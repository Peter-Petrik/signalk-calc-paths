'use strict'

/*
 * Calculated Paths - Signal K server plugin.
 *
 * Publishes new Signal K paths calculated from existing ones: formulas over
 * live values, period counters on running totals, and integrations of a
 * rate over time.
 *
 * This file is the adapter between the Signal K server and the engine in
 * lib/engine.js. It subscribes to the input paths, feeds each value to the
 * engine with a wall-clock and a monotonic time reading, publishes what the
 * engine hands back, saves the engine's state, and serves the HTTP
 * interface used by the page under Webapps: the status of every entry, and
 * the editor that creates and changes entries. It also reads the paths that
 * carry the ship's time zone and tells the engine when the zone changes.
 *
 * The entries live in entries.json in the plugin's data directory; see
 * lib/store.js. The plugin settings hold what applies to every entry.
 */

const crypto = require('crypto')
const { performance } = require('perf_hooks')

const { normalizeConfig } = require('./lib/config')
const { Engine, toNumber } = require('./lib/engine')
const { lookBack } = require('./lib/history')
const { checkName, compileFormula } = require('./lib/formula')
const openApi = require('./lib/openapi')
const { entryAdvanced, entryFields, entryOrder, schemaFor, uiSchema } = require('./lib/schema')
const { loadState, saveState } = require('./lib/state')
const store = require('./lib/store')
const { ZoneTracker } = require('./lib/timezone')
const packageInfo = require('./package.json')

const PLUGIN_ID = 'signalk-calc-paths'

// How often results are published and housekeeping runs.
const TICK_MS = 1000

// How often changed totals are written to disk. A crash or power cut loses
// at most this much counting; clean stops and resets save immediately.
const SAVE_INTERVAL_MS = 30000

// How often, in ticks, the followed time zone is looked at again without
// anything new having been published. See ZoneTracker#recheck().
const ZONE_RECHECK_TICKS = 60

// How long one look-back may take before it is given up and tried again
// later. A history provider whose database is still starting may not
// answer at all. See runLookbacks().
const LOOKBACK_TIMEOUT_MS = 120000

/**
 * Arranges the publications of one calculation pass as the updates of one
 * delta.
 *
 * Most publications are current values and carry no time stamp: the server
 * stamps them on arrival. The closing total of a period carries the moment
 * the period ended, so that a history kept by time files it under the
 * period it belongs to and not under the first moments of the next. One
 * update holds one time stamp, so each time stamp gets an update of its
 * own. They go oldest first and the current values last: the server keeps
 * the value of a path that arrives last, and that must be the current one.
 *
 * @param {Array<{path: string, value: number|null, timestamp?: number}>} publications
 *   What Engine#tick() returned; a timestamp is in epoch milliseconds.
 * @returns {Array<object>} The updates, in the order they are to be sent.
 */
function updatesFor (publications) {
  const stamped = new Map()
  const current = []
  for (const { path, value, timestamp } of publications) {
    if (Number.isFinite(timestamp)) {
      if (!stamped.has(timestamp)) stamped.set(timestamp, [])
      stamped.get(timestamp).push({ path, value })
    } else {
      current.push({ path, value })
    }
  }
  const updates = [...stamped.keys()].sort((a, b) => a - b).map((timestamp) => ({ timestamp: new Date(timestamp).toISOString(), values: stamped.get(timestamp) }))
  if (current.length > 0) updates.push({ values: current })
  return updates
}

/**
 * The metadata the plugin announces for an entry's output: its unit, and
 * its name as both display name and description.
 */
function metadataOf (entry) {
  const value = {}
  if (entry.unit) value.units = entry.unit
  if (entry.name) {
    value.displayName = entry.name
    value.description = entry.name
  }
  return value
}

/**
 * The metadata of the path a record publishes its time on: the entry's
 * name, marked as the time that goes with it. A time has no unit.
 */
function timeMetadataOf (entry) {
  if (!entry.name) return {}
  return { displayName: `${entry.name} (time)`, description: `${entry.name}: the moment that goes with the value` }
}

/**
 * Whether a request says its body is JSON. Only the media type counts, in
 * any case and with any parameters such as a charset.
 */
function isJson (req) {
  const type = req && req.headers ? req.headers['content-type'] : undefined
  return typeof type === 'string' && type.split(';')[0].trim().toLowerCase() === 'application/json'
}

// What a key of the metadata is set to when the plugin takes it away. The
// server merges metadata and offers no way to delete a key through a delta,
// so a key is overwritten instead: with an empty text for the description,
// which is what the server itself gives every path's metadata to begin
// with, and with null for the others, which have no such default.
const EMPTIED = { units: null, displayName: null, description: '' }

