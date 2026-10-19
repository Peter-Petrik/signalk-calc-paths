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

const { CYCLE_FIGURES, dependencyPaths, inputPaths } = require('./config')
const { CycleTracker, STEP_MS } = require('./cycles')
const { PERIODS, keyStart, nextPeriodInfo, periodInfo } = require('./periods')

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

// The furthest two time zones can be apart is 26 hours (UTC-12 to UTC+14).
// A change of zone can therefore put the calendar back by at most that
// much; an hour of slack is added. See rollPeriod().
const CALENDAR_STEP_BACK_MS = 27 * 60 * 60 * 1000

// How long a saved total whose output no entry uses is kept, in case an
// entry with that output comes back: after the entries file was replaced,
// or an export from before is imported. See Engine#serialize().
const ORPHAN_KEEP_MS = 30 * 24 * 60 * 60 * 1000

// Shown on the status page while a period is carried over a step back of
// the calendar.
const HELD_OVER_NOTE = 'The date has stepped back since this period began, as it does when the time zone changes going west. This period carries on until the next one begins.'

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
  if (config.type === 'cycles') {
    // What decides where stretches begin and end. The figure published,
    // the window, the longest stretch and the cycles needed only choose
    // what is reported from the stretches, and leave them valid.
    // The smoothing counts as the number of steps it averages, which is
    // what the tracker uses.
    const inputs = config.inputs.map((i) => [i.path, i.kind, i.threshold, i.direction, i.swing])
    const steps = Math.max(1, Math.round(config.smoothingMs / STEP_MS))
    return `cycles|${JSON.stringify(inputs)}|${config.combine}|${steps}|${config.shortestMs}|${config.staleMs}`
  }
  if (config.type === 'integration') {
    // The threshold only shapes the total in time mode.
    return `integration|${config.input}|${config.mode}|${config.mode === 'time' ? config.threshold : ''}`
  }
  return 'formula'
}

/** Whether an entry keeps a total that periods and resets apply to. */
function keepsTotal (config) {
  return config.type === 'counter' || config.type === 'integration'
}

// The causes a total can be cleared for; see Engine#zero().
const RESET_CAUSES = ['period', 'zone', 'path', 'request']

/**
 * Reads a saved reset record, keeping only what has the expected form. The
 * record is shown to people and decides nothing, so a damaged one is simply
 * dropped.
 */
function readResetRecord (raw) {
  if (!raw || typeof raw !== 'object' || !Number.isFinite(raw.at) || !RESET_CAUSES.includes(raw.cause)) return null
  const record = { at: raw.at, cause: raw.cause }
  if (raw.cause === 'period' && PERIODS.includes(raw.period)) record.period = raw.period
  if (raw.cause === 'zone' && typeof raw.zone === 'string') record.zone = raw.zone
  if (raw.cause === 'path') {
    if (typeof raw.path === 'string') record.path = raw.path
    if (Number.isFinite(raw.from)) record.from = raw.from
    if (Number.isFinite(raw.to)) record.to = raw.to
    if (typeof raw.source === 'string') record.source = raw.source
  }
  return record
}

