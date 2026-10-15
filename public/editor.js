'use strict'

/*
 * Calculated Paths page: the editor.
 *
 * Creates, changes, groups and orders the entries, and saves them as one
 * set. Nothing reaches the server until Save: the editor works on its own
 * copy, warns before that copy is left unsaved, and Discard returns to the
 * set last saved.
 *
 * The forms are built from the field definitions the plugin sends with the
 * entries (titles, explanations, choices and defaults), so the wording
 * lives in one place, lib/schema.js.
 *
 * Typing into a field updates the copy without redrawing anything, so focus
 * and the cursor stay where they are. Only changes of structure (adding,
 * moving or deleting an entry or a group) redraw the list.
 */

;(function () {
  const { NAME_PATTERN, OUTPUT_PATTERN, PATH_PATTERN, api, button, element, everyday, figure } = window.CalcPaths

  const view = document.getElementById('edit-view')
  const PATHS_POLL_MS = 10000
  const PREVIEW_DELAY_MS = 400

  const TYPES = {
    formula: { label: 'Formula', explain: 'Calculates a value from live values: power from current and voltage, a sum of several sources, a unit conversion.' },
    counter: { label: 'Period counter', explain: 'Reports how much a running total has grown or fallen since the start of the day, week, month or year: today\'s yield from a lifetime counter, fuel used from a tank level.' },
    integration: { label: 'Integration', explain: 'Adds up a value over time: energy from power, volume from a flow, distance from speed, or the time something was on.' },
    cycles: { label: 'Cycles', explain: 'Finds the ON and OFF stretches of a device that cycles, such as a fridge compressor or a pump, from a switch, a threshold or a rising and falling value, and reports how long they last.' }
  }

  // Units offered while typing; any other text is accepted too.
  const UNITS = ['W', 'J', 'V', 'A', 'C', 's', 'm', 'm/s', 'm3', 'm3/s', 'K', 'Pa', 'Hz', 'rad', 'ratio']

  // Fields that hold a path, and so get suggestions and a live value.
  const PATH_FIELDS = new Set(['input', 'output', 'resetPath'])

  const state = {
    // What the server holds: the last loaded or saved set.
    saved: null,
    revision: null,
    fields: null,
    order: null,
    blocked: null,
    // The copy being edited.
    groups: [],
    entries: [],
    dirty: false,
    // Faults from the last save attempt, by entry id.
    errors: Object.create(null),
    expanded: new Set(),
    paths: new Map(),
    pathsKey: '',
    notice: null,
    // Per entry: the nodes that show live information, kept so that typing
    // can update them without a redraw.
    cards: new Map(),
    loaded: false,
    permitted: null,
    // Counts every change, so a save can tell whether more changes were
    // made while it was on its way.
    changes: 0,
    sending: false
  }

  let pathsTimer = null
  let visible = false

  // ------------------------------------------------------------- helpers

  function newId (prefix) {
    const bytes = new Uint8Array(4)
    window.crypto.getRandomValues(bytes)
    return prefix + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  }

  function clone (value) {
    return JSON.parse(JSON.stringify(value))
  }

  function entryById (id) {
    return state.entries.find((entry) => entry.id === id)
  }

  function entryLabel (entry) {
    return (entry.name && entry.name.trim()) || entry.output || `New ${TYPES[entry.type].label.toLowerCase()}`
  }

  function markDirty () {
    state.changes++
    if (!state.dirty) {
      state.dirty = true
      updateToolbar()
    }
    window.CalcPaths.app.setUnsaved(true)
  }

  /** The default value of every field of a type, as the field definitions give it. */
  function defaults (type) {
    const values = {}
    for (const [field, definition] of Object.entries(state.fields[type].properties)) {
      if ('default' in definition && field !== 'inputs') values[field] = clone(definition.default)
    }
    return values
  }

  /** The fields of a type in the order the editor shows them. */
  function orderedFields (type) {
    const properties = Object.keys(state.fields[type].properties)
    const order = (state.order && state.order[type]) || []
    const listed = order.filter((field) => field !== '*' && properties.includes(field))
    return [...listed, ...properties.filter((field) => !listed.includes(field))]
  }

  /** Whether a field applies, given the entry's other settings. */
  function applies (entry, field) {
    if (entry.type === 'cycles') {
      const inputs = Array.isArray(entry.inputs) ? entry.inputs : []
      if (field === 'smoothing') return inputs.some((input) => input.kind === 'wave')
      if (field === 'combine') return inputs.length > 1
      if (field === 'minCycles') return entry.statistic !== 'cycles'
      return true
    }
    if (field === 'resetPath') return entry.resets === 'path'
    if (field === 'threshold') return entry.mode === 'time'
    if (field === 'reversal') return entry.direction !== 'net'
    return true
  }

  // ------------------------------------------------------------- paths

  /** What a path holds now, in a few words, for the hint under a path field. */
  function describePath (path) {
    if (!path) return ''
    const known = state.paths.get(path)
    const producer = state.entries.find((entry) => entry.output === path)
    const from = producer ? ` Published by the entry "${entryLabel(producer)}".` : ''
    if (!known) return producer ? `Not published yet.${from}` : 'The server holds no value on this path at the moment.'
    if (known.value !== undefined) {
      const value = typeof known.value === 'boolean' ? (known.value ? 'true (counts as 1)' : 'false (counts as 0)') : `${figure(known.value)}${known.units ? ` ${known.units}` : ''}`
      const converted = typeof known.value === 'number' && known.units ? everyday(known.value, known.units, 'formula') : null
      const reading = converted ? ` (${converted.figure}${converted.unit ? ` ${converted.unit}` : ''})` : ''
      return `Now ${value}${reading}.${from}`
    }
    if (known.kind === 'object') return 'Holds an object, such as a position, which cannot be calculated with.'
    if (known.kind === 'string') return 'Holds text, which cannot be calculated with.'
    return `No value at the moment.${from}`
  }

  async function loadPaths () {
    let result
    try {
      result = await api('/paths')
    } catch (err) {
      return
    }
    if (!result.ok || !Array.isArray(result.body)) return
    state.paths = new Map(result.body.map((item) => [item.path, item]))
    const key = result.body.map((item) => item.path).join('\n')
    if (key !== state.pathsKey) {
      state.pathsKey = key
      const list = document.getElementById('calc-paths-list')
      if (list) {
        list.replaceChildren(...result.body.map((item) => {
          const option = element('option')
          option.value = item.path
          if (item.units) option.label = item.units
          return option
        }))
      }
    }
    for (const id of state.cards.keys()) refreshCard(id)
  }

  // ------------------------------------------------------------- loading

  async function load () {
    let result
    try {
      result = await api('/config')
    } catch (err) {
      showMessage('The server could not be reached.')
      return false
    }
    if (result.status === 401 || result.status === 403) {
      state.permitted = false
      showMessage('This login may read the calculated paths but not change them. Log in as a user with read/write permission to edit the entries.')
      return false
    }
    if (!result.ok) {
      showMessage(result.body && result.body.error ? result.body.error : `The server answered ${result.status}.`)
      return false
    }
    state.permitted = true
    const body = result.body
    state.saved = { groups: body.groups, entries: body.entries }
    state.revision = body.revision
    state.blocked = body.blocked
    state.fields = body.fields
    state.order = body.order
    state.groups = clone(body.groups)
    state.entries = clone(body.entries)
    state.dirty = false
    state.errors = Object.create(null)
    state.loaded = true
    window.CalcPaths.app.setUnsaved(false)
    return true
  }

  /** Asks the server, without showing anything, whether this login may edit. */
  async function probe () {
    try {
      const result = await api('/config')
      state.permitted = result.ok
    } catch (err) {
      state.permitted = false
    }
    return state.permitted
  }

  function showMessage (text) {
    view.replaceChildren(element('p', 'placeholder', text))
  }

  // ------------------------------------------------------------- drawing

  function render (focus) {
    state.cards.clear()
    const toolbar = renderToolbar()
    const notices = element('div', 'editor-notices')
    notices.setAttribute('aria-live', 'polite')
    if (state.blocked) notices.append(element('p', 'notice is-error', `${state.blocked}. The file has been left as it is. Saving here moves it aside, beside the new file, and starts the set built below. Saved totals are kept: an entry with the same output path as before continues its total, and totals no entry uses are kept for 30 days.`))
    if (state.notice) notices.append(state.notice)

    const blocks = element('div', 'editor-blocks')
    // The entries outside any group are shown as a block of their own while
    // there are any, or while there are no groups to put entries in.
    if (state.groups.length === 0 || state.entries.some((entry) => !entry.group)) blocks.append(renderBlock(null))
    for (const group of state.groups) blocks.append(renderBlock(group))

    const list = element('datalist')
    list.id = 'calc-paths-list'
    for (const item of state.paths.values()) {
      const option = element('option')
      option.value = item.path
      if (item.units) option.label = item.units
      list.append(option)
    }
    const units = element('datalist')
    units.id = 'calc-units-list'
    for (const unit of UNITS) {
      const option = element('option')
      option.value = unit
      units.append(option)
    }

    view.replaceChildren(toolbar, notices, blocks, list, units)
    updateToolbar()
    if (focus) {
      const target = view.querySelector(focus)
      if (target) target.focus()
    }
  }

  function renderToolbar () {
    const bar = element('div', 'editor-toolbar')
    const status = element('span', 'editor-status')
    status.id = 'editor-status'
    const save = button('Save', 'is-primary', () => saveAll())
    save.id = 'editor-save'
    const discard = button('Discard changes', 'is-quiet', () => discardAll())
    discard.id = 'editor-discard'
    const addGroup = button('Add group', '', () => {
      const group = { id: newId('g'), name: 'New group' }
      state.groups.push(group)
      markDirty()
      render(`[data-group-name="${group.id}"]`)
      const field = view.querySelector(`[data-group-name="${group.id}"]`)
      if (field) field.select()
    })
    addGroup.id = 'editor-add-group'
    const exportButton = button('Export', 'is-quiet', exportSet)
    const importLabel = element('label', 'file-button')
    const importInput = element('input')
    importInput.type = 'file'
    importInput.accept = 'application/json,.json'
    importInput.className = 'visually-hidden'
    importInput.addEventListener('change', () => importSet(importInput))
    importLabel.append('Import', importInput)
    const main = element('div', 'toolbar-main')
    main.append(save, discard, status)
    const more = element('div', 'toolbar-more')
    more.append(addGroup, exportButton, importLabel)
    bar.append(main, more)
    return bar
  }

  function updateToolbar () {
    const status = document.getElementById('editor-status')
    const save = document.getElementById('editor-save')
    const discard = document.getElementById('editor-discard')
    if (!status) return
    status.textContent = state.sending ? 'Saving' : state.dirty ? 'Unsaved changes' : 'All changes saved'
    status.classList.toggle('is-unsaved', state.dirty && !state.sending)
    save.disabled = !state.dirty || state.sending
    discard.disabled = !state.dirty || state.sending
  }

  /** One block: the entries outside any group (group null), or one group. */
  function renderBlock (group) {
    const id = group ? group.id : null
    const section = element('section', group ? 'edit-group' : 'edit-group is-ungrouped')
    const head = element('div', 'edit-group-head')
    if (group) {
      const name = element('input', 'group-name-field')
      name.type = 'text'
      name.value = group.name
      name.setAttribute('aria-label', 'Group name')
      name.dataset.groupName = group.id
      name.addEventListener('input', () => {
        group.name = name.value
        markDirty()
      })
      const index = state.groups.indexOf(group)
      const up = button('↑', 'is-icon', () => moveGroup(group, -1), `Move group ${group.name} up`)
      up.dataset.focus = `group-up-${group.id}`
      up.disabled = index === 0
      const down = button('↓', 'is-icon', () => moveGroup(group, 1), `Move group ${group.name} down`)
      down.dataset.focus = `group-down-${group.id}`
      down.disabled = index === state.groups.length - 1
      const remove = button('Delete group', 'is-quiet', () => confirmInline(remove, 'Delete group? Its entries stay, outside any group.', () => deleteGroup(group)))
      const tools = element('div', 'edit-group-tools')
      tools.append(up, down, remove)
      head.append(name, tools)
    } else {
      head.append(element('h2', 'edit-group-title', 'Not in a group'))
    }
    section.append(head)

    const list = element('ol', 'cards')
    list.dataset.group = id || ''
    const entries = state.entries.filter((entry) => (entry.group || null) === id)
    for (const entry of entries) list.append(renderCard(entry, entries))
    if (entries.length === 0) list.append(element('li', 'cards-empty', group ? 'No entries in this group yet. Add one below, or drag one here.' : 'No entries outside the groups.'))
    addDropTarget(list, id)
    section.append(list)
    section.append(renderAdder(id))
    return section
  }

  /** The "Add entry" chooser at the foot of a block. */
  function renderAdder (groupId) {
    const wrap = element('div', 'adder')
    const open = button('Add entry', '', () => {
      choices.hidden = !choices.hidden
      open.setAttribute('aria-expanded', String(!choices.hidden))
      if (!choices.hidden) choices.querySelector('button').focus()
    })
    open.setAttribute('aria-expanded', 'false')
    const choices = element('div', 'adder-choices')
    choices.hidden = true
    for (const [type, info] of Object.entries(TYPES)) {
      const choice = button('', 'adder-choice', () => addEntry(type, groupId))
      choice.append(element('strong', '', info.label), element('span', '', info.explain))
      choices.append(choice)
    }
    wrap.append(open, choices)
    return wrap
  }

  function renderCard (entry, siblings) {
    const item = element('li', 'card')
    item.dataset.id = entry.id
    if (state.errors[entry.id]) item.classList.add('has-error')
    if (entry.enabled === false) item.classList.add('is-off')

    const head = element('div', 'card-head')
    const handle = element('span', 'drag-handle', '⠿')
    handle.title = 'Drag to move'
    handle.setAttribute('aria-hidden', 'true')
    handle.draggable = true
    handle.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('text/plain', entry.id)
      event.dataTransfer.effectAllowed = 'move'
      try { event.dataTransfer.setDragImage(item, 20, 20) } catch (err) { /* not offered by every browser */ }
      item.classList.add('is-dragging')
    })
    handle.addEventListener('dragend', () => item.classList.remove('is-dragging'))

    const expanded = state.expanded.has(entry.id)
    const toggle = element('button', 'card-toggle')
    toggle.type = 'button'
    toggle.setAttribute('aria-expanded', String(expanded))
    toggle.dataset.focus = `toggle-${entry.id}`
    const title = element('span', 'card-title', entryLabel(entry))
    const kind = element('span', 'card-kind', TYPES[entry.type].label + (entry.enabled === false ? ', switched off' : ''))
    const output = element('code', 'card-output', entry.output || 'no output path yet')
    toggle.append(title, kind, output)
    toggle.addEventListener('click', () => {
      if (state.expanded.has(entry.id)) state.expanded.delete(entry.id)
      else state.expanded.add(entry.id)
      const open = state.expanded.has(entry.id)
      toggle.setAttribute('aria-expanded', String(open))
      body.hidden = !open
      if (open) refreshCard(entry.id)
    })

    const position = siblings.indexOf(entry)
    const up = button('↑', 'is-icon', () => moveEntry(entry, -1), `Move ${entryLabel(entry)} up`)
    up.dataset.focus = `up-${entry.id}`
    up.disabled = position === 0
    const down = button('↓', 'is-icon', () => moveEntry(entry, 1), `Move ${entryLabel(entry)} down`)
    down.dataset.focus = `down-${entry.id}`
    down.disabled = position === siblings.length - 1
    const tools = element('div', 'card-tools')
    tools.append(up, down)
    head.append(handle, toggle, tools)

    const error = element('p', 'card-error')
    error.hidden = !state.errors[entry.id]
    error.textContent = state.errors[entry.id] ? `Cannot run as set: ${state.errors[entry.id]}.` : ''

    const body = element('div', 'card-body')
    body.hidden = !expanded
    const form = element('div', 'card-form')
    const live = { title, kind, output, error, body, hints: new Map(), inputHints: [], rows: new Map(), chain: null, preview: null, previewTimer: null }
    for (const field of orderedFields(entry.type)) form.append(renderField(entry, field, live))
    const chain = element('p', 'card-chain')
    live.chain = chain
    const footer = element('div', 'card-footer')
    const groupSelect = element('select')
    groupSelect.setAttribute('aria-label', `Group of ${entryLabel(entry)}`)
    const none = element('option', '', 'Not in a group')
    none.value = ''
    groupSelect.append(none)
    for (const group of state.groups) {
      const option = element('option', '', group.name)
      option.value = group.id
      groupSelect.append(option)
    }
    groupSelect.value = entry.group || ''
    groupSelect.addEventListener('change', () => {
      moveToGroup(entry, groupSelect.value || null, null)
      state.expanded.add(entry.id)
      render(`[data-focus="toggle-${entry.id}"]`)
    })
    const groupLabel = element('label', 'card-group')
    groupLabel.append('Group ', groupSelect)
    const duplicate = button('Duplicate', 'is-quiet', () => duplicateEntry(entry))
    const remove = button('Delete entry', 'is-quiet is-danger', () => confirmInline(remove, 'Delete this entry?', () => deleteEntry(entry)))
    footer.append(groupLabel, duplicate, remove)
    body.append(form, chain, footer)

    item.append(head, error, body)
    addCardDrop(item, entry)
    state.cards.set(entry.id, live)
    refreshCard(entry.id)
    return item
  }

  /** Draws one field of an entry's form. */
  function renderField (entry, field, live) {
    const definition = state.fields[entry.type].properties[field]
    const wrap = element('div', `field field-${field}`)
    const fieldId = `f-${entry.id}-${field}`
    wrap.hidden = !applies(entry, field)
    live.rows.set(field, wrap)

    if (field === 'inputs') return entry.type === 'cycles' ? renderCycleInputs(entry, definition, wrap, live) : renderInputs(entry, definition, wrap, live)

    if (definition.type === 'boolean') {
      const box = element('input')
      box.type = 'checkbox'
      box.id = fieldId
      box.checked = entry[field] !== false
      box.addEventListener('change', () => {
        entry[field] = box.checked
        markDirty()
        live.kind.textContent = TYPES[entry.type].label + (entry.enabled === false ? ', switched off' : '')
        live.title.closest('.card').classList.toggle('is-off', entry.enabled === false)
      })
      const label = element('label', 'field-check')
      label.htmlFor = fieldId
      label.append(box, ` ${field === 'enabled' ? 'Switched on' : definition.title}`)
      wrap.append(label)
      return wrap
    }

    const label = element('label', 'field-label', definition.title)
    label.htmlFor = fieldId
    wrap.append(label)
    let control
    if (Array.isArray(definition.enum)) {
      control = element('select')
      definition.enum.forEach((value, index) => {
        const option = element('option', '', (definition.enumNames || definition.enum)[index])
        option.value = value
        control.append(option)
      })
      control.value = entry[field] !== undefined ? entry[field] : definition.default
      control.addEventListener('change', () => {
        entry[field] = control.value
        markDirty()
        for (const [name, row] of live.rows) row.hidden = !applies(entry, name)
        refreshChains()
      })
    } else if (field === 'expression') {
      control = element('textarea')
      control.rows = 2
      control.spellcheck = false
      control.value = entry.expression || ''
      control.addEventListener('input', () => {
        entry.expression = control.value
        markDirty()
        schedulePreview(entry, live)
      })
    } else {
      control = element('input')
      control.type = 'text'
      const numeric = definition.type === 'number'
      if (numeric) control.inputMode = 'decimal'
      if (PATH_FIELDS.has(field)) {
        control.setAttribute('list', 'calc-paths-list')
        control.spellcheck = false
        control.autocapitalize = 'off'
        control.className = 'is-path'
      }
      if (field === 'unit') control.setAttribute('list', 'calc-units-list')
      const value = entry[field]
      control.value = value === undefined || value === null ? '' : String(value)
      if (numeric && definition.default !== undefined) control.placeholder = String(definition.default)
      control.addEventListener('input', () => {
        const text = control.value
        if (numeric) {
          const number = Number(text)
          if (text.trim() === '') delete entry[field]
          else entry[field] = Number.isFinite(number) ? number : text
        } else {
          entry[field] = text.trim()
        }
        markDirty()
        if (field === 'name' || field === 'output') {
          live.title.textContent = entryLabel(entry)
          live.output.textContent = entry.output || 'no output path yet'
        }
        if (PATH_FIELDS.has(field) || field === 'output') {
          checkPath(control, field, entry[field])
          refreshChains()
        }
        if (PATH_FIELDS.has(field)) refreshHint(live, field, entry[field])
      })
    }
    control.id = fieldId
    wrap.append(control)
    if (PATH_FIELDS.has(field)) {
      const hint = element('p', 'field-hint')
      live.hints.set(field, hint)
      wrap.append(hint)
    }
    if (field === 'expression') {
      live.preview = element('p', 'field-preview')
      live.preview.setAttribute('aria-live', 'polite')
      wrap.append(live.preview)
    }
    if (definition.description) wrap.append(element('p', 'field-help', definition.description))
    return wrap
  }

  /** The inputs of a formula: short names, each with its path. */
  function renderInputs (entry, definition, wrap, live) {
    wrap.append(element('p', 'field-label', definition.title))
    const names = definition.items.properties.name
    const paths = definition.items.properties.path
    if (!Array.isArray(entry.inputs)) entry.inputs = []
    const table = element('div', 'inputs')
    const draw = () => {
      table.replaceChildren()
      live.inputHints = []
      entry.inputs.forEach((input, index) => {
        const row = element('div', 'input-row')
        const name = element('input', 'input-name')
        name.type = 'text'
        name.value = input.name || ''
        name.spellcheck = false
        name.autocapitalize = 'off'
        name.setAttribute('aria-label', `${names.title} ${index + 1}`)
        name.placeholder = names.title
        name.addEventListener('input', () => {
          input.name = name.value.trim()
          markDirty()
          name.setAttribute('aria-invalid', String(input.name !== '' && !NAME_PATTERN.test(input.name)))
          schedulePreview(entry, live)
        })
        const path = element('input', 'input-path is-path')
        path.type = 'text'
        path.value = input.path || ''
        path.spellcheck = false
        path.autocapitalize = 'off'
        path.setAttribute('list', 'calc-paths-list')
        path.setAttribute('aria-label', `${paths.title} ${index + 1}`)
        path.placeholder = 'Signal K path'
        const hint = element('p', 'field-hint')
        path.addEventListener('input', () => {
          input.path = path.value.trim()
          markDirty()
          checkPath(path, 'input', input.path)
          hint.textContent = describePath(input.path)
          refreshChains()
          schedulePreview(entry, live)
        })
        hint.textContent = describePath(input.path)
        live.inputHints.push({ hint, input })
        const remove = button('Remove', 'is-quiet', () => {
          entry.inputs.splice(index, 1)
          markDirty()
          draw()
          refreshChains()
          schedulePreview(entry, live)
        }, `Remove input ${input.name || index + 1}`)
        row.append(name, path, remove, hint)
        table.append(row)
      })
    }
    draw()
    const add = button('Add input', '', () => {
      entry.inputs.push({ name: suggestName(entry), path: '' })
      markDirty()
      draw()
      const fields = table.querySelectorAll('.input-path')
      if (fields.length > 0) fields[fields.length - 1].focus()
    })
    wrap.append(table, add, element('p', 'field-help', `${names.description} ${paths.description}`))
    return wrap
  }

  /**
   * The inputs of a Cycles entry: each a path, read as on/off against a
   * threshold or as a wave with a direction and a swing.
   */
  function renderCycleInputs (entry, definition, wrap, live) {
    wrap.append(element('p', 'field-label', definition.title))
    const item = definition.items.properties
    if (!Array.isArray(entry.inputs)) entry.inputs = []
    const table = element('div', 'inputs')
    const changed = () => {
      markDirty()
      for (const [name, row] of live.rows) row.hidden = !applies(entry, name)
      refreshChains()
    }
    const draw = () => {
      table.replaceChildren()
      live.inputHints = []
      entry.inputs.forEach((input, index) => {
        const number = index + 1
        const row = element('div', 'cycle-input')
        const path = element('input', 'input-path is-path')
        path.type = 'text'
        path.value = input.path || ''
        path.spellcheck = false
        path.autocapitalize = 'off'
        path.setAttribute('list', 'calc-paths-list')
        path.setAttribute('aria-label', `${item.path.title} of input ${number}`)
        path.placeholder = 'Signal K path'
        const hint = element('p', 'field-hint')
        path.addEventListener('input', () => {
          input.path = path.value.trim()
          checkPath(path, 'input', input.path)
          hint.textContent = describePath(input.path)
          changed()
        })
        hint.textContent = describePath(input.path)
        live.inputHints.push({ hint, input })

        const kind = element('select')
        kind.setAttribute('aria-label', `${item.kind.title} for input ${number}`)
        item.kind.enum.forEach((value, i) => {
          const option = element('option', '', item.kind.enumNames[i])
          option.value = value
          kind.append(option)
        })
        kind.value = input.kind || item.kind.default

        const settings = element('div', 'cycle-input-settings')
        const labelled = (title, control) => {
          const label = element('label', 'cycle-input-setting')
          label.append(element('span', '', title), control)
          return label
        }
        const numberField = (field) => {
          const control = element('input')
          control.type = 'text'
          control.inputMode = 'decimal'
          control.value = input[field] === undefined || input[field] === null ? '' : String(input[field])
          if (item[field].default !== undefined) control.placeholder = String(item[field].default)
          control.addEventListener('input', () => {
            const text = control.value.trim()
            const value = Number(text)
            if (text === '') delete input[field]
            else input[field] = Number.isFinite(value) ? value : text
            markDirty()
          })
          return control
        }
        const threshold = labelled(item.threshold.title, numberField('threshold'))
        const direction = element('select')
        item.direction.enum.forEach((value, i) => {
          const option = element('option', '', item.direction.enumNames[i])
          option.value = value
          direction.append(option)
        })
        direction.value = input.direction || item.direction.default
        direction.addEventListener('change', () => {
          input.direction = direction.value
          markDirty()
        })
        const directionLabel = labelled(item.direction.title, direction)
        const swing = labelled(item.swing.title, numberField('swing'))
        const show = () => {
          const wave = (input.kind || item.kind.default) === 'wave'
          threshold.hidden = wave
          directionLabel.hidden = !wave
          swing.hidden = !wave
        }
        kind.addEventListener('change', () => {
          input.kind = kind.value
          show()
          changed()
        })
        show()
        settings.append(labelled(item.kind.title, kind), threshold, directionLabel, swing)

        const remove = button('Remove', 'is-quiet', () => {
          entry.inputs.splice(index, 1)
          draw()
          changed()
        }, `Remove input ${number}`)
        row.append(path, remove, hint, settings)
        table.append(row)
      })
    }
    draw()
    const add = button('Add input', '', () => {
      entry.inputs.push({ path: '', kind: item.kind.default })
      draw()
      changed()
      const fields = table.querySelectorAll('.input-path')
      if (fields.length > 0) fields[fields.length - 1].focus()
    })
    const help = element('div', 'field-help')
    for (const field of ['kind', 'threshold', 'direction', 'swing']) {
      const line = element('p')
      line.append(element('strong', '', `${item[field].title}: `), item[field].description)
      help.append(line)
    }
    wrap.append(table, add, element('p', 'field-help', definition.description), help)
    return wrap
  }

  /** A short name not used yet in a formula: a, b, c, ... */
  function suggestName (entry) {
    const used = new Set((entry.inputs || []).map((input) => input.name))
    for (const letter of 'abcdefghijklmnopqrstuvwxyz') if (!used.has(letter)) return letter
    return `x${used.size + 1}`
  }

  function checkPath (control, field, value) {
    const pattern = field === 'output' ? OUTPUT_PATTERN : PATH_PATTERN
    control.setAttribute('aria-invalid', String(Boolean(value) && !pattern.test(value)))
  }

  function refreshHint (live, field, value) {
    const hint = live.hints.get(field)
    if (!hint) return
    if (field === 'output') {
      const others = state.entries.filter((entry) => entry.output === value)
      const known = state.paths.get(value)
      if (others.length > 1) hint.textContent = 'Another entry already writes this path.'
      else if (known && known.entry === undefined && known.value !== undefined) hint.textContent = 'Another source already publishes this path. Pick a path nothing else writes.'
      else hint.textContent = ''
      return
    }
    hint.textContent = describePath(value)
  }

  /** Brings the live parts of one card up to date. */
  function refreshCard (id) {
    const entry = entryById(id)
    const live = state.cards.get(id)
    if (!entry || !live) return
    for (const field of live.hints.keys()) refreshHint(live, field, entry[field])
    for (const { hint, input } of live.inputHints) hint.textContent = describePath(input.path)
    refreshChain(entry, live)
    // The preview asks the server, so only open cards keep it current.
    if (entry.type === 'formula' && !live.body.hidden) schedulePreview(entry, live, 0)
  }

  /** The paths an entry reads. */
  function readsOf (entry) {
    const paths = Array.isArray(entry.inputs) ? entry.inputs.map((input) => input.path) : [entry.input]
    if ((entry.type === 'counter' || entry.type === 'integration') && entry.resets === 'path') paths.push(entry.resetPath)
    return paths.filter(Boolean)
  }

  /** Says which entries an entry reads from and which read from it. */
  function refreshChain (entry, live) {
    const from = []
    for (const path of readsOf(entry)) {
      const producer = state.entries.find((other) => other !== entry && other.output === path)
      if (producer) from.push(`"${entryLabel(producer)}"`)
    }
    const to = entry.output ? state.entries.filter((other) => other !== entry && readsOf(other).includes(entry.output)).map((other) => `"${entryLabel(other)}"`) : []
    const parts = []
    if (from.length > 0) parts.push(`Reads the result of ${from.join(', ')}.`)
    if (to.length > 0) parts.push(`Its result is read by ${to.join(', ')}.`)
    live.chain.textContent = parts.join(' ')
    live.chain.hidden = parts.length === 0
  }

  function refreshChains () {
    for (const [id, live] of state.cards) {
      const entry = entryById(id)
      if (entry) refreshChain(entry, live)
    }
  }

  /** Works the formula out on the current values, a moment after typing stops. */
  function schedulePreview (entry, live, delay = PREVIEW_DELAY_MS) {
    if (!live.preview) return
    clearTimeout(live.previewTimer)
    live.previewTimer = setTimeout(async () => {
      const inputs = (entry.inputs || []).filter((input) => input.name && input.path)
      if (!entry.expression) {
        live.preview.textContent = ''
        return
      }
      let result
      try {
        result = await api('/preview', { method: 'POST', body: { inputs, expression: entry.expression } })
      } catch (err) {
        return
      }
      const body = result.body || {}
      live.preview.className = 'field-preview'
      if (!result.ok) {
        live.preview.textContent = ''
      } else if (body.error) {
        live.preview.textContent = `Not yet: ${body.error}.`
        live.preview.classList.add('is-error')
      } else if (body.missing) {
        live.preview.textContent = `No result yet: no value on ${body.missing.join(', ')} at the moment.`
      } else {
        const unit = entry.unit ? ` ${entry.unit}` : ''
        const converted = entry.unit ? everyday(body.value, entry.unit, 'formula') : null
        const reading = converted ? ` (${converted.figure}${converted.unit ? ` ${converted.unit}` : ''})` : ''
        live.preview.textContent = `With the current values: ${figure(body.value)}${unit}${reading}`
        live.preview.classList.add('is-ok')
      }
    }, delay)
  }

  // ------------------------------------------------------------- confirming

  /** Turns a button into a short "Confirm / Cancel" pair. */
  function confirmInline (trigger, question, action) {
    const holder = trigger.parentNode
    const box = element('span', 'confirm')
    box.append(element('span', 'confirm-question', question))
    const yes = button('Confirm', 'is-confirm', action)
    const no = button('Cancel', 'is-quiet', () => {
      box.replaceWith(trigger)
      trigger.focus()
    })
    box.append(yes, no)
    holder.replaceChild(box, trigger)
    yes.focus()
  }

  // ------------------------------------------------------------- changes

  function addEntry (type, groupId) {
    const entry = { id: newId('e'), group: groupId, type, ...defaults(type), name: '', output: '' }
    if (type === 'formula') {
      entry.inputs = [{ name: 'a', path: '' }]
      entry.expression = ''
    } else if (type === 'cycles') {
      entry.inputs = [{ path: '', kind: 'onoff' }]
    } else {
      entry.input = ''
    }
    // A new entry goes to the end of its block.
    const last = state.entries.map((e) => e.group || null).lastIndexOf(groupId)
    state.entries.splice(last === -1 ? state.entries.length : last + 1, 0, entry)
    state.expanded.add(entry.id)
    markDirty()
    render(`#f-${entry.id}-name`)
  }

  function duplicateEntry (entry) {
    const copy = { ...clone(entry), id: newId('e'), name: `${entryLabel(entry)} (copy)`, output: '' }
    state.entries.splice(state.entries.indexOf(entry) + 1, 0, copy)
    state.expanded.add(copy.id)
    markDirty()
    render(`#f-${copy.id}-output`)
  }

  function deleteEntry (entry) {
    const siblings = state.entries.filter((e) => (e.group || null) === (entry.group || null))
    const next = siblings[siblings.indexOf(entry) + 1] || siblings[siblings.indexOf(entry) - 1]
    state.entries.splice(state.entries.indexOf(entry), 1)
    state.expanded.delete(entry.id)
    delete state.errors[entry.id]
    markDirty()
    render(next ? `[data-focus="toggle-${next.id}"]` : '#editor-add-group')
  }

  /** Moves an entry one place up or down within its block. */
  function moveEntry (entry, step) {
    const group = entry.group || null
    const siblings = state.entries.filter((e) => (e.group || null) === group)
    const other = siblings[siblings.indexOf(entry) + step]
    if (!other) return
    const a = state.entries.indexOf(entry)
    const b = state.entries.indexOf(other)
    state.entries[a] = other
    state.entries[b] = entry
    markDirty()
    // Focus stays on the arrow that was pressed, or moves to the other one
    // when that arrow is now at the end of the list.
    const position = siblings.indexOf(entry) + step
    const focus = (step < 0 && position === 0) || (step > 0 && position === siblings.length - 1) ? (step < 0 ? 'down' : 'up') : (step < 0 ? 'up' : 'down')
    render(`[data-focus="${focus}-${entry.id}"]`)
  }

  /** Moves an entry into a block, before another entry or at its end. */
  function moveToGroup (entry, groupId, beforeId) {
    state.entries.splice(state.entries.indexOf(entry), 1)
    entry.group = groupId
    let index
    if (beforeId) {
      index = state.entries.findIndex((e) => e.id === beforeId)
    } else {
      const last = state.entries.map((e) => e.group || null).lastIndexOf(groupId)
      index = last === -1 ? state.entries.length : last + 1
    }
    state.entries.splice(index === -1 ? state.entries.length : index, 0, entry)
    markDirty()
  }

  function moveGroup (group, step) {
    const index = state.groups.indexOf(group)
    const other = state.groups[index + step]
    if (!other) return
    state.groups[index] = other
    state.groups[index + step] = group
    markDirty()
    const position = index + step
    const focus = (step < 0 && position === 0) || (step > 0 && position === state.groups.length - 1) ? (step < 0 ? 'down' : 'up') : (step < 0 ? 'up' : 'down')
    render(`[data-focus="group-${focus}-${group.id}"]`)
  }

  function deleteGroup (group) {
    // Its entries join the end of the block outside any group.
    const members = state.entries.filter((e) => e.group === group.id)
    for (const entry of members) moveToGroup(entry, null, null)
    state.groups.splice(state.groups.indexOf(group), 1)
    markDirty()
    render('#editor-add-group')
  }

  // ------------------------------------------------------------- dragging

  /** A drop on a card puts the dragged entry before or after it. */
  function addCardDrop (item, entry) {
    item.addEventListener('dragover', (event) => {
      if (!event.dataTransfer.types.includes('text/plain')) return
      event.preventDefault()
      event.stopPropagation()
      const box = item.getBoundingClientRect()
      const after = event.clientY > box.top + box.height / 2
      item.classList.toggle('drop-before', !after)
      item.classList.toggle('drop-after', after)
    })
    item.addEventListener('dragleave', () => item.classList.remove('drop-before', 'drop-after'))
    item.addEventListener('drop', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const after = item.classList.contains('drop-after')
      item.classList.remove('drop-before', 'drop-after')
      const dragged = entryById(event.dataTransfer.getData('text/plain'))
      if (!dragged || dragged === entry) return
      const group = entry.group || null
      let before = entry.id
      if (after) {
        const siblings = state.entries.filter((e) => (e.group || null) === group && e !== dragged)
        const next = siblings[siblings.indexOf(entry) + 1]
        before = next ? next.id : null
      }
      moveToGroup(dragged, group, before)
      render(`[data-focus="toggle-${dragged.id}"]`)
    })
  }

  /** A drop on the list itself, outside any card, puts the entry at its end. */
  function addDropTarget (list, groupId) {
    list.addEventListener('dragover', (event) => {
      if (!event.dataTransfer.types.includes('text/plain')) return
      event.preventDefault()
      list.classList.add('is-drop-target')
    })
    list.addEventListener('dragleave', (event) => {
      if (!list.contains(event.relatedTarget)) list.classList.remove('is-drop-target')
    })
    list.addEventListener('drop', (event) => {
      event.preventDefault()
      list.classList.remove('is-drop-target')
      const dragged = entryById(event.dataTransfer.getData('text/plain'))
      if (!dragged) return
      moveToGroup(dragged, groupId, null)
      render(`[data-focus="toggle-${dragged.id}"]`)
    })
  }

  // ------------------------------------------------------------- saving

  /**
   * What an entry's total is measured from, as the plugin decides whether
   * a saved total still applies (signature() and the restore rules in
   * lib/engine.js): the input, the direction or mode, the threshold when
   * adding up time, and the reset rule. Missing fields count as their
   * defaults, as the plugin reads them.
   */
  function measure (entry) {
    if (entry.type === 'counter') return ['counter', entry.input || '', entry.direction || 'increase', entry.resets || 'day'].join('|')
    if (entry.type === 'integration') {
      const mode = entry.mode || 'rate'
      // As the plugin reads it: anything that is not a number counts as 0.
      const number = entry.threshold === null || entry.threshold === '' ? NaN : Number(entry.threshold)
      const threshold = mode === 'time' ? String(Number.isFinite(number) ? number : 0) : ''
      return ['integration', entry.input || '', mode, threshold, entry.resets || 'day'].join('|')
    }
    if (entry.type === 'cycles') {
      // What decides where stretches begin and end, read as lib/config.js
      // reads it (signature() in lib/engine.js); the figure and the window
      // do not.
      const text = (value) => typeof value === 'string' ? value.trim() : ''
      const pick = (value, allowed, fallback) => allowed.includes(value) ? value : fallback
      const number = (value) => value === null || value === '' || value === undefined ? NaN : Number(value)
      const nonNegative = (value, fallback) => {
        const n = number(value)
        return Number.isFinite(n) && n >= 0 ? n : fallback
      }
      const inputs = (Array.isArray(entry.inputs) ? entry.inputs : []).map((i) => {
        const item = i && typeof i === 'object' ? i : {}
        const kind = pick(item.kind, ['onoff', 'wave'], 'onoff')
        if (kind === 'onoff') {
          const threshold = number(item.threshold)
          return [text(item.path), kind, Number.isFinite(threshold) ? threshold : 0]
        }
        const swing = number(item.swing)
        return [text(item.path), kind, pick(item.direction, ['falling', 'rising'], 'falling'), Number.isFinite(swing) ? swing : null]
      })
      const steps = Math.max(1, Math.round(nonNegative(entry.smoothing, 150) / 30))
      return ['cycles', JSON.stringify(inputs), pick(entry.combine, ['all', 'any'], 'all'), steps, nonNegative(entry.shortest, 120), nonNegative(entry.staleTimeout, 180)].join('|')
    }
    return null
  }

  /**
   * The entry whose total an output path holds, as the plugin saves it: an
   * entry that is switched on before one that is switched off, and the
   * first of each.
   */
  function holders (entries) {
    const map = new Map()
    for (const on of [true, false]) {
      for (const entry of entries) {
        if (!entry.output || !measure(entry) || (entry.enabled !== false) !== on || map.has(entry.output)) continue
        map.set(entry.output, entry)
      }
    }
    return map
  }

  /**
   * What a save will cost in totals. Totals belong to output paths, so the
   * set last saved and the set being saved are compared by output path,
   * whatever the entries' ids: an entry imported from another server that
   * takes over an output continues its total. Listed so that nothing is
   * lost unawares.
   */
  function losses () {
    const now = holders(state.entries)
    const lost = []
    for (const old of holders(state.saved.entries).values()) {
      const before = measure(old)
      const entry = now.get(old.output)
      if (!entry) {
        const renamed = state.entries.find((e) => e.id === old.id)
        const what = old.type === 'cycles' ? 'the cycles counted so far' : 'its total'
        lost.push(renamed
          ? `"${entryLabel(renamed)}" starts again: its output path changed, and ${what} stay${old.type === 'cycles' ? '' : 's'} with the old path.`
          : `"${entryLabel(old)}" is deleted, and ${what} with it.`)
      } else if (measure(entry) !== before) {
        lost.push(entry.type === 'cycles'
          ? `"${entryLabel(entry)}" forgets the cycles counted so far: how its stretches are found changed (inputs, combination, smoothing, shortest stretch or stale timeout).`
          : `"${entryLabel(entry)}" starts again from zero: what its total is measured from changed (input, direction, mode, threshold or reset rule).`)
      }
    }
    return lost
  }

  function saveAll () {
    if (!state.dirty) return
    const lost = losses()
    if (lost.length === 0) {
      send()
      return
    }
    const box = element('div', 'notice is-warning save-check')
    box.append(element('p', '', 'Saving changes what these entries have counted:'))
    const list = element('ul')
    for (const line of lost) list.append(element('li', '', line))
    const go = button('Save anyway', 'is-confirm', () => send())
    const back = button('Go back', 'is-quiet', () => {
      state.notice = null
      render('#editor-save')
    })
    box.append(list, go, back)
    state.notice = box
    render()
    go.focus()
  }

  async function send () {
    if (state.sending) return
    state.notice = null
    state.sending = true
    updateToolbar()
    const changes = state.changes
    const sent = clone({ groups: state.groups, entries: state.entries })
    let result
    try {
      result = await api('/config', { method: 'PUT', body: { revision: state.revision, ...sent } })
    } catch (err) {
      result = null
    }
    state.sending = false
    if (!result) {
      setNotice('error', 'The server could not be reached. Nothing was saved.')
      return
    }
    const answer = result.body || {}
    if (result.status === 409) {
      const box = element('div', 'notice is-error')
      box.append(element('p', '', answer.error || 'The entries were changed elsewhere.'))
      box.append(button('Reload, losing the changes here', '', async () => { await reopen() }), ' ', button('Export the changes here first', 'is-quiet', exportSet))
      state.notice = box
      render()
      return
    }
    if (result.status === 401 || result.status === 403) {
      setNotice('error', 'This login may not change the entries. Nothing was saved.')
      return
    }
    if (!result.ok) {
      state.errors = Object.assign(Object.create(null), answer.entryErrors || {})
      for (const id of Object.keys(state.errors)) state.expanded.add(id)
      const lines = [answer.error || `The server answered ${result.status}. Nothing was saved.`, ...(answer.errors || [])]
      setNotice('error', lines.join(' '))
      const first = Object.keys(state.errors)[0]
      if (first) {
        const card = view.querySelector(`.card[data-id="${first}"]`)
        if (card) card.scrollIntoView({ block: 'center' })
      }
      return
    }
    state.errors = Object.assign(Object.create(null), answer.entryErrors || {})
    if (state.changes === changes) {
      // Nothing changed while the save was on its way: show the set as the
      // server now holds it.
      const expanded = new Set(state.expanded)
      await load()
      state.expanded = expanded
      state.errors = Object.assign(Object.create(null), answer.entryErrors || {})
    } else {
      // Changes made meanwhile stay, unsaved, on top of what was saved.
      state.saved = sent
      state.revision = answer.revision
    }
    const kept = answer.kept === 1 ? '1 entry kept running' : `${answer.kept} entries kept running`
    const started = answer.started === 1 ? '1 entry started' : `${answer.started} entries started`
    const more = state.dirty ? ' Changes made since are not saved yet.' : ''
    if (answer.warning) setNotice('warning', `Saved. ${answer.warning}`, true)
    else setNotice('info', `Saved. ${kept} without interruption, ${started}.${more}`, true)
    window.CalcPaths.status.refresh()
  }

  /**
   * Shows a message above the entries. With `focus`, keyboard focus moves
   * to it, for when the control that was used is now disabled.
   */
  function setNotice (kind, text, focus) {
    state.notice = element('p', `notice is-${kind}`, text)
    state.notice.tabIndex = -1
    render()
    const target = view.querySelector('.editor-notices .notice')
    if (target) {
      target.scrollIntoView({ block: 'nearest' })
      if (focus) target.focus()
    }
  }

  function discardAll () {
    const trigger = document.getElementById('editor-discard')
    confirmInline(trigger, 'Discard all unsaved changes?', () => {
      state.groups = clone(state.saved.groups)
      state.entries = clone(state.saved.entries)
      state.dirty = false
      state.errors = Object.create(null)
      state.notice = null
      window.CalcPaths.app.setUnsaved(false)
      render('#editor-add-group')
    })
  }

  async function reopen () {
    if (await load()) {
      state.notice = null
      render()
    }
  }

  // ------------------------------------------------------------- import, export

  function exportSet () {
    const text = JSON.stringify({ version: 1, groups: state.groups, entries: state.entries }, null, 2) + '\n'
    const link = element('a')
    link.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
    link.download = 'calculated-paths-entries.json'
    document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(link.href), 10000)
  }

  /**
   * Keeps the fields an imported entry may have, each only with a value of
   * its kind, as the plugin keeps them on saving (pickFields() in
   * lib/store.js). A stray value in a file must not break the editor.
   */
  function cleanEntry (raw) {
    const entry = { id: raw.id, type: raw.type }
    for (const [field, definition] of Object.entries(state.fields[raw.type].properties)) {
      const value = raw[field]
      if (value === undefined) continue
      if (field === 'enabled') {
        if (typeof value === 'boolean') entry.enabled = value
      } else if (field === 'inputs') {
        if (Array.isArray(value)) {
          const fields = definition.items.properties
          entry.inputs = value.filter((i) => i && typeof i === 'object').map((i) => {
            const kept = {}
            for (const [name, spec] of Object.entries(fields)) {
              const v = i[name]
              if (spec.type === 'number' ? (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'string' : typeof v === 'string') kept[name] = v
            }
            if (raw.type === 'formula') return { name: kept.name || '', path: kept.path || '' }
            return kept
          })
        }
      } else if (definition.type === 'number') {
        if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'string') entry[field] = value
      } else if (typeof value === 'string') {
        entry[field] = value
      }
    }
    return entry
  }

  function importSet (input) {
    const file = input.files && input.files[0]
    input.value = ''
    if (!file) return
    file.text().then((text) => {
      let data
      try {
        data = JSON.parse(text)
      } catch (err) {
        setNotice('error', `${file.name} is not a JSON file. Nothing was imported.`)
        return
      }
      if (!data || !Array.isArray(data.entries) || !Array.isArray(data.groups)) {
        setNotice('error', `${file.name} holds no entries exported from this page. Nothing was imported.`)
        return
      }
      state.groups = data.groups.filter((g) => g && typeof g.id === 'string').map((g) => ({ id: g.id, name: String(g.name || 'Unnamed group') }))
      const known = new Set(state.groups.map((g) => g.id))
      state.entries = data.entries.filter((e) => e && typeof e.id === 'string' && TYPES[e.type]).map((e) => ({ ...cleanEntry(e), group: known.has(e.group) ? e.group : null }))
      state.errors = Object.create(null)
      state.expanded.clear()
      markDirty()
      const groups = state.groups.length === 1 ? '1 group' : `${state.groups.length} groups`
      const entries = state.entries.length === 1 ? '1 entry' : `${state.entries.length} entries`
      setNotice('info', `Imported ${entries} in ${groups} from ${file.name}. They replace the entries shown before, and are not saved yet.`)
    }, () => setNotice('error', `${file.name} could not be read. Nothing was imported.`))
  }

  // ------------------------------------------------------------- the view

  window.addEventListener('beforeunload', (event) => {
    if (state.dirty) {
      event.preventDefault()
      event.returnValue = ''
    }
  })

  window.CalcPaths.editor = {
    probe,
    get dirty () { return state.dirty },
    async show () {
      visible = true
      if (!state.loaded) {
        showMessage('Loading the entries.')
        if (!(await load())) return
        await loadPaths()
        render()
      }
      if (!pathsTimer) pathsTimer = setInterval(() => { if (visible) loadPaths() }, PATHS_POLL_MS)
    },
    hide () {
      visible = false
    }
  }
})()