module.exports = function (app) {
  const plugin = {
    id: PLUGIN_ID,
    name: 'Calculated Paths',
    description: 'Calculate new paths from existing ones: formulas over live values, daily/weekly/monthly/yearly counters on running totals, integration of a rate over time, and the ON and OFF cycles of a device such as a fridge compressor.',
    uiSchema
  }

  // The time zone chosen in the configuration last started with. See
  // plugin.schema below.
  let startedTimeZone

  let engine = null
  let normalized = null
  // The plugin settings last started with, and the entries document in use.
  let settingsOptions = {}
  let doc = null
  // Why the entries file could not be used, while that is so. The plugin
  // then runs no entries and saves nothing until a new set is saved.
  let blocked = null
  // Things the status page says once per start, such as entries having been
  // moved out of the plugin settings.
  let notes = []
  // A failure while putting a saved set to work, shown in the plugin status
  // until the next save succeeds; see applyDocument().
  let applyProblem = null
  // The paths the current subscription covers.
  let subscribedPaths = new Set()
  // While set, only values of these paths are collected from the replay of
  // a new subscription; see resubscribe().
  let heldOnly = null
  // Decides which time zone is in use; see lib/timezone.js.
  let zones = null
  let stateProblem = null
  // Set while the state file exists but could not be read. Nothing is
  // saved then: a save would replace a file that may hold every total.
  // The next start reads it again.
  let stateUnreadable = false
  // True from start() to stop(): while the server has the plugin switched
  // on. The editor's routes act only then, so that an editor left open
  // cannot start the engine of a plugin the server lists as disabled.
  let running = false
  let unsubscribes = []
  let tickTimer = null
  // Saves the totals when the process ends without stopping the plugin
  // first, as Signal K server does on a restart from its admin UI (it
  // calls process.exit). Node runs 'exit' listeners synchronously, and the
  // save is synchronous throughout, so it completes. Registered only while
  // the plugin runs.
  let exitListener = null
  let lastSaveMono = 0
  let ticksSinceZoneCheck = 0
  // True while look-backs are being read; one run at a time. Each run has
  // a number, so that one still under way when the plugin stops ends there.
  let lookingBack = false
  let lookbackRun = 0
  // The time-out of the read under way, cleared by stop().
  let lookbackTimer = null
  let lastStatus = null
  // When the plugin last started, for the status page: a start that nobody
  // asked for is otherwise indistinguishable from one that never happened.
  let startedAt = null
  // True only while the subscription is being set up. See onDelta().
  let subscribing = false
  // Values received in the current turn of the event loop, waiting to be
  // handed to the engine together. See onDelta().
  let pending = []
  let pendingWall = 0
  let pendingMono = 0
  // The values the server already held when the plugin started, newest per
  // path. See onDelta() and feedHeldValues().
  let held = new Map()
  // The same for the paths that carry the ship's time zone.
  let heldZones = new Map()
  // The time stamp and source of the value last taken in for each path,
  // the last time stamp and value seen from each source of each path, and
  // a count of the values turned away as old ones. See isOutdated().
  let latest = new Map()
  let seenBySource = new Map()
  let outdated = { count: 0, last: null }
  // The metadata last announced for each output path, as the server holds
  // it from this plugin. See publishMetadata().
  let announced = new Map()

  // Both clocks are read through these two functions so that every value
  // and every tick is stamped the same way.
  const wallNow = () => Date.now()
  const monoNow = () => performance.now()

  /**
   * Writes the engine state to the plugin's data directory. A failed save
   * is reported and retried on the next interval; it never stops the
   * calculations. Nothing is written while the state file could not be
   * read; see stateUnreadable.
   */
  function save () {
    if (!engine || stateUnreadable) return
    try {
      saveState(app.getDataDirPath(), { ...engine.serialize(wallNow()), zone: zones.serialize() })
      lastSaveMono = monoNow()
    } catch (err) {
      app.error(`Could not save state: ${err.message}`)
    }
  }

  /**
   * Announces the unit and description of every output path. Signal K
   * keeps this metadata with the path, so instrument displays can label
   * the value without any configuration of their own.
   *
   * The server keeps metadata until it restarts, and a new announcement
   * only adds to it. After an edit, therefore, only what differs from the
   * last announcement is sent: a key that is new or changed with its value,
   * and a key the plugin no longer gives, on a path it still publishes or
   * on one it gave up, emptied (see EMPTIED). A path whose metadata is
   * unchanged gets nothing, which also leaves alone any metadata set on it
   * by hand in the server. The record of what was announced is kept only
   * once the server took the message, so a failed send is tried again at
   * the next edit.
   */
  function publishMetadata () {
    const wanted = new Map()
    for (const entry of normalized.entries) {
      if (!entry.enabled || entry.error) continue
      const value = metadataOf(entry)
      if (Object.keys(value).length > 0) wanted.set(entry.output, value)
      if (entry.timeOutput) {
        const time = timeMetadataOf(entry)
        if (Object.keys(time).length > 0) wanted.set(entry.timeOutput, time)
      }
    }
    const meta = []
    for (const [path, before] of announced) {
      if (wanted.has(path)) continue
      const value = {}
      for (const key of Object.keys(before)) value[key] = EMPTIED[key]
      meta.push({ path, value })
    }
    for (const [path, value] of wanted) {
      const before = announced.get(path) || {}
      const change = {}
      for (const key of Object.keys(EMPTIED)) {
        if (key in value) {
          if (value[key] !== before[key]) change[key] = value[key]
        } else if (key in before) {
          change[key] = EMPTIED[key]
        }
      }
      if (Object.keys(change).length > 0) meta.push({ path, value: change })
    }
    if (meta.length > 0) app.handleMessage(PLUGIN_ID, { updates: [{ meta }] })
    announced = wanted
  }

  /**
   * Updates the status line shown on the server's dashboard and plugin
   * list. The text is sent only when it changes, since each call makes the
   * server notify every connected admin page.
   */
  function reportStatus () {
    const counts = engine.summary(monoNow())
    const total = normalized.entries.length
    const parts = []
    if (counts.ok) parts.push(`${counts.ok} publishing`)
    if (counts.waiting) parts.push(`${counts.waiting} waiting for input`)
    if (counts.stale) parts.push(`${counts.stale} stale`)
    if (counts.disabled) parts.push(`${counts.disabled} disabled`)
    if (counts.error) parts.push(`${counts.error} with a configuration error`)

    let text = total === 0
      ? 'No entries configured yet'
      : `${total} ${total === 1 ? 'entry' : 'entries'}: ${parts.join(', ')}`
    if (engine.clockSuspect) text += '. System clock looks unset: period resets are paused until it is correct'
    // Named only when it is followed: a zone that can change by itself is
    // worth seeing at a glance, a fixed setting is not.
    const zone = zones.describe()
    if (zone.source === 'path' || zone.source === 'remembered') text += `. Time zone ${zone.label}`

    const firstError = normalized.entries.find((e) => e.error)
    const problem = applyProblem || stateProblem || normalized.problems[0] || (firstError ? `${firstError.label}: ${firstError.error}` : null)
    const status = problem ? `error|${text}. ${problem}` : `ok|${text}`
    if (status === lastStatus) return
    lastStatus = status

    if (problem) {
      app.setPluginError(`${text}. ${problem}`)
    } else {
      app.setPluginStatus(text)
    }
  }

  /**
   * Publishes values, refreshes the status and saves when due.
   *
   * The timer runs inside the server process, which does not shield itself
   * from plugins: an exception thrown here would take the whole server
   * down. Any failure is therefore caught and reported instead.
   */
  function tick () {
    if (!engine) return
    try {
      flushPending()
      if (++ticksSinceZoneCheck >= ZONE_RECHECK_TICKS) {
        ticksSinceZoneCheck = 0
        const before = zones.zone
        if (zones.recheck(wallNow())) {
          engine.setTimeZone(zones.zone)
          app.debug(`Time zone changed from ${before} to ${zones.zone}: the published name and offset no longer agree`)
        }
      }
      const publications = engine.tick(wallNow(), monoNow())
      if (publications.length > 0) {
        try {
          // One message for the whole pass: a failure concerns all of it,
          // and all of it is handed back below.
          app.handleMessage(PLUGIN_ID, { updates: updatesFor(publications) })
        } catch (err) {
          // The engine sends a value only when it changes, or a null only
          // once, so what did not get out is handed back to be sent again
          // at the next pass.
          engine.republish(publications)
          throw err
        }
      }
      reportStatus()
      runLookbacks()
      if ((engine.dirty || zones.dirty) && monoNow() - lastSaveMono >= SAVE_INTERVAL_MS) save()
    } catch (err) {
      app.error(`Calculation pass failed: ${err.stack || err.message}`)
      app.setPluginError(`Calculation pass failed: ${err.message}`)
      lastStatus = null
    }
  }

  /**
   * Reads the history for the entries that started with nothing saved;
   * see lib/history.js and Engine#lookbackPlans(). The reads run one after
   * the other, in the background, so that the calculations never wait for
   * them, and only one run is under way at a time.
   *
   * What a read found is handed to the engine running when it finishes:
   * an edit made meanwhile carries unchanged entries over to a new engine,
   * and the engine drops what belongs to an entry it no longer runs.
   */
  function runLookbacks () {
    if (!engine || lookingBack) return
    const plans = engine.lookbackPlans(wallNow(), monoNow())
    if (plans.length === 0) return
    lookingBack = true
    const run = ++lookbackRun
    const gone = () => !engine || run !== lookbackRun
    const read = async () => {
      for (const plan of plans) {
        if (gone()) return
        let api = null
        let reason = 'no history provider answered: the History API needs a plugin that provides it, such as signalk-to-influxdb2'
        if (typeof app.getHistoryApi !== 'function') {
          engine.failLookback(plan, 'this Signal K server offers no History API to plugins (it came with version 2.33)', false, wallNow(), monoNow())
          continue
        }
        try {
          api = await app.getHistoryApi()
        } catch (err) {
          if (err && err.message) reason = `no history provider answered (${err.message})`
        }
        if (gone()) return
        if (!api || typeof api.getValues !== 'function') {
          engine.failLookback(plan, reason, true, wallNow(), monoNow())
          app.debug(`Look-back for ${plan.entry.config.output}: ${reason}`)
          continue
        }
        // A read that takes too long is given up: it makes no further
        // request to the provider once the time is out or the plugin stops,
        // so that retries do not pile up reads.
        let timedOut = false
        let timer = null
        try {
          const answer = await Promise.race([
            lookBack(api, plan, () => timedOut || gone()),
            new Promise((resolve, reject) => {
              timer = setTimeout(() => {
                timedOut = true
                reject(new Error(`no answer within ${LOOKBACK_TIMEOUT_MS / 1000} s`))
              }, LOOKBACK_TIMEOUT_MS)
              lookbackTimer = timer
            })
          ])
          if (gone()) return
          engine.applyLookback(plan, answer, wallNow(), monoNow())
          app.debug(`Look-back for ${plan.entry.config.output}: ${answer.reads} reads, ${plan.entry.history ? plan.entry.history.outcome : 'dropped'}`)
        } catch (err) {
          if (gone()) return
          engine.failLookback(plan, `the history could not be read (${err.message})`, true, wallNow(), monoNow())
          app.debug(`Look-back for ${plan.entry.config.output} failed: ${err.message}`)
        } finally {
          // Only this read's own time-out: a read left over from a stopped
          // run must not clear the time-out of a run started since.
          clearTimeout(timer)
          if (lookbackTimer === timer) lookbackTimer = null
        }
      }
    }
    read()
      .catch((err) => app.error(`Look-back failed: ${err.stack || err.message}`))
      .finally(() => {
        if (run !== lookbackRun) return
        lookingBack = false
        if (engine && engine.dirty) save()
      })
  }

  /**
   * Takes in a value from a path that carries the ship's time zone, and
   * tells the engine when the zone in use changes as a result. Values on
   * any other path are ignored here.
   *
   * A zone value is acted on at once and is never held back with the input
   * values: it is not part of a calculation, and the engine only notes the
   * new zone and applies it on its next pass.
   *
   * The value's own time stamp is passed on. The tracker uses it to tell
   * which of a name and an offset was published later, which the order of
   * delivery does not say.
   */
  function zoneInput (path, value, timestamp, source, wall = wallNow()) {
    if (!zones.paths.includes(path)) return
    const before = zones.zone
    if (!zones.input(path, value, wall, Date.parse(timestamp), source)) return
    engine.setTimeZone(zones.zone)
    app.debug(`Time zone changed from ${before} to ${zones.zone}, read from ${path}`)
  }

  /**
   * Handles one delta from the subscription.
   *
   * Metadata for a path travels on the same stream as its values, as an
   * update with a `meta` list and no `values`. Those updates are skipped
   * here; reading `values` on them would throw.
   *
   * A source usually sends related values in one update: a current and a
   * voltage, say. The server splits such an update and calls back once per
   * value, one straight after the other. Feeding them to the engine one by
   * one would calculate a formula over both from one new and one old value,
   * and an entry reading that formula would count the false step. Live
   * values are therefore collected and handed over together once the
   * server has finished delivering: in a microtask, which runs as soon as
   * the current delivery returns.
   *
   * When a subscription is made, the server first replays the values it
   * already holds, synchronously, before subscribe() returns. Those are not
   * fresh: a switch state may be hours old. And there may be several for
   * one path: the server keeps the last value of every source that ever
   * wrote to it, so a device that once appeared under another source name
   * leaves that name's last value behind. While `subscribing` is set the
   * values are therefore only collected; feedHeldValues() then hands over
   * the newest one per path. Live values are stamped on arrival, because a
   * sensor's own clock cannot be relied on for measuring durations.
   */
  function onDelta (delta) {
    if (!engine || !delta || !Array.isArray(delta.updates)) return
    for (const update of delta.updates) {
      if (!update || !Array.isArray(update.values)) continue
      // The source is passed along so that a reset record can name it, and
      // to tell a source's own values from another source's.
      const source = typeof update.$source === 'string' ? update.$source : undefined
      // The clock is read once for the whole update. Time stamps from the
      // future are cut back to it, and the values of one update must come
      // out with equal time stamps: the zone tracker reads a name and an
      // offset with equal stamps as belonging together.
      const wall = wallNow()
      if (subscribing) {
        for (const item of update.values) {
          if (!item || typeof item.path !== 'string') continue
          collectHeld(item.path, item.value, update.timestamp, source, false, wall)
          collectHeldZone(item.path, item.value, update.timestamp, source, wall)
        }
        continue
      }
      for (const item of update.values) {
        if (item && typeof item.path === 'string') zoneInput(item.path, item.value, update.timestamp, source, wall)
      }
      for (const item of update.values) {
        if (!item || typeof item.path !== 'string') continue
        if (isOutdated(item.path, update.timestamp, source, item.value, wall)) continue
        // A second value for a path that is already waiting is a new
        // reading, not part of the same step: what is waiting goes first.
        if (pending.some((waiting) => waiting.path === item.path)) flushPending()
        if (pending.length === 0) {
          pendingWall = wallNow()
          pendingMono = monoNow()
          queueMicrotask(flushPending)
        }
        pending.push({ path: item.path, value: item.value, source })
      }
    }
  }

  /** Hands the collected values to the engine as one step. */
  function flushPending () {
    if (pending.length === 0) return
    const values = pending
    pending = []
    if (!engine) return
    try {
      engine.inputs(values, pendingWall, pendingMono)
    } catch (err) {
      // As in tick(): nothing thrown here may reach the server.
      app.error(`Calculation failed: ${err.stack || err.message}`)
    }
  }

  /**
   * Reads a time stamp for comparing values with each other. One that is
   * missing or unreadable counts as now. So does one from
   * the future: a source with a clock that runs ahead must not outrank
   * every value that arrives after it.
   */
  function stampOf (timestamp, wall) {
    const parsed = Date.parse(timestamp)
    return Number.isFinite(parsed) ? Math.min(parsed, wall) : wall
  }

  /**
   * Notes a value the server already held at start-up, keeping one per
   * path.
   *
   * The value read directly from the server (`direct`) is the one the
   * server itself reports for the path at this moment, and is kept in
   * preference to anything replayed. Among replayed values the newest time
   * stamp wins. That is the best available guess and can be wrong where
   * two sources of one path stamp their values by different clocks.
   */
  function collectHeld (path, value, timestamp, source, direct = false, wall = wallNow()) {
    if (!engine || !engine.external.has(path)) return
    const stamp = stampOf(timestamp, wall)
    // Every held value is remembered, also those not used, so that one
    // handed over again later is recognised; see isOutdated().
    noteSeen(path, source, stamp, value)
    // After an edit the paths read before are already known; see
    // resubscribe().
    if (heldOnly && !heldOnly.has(path)) return
    const known = held.get(path)
    if (known && known.direct && !direct) return
    if (!known || direct || stamp >= known.stamp) held.set(path, { value, stamp, source, direct })
  }

  /**
   * Notes a held value of a path that carries the ship's time zone, newest
   * per path. Applied one after the other, an old source's last value and
   * the current one would be recorded as a change of zone at every start.
   */
  function collectHeldZone (path, value, timestamp, source, wall = wallNow()) {
    if (!zones || !zones.paths.includes(path) || heldOnly) return
    const stamp = stampOf(timestamp, wall)
    const known = heldZones.get(path)
    if (!known || stamp >= known.stamp) heldZones.set(path, { value, timestamp, stamp, source })
  }

  /**
   * Reads the values the server holds for the input paths.
   *
   * An input that is sent rarely, such as a switch state, would otherwise
   * leave its entries waiting, possibly for hours. Signal K server 2.33
   * replays held values when a subscription is made (see onDelta), which
   * covers the same need; this direct read makes the plugin independent of
   * that behaviour. A value found both ways is kept once.
   */
  function collectCurrentValues (paths) {
    const wall = wallNow()
    for (const path of paths) {
      let node
      try {
        node = app.getSelfPath(path)
      } catch (err) {
        continue
      }
      if (!node || typeof node !== 'object' || !('value' in node)) continue
      collectHeld(path, node.value, node.timestamp, typeof node.$source === 'string' ? node.$source : undefined, true, wall)
    }
  }

  /**
   * Hands the engine the newest held value of each path.
   *
   * Only one value per path counts. Fed one after the other, an old source
   * name's last value followed by the current one would look like a change
   * that never happened: a counter would add the difference, and a total
   * that resets when a path falls would be cleared at every start.
   *
   * Each value goes in with its real age, taken from its time stamp, so
   * that the stale timeout judges it correctly, and with the present moment
   * as the point from which an integration may start adding up. The wall
   * time stays "now": it decides which period the value falls in, and an
   * old value must not reopen yesterday's period. Values that came in one
   * update are handed over together, oldest update first.
   */
  function feedHeldValues () {
    const wall = wallNow()
    const mono = monoNow()
    const updates = new Map()
    for (const [path, item] of held) {
      const key = `${item.stamp}|${item.source || ''}`
      if (!updates.has(key)) updates.set(key, { stamp: item.stamp, values: [] })
      updates.get(key).values.push({ path, value: item.value, source: item.source })
      latest.set(path, { stamp: item.stamp, source: item.source })
    }
    held = new Map()
    for (const [path, item] of heldZones) zoneInput(path, item.value, item.timestamp, item.source, wall)
    heldZones = new Map()
    for (const update of [...updates.values()].sort((a, b) => a.stamp - b.stamp)) {
      engine.inputs(update.values, wall, mono - Math.max(0, wall - update.stamp), mono)
    }
  }

  /** Remembers the last time stamp and value seen from one source of one path. */
  function noteSeen (path, source, stamp, value) {
    if (!seenBySource.has(path)) seenBySource.set(path, new Map())
    seenBySource.get(path).set(source || '', { stamp, value })
  }

  /**
   * Whether a live value is an old one handed over again, and not a new
   * reading.
   *
   * The server keeps the last value of every source that ever wrote to a
   * path, with the time stamp it arrived with, and can pass such a value on
   * long after the source has gone quiet. Taken as a new reading it would
   * undo the current one for a moment: a period counter would add the
   * difference, and a total that resets when a path falls would be cleared.
   *
   * Time stamps of different sources need not share a clock, so "older
   * than the current value" alone proves little. What marks a held value
   * is that it does not move: handed over again it carries the same time
   * stamp and the same value. Two rules follow, and both apply only to a
   * source other than the one last read:
   *
   * 1. A value from a source seen before on this path is turned away only
   *    when it repeats exactly what that source sent last. Anything else
   *    from it is a new reading, whatever its clock says: the clock may run
   *    behind, or may have been set back.
   * 2. A value from a source not seen before is turned away when it is
   *    older than the value last read. This is the one case that rests on
   *    comparing two clocks.
   *
   * Every value the server held at start-up counts as seen, so an old
   * source name's leftover falls under the first rule from the beginning.
   * Values of the source last read are never turned away, so a recorded
   * log that is played again from its beginning is still read.
   */
  function isOutdated (path, timestamp, source, value, wall) {
    if (!engine.external.has(path)) return false
    const parsed = Date.parse(timestamp)
    if (!Number.isFinite(parsed)) return false
    const stamp = Math.min(parsed, wall)
    const known = latest.get(path)
    const sources = seenBySource.get(path)
    const before = sources ? sources.get(source || '') : undefined
    noteSeen(path, source, stamp, value)
    const repeated = before !== undefined && before.stamp === stamp && Object.is(before.value, value)
    if (known && source !== known.source && (before !== undefined ? repeated : stamp < known.stamp)) {
      outdated.count++
      outdated.last = { path, source: source || null, timestamp: new Date(stamp).toISOString(), at: new Date(wall).toISOString() }
      app.debug(`Ignored a value on ${path} from ${source || 'an unnamed source'} stamped ${outdated.last.timestamp}: an old value handed over again while ${known.source || 'an unnamed source'} is being read`)
      return true
    }
    latest.set(path, { stamp, source })
    return false
  }

  /**
   * Subscribes to the paths the engine reads and the paths that carry the
   * ship's time zone, and hands over the values the server already holds.
   *
   * After an edit of the entries the subscription is made afresh only when
   * the set of paths changed, and held values are taken in only for paths
   * that are new: the entries that kept running already know the others.
   */
  function resubscribe (initial) {
    const wanted = new Set([...engine.externalPaths, ...zones.paths])
    const added = [...wanted].filter((path) => !subscribedPaths.has(path))
    const removed = [...subscribedPaths].filter((path) => !wanted.has(path))
    if (!initial && added.length === 0 && removed.length === 0) return
    for (const unsubscribe of unsubscribes) {
      try {
        unsubscribe()
      } catch (err) {
        app.debug(`Unsubscribe failed: ${err.message}`)
      }
    }
    unsubscribes = []
    // Recorded as covered only once the subscription is made, so that a
    // failed one is made again at the next save.
    subscribedPaths = new Set()
    if (wanted.size === 0) return

    const canSubscribe = app.subscriptionmanager && typeof app.subscriptionmanager.subscribe === 'function'
    if (!canSubscribe) {
      app.error('The server offers no subscription manager, so no input values can be read.')
      return
    }
    heldOnly = initial ? null : new Set(added)
    collectCurrentValues(engine.externalPaths.filter((path) => initial || heldOnly.has(path)))
    // No period or minPeriod is given on purpose: the server then passes
    // every value through as it arrives. An integration needs each value
    // at its own time, and a subscription with a period would hand them
    // over in batches.
    subscribing = true
    try {
      app.subscriptionmanager.subscribe(
        {
          context: 'vessels.self',
          subscribe: [...wanted].map((path) => ({ path }))
        },
        unsubscribes,
        (err) => app.error(`Subscription error: ${err}`),
        onDelta
      )
      subscribedPaths = wanted
    } finally {
      subscribing = false
      heldOnly = null
    }
    feedHeldValues()
  }

  /**
   * Reads the full plugin options, for the copy kept when entries are moved
   * out of the settings. A server without readPluginOptions() gives only
   * the configuration the plugin was started with.
   */
  function fullOptions (options) {
    try {
      const stored = app.readPluginOptions()
      if (stored && typeof stored === 'object') return stored
    } catch (err) {
      // Fall through to the configuration in hand.
    }
    return { configuration: options }
  }

  /**
   * Moves entries found in the plugin settings, where versions before 0.3.0
   * kept them, into the entries file, and removes them from the settings.
   *
   * 1. With no entries file yet, the entries are written into a new one, in
   *    the order the status page showed them, without groups.
   * 2. With an entries file already there, it stays in charge: the entries
   *    in the settings are not used. This happens after going back to
   *    0.2.1 and forward again.
   *
   * Either way the settings as they were are kept as a file first, and the
   * lists are removed only once everything else is written, so nothing can
   * be lost part-way. Returns the document to run.
   */
  function takeOverLists (current, options, dir) {
    if (!store.hasListEntries(options)) return current || { version: store.ENTRIES_VERSION, groups: [], entries: [] }
    let document = current
    try {
      const copy = store.keepSettingsCopy(dir, fullOptions(options))
      if (!document) {
        document = store.documentFromLists(options)
        store.saveEntries(dir, document)
        const count = document.entries.length
        notes.push(`${count === 1 ? 'The entry was' : `The ${count} entries were`} moved from the plugin settings into the editor on this page. The plugin settings as they were are kept as ${copy} in the plugin's data folder.`)
        app.debug(`Moved ${count} entries from the plugin settings into ${store.ENTRIES_FILE}; settings kept as ${copy}`)
      } else {
        notes.push(`The plugin settings held entries, which were not used: the entries are kept in the editor on this page. The settings as they were are kept as ${copy} in the plugin's data folder.`)
      }
    } catch (err) {
      // Nothing could be written. The entries run from the settings this
      // time, and the settings are left alone.
      app.error(`Could not move the entries out of the plugin settings: ${err.message}`)
      notes.push(`The entries could not be moved out of the plugin settings (${err.message}). They run from the settings until this is fixed.`)
      return document || store.documentFromLists(options)
    }
    if (typeof app.savePluginOptions === 'function') {
      app.savePluginOptions(store.withoutLists(options), (err) => {
        if (err) app.error(`Could not remove the entries from the plugin settings: ${err.message}`)
      })
    }
    return document
  }

  /** Starts the engine on a set of entries. */
  function startEngine (document, loadedState) {
    doc = document
    normalized = normalizeConfig(settingsOptions, doc)
    zones = new ZoneTracker(normalized.settings.zone, loadedState ? loadedState.zone : null)
    // The zone the server already holds is read before the engine exists,
    // so that the engine starts in the right zone and no total sees a
    // change of zone that is only the plugin catching up.
    const zoneWall = wallNow()
    for (const path of zones.paths) {
      let node
      try {
        node = app.getSelfPath(path)
      } catch (err) {
        continue
      }
      if (node && typeof node === 'object' && 'value' in node) {
        zones.input(path, node.value, zoneWall, Date.parse(node.timestamp), typeof node.$source === 'string' ? node.$source : undefined)
      }
    }

    engine = new Engine(normalized, loadedState, zones.zone)
    held = new Map()
    heldZones = new Map()
    latest = new Map()
    seenBySource = new Map()
    outdated = { count: 0, last: null }
    // Announced afresh at every start: the server may have restarted, and
    // a plugin that stopped and started again has no record from before.
    announced = new Map()
    subscribedPaths = new Set()
    lastStatus = null
    lastSaveMono = monoNow()
    ticksSinceZoneCheck = 0

    for (const problem of normalized.problems) app.error(problem)
    for (const entry of normalized.entries) {
      if (entry.error) app.error(`${entry.label}: ${entry.error}`)
    }
    const zone = zones.describe()
    app.debug(`Starting with ${normalized.entries.length} entries, time zone ${zone.label} (${zone.source}), reading ${engine.externalPaths.length} paths`)

    publishMetadata()
    // The paths that carry the ship's time zone are subscribed to together
    // with the input paths. They change rarely, and the server passes each
    // value on as it arrives.
    resubscribe(true)

    // One pass at once, not a second from now: period boundaries that
    // passed while the plugin was stopped are applied before anyone reads
    // the status, and saved totals that are to be published go out.
    tick()
    tickTimer = setInterval(tick, TICK_MS)
    exitListener = () => {
      try {
        flushPending()
      } catch (err) {
        // The values not yet taken in are lost; the totals are still saved.
      }
      save()
    }
    // First in line: a listener of another plugin that throws stops every
    // listener after it.
    process.prependListener('exit', exitListener)
    reportStatus()
  }

  plugin.start = function (options) {
    // The server stops a plugin before starting it again, but nothing is
    // lost by making sure: a second timer or subscription left running
    // would publish every value twice.
    plugin.stop()
    running = true
    settingsOptions = options && typeof options === 'object' ? options : {}
    startedAt = wallNow()
    startedTimeZone = settingsOptions.timeZone
    notes = []
    blocked = null
    applyProblem = null
    const dir = app.getDataDirPath()

    const loadedEntries = store.loadEntries(dir)
    if (loadedEntries.error) {
      // The entries cannot be read, so none run, and nothing is saved: a
      // save now would write state without the totals of those entries.
      // The file stays as it is until a new set is saved from the page,
      // which moves it aside first.
      blocked = loadedEntries.error
      app.error(blocked)
      app.setPluginError(`${blocked}. No entries are running. The file has been left as it is; saving entries on the Calculated Paths page moves it aside and starts a new set.`)
      return
    }
    const document = takeOverLists(loadedEntries.doc, settingsOptions, dir)
    startEngine(document, readState(dir))
  }

  /**
   * Reads the state file and notes what is wrong with it, for the status
   * and for save(). Returns the state, or null to start every total afresh.
   */
  function readState (dir) {
    const loaded = loadState(dir)
    stateProblem = loaded.error
    stateUnreadable = loaded.unreadable === true
    if (stateProblem) app.error(stateProblem)
    return loaded.state
  }

  /**
   * Puts an edited set of entries to work: saves it, and replaces the
   * engine with one that takes over every entry that still calculates the
   * same thing as it is. Changed and new entries start, from their saved
   * totals where they still measure the same thing. Returns how many
   * entries kept running and how many started.
   */
  function applyDocument (document) {
    const dir = app.getDataDirPath()
    if (blocked) {
      const setAside = store.replaceUnreadable(dir, document)
      if (setAside) notes.push(`The entries file that could not be used was moved aside as ${setAside}.`)
    } else {
      store.saveEntries(dir, document)
    }

    if (!engine) {
      // Totals saved for outputs the new set does not use are kept in the
      // state file for 30 days; see Engine#serialize().
      blocked = null
      startEngine(document, readState(dir))
      return { kept: 0, started: normalized.entries.filter((e) => e.enabled && !e.error).length }
    }

    flushPending()
    const next = normalizeConfig(settingsOptions, document)
    const saved = engine.serialize(wallNow())
    const replacement = new Engine(next, saved, zones.zone, engine)
    const started = replacement.fresh.size
    const kept = replacement.entries.filter((e) => e.active).length - started
    engine = replacement
    normalized = next
    doc = document

    for (const entry of normalized.entries) {
      if (entry.error) app.error(`${entry.label}: ${entry.error}`)
    }
    app.debug(`Entries saved: ${kept} kept running, ${started} started`)
    // The set is saved and running from here on. What follows can fail
    // without undoing that, so a failure is reported, not thrown.
    let warning = null
    try {
      publishMetadata()
      // Entries that were running already hold the latest values; the new
      // ones get them first, then any path read for the first time is
      // subscribed to and its held value taken in.
      engine.prime(wallNow(), monoNow())
      resubscribe(false)
      save()
    } catch (err) {
      warning = `The entries were saved, but starting them did not complete: ${err.message}. Restarting the plugin starts them afresh.`
      app.error(`${warning} ${err.stack || ''}`)
    }
    applyProblem = warning
    lastStatus = null
    reportStatus()
    return { kept, started, warning }
  }

  plugin.stop = function () {
    if (tickTimer) clearInterval(tickTimer)
    tickTimer = null
    // A look-back under way ends at its next step; see runLookbacks().
    lookbackRun++
    lookingBack = false
    clearTimeout(lookbackTimer)
    lookbackTimer = null
    if (exitListener) process.removeListener('exit', exitListener)
    exitListener = null
    for (const unsubscribe of unsubscribes) {
      try {
        unsubscribe()
      } catch (err) {
        app.debug(`Unsubscribe failed: ${err.message}`)
      }
    }
    unsubscribes = []
    subscribedPaths = new Set()
    flushPending()
    // Saving on the way out: switching the plugin off, saving its settings,
    // and from server 2.34.0 a stop by signal (systemctl), lose nothing.
    if (engine) save()
    engine = null
    normalized = null
    zones = null
    // A file found unusable at this start is looked at afresh at the next;
    // until then the routes answer as for a stopped plugin.
    blocked = null
    stateUnreadable = false
    running = false
  }

  /** Identifies a version of the entries, so that two editors cannot overwrite each other unawares. */
  function revisionOf (document) {
    return crypto.createHash('sha256').update(JSON.stringify(document)).digest('hex').slice(0, 16)
  }

  /**
   * The current value of a path for the editor: an entry's own result when
   * an entry publishes the path, otherwise what the server holds.
   */
  function currentValue (path) {
    const producer = engine && engine.byOutput.get(path)
    if (producer) return producer.value
    try {
      const node = app.getSelfPath(path)
      return node && typeof node === 'object' && 'value' in node ? node.value : undefined
    } catch (err) {
      return undefined
    }
  }

  /**
   * Why the preview counts an input as its value when stale, as the engine
   * would: 'none' for a path that has had nothing, 'invalid' for one that
   * holds no number, 'stale' for one older than the stale timeout, null to
   * read it as it is. The output of an entry counts as what that entry
   * sends: nothing before its first input since start, unless its saved
   * total goes out; no number while it is not publishing or has no result.
   */
  function previewReason (path, raw, value, staleMs) {
    const producer = engine && engine.byOutput.get(path)
    if (producer) {
      if (producer.inputMono === null && !engine.publishing(producer, monoNow())) return 'none'
      if (value === null || !engine.publishing(producer, monoNow())) return 'invalid'
    } else {
      if (raw === undefined) return 'none'
      if (value === null) return 'invalid'
    }
    const age = valueAge(path)
    return staleMs > 0 && age !== null && age > staleMs ? 'stale' : null
  }

  /**
   * How old the value of a path is, in milliseconds, or null when that is
   * not known. The plugin's own record of when it received the value comes
   * first; for a path it does not read, the server's time stamp, which is
   * set by the source's clock.
   */
  function valueAge (path) {
    const producer = engine && engine.byOutput.get(path)
    if (producer) return producer.inputMono === null ? null : monoNow() - producer.inputMono
    const last = engine && engine.lastExternal.get(path)
    if (last) return monoNow() - last.mono
    try {
      const node = app.getSelfPath(path)
      const stamp = node && typeof node === 'object' ? Date.parse(node.timestamp) : NaN
      return Number.isFinite(stamp) ? Math.max(0, Date.now() - stamp) : null
    } catch (err) {
      return null
    }
  }

  /**
   * Why a formula sent for a preview could not be saved as it is, or null:
   * an expression or a path longer than an entry may hold, more inputs than
   * an entry may have, or a short name a save would refuse or that is used
   * twice. The messages follow those of a save.
   */
  function previewProblem (count, inputs, expression) {
    if (expression.length > store.MAX_TEXT) return `the expression is longer than ${store.MAX_TEXT} characters`
    if (count > store.MAX_INPUTS) return `the formula has more than ${store.MAX_INPUTS} inputs`
    const seen = new Set()
    for (const input of inputs) {
      if (input.name.length > store.MAX_TEXT || input.path.length > store.MAX_TEXT) return `an input has a text longer than ${store.MAX_TEXT} characters`
      const nameProblem = checkName(input.name)
      if (nameProblem) return nameProblem
      if (seen.has(input.name)) return `the short name "${input.name}" is used twice`
      seen.add(input.name)
    }
    return null
  }

  /**
   * HTTP interface under /plugins/signalk-calc-paths.
   *
   * Plugin routes are admin-only unless registered through router.access().
   * Reading the status is opened to any logged-in user. Resetting a total
   * and everything the editor uses is opened to users who may write. Servers
   * that predate router.access() fall back to plain registration, which
   * keeps every route admin-only.
   */
  plugin.registerWithRouter = function (router) {
    // The routes stay registered while the plugin is switched off, and the
    // page may still be open; each says so instead of acting.
    const notRunning = (res) => res.status(503).json({ error: 'The plugin is not running. On its configuration page, turn on Enabled where it is shown and click Save Configuration.' })

    const listEntries = (req, res) => {
      if (running && !engine && blocked) {
        res.status(503).json({ error: blocked, blocked: true })
        return
      }
      if (!running || !engine) {
        notRunning(res)
        return
      }
      const settings = normalized.settings
      const pad = (n) => String(n).padStart(2, '0')
      const zone = zones.describe()
      res.json({
        version: packageInfo.version,
        startedAt: new Date(startedAt).toISOString(),
        // The zone in use, which may be a followed one and not the setting.
        timeZone: zone.timeZone,
        timeZoneLabel: zone.label,
        timeZoneSource: {
          kind: zone.source,
          follow: zone.follow,
          paths: zone.paths,
          path: zone.path,
          since: zone.since,
          lastChange: zone.lastChange,
          fallback: settings.zone.fallback,
          problem: zone.problem
        },
        dayStart: `${pad(Math.floor(settings.dayStartMinutes / 60))}:${pad(settings.dayStartMinutes % 60)}`,
        clockTrusted: !engine.clockSuspect,
        // Values turned away since the plugin started; see isOutdated().
        outdatedValues: { count: outdated.count, last: outdated.last },
        problems: [stateProblem, ...normalized.problems].filter(Boolean),
        notes,
        groups: doc.groups,
        entries: engine.snapshot(wallNow(), monoNow()).map(withInputUnit)
      })
    }

    // A record's level is set in its input's unit, which the status page
    // needs to show it; the server's metadata of the input holds it.
    const withInputUnit = (item) => {
      if (item.type !== 'record' || !item.inputs[0]) return item
      let node
      try {
        node = app.getSelfPath(item.inputs[0])
      } catch (err) {
        node = undefined
      }
      const units = node && typeof node === 'object' && node.meta && typeof node.meta.units === 'string' ? node.meta.units : null
      return { ...item, inputUnit: units }
    }

    // A browser lets a page of any site post a form, with the user's login
    // cookie, to any address: as form data or plain text, but never as
    // JSON. A request that is JSON either comes from a page of the server
    // itself or has passed the server's CORS check. The reset clears a
    // total for good, so it accepts only that.
    const resetEntry = (req, res) => {
      if (!isJson(req)) {
        res.status(415).json({ error: 'A reset must be sent with Content-Type: application/json.' })
        return
      }
      if (!running || !engine) {
        res.status(503).json({ error: 'The plugin is not running.' })
        return
      }
      const id = req.params.id
      if (!engine.reset(id, wallNow(), monoNow())) {
        res.status(404).json({ error: `No running counter, integration, cycles entry or record of a lowest or highest value publishes ${id}.` })
        return
      }
      app.debug(`Total reset by request: ${id}`)
      save()
      res.json({ reset: id })
    }

    // The entries as saved, with the field definitions the editor builds
    // its forms from.
    const getConfig = (req, res) => {
      if (!running || (!engine && !blocked)) {
        notRunning(res)
        return
      }
      const document = blocked ? { version: store.ENTRIES_VERSION, groups: [], entries: [] } : doc
      res.json({
        ...document,
        revision: blocked ? null : revisionOf(document),
        blocked: blocked || null,
        fields: entryFields,
        order: entryOrder,
        advanced: entryAdvanced
      })
    }

    // Saves an edited set of entries. The set is refused as a whole when its
    // structure is wrong, when it was changed elsewhere since the editor
    // read it, or when an entry that is switched on cannot run; the answer
    // then names each fault and the entry it belongs to. An entry that is
    // switched off may be saved unfinished.
    const putConfig = (req, res) => {
      // A save puts the entries to work, which starts the engine when the
      // entries file could not be used; a plugin switched off must stay off.
      if (!running || (!engine && !blocked)) {
        notRunning(res)
        return
      }
      const body = req.body && typeof req.body === 'object' ? req.body : {}
      // The revision read is required, so that no client overwrites a set
      // it has not seen.
      if (!blocked && body.revision !== revisionOf(doc)) {
        res.status(409).json({ error: body.revision === undefined ? 'The revision of the entries read is missing. Read the entries first and send their revision with the save.' : 'The entries were changed elsewhere since this editor read them. Reload the editor to see the current entries.' })
        return
      }
      const { doc: checked, errors } = store.checkDocument({ version: store.ENTRIES_VERSION, groups: body.groups, entries: body.entries }, true)
      if (!checked) {
        res.status(400).json({ error: 'The entries could not be saved.', errors })
        return
      }
      const candidate = normalizeConfig(settingsOptions, checked)
      // entryErrors names each entry's first fault, entryFaults every fault
      // with the field it lies in, for the editor to mark.
      const entryErrors = Object.create(null)
      const entryFaults = Object.create(null)
      let refused = 0
      for (const entry of candidate.entries) {
        if (!entry.error) continue
        entryErrors[entry.id] = entry.error
        entryFaults[entry.id] = entry.faults
        if (entry.enabled) refused++
      }
      if (refused > 0) {
        res.status(400).json({ error: `${refused === 1 ? 'One entry' : `${refused} entries`} cannot run as set. Nothing was saved.`, entryErrors, entryFaults })
        return
      }
      let outcome
      try {
        outcome = applyDocument(checked)
      } catch (err) {
        // The message can name the data folder's full path, which is no
        // business of a client; the server log keeps the whole of it.
        app.error(`Could not save the entries: ${err.stack || err.message}`)
        res.status(500).json({ error: 'The entries could not be saved. The server log has the details.' })
        return
      }
      res.json({ saved: true, revision: revisionOf(doc), ...outcome, entryErrors, entryFaults })
    }

    // Every path the server knows on this vessel, with its current value and
    // unit, for the path suggestions of the editor. Objects such as a
    // position are named by kind only: they cannot be calculated with.
    const listPaths = (req, res) => {
      const paths = new Set()
      try {
        const available = app.streambundle && typeof app.streambundle.getAvailablePaths === 'function' ? app.streambundle.getAvailablePaths() : []
        for (const path of available) if (typeof path === 'string' && path !== '') paths.add(path)
      } catch (err) {
        app.debug(`Could not list the available paths: ${err.message}`)
      }
      if (normalized) for (const entry of normalized.entries) if (entry.output) paths.add(entry.output)
      const result = []
      for (const path of [...paths].sort()) {
        let node
        try {
          node = app.getSelfPath(path)
        } catch (err) {
          node = undefined
        }
        const meta = node && typeof node === 'object' && node.meta && typeof node.meta === 'object' ? node.meta : {}
        const value = currentValue(path)
        const item = { path }
        if (typeof value === 'number' || typeof value === 'boolean') item.value = value
        else item.kind = value === null ? 'null' : value === undefined ? 'none' : typeof value
        if (typeof meta.units === 'string') item.units = meta.units
        if (typeof meta.description === 'string') item.description = meta.description
        const producer = normalized && normalized.entries.find((entry) => entry.output === path)
        if (producer) item.entry = producer.id
        result.push(item)
      }
      res.json(result)
    }

    // Works out a formula on the current values, as the editor's preview.
    const preview = (req, res) => {
      if (!running) {
        notRunning(res)
        return
      }
      const body = req.body && typeof req.body === 'object' ? req.body : {}
      const inputs = Array.isArray(body.inputs) ? body.inputs.filter((i) => i && typeof i.name === 'string' && typeof i.path === 'string') : []
      const expression = typeof body.expression === 'string' ? body.expression : ''
      // What a save refuses is refused here too, with the same limits and
      // the same check of the short names: the editor asks for a preview as
      // a formula is typed, and a preview must not work out what can never
      // be saved, nor take the time a very long expression takes to parse.
      const problem = previewProblem(Array.isArray(body.inputs) ? body.inputs.length : 0, inputs, expression)
      if (problem) {
        res.json({ error: problem })
        return
      }
      let compiled
      try {
        compiled = compileFormula(expression, inputs.map((i) => i.name))
      } catch (err) {
        res.json({ error: err.message })
        return
      }
      // An input with a value for when it is stale is counted as that value
      // as the running entry would count it: while its value is missing,
      // not a number, or older than the stale timeout given.
      // As in the entries file: left out or emptied means the default.
      const stale = body.staleTimeout === null || body.staleTimeout === undefined || body.staleTimeout === '' ? NaN : Number(body.staleTimeout)
      const staleMs = Number.isFinite(stale) && stale >= 0 ? stale * 1000 : 60000
      const values = {}
      const missing = []
      const substituted = []
      for (const input of inputs) {
        const whenStale = input.whenStale === null || input.whenStale === undefined || input.whenStale === '' ? NaN : Number(input.whenStale)
        const raw = currentValue(input.path)
        const value = toNumber(raw)
        if (Number.isFinite(whenStale)) {
          const reason = previewReason(input.path, raw, value, staleMs)
          if (reason) {
            values[input.name] = whenStale
            substituted.push({ name: input.name, path: input.path, value: whenStale, reason })
            continue
          }
        }
        if (value === null) missing.push(input.path)
        else values[input.name] = value
      }
      // Named only when there are any, so the answer is as before otherwise.
      const extra = substituted.length > 0 ? { substituted } : {}
      if (missing.length > 0) {
        res.json({ missing, ...extra })
        return
      }
      const value = compiled.evaluate(values)
      res.json(value === null ? { error: 'The expression gives no finite number for the current values.', ...extra } : { value, values, ...extra })
    }

    if (typeof router.access === 'function') {
      router.access('readonly').get('/api/entries', listEntries)
      router.access('readwrite').post('/api/entries/:id/reset', resetEntry)
      router.access('readwrite').get('/api/config', getConfig)
      router.access('readwrite').put('/api/config', putConfig)
      router.access('readwrite').get('/api/paths', listPaths)
      router.access('readwrite').post('/api/preview', preview)
    } else {
      router.get('/api/entries', listEntries)
      router.post('/api/entries/:id/reset', resetEntry)
      router.get('/api/config', getConfig)
      router.put('/api/config', putConfig)
      router.get('/api/paths', listPaths)
      router.post('/api/preview', preview)
    }
  }

  /**
   * The configuration form, built each time the admin UI asks for it.
   *
   * The time zone field is a list. The form replaces a saved value that is
   * not in its list with the default as soon as it is opened, and would then
   * save "the server's own time zone" over a zone the plugin accepts and
   * runs with: a name the runtime knows but does not list, or a spelling of
   * its own. The saved zone is therefore added to the list. It is read from
   * the saved configuration, so that this also works while the plugin is
   * disabled, and falls back to the configuration last started with.
   */
  plugin.schema = function () {
    let saved = startedTimeZone
    try {
      const stored = app.readPluginOptions()
      if (stored && stored.configuration && typeof stored.configuration === 'object' && 'timeZone' in stored.configuration) {
        saved = stored.configuration.timeZone
      }
    } catch (err) {
      // A server without readPluginOptions() leaves the last started value.
    }
    return schemaFor(saved)
  }

  plugin.getOpenApi = () => openApi(packageInfo.version)

  return plugin
}
