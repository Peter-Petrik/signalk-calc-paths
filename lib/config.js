'use strict'

/*
 * Configuration checking.
 *
 * The admin form saves whatever was typed. This module turns the saved
 * options into entries the engine can run, and attaches a plain-language
 * error to any entry that cannot run. One bad entry never stops the others:
 * it is reported in the plugin status and on the Webapps page, and skipped.
 */

const { checkName, compileFormula } = require('./formula')
const { PERIODS, WEEK_START_DAYS, canonicalTimeZone, parseDayStart, serverTimeZone } = require('./periods')
const { DEFAULT_OFFSET_PATH, DEFAULT_REGION_PATH } = require('./timezone')

// A Signal K path: dot-separated segments of letters, digits, dashes and
// underscores. An output needs at least two segments, since a single word
// would sit at the root of the vessel's data.
const PATH_PATTERN = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/
const OUTPUT_PATTERN = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/

const RESET_MODES = [...PERIODS, 'path', 'manual']

// What a record entry keeps; see recordEntry().
const RECORD_KINDS = ['lowest', 'highest', 'sinceAbove', 'sinceBelow']
// A lowest or highest value can also start again when the input reaches a
// level, such as a battery that is full again.
const RECORD_RESET_MODES = [...PERIODS, 'level', 'path', 'manual']

// Where the time zone for period boundaries comes from: followed from
// Signal K paths, or fixed by the setting alone.
const ZONE_SOURCES = ['follow', 'fixed']

// The value the time zone dropdown saves for "the server's own time zone".
const SERVER_ZONE = 'server'
const DEFAULT_STALE_SECONDS = 60
const DEFAULT_REPEAT_SECONDS = 10

function text (value) {
  return typeof value === 'string' ? value.trim() : ''
}

function pick (value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback
}

/**
 * Reads a number setting as saved: null when the field was left empty,
 * NaN when it holds something that is not a number, else the number.
 *
 * An emptied form field arrives as null, undefined or an empty string.
 * Number() would read null and '' as 0, which for a timeout means "never
 * stale": the opposite of leaving a setting at its default. Text that is
 * not a number, such as "1.234,5", is not read as 0 or as the default
 * either: either would run the entry on a figure nobody chose, with
 * nothing to say so.
 *
 * A decimal comma is read as the decimal point, as the editor reads it:
 * a phone set to a region that writes "1,5" offers no point on its number
 * keypad, and earlier versions saved such text as typed. A comma followed
 * by exactly three digits, as in "1,500", is refused instead, because it
 * may as well separate thousands.
 */
function readNumber (value) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null
  if (typeof value !== 'number' && typeof value !== 'string') return NaN
  const number = Number(typeof value === 'string' ? decimalPoint(value.trim()) : value)
  return Number.isFinite(number) ? number : NaN
}

/**
 * Text with a decimal comma written with a point; text that is no such
 * number is returned unchanged, or as "NaN" when the comma is ambiguous.
 */
function decimalPoint (text) {
  if (!/^[-+]?\d*,\d+$/.test(text)) return text
  return /,\d{3}$/.test(text) ? 'NaN' : text.replace(',', '.')
}

/** The message for a setting that holds something that is not a number. */
function notNumber (value, what) {
  const shown = typeof value === 'string' ? value : JSON.stringify(value)
  const comma = typeof value === 'string' && /,\d{3}$/.test(value.trim())
    ? ': a comma followed by three digits could separate thousands, so write the number with a point and no separator, such as 1.5 or 1500'
    : ''
  return `"${shown}" is not a number for the ${what}${comma}`
}

/**
 * Reads a setting that cannot be negative. An empty field gives the
 * default; so does a negative number, as it always has. Anything that is
 * not a number is a fault on the field, and the default stands in for it
 * while the entry waits to be corrected.
 */
function nonNegative (entry, value, field, what, fallback) {
  const number = readNumber(value)
  if (number === null) return fallback
  if (Number.isNaN(number)) {
    fault(entry, field, notNumber(value, what))
    return fallback
  }
  return number >= 0 ? number : fallback
}

/** Reads a threshold, which may be negative; empty means 0. */
function threshold (entry, value, field, what) {
  const number = readNumber(value)
  if (number === null) return 0
  if (Number.isNaN(number)) {
    fault(entry, field, notNumber(value, what))
    return 0
  }
  return number
}

/**
 * Fields every entry has, whatever its type.
 */
