'use strict'

/*
 * The calculation engine.
 *
 * The engine knows nothing about Signal K. It is fed input values with two
 * time readings and answers with the values to publish. That separation is
 * what lets the same code run inside the server and be replayed, in tests,
 * over days of recorded data in a few seconds.
 *
 * Two clocks are used on purpose:
 *
 * 1. A wall clock (milliseconds since the Unix epoch) decides when a day,
 *    week, month or year begins.
 * 2. A monotonic clock (milliseconds from an arbitrary start) measures how
 *    much time passed between two values and how old a value is.
 *
 * A boat computer without a clock battery can start with the wrong date and
 * jump to the right one minutes later, once GPS or the network supplies it.
 * Measuring durations on the wall clock would count that jump as elapsed
 * time. The monotonic clock never jumps, so sums stay correct, and the wall
 * clock is trusted only for the one thing it is needed for.
 *
 * Everything happens in passes. A pass starts with a set of changed paths
 * (the values of one incoming update, or nothing at all for the once-a-second
 * tick) and walks the entries in dependency order. An entry that produces a
 * new value adds its output path to the set, so the entries that read it
 * are calculated later in the same pass, each exactly once and with all of
 * its inputs already up to date.
 */

const { dependencyPaths, inputPaths } = require('./config')
const { PERIODS, nextPeriodStart, periodStart } = require('./periods')

// A wall clock reading before this date cannot be right: the plugin did not
// exist yet. A computer that lost its clock typically starts at 1970 or at
// its firmware build date.
const EARLIEST_SANE_CLOCK = Date.UTC(2024, 0, 1)

// How far the wall clock may sit behind the time of the last save before it
// is treated as not yet set. A few minutes of slack covers ordinary clock
// corrections.
const CLOCK_BACK_TOLERANCE_MS = 5 * 60 * 1000

// How long an earlier-than-saved clock reading must hold before it is
// believed over the saved time.
const CLOCK_ACCEPT_AFTER_MS = 60 * 60 * 1000

/**
 * Reduces a Signal K value to a number the engine can calculate with.
 * Switch states arrive as true or false and are counted as 1 and 0, which
 * makes "time while a switch is on" a plain integration. Anything else
 * (null, text, an object such as a position, a number that is not finite)
 * is not usable and yields null, which the engine reads as "no value".
 */
function toNumber (value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value ? 1 : 0
  return null
}

/**
 * Identifies what an entry's saved total was measured from. When this
 * changes (a different input, a different direction) the old total no
 * longer means anything and is dropped. Edits that do not change what is
 * measured, such as the name or the stale timeout, leave it unchanged and
 * keep the total.
 */
function signature (config) {
  if (config.type === 'counter') return `counter|${config.input}|${config.direction}`
  if (config.type === 'integration') {
    // The threshold only shapes the total in time mode.
    return `integration|${config.input}|${config.mode}|${config.mode === 'time' ? config.threshold : ''}`
  }
  return 'formula'
}

/**
 * Sorts entries so that each one comes after every entry it reads from.
 * Loops were already refused when the configuration was checked, so a
 * plain depth-first walk is enough.
 */
function dependencyOrder (entries) {
  const byOutput = new Map(entries.map((entry) => [entry.config.output, entry]))
  const ordered = []
  const visited = new Set()
  const visit = (entry) => {
    if (visited.has(entry)) return
    visited.add(entry)
    for (const path of dependencyPaths(entry.config)) {
      const source = byOutput.get(path)
      if (source) visit(source)
    }
    ordered.push(entry)
  }
  entries.forEach(visit)
  return ordered
}

