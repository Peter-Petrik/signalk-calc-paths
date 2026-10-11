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
 * engine hands back, saves the engine's state, and serves the small HTTP
 * interface used by the page under Webapps. It also reads the paths that
 * carry the ship's time zone and tells the engine when the zone changes.
 */

const { performance } = require('perf_hooks')

const { normalizeConfig } = require('./lib/config')
const { Engine } = require('./lib/engine')
const openApi = require('./lib/openapi')
const { schemaFor, uiSchema } = require('./lib/schema')
const { loadState, saveState } = require('./lib/state')
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

module.exports = function (app) {
  const plugin = {
    id: PLUGIN_ID,
    name: 'Calculated Paths',
    description: 'Calculate new paths from existing ones: formulas over live values, daily/weekly/monthly/yearly counters on running totals, and integration of a rate over time.',
    uiSchema
  }

  // The time zone chosen in the configuration last started with. See
  // plugin.schema below.
  let startedTimeZone

  let engine = null
  let normalized = null
  // Decides which time zone is in use; see lib/timezone.js.
  let zones = null
  let stateProblem = null
  let unsubscribes = []
  let tickTimer = null
  let lastSaveMono = 0
  let ticksSinceZoneCheck = 0
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

  // Both clocks are read through these two functions so that every value
  // and every tick is stamped the same way.
  const wallNow = () => Date.now()
  const monoNow = () => performance.now()

  /**
   * Writes the engine state to the plugin's data directory. A failed save
   * is reported and retried on the next interval; it never stops the
   * calculations.
   */
  function save () {
    if (!engine) return
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
   */
  function publishMetadata () {
    const meta = []
    for (const entry of normalized.entries) {
      if (!entry.enabled || entry.error) continue
      const value = {}
      if (entry.unit) value.units = entry.unit
      if (entry.name) {
        value.displayName = entry.name
        value.description = entry.name
      }
      if (Object.keys(value).length > 0) meta.push({ path: entry.output, value })
    }
    if (meta.length > 0) app.handleMessage(PLUGIN_ID, { updates: [{ meta }] })
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
    const problem = stateProblem || normalized.problems[0] || (firstError ? `${firstError.label}: ${firstError.error}` : null)
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
        app.handleMessage(PLUGIN_ID, {
          updates: [{ values: publications.map(({ path, value }) => ({ path, value })) }]
        })
      }
      reportStatus()
      if ((engine.dirty || zones.dirty) && monoNow() - lastSaveMono >= SAVE_INTERVAL_MS) save()
    } catch (err) {
      app.error(`Calculation pass failed: ${err.stack || err.message}`)
      app.setPluginError(`Calculation pass failed: ${err.message}`)
      lastStatus = null
    }
  }

  /**
   * How old a value is, from the timestamp the server keeps with it. A
   * timestamp that is missing, unreadable or in the future (a source with
   * a wrong clock) is read as "just now" rather than as a negative age.
   */
  function ageOf (timestamp, wall) {
    const stamped = Date.parse(timestamp)
    return Number.isFinite(stamped) ? Math.max(0, wall - stamped) : 0
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
   * missing or unreadable counts as now, as in ageOf(). So does one from
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
    if (!zones || !zones.paths.includes(path)) return
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

  plugin.start = function (options) {
    // The server stops a plugin before starting it again, but nothing is
    // lost by making sure: a second timer or subscription left running
    // would publish every value twice.
    plugin.stop()
    normalized = normalizeConfig(options)
    startedAt = wallNow()
    startedTimeZone = options && typeof options === 'object' ? options.timeZone : undefined

    const loaded = loadState(app.getDataDirPath())
    stateProblem = loaded.error
    if (stateProblem) app.error(stateProblem)

    zones = new ZoneTracker(normalized.settings.zone, loaded.state ? loaded.state.zone : null)
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

    engine = new Engine(normalized, loaded.state, zones.zone)
    held = new Map()
    heldZones = new Map()
    latest = new Map()
    seenBySource = new Map()
    outdated = { count: 0, last: null }
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
    const subscribed = [...new Set([...engine.externalPaths, ...zones.paths])]
    const canSubscribe = app.subscriptionmanager && typeof app.subscriptionmanager.subscribe === 'function'
    if (subscribed.length > 0 && !canSubscribe) {
      app.error('The server offers no subscription manager, so no input values can be read.')
    } else if (subscribed.length > 0) {
      collectCurrentValues(engine.externalPaths)
      // No period or minPeriod is given on purpose: the server then passes
      // every value through as it arrives. An integration needs each value
      // at its own time, and a subscription with a period would hand them
      // over in batches.
      subscribing = true
      try {
        app.subscriptionmanager.subscribe(
          {
            context: 'vessels.self',
            subscribe: subscribed.map((path) => ({ path }))
          },
          unsubscribes,
          (err) => app.error(`Subscription error: ${err}`),
          onDelta
        )
      } finally {
        subscribing = false
      }
      feedHeldValues()
    }

    // One pass at once, not a second from now: period boundaries that
    // passed while the plugin was stopped are applied before anyone reads
    // the status, and saved totals that are to be published go out.
    tick()
    tickTimer = setInterval(tick, TICK_MS)
    reportStatus()
  }

  plugin.stop = function () {
    if (tickTimer) clearInterval(tickTimer)
    tickTimer = null
    for (const unsubscribe of unsubscribes) {
      try {
        unsubscribe()
      } catch (err) {
        app.debug(`Unsubscribe failed: ${err.message}`)
      }
    }
    unsubscribes = []
    flushPending()
    // Saving on the way out means a restart from the admin UI costs nothing.
    if (engine) save()
    engine = null
    normalized = null
    zones = null
  }

  /**
   * HTTP interface under /plugins/signalk-calc-paths.
   *
   * Plugin routes are admin-only unless registered through router.access().
   * Reading the status is opened to any logged-in user and resetting a
   * total to users who may write. Servers that predate router.access()
   * fall back to plain registration, which keeps both routes admin-only.
   */
  plugin.registerWithRouter = function (router) {
    const listEntries = (req, res) => {
      if (!engine) {
        res.status(503).json({ error: 'The plugin is not running. Enable it on its configuration page.' })
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
        entries: engine.snapshot(wallNow(), monoNow())
      })
    }

    const resetEntry = (req, res) => {
      if (!engine) {
        res.status(503).json({ error: 'The plugin is not running.' })
        return
      }
      const id = req.params.id
      if (!engine.reset(id, wallNow(), monoNow())) {
        res.status(404).json({ error: `No counter or integration publishes ${id}.` })
        return
      }
      app.debug(`Total reset by request: ${id}`)
      save()
      res.json({ reset: id })
    }

    if (typeof router.access === 'function') {
      router.access('readonly').get('/api/entries', listEntries)
      router.access('readwrite').post('/api/entries/:id/reset', resetEntry)
    } else {
      router.get('/api/entries', listEntries)
      router.post('/api/entries/:id/reset', resetEntry)
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
