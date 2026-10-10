'use strict'

/*
 * Tests of the plugin as the server sees it, against a stand-in for the
 * Signal K server API. The stand-in records what the plugin subscribes to
 * and publishes, and lets a test push deltas through the subscription.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const createPlugin = require('../index')
const packageInfo = require('../package.json')

function fakeApp (selfPaths = {}) {
  const app = {
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'calc-paths-plugin-')),
    messages: [],
    statuses: [],
    errors: [],
    logged: [],
    subscriptions: [],
    unsubscribed: 0,
    getDataDirPath: () => app.dataDir,
    getSelfPath: (p) => selfPaths[p],
    handleMessage: (id, delta) => app.messages.push({ id, delta }),
    setPluginStatus: (text) => app.statuses.push(text),
    setPluginError: (text) => app.errors.push(text),
    debug: () => {},
    error: (text) => app.logged.push(text),
    // Deltas the stand-in hands over during subscribe(), the way the real
    // server replays the values it already holds.
    replay: [],
    subscriptionmanager: {
      subscribe (command, unsubscribes, onError, callback) {
        app.subscriptions.push({ command, callback })
        unsubscribes.push(() => { app.unsubscribed++ })
        for (const delta of app.replay) callback(delta)
      }
    },
    /**
     * Delivers one source update the way the server does: one callback per
     * value, one straight after the other.
     */
    sendUpdate (values) {
      const timestamp = new Date().toISOString()
      for (const [p, value] of Object.entries(values)) {
        for (const { callback } of app.subscriptions) {
          callback({ context: 'vessels.self', updates: [{ $source: 'test', timestamp, values: [{ path: p, value }] }] })
        }
      }
    },
    /** Pushes one value through every subscription, as the server would. */
    send (p, value) {
      for (const { callback } of app.subscriptions) {
        callback({ context: 'vessels.self', updates: [{ $source: 'test', timestamp: new Date().toISOString(), values: [{ path: p, value }] }] })
      }
    },
    values () {
      const latest = {}
      for (const { delta } of app.messages) {
        for (const update of delta.updates) {
          for (const item of update.values || []) latest[item.path] = item.value
        }
      }
      return latest
    }
  }
  return app
}

/** A router stand-in that records routes and the access level they asked for. */
function fakeRouter (withAccess = true) {
  const routes = {}
  const add = (level) => (method) => (route, handler) => { routes[`${method} ${route}`] = { level, handler } }
  const router = { get: add('admin')('GET'), post: add('admin')('POST'), routes }
  if (withAccess) router.access = (level) => ({ get: add(level)('GET'), post: add(level)('POST') })
  return router
}

function call (handler, params = {}) {
  const response = { statusCode: 200, body: null }
  handler({ params }, {
    status (code) { response.statusCode = code; return this },
    json (body) { response.body = body }
  })
  return response
}

const options = {
  timeZone: 'UTC',
  formulas: [{ name: 'Hardtop power', inputs: [{ name: 'i', path: 'el.current' }, { name: 'v', path: 'el.voltage' }], expression: 'i * v', output: 'el.power', unit: 'W' }],
  counters: [{ name: 'Yield today', input: 'el.yieldTotal', output: 'el.yieldToday', unit: 'J', resets: 'manual' }],
  integrations: [{ input: 'el.power', output: 'el.energy', unit: 'J' }]
}

test('plugin identity matches the package', () => {
  const plugin = createPlugin(fakeApp())
  assert.equal(plugin.id, 'signalk-calc-paths')
  assert.equal(plugin.id, packageInfo.name)
  assert.equal(plugin.id, packageInfo.signalk.pluginId)
  assert.equal(plugin.name, packageInfo.signalk.displayName)
  // The form is built on request; see the tests of the time zone list.
  assert.equal(typeof plugin.schema, 'function')
  assert.equal(plugin.schema().type, 'object')
  assert.equal(typeof plugin.uiSchema, 'object')
  assert.equal(plugin.getOpenApi().info.version, packageInfo.version)
})

test('files named in package.json exist', () => {
  const root = path.join(__dirname, '..')
  assert.ok(fs.existsSync(path.join(root, packageInfo.main)))
  assert.ok(fs.existsSync(path.join(root, packageInfo.signalk.appIcon)))
  assert.ok(fs.existsSync(path.join(root, 'public', 'index.html')))
  for (const screenshot of packageInfo.signalk.screenshots) {
    assert.ok(fs.existsSync(path.join(root, screenshot)), screenshot)
    // A real screenshot, not an empty placeholder.
    assert.ok(fs.statSync(path.join(root, screenshot)).size > 10000, screenshot)
  }
  // The App Store reads the icon from the package root and the Webapps
  // list reads it from public/, so the same file is kept in both places.
  assert.deepEqual(fs.readFileSync(path.join(root, 'icon.svg')), fs.readFileSync(path.join(root, 'public', 'icon.svg')))
})