function common (raw, type, index) {
  const output = text(raw.output)
  const entry = {
    // Entries from the entries file carry an id of their own. Entries given
    // as lists, as in the plugin settings before version 0.3.0, are known by
    // their place in the lists.
    id: typeof raw.id === 'string' && raw.id ? raw.id : `${type}-${index}`,
    group: typeof raw.group === 'string' && raw.group ? raw.group : null,
    type,
    // Shown in messages when an entry has no usable output path to name it.
    label: text(raw.name) || output || `${type} ${index + 1}`,
    name: text(raw.name),
    output,
    unit: text(raw.unit),
    enabled: raw.enabled !== false,
    staleMs: DEFAULT_STALE_SECONDS * 1000,
    onStale: pick(raw.onStale, ['stop', 'hold'], 'stop'),
    // The first fault, which stops the entry; see fault().
    error: null,
    faults: []
  }
  // A Cycles entry has a default of its own; see cyclesEntry().
  if (type !== 'cycles') entry.staleMs = nonNegative(entry, raw.staleTimeout, 'staleTimeout', 'stale timeout', DEFAULT_STALE_SECONDS) * 1000
  if (!output) {
    fault(entry, 'output', 'no output path is set')
  } else if (!OUTPUT_PATTERN.test(output)) {
    fault(entry, 'output', `"${output}" is not a valid output path: use at least two dot-separated segments of letters, digits, dashes and underscores`)
  }
  return entry
}

/**
 * Records a fault in an entry, with the field it lies in, so the editor can
 * mark each one. The first fault is also the entry's `error`, which is what
 * stops it and what the status names. A field is the setting's name, or
 * `inputs.<n>.<setting>` for the nth input (from 0), or null.
 */
function fault (entry, field, text) {
  entry.faults.push({ field, text })
  if (!entry.error) entry.error = text
}

function checkInputPath (entry, path, what, field) {
  if (!path) {
    fault(entry, field, `no ${what} is set`)
  } else if (!PATH_PATTERN.test(path)) {
    fault(entry, field, `"${path}" is not a valid ${what}: use dot-separated segments of letters, digits, dashes and underscores, with no spaces`)
  }
}

/**
 * Reset settings shared by period counters and integrations.
 */
function resetSettings (entry, raw) {
  entry.resets = pick(raw.resets, RESET_MODES, 'day')
  entry.resetPath = text(raw.resetPath)
  if (entry.resets === 'path') {
    checkInputPath(entry, entry.resetPath, 'path to follow for resets', 'resetPath')
  }
}

function formulaEntry (raw, index) {
  const entry = common(raw, 'formula', index)
  entry.expression = text(raw.expression)
  entry.inputs = []

  const seen = new Set()
  let inputsUsable = true
  for (const rawInput of Array.isArray(raw.inputs) ? raw.inputs : []) {
    const input = { name: text(rawInput && rawInput.name), path: text(rawInput && rawInput.path), whenStale: null }
    const at = entry.inputs.length
    // The value used for the input while it is stale, has no value or no
    // number; see formulaEvaluate() in lib/engine.js. Empty means none.
    // Text is read as typed, so that blank text means empty and not 0.
    const rawStale = rawInput ? rawInput.whenStale : undefined
    const whenStale = typeof rawStale === 'string' ? rawStale.trim() : rawStale
    if (whenStale !== undefined && whenStale !== null && whenStale !== '') {
      const number = readNumber(whenStale)
      if (Number.isFinite(number)) input.whenStale = number
      else fault(entry, `inputs.${at}.whenStale`, `the value when stale of "${input.name || `input ${at + 1}`}" is not a number`)
    }
    entry.inputs.push(input)
    const nameProblem = checkName(input.name)
    if (nameProblem) {
      fault(entry, `inputs.${at}.name`, nameProblem)
      inputsUsable = false
    } else if (seen.has(input.name)) {
      fault(entry, `inputs.${at}.name`, `the short name "${input.name}" is used twice`)
      inputsUsable = false
    }
    checkInputPath(entry, input.path, `path for "${input.name || `input ${at + 1}`}"`, `inputs.${at}.path`)
    seen.add(input.name)
  }

  if (entry.inputs.length === 0) {
    fault(entry, 'inputs', 'no inputs are set')
    inputsUsable = false
  }
  // Whether any input has a value for when it is stale.
  entry.substitutes = entry.inputs.some((input) => input.whenStale !== null)
  // The expression can be checked only against usable short names.
  if (inputsUsable) {
    try {
      entry.compiled = compileFormula(entry.expression, entry.inputs.map((i) => i.name))
    } catch (err) {
      fault(entry, 'expression', err.message)
    }
  }
  return entry
}