class Engine {
  /**
   * @param {object} normalized - Result of normalizeConfig().
   * @param {object|null} saved - Previously saved state, or null.
   */
  constructor (normalized, saved) {
    this.settings = normalized.settings
    this.savedAt = saved && Number.isFinite(saved.savedAt) ? saved.savedAt : null
    this.clockSuspect = false
    this.behindSinceMono = null
    this.dirty = false
    this.periodCache = new Map()

    this.entries = normalized.entries.map((config, index) => this.createEntry(config, index, saved))
    const active = this.entries.filter((entry) => entry.active)
    this.order = dependencyOrder(active)

    // The paths that must come from the server: everything an active entry
    // reads that no active entry produces. Values offered for any other
    // path, including the outputs of entries, are not taken in.
    const read = new Set(active.flatMap((entry) => dependencyPaths(entry.config)))
    const outputs = new Set(active.map((entry) => entry.config.output))
    this.externalPaths = [...read].filter((path) => !outputs.has(path)).sort()
    this.external = new Set(this.externalPaths)
  }

  createEntry (config, index, saved) {
    const entry = {
      config,
      // Unique even when two entries share an output path or have none.
      key: `${config.type}-${index}`,
      active: config.enabled && !config.error,
      value: null,
      // Monotonic and wall time of the last value this entry took in.
      inputMono: null,
      updatedWall: null,
      publishedValue: null,
      publishedMono: null,
      note: '',
      // Whether dependent entries were told that this entry went stale.
      staleNotified: false,
      // Set once the first check after start-up has run; used to tell a
      // boundary that passed during downtime from one seen live.
      checkedSinceStart: false
    }

    if (config.type === 'formula') {
      entry.variables = new Map()
    } else {
      entry.total = 0
      entry.started = false
      entry.since = null
      entry.periodStart = null
      entry.referenceLast = null
      if (config.type === 'counter') entry.last = null
      if (config.type === 'integration') entry.previous = null

      const old = saved && saved.entries && config.output ? saved.entries[config.output] : null
      if (old && old.signature === signature(config)) {
        entry.restored = true
        entry.started = true
        if (config.type === 'counter') entry.last = Number.isFinite(old.last) ? old.last : null
        // A total collected under one reset rule says nothing under
        // another: a total "since the last reset by hand" is not "today's".
        // Only the counter's place in its input survives such a change.
        if (old.resets === config.resets) {
          entry.total = Number.isFinite(old.total) ? old.total : 0
          entry.since = Number.isFinite(old.since) ? old.since : null
          entry.periodStart = Number.isFinite(old.periodStart) ? old.periodStart : null
          // The level last seen on the followed path is only comparable
          // with later values of that same path.
          if (config.resets === 'path' && old.resetPath === config.resetPath) {
            entry.referenceLast = Number.isFinite(old.referenceLast) ? old.referenceLast : null
          }
        }
      }
    }
    return entry
  }

  /**
   * Decides whether the wall clock can be trusted for period boundaries.
   * While it cannot, totals keep accumulating on the monotonic clock and
   * no period is started or ended; the check repeats on every pass, so
   * boundaries resume by themselves once the clock is set.
   */
  checkClock (wall, mono) {
    if (wall < EARLIEST_SANE_CLOCK) {
      this.clockSuspect = true
      this.behindSinceMono = null
      return
    }
    const behind = this.savedAt !== null && wall < this.savedAt - CLOCK_BACK_TOLERANCE_MS
    if (!behind) {
      this.clockSuspect = false
      this.behindSinceMono = null
      return
    }
    // The clock reads earlier than the last save. Usually it is simply not
    // set yet. But the earlier reading may be the right one: the clock could
    // have been wrong, and ahead, when the state was saved. If the reading
    // holds steady for an hour it is accepted, so a bad saved time cannot
    // freeze period boundaries for good.
    if (this.behindSinceMono === null) this.behindSinceMono = mono
    if (mono - this.behindSinceMono > CLOCK_ACCEPT_AFTER_MS) {
      this.savedAt = wall
      this.clockSuspect = false
      this.behindSinceMono = null
      this.periodCache.clear()
      this.dirty = true
    } else {
      this.clockSuspect = true
    }
  }