test('start subscribes to outside paths only, announces units, and publishes results', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const app = fakeApp()
  const plugin = createPlugin(app)
  plugin.start(options)

  // el.power is produced by the formula, so it is not asked of the server.
  assert.equal(app.subscriptions.length, 1)
  const { command } = app.subscriptions[0]
  assert.equal(command.context, 'vessels.self')
  // The two paths that carry the ship's time zone are read as well.
  assert.deepEqual(command.subscribe, [
    { path: 'el.current' },
    { path: 'el.voltage' },
    { path: 'el.yieldTotal' },
    { path: 'environment.time.timezoneRegion' },
    { path: 'environment.time.timezoneOffset' }
  ])

  // Metadata goes out first, in one delta.
  assert.deepEqual(app.messages[0], {
    id: 'signalk-calc-paths',
    delta: {
      updates: [{
        meta: [
          { path: 'el.power', value: { units: 'W', displayName: 'Hardtop power', description: 'Hardtop power' } },
          { path: 'el.yieldToday', value: { units: 'J', displayName: 'Yield today', description: 'Yield today' } },
          { path: 'el.energy', value: { units: 'J' } }
        ]
      }]
    }
  })
  assert.deepEqual(app.statuses, ['3 entries: 3 waiting for input'])

  app.send('el.current', 5)
  app.send('el.voltage', 24)
  app.send('el.yieldTotal', 1000)
  app.send('el.yieldTotal', 1600)
  t.mock.timers.tick(1000)

  assert.deepEqual(app.values(), { 'el.power': 120, 'el.yieldToday': 600, 'el.energy': 0 })
  assert.equal(app.statuses.at(-1), '3 entries: 3 publishing')
  assert.deepEqual(app.errors, [])

  plugin.stop()
  assert.equal(app.unsubscribed, 1)
})

test('deltas without values, such as metadata, are ignored', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const app = fakeApp()
  const plugin = createPlugin(app)
  plugin.start(options)
  const { callback } = app.subscriptions[0]
  assert.doesNotThrow(() => {
    callback({ context: 'vessels.self', updates: [{ meta: [{ path: 'el.current', value: { units: 'A' } }] }] })
    callback({ context: 'vessels.self', updates: [{}] })
    callback({ context: 'vessels.self' })
    callback(null)
    callback({ updates: [{ values: [null, { value: 1 }, { path: 'el.current', value: 'text' }] }] })
  })
  t.mock.timers.tick(1000)
  assert.deepEqual(app.values(), {})
  plugin.stop()
})

test('values the server already holds are used at start', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const now = new Date().toISOString()
  const app = fakeApp({
    'el.current': { value: 5, timestamp: now, $source: 'test' },
    'el.voltage': { value: 24, timestamp: now, $source: 'test' },
    // Ten minutes old: beyond the 60 s stale timeout.
    'el.yieldTotal': { value: 1000, timestamp: new Date(Date.now() - 600000).toISOString(), $source: 'test' }
  })
  const plugin = createPlugin(app)
  plugin.start(options)
  t.mock.timers.tick(1000)
  assert.equal(app.values()['el.power'], 120)
  assert.equal(app.values()['el.yieldToday'], undefined)
  assert.match(app.statuses.at(-1), /2 publishing, 1 stale/)
  plugin.stop()
})

test('totals are saved on stop and restored on the next start', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const app = fakeApp()
  let plugin = createPlugin(app)
  plugin.start(options)
  app.send('el.yieldTotal', 1000)
  app.send('el.yieldTotal', 1600)
  t.mock.timers.tick(1000)
  plugin.stop()

  const saved = JSON.parse(fs.readFileSync(path.join(app.dataDir, 'state.json'), 'utf8'))
  assert.equal(saved.version, 1)
  assert.equal(saved.entries['el.yieldToday'].total, 600)
  assert.equal(saved.entries['el.yieldToday'].last, 1600)

  app.subscriptions = []
  app.messages = []
  plugin = createPlugin(app)
  plugin.start(options)
  app.send('el.yieldTotal', 1650)
  t.mock.timers.tick(1000)
  assert.equal(app.values()['el.yieldToday'], 650)
  plugin.stop()
})