/**
 * Whether an entry fills in what it would have counted before it started
 * from the server's history; see lib/history.js. On unless switched off,
 * also for entries saved before version 0.8.0, which do not have the
 * setting. Only an entry that starts with nothing saved looks back, so a
 * running entry is never touched by it.
 */
function lookbackSetting (entry, raw) {
  entry.lookback = raw.lookback !== false
}

/**
 * Reads a moment typed as a date and time. Text the runtime reads as a
 * date with a time zone or an offset, such as 2026-09-24T14:05:00Z, is
 * taken as it is. Text without one is refused rather than guessed: the
 * zone of the server, the browser and the ship can all differ.
 */
function readMoment (value) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null
  if (typeof value !== 'string') return NaN
  const text = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i.test(text)) return NaN
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? ms : NaN
}

/**
 * A record entry: the lowest or highest value of an input with the moment
 * it was reached, or the time since the input was last at or above, or at
 * or below, a level, with the moment it last was.
 */
function recordEntry (raw, index) {
  const entry = common(raw, 'record', index)
  entry.input = text(raw.input)
  entry.keep = pick(raw.keep, RECORD_KINDS, 'lowest')
  entry.timeSince = entry.keep === 'sinceAbove' || entry.keep === 'sinceBelow'
  entry.timeOutput = text(raw.timeOutput)
  // A time since is published in seconds; an empty unit says so.
  if (entry.timeSince && !entry.unit) entry.unit = 's'
  checkInputPath(entry, entry.input, 'input path', 'input')
  if (entry.timeSince) {
    const level = readNumber(raw.level)
    if (level === null) fault(entry, 'level', 'no level is set')
    else if (Number.isNaN(level)) fault(entry, 'level', notNumber(raw.level, 'level'))
    entry.level = Number.isFinite(level) ? level : 0
    // A time since knows no resets: it starts again each time the level is
    // met.
    entry.resets = 'manual'
    entry.resetPath = ''
    entry.resetLevel = null
  } else {
    entry.level = null
    entry.resets = pick(raw.resets, RECORD_RESET_MODES, 'manual')
    entry.resetPath = text(raw.resetPath)
    entry.resetLevel = null
    if (entry.resets === 'path') checkInputPath(entry, entry.resetPath, 'path to follow for resets', 'resetPath')
    if (entry.resets === 'level') {
      const level = readNumber(raw.resetLevel)
      if (level === null) fault(entry, 'resetLevel', 'no level to reset at is set')
      else if (Number.isNaN(level)) fault(entry, 'resetLevel', notNumber(raw.resetLevel, 'level to reset at'))
      else entry.resetLevel = level
    }
  }
  if (entry.timeOutput && !OUTPUT_PATTERN.test(entry.timeOutput)) {
    fault(entry, 'timeOutput', `"${entry.timeOutput}" is not a valid path for the time: use at least two dot-separated segments of letters, digits, dashes and underscores`)
  } else if (entry.timeOutput && entry.timeOutput === entry.output) {
    fault(entry, 'timeOutput', 'the path for the time is the output path itself')
  }
  // A start entered by hand: a value with the moment it was reached, for a
  // lowest or highest value, or the moment the level was last met. It is
  // taken into the record whenever it falls within what the record covers;
  // see Engine#applyStart().
  entry.startValue = null
  entry.startTime = null
  const moment = readMoment(raw.startTime)
  if (Number.isNaN(moment)) {
    fault(entry, 'startTime', `"${raw.startTime}" is not a date and time with a time zone, such as 2026-09-24T14:05:00Z`)
  } else {
    entry.startTime = moment
  }
  if (!entry.timeSince) {
    const start = readNumber(raw.startValue)
    if (Number.isNaN(start)) fault(entry, 'startValue', notNumber(raw.startValue, 'start value'))
    else entry.startValue = start
    if (entry.startValue !== null && entry.startTime === null) fault(entry, 'startTime', 'a start value needs the date and time it was reached')
    if (entry.startValue === null && entry.startTime !== null) fault(entry, 'startValue', 'a start time needs the value reached then')
  }
  lookbackSetting(entry, raw)
  return entry
}

