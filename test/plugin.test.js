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
  assert.equal(typeof plugin.schema, 'object')
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
  assert.deepEqual(command.subscribe, [{ path: 'el.current' }, { path: 'el.voltage' }, { path: 'el.yieldTotal' }])

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
  assert.equal(app.subscriptions.length, 0)
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