  /**
   * Returns the start of the current period of one kind. Working out a
   * boundary needs several time zone conversions, and every entry asks on
   * every pass, so the answer is cached until the next boundary is reached.
   */
  currentPeriodStart (period, wall) {
    let cached = this.periodCache.get(period)
    if (!cached || wall < cached.start || wall >= cached.next) {
      const start = periodStart(wall, period, this.settings)
      cached = { start, next: nextPeriodStart(start, period, this.settings) }
      this.periodCache.set(period, cached)
    }
    return cached.start
  }

  // ------------------------------------------------------------- the pass

  /**
   * Walks every active entry once, in dependency order.
   *
   * @param {Map<string, *>} changed - Paths with a new value. Entries add
   *   their own output to it as they go.
   * @param {number} wall
   * @param {number} mono
   * @param {number} [countFrom] - See input().
   * @param {boolean} [ticking] - True for the once-a-second pass, which
   *   also does the work that no incoming value triggers.
   */
  pass (changed, wall, mono, countFrom, ticking) {
    // A value known from before start-up carries an aged monotonic time.
    // The clock check must run on the present moment, or an old value
    // would count as "the clock has been behind for an hour" at once.
    this.checkClock(wall, countFrom === undefined ? mono : Math.max(mono, countFrom))

    for (const entry of this.order) {
      const config = entry.config

      if (config.type !== 'formula') {
        this.rollPeriod(entry, wall, mono, changed)
        this.repairSince(entry, wall)
        if (config.resets === 'path' && changed.has(config.resetPath)) {
          this.followReference(entry, toNumber(changed.get(config.resetPath)), wall, mono, changed)
        }
      }

      if (ticking) {
        if (config.type === 'integration') this.extendHeld(entry, wall, mono, changed)
        this.notifyStale(entry, mono, changed)
      }

      if (config.type === 'formula') {
        if (config.inputs.some((input) => changed.has(input.path))) {
          this.formulaInput(entry, changed, wall, mono)
        }
      } else if (changed.has(config.input)) {
        const value = toNumber(changed.get(config.input))
        if (config.type === 'counter') {
          this.counterInput(entry, value, wall, mono, changed)
        } else {
          this.integrationInput(entry, value, wall, mono, countFrom, changed)
        }
      }
    }
  }

  /**
   * Takes in one value. `path` is a path from the server.
   *
   * `countFrom` is given only for a value that was already known when the
   * plugin started. Such a value carries its true age in `mono`, so that
   * the stale timeout judges it correctly, while `countFrom` marks the
   * moment the plugin started: an integration must not add up the time
   * before that, during which nothing was listening.
   */
  input (path, rawValue, wall, mono, countFrom) {
    this.inputs([{ path, value: rawValue }], wall, mono, countFrom)
  }

  /**
   * Takes in several values that arrived together, as the values of one
   * Signal K update do. They are applied as one step: a formula over two of
   * them is calculated once, from both new values, and never from one new
   * and one old.
   */
  inputs (values, wall, mono, countFrom) {
    const changed = new Map()
    for (const item of values) {
      if (item && typeof item.path === 'string' && this.external.has(item.path)) changed.set(item.path, item.value)
    }
    if (changed.size > 0) this.pass(changed, wall, mono, countFrom, false)
  }

  /** Records a freshly calculated value and marks it for dependent entries. */
  setValue (entry, value, wall, mono, changed) {
    entry.value = value
    entry.updatedWall = wall
    entry.inputMono = mono
    entry.staleNotified = false
    changed.set(entry.config.output, value)
  }

  /**
   * Withdraws an entry's value and tells dependent entries, which treat it
   * like a null from a sensor: a formula waits, and an integration does not
   * join the values on either side.
   */
  dropValue (entry, changed) {
    if (entry.value === null) return
    entry.value = null
    changed.set(entry.config.output, null)
  }

  // ------------------------------------------------------ periods, resets

