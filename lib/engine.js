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
const { PERIODS, canonicalTimeZone, keyStart, nextPeriodInfo, periodInfo } = require('./periods')

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
  if (config.type === 'record') {
    // Everything that decides what the record holds. The start entered by
    // hand is left out: it is taken into the record whenever it fits, so
    // changing it keeps what the record already holds.
    return `record|${config.input}|${config.keep}|${config.timeSince ? config.level : ''}|${config.resets}|${config.resets === 'level' ? config.resetLevel : ''}|${config.resets === 'path' ? config.resetPath : ''}`
  }
  return 'formula'
}

/** Whether an entry keeps a total that periods and resets apply to. */
function keepsTotal (config) {
  return config.type === 'counter' || config.type === 'integration'
}

// The causes a total can be cleared for (see Engine#zero()), and a record
// started again (see Engine#restartRecord()).
const RESET_CAUSES = ['period', 'zone', 'path', 'request', 'level']

// Which kinds of entry can fill in from the history when they start; see
// lib/history.js.
const LOOKS_BACK = new Set(['counter', 'integration', 'cycles', 'record'])

// How often, at most, the time of a record that follows the input is sent
// while the input stays at the level; see Engine#tick().
const TIME_FOLLOW_MS = 60000

// How long a look-back that found no history provider is tried again, and
// how often; see Engine#lookbackPlans().
const LOOKBACK_RETRY_MS = 30000
const LOOKBACK_GIVE_UP_MS = 15 * 60 * 1000

/**
 * Reads a saved reset record, keeping only what has the expected form. The
 * record is shown to people and decides nothing, so a damaged one is simply
 * dropped.
 */
function readResetRecord (raw) {
  if (!raw || typeof raw !== 'object' || !Number.isFinite(raw.at) || !RESET_CAUSES.includes(raw.cause)) return null
  const record = { at: raw.at, cause: raw.cause }
  if (raw.cause === 'period' && PERIODS.includes(raw.period)) record.period = raw.period
  if ((raw.cause === 'period' || raw.cause === 'zone') && Number.isFinite(raw.total)) record.total = raw.total
  if (raw.cause === 'zone' && typeof raw.zone === 'string') record.zone = raw.zone
  if (raw.cause === 'path') {
    if (typeof raw.path === 'string') record.path = raw.path
    if (Number.isFinite(raw.from)) record.from = raw.from
    if (Number.isFinite(raw.to)) record.to = raw.to
    if (typeof raw.source === 'string') record.source = raw.source
  }
  if (raw.cause === 'level' && Number.isFinite(raw.level)) record.level = raw.level
  return record
}

/**
 * Reads a saved record of a look-back, kept for people only: when it ran,
 * what it covered and what it found.
 */
function readHistoryRecord (raw) {
  if (!raw || typeof raw !== 'object' || !Number.isFinite(raw.at) || typeof raw.outcome !== 'string') return null
  const record = { at: raw.at, outcome: raw.outcome }
  for (const key of ['from', 'to', 'resolution', 'amount', 'stretches', 'found']) if (Number.isFinite(raw[key])) record[key] = raw[key]
  if (typeof raw.reason === 'string') record.reason = raw.reason
  return record
}

/**
 * Reads a saved look-back that was not done: the moment it fills in up to,
 * or null when that moment was never known.
 */
function readPendingLookback (raw) {
  if (!raw || typeof raw !== 'object') return null
  return { to: Number.isFinite(raw.to) ? raw.to : null }
}

/** Whether a value meets a record's level, at or above it or at or below it. */
function meets (value, level, atLeast) {
  return atLeast ? value >= level : value <= level
}

/** A look-back not yet done, as saved with the state; undefined when there is none. */
function pendingOf (entry) {
  return entry.lookback && entry.lookback.state !== 'done' ? { to: entry.lookbackTo } : undefined
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

/**
 * Adds up an integration's input from buckets of the history: each bucket's
 * value holds from its start until the next bucket, as a reading holds
 * until the next one, unless the stretch between them is longer than the
 * stale timeout allows; a gap is then left out, or bridged as the entry's
 * gap setting says. An input sent only when it changes (a stale timeout of
 * zero) holds across any stretch, as it does live.
 */
function integrateRows (rows, resolution, from, to, config) {
  const bucketMs = resolution * 1000
  const allow = config.staleMs === 0 || config.gap === 'bridge' ? Infinity : Math.max(config.staleMs, bucketMs)
  let amount = 0
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const start = Math.max(row.t, from)
    const next = i + 1 < rows.length ? rows[i + 1].t : to
    const end = Math.min(next - row.t <= bucketMs + allow ? next : row.t + bucketMs, to)
    if (end <= start) continue
    const seconds = (end - start) / 1000
    if (config.mode === 'time') {
      if (row.v > config.threshold) amount += seconds
    } else {
      amount += row.v * seconds
    }
  }
  return amount
}

/**
 * Finds the finished stretches of a cycles entry in buckets of the history,
 * with the entry's own rules: a tracker of its own is fed the buckets of all
 * inputs in time order, with the bucket times as both clocks. Returns the
 * stretches that ended before `to`, dated by the wall clock.
 */