test('a configuration error is reported while the other entries keep running', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const app = fakeApp()
  const plugin = createPlugin(app)
  plugin.start({ ...options, timeZone: 'Nowhere/Land', counters: [...options.counters, { name: 'Broken', input: 'x.total', output: 'nodots' }] })
  assert.equal(app.errors.length, 1)
  assert.match(app.errors[0], /4 entries: 3 waiting for input, 1 with a configuration error/)
  assert.match(app.errors[0], /Nowhere\/Land/)
  assert.ok(app.logged.some((line) => /Broken: "nodots" is not a valid output path/.test(line)))
  app.send('el.current', 2)
  app.send('el.voltage', 12)
  t.mock.timers.tick(1000)
  assert.equal(app.values()['el.power'], 24)
  plugin.stop()
})

test('the status text is sent only when it changes', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const app = fakeApp()
  const plugin = createPlugin(app)
  plugin.start({})
  for (let i = 0; i < 30; i++) t.mock.timers.tick(1000)
  assert.deepEqual(app.statuses, ['No entries configured yet'])
  // With no entries only the ship's time zone is listened for.
  assert.equal(app.subscriptions.length, 1)
  assert.deepEqual(app.subscriptions[0].command.subscribe, [{ path: 'environment.time.timezoneRegion' }, { path: 'environment.time.timezoneOffset' }])
  plugin.stop()
})

test('the status route lists entries and is open to read-only users', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const app = fakeApp()
  const plugin = createPlugin(app)
  const router = fakeRouter()
  plugin.registerWithRouter(router)
  assert.equal(router.routes['GET /api/entries'].level, 'readonly')
  assert.equal(router.routes['POST /api/entries/:id/reset'].level, 'readwrite')

  // Before start the plugin says so instead of failing.
  assert.equal(call(router.routes['GET /api/entries'].handler).statusCode, 503)

  plugin.start({ ...options, dayStart: '04:30' })
  app.send('el.current', 5)
  app.send('el.voltage', 24)
  t.mock.timers.tick(1000)
  const { statusCode, body } = call(router.routes['GET /api/entries'].handler)
  assert.equal(statusCode, 200)
  assert.equal(body.version, packageInfo.version)
  assert.equal(body.timeZone, 'UTC')
  assert.equal(body.dayStart, '04:30')
  assert.equal(body.clockTrusted, true)
  assert.deepEqual(body.problems, [])
  assert.deepEqual(body.entries.map((e) => [e.output, e.state, e.value]), [['el.power', 'ok', 120], ['el.yieldToday', 'waiting', null], ['el.energy', 'ok', 0]])
  plugin.stop()
})

test('the reset route clears one total and saves at once', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const app = fakeApp()
  const plugin = createPlugin(app)
  const router = fakeRouter()
  plugin.registerWithRouter(router)
  const reset = router.routes['POST /api/entries/:id/reset'].handler
  assert.equal(call(reset, { id: 'el.yieldToday' }).statusCode, 503)

  plugin.start(options)
  app.send('el.yieldTotal', 1000)
  app.send('el.yieldTotal', 1600)
  t.mock.timers.tick(1000)
  assert.equal(app.values()['el.yieldToday'], 600)

  assert.equal(call(reset, { id: 'el.power' }).statusCode, 404)
  assert.equal(call(reset, { id: 'no.such.entry' }).statusCode, 404)
  assert.deepEqual(call(reset, { id: 'el.yieldToday' }), { statusCode: 200, body: { reset: 'el.yieldToday' } })
  const saved = JSON.parse(fs.readFileSync(path.join(app.dataDir, 'state.json'), 'utf8'))
  assert.equal(saved.entries['el.yieldToday'].total, 0)

  t.mock.timers.tick(1000)
  assert.equal(app.values()['el.yieldToday'], 0)
  app.send('el.yieldTotal', 1630)
  t.mock.timers.tick(1000)
  assert.equal(app.values()['el.yieldToday'], 30)
  plugin.stop()
})

test('on a server without per-route access levels both routes stay admin-only', () => {
  const plugin = createPlugin(fakeApp())
  const router = fakeRouter(false)
  plugin.registerWithRouter(router)
  assert.equal(router.routes['GET /api/entries'].level, 'admin')
  assert.equal(router.routes['POST /api/entries/:id/reset'].level, 'admin')
})