  /**
   * Starts a new period for an entry when a boundary has been passed.
   *
   * Only the total is cleared. A counter keeps the last input value it saw,
   * which is the "value at the boundary": whatever the input has gained by
   * the time its next value arrives is credited to the new period.
   */
  rollPeriod (entry, wall, mono, changed) {
    const config = entry.config
    if (!PERIODS.includes(config.resets) || this.clockSuspect) return

    const start = this.currentPeriodStart(config.resets, wall)
    if (entry.periodStart === null) {
      entry.periodStart = start
      this.dirty = true
    } else if (start < entry.periodStart) {
      // The saved period start lies in the future, which can only come from
      // a clock that was ahead when it was saved. The total is kept and the
      // start is pulled back, so the next real boundary is seen normally.
      entry.periodStart = start
      this.dirty = true
    } else if (start > entry.periodStart) {
      entry.periodStart = start
      this.zero(entry, start, mono, changed)
      // A boundary first noticed on the very first check after a restart
      // passed while nothing was listening.
      if (entry.restored && !entry.checkedSinceStart) {
        entry.note = config.type === 'counter'
          ? 'A period began while the plugin was not running; change since the last value seen before the stop is counted in this period.'
          : 'A period began while the plugin was not running; nothing was added for the time it was stopped.'
      }
    }
    entry.checkedSinceStart = true
  }

  /**
   * Clears an entry's total. `since` is when the new total starts counting.
   */
  zero (entry, since, mono, changed) {
    entry.total = 0
    entry.note = ''
    this.dirty = true
    if (!entry.started) {
      // Nothing has been counted yet; "counting since" is set when the
      // first value arrives.
      entry.since = null
      return
    }
    // A time read from an unset clock would be nonsense; repairSince()
    // fills it in once the clock can be trusted.
    entry.since = this.clockSuspect ? null : since
    entry.value = 0
    // Dependent entries hear about the zero only when this entry is itself
    // publishing it: not before its first input since start-up, and not
    // while it has stopped publishing because that input is stale.
    if (entry.inputMono === null) return
    if (entry.config.onStale === 'stop' && this.isStale(entry, mono)) return
    changed.set(entry.config.output, 0)
  }

  /**
   * Keeps "counting since" believable: it is filled in when it could not be
   * known earlier, and pulled back when it lies in the future, which only a
   * clock that used to be ahead can cause. A start in the future would
   * otherwise stop an integration from adding anything until that time.
   */
  repairSince (entry, wall) {
    if (this.clockSuspect || !entry.started) return
    if (entry.since === null || entry.since > wall) {
      entry.since = wall
      this.dirty = true
    }
  }

  /**
   * Resets an entry when the path it follows falls. A daily total kept by
   * another device drops back to zero when that device starts a new day,
   * and the entry starts its own new day at the same moment.
   */
  followReference (entry, value, wall, mono, changed) {
    if (value === null) return
    if (entry.referenceLast !== null && value < entry.referenceLast) {
      this.zero(entry, wall, mono, changed)
    }
    if (entry.referenceLast !== value) {
      entry.referenceLast = value
      this.dirty = true
    }
  }

  /** Marks the moment an entry started counting for the first time. */
  begin (entry, wall) {
    entry.started = true
    if (entry.since === null && !this.clockSuspect) entry.since = wall
    this.dirty = true
  }

  /**
   * Adds to an entry's total. A total that stops being a finite number
   * (possible only with absurd inputs) is cleared instead of published.
   */
  add (entry, amount) {
    entry.total += amount
    if (!Number.isFinite(entry.total)) {
      entry.total = 0
      entry.note = 'The total was no longer a finite number and was cleared.'
    }
    this.dirty = true
  }

  // --------------------------------------------------------------- formulas