/** Reads a saved record of a corrected start time; see repairSince(). */
function readSinceRecord (raw) {
  if (!raw || typeof raw !== 'object' || !Number.isFinite(raw.at)) return null
  return { at: raw.at, previous: Number.isFinite(raw.previous) ? raw.previous : null }
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

/**
 * What an entry calculates, for deciding whether an edit changed it. The
 * name, the unit and the group are left out: they change what people read,
 * not what is counted, so an entry that differs only in them keeps running
 * untouched when the entries are saved.
 */
function fingerprint (config) {
  const { name, label, unit, group, compiled, ...rest } = config
  return JSON.stringify(rest)
}

/**
 * The changed paths as an entry that kept running sees them during a
 * priming pass; see Engine#prime(). Hidden paths carry values handed to
 * newly started entries only: an entry that was running before has already
 * seen them, and taking them in a second time would count an extra reading.
 * A path stops being hidden as soon as an entry writes a new value to it.
 * One view is shared by all entries of a pass, so a write is seen by every
 * entry after the writer.
 */
class PrimedView {
  constructor (map, hidden) {
    this.map = map
    // The paths hidden from the entries that kept running; null hides all.
    this.hidden = hidden
    // Paths an entry wrote during this pass, which every entry may see.
    this.written = new Set()
  }

  hides (path) {
    return this.hidden === null ? !this.written.has(path) : this.hidden.has(path) && !this.written.has(path)
  }

  has (path) {
    return !this.hides(path) && this.map.has(path)
  }

  get (path) {
    return this.hides(path) ? undefined : this.map.get(path)
  }

  set (path, value) {
    this.written.add(path)
    this.map.set(path, value)
    return this
  }
}

class Engine {
  /**
   * @param {object} normalized - Result of normalizeConfig().
   * @param {object|null} saved - Previously saved state, or null.
   * @param {string} [timeZone] - The zone period boundaries start out in.
   *   Defaults to the zone from the settings. It can change while the
   *   engine runs; see setTimeZone().
   */
  constructor (normalized, saved, timeZone, previous) {
    this.settings = normalized.settings
    this.timeZone = timeZone || normalized.settings.timeZone
    this.savedAt = saved && Number.isFinite(saved.savedAt) ? saved.savedAt : null
    this.clockSuspect = false
    this.behindSinceMono = null
    this.dirty = false
    this.periodCache = new Map()
    // The source each input path's latest value came from, when the caller
    // says. Kept only to name it in a reset record.
    this.sources = new Map()
    // The latest value of each input path, with its monotonic time, for
    // handing to an entry that starts while the others run; see prime().
    this.lastExternal = new Map()
    // Entries created since the last prime(): new, or changed by an edit.
    this.fresh = new Set()
    // The output paths on which a number of this plugin's is on the server
    // at the moment. The server keeps the last value of a path until it is
    // replaced, so an entry that stops sending would leave its last result
    // there, looking current; tick() sends null on such a path once.
    this.onServer = new Set()

    // An engine that replaces a running one, after the entries were edited,
    // takes over each entry that still calculates the same thing exactly as
    // it is, mid-stretch, with nothing restarted or lost. Every other entry
    // starts afresh from `saved`, which the caller takes from the engine
    // being replaced, so a changed entry keeps its total where it still
    // measures the same thing; see signature().
    const running = new Map()
    if (previous) {
      for (const entry of previous.entries) running.set(entry.config.id, entry)
      this.savedAt = previous.savedAt
      this.clockSuspect = previous.clockSuspect
      this.behindSinceMono = previous.behindSinceMono
      // Only paths still being read keep their latest value. A path that
      // was read before, dropped, and is read again later would otherwise
      // hand a new entry a value from when it was last read.
      for (const map of [previous.sources, previous.lastExternal]) {
        for (const path of [...map.keys()]) if (!previous.external.has(path)) map.delete(path)
      }
      this.sources = previous.sources
      this.lastExternal = previous.lastExternal
      // What the replaced engine put on the server is still there.
      this.onServer = previous.onServer
    }
    this.entries = normalized.entries.map((config, index) => {
      const old = running.get(config.id)
      if (old && fingerprint(old.config) === fingerprint(config)) {
        running.delete(config.id)
        old.config = config
        old.key = config.id
        return old
      }
      const entry = this.createEntry(config, index, saved)
      if (previous) entry.edited = true
      if (entry.active) this.fresh.add(entry)
      return entry
    })
    const active = this.entries.filter((entry) => entry.active)
    this.order = dependencyOrder(active)
    this.byOutput = new Map(active.map((entry) => [entry.config.output, entry]))

    // Saved totals no entry has taken up. At a start they are those of the
    // state file; after an edit, those the replaced engine still kept. One
    // is taken up only by an entry that restored its total from it: an
    // entry with the same output that measures something else, or is not
    // finished yet, leaves it in place. A total of an entry deleted in the
    // editor is not among them: deleting the entry, after the editor has
    // warned, deletes its total.
    const claimed = new Set(this.entries.filter((entry) => entry.restored && entry.config.output).map((entry) => entry.config.output))
    const found = previous ? previous.orphans : this.unclaimed(saved)
    this.orphans = new Map([...found].filter(([output]) => !claimed.has(output)))

    // The paths that must come from the server: everything an active entry
    // reads that no active entry produces. Values offered for any other
    // path, including the outputs of entries, are not taken in.
    const read = new Set(active.flatMap((entry) => dependencyPaths(entry.config)))
    const outputs = new Set(active.map((entry) => entry.config.output))
    this.externalPaths = [...read].filter((path) => !outputs.has(path)).sort()
    this.external = new Set(this.externalPaths)
    if (previous) this.dirty = true
  }

  /** The saved totals of a state file, each marked with when it was last in use. */
  unclaimed (saved) {
    const found = new Map()
    if (!saved || !saved.entries || typeof saved.entries !== 'object') return found
    for (const [output, record] of Object.entries(saved.entries)) {
      if (!record || typeof record !== 'object') continue
      const since = Number.isFinite(record.orphanedAt) ? record.orphanedAt : (Number.isFinite(saved.savedAt) ? saved.savedAt : null)
      found.set(output, { ...record, orphanedAt: since })
    }
    return found
  }

  createEntry (config, index, saved) {
    const entry = {
      config,
      // Unique even when two entries share an output path or have none.
      key: config.id,
      // Set on an entry started by an edit of the entries, not by a start
      // of the plugin; only the wording of the status depends on it.
      edited: false,
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
      // Whether null was sent on the output path because this entry stopped
      // sending; cleared by its next published value.
      nullSent: false,
      // Set once the first check after start-up has run; used to tell a
      // boundary that passed during downtime from one seen live.
      checkedSinceStart: false
    }

    if (config.type === 'formula') {
      entry.variables = new Map()
      // Inputs whose last value was null or not a number, by short name.
      entry.unreadable = new Set()
      // The inputs counted as their value when stale at the last
      // evaluation, and a key for telling when that set changes.
      entry.substituted = []
      entry.substitutedKey = null
    } else if (config.type === 'cycles') {
      entry.tracker = new CycleTracker(config)
      entry.lastReset = null
      // The monotonic time of the latest input value; see isStale().
      entry.sampleMono = null
      const old = saved && saved.entries && config.output ? saved.entries[config.output] : null
      if (old && old.signature === signature(config)) {
        entry.restored = true
        entry.tracker.restore(old.stretches)
        entry.lastReset = readResetRecord(old.lastReset)
      }
    } else {
      entry.total = 0
      entry.started = false
      entry.since = null
      entry.periodStart = null
      // The calendar date the current period began on, and the time zone
      // that date was read in; see rollPeriod().
      entry.periodKey = null
      entry.periodZone = null
      // Set when the time zone changes, until the entry's period has been
      // checked against the new zone.
      entry.zoneMoved = false
      // True while the entry's period is dated later than today because the
      // calendar stepped back; the status page says so for as long as it
      // lasts.
      entry.heldOver = false
      entry.referenceLast = null
      // Why and when the total was last cleared, and when the start time
      // was last corrected without clearing it. Both are kept for people:
      // nothing is decided from them.
      entry.lastReset = null
      entry.sinceCorrected = null
      // True when the value on show is the total saved before a restart and
      // no input has arrived since. See status().
      entry.restoredValue = false
      // True once such a total has been cleared while still waiting for
      // its input; only the wording on the status page depends on it.
      entry.restoredCleared = false
      // Set until dependent entries have been told about a restored total.
      entry.announceRestored = false
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
          // Absent in state written by version 0.1.0; rollPeriod() works it
          // out from the saved start.
          entry.periodKey = typeof old.periodKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(old.periodKey) ? old.periodKey : null
          entry.periodZone = entry.periodKey !== null && typeof old.periodZone === 'string' && old.periodZone ? old.periodZone : null
          // The level last seen on the followed path is only comparable
          // with later values of that same path.
          if (config.resets === 'path' && old.resetPath === config.resetPath) {
            entry.referenceLast = Number.isFinite(old.referenceLast) ? old.referenceLast : null
          }
          entry.lastReset = readResetRecord(old.lastReset)
          entry.sinceCorrected = readSinceRecord(old.sinceCorrected)
          // The saved total is this entry's value from the first moment,
          // before any input has arrived. Without this a restart while the
          // input is silent (an engine that is switched off) would leave
          // the entry with nothing to show or publish until the input
          // spoke again, whatever its stale setting says.
          if (entry.active) {
            entry.value = entry.total
            entry.restoredValue = true
            entry.announceRestored = true
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

  /** The settings a period boundary is worked out from. */
  periodOptions () {
    return {
      timeZone: this.timeZone,
      dayStartMinutes: this.settings.dayStartMinutes,
      weekStart: this.settings.weekStart
    }
  }

  /**
   * Describes the current period of one kind: when it began and on which
   * calendar date, and the same for the period after it. Working out a
   * boundary needs several time zone conversions, and every entry asks on
   * every pass, so the answer is cached until the next boundary is reached.
   *
   * @returns {{start: number, key: string, next: number, nextKey: string}}
   */
  currentPeriod (period, wall) {
    let cached = this.periodCache.get(period)
    if (!cached || wall < cached.start || wall >= cached.next) {
      const options = this.periodOptions()
      const { start, key } = periodInfo(wall, period, options)
      const following = nextPeriodInfo(start, period, options)
      cached = { start, key, next: following.start, nextKey: following.key }
      this.periodCache.set(period, cached)
    }
    return cached
  }

  /**
   * Changes the time zone period boundaries are worked out in, as happens
   * when the ship's time zone is followed and the ship changes zone.
   *
   * Nothing is reset here. Each period entry is checked against the new
   * zone on the next pass, by the rule in rollPeriod(). Returns true when
   * the zone was in fact different.
   */
  setTimeZone (timeZone) {
    if (!timeZone || timeZone === this.timeZone) return false
    this.timeZone = timeZone
    this.periodCache.clear()
    for (const entry of this.entries) {
      if (PERIODS.includes(entry.config.resets)) entry.zoneMoved = true
    }
    this.dirty = true
    return true
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
  pass (changed, wall, mono, countFrom, ticking, primed) {
    // A value known from before start-up carries an aged monotonic time.
    // The clock check must run on the present moment, or an old value
    // would count as "the clock has been behind for an hour" at once.
    this.checkClock(wall, countFrom === undefined ? mono : Math.max(mono, countFrom))
    // In a priming pass the entries that kept running see only what they
    // have not seen yet; see prime(). `primed` null hides everything.
    const view = primed !== undefined ? new PrimedView(changed, primed) : null

    for (const entry of this.order) {
      const seen = view && !this.fresh.has(entry) ? view : changed
      this.step(entry, seen, wall, mono, countFrom, ticking)
    }
  }

  /** One entry's share of a pass; see pass(). */
  step (entry, changed, wall, mono, countFrom, ticking) {
    const config = entry.config

    if (config.type === 'cycles') {
      this.cyclesStep(entry, changed, wall, mono, ticking)
      return
    }

    if (keepsTotal(config)) {
      if (entry.announceRestored && ticking) {
        // Entries that read this one hear its saved total once, when this
        // entry is publishing it. This waits for the once-a-second pass,
        // which carries the present time: a pass that takes in a value
        // known from before start-up carries that value's age, and would
        // hand the total on as if it were that old.
        entry.announceRestored = false
        if (this.publishing(entry, mono)) changed.set(config.output, entry.value)
      }
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
      const fed = config.inputs.some((input) => changed.has(input.path))
      if (fed) this.formulaTake(entry, changed, mono)
      // An input that goes stale sends nothing, so the once-a-second pass
      // checks whether an input began or ceased to be counted as its value
      // when stale, and works the result out again if so.
      if (fed || (ticking && config.substitutes && this.substitutionKey(entry, mono) !== entry.substitutedKey)) {
        this.formulaEvaluate(entry, changed, wall, mono, countFrom)
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

  /**
   * Hands the entries started by an edit what the entries that kept
   * running already know: the latest value of each input path, with its
   * real age, and the current value of each entry they read from. Without
   * this a new entry on a path that is sent rarely would wait until the
   * path spoke again, possibly for hours.
   *
   * It runs in two steps. The input values go first, each with its real
   * age, to the new entries only: the entries that kept running have
   * taken them in already. Then, at the present moment, the new entries
   * hear the current results of the entries that kept running, and every
   * entry hears the first results of the new ones, as it would hear any
   * new result. A running entry that reads a restarted one therefore adds
   * the stretch up to now, and nothing is lost or counted twice.
   */
  prime (wall, mono) {
    if (this.fresh.size === 0) return
    const fresh = [...this.fresh]
    const outside = new Map()
    const inside = new Map()
    for (const entry of fresh) {
      for (const path of dependencyPaths(entry.config)) {
        const producer = this.byOutput.get(path)
        if (producer) {
          if (!this.fresh.has(producer) && producer.value !== null && this.publishing(producer, mono)) inside.set(path, producer.value)
        } else if (this.external.has(path) && this.lastExternal.has(path)) {
          const last = this.lastExternal.get(path)
          if (!outside.has(last.mono)) outside.set(last.mono, new Map())
          outside.get(last.mono).set(path, last.value)
        }
      }
    }
    // Values of one arrival go in together, oldest arrival first; time is
    // counted from now, as for a value the server held at start-up. The
    // entries that kept running see none of it.
    for (const at of [...outside.keys()].sort((a, b) => a - b)) {
      this.pass(outside.get(at), wall, at, mono, false, null)
    }
    // The results of the new entries, as they stand after the step above.
    const results = new Map()
    for (const entry of fresh) {
      if (entry.value !== null && this.publishing(entry, mono)) results.set(entry.config.output, entry.value)
    }
    const changed = new Map([...inside, ...results])
    if (changed.size > 0) this.pass(changed, wall, mono, undefined, false, new Set(inside.keys()))
    this.fresh.clear()
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
      if (!item || typeof item.path !== 'string' || !this.external.has(item.path)) continue
      changed.set(item.path, item.value)
      this.lastExternal.set(item.path, { value: item.value, mono })
      if (typeof item.source === 'string' && item.source) this.sources.set(item.path, item.source)
    }
    if (changed.size > 0) this.pass(changed, wall, mono, countFrom, false)
  }

  /** Records a freshly calculated value and marks it for dependent entries. */
  setValue (entry, value, wall, mono, changed) {
    // A value of its own makes the saved total old news.
    entry.announceRestored = false
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
   *
   * A period is known by the calendar date it began on (its key), and a new
   * period starts when the current date's key is later than the entry's.
   * With one unchanging time zone this is the same as comparing start
   * instants. It differs when the zone changes, and it is what makes a
   * change of zone behave like a daylight saving change:
   *
   * 1. Going east, clocks jump forward. If that carries the ship past a
   *    boundary (23:30 becomes 00:30), the new date's key is later and the
   *    total is cleared at once. That day was an hour short.
   * 2. Going west, clocks jump back. If that carries the ship back over a
   *    boundary it has already passed (00:30 becomes 23:30 the day before),
   *    the key is earlier than the entry's. The total is kept, and is not
   *    cleared again when the same date begins a second time. That day is
   *    an hour long.
   *
   * So a total is never cleared twice for one date.
   */
  rollPeriod (entry, wall, mono, changed) {
    const config = entry.config
    if (!PERIODS.includes(config.resets) || this.clockSuspect) return

    const now = this.currentPeriod(config.resets, wall)
    // Whether this is the first look at the entry since a change of zone.
    const moved = entry.zoneMoved
    entry.zoneMoved = false

    if (entry.periodKey === null && entry.periodStart !== null) {
      // State written by version 0.1.0 holds the start instant only. A
      // period start is always inside its own period, so asking which
      // period the saved start falls in gives the key it would have had.
      // The question must be asked in the zone that start was worked out
      // in, which for 0.1.0 was the zone from the settings: the same
      // instant is a different date further west, and asking in the zone
      // now in use could date the period a day early and clear its total.
      const zone = this.settings.timeZone
      entry.periodKey = periodInfo(entry.periodStart, config.resets, { ...this.periodOptions(), timeZone: zone }).key
      entry.periodZone = zone
      this.dirty = true
    }
    // State with a key but no zone cannot say where the key was read. The
    // zone from the settings is the only candidate that needs no guessing.
    if (entry.periodKey !== null && entry.periodZone === null) entry.periodZone = this.settings.timeZone

    if (entry.periodKey === null) {
      entry.periodStart = now.start
      entry.periodKey = now.key
      entry.periodZone = this.timeZone
      this.dirty = true
    } else if (now.key > entry.periodKey) {
      entry.periodStart = now.start
      entry.periodKey = now.key
      entry.periodZone = this.timeZone
      if (moved) {
        // The boundary was not passed as time went by; the change of zone
        // jumped over it. What was counted between the new zone's boundary
        // and this moment went into the total that is now cleared, so the
        // new total honestly starts here and not at the boundary.
        this.zero(entry, wall, mono, changed, { at: wall, cause: 'zone', zone: this.timeZone })
        entry.note = 'The time zone changed and a new period had already begun in the new zone. This period is counted from the moment of the change.'
      } else {
        this.zero(entry, now.start, mono, changed, { at: now.start, cause: 'period', period: config.resets })
        // A boundary first noticed on the very first check after a restart
        // passed while nothing was listening.
        if (entry.restored && !entry.checkedSinceStart) {
          entry.note = config.type === 'counter'
            ? 'A period began while the plugin was not running; change since the last value seen before the stop is counted in this period.'
            : 'A period began while the plugin was not running; nothing was added for the time it was stopped.'
        }
      }
    } else if (now.key < entry.periodKey) {
      // The entry's period is dated later than today. Two things cause it.
      // One is a change of time zone that put the calendar back: the zone
      // in use is then not the zone the period was dated in, and the period
      // begins again soon in the zone now in use. Everything else is a
      // clock, or a day-start or week-start setting, that has changed.
      const begins = keyStart(entry.periodKey, this.periodOptions())
      const steppedBack = entry.periodZone !== this.timeZone && begins !== null && begins - wall <= CALENDAR_STEP_BACK_MS
      if (steppedBack) {
        // The calendar stepped back over a boundary already passed, as it
        // does when the ship's clocks go back. The entry's period begins
        // again within a day or so; it simply carries on until then. The
        // status page says so for as long as it lasts, also after a restart.
        if (!entry.heldOver) {
          entry.note = HELD_OVER_NOTE
          entry.heldOver = true
        }
      } else {
        // Otherwise the date was saved by a clock that was ahead, or under
        // a different day-start or week-start setting. The total is kept
        // and the period is pulled back to the present, so the next real
        // boundary is seen normally.
        entry.periodStart = now.start
        entry.periodKey = now.key
        entry.periodZone = this.timeZone
        this.dirty = true
      }
    } else {
      // The entry's period is the current one in the zone in use, so it is
      // from now on dated in this zone.
      if (entry.periodZone !== this.timeZone) {
        entry.periodZone = this.timeZone
        this.dirty = true
      }
      if (entry.heldOver) {
        // The calendar has caught up with the entry's period: the date it
        // stepped back from has begun again, or the zone moved forward
        // once more. There is nothing left to explain.
        entry.heldOver = false
        if (entry.note === HELD_OVER_NOTE) entry.note = ''
      }
    }
    entry.checkedSinceStart = true
  }

  /**
   * Clears an entry's total. `since` is when the new total starts counting.
   */
  zero (entry, since, mono, changed, record) {
    entry.total = 0
    entry.note = ''
    entry.heldOver = false
    if (record) entry.lastReset = record
    // The start time is about to be set afresh; an earlier correction of
    // it no longer describes anything.
    entry.sinceCorrected = null
    // A saved total on show is no longer the saved one.
    if (entry.restoredValue && entry.inputMono === null) entry.restoredCleared = true
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
    // publishing it.
    if (this.publishing(entry, mono)) changed.set(entry.config.output, 0)
  }

  /**
   * Whether an entry's value is going out at the moment: not before its
   * first input since start-up, unless it carries a saved total that it is
   * set to keep publishing, and not while it has stopped publishing because
   * its input is stale.
   */
  publishing (entry, mono) {
    const hold = entry.config.onStale === 'hold'
    // An entry with a stale timeout of zero never counts as stale, so its
    // saved total goes out whatever the stale setting says.
    if (entry.inputMono === null) return entry.restoredValue && entry.value !== null && (hold || entry.config.staleMs === 0)
    return hold || !this.isStale(entry, mono)
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
      // A start time that lay in the future is recorded, because to a
      // reader it simply moves: the total is kept and nothing else says
      // why. A start time that was merely unknown (after a change of the
      // Resets setting, or a reset while the clock could not be trusted)
      // is filled in without a record; nothing was corrected.
      if (entry.since !== null) entry.sinceCorrected = { at: wall, previous: entry.since }
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
      const path = entry.config.resetPath
      const record = { at: wall, cause: 'path', path, from: entry.referenceLast, to: value }
      if (this.sources.has(path)) record.source = this.sources.get(path)
      this.zero(entry, wall, mono, changed, record)
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

  // ----------------------------------------------------------------- cycles

  /**
   * One "Cycles" entry's share of a pass: input values go to its tracker,
   * and the figure is worked out again on each new value and once a second.
   */
  cyclesStep (entry, changed, wall, mono, ticking) {
    const config = entry.config
    let fed = false
    config.inputs.forEach((input, index) => {
      if (!changed.has(input.path)) return
      entry.tracker.input(index, toNumber(changed.get(input.path)), mono)
      fed = true
    })
    if (fed) entry.sampleMono = entry.sampleMono === null ? mono : Math.max(entry.sampleMono, mono)
    if (fed || ticking) {
      entry.tracker.advance(wall, Math.max(mono, entry.sampleMono === null ? mono : entry.sampleMono))
      this.cyclesFigure(entry, wall, mono, changed, fed)
    }
    if (ticking) this.notifyStale(entry, mono, changed)
  }

  /**
   * Works out the figure an entry publishes from its tracker. `fed` says
   * that an input value arrived: the figure is then as fresh as that value,
   * also when it has not changed, as a counter's total is.
   */
  cyclesFigure (entry, wall, mono, changed, fed) {
    const config = entry.config
    const figures = entry.tracker.figures(wall)
    entry.figures = figures
    // Every stretch recorded or trimmed is worth saving.
    const kept = entry.tracker.stretches.length
    if (kept !== entry.stretchesKept) this.dirty = true
    entry.stretchesKept = kept
    let value = figures[config.statistic]
    const hours = config.windowMs / 3600000
    if (config.statistic !== 'cycles' && figures.cycles < config.minCycles) {
      entry.note = `${figures.cycles} of the ${config.minCycles} cycles needed in the last ${hours} h have been counted.`
      this.dropValue(entry, changed)
      return
    }
    if (value === null || value === undefined) {
      const longest = Math.round(config.longestMs / 1000)
      entry.note = config.statistic === 'offMedian'
        ? `No OFF stretch of at most ${longest} s, the longest stretch, has ended in the last ${hours} h.`
        : `No ON stretch followed straight by an OFF stretch, both of at most ${longest} s, the longest stretch, has ended in the last ${hours} h.`
      this.dropValue(entry, changed)
      return
    }
    entry.note = ''
    if (CYCLE_FIGURES[config.statistic] === 's') value = value / 1000
    if (fed || value !== entry.value) this.setValue(entry, value, wall, mono, changed)
  }

  // --------------------------------------------------------------- formulas

  /** Takes in the values that arrived for a formula's inputs. */
  formulaTake (entry, changed, mono) {
    // One path may feed several short names; each gets the value.
    for (const input of entry.config.inputs) {
      if (!changed.has(input.path)) continue
      const value = toNumber(changed.get(input.path))
      if (value === null) {
        entry.variables.delete(input.name)
        entry.unreadable.add(input.name)
      } else {
        entry.variables.set(input.name, { value, mono })
        entry.unreadable.delete(input.name)
      }
    }
  }

  /**
   * Why an input with a value for when it is stale is counted as that
   * value now: 'stale' (its last value is older than the stale timeout),
   * 'none' (no value since the plugin started or the entry was changed),
   * 'invalid' (its last value was null or not a number, which is also
   * what an entry it reads sends when it stops publishing); or null when
   * it is read as it is.
   */
  substitutionReason (entry, input, mono) {
    if (input.whenStale === null) return null
    const variable = entry.variables.get(input.name)
    if (!variable) return entry.unreadable.has(input.name) ? 'invalid' : 'none'
    const staleMs = entry.config.staleMs
    if (staleMs > 0 && mono - variable.mono > staleMs) return 'stale'
    return null
  }

  /** The inputs counted as their value when stale now, with their reasons. */
  substitutionKey (entry, mono) {
    return entry.config.inputs.map((input) => this.substitutionReason(entry, input, mono) || '').join('|')
  }

  /**
   * Works a formula out from its inputs' latest values. An input with a
   * value for when it is stale is counted as that value while it is stale,
   * has no value or no number; an entry whose inputs all have one always
   * publishes. Only an input without one makes the entry wait or go stale.
   *
   * Whether an input is counted as its value when stale is judged at the
   * present moment, also for a value the server held at start-up, which
   * arrives with its own age (`countFrom`): such a value already older
   * than the stale timeout is replaced at once rather than published.
   */
  formulaEvaluate (entry, changed, wall, mono, countFrom) {
    const config = entry.config
    const now = countFrom === undefined ? mono : Math.max(mono, countFrom)
    const values = {}
    const replaced = new Set()
    const substituted = []
    entry.substitutedKey = this.substitutionKey(entry, now)
    for (const input of config.inputs) {
      const reason = this.substitutionReason(entry, input, now)
      if (reason) {
        values[input.name] = input.whenStale
        replaced.add(input.name)
        substituted.push({ name: input.name, path: input.path, value: input.whenStale, reason })
      }
    }
    for (const input of config.inputs) {
      if (replaced.has(input.name)) continue
      const variable = entry.variables.get(input.name)
      if (!variable) {
        // An input has no value: nothing can be calculated, and the last
        // result must not be passed off as current.
        entry.note = ''
        entry.substituted = substituted
        this.dropValue(entry, changed)
        return
      }
      // With a stale input the result is left exactly as it was. Whether
      // it is still published is decided by the entry's stale setting;
      // either way it is never recalculated from a reading that old. The
      // inputs it was worked out with stay listed, as they still hold.
      if (config.staleMs > 0 && mono - variable.mono > config.staleMs) return
      values[input.name] = variable.value
    }
    entry.substituted = substituted

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
      // An input with a value for when it is stale never makes the entry
      // stale: it is counted as that value instead.
      for (const input of entry.config.inputs) {
        if (input.whenStale !== null) continue
        const variable = entry.variables.get(input.name)
        if (variable && mono - variable.mono > staleMs) return true
      }
      return false
    }
    // A figure over the cycles is as fresh as the latest input value.
    // Before any value has arrived it is one restored from before a start.
    if (entry.config.type === 'cycles') return entry.sampleMono === null || mono - entry.sampleMono > staleMs
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
    const status = this.condition(entry, mono)
    if (entry.nullSent && status.state !== 'ok') {
      const sent = `Null was sent on ${entry.config.output}, so that readers do not see the last result.`
      return { ...status, message: status.message ? `${status.message} ${sent}` : sent }
    }
    return status
  }

  /** The state and message of an entry, before what was sent is added. */
  condition (entry, mono) {
    const config = entry.config
    if (config.error) return { state: 'error', message: config.error }
    if (!config.enabled) return { state: 'disabled', message: 'Switched off in the editor.' }

    if (config.type === 'cycles') {
      if (entry.value === null) return { state: 'waiting', message: entry.note || 'Waiting for the first cycles.' }
      if (this.isStale(entry, mono)) {
        const since = entry.sampleMono === null ? `since ${entry.edited ? 'the entry was last changed' : 'the plugin started'}` : `for more than ${config.staleMs / 1000} s`
        return {
          state: 'stale',
          message: config.onStale === 'hold'
            ? `No input value ${since}; still publishing the last figure.`
            : `No input value ${since}; publishing is paused.`
        }
      }
      return { state: 'ok', message: entry.note }
    }

    if (keepsTotal(config) && entry.inputMono === null && entry.restoredValue && entry.value !== null) {
      // A total saved before a restart, with no input since. It is treated
      // as a stale input is: shown, and published or not as the entry's
      // stale setting says. With a stale timeout of zero an entry never
      // counts as stale, and the total is published.
      const total = entry.restoredCleared ? 'the total, cleared since' : 'the saved total'
      const note = entry.note ? ` ${entry.note}` : ''
      const since = entry.edited ? 'the entry was last changed' : 'the plugin started'
      if (config.staleMs === 0) {
        return { state: 'ok', message: `No value on ${config.input} since ${since}; publishing ${total}.${note}` }
      }
      return {
        state: 'stale',
        message: (config.onStale === 'hold'
          ? `No value on ${config.input} since ${since}; still publishing ${total}.`
          : `No value on ${config.input} since ${since}; ${total} is shown and publishing is paused.`) + note
      }
    }

    if (entry.inputMono === null || entry.value === null) {
      if (keepsTotal(config)) {
        return { state: 'waiting', message: `Waiting for a value on ${config.input}.` }
      }
      // Inputs with a value for when they are stale never hold an entry up.
      const read = config.inputs.filter((i) => i.whenStale === null)
      const missing = read.filter((i) => !entry.variables.has(i.name)).map((i) => i.path)
      if (missing.length > 0) return { state: 'waiting', message: `Waiting for a value on ${missing.join(', ')}.` }
      if (entry.note) return { state: 'waiting', message: entry.note }
      const old = read.filter((i) => config.staleMs > 0 && mono - entry.variables.get(i.name).mono > config.staleMs).map((i) => i.path)
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
   * An entry that stops sending, for whatever reason, sends null once on
   * its output path, so that a reader of the path sees that there is no
   * reading rather than the last result. Only "Keep publishing the last
   * result" goes on sending a figure, and only while an input is stale.
   * The same goes for a path no entry publishes any more after an edit: an
   * entry switched off, deleted or given another output path. Nothing is
   * sent for a path this plugin has not published since it started.
   *
   * @returns {Array<{path: string, value: number|null}>}
   */
  tick (wall, mono) {
    this.pass(new Map(), wall, mono, undefined, true)
    const publications = []
    const sending = new Set()

    for (const entry of this.entries) {
      if (!entry.active) continue
      const output = entry.config.output
      const { state } = this.status(entry, mono)
      const publish = entry.value !== null && Number.isFinite(entry.value) &&
        (state === 'ok' || (state === 'stale' && entry.config.onStale === 'hold'))
      if (!publish) {
        // Forgetting what was sent makes the value go out again at once
        // when it returns, instead of waiting for it to change.
        entry.publishedMono = null
        entry.publishedValue = null
        // Two running entries cannot share an output (the configuration
        // check faults the second), so `sending` is only a guard against
        // a null and a number going to one path in the same pass.
        if (this.onServer.has(output) && !sending.has(output)) {
          publications.push({ path: output, value: null })
          this.onServer.delete(output)
          entry.nullSent = true
        }
        continue
      }
      sending.add(output)

      const changed = entry.value !== entry.publishedValue || entry.publishedMono === null
      const repeatDue = this.settings.repeatMs > 0 && entry.publishedMono !== null && mono - entry.publishedMono >= this.settings.repeatMs
      if (changed || repeatDue) {
        // Twelve significant digits is far finer than any sensor, and it
        // keeps binary rounding noise (286.29720000000003) off the wire.
        publications.push({ path: entry.config.output, value: Number(entry.value.toPrecision(12)) })
        entry.publishedValue = entry.value
        entry.publishedMono = mono
        entry.nullSent = false
        this.onServer.add(output)
      }
    }
    // Paths that no running entry publishes any more. An entry switched
    // off, or left with a fault, that has this output says so.
    for (const path of [...this.onServer]) {
      if (this.byOutput.has(path)) continue
      publications.push({ path, value: null })
      this.onServer.delete(path)
      for (const entry of this.entries) if (!entry.active && entry.config.output === path) entry.nullSent = true
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
    if (entry.config.type === 'cycles') {
      // The cycles counted so far are forgotten, as after a defrost: the
      // figures start again from the next stretch that begins.
      entry.tracker.clear(mono)
      entry.lastReset = { at: wall, cause: 'request' }
      this.dirty = true
      this.cyclesFigure(entry, wall, mono, changed, false)
    } else {
      this.zero(entry, wall, mono, changed, { at: wall, cause: 'request' })
    }
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
        group: config.group,
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
        // The inputs counted as their value when stale at the latest
        // working-out, so that a silent device shows rather than hides.
        item.substituted = entry.substituted.map((input) => ({ ...input }))
        item.staleTimeout = config.staleMs / 1000
        item.edited = Boolean(entry.edited)
      } else if (config.type === 'cycles') {
        const figures = entry.figures || entry.tracker.figures(wall)
        const current = entry.tracker.current(mono)
        item.combine = config.combine
        item.statistic = config.statistic
        item.window = config.windowMs / 3600000
        item.minCycles = config.minCycles
        item.cycleInputs = config.inputs.map((i) => ({ ...i }))
        item.cycles = {
          count: figures.cycles,
          onMedian: figures.onMedian === null ? null : figures.onMedian / 1000,
          offMedian: figures.offMedian === null ? null : figures.offMedian / 1000,
          periodMedian: figures.periodMedian === null ? null : figures.periodMedian / 1000,
          duty: figures.duty,
          lastOn: figures.lastOn === null ? null : figures.lastOn / 1000,
          state: current.state === null ? null : (current.state ? 'on' : 'off'),
          stateFor: current.ms === null ? null : current.ms / 1000
        }
        item.lastReset = entry.lastReset === null ? null : { ...entry.lastReset, at: new Date(entry.lastReset.at).toISOString() }
      } else {
        item.resets = config.resets
        item.resetPath = config.resets === 'path' ? config.resetPath : null
        item.since = entry.since === null ? null : new Date(entry.since).toISOString()
        item.lastReset = entry.lastReset === null ? null : { ...entry.lastReset, at: new Date(entry.lastReset.at).toISOString() }
        item.sinceCorrected = entry.sinceCorrected === null
          ? null
          : {
              at: new Date(entry.sinceCorrected.at).toISOString(),
              previous: entry.sinceCorrected.previous === null ? null : new Date(entry.sinceCorrected.previous).toISOString()
            }
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
      if (config.type === 'cycles') {
        // An entry with nothing counted leaves a kept record of another
        // entry with its output in place, as a counter that has not started
        // does.
        const stretches = entry.tracker.serialize()
        if (config.output && !entries[config.output] && (stretches.length > 0 || entry.lastReset !== null || entry.restored)) {
          entries[config.output] = { signature: signature(config), stretches, lastReset: entry.lastReset }
        }
        continue
      }
      if (config.type === 'formula' || !entry.started || !config.output || entries[config.output]) continue
      entries[config.output] = {
        signature: signature(config),
        resets: config.resets,
        resetPath: config.resets === 'path' ? config.resetPath : null,
        total: entry.total,
        since: entry.since,
        periodStart: entry.periodStart,
        periodKey: entry.periodKey,
        periodZone: entry.periodZone,
        referenceLast: entry.referenceLast,
        lastReset: entry.lastReset,
        sinceCorrected: entry.sinceCorrected
      }
      if (config.type === 'counter') entries[config.output].last = entry.last
    }
    // Saved totals whose output no entry uses are kept for a while, so an
    // entry that comes back with the same output, from an import or after
    // the entries file was replaced, continues its total. They are dropped
    // once unused for ORPHAN_KEEP_MS, as long as the clock can be trusted.
    for (const [output, record] of this.orphans) {
      if (entries[output]) continue
      if (record.orphanedAt === null) record.orphanedAt = this.clockSuspect ? null : wall
      if (!this.clockSuspect && record.orphanedAt !== null && wall - record.orphanedAt > ORPHAN_KEEP_MS) {
        this.orphans.delete(output)
        continue
      }
      entries[output] = record
    }
    // The clock check compares against this, so a wrong clock must not be
    // written into it.
    if (!this.clockSuspect) this.savedAt = wall
    this.dirty = false
    return { savedAt: this.savedAt, entries }
  }
}

module.exports = { Engine, fingerprint, keepsTotal, signature, toNumber }