test('an unusable state file is reported and replaced', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const app = fakeApp()
  fs.writeFileSync(path.join(app.dataDir, 'state.json'), 'garbage')
  const plugin = createPlugin(app)
  plugin.start(options)
  assert.match(app.errors[0], /state file was not usable/)
  plugin.stop()
  assert.equal(JSON.parse(fs.readFileSync(path.join(app.dataDir, 'state.json'), 'utf8')).version, 1)
})

test('stop is safe to call twice and before start', () => {
  const plugin = createPlugin(fakeApp())
  assert.doesNotThrow(() => plugin.stop())
  plugin.start({})
  assert.doesNotThrow(() => { plugin.stop(); plugin.stop() })
})

test('values replayed when the subscription is made are judged by their real age', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const app = fakeApp()
  const at = (secondsAgo) => new Date(Date.now() - secondsAgo * 1000).toISOString()
  app.replay = [
    { context: 'vessels.self', updates: [{ $source: 'test', timestamp: at(2), values: [{ path: 'el.current', value: 5 }, { path: 'el.voltage', value: 24 }] }] },
    // Three hours old: far beyond the 60 s stale timeout.
    { context: 'vessels.self', updates: [{ $source: 'test', timestamp: at(3 * 3600), values: [{ path: 'el.yieldTotal', value: 1000 }] }] }
  ]
  const plugin = createPlugin(app)
  plugin.start(options)
  t.mock.timers.tick(1000)
  assert.equal(app.values()['el.power'], 120)
  assert.equal(app.values()['el.yieldToday'], undefined)
  assert.match(app.statuses.at(-1), /2 publishing, 1 stale/)
  // A live value afterwards is fresh on arrival, whatever its timestamp says.
  app.subscriptions[0].callback({ context: 'vessels.self', updates: [{ timestamp: at(3 * 3600), values: [{ path: 'el.yieldTotal', value: 1010 }] }] })
  t.mock.timers.tick(1000)
  assert.equal(app.values()['el.yieldToday'], 10)
  plugin.stop()
})

test('starting twice leaves one timer and one subscription', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const app = fakeApp()
  const plugin = createPlugin(app)
  plugin.start(options)
  plugin.start(options)
  // The first start's subscription was released by the second.
  assert.equal(app.unsubscribed, 1)
  app.subscriptions.at(-1).callback({ updates: [{ values: [{ path: 'el.current', value: 5 }, { path: 'el.voltage', value: 24 }] }] })
  t.mock.timers.tick(1000)
  const powerMessages = app.messages.filter(({ delta }) => delta.updates.some((u) => (u.values || []).some((v) => v.path === 'el.power')))
  assert.equal(powerMessages.length, 1)
  plugin.stop()
  // Nothing is left running to throw after the stop.
  assert.doesNotThrow(() => t.mock.timers.tick(5000))
})

test('a failure inside the timer is reported, not thrown into the server', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const app = fakeApp()
  const plugin = createPlugin(app)
  plugin.start(options)
  app.handleMessage = () => { throw new Error('server refused the delta') }
  app.send('el.current', 5)
  app.send('el.voltage', 24)
  assert.doesNotThrow(() => t.mock.timers.tick(1000))
  assert.match(app.errors.at(-1), /server refused the delta/)
  plugin.stop()
})

test('values of one source update are applied together although the server delivers them singly', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const app = fakeApp()
  const plugin = createPlugin(app)
  plugin.start({
    timeZone: 'UTC',
    formulas: [{ inputs: [{ name: 'a', path: 's.a' }, { name: 'b', path: 's.b' }], expression: 'a + b', output: 's.sum', staleTimeout: 0 }],
    counters: [{ input: 's.sum', output: 's.moved', resets: 'manual', staleTimeout: 0 }]
  })
  // The source keeps a + b at 10 while both change in every update.
  for (let k = 0; k <= 10; k++) {
    app.sendUpdate({ 's.a': 10 - k, 's.b': k })
    // Let the plugin's microtask run, as it does between two deliveries.
    await Promise.resolve()
  }
  t.mock.timers.tick(1000)
  assert.equal(app.values()['s.sum'], 10)
  // Had the two values been applied one after the other, the sum would
  // have stepped to 9 and back on every update and the counter would show 10.
  assert.equal(app.values()['s.moved'], 0)
  plugin.stop()
})