  formulaInput (entry, changed, wall, mono) {
    const config = entry.config
    // One path may feed several short names; each gets the value.
    for (const input of config.inputs) {
      if (!changed.has(input.path)) continue
      const value = toNumber(changed.get(input.path))
      if (value === null) {
        entry.variables.delete(input.name)
      } else {
        entry.variables.set(input.name, { value, mono })
      }
    }

    const values = {}
    for (const input of config.inputs) {
      const variable = entry.variables.get(input.name)
      if (!variable) {
        // An input has no value: nothing can be calculated, and the last
        // result must not be passed off as current.
        entry.note = ''
        this.dropValue(entry, changed)
        return
      }
      // With a stale input the result is left exactly as it was. Whether
      // it is still published is decided by the entry's stale setting;
      // either way it is never recalculated from a reading that old.
      if (config.staleMs > 0 && mono - variable.mono > config.staleMs) return
      values[input.name] = variable.value
    }

    const result = config.compiled.evaluate(values)
    if (result === null) {
      entry.note = 'The expression gave no finite number for the current inputs.'
      this.dropValue(entry, changed)
      return
    }
    entry.note = ''
    this.setValue(entry, result, wall, mono, changed)
  }

  // --------------------------------------------------------------- counters

  counterInput (entry, value, wall, mono, changed) {
    if (value === null) return
    const config = entry.config

    if (entry.last === null) {
      // The very first value only sets the starting point. Nothing is known
      // about what the input did before the plugin first saw it.
      entry.last = value
      this.begin(entry, wall)
    } else {
      const change = value - entry.last
      if (change !== 0 && Math.abs(change) >= config.minStep) {
        const wanted = config.direction === 'net' || (config.direction === 'increase' ? change > 0 : change < 0)
        if (wanted) {
          this.add(entry, config.direction === 'decrease' ? -change : change)
          entry.last = value
        } else if (config.reversal === 'continue') {
          // The input moved the other way (a counter restarted from zero, a
          // tank was refilled). Counting carries on from the new level.
          entry.last = value
          this.dirty = true
        }
        // With reversal 'wait' the old level is kept, so nothing is counted
        // until the input has passed it again.
      }
      if (!entry.started) this.begin(entry, wall)
    }
    this.setValue(entry, entry.total, wall, mono, changed)
  }

  // ----------------------------------------------------------- integrations

  integrationInput (entry, value, wall, mono, countFrom, changed) {
    const config = entry.config
    if (value === null) {
      // A null means the source has no reading. The stretch on either side
      // of it cannot be summed, so the chain of values is broken here.
      entry.previous = null
      return
    }
    if (!entry.started) this.begin(entry, wall)

    this.accumulate(entry, value, wall, mono)

    if (countFrom === undefined) {
      entry.previous = { value, mono }
    } else if (config.staleMs > 0 && countFrom - mono > config.staleMs) {
      // A value known from before start-up that is already older than the
      // stale timeout is no basis for adding anything up.
      entry.previous = null
    } else {
      // Time is counted from the start-up, not from the value's own,
      // earlier, time: nothing was listening before.
      entry.previous = { value, mono: Math.max(mono, countFrom) }
    }
    this.setValue(entry, entry.total, wall, mono, changed)
  }

  /**
   * Adds the stretch of time from the previous value up to `mono` to an
   * integration's total.
   *
   * `value` is the new reading that ends the stretch, or undefined when the
   * stretch is being closed by the clock alone (see extendHeld).
   *
   * How the stretch is valued depends on what is known about the input:
   *
   * 1. A regularly sampled input (stale timeout above zero) is joined to
   *    its previous reading by a straight line: the trapezoid rule.
   * 2. An input that is sent only when it changes (stale timeout of zero)
   *    is a step: it held its previous reading for the whole stretch.
   * 3. A stretch longer than the stale timeout is a gap. It is left out, or
   *    with "bridge" valued as a step.
   */
  accumulate (entry, value, wall, mono) {
    const config = entry.config
    const previous = entry.previous
    if (!previous || mono <= previous.mono) return

    const elapsedMs = mono - previous.mono
    const held = config.staleMs === 0
    const withinTimeout = held || elapsedMs <= config.staleMs
    if (!withinTimeout && config.gap !== 'bridge') return

    // When the total was cleared part-way through this stretch (a period
    // boundary, a reset), only the part after the clearing belongs to the
    // new total.
    let share = 1
    if (!this.clockSuspect && entry.since !== null && entry.since > wall - elapsedMs) {
      share = Math.min(1, Math.max(0, (wall - entry.since) / elapsedMs))
    }
    const seconds = (elapsedMs * share) / 1000

    if (config.mode === 'time') {
      // The state between two readings is the state the earlier one gave.
      if (previous.value > config.threshold) this.add(entry, seconds)
    } else if (held || !withinTimeout || value === undefined) {
      this.add(entry, previous.value * seconds)
    } else {
      // For a shortened stretch the starting height is read off the
      // straight line between the two readings.
      const startValue = previous.value + (value - previous.value) * (1 - share)
      this.add(entry, ((startValue + value) / 2) * seconds)
    }
  }