function replayCycles (config, inputs, to) {
  const tracker = new CycleTracker(config)
  const events = []
  inputs.forEach((rows, index) => {
    for (const row of rows || []) if (row.t < to) events.push({ t: row.t, index, v: row.v })
  })
  if (events.length === 0) return []
  events.sort((a, b) => a.t - b.t || a.index - b.index)
  for (const event of events) {
    tracker.input(event.index, event.v, event.t)
    tracker.advance(event.t, event.t)
  }
  tracker.advance(to, to)
  return tracker.stretches.filter((stretch) => stretch.end <= to).map((stretch, i) => i === 0 ? { ...stretch, joined: false } : stretch)
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
      // An entry that starts with nothing saved fills in from the history,
      // once; see lookbackPlans(). One saved before its look-back was done
      // carries on with it, up to the moment it was to fill in to.
      if (entry.active && LOOKS_BACK.has(config.type) && config.lookback && (!entry.kept || entry.pendingLookback)) {
        entry.lookback = { state: 'wanted', firstMono: null, tries: 0, nextMono: null }
        if (entry.kept) entry.lookbackTo = entry.pendingLookback.to
      }
      // Where counting began under an untrusted clock is known only in
      // memory, by the monotonic clock; an entry rebuilt by an edit that
      // took over the total takes it over too. See rollPeriod().
      if (previous && entry.restored) {
        const before = previous.entries.find((one) => one.config.output === config.output)
        if (before && before.suspectFrom && before.config.resets === config.resets) entry.suspectFrom = { ...before.suspectFrom }
      }
      if (entry.active) this.fresh.add(entry)
      return entry
    })
    const active = this.entries.filter((entry) => entry.active)
    this.order = dependencyOrder(active)
    this.byOutput = new Map(active.map((entry) => [entry.config.output, entry]))
    // The paths running records publish their times on; see publishTime().
    this.timePaths = new Set(active.filter((entry) => entry.config.timeOutput).map((entry) => entry.config.timeOutput))

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
      checkedSinceStart: false,
      // The monotonic time of the entry's first pass: the moment it began
      // counting, up to which a look-back fills in; see lookbackPlans().
      bornMono: null,
      // A look-back still to be done or under way; see lookbackPlans().
      lookback: null,
      // The moment up to which the look-back fills in, once known; saved
      // with the state while the look-back is not done, so that a restart
      // or an edit before it is done reads the same stretch.
      lookbackTo: null,
      // A look-back saved as not done, read back from the state.
      pendingLookback: null,
      // What the last look-back covered and found, for the status page.
      history: null
    }

    if (config.type === 'formula') {
      entry.variables = new Map()
      // Inputs whose last value was null or not a number, by short name.
      entry.unreadable = new Set()
      // The inputs counted as their value when stale at the last
      // evaluation, and a key for telling when that set changes.
      entry.substituted = []
      entry.substitutedKey = null
    } else if (config.type === 'record') {
      // A lowest or highest value with the wall time it was reached.
      entry.record = null
      // The wall time the input was last at the level, for a time since.
      entry.lastMet = null
      // The monotonic times of the record's value and of lastMet, when they
      // were taken in since this start; see repairRecordTimes().
      entry.recordMono = null
      entry.lastMetMono = null
      // Whether the latest input value met the level: the record of a time
      // since then follows the input, and its time is sent at most once a
      // minute; see tick().
      entry.metNow = false
      // Whether the latest value met the level a lowest or highest value
      // starts again at; only a value that comes to it starts the record
      // again with a record of why.
      entry.atResetLevel = false
      // The wall time the record last started again, or null when that is
      // not known; a start entered by hand counts only after it.
      entry.windowStart = null
      entry.periodKey = null
      entry.periodZone = null
      entry.referenceLast = null
      entry.referenceSeen = false
      entry.lastReset = null
      // The latest number from the input, with its wall time, so that a
      // record that starts again can start from it.
      entry.lastInput = null
      // The time last sent on the path for the time, when it was last sent,
      // and when a new time was last sent.
      entry.timeSent = null
      entry.timeSentMono = null
      entry.timeMovedMono = null
      // Whether the moment sent last was taken while the input was at the
      // level; see publishTime().
      entry.timeSentFollowing = false
      entry.restoredValue = false
      entry.announceRestored = false
      const old = saved && saved.entries && config.output ? saved.entries[config.output] : null
      if (old && old.signature === signature(config)) {
        entry.restored = true
        entry.kept = true
        const at = (value) => Number.isFinite(value) ? value : null
        if (old.record && Number.isFinite(old.record.value) && Number.isFinite(old.record.at)) entry.record = { value: old.record.value, at: old.record.at }
        entry.lastMet = at(old.lastMet)
        entry.windowStart = at(old.windowStart)
        entry.periodKey = typeof old.periodKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(old.periodKey) ? old.periodKey : null
        const zone = typeof old.periodZone === 'string' && old.periodZone ? old.periodZone : null
        entry.periodZone = entry.periodKey !== null && zone !== null ? canonicalTimeZone(zone) || zone : null
        if (config.resets === 'path') entry.referenceLast = at(old.referenceLast)
        entry.lastReset = readResetRecord(old.lastReset)
        entry.history = readHistoryRecord(old.history)
        entry.pendingLookback = readPendingLookback(old.pendingLookback)
      }
      if (entry.active && (entry.record !== null || entry.lastMet !== null)) {
        // As for a saved total: the record is the entry's value from the
        // first moment; a time since is worked out at the first pass.
        if (!config.timeSince) entry.value = entry.record.value
        entry.restoredValue = true
        entry.announceRestored = true
      }
    } else if (config.type === 'cycles') {
      entry.tracker = new CycleTracker(config)
      entry.lastReset = null
      // The monotonic time of the latest input value; see isStale().
      entry.sampleMono = null
      // The monotonic time each input was last handed a value; see
      // cyclesStep().
      entry.fedMono = config.inputs.map(() => null)
      const old = saved && saved.entries && config.output ? saved.entries[config.output] : null
      if (old && old.signature === signature(config)) {
        entry.restored = true
        entry.kept = true
        entry.tracker.restore(old.stretches)
        entry.lastReset = readResetRecord(old.lastReset)
        entry.history = readHistoryRecord(old.history)
        entry.pendingLookback = readPendingLookback(old.pendingLookback)
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
      // False until the followed path has been read since this entry was
      // created; see followReference().
      entry.referenceSeen = false
      // Why and when the total was last cleared, and when the start time
      // was last corrected without clearing it. Both are kept for people:
      // nothing is decided from them.
      entry.lastReset = null
      entry.sinceCorrected = null
      // The total and the monotonic time when counting began under a clock
      // that could not be trusted; see rollPeriod().
      entry.suspectFrom = null
      // The total a period ended with, waiting to be published by tick()
      // just before the boundary; see rollPeriod().
      entry.closing = null
      // True when the value on show is the total saved before a restart and
      // no input has arrived since. See status().
      entry.restoredValue = false
      // True once such a total has been cleared while still waiting for
      // its input; only the wording on the status page depends on it.
      entry.restoredCleared = false
      // Set until dependent entries have been told about a restored total.
      entry.announceRestored = false
      if (config.type === 'counter') {
        entry.last = null
        // A value that moved the other way, waiting for the next value to
        // tell a glitch from a restart; see counterInput().
        entry.pending = null
      }
      if (config.type === 'integration') entry.previous = null

      const old = saved && saved.entries && config.output ? saved.entries[config.output] : null
      if (old && old.signature === signature(config)) {
        entry.restored = true
        entry.started = true
        if (config.type === 'counter') {
          entry.last = Number.isFinite(old.last) ? old.last : null
          // Only "carry on counting" in one direction holds a value back.
          const holds = config.reversal === 'continue' && config.direction !== 'net'
          entry.pending = holds && entry.last !== null && Number.isFinite(old.pending) ? old.pending : null
        }
        // A total collected under one reset rule says nothing under
        // another: a total "since the last reset by hand" is not "today's".
        // Only the counter's place in its input survives such a change.
        if (old.resets === config.resets) {
          entry.kept = true
          entry.history = readHistoryRecord(old.history)
          entry.pendingLookback = readPendingLookback(old.pendingLookback)
          entry.total = Number.isFinite(old.total) ? old.total : 0
          entry.since = Number.isFinite(old.since) ? old.since : null
          entry.periodStart = Number.isFinite(old.periodStart) ? old.periodStart : null
          // Absent in state written by version 0.1.0; rollPeriod() works it
          // out from the saved start.
          entry.periodKey = typeof old.periodKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(old.periodKey) ? old.periodKey : null
          // Read in the spelling the zone in use is kept in, so that a zone
          // saved in other capitals is not taken for another zone.
          const zone = typeof old.periodZone === 'string' && old.periodZone ? old.periodZone : null
          entry.periodZone = entry.periodKey !== null && zone !== null ? canonicalTimeZone(zone) || zone : null
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

    if (entry.bornMono === null) {
      // The entry's first pass: it begins counting now. A value known from
      // before start-up carries an older `mono`; the present is later.
      entry.bornMono = countFrom === undefined ? mono : Math.max(mono, countFrom)
      // The moment a look-back fills in up to is the present one, saved
      // from now on; under a clock that cannot be trusted it is worked out
      // once the clock is right; see lookbackPlans().
      if (entry.lookback && !entry.kept && entry.lookbackTo === null && !this.clockSuspect) entry.lookbackTo = Math.floor(wall)
      // A record's window is known before a start entered by hand is
      // weighed against it; see rollRecord().
      if (config.type === 'record') {
        this.rollRecord(entry, wall, mono, changed)
        this.startByHand(entry, wall)
      }
    }

    if (config.type === 'record') {
      this.recordStep(entry, changed, wall, mono, countFrom, ticking)
      return
    }

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
      this.rollPeriod(entry, wall, mono, changed, countFrom === undefined ? mono : Math.max(mono, countFrom))
      this.repairSince(entry, wall)
      if (config.resets === 'path' && changed.has(config.resetPath)) {
        this.followReference(entry, toNumber(changed.get(config.resetPath)), wall, mono, changed)
      }
    }

    if (ticking) {
      if (config.type === 'integration') {
        this.extendHeld(entry, wall, mono, changed)
        this.extendCarried(entry, wall, mono, changed)
      }
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
   *
   * While the clock cannot be trusted no period ends, but totals go on
   * counting. Where that began is remembered, so that when the clock is
   * set and the boundary that passed meanwhile is seen, what was counted
   * since can stay in the new period if the counting began after it: the
   * usual case of a computer without a clock battery that boots in the
   * morning with its clock at 1970. If the counting began before the
   * boundary, how much fell on either side cannot be told, and all of it
   * goes with the period that ended.
   *
   * At a boundary seen live, the total the period ended with is recorded
   * and queued for tick(), which publishes it dated just before the
   * boundary: a reader that keeps the last value of each day then has the
   * day's full total, and not a figure from up to a second earlier.
   *
   * `present` is the present moment on the monotonic clock: `mono` is
   * older for a value that was known before start-up.
   */
  rollPeriod (entry, wall, mono, changed, present = mono) {
    const config = entry.config
    if (!PERIODS.includes(config.resets)) return
    if (this.clockSuspect) {
      if (entry.suspectFrom === null) entry.suspectFrom = { total: entry.total, mono: present }
      return
    }
    const suspect = entry.suspectFrom
    entry.suspectFrom = null

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
        // new total honestly starts here and not at the boundary. The total
        // closes at the moment of the change, and is published dated just
        // before it, as at a boundary.
        const downtime = entry.restored && !entry.checkedSinceStart
        this.closeAtBoundary(entry, wall, wall, present)
        const rounded = Number(entry.total.toPrecision(12))
        const publishing = entry.started && this.publishing(entry, present)
        this.zero(entry, wall, mono, changed, { at: wall, cause: 'zone', zone: this.timeZone, total: rounded })
        if (!downtime && publishing) entry.closing = { value: rounded, timestamp: wall - 1 }
        entry.note = 'The time zone changed and a new period had already begun in the new zone. This period is counted from the moment of the change.'
      } else {
        // A boundary first noticed on the very first check after a restart
        // passed while nothing was listening. The total it ended with was
        // published before the stop, so it is recorded but not sent again.
        const downtime = entry.restored && !entry.checkedSinceStart
        this.closeAtBoundary(entry, now.start, wall, present)
        let closing = entry.total
        let carry = 0
        let began = null
        if (suspect !== null) {
          // The clock is right now, so the monotonic clock dates the moment
          // the counting under the untrusted clock began.
          began = wall - (present - suspect.mono)
          if (began >= now.start) {
            carry = entry.total - suspect.total
            closing = suspect.total
          }
        }
        // A clock that ran ahead passed this boundary once already and was
        // then set back by less than the tolerance, which pulls the period
        // back (see below): what was counted since belongs to the same
        // period that closed then, and the closing figure is that sum, sent
        // again with the same time stamp.
        const last = entry.lastReset
        if (last && last.cause === 'period' && last.at === now.start && Number.isFinite(last.total)) closing += last.total
        const rounded = Number(closing.toPrecision(12))
        const publishing = entry.started && this.publishing(entry, present)
        this.zero(entry, now.start, mono, changed, { at: now.start, cause: 'period', period: config.resets, total: rounded }, carry)
        if (!downtime && publishing) entry.closing = { value: rounded, timestamp: now.start - 1 }
        if (began !== null) {
          entry.note = began >= now.start
            ? 'The clock was set after this period began; what was counted since the plugin started is kept in this period.'
            : 'The clock was set after this period began; what was counted before then went to the period before, as the moment of the boundary could not be told.'
        } else if (downtime) {
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
   * Adds to an integration's total the stretch from its last value up to a
   * period boundary, at that value, so that the total the period ends with
   * is complete. The rest of the stretch goes to the new period when the
   * next value arrives, as before; see accumulate().
   *
   * The stretch is added only when it would be counted anyway: the last
   * value is within the stale timeout of the boundary, the input is held
   * (a stale timeout of zero) or carried on from a fresh entry, or gaps
   * are bridged. The last value is always from since the plugin started,
   * so no stretch across a stop is added.
   */
  closeAtBoundary (entry, boundary, wall, present) {
    const config = entry.config
    const previous = entry.previous
    if (config.type !== 'integration' || !previous || previous.broken) return
    const at = present - (wall - boundary)
    if (at <= previous.mono) return
    const elapsedMs = at - previous.mono
    const counted = config.staleMs === 0 || previous.carried === true || elapsedMs <= config.staleMs ||
      config.gap === 'bridge' || this.producerFresh(config.input, present)
    if (!counted) return
    // Only the part after a clearing within the stretch, as in accumulate().
    let share = 1
    if (entry.since !== null && entry.since > boundary - elapsedMs) {
      share = Math.min(1, Math.max(0, (boundary - entry.since) / elapsedMs))
    }
    const seconds = (elapsedMs * share) / 1000
    if (config.mode === 'time') {
      if (previous.value > config.threshold) this.add(entry, seconds)
    } else {
      this.add(entry, previous.value * seconds)
    }
  }

  /**
   * Clears an entry's total. `since` is when the new total starts counting.
   * `carry` is what the new total starts from: normally nothing, and what
   * was counted under an untrusted clock when that is known to belong to
   * the new period; see rollPeriod().
   */
  zero (entry, since, mono, changed, record, carry = 0) {
    entry.total = carry
    entry.note = ''
    // What was counted under an untrusted clock is now all in the new total.
    if (entry.suspectFrom) entry.suspectFrom.total = 0
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
    entry.value = carry
    // Dependent entries hear about the zero only when this entry is itself
    // publishing it.
    if (this.publishing(entry, mono)) changed.set(entry.config.output, carry)
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
   *
   * Only a fall to below half of the previous value counts, or to zero or
   * below from above zero: a total kept in floating point can wobble down
   * by a hair, and a second source on the path can send a slightly lower
   * figure, and neither is a new day. From a value of zero or below any
   * fall counts, as half of it lies above it.
   *
   * After a smaller fall the level is still taken over, so the next value
   * is measured from it. A total that slips down in small steps and then
   * drops to zero is thereby reset once, at the drop, and not also halfway
   * down, as it would be if the highest level were kept.
   *
   * The first value after a start, or after the entry was changed, is
   * compared with the level saved before, and there any fall counts: the
   * followed device may have started its new day while the plugin was
   * stopped and climbed back above half of the old level since.
   */
  followReference (entry, value, wall, mono, changed) {
    if (value === null) return
    const previous = entry.referenceLast
    const first = !entry.referenceSeen
    entry.referenceSeen = true
    if (previous !== null && value < previous && (first || value < previous / 2 || (previous > 0 && value <= 0))) {
      const path = entry.config.resetPath
      const record = { at: wall, cause: 'path', path, from: entry.referenceLast, to: value }
      if (this.sources.has(path)) record.source = this.sources.get(path)
      if (entry.config.type === 'record') this.restartRecord(entry, wall, wall, mono, changed, record)
      else this.zero(entry, wall, mono, changed, record)
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
   * Adds to an entry's total. An amount that would leave the total no
   * longer a finite number (possible only with absurd inputs) is left out
   * and the total kept: clearing it instead would lose everything counted,
   * with no reset on record to say why.
   */
  add (entry, amount) {
    const total = entry.total + amount
    if (!Number.isFinite(total)) {
      entry.note = 'Adding the latest amount would have left the total no longer a finite number, so that amount was left out.'
      return
    }
    entry.total = total
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
      if (changed.has(input.path)) {
        entry.tracker.input(index, toNumber(changed.get(input.path)), mono)
        entry.fedMono[index] = mono
        fed = true
        return
      }
      // An entry this one reads announces its value only when it changes.
      // While it is publishing and not stale, its value still holds, and is
      // handed over again shortly before the stale timeout would count the
      // input as having a gap. Earlier would add steps a wave input does
      // not otherwise get from a reader that is merely slow.
      if (!ticking || config.staleMs === 0 || !this.byOutput.has(input.path)) return
      const last = entry.fedMono[index]
      if (last === null || mono - last < Math.max(config.staleMs / 2, config.staleMs - 2000)) return
      if (!this.producerFresh(input.path, mono)) return
      entry.tracker.input(index, toNumber(this.byOutput.get(input.path).value), mono)
      entry.fedMono[index] = mono
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
    // An untrusted clock keeps the stretches dated after it (see trim()).
    entry.tracker.clockTrusted = !this.clockSuspect
    // The present moment as advance() saw it, for the ON time so far.
    const figures = entry.tracker.figures(wall, Math.max(mono, entry.sampleMono === null ? mono : entry.sampleMono))
    entry.figures = figures
    // Every stretch recorded or trimmed is worth saving.
    const kept = entry.tracker.stretches.length
    if (kept !== entry.stretchesKept) this.dirty = true
    entry.stretchesKept = kept
    let value = figures[config.statistic]
    const hours = config.windowMs / 3600000
    if (config.statistic === 'onSoFar') {
      // The stretch under way needs no cycles counted before it, and does
      // not depend on the window. While ON it changes on every pass, so it
      // goes out every second.
      if (value === null) {
        // A first state waits for the shortest stretch before it counts,
        // which is worth saying apart from a state that cannot be told.
        const pending = entry.tracker.pending
        entry.note = pending && pending.state !== null && entry.tracker.state === null
          ? `The state counts once it has held for the shortest stretch, ${config.shortestMs / 1000} s.`
          : 'The state is not known at the moment: no input has a value without a gap, or the wave inputs have not turned yet or, while OFF, have not turned for longer than the longest stretch.'
        this.dropValue(entry, changed)
        return
      }
      entry.note = ''
      value = value / 1000
      if (fed || value !== entry.value) this.setValue(entry, value, wall, mono, changed)
      return
    }
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

  // ------------------------------------------------------------- look-back

  /**
   * The look-backs due now: one plan for each entry that started with
   * nothing saved and has not yet had its history read; see lib/history.js.
   * Each plan names what to read and up to when: the moment the entry began
   * counting, so that nothing is counted twice. A plan waits while the
   * clock cannot be trusted, as that moment is not known then, and an entry
   * whose last try found no history provider is tried again a little later.
   * The plans returned are marked as under way.
   */
  lookbackPlans (wall, mono) {
    if (this.clockSuspect) return []
    const plans = []
    for (const entry of this.order) {
      const lookback = entry.lookback
      if (!lookback || lookback.state !== 'wanted' || entry.bornMono === null) continue
      if (lookback.nextMono !== null && mono < lookback.nextMono) continue
      if (lookback.firstMono === null) lookback.firstMono = mono
      const config = entry.config
      if (entry.kept && entry.lookbackTo === null) {
        // Saved before the moment to fill in to was known, while the clock
        // could not be trusted: the entry has counted since a moment that
        // is lost, and filling in now could count that time twice.
        lookback.state = 'done'
        entry.history = { at: wall, outcome: 'failed', reason: 'the plugin stopped before the history was read, while the clock could not be trusted' }
        this.dirty = true
        continue
      }
      // Whole milliseconds: the monotonic clock of the server has fractions.
      // Once known, the moment stays the same through retries, restarts and
      // edits.
      if (entry.lookbackTo === null) entry.lookbackTo = Math.floor(wall - (mono - entry.bornMono))
      const to = entry.lookbackTo
      const plan = { key: entry.key, entry, type: config.type, to, from: null, finest: 1, resets: config.resets || null, resetPath: config.resetPath || null }
      if (config.type === 'cycles') {
        plan.inputs = config.inputs.map((input) => input.path)
        plan.from = to - config.windowMs
        // Fine enough for the shortest stretch, and never coarser than the
        // steps a wave is averaged into.
        plan.finest = Math.max(1, Math.min(10, Math.floor(config.shortestMs / 2000)))
      } else {
        plan.input = config.input
        if (PERIODS.includes(config.resets)) plan.from = this.currentPeriod(config.resets, to).start
        if (config.type === 'counter') plan.direction = config.direction
        if (config.type === 'record') {
          plan.keep = config.keep
          plan.timeSince = config.timeSince
          plan.level = config.level
          plan.resetLevel = config.resetLevel
        }
      }
      lookback.state = 'running'
      lookback.tries++
      plans.push(plan)
    }
    return plans
  }

  /**
   * Takes in what a look-back found (see lookBack() in lib/history.js) and
   * fills it into the entry, unless the entry has changed or started again
   * since the plan was made: what was counted before then belongs to a
   * period or a record the entry no longer holds.
   *
   * 1. A counter or an integration adds what the input changed by or added
   *    up to from the start of what its total covers until it began
   *    counting, worked out by the entry's own rules from the buckets read.
   * 2. A cycles entry adds the stretches found in the window.
   * 3. A record takes the lowest or highest value found, or the last moment
   *    the input was at the level, when it beats what the record holds.
   */
  applyLookback (plan, answer, wall, mono) {
    const entry = plan.entry
    if (!this.entries.includes(entry) || !entry.lookback || entry.lookback.state !== 'running') return false
    const config = entry.config
    entry.lookback.state = 'done'
    this.dirty = true
    const reset = entry.lastReset
    if (reset && reset.at > plan.to) {
      entry.history = { at: wall, outcome: 'skipped', reason: 'started again before the history was read' }
      return true
    }
    const record = { at: wall, outcome: 'empty', to: plan.to }
    // Why nothing could be filled in, when the history does not say where
    // the entry's total or record starts.
    if (typeof answer.unknown === 'string') record.reason = answer.unknown
    if (Number.isFinite(answer.from)) record.from = answer.from
    if (Number.isFinite(answer.resolution)) record.resolution = answer.resolution
    const changed = new Map()

    if (config.type === 'counter' || config.type === 'integration') {
      const rows = Array.isArray(answer.rows) ? answer.rows : []
      if (rows.length > 0) {
        let amount
        if (config.type === 'counter') {
          // The entry's own rules, on a copy that sees the buckets in turn
          // and, last, the first value the entry itself took in.
          const scratch = this.createEntry({ ...config, output: '' }, 0, null)
          const scratchChanged = new Map()
          for (const row of rows) this.counterInput(scratch, row.v, row.t, row.t, scratchChanged)
          if (entry.firstValue !== undefined) this.counterInput(scratch, entry.firstValue, plan.to, plan.to, scratchChanged)
          else if (entry.last === null) {
            // Nothing taken in yet: the first value counts from the last one
            // in the history.
            entry.last = scratch.last
          }
          amount = scratch.total
        } else {
          amount = integrateRows(rows, answer.resolution, answer.from, plan.to, config)
        }
        this.add(entry, amount)
        if (entry.since === null || answer.from < entry.since) entry.since = answer.from
        if (!entry.started) {
          entry.started = true
          // Shown and published as a saved total would be until the input
          // speaks; see publishing().
          entry.value = entry.total
          entry.restoredValue = true
          entry.filledFromHistory = true
          entry.announceRestored = true
        } else {
          entry.value = entry.total
          if (this.publishing(entry, mono)) changed.set(config.output, entry.value)
        }
        record.outcome = 'filled'
        record.amount = amount
      }
    } else if (config.type === 'cycles') {
      const found = replayCycles(config, answer.inputs || [], plan.to)
      if (found.length > 0) {
        const present = entry.tracker.stretches
        entry.tracker.stretches = [...found, ...present].sort((a, b) => a.end - b.end)
        this.cyclesFigure(entry, wall, mono, changed, false)
        record.outcome = 'filled'
        record.stretches = found.length
      }
    } else if (config.type === 'record') {
      if (config.timeSince) {
        if (Number.isFinite(answer.lastMet)) {
          record.outcome = 'filled'
          record.found = answer.lastMet
          if (entry.lastMet === null || answer.lastMet > entry.lastMet) {
            entry.lastMet = answer.lastMet
            entry.lastMetMono = null
          }
        }
      } else {
        // What the record covers starts where the history says it last
        // started again, unless the entry knows better.
        if (entry.windowStart === null && Number.isFinite(answer.from)) entry.windowStart = answer.from
        const found = answer.extreme
        if (found && Number.isFinite(found.value) && Number.isFinite(found.at) && (entry.windowStart === null || found.at >= entry.windowStart)) {
          record.outcome = 'filled'
          record.found = found.at
          const lowest = config.keep === 'lowest'
          if (entry.record === null || (lowest ? found.value < entry.record.value : found.value > entry.record.value)) {
            entry.record = { value: found.value, at: found.at }
            entry.recordMono = null
          }
        }
      }
      // A start entered by hand still counts where it beats the history.
      this.applyStart(entry, wall)
      const before = entry.value
      this.refreshRecord(entry, wall)
      if (entry.value !== null && entry.value !== before) {
        if (entry.inputMono === null) {
          entry.restoredValue = true
          entry.announceRestored = true
        } else if (this.publishing(entry, mono)) {
          changed.set(config.output, entry.value)
        }
      }
    }
    entry.history = record
    if (changed.size > 0) this.pass(changed, wall, mono, undefined, false)
    return true
  }

  /**
   * Notes that a look-back could not be done. When no history provider
   * answered, it is tried again a little later, for a while: providers are
   * plugins too, and start in no set order.
   */
  failLookback (plan, reason, retry, wall, mono) {
    const entry = plan.entry
    if (!this.entries.includes(entry) || !entry.lookback || entry.lookback.state !== 'running') return
    if (retry && mono - entry.lookback.firstMono < LOOKBACK_GIVE_UP_MS) {
      entry.lookback.state = 'wanted'
      entry.lookback.nextMono = mono + LOOKBACK_RETRY_MS
      entry.history = { at: wall, outcome: 'waiting', reason }
      return
    }
    entry.lookback.state = 'done'
    entry.history = { at: wall, outcome: 'failed', reason }
    this.dirty = true
  }

  // ---------------------------------------------------------------- records

  /** One record entry's share of a pass; see pass(). */
  recordStep (entry, changed, wall, mono, countFrom, ticking) {
    const config = entry.config
    const present = countFrom === undefined ? mono : Math.max(mono, countFrom)
    if (entry.announceRestored && ticking) {
      entry.announceRestored = false
      this.refreshRecord(entry, wall)
      if (entry.value !== null && this.publishing(entry, mono)) changed.set(config.output, entry.value)
    }
    this.rollRecord(entry, wall, mono, changed)
    if (config.resets === 'path' && changed.has(config.resetPath)) {
      this.followReference(entry, toNumber(changed.get(config.resetPath)), wall, mono, changed)
    }
    if (changed.has(config.input)) this.recordInput(entry, toNumber(changed.get(config.input)), wall, mono, present, changed)
    if (ticking) {
      this.repairRecordTimes(entry, wall, mono)
      // A time since grows with the clock alone.
      if (config.timeSince && this.refreshRecord(entry, wall) && this.publishing(entry, mono)) changed.set(config.output, entry.value)
      this.notifyStale(entry, mono, changed)
    }
  }

  /**
   * Takes in a record's input value. A lowest or highest value is replaced
   * by a lower or higher one; an equal value keeps the moment it was first
   * reached. A time since notes the moment the input meets the level.
   *
   * Values are dated by the wall clock, which a record keeps across
   * restarts; while that clock cannot be trusted no value is taken in, as a
   * moment read from it would be meaningless.
   */
  recordInput (entry, value, wall, mono, present, changed) {
    const config = entry.config
    if (value === null) {
      // No reading says nothing about the level: a time since counts on
      // from the last moment the input was known to be there.
      entry.metNow = false
      return
    }
    if (this.clockSuspect) {
      entry.note = 'The system clock looks unset, so values are not taken in until it is correct: a record keeps the moment of each value.'
      return
    }
    if (entry.note && entry.note.startsWith('The system clock looks unset')) entry.note = ''
    // Moments dated by a clock that ran ahead are moved back before a new
    // value is weighed against them.
    this.repairRecordTimes(entry, wall, mono)
    // A value known from before start-up is dated by its age.
    const at = wall - (present - mono)
    entry.lastInput = { value, at }
    if (config.timeSince) {
      entry.metNow = meets(value, config.level, config.keep === 'sinceAbove')
      if (entry.metNow && (entry.lastMet === null || at > entry.lastMet)) {
        entry.lastMet = at
        entry.lastMetMono = mono
        this.dirty = true
      }
    } else if (entry.windowStart !== null && at < entry.windowStart) {
      // A value from before the time the record covers, such as one the
      // server held from before a boundary, belongs to an earlier record.
      // As at a boundary, the latest value starts a record that holds
      // nothing yet, dated at the start of what it covers, while it is not
      // stale.
      const fresh = config.staleMs === 0 || present - mono <= config.staleMs
      if (entry.record !== null || config.resets === 'level' || !fresh) return
      entry.record = { value, at: entry.windowStart }
      entry.recordMono = mono - (at - entry.windowStart)
      this.dirty = true
    } else if (config.resets === 'level' && meets(value, config.resetLevel, config.keep === 'lowest')) {
      // At the level the record starts again: the lowest since a battery
      // was last full is, while it is full, its present charge. The reason
      // is recorded once, when the input comes to the level.
      if (!entry.atResetLevel) entry.lastReset = { at, cause: 'level', level: config.resetLevel }
      entry.atResetLevel = true
      entry.record = { value, at }
      entry.recordMono = mono
      entry.windowStart = at
      this.dirty = true
    } else {
      entry.atResetLevel = false
      const lowest = config.keep === 'lowest'
      if (entry.record === null || (lowest ? value < entry.record.value : value > entry.record.value)) {
        entry.record = { value, at }
        entry.recordMono = mono
        this.dirty = true
      }
    }
    entry.started = true
    this.refreshRecord(entry, wall)
    // The entry's own value for dependents and staleness: dated as an input.
    entry.announceRestored = false
    entry.restoredValue = false
    entry.updatedWall = wall
    entry.inputMono = mono
    entry.staleNotified = false
    if (entry.value !== null) changed.set(config.output, entry.value)
  }

  /**
   * Moves a record's moments that lie in the future, dated by a clock that
   * ran ahead and was set back, to when they happened by the monotonic
   * clock, or, for a moment from before this start, to the present. Left
   * alone, a time since would read 0, and stop moving on, until the clock
   * caught up. Nothing is done while the clock cannot be trusted.
   */
  repairRecordTimes (entry, wall, mono) {
    if (this.clockSuspect) return
    const fix = (at, atMono) => (atMono !== null && atMono !== undefined && atMono <= mono ? Math.min(wall, wall - (mono - atMono)) : wall)
    if (entry.lastMet !== null && entry.lastMet > wall) {
      entry.lastMet = fix(entry.lastMet, entry.lastMetMono)
      this.dirty = true
    }
    if (entry.record !== null && entry.record.at > wall) {
      entry.record = { value: entry.record.value, at: fix(entry.record.at, entry.recordMono) }
      this.dirty = true
    }
    if (entry.windowStart !== null && entry.windowStart > wall) {
      entry.windowStart = entry.record !== null ? Math.min(entry.record.at, wall) : wall
      this.dirty = true
    }
  }

  /**
   * Works out a record's value from what it holds: the lowest or highest
   * value, or the whole seconds since the input was last at the level.
   * Returns true when the value changed. A time since is not worked out
   * while the clock cannot be trusted.
   */
  refreshRecord (entry, wall) {
    const config = entry.config
    let value = null
    if (config.timeSince) {
      // While the input is at the level, no time has passed since it was.
      if (entry.metNow && entry.lastMet !== null && !this.clockSuspect) value = 0
      else if (entry.lastMet !== null && !this.clockSuspect) value = Math.max(0, Math.floor((wall - entry.lastMet) / 1000))
    } else if (entry.record !== null) {
      value = entry.record.value
    }
    if (value === entry.value) return false
    entry.value = value
    return true
  }

  /**
   * Starts a record again: the lowest or highest value is then the input's
   * latest value, when it is fresh, from `at` on.
   */
  restartRecord (entry, at, wall, mono, changed, reason) {
    const config = entry.config
    const last = entry.lastInput
    const fresh = last !== null && entry.inputMono !== null && !this.isStale(entry, mono)
    entry.record = fresh ? { value: last.value, at } : null
    entry.recordMono = fresh ? mono - (wall - at) : null
    entry.windowStart = at
    entry.atResetLevel = false
    if (reason) entry.lastReset = reason
    entry.note = ''
    this.dirty = true
    this.refreshRecord(entry, wall)
    if (entry.value === null) this.dropValue(entry, changed)
    else if (this.publishing(entry, mono)) changed.set(config.output, entry.value)
  }

  /**
   * Starts a lowest or highest value again at a period boundary. The rules
   * are those of rollPeriod() without what a total needs: a period is known
   * by the date it began on, and a date that steps back, as when the zone
   * changes going west, does not start the record a second time.
   */
  rollRecord (entry, wall, mono, changed) {
    const config = entry.config
    if (!PERIODS.includes(config.resets) || this.clockSuspect) return
    const now = this.currentPeriod(config.resets, wall)
    if (entry.periodKey === null) {
      entry.periodKey = now.key
      entry.periodZone = this.timeZone
      if (entry.windowStart === null) {
        entry.windowStart = now.start
        // A start entered by hand waited for the window to be known.
        if (entry.bornMono !== null) this.startByHand(entry, wall)
      }
      this.dirty = true
    } else if (now.key > entry.periodKey) {
      entry.periodKey = now.key
      entry.periodZone = this.timeZone
      this.restartRecord(entry, now.start, wall, mono, changed, { at: now.start, cause: 'period', period: config.resets })
    } else if (now.key < entry.periodKey && entry.periodZone === this.timeZone) {
      // Dated by a clock that was ahead, or under another day start: pulled
      // back to the present, keeping the record.
      entry.periodKey = now.key
      this.dirty = true
    }
  }

  /**
   * Takes a start entered by hand into a record, as applyStart() does, and
   * shows it as a saved record is until the input speaks; see
   * recordCondition().
   */
  startByHand (entry, wall) {
    if (this.applyStart(entry, wall) && entry.inputMono === null) {
      entry.restoredValue = true
      entry.announceRestored = true
    }
  }

  /**
   * Takes a start entered by hand into a record, when it fits: a lowest or
   * highest value that is lower or higher than the record's, from a moment
   * after the record last started again and not in the future; or a moment
   * the level was met that is later than the one the record holds.
   */
  applyStart (entry, wall) {
    const config = entry.config
    const at = config.startTime
    if (at === null || at > wall) return false
    // A record kept per period covers a time known only from a clock that
    // can be trusted.
    if (PERIODS.includes(config.resets) && !config.timeSince && entry.windowStart === null) return false
    if (config.timeSince) {
      if (entry.lastMet !== null && entry.lastMet >= at) return false
      entry.lastMet = at
      entry.lastMetMono = null
    } else {
      if (config.startValue === null) return false
      if (entry.windowStart !== null && at < entry.windowStart) return false
      const lowest = config.keep === 'lowest'
      if (entry.record !== null && !(lowest ? config.startValue < entry.record.value : config.startValue > entry.record.value)) return false
      entry.record = { value: config.startValue, at }
      entry.recordMono = null
    }
    this.dirty = true
    this.refreshRecord(entry, wall)
    return true
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
    if (staleMs > 0 && mono - variable.mono > staleMs && !this.producerFresh(input.path, mono)) return 'stale'
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
      if (config.staleMs > 0 && mono - variable.mono > config.staleMs && !this.producerFresh(input.path, mono)) return
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

  /**
   * Takes in a counter's input value.
   *
   * With "carry on counting" a value that moves the other way is not taken
   * at once. A device that restarts may send a single 0 and then its stored
   * total again, and a level sensor may read high for one value; taking
   * such a value would count the whole climb back as new. The value is held
   * as pending, and the next value decides: one that is back at or past the
   * level before (for a count of increases; below it for decreases) shows
   * the pending value was a glitch, and only the change past that level is
   * counted. Otherwise the input really did restart or was refilled, and
   * counting carries on from the pending value, as it always did. Net
   * change has no wrong way and counts every value as before.
   */
  counterInput (entry, value, wall, mono, changed) {
    if (value === null) return
    const config = entry.config

    if (entry.last === null) {
      // The very first value only sets the starting point. Nothing is known
      // about what the input did before the plugin first saw it, unless a
      // look-back fills it in; it then needs this value; see
      // applyLookback().
      entry.last = value
      entry.firstValue = value
      this.begin(entry, wall)
    } else {
      const holds = config.reversal === 'continue' && config.direction !== 'net'
      let confirmed = false
      if (entry.pending !== null && holds) {
        // Back within the smallest change counts as back: ripple that small
        // is ignored everywhere else too.
        const back = config.direction === 'increase' ? value > entry.last - config.minStep || value >= entry.last : value < entry.last + config.minStep || value <= entry.last
        if (!back) {
          // A second value on the far side: the move was real, and counting
          // carries on from the pending value.
          entry.last = entry.pending
          confirmed = true
        }
        entry.pending = null
        this.dirty = true
      }
      const change = value - entry.last
      if (change !== 0 && Math.abs(change) >= config.minStep) {
        const wanted = config.direction === 'net' || (config.direction === 'increase' ? change > 0 : change < 0)
        if (wanted) {
          this.add(entry, config.direction === 'decrease' ? -change : change)
          entry.last = value
        } else if (config.reversal === 'continue') {
          if (holds && !confirmed) {
            // The input moved the other way. Whether it restarted (a
            // counter reset to zero, a tank refilled) or sent one wrong
            // value is told by the next value; until then the level before
            // is kept.
            entry.pending = value
          } else {
            // Right after a confirmed restart a further move the same way
            // is taken at once, as it always was.
            entry.last = value
          }
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
    // A value carried on by extendCarried() held, unchanged, up to now.
    const held = config.staleMs === 0 || previous.carried === true
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

  /**
   * Brings an integration's total up to the present while it reads another
   * entry that is publishing and not stale but says nothing new.
   *
   * An entry announces its result when it changes, or when its own input
   * arrives. One that reads a switch sent only when it changes may hold one
   * result for hours, and is right all that while: its result has not
   * changed. Once the stretch since the last value is longer than the
   * stale timeout, it is added up to now at that value, and from then on
   * every second, as for a held input. A stretch that short is left to the next value as
   * before, so an entry read every few seconds is summed exactly as it
   * always was. If the entry read is stale at such a moment the stretch is
   * a gap, and treated as one when the next value arrives.
   */
  extendCarried (entry, wall, mono, changed) {
    const config = entry.config
    const previous = entry.previous
    if (config.staleMs === 0 || !previous || previous.broken || mono <= previous.mono) return
    if (!this.byOutput.has(config.input)) return
    // Once carried on, the value is carried on every second.
    if (!previous.carried && mono - previous.mono <= config.staleMs) return
    if (!this.producerFresh(config.input, mono)) {
      previous.carried = false
      previous.broken = true
      return
    }
    const before = entry.total
    previous.carried = true
    this.accumulate(entry, undefined, wall, mono)
    entry.previous = { value: previous.value, mono, carried: true }
    if (entry.total !== before) this.setValue(entry, entry.total, wall, mono, changed)
  }

  /**
   * Whether a path that is another entry's output can be read as fresh
   * now, however long ago its value last changed: that entry is publishing
   * and not stale. An entry announces its result when it changes, so the
   * age of the last announcement says nothing about whether the result
   * still holds. An entry that stops publishing sends null to the entries
   * that read it, which then wait or go stale as for a sensor that stops.
   * Always false for a path from the server.
   */
  producerFresh (path, mono) {
    const producer = this.byOutput.get(path)
    if (!producer || producer.value === null) return false
    // publishing() and !isStale() together, with isStale() asked once: it
    // asks the same of the entries the producer reads, so asking it twice
    // at every link would double the work at every step of a chain.
    if (this.isStale(producer, mono)) return false
    if (producer.inputMono !== null) return true
    const hold = producer.config.onStale === 'hold'
    return producer.restoredValue && (hold || producer.config.staleMs === 0)
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
        if (variable && mono - variable.mono > staleMs && !this.producerFresh(input.path, mono)) return true
      }
      return false
    }
    // A figure over the cycles is as fresh as the latest input value.
    // Before any value has arrived it is one restored from before a start.
    if (entry.config.type === 'cycles') return entry.sampleMono === null || mono - entry.sampleMono > staleMs
    return entry.inputMono !== null && mono - entry.inputMono > staleMs && !this.producerFresh(entry.config.input, mono)
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
      if (entry.value === null) return { state: 'waiting', message: entry.note || (config.statistic === 'onSoFar' ? 'Waiting for the state to be known.' : 'Waiting for the first cycles.') }
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

    if (config.type === 'record') return this.recordCondition(entry, mono)

    if (keepsTotal(config) && entry.inputMono === null && entry.restoredValue && entry.value !== null) {
      // A total saved before a restart, with no input since. It is treated
      // as a stale input is: shown, and published or not as the entry's
      // stale setting says. With a stale timeout of zero an entry never
      // counts as stale, and the total is published.
      const total = entry.restoredCleared ? 'the total, cleared since' : entry.filledFromHistory ? 'the total filled in from the history' : 'the saved total'
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
      const old = read.filter((i) => config.staleMs > 0 && mono - entry.variables.get(i.name).mono > config.staleMs && !this.producerFresh(i.path, mono)).map((i) => i.path)
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

  /** The state and message of a record entry; see condition(). */
  recordCondition (entry, mono) {
    const config = entry.config
    const since = entry.edited ? 'the entry was last changed' : 'the plugin started'
    if (entry.inputMono === null && entry.restoredValue && entry.value !== null) {
      // The record held came from the saved state, the history or the start
      // entered by hand.
      let what = 'the record'
      if (!entry.started) what = entry.kept ? 'the saved record' : entry.history && entry.history.outcome === 'filled' ? 'the record filled in from the history' : 'the start entered by hand'
      if (config.staleMs === 0) return { state: 'ok', message: `No value on ${config.input} since ${since}; publishing ${what}.` }
      return {
        state: 'stale',
        message: config.onStale === 'hold'
          ? `No value on ${config.input} since ${since}; still publishing ${what}.`
          : `No value on ${config.input} since ${since}; ${what} is shown and publishing is paused.`
      }
    }
    if (entry.value === null) {
      if (this.clockSuspect) return { state: 'waiting', message: 'The system clock looks unset; the record waits until it is correct.' }
      if (entry.inputMono === null) return { state: 'waiting', message: `Waiting for a value on ${config.input}.` }
      if (config.timeSince) return { state: 'waiting', message: `${config.input} has not been at the level since ${since}${entry.history && entry.history.outcome === 'empty' ? ', nor in the history read' : ''}.` }
      return { state: 'waiting', message: entry.note || `Waiting for a value on ${config.input}.` }
    }
    if (this.isStale(entry, mono)) {
      const seconds = config.staleMs / 1000
      return {
        state: 'stale',
        message: config.onStale === 'hold'
          ? `No fresh input for more than ${seconds} s; still publishing the record.`
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
   * A counter or integration that has just started a new period first
   * sends the total the period ended with, with `timestamp` set to the
   * moment just before the boundary (wall clock, ms since the epoch), and
   * then its current value. No other publication carries a timestamp: it
   * is sent as of now. A closing total is sent only while the entry
   * publishes; it is a number on the path like any other.
   *
   * @returns {Array<{path: string, value: number|null, timestamp?: number}>}
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
      const closing = keepsTotal(entry.config) ? entry.closing : null
      if (closing) entry.closing = null
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

      if (closing) {
        publications.push({ path: output, value: closing.value, timestamp: closing.timestamp })
        // The current value goes out straight after it, even when it equals
        // the value sent before, so that it is the latest on the path.
        entry.publishedMono = null
      }
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
      if (entry.config.type === 'record') this.publishTime(entry, mono, publications, sending)
    }
    // The paths for the times of records, alongside the outputs.
    for (const entry of this.entries) {
      if (!entry.active || entry.config.type !== 'record' || !entry.config.timeOutput) continue
      const path = entry.config.timeOutput
      if (sending.has(path) || !this.onServer.has(path)) continue
      // The entry is not publishing: its time goes too.
      publications.push({ path, value: null })
      this.onServer.delete(path)
      entry.timeSent = null
      entry.timeSentMono = null
    }
    // Paths that no running entry publishes any more. An entry switched
    // off, or left with a fault, that has this output says so.
    for (const path of [...this.onServer]) {
      if (this.byOutput.has(path) || this.timePaths.has(path)) continue
      publications.push({ path, value: null })
      this.onServer.delete(path)
      for (const entry of this.entries) if (!entry.active && entry.config.output === path) entry.nullSent = true
    }
    return publications
  }

  /**
   * Sends the moment that goes with a record on its path for the time, as
   * an ISO 8601 date and time: when the lowest or highest value was reached,
   * or when the input was last at the level. While the input stays at the
   * level that moment moves on with every value; it is then sent at most
   * once a minute, and at once when the input leaves the level, so that the
   * last moment at the level is exact. Called only while the entry
   * publishes its value.
   */
  publishTime (entry, mono, publications, sending) {
    const config = entry.config
    if (!config.timeOutput) return
    const at = config.timeSince ? entry.lastMet : (entry.record === null ? null : entry.record.at)
    if (at === null) return
    // While the input stays at the level the moment moves with each value;
    // it is sent at most once a minute meanwhile.
    const following = config.timeSince ? entry.metNow : entry.atResetLevel
    sending.add(config.timeOutput)
    let send = null
    // Coming to the level is sent at once; staying there is held back.
    const held = following && entry.timeSentFollowing
    if (entry.timeSentMono === null || (at !== entry.timeSent && (!held || entry.timeMovedMono === null || mono - entry.timeMovedMono >= TIME_FOLLOW_MS))) {
      send = at
      entry.timeMovedMono = mono
      entry.timeSentFollowing = following
    } else if (this.settings.repeatMs > 0 && mono - entry.timeSentMono >= this.settings.repeatMs) {
      // The time last sent goes out again, as an unchanged value does, also
      // while a newer one waits for its minute.
      send = entry.timeSent
    }
    if (send === null) return
    publications.push({ path: config.timeOutput, value: new Date(send).toISOString() })
    entry.timeSent = send
    entry.timeSentMono = mono
    this.onServer.add(config.timeOutput)
  }

  /**
   * Marks values that tick() returned as not sent, after the host failed to
   * send them, so that the next tick() sends them again. A number goes out
   * again, as it would after a change, as long as its entry still publishes
   * one; a null is owed again on its path, as for an entry that has just
   * stopped sending. Items that are not a publication of this engine are
   * ignored.
   *
   * A closing total (a publication with a timestamp) is queued again, so
   * the next tick() sends it once more, before the entry's current value
   * and with its own timestamp, as long as the entry still publishes. It is
   * not dropped: it is the one value that carries a period's full total.
   *
   * @param {Array<{path: string, value: number|null, timestamp?: number}>}
   *   publications - What one tick() call returned, before any later
   *   tick() call.
   */
  republish (publications) {
    if (!Array.isArray(publications)) return
    for (const item of publications) {
      if (!item || typeof item.path !== 'string') continue
      if (item.value === null) {
        this.onServer.add(item.path)
        // Set again when the null does go out.
        for (const entry of this.entries) if (entry.config.output === item.path) entry.nullSent = false
      } else if (typeof item.value === 'string') {
        // The time of a record: sent again at the next tick.
        for (const entry of this.entries) {
          if (entry.active && entry.config.timeOutput === item.path) entry.timeSentMono = null
        }
      } else if (typeof item.value === 'number') {
        const entry = this.byOutput.get(item.path)
        if (!entry) continue
        if (Number.isFinite(item.timestamp)) {
          // A newer closing total, queued since, takes precedence.
          if (keepsTotal(entry.config) && entry.closing === null) entry.closing = { value: item.value, timestamp: item.timestamp }
          continue
        }
        entry.publishedValue = null
        entry.publishedMono = null
      }
    }
  }

  /**
   * Clears one entry's total on request, forgets the cycles of a cycles
   * entry, or starts a lowest or highest value again. Returns false when the
   * output path does not belong to a running entry that can be reset.
   */
  reset (output, wall, mono) {
    // Only running entries are considered: a disabled entry may carry the
    // same output path, and clearing that one would change nothing.
    const entry = this.order.find((e) => e.config.output === output && e.config.type !== 'formula' && !(e.config.type === 'record' && e.config.timeSince))
    if (!entry) return false
    const changed = new Map()
    this.checkClock(wall, mono)
    if (entry.config.type === 'record') {
      // The record starts again from the input's latest value.
      this.restartRecord(entry, wall, wall, mono, changed, { at: wall, cause: 'request' })
    } else if (entry.config.type === 'cycles') {
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
        canReset: entry.active && config.type !== 'formula' && !(config.type === 'record' && config.timeSince)
      }
      if (LOOKS_BACK.has(config.type)) {
        // What the look-back covered and found, and whether one is waiting.
        const h = entry.history
        const iso = (ms) => ms === undefined ? undefined : new Date(ms).toISOString()
        item.history = h === null
          ? null
          : { at: iso(h.at), outcome: h.outcome, reason: h.reason, from: iso(h.from), to: iso(h.to), resolution: h.resolution, amount: h.amount, stretches: h.stretches, found: iso(h.found) }
        item.lookback = entry.lookback === null ? null : entry.lookback.state
      }
      if (config.type === 'formula') {
        item.expression = config.expression
        // The inputs counted as their value when stale at the latest
        // working-out, so that a silent device shows rather than hides.
        item.substituted = entry.substituted.map((input) => ({ ...input }))
        item.staleTimeout = config.staleMs / 1000
        item.edited = Boolean(entry.edited)
      } else if (config.type === 'record') {
        const iso = (ms) => ms === null ? null : new Date(ms).toISOString()
        item.keep = config.keep
        item.level = config.level
        item.resets = config.resets
        item.resetLevel = config.resetLevel
        item.resetPath = config.resets === 'path' ? config.resetPath : null
        item.timeOutput = config.timeOutput || null
        item.record = entry.record === null ? null : { value: entry.record.value, at: iso(entry.record.at) }
        item.lastMet = iso(entry.lastMet)
        item.atLevel = config.timeSince ? entry.metNow : entry.atResetLevel
        item.windowStart = iso(entry.windowStart)
        item.lastReset = entry.lastReset === null ? null : { ...entry.lastReset, at: new Date(entry.lastReset.at).toISOString() }
      } else if (config.type === 'cycles') {
        entry.tracker.clockTrusted = !this.clockSuspect
        const figures = entry.figures || entry.tracker.figures(wall, mono)
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
          onSoFar: figures.onSoFar === null || figures.onSoFar === undefined ? null : figures.onSoFar / 1000,
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
        if (config.output && !entries[config.output] && (stretches.length > 0 || entry.lastReset !== null || entry.restored || entry.history !== null)) {
          entries[config.output] = { signature: signature(config), stretches, lastReset: entry.lastReset, history: entry.history, pendingLookback: pendingOf(entry) }
        }
        continue
      }
      if (config.type === 'record') {
        if (!config.output || entries[config.output]) continue
        if (!entry.restored && entry.record === null && entry.lastMet === null && entry.history === null) continue
        entries[config.output] = {
          signature: signature(config),
          record: entry.record,
          lastMet: entry.lastMet,
          windowStart: entry.windowStart,
          periodKey: entry.periodKey,
          periodZone: entry.periodZone,
          referenceLast: entry.referenceLast,
          lastReset: entry.lastReset,
          history: entry.history,
          pendingLookback: pendingOf(entry)
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
        sinceCorrected: entry.sinceCorrected,
        history: entry.history,
        pendingLookback: pendingOf(entry)
      }
      if (config.type === 'counter') {
        entries[config.output].last = entry.last
        entries[config.output].pending = entry.pending
      }
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

module.exports = { Engine, LOOKBACK_GIVE_UP_MS, LOOKBACK_RETRY_MS, fingerprint, integrateRows, keepsTotal, replayCycles, signature, toNumber }