test('two readings of one path in the same turn are kept apart', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const app = fakeApp()
  const plugin = createPlugin(app)
  plugin.start({ timeZone: 'UTC', counters: [{ input: 'c.total', output: 'c.moved', resets: 'manual', direction: 'net', staleTimeout: 0, reversal: 'continue' }, { input: 'c.total', output: 'c.up', resets: 'manual', staleTimeout: 0 }] })
  app.send('c.total', 0)
  app.send('c.total', 50)
  app.send('c.total', 20)
  app.send('c.total', 30)
  await Promise.resolve()
  t.mock.timers.tick(1000)
  assert.equal(app.values()['c.moved'], 30)
  // Each reading was counted: up 50, down 30 (ignored), up 10.
  assert.equal(app.values()['c.up'], 60)
  plugin.stop()
})

// ------------------------------------------------------- the ship's time zone

const REGION = 'environment.time.timezoneRegion'
const OFFSET = 'environment.time.timezoneOffset'
const daily = { counters: [{ name: 'Today', input: 'c.total', output: 'c.today', resets: 'day', staleTimeout: 0 }] }

/** Asks the status route what the plugin reports. */
function statusOf (plugin) {
  const router = fakeRouter()
  plugin.registerWithRouter(router)
  return call(router.routes['GET /api/entries'].handler).body
}

test('with the ship\'s time not followed no time zone path is read', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const app = fakeApp({ [REGION]: { value: 'Europe/Athens', timestamp: new Date().toISOString() } })
  const plugin = createPlugin(app)
  plugin.start({ timeZoneSource: 'fixed', timeZone: 'Europe/Rome', ...daily })
  assert.deepEqual(app.subscriptions[0].command.subscribe, [{ path: 'c.total' }])
  const status = statusOf(plugin)
  assert.equal(status.timeZone, 'Europe/Rome')
  assert.deepEqual(status.timeZoneSource, { kind: 'setting', follow: false, paths: [], path: null, since: null, fallback: 'Europe/Rome', problem: null })
  // A zone published later is not acted on either.
  app.send(REGION, 'Europe/Athens')
  assert.equal(statusOf(plugin).timeZone, 'Europe/Rome')
  assert.equal(app.statuses.at(-1), '1 entry: 1 waiting for input')
  plugin.stop()

  // Nothing at all is subscribed to when there is nothing to read.
  const idle = fakeApp()
  const other = createPlugin(idle)
  other.start({ timeZoneSource: 'fixed' })
  assert.equal(idle.subscriptions.length, 0)
  other.stop()
})

test('the ship\'s time zone the server already holds is used from the start', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const app = fakeApp({
    [REGION]: { value: 'Europe/Athens', timestamp: new Date().toISOString() },
    [OFFSET]: { value: 300, timestamp: new Date().toISOString() }
  })
  const plugin = createPlugin(app)
  plugin.start({ timeZone: 'UTC', ...daily })
  const status = statusOf(plugin)
  assert.equal(status.timeZone, 'Europe/Athens')
  assert.equal(status.timeZoneLabel, 'Europe/Athens')
  assert.equal(status.timeZoneSource.kind, 'path')
  assert.equal(status.timeZoneSource.path, REGION)
  assert.equal(status.timeZoneSource.fallback, 'UTC')
  assert.deepEqual(status.timeZoneSource.paths, [REGION, OFFSET])
  // The dashboard line names a followed zone.
  assert.equal(app.statuses.at(-1), '1 entry: 1 waiting for input. Time zone Europe/Athens')
  plugin.stop()
})

test('with only an offset published the offset is followed', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const app = fakeApp({ [OFFSET]: { value: -930, timestamp: new Date().toISOString() } })
  const plugin = createPlugin(app)
  plugin.start(daily)
  const status = statusOf(plugin)
  assert.equal(status.timeZone, '-09:30')
  assert.equal(status.timeZoneLabel, 'UTC-09:30')
  assert.equal(status.timeZoneSource.path, OFFSET)
  assert.match(app.statuses.at(-1), /Time zone UTC-09:30$/)
  plugin.stop()
})

test('nothing published leaves the zone from the settings in use, and says so', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const app = fakeApp()
  const plugin = createPlugin(app)
  plugin.start({ timeZone: 'Europe/Rome', ...daily })
  const status = statusOf(plugin)
  assert.equal(status.timeZone, 'Europe/Rome')
  assert.deepEqual(status.timeZoneSource, { kind: 'setting', follow: true, paths: [REGION, OFFSET], path: null, since: null, fallback: 'Europe/Rome', problem: null })
  // The dashboard line stays as it was: the zone is not a followed one.
  assert.equal(app.statuses.at(-1), '1 entry: 1 waiting for input')
  plugin.stop()
})

