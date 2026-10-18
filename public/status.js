'use strict'

/*
 * Calculated Paths page: the status view.
 *
 * Polls the plugin's status route and shows one line per entry: the name,
 * the output path, the current value, what the entry is doing, and a reset
 * button for totals. Entries are shown in the groups set in the editor, in
 * the editor's order; entries outside any group come first, without a
 * heading, so a set with no groups reads as one plain list. A group can be
 * collapsed, and each browser remembers which ones are.
 */

;(function () {
  const { SETTINGS_URL, api, element, everyday, figure, remembered, writeWithPaths } = window.CalcPaths
  const API = `${window.CalcPaths.BASE}/entries`
  const POLL_MS = 2000
  // How long a "Confirm reset" button waits before it turns back.
  const CONFIRM_MS = 6000
  // How long the outcome of a reset stays beside the button.
  const RESULT_MS = 8000

  const sheet = document.getElementById('sheet')
  const notices = document.getElementById('notices')
  const placeholder = document.getElementById('placeholder')
  const context = document.getElementById('context')
  const refreshed = document.getElementById('refreshed')
  const version = document.getElementById('version')
  const allToggle = document.getElementById('status-expand-all')

  // The groups collapsed in this browser, by id. Held here, and remembered
  // in the browser when it allows, under the key 'folded', the name used
  // before 0.4.2, so that what a browser remembers carries on. A browser
  // that keeps nothing still collapses groups until the page is left.
  const collapsed = new Set(remembered.get('folded', []))
  const collapsedGroups = () => new Set(collapsed)
  const rememberCollapsed = (set) => {
    collapsed.clear()
    for (const id of set) collapsed.add(id)
    remembered.set('folded', [...collapsed])
  }

  // One record per entry on screen, keyed by the entry's unique key, so that
  // a refresh updates the existing line instead of rebuilding it. Rebuilding
  // would throw away a half-finished reset confirmation and keyboard focus.
  const rows = new Map()
  // One record per group on screen, keyed by group id; '' is the unnamed
  // block of entries outside any group.
  const blocks = new Map()
  let timeZone
  let timer = null
  let active = false

  const STATE_LABELS = {
    ok: 'Publishing',
    waiting: 'Waiting',
    stale: 'Stale',
    error: 'Configuration error',
    disabled: 'Switched off'
  }

  const RESET_PHRASES = {
    day: 'resets every day',
    week: 'resets every week',
    month: 'resets every month',
    year: 'resets every year',
    manual: 'reset only by hand'
  }

  /**
   * Formats an instant as a clock in the plugin's time zone shows it.
   *
   * The zone may be a fixed offset, written "+03:00". Browsers differ in
   * whether they accept that as a zone name, so a fixed offset is applied
   * here by shifting the instant and formatting the result as UTC.
   */
  function when (iso) {
    if (!iso) return ''
    const options = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
    const instant = new Date(iso)
    const fixed = /^([+-])(\d{2}):(\d{2})$/.exec(timeZone || '')
    try {
      if (fixed) {
        const minutes = (Number(fixed[2]) * 60 + Number(fixed[3])) * (fixed[1] === '-' ? -1 : 1)
        return new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'UTC' }).format(new Date(instant.getTime() + minutes * 60000))
      }
      return new Intl.DateTimeFormat(undefined, { ...options, timeZone }).format(instant)
    } catch (err) {
      return new Intl.DateTimeFormat(undefined, options).format(instant)
    }
  }

  /**
   * Says, in one sentence, which time zone the day boundaries use and why.
   */
  function describeZone (data) {
    const source = data.timeZoneSource
    const zone = data.timeZoneLabel || data.timeZone
    const start = `Days begin at ${data.dayStart}, ${zone} time`
    if (!source) return `${start}.`
    const waitingFor = source.paths && source.paths.length > 0 ? source.paths.join(' or ') : 'the followed paths'
    const from = source.path || 'Signal K'
    switch (source.kind) {
      case 'path':
        return `${start}, the ship's time read from ${from}.${describeZoneChange(source.lastChange)}`
      case 'remembered':
        return `${start}, the ship's time last read from ${from}. Nothing has been published there since the plugin started.${describeZoneChange(source.lastChange)}`
      case 'setting':
        return source.follow
          ? `${start}, the zone chosen in the settings. No ship's time has been published on ${waitingFor}.`
          : `${start}, the zone chosen in the settings.`
      default:
        return source.follow
          ? `${start}, the server's own time zone. No ship's time has been published on ${waitingFor}.`
          : `${start}, the server's own time zone.`
    }
  }

  /** Writes a zone for people: a fixed offset as "UTC+03:00". */
  function zoneLabel (zone) {
    return /^[+-]\d{2}:\d{2}$/.test(zone) ? `UTC${zone}` : zone
  }

  /**
   * Says when the followed zone last changed. A zone that changes without
   * the boat having moved is worth seeing: it moves every day boundary.
   */
  function describeZoneChange (change) {
    if (!change || !change.at) return ''
    if (change.from === change.to) {
      return ` Since ${when(change.at)} it is read from ${change.toPath || 'another path'}${change.fromPath ? `, before that from ${change.fromPath}` : ''}.`
    }
    return ` It changed from ${zoneLabel(change.from)} to ${zoneLabel(change.to)} on ${when(change.at)}.`
  }

  /**
   * Says why a total was last cleared. Without this a total that starts
   * again at an unexpected time gives no hint of the reason.
   */
  function describeReset (record) {
    if (!record || !record.at) return ''
    const at = when(record.at)
    switch (record.cause) {
      case 'period':
        return ` Last reset ${at}: a new ${record.period || 'period'} began.`
      case 'zone':
        return ` Last reset ${at}: the time zone changed${record.zone ? ` to ${zoneLabel(record.zone)}` : ''} and a new period had already begun there.`
      case 'path': {
        const fall = Number.isFinite(record.from) && Number.isFinite(record.to) ? ` fell from ${figure(record.from)} to ${figure(record.to)}` : ' fell'
        const source = record.source ? `, a value from ${record.source}` : ''
        return ` Last reset ${at}: ${record.path || 'the followed path'}${fall}${source}.`
      }
      case 'request':
        return ` Last reset ${at}: by request, from this page or the reset route.`
      default:
        return ''
    }
  }

  /** A length of time as a reader says it: 45 s, 10 min 30 s, 2 h 05 min. */
  function duration (seconds) {
    if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '–'
    const whole = Math.round(seconds)
    if (whole < 60) return `${whole} s`
    if (whole < 3600) {
      const rest = whole % 60
      return rest === 0 ? `${Math.floor(whole / 60)} min` : `${Math.floor(whole / 60)} min ${rest} s`
    }
    const minutes = Math.round(whole / 60)
    return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`
  }

  /** How a Cycles entry reads its inputs, what it found, and where it is now. */
  function describeCycles (entry) {
    const inputs = (entry.cycleInputs || []).map((input) => input.kind === 'wave'
      ? `${input.path} read as a wave, ON while ${input.direction || 'falling'}`
      : `${input.path} ON above ${figure(input.threshold || 0)}`)
    const how = inputs.length > 1
      ? `Cycles while ${entry.combine === 'any' ? 'any input is ON (or)' : 'all inputs are ON (and)'}: ${inputs.join('; ')}.`
      : `Cycles of ${inputs[0] || 'no input'}.`
    const c = entry.cycles || {}
    const window = `${figure(entry.window)} h`
    let found
    if (!c.count) {
      found = ` No complete cycle in the last ${window} yet.`
    } else {
      const duty = Number.isFinite(c.duty) ? `, ON ${figure(c.duty * 100)} % of the time` : ''
      found = ` ${c.count} ${c.count === 1 ? 'cycle' : 'cycles'} in the last ${window}. Medians: ON ${duration(c.onMedian)}, OFF ${duration(c.offMedian)}, ON and OFF together ${duration(c.periodMedian)}${duty}. The latest ON stretch counted lasted ${duration(c.lastOn)}.`
    }
    // Turning points of a wave are found a little after they happen, so
    // this is the latest stretch found, not necessarily the present state.
    let now = ''
    if (c.state === 'on' || c.state === 'off') {
      now = Number.isFinite(c.stateFor)
        ? ` The latest stretch found is ${c.state.toUpperCase()}, begun ${duration(c.stateFor)} ago.`
        : ` The latest stretch found is ${c.state.toUpperCase()}; its start was not seen.`
    }
    return `${how}${found}${now}${describeReset(entry.lastReset)}`
  }

  /**
   * The inputs a formula counts as their value when stale at the moment,
   * each with the value and the reason, so that a silent device shows.
   */
  function describeSubstituted (entry) {
    const substituted = entry.substituted || []
    if (substituted.length === 0) return ''
    const reasons = {
      stale: `no value for more than ${duration(entry.staleTimeout)}`,
      none: `no value since ${entry.edited ? 'the entry was last changed' : 'the plugin started'}`,
      invalid: 'no number at the moment'
    }
    const items = substituted.map((input) => `${input.path} as ${input.value} (${reasons[input.reason] || input.reason})`)
    return `. Counted as their value when stale: ${items.join(', ')}.`
  }

  /** One sentence saying what kind of entry this is and how it behaves. */
  function describe (entry) {
    if (entry.type === 'formula') return `Formula: ${entry.expression}${describeSubstituted(entry)}`
    if (entry.type === 'cycles') return describeCycles(entry)
    const kind = entry.type === 'counter' ? 'Period counter' : 'Integration'
    const reset = entry.resets === 'path' ? `resets when ${entry.resetPath} resets` : RESET_PHRASES[entry.resets]
    const since = entry.since ? ` Counting since ${when(entry.since)}.` : ''
    const corrected = entry.sinceCorrected && entry.sinceCorrected.at
      ? ` The start time was set on ${when(entry.sinceCorrected.at)} without clearing the total, because the earlier one${entry.sinceCorrected.previous ? ` (${when(entry.sinceCorrected.previous)})` : ''} could not be used.`
      : ''
    return `${kind} on ${entry.inputs.join(', ')}, ${reset}.${since}${describeReset(entry.lastReset)}${corrected}`
  }

  function createRow (entry) {
    const item = element('li', 'entry')
    const what = element('div', 'entry-what')
    const name = element('h3', 'entry-name')
    const path = element('p', 'entry-path')
    what.append(name, path)

    const reading = element('div', 'entry-reading')
    const detail = element('p', 'entry-detail')
    const state = element('span', 'entry-state')
    const message = element('span')
    detail.append(state, message)

    const action = element('div', 'entry-action')
    item.append(what, reading, detail, action)

    const row = { item, name, path, reading, state, message, action, confirmTimer: null, resultTimer: null, stage: 'idle', result: null, drawn: null }
    rows.set(entry.key, row)
    return row
  }

  function renderReading (row, entry) {
    row.reading.replaceChildren()
    if (entry.value === null || entry.value === undefined) {
      row.reading.append(element('span', 'reading-none', '–'))
      return
    }
    const converted = everyday(entry.value, entry.unit, entry.type)
    const line = element('div')
    line.append(element('span', 'reading-figure', converted ? converted.figure : figure(entry.value)))
    const unit = converted ? converted.unit : entry.unit
    if (unit) line.append(element('span', 'reading-unit', unit))
    row.reading.append(line)
    // When the reading was converted, the value as published is shown
    // underneath, so the page always agrees with the Data Browser.
    if (converted) row.reading.append(element('p', 'reading-raw', `${figure(entry.value)} ${entry.unit}`))
  }

  function renderAction (row, entry) {
    // The buttons are rebuilt only when what they show has changed. A
    // rebuild on every refresh would drop keyboard focus every two seconds.
    const label = entry.name || entry.output
    const drawn = [row.stage, entry.canReset, entry.id, label, row.result ? row.result.text : ''].join('|')
    if (drawn === row.drawn) return
    row.drawn = drawn

    row.action.replaceChildren()
    if (!entry.canReset) return

    if (row.stage === 'confirm') {
      const confirm = element('button', 'is-confirm', entry.type === 'cycles' ? 'Confirm: forget' : 'Confirm reset')
      confirm.type = 'button'
      confirm.addEventListener('click', () => reset(row, entry))
      const cancel = element('button', 'is-quiet', 'Cancel')
      cancel.type = 'button'
      cancel.addEventListener('click', () => setStage(row, entry, 'idle'))
      // Escape cancels, as it would close a dialog.
      for (const control of [confirm, cancel]) {
        control.addEventListener('keydown', (event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          setStage(row, entry, 'idle')
        })
      }
      row.action.append(confirm, cancel)
      return
    }

    if (row.result) row.action.append(element('span', `action-result${row.result.failed ? ' is-error' : ''}`, row.result.text))
    const cycles = entry.type === 'cycles'
    const button = element('button', '', cycles ? 'Forget cycles' : 'Reset to zero')
    button.type = 'button'
    button.disabled = row.stage === 'busy'
    button.setAttribute('aria-label', cycles ? `Forget the cycles counted for ${label}` : `Reset ${label} to zero`)
    button.addEventListener('click', () => setStage(row, entry, 'confirm'))
    row.action.append(button)
  }

  function setStage (row, entry, stage) {
    clearTimeout(row.confirmTimer)
    // Focus follows the buttons only when it was on one of them. When the
    // confirmation times out by itself the reader may be elsewhere on the
    // page, and must not be pulled back.
    const hadFocus = row.action.contains(document.activeElement)
    row.stage = stage
    if (stage === 'confirm') {
      clearTimeout(row.resultTimer)
      row.result = null
      row.confirmTimer = setTimeout(() => setStage(row, entry, 'idle'), CONFIRM_MS)
    }
    renderAction(row, entry)
    const next = row.action.querySelector('button')
    if (next && hadFocus && stage !== 'busy') next.focus()
  }

  /** Shows the outcome of a reset beside the button for a few seconds. */
  function showResult (row, entry, text, failed) {
    clearTimeout(row.resultTimer)
    row.result = { text, failed }
    row.resultTimer = setTimeout(() => {
      row.result = null
      if (row.stage === 'idle') renderAction(row, entry)
    }, RESULT_MS)
  }

  async function reset (row, entry) {
    setStage(row, entry, 'busy')
    try {
      const response = await fetch(`${API}/${encodeURIComponent(entry.id)}/reset`, { method: 'POST', credentials: 'same-origin' })
      if (response.ok) {
        showResult(row, entry, entry.type === 'cycles' ? 'Cycles forgotten' : 'Reset to zero', false)
      } else if (response.status === 401 || response.status === 403) {
        showResult(row, entry, 'Not reset: this login may not change data', true)
      } else {
        showResult(row, entry, `Not reset: the server answered ${response.status}`, true)
      }
    } catch (err) {
      showResult(row, entry, 'Not reset: the server could not be reached', true)
    }
    setStage(row, entry, 'idle')
    refresh()
  }

  /** The paths an entry's sentence may name, to be set in a code font. */
  function pathsOf (entry) {
    return [entry.output, entry.resetPath, ...(entry.inputs || []), ...(entry.cycleInputs || []).map((input) => input.path), ...(entry.substituted || []).map((input) => input.path)]
  }

  function renderEntry (entry) {
    const row = rows.get(entry.key) || createRow(entry)
    row.item.className = `entry is-${entry.state}`
    row.name.textContent = entry.name || entry.output || 'Unnamed entry'
    // Outside a group an entry sits straight under the page heading.
    row.name.setAttribute('aria-level', entry.group ? '3' : '2')
    row.path.textContent = entry.output
    renderReading(row, entry)
    row.state.textContent = STATE_LABELS[entry.state] || entry.state
    const parts = [describe(entry)]
    if (entry.message) parts.unshift(entry.message)
    writeWithPaths(row.message, `. ${parts.join(' ')}`, pathsOf(entry))
    // The action area is left alone while a reset is being confirmed or
    // sent, so a refresh cannot pull the button out from under a click.
    if (row.stage === 'idle') renderAction(row, entry)
    return row
  }

  /** The block that holds a group's entries, made on first use. */
  function blockFor (group) {
    const id = group ? group.id : ''
    let block = blocks.get(id)
    if (!block) {
      const section = element('section', group ? 'group' : 'group is-ungrouped')
      const list = element('ol', 'entries')
      block = { section, list, heading: null, toggle: null, label: null, count: null }
      if (group) {
        const heading = element('h2', 'group-heading')
        const toggle = element('button', 'group-toggle')
        toggle.type = 'button'
        const label = element('span', 'group-name')
        const count = element('span', 'group-count')
        toggle.append(label, count)
        toggle.addEventListener('click', () => {
          const collapsed = collapsedGroups()
          if (collapsed.has(id)) collapsed.delete(id)
          else collapsed.add(id)
          rememberCollapsed(collapsed)
          collapseBlock(block, collapsed.has(id))
          updateAllToggle()
        })
        heading.append(toggle)
        section.append(heading)
        Object.assign(block, { heading, toggle, label, count })
        list.id = `group-${id}`
        toggle.setAttribute('aria-controls', list.id)
      } else {
        list.setAttribute('aria-label', 'Calculated paths')
      }
      section.append(list)
      blocks.set(id, block)
    }
    return block
  }

  function collapseBlock (block, collapsed) {
    if (!block.toggle) return
    block.toggle.setAttribute('aria-expanded', String(!collapsed))
    block.list.hidden = collapsed
    block.section.classList.toggle('is-collapsed', collapsed)
  }

  /**
   * The Expand all / Collapse all button above the groups, shown while two
   * or more groups are on the page; with one, its own heading does the same.
   * As in the editor it is named after what it will do: it expands every
   * group while any is collapsed, and collapses them all once all are
   * expanded.
   */
  function updateAllToggle () {
    const named = [...blocks.entries()].filter(([id, block]) => id !== '' && block.toggle && block.section.isConnected)
    allToggle.hidden = named.length < 2
    const anyCollapsed = named.some(([id]) => collapsed.has(id))
    allToggle.textContent = anyCollapsed ? 'Expand all' : 'Collapse all'
    allToggle.setAttribute('aria-label', anyCollapsed ? 'Expand all groups' : 'Collapse all groups')
    allToggle.setAttribute('aria-controls', named.map(([, block]) => block.list.id).join(' '))
    allToggle.dataset.expand = String(anyCollapsed)
  }

  allToggle.addEventListener('click', () => {
    const expand = allToggle.dataset.expand === 'true'
    const next = collapsedGroups()
    for (const [id, block] of blocks) {
      if (id === '' || !block.toggle) continue
      if (expand) next.delete(id)
      else next.add(id)
      collapseBlock(block, !expand)
    }
    rememberCollapsed(next)
    updateAllToggle()
  })

  function notice (kind, text, link) {
    const box = element('p', `notice is-${kind}`, text)
    if (link) {
      box.append(' ')
      const anchor = element('a', '', link.text)
      anchor.href = link.href
      box.append(anchor)
    }
    return box
  }

  function showPlaceholder (text, link) {
    placeholder.hidden = false
    placeholder.textContent = text
    if (link) {
      placeholder.append(' ')
      const anchor = element('a', '', link.text)
      anchor.href = link.href
      placeholder.append(anchor)
    }
  }

  function clearEntries () {
    for (const row of rows.values()) {
      clearTimeout(row.confirmTimer)
      clearTimeout(row.resultTimer)
    }
    rows.clear()
    blocks.clear()
    sheet.replaceChildren()
    updateAllToggle()
  }

  /** Puts a node at a place in a parent, moving it only when it is not there already. */
  function place (parent, node, index) {
    if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] || null)
  }

  function render (data) {
    timeZone = data.timeZone
    const source = data.timeZoneSource || {}
    const zonePaths = [...(source.paths || []), source.path, source.lastChange && source.lastChange.fromPath, source.lastChange && source.lastChange.toPath]
    writeWithPaths(context, describeZone(data), zonePaths)
    version.textContent = `signalk-calc-paths ${data.version}`

    const messages = []
    for (const note of data.notes || []) messages.push(notice('info', note))
    if (!data.clockTrusted) {
      messages.push(notice('warning', 'The system clock looks unset. Totals keep counting, and period resets are paused until the clock is correct.'))
    }
    if (source.problem) messages.push(writeWithPaths(notice('warning', ''), source.problem, zonePaths))
    const ignored = data.outdatedValues
    if (ignored && ignored.count > 0 && ignored.last) {
      const times = ignored.count === 1 ? 'One input value was' : `${ignored.count} input values were`
      messages.push(writeWithPaths(notice('warning', ''), `${times} ignored since the plugin started, being older than a value already read for the same path from another source. The last was on ${ignored.last.path} from ${ignored.last.source || 'an unnamed source'}, stamped ${when(ignored.last.timestamp)} and received ${when(ignored.last.at)}.`, [ignored.last.path]))
    }
    for (const problem of data.problems) messages.push(notice('error', problem))
    notices.replaceChildren(...messages)

    // Entries and groups that are no longer configured leave the page.
    const current = new Set(data.entries.map((entry) => entry.key))
    for (const [key, row] of rows) {
      if (!current.has(key)) {
        clearTimeout(row.confirmTimer)
        clearTimeout(row.resultTimer)
        row.item.remove()
        rows.delete(key)
      }
    }
    const groups = Array.isArray(data.groups) ? data.groups : []
    const known = new Set(groups.map((group) => group.id))
    const byGroup = new Map([['', []], ...groups.map((group) => [group.id, []])])
    for (const entry of data.entries) byGroup.get(entry.group && known.has(entry.group) ? entry.group : '').push(entry)

    // Blocks in the editor's order: the entries outside any group, then
    // each group that holds an entry. A line already in its place is left
    // alone: moving it would take keyboard focus away from a button in it.
    const shown = [['', null], ...groups.map((group) => [group.id, group])].filter(([id]) => byGroup.get(id).length > 0)
    for (const [id, block] of blocks) {
      if (!shown.some(([shownId]) => shownId === id)) {
        block.section.remove()
        blocks.delete(id)
      }
    }
    shown.forEach(([id, group], index) => {
      const block = blockFor(group)
      const entries = byGroup.get(id)
      if (group) {
        block.label.textContent = group.name
        block.count.textContent = entries.length === 1 ? '1 entry' : `${entries.length} entries`
        collapseBlock(block, collapsed.has(id))
      }
      place(sheet, block.section, index)
      entries.forEach((entry, position) => place(block.list, renderEntry(entry).item, position))
    })
    updateAllToggle()

    if (data.entries.length === 0) {
      showPlaceholder('No entries yet. Add a formula, a period counter, an integration or a cycles entry in the editor.', { text: 'Open the editor', href: '#edit' })
    } else {
      placeholder.hidden = true
    }
    const started = data.startedAt ? `. Plugin running since ${when(data.startedAt)}` : ''
    refreshed.textContent = `Updated ${new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' }).format(new Date())}${started}`
  }

  async function refresh () {
    let result
    try {
      result = await api('/entries')
    } catch (err) {
      refreshed.textContent = 'The server could not be reached. Trying again.'
      return
    }

    if (result.ok) {
      render(result.body)
      return
    }

    clearEntries()
    notices.replaceChildren()
    if (result.status === 401 || result.status === 403) {
      showPlaceholder('Log in to Signal K to see the calculated paths.', { text: 'Log in', href: '/admin/#/login' })
    } else if (result.status === 503 && result.body && result.body.blocked) {
      showPlaceholder(`${result.body.error}. No entries are running. The file has been left as it is.`, { text: 'Open the editor to save a new set', href: '#edit' })
    } else if (result.status === 503) {
      showPlaceholder('The plugin is not running. Enable it in the plugin configuration.', { text: 'Open the configuration', href: SETTINGS_URL })
    } else {
      showPlaceholder(`The server answered ${result.status}. Trying again.`)
    }
  }

  window.CalcPaths.status = {
    show () {
      active = true
      refresh()
      if (!timer) timer = setInterval(() => { if (active) refresh() }, POLL_MS)
    },
    hide () {
      active = false
    },
    refresh
  }
})()
