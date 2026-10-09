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
 * interface used by the page under Webapps.
 */

const { performance } = require('perf_hooks')

const { normalizeConfig } = require('./lib/config')
const { Engine } = require('./lib/engine')
const openApi = require('./lib/openapi')
const { schema, uiSchema } = require('./lib/schema')
const { loadState, saveState } = require('./lib/state')
const packageInfo = require('./package.json')

const PLUGIN_ID = 'signalk-calc-paths'

// How often results are published and housekeeping runs.
const TICK_MS = 1000

// How often changed totals are written to disk. A crash or power cut loses
// at most this much counting; clean stops and resets save immediately.
const SAVE_INTERVAL_MS = 30000

module.exports = function (app) {
  const plugin = {
    id: PLUGIN_ID,
    name: 'Calculated Paths',
    description: 'Calculate new paths from existing ones: formulas over live values, daily/weekly/monthly/yearly counters on running totals, and integration of a rate over time.',
    schema,
    uiSchema
  }

  let engine = null
  let normalized = null
  let stateProblem = null
  let unsubscribes = []
  let tickTimer = null
  let lastSaveMono = 0
  let lastStatus = null
  // True only while the subscription is being set up. See onDelta().
  let subscribing = false
  // Values received in the current turn of the event loop, waiting to be
  // handed to the engine together. See onDelta().
  let pending = []
  let pendingWall = 0
  let pendingMono = 0

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
      saveState(app.getDataDirPath(), engine.serialize(wallNow()))
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
      const publications = engine.tick(wallNow(), monoNow())
      if (publications.length > 0) {
        app.handleMessage(PLUGIN_ID, {
          updates: [{ values: publications.map(({ path, value }) => ({ path, value })) }]
        })
      }
      reportStatus()
      if (engine.dirty && monoNow() - lastSaveMono >= SAVE_INTERVAL_MS) save()
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
   * fresh: a switch state may be hours old. While `subscribing` is set each
   * update is therefore fed at once and with its real age, taken from its
   * timestamp, so the stale timeout judges it correctly, and with the
   * present moment as the point from which an integration may start adding
   * up. Live values are stamped on arrival instead, because a sensor's own
   * clock cannot be relied on for measuring durations.
   */
  function onDelta (delta) {
    if (!engine || !delta || !Array.isArray(delta.updates)) return
    for (const update of delta.updates) {
      if (!update || !Array.isArray(update.values)) continue
      if (subscribing) {
        const wall = wallNow()
        const mono = monoNow()
        engine.inputs(update.values, wall, mono - ageOf(update.timestamp, wall), mono)
        continue
      }
      for (const item of update.values) {
        if (!item || typeof item.path !== 'string') continue
        // A second value for a path that is already waiting is a new
        // reading, not part of the same step: what is waiting goes first.
        if (pending.some((waiting) => waiting.path === item.path)) flushPending()
        if (pending.length === 0) {
          pendingWall = wallNow()
          pendingMono = monoNow()
          queueMicrotask(flushPending)
        }
        pending.push({ path: item.path, value: item.value })
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
   * Feeds the engine the values the server already holds.
   *
   * An input that is sent rarely, such as a switch state, would otherwise
   * leave its entries waiting, possibly for hours. Signal K server 2.33
   * replays held values when a subscription is made (see onDelta), which
   * covers the same need; this direct read makes the plugin independent of
   * that behaviour. A value that arrives both ways is simply seen twice,
   * which changes nothing.
   */
  function feedCurrentValues (paths) {
    const wall = wallNow()
    const mono = monoNow()
    for (const path of paths) {
      let node
      try {
        node = app.getSelfPath(path)
      } catch (err) {
        continue
      }
      if (!node || typeof node !== 'object' || !('value' in node)) continue
      // The wall time stays "now": it decides which period the value falls
      // in, and an old value must not reopen yesterday's period.
      engine.input(path, node.value, wall, mono - ageOf(node.timestamp, wall), mono)
    }
  }

  plugin.start = function (options) {
    // The server stops a plugin before starting it again, but nothing is
    // lost by making sure: a second timer or subscription left running
    // would publish every value twice.
    plugin.stop()
    normalized = normalizeConfig(options)

    const loaded = loadState(app.getDataDirPath())
    stateProblem = loaded.error
    if (stateProblem) app.error(stateProblem)

    engine = new Engine(normalized, loaded.state)
    lastStatus = null
    lastSaveMono = monoNow()

    for (const problem of normalized.problems) app.error(problem)
    for (const entry of normalized.entries) {
      if (entry.error) app.error(`${entry.label}: ${entry.error}`)
    }
    app.debug(`Starting with ${normalized.entries.length} entries, time zone ${normalized.settings.timeZone}, reading ${engine.externalPaths.length} paths`)

    publishMetadata()

    if (engine.externalPaths.length > 0) {
      feedCurrentValues(engine.externalPaths)
      // No period or minPeriod is given on purpose: the server then passes
      // every value through as it arrives. An integration needs each value
      // at its own time, and a subscription with a period would hand them
      // over in batches.
      subscribing = true
      try {
        app.subscriptionmanager.subscribe(
          {
            context: 'vessels.self',
            subscribe: engine.externalPaths.map((path) => ({ path }))
          },
          unsubscribes,
          (err) => app.error(`Subscription error: ${err}`),
          onDelta
        )
      } finally {
        subscribing = false
      }
    }

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
      res.json({
        version: packageInfo.version,
        timeZone: settings.timeZone,
        dayStart: `${pad(Math.floor(settings.dayStartMinutes / 60))}:${pad(settings.dayStartMinutes % 60)}`,
        clockTrusted: !engine.clockSuspect,
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

  plugin.getOpenApi = () => openApi(packageInfo.version)

  return plugin
}