test('a zone published while running moves the day boundary', (t) => {
  // 23:20 in Rome on 10 October; Rome is two hours ahead of UTC.
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.parse('2026-10-10T21:20:00Z') })
  const app = fakeApp({ [REGION]: { value: 'Europe/Rome', timestamp: '2026-10-10T08:00:00Z' } })
  const plugin = createPlugin(app)
  plugin.start(daily)
  app.send('c.total', 1000)
  app.send('c.total', 1500)
  t.mock.timers.tick(1000)
  assert.equal(app.values()['c.today'], 500)

  // The ship moves to Athens time: 00:20 on the 11th. A new day has begun.
  app.send(REGION, 'Europe/Athens')
  t.mock.timers.tick(1000)
  assert.equal(app.values()['c.today'], 0)
  const status = statusOf(plugin)
  assert.equal(status.timeZone, 'Europe/Athens')
  assert.match(status.entries[0].message, /time zone changed/)
  assert.match(app.statuses.at(-1), /Time zone Europe\/Athens$/)

  // Back to Rome: 23:20 on the 10th again. The 11th is not started twice.
  app.send('c.total', 1600)
  app.send(REGION, 'Europe/Rome')
  t.mock.timers.tick(1000)
  assert.equal(app.values()['c.today'], 100)
  t.mock.timers.tick(45 * 60000)
  app.send('c.total', 1700)
  t.mock.timers.tick(1000)
  assert.equal(app.values()['c.today'], 200)
  plugin.stop()
})

test('the zone followed is saved and remembered at the next start', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const app = fakeApp()
  let plugin = createPlugin(app)
  plugin.start(daily)
  app.send(OFFSET, 300)
  app.send(REGION, 'Europe/Athens')
  plugin.stop()

  const saved = JSON.parse(fs.readFileSync(path.join(app.dataDir, 'state.json'), 'utf8'))
  assert.equal(saved.version, 1)
  assert.equal(saved.zone.zone, 'Europe/Athens')
  assert.equal(saved.zone.path, REGION)
  assert.equal(saved.zone.regionPath, REGION)
  assert.equal(saved.zone.offsetPath, OFFSET)

  // The server has just restarted and holds no zone yet.
  app.subscriptions = []
  plugin = createPlugin(app)
  plugin.start(daily)
  let status = statusOf(plugin)
  assert.equal(status.timeZone, 'Europe/Athens')
  assert.equal(status.timeZoneSource.kind, 'remembered')
  assert.match(app.statuses.at(-1), /Time zone Europe\/Athens$/)
  // The source speaks again and the zone is confirmed.
  app.send(REGION, 'Europe/Athens')
  status = statusOf(plugin)
  assert.equal(status.timeZoneSource.kind, 'path')
  plugin.stop()

  // Switching to the fixed setting forgets it.
  app.subscriptions = []
  plugin = createPlugin(app)
  plugin.start({ timeZoneSource: 'fixed', ...daily })
  assert.equal(statusOf(plugin).timeZoneSource.kind, 'server')
  plugin.stop()
  assert.equal(JSON.parse(fs.readFileSync(path.join(app.dataDir, 'state.json'), 'utf8')).zone, null)
})

test('a zone replayed when the subscription is made is used', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const app = fakeApp()
  app.replay = [
    { context: 'vessels.self', updates: [{ $source: 'ships-time', timestamp: new Date().toISOString(), values: [{ path: OFFSET, value: 200 }] }] },
    { context: 'vessels.self', updates: [{ $source: 'ships-time', timestamp: new Date().toISOString(), values: [{ path: REGION, value: 'Europe/Rome' }] }] }
  ]
  const plugin = createPlugin(app)
  plugin.start(daily)
  const status = statusOf(plugin)
  assert.equal(status.timeZone, 'Europe/Rome')
  assert.equal(status.timeZoneSource.kind, 'path')
  plugin.stop()
})

test('a custom path can carry the zone', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const app = fakeApp()
  const plugin = createPlugin(app)
  plugin.start({ timeZoneRegionPath: 'my.ship.zone', timeZoneOffsetPath: 'my.ship.offset', ...daily })
  assert.deepEqual(app.subscriptions[0].command.subscribe, [{ path: 'c.total' }, { path: 'my.ship.zone' }, { path: 'my.ship.offset' }])
  // The standard path is no longer listened to.
  app.send(REGION, 'Europe/Athens')
  assert.notEqual(statusOf(plugin).timeZone, 'Europe/Athens')
  app.send('my.ship.offset', 545)
  assert.equal(statusOf(plugin).timeZone, '+05:45')
  app.send('my.ship.zone', 'Asia/Kathmandu')
  assert.equal(statusOf(plugin).timeZone, 'Asia/Kathmandu')
  assert.equal(statusOf(plugin).timeZoneSource.path, 'my.ship.zone')
  plugin.stop()
})

