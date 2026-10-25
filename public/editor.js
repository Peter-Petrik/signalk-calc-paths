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
  const { NAME_PATTERN, OUTPUT_PATTERN, PATH_PATTERN, SETTINGS_URL, api, button, element, everyday, figure, pathCode, readNumber, shownUnit } = window.CalcPaths

  const view = document.getElementById('edit-view')
  const PATHS_POLL_MS = 10000
  const PREVIEW_DELAY_MS = 400

  const TYPES = {
    formula: { label: 'Formula', explain: 'A value worked out from live values: power from current and voltage, a sum of sources, a unit conversion.' },
    counter: { label: 'Period counter', explain: 'How much a running total has changed since the start of the day, week, month or year: today\'s yield, fuel used.' },
    integration: { label: 'Integration', explain: 'A value added up over time: energy from power, volume from a flow, or the time something was on.' },
    cycles: { label: 'Cycles', explain: 'How long a device that cycles, such as a fridge compressor or a pump, runs and rests.' },
    record: { label: 'Record', explain: 'The lowest or highest value of a path, or the time since it was last at a level, such as a full battery.' }
  }

  // Units offered while typing; any other text is accepted too.
  const UNITS = ['W', 'J', 'V', 'A', 'C', 's', 'm', 'm/s', 'm3', 'm3/s', 'K', 'Pa', 'Hz', 'rad', 'ratio']

  // The units of the Signal K specification: the keys of definitions.units
  // in schemas/definitions.json of github.com/SignalK/specification (master,
  // October 2026). Another unit is saved and published as typed, with a
  // warning in the editor, as displays cannot convert from it.
  const SIGNALK_UNITS = new Set(['s', 'Hz', 'm3', 'm3/s', 'kg/s', 'kg/m3', 'deg', 'rad', 'rad/s', 'A', 'C', 'V', 'W', 'Nm', 'J', 'ohm', 'm', 'm/s', 'm2', 'K', 'Pa', 'kg', 'ratio', 'm/s2', 'rad/s2', 'N', 'T', 'Lux', 'Pa/s', 'Pa.s', 'B', 'b/s'])

  // Fields that hold a path, and so get suggestions and a live value.
  const PATH_FIELDS = new Set(['input', 'output', 'resetPath', 'timeOutput'])
  // Fields that name a path this plugin publishes on.
  const OUTPUT_FIELDS = new Set(['output', 'timeOutput'])

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
    // Every fault of each entry the last save refused, with its field.
    faults: Object.create(null),
    // The saved set as canonical JSON, to tell whether anything differs.
    savedKey: null,
    // Whether the actions folded behind "Actions" are unfolded on a narrow screen.
    moreOpen: false,
    expanded: new Set(),
    // The entries whose Advanced settings are unfolded, by id.
    advanced: new Set(),
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
    sending: false,
    // The revision of a newer set on the server, once the editor has said
    // that its unsaved changes cannot be saved over it.
    staleRevision: null
  }

  let pathsTimer = null
  let visible = false
  // The id of the entry whose card is being dragged, so that a drop of
  // anything else, such as text dragged into a field, is left alone.
  let draggedId = null

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

  /** JSON with the keys of every object sorted, to compare two sets. */
  function canonical (value) {
    return JSON.stringify(value, (key, item) => item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map((name) => [name, item[name]]))
      : item)
  }

  /**
   * Notes an edit. The set counts as unsaved only while it differs from the
   * saved one, so an edit that is undone by hand leaves nothing to save.
   */
  function markDirty () {
    state.changes++
    const dirty = canonical({ groups: state.groups, entries: state.entries }) !== state.savedKey
    if (dirty !== state.dirty) {
      state.dirty = dirty
      updateToolbar()
    }
    window.CalcPaths.app.setUnsaved(dirty)
  }

  /** Takes the faults of a save's answer: the first of each entry, and all. */
  function takeFaults (answer) {
    state.errors = Object.assign(Object.create(null), answer.entryErrors || {})
    state.faults = Object.create(null)
    for (const id of Object.keys(state.errors)) {
      const list = answer.entryFaults && Array.isArray(answer.entryFaults[id]) ? answer.entryFaults[id] : null
      state.faults[id] = list && list.length > 0 ? list : [{ field: null, text: state.errors[id] }]
    }
  }

  /** The default value of every field of a type, as the field definitions give it. */
  function defaults (type) {
    const values = {}
    for (const [field, definition] of Object.entries(state.fields[type].properties)) {
      // A setting in the unit of the input path is left empty: its default
      // applies, and an empty field cannot be read as absolute zero.
      if ('default' in definition && field !== 'inputs' && !unitField(type, field)) values[field] = clone(definition.default)
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
      // The ON time so far is read from the stretch under way, so the
      // window and the cycles needed play no part in it.
      if (field === 'minCycles') return entry.statistic !== 'cycles' && entry.statistic !== 'onSoFar'
      if (field === 'window') return entry.statistic !== 'onSoFar'
      return true
    }
    if (entry.type === 'record') {
      const since = entry.keep === 'sinceAbove' || entry.keep === 'sinceBelow'
      if (field === 'level') return since
      if (field === 'resets' || field === 'startValue') return !since
      if (field === 'resetLevel') return !since && entry.resets === 'level'
      if (field === 'resetPath') return !since && entry.resets === 'path'
      return true
    }
    if (field === 'resetPath') return entry.resets === 'path'
    if (field === 'threshold') return entry.mode === 'time'
    if (field === 'reversal') return entry.direction !== 'net'
    return true
  }

  // ------------------------------------------------------------- paths

  // The units of the figures a cycles entry publishes (CYCLE_FIGURES in
  // lib/config.js), for a path that is a cycles entry's output.
  const CYCLE_UNITS = { onMedian: 's', offMedian: 's', periodMedian: 's', duty: 'ratio', lastOn: 's', onSoFar: 's', cycles: '' }

  // Settings given in the unit of the entry's input path.
  const UNIT_FIELDS = { integration: ['threshold'], counter: ['minStep'], record: ['level', 'resetLevel', 'startValue'] }
  function unitField (type, field) {
    return Boolean(UNIT_FIELDS[type] && UNIT_FIELDS[type].includes(field))
  }

  /** The unit of a path: as the server announces it, or as an entry publishes it. */
  function unitsOf (path) {
    if (!path) return null
    const known = state.paths.get(path)
    if (known && known.units) return known.units
    const producer = state.entries.find((entry) => entry.output === path)
    if (!producer) return null
    if (producer.unit) return producer.unit
    if (producer.type === 'record' && (producer.keep === 'sinceAbove' || producer.keep === 'sinceBelow')) return 's'
    return producer.type === 'cycles' ? CYCLE_UNITS[producer.statistic || 'onMedian'] || null : null
  }

  /**
   * A number box for a setting in the unit of a path, shown and typed in the
   * unit the rules editor would show (°C, %, hPa) and kept in the Signal K
   * unit. `onUnit` is told the unit shown whenever it is known anew.
   */
  function unitNumber (holder, field, fallback, pathOf, difference, onUnit) {
    const control = element('input')
    control.type = 'text'
    control.inputMode = 'decimal'
    let shown = null
    let key
    // Set once the value has been typed here. A typed number means what it
    // says in the unit shown when it was typed; when the unit becomes known
    // or changes after that, the number shown is kept and saved anew in the
    // new unit, so "1" typed for a humidity is 1 %, not a ratio of 1.
    let typed = false
    // The text shown for the value as saved, and that value, so that typing
    // the same text again restores it exactly, whatever the rounding.
    let original = null
    const numberIn = (value) => {
      if (typeof value === 'number') return value
      if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
      return null
    }
    const show = () => {
      const value = holder[field]
      const number = numberIn(value)
      control.value = value === undefined || value === null ? '' : number !== null ? String(shown.show(number)) : String(value)
      original = { text: control.value, value }
      // A default with an offset, such as 0 K, would read as -273.15 °C.
      const offset = !difference && shown.show(0) !== 0
      control.placeholder = typeof fallback === 'number' && !offset ? String(shown.show(fallback)) : ''
    }
    const store = () => {
      const text = control.value.trim()
      const number = readNumber(text)
      if (original && text === original.text) holder[field] = original.value
      else if (text === '') delete holder[field]
      else holder[field] = Number.isFinite(number) ? shown.store(number) : text
    }
    const refresh = (force) => {
      const units = unitsOf(pathOf())
      if (!force && units === key) return
      key = units
      shown = shownUnit(units, difference)
      onUnit(shown.unit)
      if (typed) {
        original = null
        store()
        markDirty()
      } else if (document.activeElement !== control) {
        show()
      }
    }
    control.addEventListener('input', () => {
      typed = true
      store()
      markDirty()
    })
    refresh(true)
    return { control, refresh }
  }

  /**
   * A field's title with a More button. Under each field one line says what
   * it is for; More replaces that line with the full help and Less brings it
   * back, so a form can be scanned and the detail is there when it is
   * wanted.
   */
  function fieldHead (label, wrap) {
    const head = element('div', 'field-head')
    // The accessible name starts with the visible word, so a voice command
    // that says what is on screen ("click Less") reaches it.
    const about = label.textContent.replace(/ \(.*\)$/, '')
    const toggle = button('More', 'is-quiet help-toggle', () => {
      const open = !wrap.classList.contains('help-open')
      wrap.classList.toggle('help-open', open)
      toggle.setAttribute('aria-expanded', String(open))
      toggle.textContent = open ? 'Less' : 'More'
      toggle.setAttribute('aria-label', `${open ? 'Less' : 'More'} about ${about}`)
    })
    toggle.setAttribute('aria-expanded', 'false')
    toggle.setAttribute('aria-label', `More about ${about}`)
    head.append(label, toggle)
    return head
  }

  /**
   * The help of a field: its one-line summary, always shown, and its full
   * description, shown on request. A field without a summary shows its
   * description as it is, with no More button.
   */
  function helpOf (definition, description = definition.description) {
    if (!description) return { head: false, nodes: [] }
    if (!definition.summary) return { head: false, nodes: [element('p', 'field-summary', description)] }
    return { head: true, nodes: [element('p', 'field-summary', definition.summary), element('p', 'field-help', description)] }
  }

  /** Points each Help button at the help it shows. */
  function linkHelp (item) {
    let count = 0
    for (const wrap of item.querySelectorAll('.field')) {
      const toggle = wrap.querySelector('.help-toggle')
      if (!toggle) continue
      const ids = []
      for (const help of wrap.querySelectorAll(':scope > .field-help')) {
        help.id = help.id || `${item.dataset.id}-help-${count++}`
        ids.push(help.id)
      }
      if (ids.length > 0) toggle.setAttribute('aria-controls', ids.join(' '))
    }
  }

  /**
   * What a path holds now. A setting in the path's unit is typed in the unit
   * shown (°C, %, hPa), so that unit leads. A formula calculates with the
   * value as published, so for its inputs the published unit leads.
   */
  function describePath (path, publishedFirst) {
    if (!path) return ''
    // A typing mistake is said as such, rather than as a path that holds
    // no value, which would send the user looking for a silent device.
    if (!PATH_PATTERN.test(path)) return 'Not a valid path: use dot-separated segments of letters, digits, dashes and underscores, with no spaces.'
    const known = state.paths.get(path)
    const producer = state.entries.find((entry) => entry.output === path)
    const from = producer ? ` Published by the entry "${entryLabel(producer)}".` : ''
    if (!known) return producer ? `Not published yet.${from}` : 'The server holds no value on this path at the moment.'
    if (known.value !== undefined) {
      // In the unit settings for this path are typed in, as the rules
      // editor shows it, with the value as published beside it.
      const shown = typeof known.value === 'number' ? shownUnit(known.units, false) : null
      if (shown && shown.unit && shown.unit !== known.units && !publishedFirst) return `Now ${figure(shown.show(known.value))} ${shown.unit} (${figure(known.value)} ${known.units} as published).${from}`
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

  /**
   * Reads the set the server holds. Gives the answer's body, or the text
   * that says why there is none.
   */
  async function fetchSet () {
    let result
    try {
      result = await api('/config')
    } catch (err) {
      return { problem: 'The server could not be reached.' }
    }
    if (result.status === 401 || result.status === 403) {
      state.permitted = false
      return { problem: 'This login may read the calculated paths but not change them. Log in as a user with read/write permission to edit the entries.' }
    }
    if (!result.ok || !result.body) {
      // A plugin that is not running can be enabled from its settings page,
      // so the message links there, as the status view does.
      const off = result.status === 503 && result.body && result.body.error && !result.body.blocked
      return { problem: result.body && result.body.error ? result.body.error : `The server answered ${result.status}.`, link: off ? { text: 'Open the configuration', href: SETTINGS_URL } : null }
    }
    state.permitted = true
    return { body: result.body }
  }

  async function load () {
    const { body, problem, link } = await fetchSet()
    if (problem) {
      showMessage(problem, link)
      return false
    }
    take(body)
    return true
  }

  /** Makes a set read from the server both the saved set and the copy edited. */
  function take (body) {
    state.saved = { groups: body.groups, entries: body.entries }
    state.savedKey = canonical(state.saved)
    state.revision = body.revision
    state.blocked = body.blocked
    state.fields = body.fields
    state.order = body.order
    state.advancedFields = body.advanced || null
    state.groups = clone(body.groups)
    state.entries = clone(body.entries)
    state.dirty = false
    state.errors = Object.create(null)
    state.faults = Object.create(null)
    state.loaded = true
    state.staleRevision = null
    window.CalcPaths.app.setUnsaved(false)
  }

  /**
   * Looks whether the set on the server is still the one this editor read.
   * Without unsaved changes a newer set is taken at once, and focus stays
   * on the control it was on. With unsaved changes the editor says so
   * straight away, before a save would be refused, and keeps the changes.
   */
  async function checkRevision () {
    if (!state.loaded || state.sending) return
    const before = state.revision
    const changes = state.changes
    const { body } = await fetchSet()
    // Nothing is done with an answer that a save, or an edit, has overtaken.
    if (!body || !visible || state.sending || state.revision !== before) return
    if (body.revision === state.revision && body.blocked === state.blocked) return
    if (state.dirty) {
      if (state.staleRevision === body.revision) return
      state.staleRevision = body.revision
      showInPlace(changedElsewhere('The entries were changed elsewhere since this editor read them, so the changes here cannot be saved over them. Export them first to keep them, then reload.'))
      return
    }
    if (state.changes !== changes) return
    // A question being answered on the page is left alone: the set is
    // taken on a later look.
    const active = document.activeElement
    if (view.contains(active) && active.closest('.confirm')) return
    if ([...view.querySelectorAll('.adder-choices')].some((choices) => !choices.hidden && !choices.dataset.auto)) return
    const focus = view.contains(active) ? selectorFor(active) : null
    take(body)
    state.notice = notice('info', 'The entries were changed elsewhere. The editor now shows them as saved there.')
    await loadPaths()
    render(focus)
  }

  /** A selector that finds a control again after the page is drawn anew. */
  function selectorFor (control) {
    if (control.id) return `[id="${window.CSS.escape(control.id)}"]`
    if (control.dataset.focus) return `[data-focus="${window.CSS.escape(control.dataset.focus)}"]`
    if (control.dataset.groupName) return `[data-group-name="${window.CSS.escape(control.dataset.groupName)}"]`
    return null
  }

  /** The notice for a set changed elsewhere, with a way to keep the changes made here. */
  function changedElsewhere (text) {
    const box = element('div', 'notice is-error')
    box.tabIndex = -1
    box.append(element('p', '', text))
    box.append(button('Reload, losing the changes here', '', async () => { await reopen() }), ' ', button('Export the changes here first', 'is-quiet', exportSet))
    return box
  }

  /** Shows a notice above the entries without drawing the page anew. */
  function showInPlace (box) {
    const holder = view.querySelector('.editor-notices')
    if (!holder) return
    if (state.notice && state.notice.parentNode === holder) state.notice.replaceWith(box)
    else holder.append(box)
    state.notice = box
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

  function showMessage (text, link) {
    const message = element('p', 'placeholder', text)
    if (link) {
      const anchor = element('a', '', link.text)
      anchor.href = link.href
      message.append(' ', anchor)
    }
    view.replaceChildren(message)
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
    watchToolbar(toolbar)
    if (focus) {
      const target = find(focus)
      if (target) {
        target.focus()
        // On a narrow screen a button under a folded "Actions" cannot take
        // focus; the Actions button takes it instead.
        const more = view.querySelector('.toolbar-more-toggle')
        if (document.activeElement !== target && more && target.closest('.toolbar-more')) more.focus()
      }
    }
  }

  /** The first element a selector finds in the editor, or null. */
  function find (selector) {
    // Every id put in a selector is escaped; this guards against the rest.
    try {
      return view.querySelector(selector)
    } catch (err) {
      return null
    }
  }

  /**
   * Keeps the page's scroll padding as tall as the editing bar that stays
   * at the top, so a control that takes focus is never hidden under it.
   */
  let toolbarWatch = null
  function watchToolbar (toolbar) {
    if (toolbarWatch) toolbarWatch.disconnect()
    const apply = () => {
      if (!visible) return
      const margin = parseFloat(window.getComputedStyle(toolbar).marginBottom) || 0
      document.documentElement.style.scrollPaddingTop = `${Math.ceil(toolbar.offsetHeight + margin)}px`
    }
    apply()
    if (window.ResizeObserver) {
      toolbarWatch = new window.ResizeObserver(apply)
      toolbarWatch.observe(toolbar)
    }
  }

  function renderToolbar () {
    const bar = element('div', 'editor-toolbar')
    const status = element('span', 'editor-status')
    status.id = 'editor-status'
    const save = button('Save', 'is-primary', () => saveAll())
    save.id = 'editor-save'
    const discard = button('', 'is-quiet', () => discardAll())
    discard.append(...twoLengths('Discard changes', 'Discard'))
    discard.id = 'editor-discard'
    const addGroup = button('Add group', '', () => {
      state.moreOpen = false
      const group = { id: newId('g'), name: 'New group' }
      state.groups.push(group)
      markDirty()
      const selector = `[data-group-name="${window.CSS.escape(group.id)}"]`
      render(selector)
      // The new group is added at the end of the page, which may be out of
      // sight: it is brought to the middle, its name selected to type over.
      const field = find(selector)
      if (field) {
        field.closest('section').scrollIntoView({ block: 'center' })
        field.select()
      }
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
    const more = element('div', 'toolbar-more')
    more.id = 'toolbar-more'
    more.append(expandButton(null), addGroup, exportButton, importLabel)
    // On a narrow screen the less frequent actions fold behind "Actions", so
    // the bar that stays at the top takes one line. It is not called "More",
    // which is the label of every field's help toggle.
    const moreToggle = button('Actions', 'is-quiet toolbar-more-toggle', () => {
      state.moreOpen = !state.moreOpen
      bar.classList.toggle('is-more-open', state.moreOpen)
      moreToggle.setAttribute('aria-expanded', String(state.moreOpen))
    })
    moreToggle.setAttribute('aria-controls', 'toolbar-more')
    moreToggle.setAttribute('aria-expanded', String(Boolean(state.moreOpen)))
    if (state.moreOpen) bar.classList.add('is-more-open')
    main.append(save, discard, status, moreToggle)
    bar.append(main, more)
    return bar
  }

  /** A text in a long and a short wording; a narrow screen shows the short. */
  function twoLengths (long, short) {
    return [element('span', 'long-text', long), element('span', 'short-text', short)]
  }

  function updateToolbar () {
    const status = document.getElementById('editor-status')
    const save = document.getElementById('editor-save')
    const discard = document.getElementById('editor-discard')
    if (!status) return
    const [long, short] = state.sending ? ['Saving', 'Saving'] : state.dirty ? ['Unsaved changes', 'Unsaved'] : ['All changes saved', 'Saved']
    if (status.dataset.text !== long) {
      status.dataset.text = long
      status.replaceChildren(...twoLengths(long, short))
    }
    status.classList.toggle('is-unsaved', state.dirty && !state.sending)
    save.disabled = !state.dirty || state.sending
    discard.disabled = !state.dirty || state.sending
  }

  /** The entries an Expand all / Collapse all button acts on: all, or a group's. */
  function scopeEntries (scope) {
    if (scope === null) return state.entries
    return state.entries.filter((entry) => (entry.group || '') === scope)
  }

  /**
   * An Expand all / Collapse all button for every entry (scope null) or for
   * the entries of one group ('' for those outside any group). It is named
   * after what it will do: it expands every entry while any is collapsed,
   * and collapses them all once all are expanded.
   */
  function expandButton (scope, groupName) {
    const control = button('', 'is-quiet expand-all', () => {
      const expand = control.dataset.expand === 'true'
      for (const entry of scopeEntries(scope)) {
        if (expand) state.expanded.add(entry.id)
        else state.expanded.delete(entry.id)
      }
      render(`[data-focus="${window.CSS.escape(control.dataset.focus)}"]`)
    })
    // The scope is kept on the element itself: a group id from an imported
    // file may hold any character.
    control.expandScope = scope
    control.dataset.focus = scope === null ? 'expand-all' : `expand-group-${scope}`
    // How the button's spoken name says where it acts.
    control.dataset.where = scope === null ? '' : scope === '' ? ' outside the groups' : ` in ${groupName}`
    labelExpandButton(control)
    return control
  }

  function labelExpandButton (control) {
    const entries = scopeEntries(control.expandScope)
    const expand = entries.length === 0 || entries.some((entry) => !state.expanded.has(entry.id))
    control.dataset.expand = String(expand)
    control.textContent = expand ? 'Expand all' : 'Collapse all'
    control.disabled = entries.length === 0
    control.setAttribute('aria-label', `${expand ? 'Expand' : 'Collapse'} all entries${control.dataset.where}`)
  }

  /** Renames every Expand all / Collapse all button after a card opens or closes. */
  function updateExpandButtons () {
    for (const control of view.querySelectorAll('.expand-all')) labelExpandButton(control)
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
      const expandGroup = expandButton(group.id, group.name)
      name.addEventListener('input', () => {
        group.name = name.value
        markDirty()
        expandGroup.dataset.where = ` in ${group.name}`
        labelExpandButton(expandGroup)
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
      tools.append(expandGroup, up, down, remove)
      head.append(name, tools)
    } else {
      // Without groups there is nothing else to tell these entries from, so
      // the block has no heading; the button in the editing bar expands.
      if (state.groups.length > 0) {
        head.append(element('h2', 'edit-group-title', 'Not in a group'))
        const tools = element('div', 'edit-group-tools')
        tools.append(expandButton(''))
        head.append(tools)
      }
    }
    section.append(head)

    const list = element('ol', 'cards')
    list.dataset.group = id || ''
    const entries = state.entries.filter((entry) => (entry.group || null) === id)
    for (const entry of entries) list.append(renderCard(entry, entries))
    if (entries.length === 0) {
      const empty = group ? 'No entries in this group yet. Add one below, or drag one here.' : state.groups.length === 0 ? 'No entries yet. Choose what to calculate:' : 'No entries outside the groups.'
      list.append(element('li', 'cards-empty', empty))
    }
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
      delete choices.dataset.auto
      open.setAttribute('aria-expanded', String(!choices.hidden))
      if (!choices.hidden) choices.querySelector('button').focus()
    })
    const choices = element('div', 'adder-choices')
    // With no entries at all the choice of a first entry is open at once.
    const first = groupId === null && state.entries.length === 0 && state.groups.length === 0
    choices.hidden = !first
    if (first) choices.dataset.auto = 'true'
    for (const [type, info] of Object.entries(TYPES)) {
      const choice = button('', 'adder-choice', () => addEntry(type, groupId))
      choice.append(element('strong', '', info.label), element('span', '', info.explain))
      choices.append(choice)
    }
    open.setAttribute('aria-expanded', String(!choices.hidden))
    wrap.append(open, choices)
    return wrap
  }

  /** The fields of a type folded under "Advanced settings", as the plugin lists them. */
  function advancedOf (type) {
    return (state.advancedFields && state.advancedFields[type]) || []
  }

  /**
   * Names, on the folded section's own line, the advanced settings that
   * differ from their defaults, so a folded section hides nothing that was
   * changed. A section holding a field with a fault opens.
   */
  function describeAdvanced (entry, live) {
    if (!live.advanced) return
    const properties = state.fields[entry.type].properties
    const changed = advancedOf(entry.type).filter((field) => {
      if (!(field in properties) || !applies(entry, field)) return false
      const value = entry[field]
      if (value === undefined || value === null || value === '') return false
      return 'default' in properties[field] ? canonical(value) !== canonical(properties[field].default) : true
    }).map((field) => properties[field].title.replace(/ \(.*\)$/, ''))
    live.advanced.title.replaceChildren('Advanced settings', element('span', 'advanced-note', changed.length === 0 ? ' (all at their defaults)' : ` (changed: ${changed.join(', ')})`))
    const faulty = (state.faults[entry.id] || []).some((fault) => fault.field && advancedOf(entry.type).includes(fault.field))
    if (faulty) live.advanced.details.open = true
  }

  /**
   * The output path under a card's title, wrapping only after a dot as the
   * status page does, so a narrow screen never breaks a segment in two.
   */
  function showOutput (node, path) {
    node.replaceChildren(path ? pathCode(path) : element('span', 'card-output-none', 'no output path yet'))
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
      draggedId = entry.id
      try { event.dataTransfer.setDragImage(item, 20, 20) } catch (err) { /* not offered by every browser */ }
      item.classList.add('is-dragging')
    })
    handle.addEventListener('dragend', () => {
      item.classList.remove('is-dragging')
      draggedId = null
    })

    const expanded = state.expanded.has(entry.id)
    const toggle = element('button', 'card-toggle')
    toggle.type = 'button'
    toggle.setAttribute('aria-expanded', String(expanded))
    toggle.dataset.focus = `toggle-${entry.id}`
    const title = element('span', 'card-title', entryLabel(entry))
    const kind = element('span', 'card-kind', TYPES[entry.type].label + (entry.enabled === false ? ', disabled' : ''))
    const output = element('span', 'card-output')
    showOutput(output, entry.output)
    toggle.append(title, kind, output)
    toggle.addEventListener('click', () => {
      if (state.expanded.has(entry.id)) state.expanded.delete(entry.id)
      else state.expanded.add(entry.id)
      const open = state.expanded.has(entry.id)
      toggle.setAttribute('aria-expanded', String(open))
      body.hidden = !open
      if (open) refreshCard(entry.id)
      updateExpandButtons()
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

    const error = element('div', 'card-error')
    error.id = `faults-${entry.id}`
    drawFaults(error, entry)

    const body = element('div', 'card-body')
    body.hidden = !expanded
    const form = element('div', 'card-form')
    const live = { title, kind, output, error, body, hints: new Map(), inputHints: [], unitFields: [], unitNotes: [], rows: new Map(), chain: null, preview: null, previewTimer: null, previewAsked: 0 }
    // The settings most entries leave at their defaults sit in a folded
    // section at the end, so the form shows first what defines the entry.
    const advanced = element('details', 'advanced-settings')
    const advancedTitle = element('summary')
    advanced.append(advancedTitle)
    advanced.open = state.advanced.has(entry.id)
    advanced.addEventListener('toggle', () => {
      if (advanced.open) state.advanced.add(entry.id)
      else state.advanced.delete(entry.id)
    })
    live.advanced = { details: advanced, title: advancedTitle }
    for (const field of orderedFields(entry.type)) {
      const row = renderField(entry, field, live)
      if (advancedOf(entry.type).includes(field)) advanced.append(row)
      else form.append(row)
    }
    if (advanced.childElementCount > 1) form.append(advanced)
    describeAdvanced(entry, live)
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
      render(`[data-focus="${window.CSS.escape(`toggle-${entry.id}`)}"]`)
    })
    const groupLabel = element('label', 'card-group')
    groupLabel.append('Group ', groupSelect)
    const duplicate = button('Duplicate', 'is-quiet', () => duplicateEntry(entry))
    const remove = button('Delete entry', 'is-quiet is-danger', () => confirmInline(remove, 'Delete this entry?', () => deleteEntry(entry)))
    footer.append(groupLabel, duplicate, remove)
    body.append(form, chain, footer)

    item.append(head, error, body)
    markFaults(entry, item)
    linkHelp(item)
    // A marked field loses its mark, and its fault, once it is changed, so
    // neither comes back when the page is drawn again. Taken before the
    // field's own handler, which may mark the field again.
    const unmark = (event) => {
      const target = event.target
      if (target && target.dataset && target.dataset.fault) {
        const field = target.dataset.fault
        delete target.dataset.fault
        target.removeAttribute('aria-invalid')
        describedBy(target, `faults-${entry.id}`, false)
        dropFaults(entry, live, (name) => name === field)
      }
    }
    item.addEventListener('input', unmark, true)
    item.addEventListener('change', unmark, true)
    // After the field's own handler has stored the value: the folded
    // section's line names what differs from the defaults.
    item.addEventListener('input', () => describeAdvanced(entry, live))
    item.addEventListener('change', () => describeAdvanced(entry, live))
    addCardDrop(item, entry)
    state.cards.set(entry.id, live)
    refreshCard(entry.id)
    return item
  }

  /** The faults the last save found in an entry, all of them when several. */
  function drawFaults (error, entry) {
    const faults = state.faults[entry.id] || []
    error.hidden = !state.errors[entry.id]
    if (faults.length > 1) {
      const list = element('ul')
      for (const item of faults) list.append(element('li', '', `${item.text.charAt(0).toUpperCase()}${item.text.slice(1)}.`))
      error.replaceChildren(element('p', '', 'Cannot run as set:'), list)
    } else {
      error.textContent = state.errors[entry.id] ? `Cannot run as set: ${state.errors[entry.id]}.` : ''
    }
  }

  /** The control a fault's field names, if the form has one for it. */
  function faultControl (item, entry, field) {
    if (!field) return null
    const match = /^inputs\.(\d+)\.(\w+)$/.exec(field)
    if (match) {
      const row = item.querySelectorAll('.inputs > .input-row, .inputs > .cycle-input')[Number(match[1])]
      if (!row) return null
      if (match[2] === 'path') return row.querySelector('.input-path')
      if (match[2] === 'name') return row.querySelector('.input-name')
      return row.querySelector(`[data-setting="${window.CSS.escape(match[2])}"]`)
    }
    return item.querySelector(`[id="${window.CSS.escape(`f-${entry.id}-${field}`)}"]`)
  }

  /**
   * Forgets an entry's faults whose field passes `test`, once it has been
   * changed, and redraws the list; the entry shows no fault once none is
   * left. The faults of other fields stay until the next save.
   */
  function dropFaults (entry, live, test) {
    const faults = state.faults[entry.id]
    if (!faults) return
    const left = faults.filter((fault) => !(fault.field && test(fault.field)))
    if (left.length === faults.length) return
    if (left.length === 0) {
      delete state.faults[entry.id]
      delete state.errors[entry.id]
      live.error.closest('.card').classList.remove('has-error')
    } else {
      state.faults[entry.id] = left
      state.errors[entry.id] = left[0].text
    }
    drawFaults(live.error, entry)
  }

  /** Adds an id to the texts that describe a control, or takes it away. */
  function describedBy (control, id, on) {
    const ids = (control.getAttribute('aria-describedby') || '').split(' ').filter((one) => one && one !== id)
    if (on) ids.push(id)
    if (ids.length > 0) control.setAttribute('aria-describedby', ids.join(' '))
    else control.removeAttribute('aria-describedby')
  }

  /** Marks each field a fault lies in, and ties it to the list of faults. */
  function markFaults (entry, item) {
    for (const fault of state.faults[entry.id] || []) {
      const control = faultControl(item, entry, fault.field)
      if (!control) continue
      control.setAttribute('aria-invalid', 'true')
      describedBy(control, `faults-${entry.id}`, true)
      control.dataset.fault = fault.field
    }
  }

  /**
   * The warning under the Unit field when it holds a unit Signal K does
   * not know. Saving stays allowed: the value is published as it is.
   */
  function unitWarning (control, warning) {
    const unit = control.value.trim()
    const foreign = unit !== '' && !SIGNALK_UNITS.has(unit)
    warning.textContent = foreign
      ? `"${unit}" is not a Signal K unit. Signal K publishes SI units such as W, J, V, A, s, m3, K, Pa and ratio; displays convert from them, and a non-SI unit is shown as is.`
      : ''
    warning.hidden = !foreign
    describedBy(control, warning.id, foreign)
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
        live.kind.textContent = TYPES[entry.type].label + (entry.enabled === false ? ', disabled' : '')
        live.title.closest('.card').classList.toggle('is-off', entry.enabled === false)
      })
      const label = element('label', 'field-check')
      label.htmlFor = fieldId
      label.append(box, ` ${definition.title}`)
      const help = helpOf(definition)
      wrap.append(help.head ? fieldHead(label, wrap) : label, ...help.nodes)
      return wrap
    }

    const label = element('label', 'field-label', definition.title)
    label.htmlFor = fieldId
    const help = helpOf(definition)
    wrap.append(help.head ? fieldHead(label, wrap) : label)
    // A node shown under the control, for a field that has one.
    let after = null
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
    } else if (definition.format === 'date-time') {
      // Typed in this browser's time zone and kept as a time in UTC, the
      // form the plugin reads; see readMoment() in lib/config.js.
      control = element('input')
      control.type = 'datetime-local'
      control.step = '1'
      const hint = element('p', 'field-hint')
      const pad = (n) => String(n).padStart(2, '0')
      const local = (ms) => {
        const d = new Date(ms)
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
      }
      const describe = () => {
        const text = entry[field]
        const ms = typeof text === 'string' ? Date.parse(text) : NaN
        hint.textContent = text === undefined || text === '' ? '' : Number.isFinite(ms) ? `Saved as ${new Date(ms).toISOString().replace('.000Z', 'Z')} (UTC).` : `Saved as "${text}", which is not a date and time with a time zone.`
      }
      const saved = typeof entry[field] === 'string' ? Date.parse(entry[field]) : NaN
      control.value = Number.isFinite(saved) ? local(saved) : ''
      control.addEventListener('input', () => {
        const ms = control.value ? new Date(control.value).getTime() : NaN
        if (!control.value) delete entry[field]
        else if (Number.isFinite(ms)) entry[field] = new Date(ms).toISOString().replace('.000Z', 'Z')
        describe()
        markDirty()
      })
      describe()
      after = hint
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
    } else if (definition.type === 'number' && unitField(entry.type, field)) {
      // In the unit of the input path, shown as the rules editor shows it.
      // A path that announces no unit is compared as published: a battery
      // charge without a unit may be a ratio, where full is 1, not 100. The
      // note says so with the value the input holds now, so that a level
      // typed in the wrong scale shows before it is saved.
      const note = element('p', 'field-hint')
      const explainScale = () => {
        const known = state.paths.get(entry.input)
        const show = Boolean(entry.input) && !unitsOf(entry.input) && Boolean(known) && typeof known.value === 'number'
        note.hidden = !show
        note.textContent = show ? `No unit is announced for the input, so this is compared with its value as published (now ${figure(known.value)}).` : ''
      }
      const number = unitNumber(entry, field, definition.default, () => entry.input, field === 'minStep', (unit) => {
        label.textContent = `${definition.title} (${unit || 'in the input\'s unit'})`
        explainScale()
      })
      live.unitFields.push(number)
      live.unitNotes.push(explainScale)
      control = number.control
      after = note
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
          const number = readNumber(text)
          if (text.trim() === '') delete entry[field]
          else entry[field] = Number.isFinite(number) ? number : text
        } else {
          entry[field] = text.trim()
        }
        markDirty()
        if (field === 'name' || field === 'output') {
          live.title.textContent = entryLabel(entry)
          showOutput(live.output, entry.output)
        }
        if (PATH_FIELDS.has(field)) {
          checkPath(control, field, entry[field])
          refreshChains()
        }
        if (PATH_FIELDS.has(field)) refreshHint(live, field, entry[field])
        if (field === 'input') {
          for (const number of live.unitFields) number.refresh()
          for (const explainScale of live.unitNotes) explainScale()
        }
        if (field === 'staleTimeout' && entry.type === 'formula') schedulePreview(entry, live)
      })
    }
    control.id = fieldId
    wrap.append(control)
    if (after) wrap.append(after)
    if (field === 'unit') {
      const warning = element('p', 'field-warning')
      warning.id = `${fieldId}-warning`
      wrap.append(warning)
      unitWarning(control, warning)
      control.addEventListener('input', () => unitWarning(control, warning))
    }
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
    wrap.append(...help.nodes)
    return wrap
  }

  /** The inputs of a formula: short names, each with its path. */
  function renderInputs (entry, definition, wrap, live) {
    wrap.append(fieldHead(element('p', 'field-label', definition.title), wrap))
    const names = definition.items.properties.name
    const paths = definition.items.properties.path
    const whenStaleField = definition.items.properties.whenStale
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
          hint.textContent = describePath(input.path, true)
          refreshChains()
          schedulePreview(entry, live)
        })
        hint.textContent = describePath(input.path, true)
        // The value used while the input is stale, has no value or no
        // number, in the unit Signal K publishes for the path, as the
        // formula calculates with it. Empty means none.
        const stale = element('label', 'input-stale')
        const staleBox = element('input')
        staleBox.type = 'text'
        staleBox.inputMode = 'decimal'
        staleBox.placeholder = 'none'
        staleBox.dataset.setting = 'whenStale'
        staleBox.value = input.whenStale === undefined || input.whenStale === null ? '' : String(input.whenStale)
        const staleUnit = element('span', 'input-stale-unit', unitsOf(input.path) || '')
        staleBox.addEventListener('input', () => {
          const text = staleBox.value.trim()
          const number = readNumber(text)
          if (text === '') delete input.whenStale
          else input.whenStale = Number.isFinite(number) ? number : text
          markDirty()
          schedulePreview(entry, live)
        })
        stale.append(element('span', 'input-stale-title', whenStaleField ? whenStaleField.title : 'Value when stale'), staleBox, staleUnit)
        path.addEventListener('input', () => { staleUnit.textContent = unitsOf(input.path) || '' })
        live.inputHints.push({ hint, input, publishedFirst: true, unit: staleUnit })
        const remove = button('Remove', 'is-quiet', () => {
          entry.inputs.splice(index, 1)
          dropFaults(entry, live, (field) => /^inputs\./.test(field))
          markDirty()
          draw()
          focusAfterRemove(table, add, index)
          refreshChains()
          schedulePreview(entry, live)
        }, `Remove input ${input.name || index + 1}`)
        row.append(name, path, remove, hint, stale)
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
    // The help names each part of an input row, as the row shows them.
    const details = element('div', 'field-help')
    for (const part of [names, paths, whenStaleField].filter(Boolean)) {
      const line = element('p')
      line.append(element('strong', '', `${part.title}: `), part.description)
      details.append(line)
    }
    wrap.append(table, add, element('p', 'field-summary', definition.summary || ''), details)
    return wrap
  }

  /**
   * The inputs of a Cycles entry: each a path, read as on/off against a
   * threshold or as a wave with a direction and a swing.
   */
  function renderCycleInputs (entry, definition, wrap, live) {
    wrap.append(fieldHead(element('p', 'field-label', definition.title), wrap))
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
      live.unitFields = []
      entry.inputs.forEach((input, index) => {
        const number = index + 1
        const rowUnits = []
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
          for (const setting of rowUnits) setting.refresh()
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
        // The threshold and the swing are shown in the unit of the input's
        // path, as the rules editor shows it, and kept in the Signal K unit.
        const unitField = (field) => {
          const caption = element('span', '', item[field].title)
          const box = unitNumber(input, field, item[field].default, () => input.path, field === 'swing', (unit) => {
            caption.textContent = `${item[field].title} (${unit || 'in the input\'s unit'})`
          })
          box.control.dataset.setting = field
          rowUnits.push(box)
          live.unitFields.push(box)
          const label = element('label', 'cycle-input-setting')
          label.append(caption, box.control)
          return label
        }
        const threshold = unitField('threshold')
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
        const swing = unitField('swing')
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
          dropFaults(entry, live, (field) => /^inputs\./.test(field))
          draw()
          focusAfterRemove(table, add, index)
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
    help.append(element('p', '', definition.description))
    for (const field of ['kind', 'threshold', 'direction', 'swing']) {
      const line = element('p')
      line.append(element('strong', '', `${item[field].title}: `), item[field].description)
      help.append(line)
    }
    wrap.append(table, add, element('p', 'field-summary', definition.summary || ''), help)
    return wrap
  }

  /** After an input is removed, focus goes to the input now in its place. */
  function focusAfterRemove (table, add, index) {
    const paths = table.querySelectorAll('.input-path')
    const next = paths[Math.min(index, paths.length - 1)]
    ;(next || add).focus()
  }

  /** A short name not used yet in a formula: a, b, c, ... */
  function suggestName (entry) {
    const used = new Set((entry.inputs || []).map((input) => input.name))
    for (const letter of 'abcdefghijklmnopqrstuvwxyz') if (!used.has(letter)) return letter
    return `x${used.size + 1}`
  }

  function checkPath (control, field, value) {
    const pattern = OUTPUT_FIELDS.has(field) ? OUTPUT_PATTERN : PATH_PATTERN
    control.setAttribute('aria-invalid', String(Boolean(value) && !pattern.test(value)))
  }

  function refreshHint (live, field, value) {
    const hint = live.hints.get(field)
    if (!hint) return
    if (OUTPUT_FIELDS.has(field)) {
      // An empty field writes nothing: without this, every other entry
      // with an empty path for the time would count as writing it.
      if (!value) {
        hint.textContent = ''
        return
      }
      if (!OUTPUT_PATTERN.test(value)) {
        hint.textContent = 'Not a valid path: use at least two dot-separated segments of letters, digits, dashes and underscores, with no spaces.'
        return
      }
      const others = state.entries.filter((entry) => entry.output === value || entry.timeOutput === value)
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
    for (const { hint, input, publishedFirst, unit } of live.inputHints) {
      hint.textContent = describePath(input.path, publishedFirst)
      if (unit) unit.textContent = unitsOf(input.path) || ''
    }
    for (const number of live.unitFields) number.refresh()
    for (const explainScale of live.unitNotes) explainScale()
    refreshChain(entry, live)
    // The preview asks the server, so only open cards keep it current.
    if (entry.type === 'formula' && !live.body.hidden) schedulePreview(entry, live, 0)
  }

  /** The paths an entry reads. */
  function readsOf (entry) {
    const paths = Array.isArray(entry.inputs) ? entry.inputs.map((input) => input.path) : [entry.input]
    if ((entry.type === 'counter' || entry.type === 'integration' || entry.type === 'record') && entry.resets === 'path') paths.push(entry.resetPath)
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

  /** Names the inputs a preview counted as their value when stale. */
  function describeSubstituted (substituted) {
    if (!Array.isArray(substituted) || substituted.length === 0) return ''
    const why = { stale: 'stale', none: 'no value', invalid: 'no number now' }
    return `. Counted as their value when stale: ${substituted.map((item) => `${item.name} as ${figure(item.value)} (${why[item.reason] || item.reason})`).join(', ')}.`
  }

  function schedulePreview (entry, live, delay = PREVIEW_DELAY_MS) {
    if (!live.preview) return
    clearTimeout(live.previewTimer)
    live.previewTimer = setTimeout(async () => {
      // Each request is numbered, so that an answer overtaken by a later
      // request, which may arrive after it, is not shown.
      const asked = ++live.previewAsked
      const inputs = (entry.inputs || []).filter((input) => input.name && input.path)
      if (!entry.expression) {
        live.preview.className = 'field-preview'
        live.preview.textContent = ''
        return
      }
      let result
      try {
        result = await api('/preview', { method: 'POST', body: { inputs, expression: entry.expression, staleTimeout: entry.staleTimeout } })
      } catch (err) {
        result = null
      }
      if (asked !== live.previewAsked) return
      const body = (result && result.body) || {}
      live.preview.className = 'field-preview'
      if (!result) {
        live.preview.textContent = 'Not checked: the server could not be reached.'
      } else if (!result.ok) {
        live.preview.textContent = `Not checked: the server answered ${result.status}.`
      } else if (body.error) {
        live.preview.textContent = `Cannot calculate: ${body.error}.`
        live.preview.classList.add('is-error')
      } else if (body.missing) {
        live.preview.textContent = `No result yet: no value on ${body.missing.join(', ')} at the moment.${describeSubstituted(body.substituted)}`
      } else {
        const unit = entry.unit ? ` ${entry.unit}` : ''
        const converted = entry.unit ? everyday(body.value, entry.unit, 'formula') : null
        const reading = converted ? ` (${converted.figure}${converted.unit ? ` ${converted.unit}` : ''})` : ''
        live.preview.textContent = `With the current values: ${figure(body.value)}${unit}${reading}${describeSubstituted(body.substituted)}`
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
    // Escape cancels, as it would close a dialog.
    box.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      no.click()
    })
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
    render(`[id="${window.CSS.escape(`f-${entry.id}-name`)}"]`)
  }

  function duplicateEntry (entry) {
    const copy = { ...clone(entry), id: newId('e'), name: `${entryLabel(entry)} (copy)`, output: '' }
    state.entries.splice(state.entries.indexOf(entry) + 1, 0, copy)
    state.expanded.add(copy.id)
    markDirty()
    render(`[id="${window.CSS.escape(`f-${copy.id}-output`)}"]`)
  }

  function deleteEntry (entry) {
    const siblings = state.entries.filter((e) => (e.group || null) === (entry.group || null))
    const next = siblings[siblings.indexOf(entry) + 1] || siblings[siblings.indexOf(entry) - 1]
    state.entries.splice(state.entries.indexOf(entry), 1)
    state.expanded.delete(entry.id)
    delete state.errors[entry.id]
    delete state.faults[entry.id]
    markDirty()
    render(next ? `[data-focus="${window.CSS.escape(`toggle-${next.id}`)}"]` : '#editor-add-group')
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
    render(`[data-focus="${window.CSS.escape(`${focus}-${entry.id}`)}"]`)
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
    render(`[data-focus="${window.CSS.escape(`group-${focus}-${group.id}`)}"]`)
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
      if (!draggedId) return
      event.preventDefault()
      event.stopPropagation()
      const box = item.getBoundingClientRect()
      const after = event.clientY > box.top + box.height / 2
      item.classList.toggle('drop-before', !after)
      item.classList.toggle('drop-after', after)
    })
    item.addEventListener('dragleave', () => item.classList.remove('drop-before', 'drop-after'))
    item.addEventListener('drop', (event) => {
      if (!draggedId) return
      event.preventDefault()
      event.stopPropagation()
      const after = item.classList.contains('drop-after')
      item.classList.remove('drop-before', 'drop-after')
      const dragged = entryById(draggedId)
      draggedId = null
      if (!dragged || dragged === entry) return
      const group = entry.group || null
      let before = entry.id
      if (after) {
        const siblings = state.entries.filter((e) => (e.group || null) === group && e !== dragged)
        const next = siblings[siblings.indexOf(entry) + 1]
        before = next ? next.id : null
      }
      moveToGroup(dragged, group, before)
      render(`[data-focus="${window.CSS.escape(`toggle-${dragged.id}`)}"]`)
    })
  }

  /** A drop on the list itself, outside any card, puts the entry at its end. */
  function addDropTarget (list, groupId) {
    list.addEventListener('dragover', (event) => {
      if (!draggedId) return
      event.preventDefault()
      list.classList.add('is-drop-target')
    })
    list.addEventListener('dragleave', (event) => {
      if (!list.contains(event.relatedTarget)) list.classList.remove('is-drop-target')
    })
    list.addEventListener('drop', (event) => {
      if (!draggedId) return
      event.preventDefault()
      list.classList.remove('is-drop-target')
      const dragged = entryById(draggedId)
      draggedId = null
      if (!dragged) return
      moveToGroup(dragged, groupId, null)
      render(`[data-focus="${window.CSS.escape(`toggle-${dragged.id}`)}"]`)
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
    if (entry.type === 'record') {
      // What decides what the record holds (signature() in lib/engine.js);
      // the start entered by hand does not.
      const keep = ['lowest', 'highest', 'sinceAbove', 'sinceBelow'].includes(entry.keep) ? entry.keep : 'lowest'
      const since = keep === 'sinceAbove' || keep === 'sinceBelow'
      const number = (value) => {
        const n = value === null || value === '' || value === undefined ? NaN : Number(value)
        return Number.isFinite(n) ? n : null
      }
      const resets = since ? 'manual' : (['day', 'week', 'month', 'year', 'level', 'path', 'manual'].includes(entry.resets) ? entry.resets : 'manual')
      return ['record', entry.input || '', keep, since ? number(entry.level) : '', resets, resets === 'level' ? number(entry.resetLevel) : '', resets === 'path' ? entry.resetPath || '' : ''].join('|')
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
        const what = { cycles: 'the cycles counted so far', record: 'its record' }[old.type] || 'its total'
        lost.push(renamed
          ? `"${entryLabel(renamed)}" starts again: its output path changed, and ${what} stay${old.type === 'cycles' ? '' : 's'} with the old path.`
          : `"${entryLabel(old)}" is deleted, and ${what} with it.`)
      } else if (measure(entry) !== before) {
        // An entry that fills in from the history gets back what the
        // history still holds.
        const refill = entry.lookback === false ? '' : ' It fills in again from the history, as far as the history reaches.'
        lost.push(entry.type === 'cycles'
          ? `"${entryLabel(entry)}" forgets the cycles counted so far: how its stretches are found changed (inputs, combination, smoothing, shortest stretch or stale timeout).${refill}`
          : entry.type === 'record'
            ? `"${entryLabel(entry)}" starts its record again: what it keeps changed (input, what is kept, level or reset rule).${refill}`
            : `"${entryLabel(entry)}" starts again from zero: what its total is measured from changed (input, direction, mode, threshold or reset rule).${refill}`)
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
    // Escape goes back, as it would close a dialog.
    box.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      back.click()
    })
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
      setNotice('error', 'The server could not be reached. Nothing was saved.', true)
      return
    }
    const answer = result.body || {}
    if (result.status === 409) {
      state.notice = changedElsewhere(answer.error || 'The entries were changed elsewhere.')
      render()
      focusNotice()
      return
    }
    if (result.status === 401 || result.status === 403) {
      setNotice('error', 'This login may not change the entries. Nothing was saved.', true)
      return
    }
    if (!result.ok) {
      takeFaults(answer)
      for (const id of Object.keys(state.errors)) state.expanded.add(id)
      const lines = [answer.error || `The server answered ${result.status}. Nothing was saved.`, ...(answer.errors || [])]
      // The way out is said where the problem is reported: an entry can be
      // saved unfinished once it is disabled.
      if (Object.keys(state.errors).length > 0) lines.push('Correct the marked fields, or clear Enabled to save an entry unfinished.')
      setNotice('error', lines.join(' '), true)
      const first = Object.keys(state.errors)[0]
      if (first) {
        const card = find(`.card[data-id="${window.CSS.escape(first)}"]`)
        if (card) card.scrollIntoView({ block: 'center' })
      }
      return
    }
    takeFaults(answer)
    if (state.changes === changes) {
      // Nothing changed while the save was on its way: show the set as the
      // server now holds it, with every card closed but those of entries
      // the server reports a fault in.
      await load()
      takeFaults(answer)
      state.expanded = new Set(Object.keys(state.errors))
    } else {
      // Changes made meanwhile stay, unsaved, on top of what was saved.
      state.saved = sent
      state.savedKey = canonical(sent)
      state.revision = answer.revision
    }
    // Only the counts that are not zero are said: "Saved. 1 entry started."
    const counted = (n, what) => (n === 1 ? `1 entry ${what}` : `${n} entries ${what}`)
    const parts = []
    if (answer.started > 0) parts.push(counted(answer.started, 'started'))
    if (answer.kept > 0) parts.push(`${counted(answer.kept, 'kept running')} without interruption`)
    const more = state.dirty ? ' Changes made since are not saved yet.' : ''
    if (answer.warning) setNotice('warning', `Saved. ${answer.warning}`, true)
    else setNotice('info', `Saved.${parts.length > 0 ? ` ${parts.join(', ')}.` : ''}${more}`, true)
    window.CalcPaths.status.refresh()
  }

  /**
   * Shows a message above the entries. With `focus`, keyboard focus moves
   * to it, for when the control that was used is now disabled.
   */
  function setNotice (kind, text, focus) {
    state.notice = notice(kind, text)
    render()
    const target = view.querySelector('.editor-notices .notice')
    if (target) {
      target.scrollIntoView({ block: 'nearest' })
      if (focus) target.focus()
    }
  }

  /** A message for above the entries, able to take focus. */
  function notice (kind, text) {
    const box = element('p', `notice is-${kind}`, text)
    box.tabIndex = -1
    return box
  }

  /** Moves keyboard focus to the notice shown above the entries. */
  function focusNotice () {
    if (!state.notice || !state.notice.isConnected) return
    state.notice.scrollIntoView({ block: 'nearest' })
    state.notice.focus()
  }

  function discardAll () {
    const trigger = document.getElementById('editor-discard')
    confirmInline(trigger, 'Discard all unsaved changes?', () => {
      state.groups = clone(state.saved.groups)
      state.entries = clone(state.saved.entries)
      state.dirty = false
      state.errors = Object.create(null)
      state.faults = Object.create(null)
      // Back to the saved set, with every card closed, as after a save.
      state.expanded.clear()
      state.notice = null
      window.CalcPaths.app.setUnsaved(false)
      render('#editor-add-group')
    })
  }

  /** Reloads the set from the server, dropping the changes made here. */
  async function reopen () {
    const { body, problem } = await fetchSet()
    if (problem) {
      setNotice('error', `${problem} Nothing was reloaded.`, true)
      return
    }
    take(body)
    await loadPaths()
    setNotice('info', 'Reloaded. The editor now shows the entries as saved on the server.', true)
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
      if (definition.type === 'boolean') {
        if (typeof value === 'boolean') entry[field] = value
      } else if (field === 'inputs') {
        if (Array.isArray(value)) {
          const fields = definition.items.properties
          entry.inputs = value.filter((i) => i && typeof i === 'object').map((i) => {
            const kept = {}
            for (const [name, spec] of Object.entries(fields)) {
              const v = i[name]
              if (spec.type === 'number' ? (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'string' : typeof v === 'string') kept[name] = v
            }
            if (raw.type === 'formula') {
              const formulaInput = { name: kept.name || '', path: kept.path || '' }
              const whenStale = typeof kept.whenStale === 'string' ? kept.whenStale.trim() : kept.whenStale
              if (whenStale !== undefined && whenStale !== '') formulaInput.whenStale = kept.whenStale
              return formulaInput
            }
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

  // An id as the plugin accepts it (validId() in lib/store.js): letters,
  // digits, dashes and underscores, and no name every object carries.
  const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/
  function validId (id) {
    return typeof id === 'string' && ID_PATTERN.test(id) && !(id in {}) && id !== '__proto__'
  }

  // An exported set is a few kilobytes; a much larger file is not one.
  const MAX_IMPORT_BYTES = 1024 * 1024

  /**
   * Reads an exported set. Groups and entries without an id, and entries
   * of no known type, are left out; an id the plugin would refuse, or one
   * used twice, is replaced by a new one, and the entries of a group keep
   * their group. Throws on anything else it cannot read.
   */
  function readSet (data) {
    const known = Object.create(null)
    const used = new Set()
    const groups = []
    for (const g of data.groups) {
      if (!g || typeof g !== 'object' || typeof g.id !== 'string') continue
      const id = validId(g.id) && !used.has(g.id) ? g.id : newId('g')
      used.add(id)
      if (!Object.prototype.hasOwnProperty.call(known, g.id)) known[g.id] = id
      groups.push({ id, name: String(g.name || 'Unnamed group') })
    }
    const entries = []
    const usedEntries = new Set()
    for (const e of data.entries) {
      if (!e || typeof e !== 'object' || typeof e.id !== 'string') continue
      if (!Object.prototype.hasOwnProperty.call(TYPES, e.type) || !Object.prototype.hasOwnProperty.call(state.fields, e.type)) continue
      const id = validId(e.id) && !usedEntries.has(e.id) ? e.id : newId('e')
      usedEntries.add(id)
      const group = typeof e.group === 'string' && Object.prototype.hasOwnProperty.call(known, e.group) ? known[e.group] : null
      entries.push({ ...cleanEntry(e), id, group })
    }
    return { groups, entries }
  }

  function importSet (input) {
    const file = input.files && input.files[0]
    input.value = ''
    if (!file) return
    if (file.size > MAX_IMPORT_BYTES) {
      setNotice('error', `${file.name} is larger than 1 MB, too large for a set of entries. Nothing was imported.`, true)
      return
    }
    file.text().then((text) => {
      let data
      try {
        data = JSON.parse(text)
      } catch (err) {
        setNotice('error', `${file.name} is not a JSON file. Nothing was imported.`, true)
        return
      }
      if (!data || !Array.isArray(data.entries) || !Array.isArray(data.groups)) {
        setNotice('error', `${file.name} holds no entries exported from this page. Nothing was imported.`, true)
        return
      }
      let set
      try {
        set = readSet(data)
      } catch (err) {
        setNotice('error', `${file.name} could not be read as entries exported from this page. Nothing was imported.`, true)
        return
      }
      state.groups = set.groups
      state.entries = set.entries
      state.errors = Object.create(null)
      state.faults = Object.create(null)
      state.expanded.clear()
      markDirty()
      const groups = state.groups.length === 1 ? '1 group' : `${state.groups.length} groups`
      const entries = state.entries.length === 1 ? '1 entry' : `${state.entries.length} entries`
      setNotice('info', `Imported ${entries} in ${groups} from ${file.name}. They replace the entries shown before, and are not saved yet.`, true)
    }, () => setNotice('error', `${file.name} could not be read. Nothing was imported.`, true))
  }

  // ------------------------------------------------------------- the view

  window.addEventListener('beforeunload', (event) => {
    if (state.dirty) {
      event.preventDefault()
      event.returnValue = ''
    }
  })

  // An entry to open once the entries are drawn, as asked by an Edit link
  // on the status page.
  let revealId = null

  /** Opens an entry's card, brings it into view and puts focus on its title. */
  function reveal () {
    const id = revealId
    if (!id || !state.loaded) return
    revealId = null
    if (!entryById(id)) return
    state.expanded.add(id)
    const selector = `[data-focus="${window.CSS.escape(`toggle-${id}`)}"]`
    render(selector)
    const toggle = find(selector)
    if (toggle) toggle.closest('.card').scrollIntoView({ block: 'start' })
  }

  window.CalcPaths.editor = {
    probe,
    /**
     * Asks for an entry's card to be opened when the editor shows. While
     * the editor is hidden nothing can take focus or scroll, so the card is
     * opened by show(), once the view is visible.
     */
    open (id) {
      revealId = id
      if (visible) reveal()
    },
    async show () {
      visible = true
      // The header (the time zone in use) and the footer (version, last
      // update) are filled by the status, which otherwise refreshes only
      // while its tab shows. They are kept current here on the editor's
      // slower beat.
      window.CalcPaths.status.refresh()
      // Started before the first load, which it tries again while that
      // fails, so a server that comes back is noticed.
      if (!pathsTimer) {
        pathsTimer = setInterval(async () => {
          if (!visible) return
          window.CalcPaths.status.refresh()
          if (!state.loaded) {
            if (await load()) {
              await loadPaths()
              render()
              reveal()
            }
            return
          }
          await checkRevision()
          loadPaths()
        }, PATHS_POLL_MS)
      }
      if (!state.loaded) {
        showMessage('Loading the entries.')
        if (!(await load())) return
        await loadPaths()
        render()
        reveal()
        return
      }
      // An entry asked for by an Edit link on the status page.
      reveal()
      // The set may have been changed elsewhere while another view showed.
      const toolbar = view.querySelector('.editor-toolbar')
      if (toolbar) watchToolbar(toolbar)
      await checkRevision()
    },
    hide () {
      visible = false
      document.documentElement.style.scrollPaddingTop = ''
    }
  }
})()