  /**
   * Brings a held input's total up to the present.
   *
   * An input that is sent only when it changes may say nothing for hours:
   * a switch that stays on, a pump that keeps running. Its total must keep
   * growing all the same, so once a second the time since the last reading
   * is added at the last reading's value.
   */
  extendHeld (entry, wall, mono, changed) {
    const previous = entry.previous
    if (entry.config.staleMs !== 0 || !previous || mono <= previous.mono) return
    const before = entry.total
    this.accumulate(entry, undefined, wall, mono)
    entry.previous = { value: previous.value, mono }
    if (entry.total !== before) this.setValue(entry, entry.total, wall, mono, changed)
  }

  // ------------------------------------------------------------------ state

  /**
   * Whether an entry's inputs are too old to trust.
   */
  isStale (entry, mono) {
    const staleMs = entry.config.staleMs
    if (staleMs === 0) return false
    if (entry.config.type === 'formula') {
      for (const variable of entry.variables.values()) {
        if (mono - variable.mono > staleMs) return true
      }
      return false
    }
    return entry.inputMono !== null && mono - entry.inputMono > staleMs
  }

  /**
   * Tells dependent entries, once, that this entry stopped publishing
   * because its input went stale. Without this an integration fed by a
   * formula would carry on adding up the formula's last result for as long
   * as the formula's own input stayed away.
   */
  notifyStale (entry, mono, changed) {
    if (entry.staleNotified || entry.value === null || entry.config.onStale !== 'stop') return
    if (!this.isStale(entry, mono)) return
    entry.staleNotified = true
    changed.set(entry.config.output, null)
  }

  /**
   * Describes an entry's condition: ok, waiting (nothing to show yet),
   * stale, error or disabled.
   */
  status (entry, mono) {
    const config = entry.config
    if (config.error) return { state: 'error', message: config.error }
    if (!config.enabled) return { state: 'disabled', message: 'Disabled in the plugin configuration.' }

    if (entry.inputMono === null || entry.value === null) {
      if (config.type !== 'formula') {
        return { state: 'waiting', message: `Waiting for a value on ${config.input}.` }
      }
      const missing = config.inputs.filter((i) => !entry.variables.has(i.name)).map((i) => i.path)
      if (missing.length > 0) return { state: 'waiting', message: `Waiting for a value on ${missing.join(', ')}.` }
      if (entry.note) return { state: 'waiting', message: entry.note }
      const old = config.inputs.filter((i) => config.staleMs > 0 && mono - entry.variables.get(i.name).mono > config.staleMs).map((i) => i.path)
      return { state: 'waiting', message: `Waiting for a fresh value on ${old.join(', ') || 'its inputs'}.` }
    }

    if (this.isStale(entry, mono)) {
      const seconds = config.staleMs / 1000
      return {
        state: 'stale',
        message: config.onStale === 'hold'
          ? `No fresh input for more than ${seconds} s; still publishing the last result.`
          : `No fresh input for more than ${seconds} s; publishing is paused.`
      }
    }
    return { state: 'ok', message: entry.note }
  }