test('a followed path that holds something else is reported without failing the plugin', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const app = fakeApp()
  const plugin = createPlugin(app)
  plugin.start({ timeZone: 'Europe/Rome', ...daily })
  app.send(REGION, { latitude: 37.9, longitude: 23.7 })
  app.send(OFFSET, 'three hours')
  t.mock.timers.tick(1000)
  const status = statusOf(plugin)
  assert.equal(status.timeZone, 'Europe/Rome')
  assert.equal(status.timeZoneSource.kind, 'setting')
  assert.match(status.timeZoneSource.problem, /is not a time zone name or an offset/)
  // It is a notice on the status page, not a red plugin error.
  assert.deepEqual(app.errors, [])
  assert.deepEqual(status.problems, [])
  plugin.stop()
})

test('a path that is both an input and a followed path serves both', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const app = fakeApp()
  const plugin = createPlugin(app)
  plugin.start({ formulas: [{ inputs: [{ name: 'o', path: OFFSET }], expression: 'o / 100', output: 'c.offsetHours', staleTimeout: 0 }] })
  // Subscribed once, not twice.
  assert.deepEqual(app.subscriptions[0].command.subscribe, [{ path: OFFSET }, { path: REGION }])
  app.send(OFFSET, 300)
  t.mock.timers.tick(1000)
  assert.equal(app.values()['c.offsetHours'], 3)
  assert.equal(statusOf(plugin).timeZone, '+03:00')
  plugin.stop()
})

test('a server without a subscription manager is reported, not crashed into', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const app = fakeApp()
  delete app.subscriptionmanager
  const plugin = createPlugin(app)
  plugin.start(daily)
  assert.ok(app.logged.some((line) => /no subscription manager/.test(line)))
  t.mock.timers.tick(1000)
  plugin.stop()
})

test('the same published values give the same zone live and at a restart', (t) => {
  // Ship's Time in manual mode with an offset of three hours and the region
  // Europe/Athens, set in summer. On 26 October the two disagree. Both are
  // published in one update, so the name is followed, and it must still be
  // followed when the plugin is restarted and reads them from the server.
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.parse('2026-10-26T21:30:00Z') })
  const published = '2026-10-26T08:00:00.000Z'
  const app = fakeApp()
  let plugin = createPlugin(app)
  plugin.start(daily)
  app.subscriptions[0].callback({ context: 'vessels.self', updates: [{ $source: 'ships-time', timestamp: published, values: [{ path: OFFSET, value: 300 }] }] })
  app.subscriptions[0].callback({ context: 'vessels.self', updates: [{ $source: 'ships-time', timestamp: published, values: [{ path: REGION, value: 'Europe/Athens' }] }] })
  assert.equal(statusOf(plugin).timeZone, 'Europe/Athens')
  app.send('c.total', 1000)
  app.send('c.total', 1500)
  t.mock.timers.tick(1000)
  assert.equal(app.values()['c.today'], 500)
  plugin.stop()

  // Restarted: the server holds both values and hands them over.
  const held = fakeApp({
    [REGION]: { value: 'Europe/Athens', timestamp: published },
    [OFFSET]: { value: 300, timestamp: published }
  })
  held.dataDir = app.dataDir
  plugin = createPlugin(held)
  plugin.start(daily)
  assert.equal(statusOf(plugin).timeZone, 'Europe/Athens')
  held.send('c.total', 1600)
  t.mock.timers.tick(1000)
  // The day's total carried over: no boundary moved.
  assert.equal(held.values()['c.today'], 600)
  assert.equal(statusOf(plugin).entries[0].message, '')
  plugin.stop()
})

