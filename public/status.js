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
  const { SETTINGS_URL, api, element, everyday, figure, remembered, shownUnit, writeWithPaths } = window.CalcPaths
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
  const offline = document.getElementById('offline')
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
  let blockCount = 0
  let timeZone
  let timer = null
  let active = false
  // Each run of polls has its own number, so that a run left over from
  // before the view was hidden and shown again stops.
  let run = 0
  // The request in flight, if any, and whether another was asked for
  // meanwhile: never more than one is on its way.
  let pending = null
  let again = false
  // Answers are numbered, so that one older than the answer drawn is not.
  let asked = 0
  let shownAnswer = 0
  // The text of the notices on screen, so that they are rebuilt, and read
  // out, only when it changes.
  let noticesKey = ''
  // When the last answer with the readings arrived, and the text of the
  // notice shown while no newer answer comes, so that it is rebuilt, and
  // read out, only when it changes.
  let answeredAt = null
  let offlineText = ''

  const STATE_LABELS = {
    ok: 'Publishing',
    waiting: 'Waiting',
    stale: 'Stale',
    error: 'Configuration error',
    disabled: 'Disabled'
  }

  // When a total resets, or a record starts again, for the value of a fact.
  const RESET_PHRASES = {
    day: 'every day',
    week: 'every week',
    month: 'every month',
    year: 'every year',
    manual: 'only by hand'
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
    const instant = new Date(iso)
    // A moment of another year, as a record or the history may hold, says
    // which year.
    const options = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
    if (Math.abs(Date.now() - instant.getTime()) > 300 * 24 * 3600 * 1000) options.year = 'numeric'
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
   * A time of day as the rest of the page gives it, on the 24-hour clock in
   * the plugin's time zone, with seconds when asked: 09:41:41.
   */
  function clock (date, seconds) {
    const options = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
    if (seconds) options.second = '2-digit'
    const fixed = /^([+-])(\d{2}):(\d{2})$/.exec(timeZone || '')
    try {
      if (fixed) {
        const minutes = (Number(fixed[2]) * 60 + Number(fixed[3])) * (fixed[1] === '-' ? -1 : 1)
        return new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'UTC' }).format(new Date(date.getTime() + minutes * 60000))
      }
      return new Intl.DateTimeFormat(undefined, { ...options, timeZone }).format(date)
    } catch (err) {
      return new Intl.DateTimeFormat(undefined, options).format(date)
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
   * One line of the list under an entry: a label and its value. The value
   * may name paths, which are set apart in a code font.
   */
  const fact = (label, value) => ({ label, value })

  /**
   * Why and when a total was last cleared, the cycles last forgotten or a
   * record last started again. Without this a figure that starts again at
   * an unexpected time gives no hint of the reason. Null when it never was.
   */
  function resetFact (record, entry) {
    if (!record || !record.at) return null
    const isRecord = entry.type === 'record'
    // The total a period ended with, when the plugin kept it, in the
    // reading the page shows for the entry's value.
    const closed = !isRecord && Number.isFinite(record.total) ? `; the ${record.period || 'period'} closed at ${withUnit(record.total, entry)}` : ''
    let why
    switch (record.cause) {
      case 'period':
        why = `a new ${record.period || 'period'} began${closed}`
        break
      case 'zone':
        why = `the time zone changed${record.zone ? ` to ${zoneLabel(record.zone)}` : ''} and a new period had already begun there${closed}`
        break
      case 'path': {
        const fall = Number.isFinite(record.from) && Number.isFinite(record.to) ? ` fell from ${figure(record.from)} to ${figure(record.to)}` : ' fell'
        const source = record.source ? `, a value from ${record.source}` : ''
        why = `${record.path || 'the followed path'}${fall}${source}`
        break
      }
      case 'level':
        why = `${entry.inputs[0]} came to ${inInputUnit(record.level, entry)}`
        break
      case 'request':
        why = 'by request, from this page or the reset route'
        break
      default:
        return null
    }
    const label = 'Last reset'
    return fact(label, `${when(record.at)}: ${why}`)
  }

  /** A level of a record in its input's unit, shown as the editor shows it: 100 % for a ratio of 1. */
  function inInputUnit (value, entry) {
    if (!Number.isFinite(value)) return '–'
    const shown = shownUnit(entry.inputUnit || null, false)
    return `${figure(shown.show(value))}${shown.unit ? ` ${shown.unit}` : ''}`
  }

  /** A value with its unit, converted as the reading of the entry is: 2.4 kWh. */
  function withUnit (value, entry) {
    const unit = (entry && entry.unit) || ''
    const converted = everyday(value, unit, entry && entry.type)
    if (converted) return `${converted.figure}${converted.unit ? ` ${converted.unit}` : ''}`
    return `${figure(value)}${unit ? ` ${unit}` : ''}`
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

  /** How a cycles entry reads its inputs, what it found, and where it is now. */
  function cyclesFacts (entry) {
    const inputs = (entry.cycleInputs || []).map((input) => input.kind === 'wave'
      ? `${input.path}, a wave, ON while ${input.direction || 'falling'}`
      : `${input.path}, ON above ${figure(input.threshold || 0)}`)
    const facts = [fact('Cycles of', inputs.join('; ') || 'no input')]
    if (inputs.length > 1) facts.push(fact('Combined', entry.combine === 'any' ? 'ON while any input is ON (or)' : 'ON while all inputs are ON (and)'))
    const c = entry.cycles || {}
    const window = `Last ${figure(entry.window)} h`
    if (!c.count) {
      facts.push(fact(window, 'no complete cycle yet'))
    } else {
      const duty = Number.isFinite(c.duty) ? `, ON ${figure(c.duty * 100)} % of the time` : ''
      facts.push(fact(window, `${c.count} ${c.count === 1 ? 'cycle' : 'cycles'}${duty}`))
      facts.push(fact('Medians', `ON ${duration(c.onMedian)}, OFF ${duration(c.offMedian)}, ON and OFF together ${duration(c.periodMedian)}`))
      facts.push(fact('Latest ON counted', duration(c.lastOn)))
    }
    // Turning points of a wave are found a little after they happen, so
    // this is the latest stretch found, not necessarily the present state.
    if (c.state === 'on' || c.state === 'off') {
      facts.push(fact('Latest stretch found', Number.isFinite(c.stateFor)
        ? `${c.state.toUpperCase()}, begun ${duration(c.stateFor)} ago`
        : `${c.state.toUpperCase()}, its start not seen`))
    }
    // The ON time so far is the one figure not taken from the cycles
    // already complete, so the list says that it is what is published.
    if (entry.statistic === 'onSoFar') {
      const soFar = Number.isFinite(c.onSoFar) ? c.onSoFar : entry.value
      facts.push(fact('Publishes', Number.isFinite(soFar) ? `the ON time so far, ${duration(soFar)}` : 'the ON time so far'))
    }
    return facts
  }

  /**
   * The inputs a formula counts as their value when stale at the moment,
   * each with the value and the reason, so that a silent device shows.
   */
  function substitutedFact (entry) {
    const substituted = entry.substituted || []
    if (substituted.length === 0) return null
    const reasons = {
      stale: `no value for more than ${duration(entry.staleTimeout)}`,
      none: `no value since ${entry.edited ? 'the entry was last changed' : 'the plugin started'}`,
      invalid: 'no number at the moment'
    }
    const items = substituted.map((input) => `${input.path} as ${input.value} (${reasons[input.reason] || input.reason})`)
    return fact('Counted as their value when stale', items.join('; '))
  }

  /** What a record keeps, what it holds now, and since when. */
  function recordFacts (entry) {
    const input = entry.inputs[0]
    const time = entry.timeOutput ? fact('Moment published on', entry.timeOutput) : null
    if (entry.keep === 'sinceAbove' || entry.keep === 'sinceBelow') {
      let last = 'not yet'
      if (entry.atLevel) last = 'now'
      else if (entry.lastMet) last = when(entry.lastMet)
      return [
        fact('Time since', input),
        fact('Level', `${entry.keep === 'sinceAbove' ? 'at or above' : 'at or below'} ${inInputUnit(entry.level, entry)}`),
        fact('Last at the level', last),
        time
      ]
    }
    let restart
    if (entry.resets === 'level') restart = `whenever it is ${entry.keep === 'highest' ? 'at or below' : 'at or above'} ${inInputUnit(entry.resetLevel, entry)}`
    else if (entry.resets === 'path') restart = `when ${entry.resetPath} resets`
    else restart = RESET_PHRASES[entry.resets] || RESET_PHRASES.manual
    return [
      fact(entry.keep === 'highest' ? 'Highest of' : 'Lowest of', input),
      fact('Resets', restart),
      fact('Reached', entry.record ? when(entry.record.at) : 'no value seen yet'),
      entry.windowStart ? fact('Covers', `since ${when(entry.windowStart)}`) : null,
      time,
      resetFact(entry.lastReset, entry)
    ]
  }

  /**
   * What the look-back of an entry found, or why it found nothing, so that
   * a figure that includes the time before the entry started says so.
   */
  function historyFact (entry) {
    const label = 'From history'
    const h = entry.history
    if (!h) {
      if (entry.lookback === 'running') return fact(label, 'being read')
      if (entry.lookback === 'wanted') return fact(label, 'to be read')
      return null
    }
    switch (h.outcome) {
      case 'waiting':
        return fact(label, `not read yet: ${h.reason}; trying again`)
      case 'failed':
      case 'skipped':
        return fact(label, `not filled in: ${h.reason}`)
      case 'empty':
        if (h.reason) return fact(label, `not filled in: ${h.reason}`)
        // A time since that found the input but never at the level read
        // something, so "holds nothing" would mislead.
        if (entry.type === 'record' && (entry.keep === 'sinceAbove' || entry.keep === 'sinceBelow')) return fact(label, `not at the level in the history read, up to ${when(h.to)}`)
        return fact(label, `the history holds no values on ${entry.inputs.length === 1 ? entry.inputs[0] : 'the inputs'} up to ${when(h.to)}`)
      case 'filled': {
        const span = h.from ? `${when(h.from)} to ${when(h.to)}` : `up to ${when(h.to)}`
        const steps = Number.isFinite(h.resolution) && h.resolution > 1 ? `, in steps of ${duration(h.resolution)}` : ''
        if (entry.type === 'cycles') return fact(label, `${h.stretches} ON and OFF ${h.stretches === 1 ? 'stretch' : 'stretches'}, ${span}${steps}`)
        if (entry.type === 'record') {
          if (entry.keep === 'sinceAbove' || entry.keep === 'sinceBelow') return fact(label, `last at the level ${when(h.found)}`)
          return fact(label, `${span}; the ${entry.keep === 'highest' ? 'highest' : 'lowest'} there was reached ${when(h.found)}`)
        }
        return fact(label, `${withUnit(h.amount, entry)}, ${span}${steps}`)
      }
      default:
        return null
    }
  }

  /**
   * The list under an entry: what kind of entry it is and how it behaves,
   * one fact a line, so that each can be found at a glance.
   */
  function factsOf (entry) {
    let facts
    if (entry.type === 'formula') {
      // What each short name in the expression stands for.
      const names = entry.inputNames || []
      const inputs = names.length === entry.inputs.length && names.length > 0 ? fact('Inputs', names.map((name, i) => `${name} = ${entry.inputs[i]}`).join(', ')) : null
      facts = [fact('Formula', entry.expression), inputs, substitutedFact(entry)]
    } else if (entry.type === 'cycles') {
      facts = [...cyclesFacts(entry), resetFact(entry.lastReset, entry)]
    } else if (entry.type === 'record') {
      facts = recordFacts(entry)
    } else {
      const corrected = entry.sinceCorrected && entry.sinceCorrected.at
        ? fact('Start time', `set on ${when(entry.sinceCorrected.at)} without clearing the total, because the earlier one${entry.sinceCorrected.previous ? ` (${when(entry.sinceCorrected.previous)})` : ''} could not be used`)
        : null
      facts = [
        fact(entry.type === 'counter' ? 'Period counter on' : 'Integration of', entry.inputs.join(', ')),
        fact('Resets', entry.resets === 'path' ? `when ${entry.resetPath} resets` : RESET_PHRASES[entry.resets]),
        entry.since ? fact('Counting since', when(entry.since)) : null,
        resetFact(entry.lastReset, entry),
        corrected
      ]
    }
    return [...facts, historyFact(entry)].filter(Boolean)
  }

  function createRow (entry) {
    const item = element('li', 'entry')
    const what = element('div', 'entry-what')
    const name = element('h3', 'entry-name')
    const path = element('p', 'entry-path')
    // Opens the entry in the editor; shown only to a login that may edit.
    const edit = element('a', 'entry-edit', 'Edit')
    edit.href = `#edit=${encodeURIComponent(entry.key)}`
    what.append(name, path)

    const reading = element('div', 'entry-reading')
    // The state and, when there is one, the message that goes with it; then
    // the facts of the entry, one a line.
    const detail = element('div', 'entry-detail')
    const status = element('p', 'entry-status')
    const state = element('span', 'entry-state')
    const message = element('span')
    status.append(state, message)
    const facts = element('dl', 'entry-facts')
    detail.append(status, facts)

    const action = element('div', 'entry-action')
    // The outcome of a reset, read out when it appears. It stays in place
    // while the buttons beside it are rebuilt.
    const outcome = element('span', 'action-result')
    outcome.setAttribute('role', 'status')
    action.append(outcome, edit)
    item.append(what, reading, detail, action)

    const row = { item, name, path, edit, reading, state, message, facts, factsDrawn: null, action, outcome, confirmTimer: null, resultTimer: null, stage: 'idle', result: null, drawn: null }
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

    for (const child of [...row.action.children]) {
      if (child !== row.outcome && child !== row.edit) child.remove()
    }
    const result = row.stage === 'confirm' || !row.result ? null : row.result
    row.outcome.textContent = result ? result.text : ''
    row.outcome.classList.toggle('is-error', Boolean(result && result.failed))
    if (!entry.canReset) return

    if (row.stage === 'confirm') {
      const confirm = element('button', 'is-confirm', 'Confirm reset')
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
      row.edit.before(confirm, cancel)
      return
    }

    const words = {
      cycles: ['Reset cycles', `Reset the cycles counted for ${label}`],
      record: ['Reset record', `Reset the record of ${label} to the present value`]
    }[entry.type] || ['Reset to zero', `Reset ${label} to zero`]
    const button = element('button', '', words[0])
    button.type = 'button'
    // While the reset is on its way the button is marked unavailable but
    // stays able to hold keyboard focus, which a disabled button drops.
    if (row.stage === 'busy') button.setAttribute('aria-disabled', 'true')
    button.setAttribute('aria-label', words[1])
    button.addEventListener('click', () => {
      if (row.stage !== 'busy') setStage(row, entry, 'confirm')
    })
    row.edit.before(button)
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
    if (next && hadFocus) next.focus()
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
      // The reset route takes JSON only, so that a form on another site
      // cannot send it.
      const response = await fetch(`${API}/${encodeURIComponent(entry.id)}/reset`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      })
      if (response.ok) {
        showResult(row, entry, { cycles: 'Cycles reset', record: 'Record reset' }[entry.type] || 'Reset to zero', false)
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

  /** The paths an entry's message and facts may name, to be set in a code font. */
  function pathsOf (entry) {
    return [entry.output, entry.resetPath, entry.timeOutput, ...(entry.inputs || []), ...(entry.cycleInputs || []).map((input) => input.path), ...(entry.substituted || []).map((input) => input.path)]
  }

  /**
   * Draws the list of facts, only when it changed: it is rebuilt from the
   * status every two seconds, and an unchanged list is left as it is so
   * that a selection in it survives.
   */
  function renderFacts (row, facts, paths) {
    const drawn = JSON.stringify(facts)
    if (drawn === row.factsDrawn) return
    row.factsDrawn = drawn
    const nodes = []
    for (const item of facts) {
      nodes.push(element('dt', '', item.label))
      nodes.push(writeWithPaths(element('dd'), item.value, paths))
    }
    row.facts.replaceChildren(...nodes)
  }

  function renderEntry (entry) {
    const row = rows.get(entry.key) || createRow(entry)
    row.item.className = `entry is-${entry.state}`
    row.name.textContent = entry.name || entry.output || 'Unnamed entry'
    row.edit.setAttribute('aria-label', `Edit ${row.name.textContent}`)
    // Outside a group an entry sits straight under the page heading.
    row.name.setAttribute('aria-level', entry.group ? '3' : '2')
    writeWithPaths(row.path, entry.output || '', [entry.output])
    renderReading(row, entry)
    row.state.textContent = STATE_LABELS[entry.state] || entry.state
    const paths = pathsOf(entry)
    // A fault from the configuration reads as a clause ("the expression
    // does not parse"); after the state's label it starts a sentence.
    // A message that starts with a path keeps the path as it is written:
    // paths are case-sensitive.
    const text = entry.message || ''
    const message = text && !paths.some((path) => path && text.startsWith(path)) ? text.charAt(0).toUpperCase() + text.slice(1) : text
    writeWithPaths(row.message, message ? `. ${message}` : '', paths)
    renderFacts(row, factsOf(entry), paths)
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
        // Numbered rather than named after the group id, so the id is
        // always one word, as an aria-controls list needs.
        list.id = `status-group-${++blockCount}`
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
    answeredAt = new Date()
    showOffline('')
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
    for (const problem of data.problems || []) messages.push(notice('error', problem))
    const key = messages.map((box) => `${box.className}|${box.textContent}`).join('\n')
    if (key !== noticesKey) {
      noticesKey = key
      notices.replaceChildren(...messages)
    }

    // Entries and groups that are no longer configured leave the page.
    const list = Array.isArray(data.entries) ? data.entries : []
    const current = new Set(list.map((entry) => entry.key))
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
    for (const entry of list) byGroup.get(entry.group && known.has(entry.group) ? entry.group : '').push(entry)

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

    if (list.length === 0) {
      showPlaceholder('No entries yet. An entry is a formula, a period counter, an integration, a cycles entry or a record, added in the editor.', { text: 'Open the editor', href: '#edit' })
    } else {
      placeholder.hidden = true
    }
    const started = data.startedAt ? `. Plugin running since ${when(data.startedAt)}` : ''
    refreshed.textContent = `Updated ${clock(answeredAt, true)}${started}`
  }

  /**
   * Shows, or with an empty text takes away, the notice that the readings
   * are old, and dims the readings while it shows. The notice says so in
   * words, so the dimming is not the only sign, and it is read out once
   * when it appears or changes.
   */
  function showOffline (text) {
    sheet.classList.toggle('is-offline', text !== '')
    if (text === offlineText) return
    offlineText = text
    offline.replaceChildren()
    if (text) offline.append(notice('warning', text))
  }

  /**
   * The time of the last answer, with the date when it was not today. Today
   * is the day in the plugin's time zone, in which the time is given, not
   * the browser's.
   */
  function answeredWhen () {
    const day = (date) => {
      const options = { year: 'numeric', month: '2-digit', day: '2-digit' }
      const fixed = /^([+-])(\d{2}):(\d{2})$/.exec(timeZone || '')
      try {
        if (fixed) {
          const minutes = (Number(fixed[2]) * 60 + Number(fixed[3])) * (fixed[1] === '-' ? -1 : 1)
          return new Intl.DateTimeFormat('en-CA', { ...options, timeZone: 'UTC' }).format(new Date(date.getTime() + minutes * 60000))
        }
        return new Intl.DateTimeFormat('en-CA', { ...options, timeZone }).format(date)
      } catch (err) {
        return date.toDateString()
      }
    }
    return day(new Date()) === day(answeredAt) ? clock(answeredAt, false) : when(answeredAt.toISOString())
  }

  /**
   * Keeps the readings on screen, dimmed, when a refresh brings no new
   * ones. Gives false when there are none to keep.
   */
  function keepReadings (status) {
    if (!answeredAt || rows.size === 0) return false
    const since = answeredWhen()
    showOffline(status === null
      ? `The server could not be reached since ${since}; the readings shown are from then.`
      : `The server has answered with an error (${status}) since ${since}; the readings shown are from then.`)
    return true
  }

  /**
   * Reads the status and draws it. A call while a request is on its way
   * asks for one more after it, so requests never pile up.
   */
  function refresh () {
    if (pending) {
      again = true
      return pending
    }
    pending = (async () => {
      try {
        do {
          again = false
          await fetchAndDraw()
        } while (again)
      } finally {
        pending = null
      }
    })()
    return pending
  }

  async function fetchAndDraw () {
    const number = ++asked
    let result
    try {
      result = await api('/entries')
    } catch (err) {
      if (number < shownAnswer) return
      shownAnswer = number
      keepReadings(null)
      refreshed.textContent = 'The server could not be reached. Trying again.'
      return
    }
    if (number < shownAnswer) return
    shownAnswer = number

    if (result.ok && result.body) {
      render(result.body)
      return
    }

    // An answer that is not the readings, such as an error from a proxy
    // in front of a server that is restarting, leaves the readings on
    // screen, dimmed. An answer that says why there are none clears them.
    // A 503 says why only when it comes from the plugin, with its reason; a
    // proxy in front of a server that is restarting answers 503 too.
    const notRunning = result.status === 503 && !!result.body && typeof result.body.error === 'string'
    const says = result.status === 401 || result.status === 403 || notRunning
    if (!says && keepReadings(result.status)) {
      refreshed.textContent = `The server answered ${result.status}. Trying again.`
      return
    }
    showOffline('')
    answeredAt = null
    clearEntries()
    noticesKey = ''
    notices.replaceChildren()
    if (result.status === 401 || result.status === 403) {
      showPlaceholder('Log in to Signal K to see the calculated paths.', { text: 'Log in', href: '/admin/#/login' })
    } else if (notRunning && result.body.blocked) {
      showPlaceholder(`${result.body.error}. No entries are running. The file has been left as it is.`, { text: 'Open the editor to save a new set', href: '#edit' })
    } else if (notRunning) {
      showPlaceholder('The plugin is not running. On its configuration page, turn on Enabled where it is shown and click Save Configuration.', { text: 'Open the configuration', href: SETTINGS_URL })
    } else {
      showPlaceholder(`The server answered ${result.status}. Trying again.`)
    }
  }

  /** Polls while the view shows: the next request waits for the answer to the last. */
  function poll (current) {
    if (!active || current !== run) return
    const next = () => {
      if (active && current === run) timer = setTimeout(() => poll(current), POLL_MS)
    }
    // A failed drawing does not stop the polls.
    refresh().then(next, (err) => {
      next()
      throw err
    })
  }

  window.CalcPaths.status = {
    show () {
      active = true
      clearTimeout(timer)
      poll(++run)
    },
    hide () {
      active = false
      clearTimeout(timer)
      run++
    },
    refresh
  }
})()
