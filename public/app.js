'use strict'

/*
 * Calculated Paths status page.
 *
 * Polls the plugin's status route and shows one line per entry: the name,
 * the output path, the current value, what the entry is doing, and a reset
 * button for totals. Everything the server sends is written with
 * textContent, never as HTML.
 */

;(function () {
  const API = '/plugins/signalk-calc-paths/api/entries'
  const CONFIG_URL = '/admin/#/serverConfiguration/plugins/signalk-calc-paths'
  const POLL_MS = 2000
  // How long a "Confirm reset" button waits before it turns back.
  const CONFIRM_MS = 6000
  // How long the outcome of a reset stays beside the button.
  const RESULT_MS = 8000

  const list = document.getElementById('entries')
  const notices = document.getElementById('notices')
  const placeholder = document.getElementById('placeholder')
  const context = document.getElementById('context')
  const refreshed = document.getElementById('refreshed')
  const version = document.getElementById('version')

  // One record per entry on screen, keyed by the entry's unique key, so that
  // a refresh updates the existing line instead of rebuilding it. Rebuilding
  // would throw away a half-finished reset confirmation and keyboard focus.
  const rows = new Map()
  let timeZone

  const STATE_LABELS = {
    ok: 'Publishing',
    waiting: 'Waiting',
    stale: 'Stale',
    error: 'Configuration error',
    disabled: 'Disabled'
  }

  const RESET_PHRASES = {
    day: 'resets every day',
    week: 'resets every week',
    month: 'resets every month',
    year: 'resets every year',
    manual: 'reset only by hand'
  }

  function element (tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  /** Formats a number with a sensible count of decimals for its size. */
  function figure (value) {
    const size = Math.abs(value)
    // Below 1 a fixed count of decimals would round a small reading away
    // to zero, so three significant digits are kept instead.
    if (size > 0 && size < 1) return new Intl.NumberFormat(undefined, { maximumSignificantDigits: 3 }).format(value)
    let decimals = 2
    if (size >= 1000) decimals = 0
    else if (size >= 100) decimals = 1
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: decimals }).format(value)
  }

  /**
   * Turns a value in a Signal K unit into the everyday reading for that
   * unit: joules into Wh or kWh, seconds into hours and minutes, and so on.
   * Returns null when the published unit is already the natural reading.
   */
  function everyday (value, unit, type) {
    const size = Math.abs(value)
    switch (unit) {
      case 'J':
        if (size >= 3.6e6) return { figure: figure(value / 3.6e6), unit: 'kWh' }
        if (size >= 3600) return { figure: figure(value / 3600), unit: 'Wh' }
        return null
      case 'W':
        return size >= 1000 ? { figure: figure(value / 1000), unit: 'kW' } : null
      case 's': {
        if (size < 60) return null
        const sign = value < 0 ? '-' : ''
        const minutes = Math.round(size / 60)
        const hours = Math.floor(minutes / 60)
        return hours > 0
          ? { figure: `${sign}${hours} h ${String(minutes % 60).padStart(2, '0')} min`, unit: '' }
          : { figure: `${sign}${minutes} min`, unit: '' }
      }
      case 'm3':
        return size < 1 ? { figure: figure(value * 1000), unit: 'L' } : null
      case 'ratio':
        return { figure: figure(value * 100), unit: '%' }
      case 'K':
        // Only a formula can hold a temperature. A counter or integration
        // in kelvin is a difference or a sum, where the offset is wrong.
        return type === 'formula' ? { figure: figure(value - 273.15), unit: '°C' } : null
      default:
        return null
    }
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
        return `${start}, the ship's time read from ${from}.`
      case 'remembered':
        return `${start}, the ship's time last read from ${from}. Nothing has been published there since the plugin started.`
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

  /** One sentence saying what kind of entry this is and how it behaves. */
  function describe (entry) {
    if (entry.type === 'formula') return `Formula: ${entry.expression}`
    const kind = entry.type === 'counter' ? 'Period counter' : 'Integration'
    const reset = entry.resets === 'path' ? `resets when ${entry.resetPath} resets` : RESET_PHRASES[entry.resets]
    const since = entry.since ? ` Counting since ${when(entry.since)}.` : ''
    return `${kind} on ${entry.inputs.join(', ')}, ${reset}.${since}`
  }

  function createRow (entry) {
    const item = element('li', 'entry')
    const what = element('div', 'entry-what')
    const name = element('h2', 'entry-name')
    const path = element('p', 'entry-path')
    what.append(name, path)

    const reading = element('div', 'entry-reading')
    const detail = element('p', 'entry-detail')
    const state = element('span', 'entry-state')
    const message = document.createTextNode('')
    detail.append(state, message)

    const action = element('div', 'entry-action')
    item.append(what, reading, detail, action)
    list.append(item)

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
      const confirm = element('button', 'is-confirm', 'Confirm reset')
      confirm.type = 'button'
      confirm.addEventListener('click', () => reset(row, entry))
      const cancel = element('button', 'is-quiet', 'Cancel')
      cancel.type = 'button'
      cancel.addEventListener('click', () => setStage(row, entry, 'idle'))
      row.action.append(confirm, cancel)
      return
    }

    if (row.result) row.action.append(element('span', `action-result${row.result.failed ? ' is-error' : ''}`, row.result.text))
    const button = element('button', '', 'Reset to zero')
    button.type = 'button'
    button.disabled = row.stage === 'busy'
    button.setAttribute('aria-label', `Reset ${label} to zero`)
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
        showResult(row, entry, 'Reset to zero', false)
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

  function renderEntry (entry) {
    const row = rows.get(entry.key) || createRow(entry)
    row.item.className = `entry is-${entry.state}`
    row.name.textContent = entry.name || entry.output || 'Unnamed entry'
    row.path.textContent = entry.output
    renderReading(row, entry)
    row.state.textContent = STATE_LABELS[entry.state] || entry.state
    const parts = [describe(entry)]
    if (entry.message) parts.unshift(entry.message)
    row.message.textContent = `. ${parts.join(' ')}`
    // The action area is left alone while a reset is being confirmed or
    // sent, so a refresh cannot pull the button out from under a click.
    if (row.stage === 'idle') renderAction(row, entry)
    return row
  }

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
      row.item.remove()
    }
    rows.clear()
  }

  function render (data) {
    timeZone = data.timeZone
    context.textContent = describeZone(data)
    version.textContent = `signalk-calc-paths ${data.version}`

    const messages = []
    if (!data.clockTrusted) {
      messages.push(notice('warning', 'The system clock looks unset. Totals keep counting, and period resets are paused until the clock is correct.'))
    }
    if (data.timeZoneSource && data.timeZoneSource.problem) messages.push(notice('warning', data.timeZoneSource.problem))
    for (const problem of data.problems) messages.push(notice('error', problem))
    notices.replaceChildren(...messages)

    // Entries that are no longer configured leave the page.
    const current = new Set(data.entries.map((entry) => entry.key))
    for (const [key, row] of rows) {
      if (!current.has(key)) {
        clearTimeout(row.confirmTimer)
        clearTimeout(row.resultTimer)
        row.item.remove()
        rows.delete(key)
      }
    }
    // Lines are kept in the order of the configuration. A line that is
    // already in its place is left alone: moving it would take keyboard
    // focus away from a button inside it.
    data.entries.forEach((entry, index) => {
      const item = renderEntry(entry).item
      if (list.children[index] !== item) list.insertBefore(item, list.children[index] || null)
    })

    if (data.entries.length === 0) {
      showPlaceholder('No entries yet. Add a formula, a period counter or an integration in the plugin configuration.', { text: 'Open the configuration', href: CONFIG_URL })
    } else {
      placeholder.hidden = true
    }
    refreshed.textContent = `Updated ${new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' }).format(new Date())}`
  }

  async function refresh () {
    let response
    try {
      response = await fetch(API, { credentials: 'same-origin', cache: 'no-store' })
    } catch (err) {
      refreshed.textContent = 'The server could not be reached. Trying again.'
      return
    }

    if (response.ok) {
      render(await response.json())
      return
    }

    clearEntries()
    notices.replaceChildren()
    if (response.status === 401 || response.status === 403) {
      showPlaceholder('Log in to Signal K to see the calculated paths.', { text: 'Log in', href: '/admin/#/login' })
    } else if (response.status === 503) {
      showPlaceholder('The plugin is not running. Enable it in the plugin configuration.', { text: 'Open the configuration', href: CONFIG_URL })
    } else {
      showPlaceholder(`The server answered ${response.status}. Trying again.`)
    }
  }

  refresh()
  setInterval(refresh, POLL_MS)
})()