  /**
   * Runs the once-a-second housekeeping and returns the values to publish.
   *
   * @returns {Array<{path: string, value: number}>}
   */
  tick (wall, mono) {
    this.pass(new Map(), wall, mono, undefined, true)
    const publications = []

    for (const entry of this.entries) {
      if (!entry.active || entry.value === null || !Number.isFinite(entry.value)) continue

      const { state } = this.status(entry, mono)
      const publish = state === 'ok' || (state === 'stale' && entry.config.onStale === 'hold')
      if (!publish) {
        // Forgetting what was sent makes the value go out again at once
        // when the input returns, instead of waiting for it to change.
        entry.publishedMono = null
        continue
      }

      const changed = entry.value !== entry.publishedValue || entry.publishedMono === null
      const repeatDue = this.settings.repeatMs > 0 && entry.publishedMono !== null && mono - entry.publishedMono >= this.settings.repeatMs
      if (changed || repeatDue) {
        // Twelve significant digits is far finer than any sensor, and it
        // keeps binary rounding noise (286.29720000000003) off the wire.
        publications.push({ path: entry.config.output, value: Number(entry.value.toPrecision(12)) })
        entry.publishedValue = entry.value
        entry.publishedMono = mono
      }
    }
    return publications
  }

  /**
   * Clears one entry's total on request. Returns false when the output path
   * does not belong to a running counter or integration.
   */
  reset (output, wall, mono) {
    // Only running entries are considered: a disabled entry may carry the
    // same output path, and clearing that one would change nothing.
    const entry = this.order.find((e) => e.config.output === output && e.config.type !== 'formula')
    if (!entry) return false
    const changed = new Map()
    this.checkClock(wall, mono)
    this.zero(entry, wall, mono, changed)
    this.pass(changed, wall, mono, undefined, false)
    return true
  }

  /** Counts of entries by condition, for the plugin status line. */
  summary (mono) {
    const counts = { ok: 0, waiting: 0, stale: 0, error: 0, disabled: 0 }
    for (const entry of this.entries) counts[this.status(entry, mono).state]++
    return counts
  }

  /** Everything the status page shows, one object per entry. */
  snapshot (wall, mono) {
    return this.entries.map((entry) => {
      const config = entry.config
      const { state, message } = this.status(entry, mono)
      const item = {
        key: entry.key,
        id: config.output,
        name: config.name,
        type: config.type,
        output: config.output,
        unit: config.unit,
        inputs: inputPaths(config),
        value: state === 'ok' || state === 'stale' ? entry.value : null,
        state,
        message,
        updated: entry.updatedWall === null ? null : new Date(entry.updatedWall).toISOString(),
        canReset: entry.active && config.type !== 'formula'
      }
      if (config.type === 'formula') {
        item.expression = config.expression
      } else {
        item.resets = config.resets
        item.resetPath = config.resets === 'path' ? config.resetPath : null
        item.since = entry.since === null ? null : new Date(entry.since).toISOString()
      }
      return item
    })
  }

  /** The state to save: only what a restart cannot rebuild. */
  serialize (wall) {
    const entries = {}
    // Running entries are written first. An entry that is switched off, or
    // that fails a configuration check, keeps its saved total as long as it
    // still measures the same thing, but it never overwrites the total of a
    // running entry that uses the same output path.
    const ordered = [...this.entries.filter((e) => e.active), ...this.entries.filter((e) => !e.active)]
    for (const entry of ordered) {
      const config = entry.config
      if (config.type === 'formula' || !entry.started || !config.output || entries[config.output]) continue
      entries[config.output] = {
        signature: signature(config),
        resets: config.resets,
        resetPath: config.resets === 'path' ? config.resetPath : null,
        total: entry.total,
        since: entry.since,
        periodStart: entry.periodStart,
        referenceLast: entry.referenceLast
      }
      if (config.type === 'counter') entries[config.output].last = entry.last
    }
    // The clock check compares against this, so a wrong clock must not be
    // written into it.
    if (!this.clockSuspect) this.savedAt = wall
    this.dirty = false
    return { savedAt: this.savedAt, entries }
  }
}

module.exports = { Engine, signature, toNumber }