function counterEntry (raw, index) {
  const entry = common(raw, 'counter', index)
  entry.input = text(raw.input)
  entry.direction = pick(raw.direction, ['increase', 'decrease', 'net'], 'increase')
  entry.reversal = pick(raw.reversal, ['continue', 'wait'], 'continue')
  entry.minStep = nonNegative(entry, raw.minStep, 'minStep', 'smallest step', 0)
  checkInputPath(entry, entry.input, 'input path', 'input')
  resetSettings(entry, raw)
  lookbackSetting(entry, raw)
  return entry
}

function integrationEntry (raw, index) {
  const entry = common(raw, 'integration', index)
  entry.input = text(raw.input)
  entry.mode = pick(raw.mode, ['rate', 'time'], 'rate')
  // The threshold is used in time mode only, and the editor hides it in
  // rate mode, so only there is what it holds checked.
  if (entry.mode === 'time') {
    entry.threshold = threshold(entry, raw.threshold, 'threshold', 'threshold')
  } else {
    const number = readNumber(raw.threshold)
    entry.threshold = Number.isFinite(number) ? number : 0
  }
  entry.gap = pick(raw.gap, ['skip', 'bridge'], 'skip')
  checkInputPath(entry, entry.input, 'input path', 'input')
  resetSettings(entry, raw)
  lookbackSetting(entry, raw)
  return entry
}

// What a "Cycles" entry can publish, and the unit each figure is in.
const CYCLE_FIGURES = {
  onMedian: 's',
  offMedian: 's',
  periodMedian: 's',
  duty: 'ratio',
  lastOn: 's',
  cycles: '',
  onSoFar: 's'
}

/**
 * A "Cycles" entry: one or more inputs read as on/off or as a wave, and
 * combined; see lib/cycles.js.
 */
function cyclesEntry (raw, index) {
  const entry = common(raw, 'cycles', index)
  // A longer default stale timeout than other entries: a wave input may
  // come from a sensor that reports about once a minute, and a late report
  // must not cut the series.
  entry.staleMs = nonNegative(entry, raw.staleTimeout, 'staleTimeout', 'stale timeout', 180) * 1000
  entry.combine = pick(raw.combine, ['all', 'any'], 'all')
  entry.statistic = pick(raw.statistic, Object.keys(CYCLE_FIGURES), 'onMedian')
  // An empty unit takes the unit of the figure published.
  if (!entry.unit) entry.unit = CYCLE_FIGURES[entry.statistic]
  if (entry.statistic === 'onSoFar') {
    // The window and the cycles needed play no part in the ON time so far,
    // and the editor hides them for it, so a value there that cannot be
    // used is not a fault: the default is used, as for the smoothing. The
    // status page still shows the other figures, over the window.
    const window = readNumber(raw.window)
    const needed = readNumber(raw.minCycles)
    entry.windowMs = (window !== null && window > 0 ? window : 24) * 3600000
    entry.minCycles = Math.floor(needed !== null && needed >= 0 ? needed : 3)
  } else {
    entry.windowMs = nonNegative(entry, raw.window, 'window', 'window', 24) * 3600000
    entry.minCycles = Math.floor(nonNegative(entry, raw.minCycles, 'minCycles', 'cycles needed', 3))
  }
  // The smoothing applies to wave inputs only, and the editor hides it
  // otherwise; it is checked below, once the inputs are known.
  const smoothing = readNumber(raw.smoothing)
  entry.smoothingMs = (smoothing !== null && smoothing >= 0 ? smoothing : 150) * 1000
  entry.shortestMs = nonNegative(entry, raw.shortest, 'shortest', 'shortest stretch', 120) * 1000
  entry.longestMs = nonNegative(entry, raw.longest, 'longest', 'longest stretch', 7200) * 1000
  entry.inputs = []
  for (const rawInput of Array.isArray(raw.inputs) ? raw.inputs : []) {
    const item = rawInput && typeof rawInput === 'object' ? rawInput : {}
    const kind = pick(item.kind, ['onoff', 'wave'], 'onoff')
    const input = { path: text(item.path), kind }
    const at = entry.inputs.length
    if (kind === 'onoff') {
      input.threshold = threshold(entry, item.threshold, `inputs.${at}.threshold`, `threshold of input ${at + 1}`)
    } else {
      input.direction = pick(item.direction, ['falling', 'rising'], 'falling')
      const swing = readNumber(item.swing)
      input.swing = swing === null ? NaN : swing
    }
    entry.inputs.push(input)
    checkInputPath(entry, input.path, `path of input ${at + 1}`, `inputs.${at}.path`)
    if (kind === 'wave' && readNumber(item.swing) !== null && Number.isNaN(input.swing)) {
      fault(entry, `inputs.${at}.swing`, notNumber(item.swing, `swing of input ${at + 1}`))
    } else if (kind === 'wave' && !(input.swing > 0)) {
      fault(entry, `inputs.${at}.swing`, `input ${at + 1} is read as a wave and needs a swing above 0`)
    }
  }
  if (entry.inputs.length === 0) fault(entry, 'inputs', 'no inputs are set')
  if (entry.windowMs <= 0) fault(entry, 'window', 'the window must be longer than 0 hours')
  if (entry.longestMs <= entry.shortestMs) fault(entry, 'longest', 'the longest stretch must be longer than the shortest')
  // The smoothing applies to wave inputs only; the editor hides it otherwise.
  if (entry.inputs.some((input) => input.kind === 'wave')) {
    if (Number.isNaN(smoothing)) fault(entry, 'smoothing', notNumber(raw.smoothing, 'smoothing'))
    else if (entry.smoothingMs > 1800000) fault(entry, 'smoothing', 'the smoothing must be at most 1800 seconds')
  }
  lookbackSetting(entry, raw)
  return entry
}