test('a name and an offset that come to disagree are noticed within a minute', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.parse('2026-10-24T22:00:00Z') })
  const app = fakeApp()
  const plugin = createPlugin(app)
  plugin.start(daily)
  // The name was published yesterday; the offset, set by hand, today.
  app.subscriptions[0].callback({ context: 'vessels.self', updates: [{ timestamp: '2026-10-23T12:00:00Z', values: [{ path: REGION, value: 'Europe/Athens' }] }] })
  app.subscriptions[0].callback({ context: 'vessels.self', updates: [{ timestamp: '2026-10-24T11:00:00Z', values: [{ path: OFFSET, value: 300 }] }] })
  assert.equal(statusOf(plugin).timeZone, 'Europe/Athens')
  // Athens goes back an hour at 01:00 UTC on the 25th. Up to then the two
  // agree and nothing changes.
  t.mock.timers.tick(3 * 3600000 - 1000)
  assert.equal(statusOf(plugin).timeZone, 'Europe/Athens')
  // Nothing is published at the change. Within a minute of it the plugin
  // has noticed that the ship keeps three hours and Athens now keeps two.
  t.mock.timers.tick(61000)
  assert.equal(statusOf(plugin).timeZone, '+03:00')
  assert.equal(statusOf(plugin).timeZoneSource.path, OFFSET)
  plugin.stop()
})

test('the form keeps a saved zone that its list does not hold', () => {
  const zoneList = (plugin) => plugin.schema().properties.timeZone
  // Saved by version 0.1.0 as free text: a name the list lacks.
  const app = fakeApp()
  app.readPluginOptions = () => ({ enabled: true, configuration: { timeZone: 'US/Eastern' } })
  const plugin = createPlugin(app)
  const field = zoneList(plugin)
  assert.ok(field.enum.includes('US/Eastern'))
  assert.equal(field.enumNames.length, field.enum.length)
  assert.equal(field.enumNames[field.enum.indexOf('US/Eastern')], 'US/Eastern (as saved)')

  // A zone that is in the list, the server's zone, nothing, and text that
  // names no zone add nothing.
  const base = zoneList(createPlugin(fakeApp())).enum.length
  for (const timeZone of ['Europe/Athens', 'server', '', undefined, null, 'Atlantis/Central', 42]) {
    const other = fakeApp()
    other.readPluginOptions = () => ({ configuration: { timeZone } })
    assert.equal(zoneList(createPlugin(other)).enum.length, base, String(timeZone))
  }

  // A server that cannot hand over the saved options: the zone the plugin
  // was last started with is used.
  const bare = fakeApp()
  bare.readPluginOptions = () => { throw new Error('not available') }
  const started = createPlugin(bare)
  assert.equal(zoneList(started).enum.length, base)
  started.start({ timeZone: 'europe/athens' })
  assert.ok(zoneList(started).enum.includes('europe/athens'))
  started.stop()

  // Each call returns a fresh object: changing one does not leak into the next.
  const first = plugin.schema()
  first.properties.timeZone.enum.push('Changed/ByCaller')
  assert.ok(!plugin.schema().properties.timeZone.enum.includes('Changed/ByCaller'))
})

test('totals saved by version 0.1.0 survive the upgrade when a zone further west is followed', (t) => {
  // 0.1.0 ran with the zone setting Europe/Athens and saved period starts
  // at Athens midnight. After the upgrade the ship's time is followed and
  // reads Europe/Rome, where that same instant is still the day before.
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.parse('2026-10-10T10:00:00Z') })
  const app = fakeApp({ [REGION]: { value: 'Europe/Rome', timestamp: '2026-10-10T09:00:00Z' } })
  const start = (iso) => Date.parse(iso)
  const record = (resets, periodStart) => ({ signature: 'counter|c.total|increase', resets, resetPath: null, total: 1000, since: periodStart, periodStart, referenceLast: null, last: 5000 })
  fs.mkdirSync(app.dataDir, { recursive: true })
  fs.writeFileSync(path.join(app.dataDir, 'state.json'), JSON.stringify({
    version: 1,
    savedAt: start('2026-10-10T09:59:00Z'),
    entries: {
      'c.day': record('day', start('2026-10-09T21:00:00Z')),
      'c.week': record('week', start('2026-10-04T21:00:00Z')),
      'c.month': record('month', start('2026-09-30T21:00:00Z')),
      'c.year': record('year', start('2025-12-31T22:00:00Z'))
    }
  }))
  const plugin = createPlugin(app)
  plugin.start({
    timeZone: 'Europe/Athens',
    counters: ['day', 'week', 'month', 'year'].map((resets) => ({ input: 'c.total', output: `c.${resets}`, resets, staleTimeout: 0 }))
  })
  assert.equal(statusOf(plugin).timeZone, 'Europe/Rome')
  app.send('c.total', 5100)
  t.mock.timers.tick(1000)
  assert.deepEqual(app.values(), { 'c.day': 1100, 'c.week': 1100, 'c.month': 1100, 'c.year': 1100 })
  plugin.stop()
})
