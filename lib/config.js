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
const { PERIODS, WEEK_START_DAYS, isValidTimeZone, parseDayStart, serverTimeZone } = require('./periods')

// A Signal K path: dot-separated segments of letters, digits, dashes and
// underscores. An output needs at least two segments, since a single word
// would sit at the root of the vessel's data.
const PATH_PATTERN = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/
const OUTPUT_PATTERN = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/

const RESET_MODES = [...PERIODS, 'path', 'manual']
const DEFAULT_STALE_SECONDS = 60
const DEFAULT_REPEAT_SECONDS = 10

function text (value) {
  return typeof value === 'string' ? value.trim() : ''
}

function pick (value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback
}

function nonNegative (value, fallback) {
  // An emptied form field arrives as null, undefined or an empty string.
  // Number() would read null and '' as 0, which for a timeout means "never
  // stale": the opposite of leaving a setting at its default.
  if (value === null || value === undefined || value === '') return fallback
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

/**
 * Fields every entry has, whatever its type.
 */
function common (raw, type, index) {
  const output = text(raw.output)
  const entry = {
    type,
    // Shown in messages when an entry has no usable output path to name it.
    label: text(raw.name) || output || `${type} ${index + 1}`,
    name: text(raw.name),
    output,
    unit: text(raw.unit),
    enabled: raw.enabled !== false,
    staleMs: nonNegative(raw.staleTimeout, DEFAULT_STALE_SECONDS) * 1000,
    onStale: pick(raw.onStale, ['stop', 'hold'], 'stop'),
    error: null
  }
  if (!output) {
    entry.error = 'no output path is set'
  } else if (!OUTPUT_PATTERN.test(output)) {
    entry.error = `"${output}" is not a valid output path: use at least two dot-separated segments of letters, digits, dashes and underscores`
  }
  return entry
}

function checkInputPath (entry, path, what) {
  if (entry.error) return
  if (!path) {
    entry.error = `no ${what} is set`
  } else if (!PATH_PATTERN.test(path)) {
    entry.error = `"${path}" is not a valid ${what}`
  }
}

/**
 * Reset settings shared by period counters and integrations.
 */
function resetSettings (entry, raw) {
  entry.resets = pick(raw.resets, RESET_MODES, 'day')
  entry.resetPath = text(raw.resetPath)
  if (entry.resets === 'path') {
    checkInputPath(entry, entry.resetPath, 'path to follow for resets')
  }
}

function formulaEntry (raw, index) {
  const entry = common(raw, 'formula', index)
  entry.expression = text(raw.expression)
  entry.inputs = []

  const seen = new Set()
  for (const rawInput of Array.isArray(raw.inputs) ? raw.inputs : []) {
    const input = { name: text(rawInput && rawInput.name), path: text(rawInput && rawInput.path) }
    entry.inputs.push(input)
    if (entry.error) continue
    const nameProblem = checkName(input.name)
    if (nameProblem) {
      entry.error = nameProblem
    } else if (seen.has(input.name)) {
      entry.error = `the short name "${input.name}" is used twice`
    } else {
      checkInputPath(entry, input.path, `path for "${input.name}"`)
    }
    seen.add(input.name)
  }

  if (!entry.error && entry.inputs.length === 0) {
    entry.error = 'no inputs are set'
  }
  if (!entry.error) {
    try {
      entry.compiled = compileFormula(entry.expression, entry.inputs.map((i) => i.name))
    } catch (err) {
      entry.error = err.message
    }
  }
  return entry
}

function counterEntry (raw, index) {
  const entry = common(raw, 'counter', index)
  entry.input = text(raw.input)
  entry.direction = pick(raw.direction, ['increase', 'decrease', 'net'], 'increase')
  entry.reversal = pick(raw.reversal, ['continue', 'wait'], 'continue')
  entry.minStep = nonNegative(raw.minStep, 0)
  checkInputPath(entry, entry.input, 'input path')
  resetSettings(entry, raw)
  return entry
}

function integrationEntry (raw, index) {
  const entry = common(raw, 'integration', index)
  entry.input = text(raw.input)
  entry.mode = pick(raw.mode, ['rate', 'time'], 'rate')
  const threshold = raw.threshold === null || raw.threshold === '' ? NaN : Number(raw.threshold)
  entry.threshold = Number.isFinite(threshold) ? threshold : 0
  entry.gap = pick(raw.gap, ['skip', 'bridge'], 'skip')
  checkInputPath(entry, entry.input, 'input path')
  resetSettings(entry, raw)
  return entry
}

/**
 * Paths an entry reads its values from.
 */
function inputPaths (entry) {
  return entry.type === 'formula' ? entry.inputs.map((i) => i.path) : [entry.input]
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
  for (const entry of entries) {
    if (entry.error || !entry.enabled) continue
    if (byOutput.has(entry.output)) {
      entry.error = `the output path "${entry.output}" is already written by "${byOutput.get(entry.output).label}"`
      continue
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
      for (const member of loop) {
        member.error = `circular reference: ${[...loop, entry].map((e) => e.output).join(' -> ')}`
      }
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
 * @returns {{settings: object, entries: object[], problems: string[]}}
 *   `problems` lists settings-level faults; entry-level faults sit on the
 *   entries themselves as `error`.
 */
function normalizeConfig (options) {
  const raw = options || {}
  const problems = []

  let timeZone = text(raw.timeZone)
  if (!timeZone) {
    timeZone = serverTimeZone()
  } else if (!isValidTimeZone(timeZone)) {
    problems.push(`"${timeZone}" is not a known time zone; using the server's zone, ${serverTimeZone()}`)
    timeZone = serverTimeZone()
  }

  let dayStartMinutes = parseDayStart(raw.dayStart)
  if (dayStartMinutes === null) {
    problems.push(`"${raw.dayStart}" is not a valid day start (expected HH:MM); using 00:00`)
    dayStartMinutes = 0
  }

  const settings = {
    timeZone,
    dayStartMinutes,
    weekStart: pick(raw.weekStart, Object.keys(WEEK_START_DAYS), 'monday'),
    // Zero switches the repeat off: a value is then sent only when it
    // changes.
    repeatMs: nonNegative(raw.repeatInterval, DEFAULT_REPEAT_SECONDS) * 1000
  }

  const list = (value) => (Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [])
  const entries = [
    ...list(raw.formulas).map(formulaEntry),
    ...list(raw.counters).map(counterEntry),
    ...list(raw.integrations).map(integrationEntry)
  ]
  checkRelations(entries)

  return { settings, entries, problems }
}

module.exports = {
  DEFAULT_REPEAT_SECONDS,
  DEFAULT_STALE_SECONDS,
  RESET_MODES,
  dependencyPaths,
  inputPaths,
  normalizeConfig
}