/**
 * Paths an entry reads its values from.
 */
function inputPaths (entry) {
  return Array.isArray(entry.inputs) ? entry.inputs.map((i) => i.path) : [entry.input]
}

/**
 * Every path an entry reacts to: its inputs, and the path it follows for
 * resets when it has one.
 */
function dependencyPaths (entry) {
  const paths = inputPaths(entry)
  return entry.resets === 'path' ? [...paths, entry.resetPath] : paths
}

/**
 * Marks entries that cannot run because of how they relate to each other:
 * two entries writing one path, or entries feeding each other in a loop.
 */
function checkRelations (entries) {
  const byOutput = new Map()
  // The paths a record entry publishes its times on. Nothing can calculate
  // with a time written as text, but no other entry may write one.
  const timePaths = new Map()
  for (const entry of entries) {
    if (entry.error || !entry.enabled) continue
    const taken = byOutput.get(entry.output) || timePaths.get(entry.output)
    if (taken) {
      fault(entry, 'output', `the output path "${entry.output}" is already written by "${taken.label}"`)
      continue
    }
    if (entry.timeOutput) {
      const other = byOutput.get(entry.timeOutput) || timePaths.get(entry.timeOutput)
      if (other) {
        fault(entry, 'timeOutput', `the path for the time "${entry.timeOutput}" is already written by "${other.label}"`)
        continue
      }
      timePaths.set(entry.timeOutput, entry)
    }
    byOutput.set(entry.output, entry)
  }

  // Depth-first walk along "reads the output of". Meeting an entry that is
  // still on the walk's own trail means the trail closes into a loop, and
  // every entry on that loop is refused: none of them could ever settle.
  const state = new Map()
  const visit = (entry, trail) => {
    if (state.get(entry) === 'done') return
    if (state.get(entry) === 'open') {
      const loop = trail.slice(trail.indexOf(entry))
      // An entry that reads its own output is the commonest case, and says
      // so plainly; a longer loop names its paths in reading order.
      const text = loop.length === 1
        ? `it reads its own output path ${entry.output}; an entry cannot read what it publishes`
        : `entries read each other's output in a loop, so none of them can be worked out: ${[...loop, entry].map((e) => e.output).join(' -> ')}`
      for (const member of loop) fault(member, null, text)
      return
    }
    state.set(entry, 'open')
    for (const path of dependencyPaths(entry)) {
      const source = byOutput.get(path)
      if (source && !source.error) visit(source, [...trail, entry])
    }
    state.set(entry, 'done')
  }
  for (const entry of byOutput.values()) {
    if (!entry.error) visit(entry, [])
  }
}

/**
 * Turns saved plugin options into settings and runnable entries.
 *
 * The settings come from the plugin options. The entries come from `doc`,
 * the entries file, when one is given; otherwise from the three lists in
 * the options, where versions before 0.3.0 kept them.
 *
 * @param {object} options - The plugin options.
 * @param {object} [doc] - An entries document; see lib/store.js.
 * @returns {{settings: object, entries: object[], problems: string[]}}
 *   `problems` lists settings-level faults; entry-level faults sit on the
 *   entries themselves as `error`.
 */
function normalizeConfig (options, doc) {
  const raw = options || {}
  const problems = []

  // The zone chosen in the settings. It is the zone in use when nothing is
  // followed, and the fallback when a followed path has said nothing yet.
  // An empty choice, and the explicit choice "server", mean the server's
  // own time zone; versions before 0.2.0 saved an empty text for that.
  const chosen = text(raw.timeZone)
  let timeZone = serverTimeZone()
  let fallbackSource = 'server'
  if (chosen && chosen !== SERVER_ZONE) {
    const canonical = canonicalTimeZone(chosen)
    if (canonical) {
      timeZone = canonical
      fallbackSource = 'setting'
    } else {
      problems.push(`"${chosen}" is not a known time zone; using the server's zone, ${serverTimeZone()}`)
    }
  }

  // Which Signal K paths to read the ship's time zone from. An emptied
  // field goes back to the standard path, like every other emptied setting.
  const followedPath = (value, standard, what) => {
    const path = text(value)
    if (!path) return standard
    if (PATH_PATTERN.test(path)) return path
    problems.push(`"${path}" is not a valid path for the ${what}; using ${standard}`)
    return standard
  }
  const zone = {
    follow: pick(raw.timeZoneSource, ZONE_SOURCES, 'follow') === 'follow',
    regionPath: followedPath(raw.timeZoneRegionPath, DEFAULT_REGION_PATH, 'time zone name'),
    offsetPath: followedPath(raw.timeZoneOffsetPath, DEFAULT_OFFSET_PATH, 'UTC offset'),
    fallback: timeZone,
    fallbackSource
  }

  let dayStartMinutes = parseDayStart(raw.dayStart)
  if (dayStartMinutes === null) {
    problems.push(`"${raw.dayStart}" is not a valid day start (expected HH:MM); using 00:00`)
    dayStartMinutes = 0
  }

  const settings = {
    // The zone from the settings. The zone actually in use may be a
    // followed one; see lib/timezone.js.
    timeZone,
    zone,
    dayStartMinutes,
    weekStart: pick(raw.weekStart, Object.keys(WEEK_START_DAYS), 'monday'),
    // Zero switches the repeat off: a value is then sent only when it
    // changes.
    repeatMs: DEFAULT_REPEAT_SECONDS * 1000
  }
  const repeat = readNumber(raw.repeatInterval)
  if (Number.isNaN(repeat)) {
    problems.push(`${notNumber(raw.repeatInterval, 'repeat interval')}; using ${DEFAULT_REPEAT_SECONDS} s`)
  } else if (repeat !== null && repeat >= 0) {
    settings.repeatMs = repeat * 1000
  }

  let entries
  if (doc && Array.isArray(doc.entries)) {
    const build = { formula: formulaEntry, counter: counterEntry, integration: integrationEntry, cycles: cyclesEntry, record: recordEntry }
    entries = doc.entries.filter((item) => item && build[item.type]).map((item, index) => build[item.type](item, index))
  } else {
    const list = (value) => (Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [])
    const lists = [
      ...list(raw.formulas).map((item) => [item, formulaEntry]),
      ...list(raw.counters).map((item) => [item, counterEntry]),
      ...list(raw.integrations).map((item) => [item, integrationEntry])
    ]
    entries = lists.map(([item, build], index) => build(item, index))
  }
  // An entry writing the path the ship's time zone is read from would set
  // the zone its own periods are counted in, and anything else's.
  if (zone.follow) {
    for (const entry of entries) {
      if (entry.output && (entry.output === zone.regionPath || entry.output === zone.offsetPath)) {
        fault(entry, 'output', 'the output path is the path the time zone is read from')
      }
      if (entry.timeOutput && (entry.timeOutput === zone.regionPath || entry.timeOutput === zone.offsetPath)) {
        fault(entry, 'timeOutput', 'the path for the time is the path the time zone is read from')
      }
    }
  }
  checkRelations(entries)

  return { settings, entries, problems }
}

module.exports = {
  CYCLE_FIGURES,
  RECORD_KINDS,
  RECORD_RESET_MODES,
  DEFAULT_REPEAT_SECONDS,
  DEFAULT_STALE_SECONDS,
  RESET_MODES,
  SERVER_ZONE,
  ZONE_SOURCES,
  dependencyPaths,
  inputPaths,
  normalizeConfig,
  readMoment
}
