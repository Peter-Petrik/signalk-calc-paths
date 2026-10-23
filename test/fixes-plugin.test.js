'use strict'

/*
 * Tests of the plugin as the server sees it, for the faults put right in
 * version 0.6.1: a plugin switched off that could be started again through
 * the editor, a preview without limits, a state file that could not be read
 * and was then overwritten, a failed publication that was never sent again,
 * a 500 answer that named the data folder, and an OpenAPI description that
 * did not match the routes. Also tests of behaviours of the adapter that no
 * test held in place before.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { test } = require('node:test')

const createPlugin = require('../index')
const store = require('../lib/store')
const { call, fakeApp, fakeRouter } = require('./support')

function started (app) {
  const plugin = createPlugin(app)
  const router = fakeRouter()
  plugin.registerWithRouter(router)
  return { plugin, route: (key) => router.routes[key] }
}

/** Writes an entries file holding the given entries, without groups. */
function writeEntries (app, entries) {
  fs.writeFileSync(path.join(app.dataDir, store.ENTRIES_FILE), JSON.stringify({ version: 1, groups: [], entries }))
}

/**
 * Keeps count of the intervals the plugin sets and clears. It wraps the
 * mocked timer functions, so it must be called after the mock timers are
 * enabled, and the returned `restore` must run before the test ends, so
 * that the mock timers put the real functions back afterwards.
 */
function trackIntervals () {
  const set = globalThis.setInterval
  const clear = globalThis.clearInterval
  const live = new Set()
  globalThis.setInterval = (...args) => {
    const id = set(...args)
    live.add(id)
    return id
  }
  globalThis.clearInterval = (id) => {
    live.delete(id)
    return clear(id)
  }
  return { live, restore () { globalThis.setInterval = set; globalThis.clearInterval = clear } }
}

/** The values published on one path, in order. */
function sentOn (app, p) {
  return app.messages.flatMap(({ delta }) => delta.updates.flatMap((u) => (u.values || []).filter((v) => v.path === p).map((v) => v.value)))
}

const counter = { id: 'e1', type: 'counter', input: 'a.total', output: 'a.today', resets: 'manual', staleTimeout: 0 }

// ------------------------------------------------- a plugin switched off

test('a plugin switched off with an unusable entries file cannot be started through the editor', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const timers = trackIntervals()
  try {
    const app = fakeApp({ 'a.total': { value: 5, timestamp: new Date().toISOString() } })
    fs.writeFileSync(path.join(app.dataDir, store.ENTRIES_FILE), '{ "groups": [')
    const { plugin, route } = started(app)
    plugin.start({ timeZone: 'UTC' })
    assert.match(call(route('GET /api/config')).body.blocked, /not valid JSON/)
    // The server switches the plugin off.
    plugin.stop()
    const listeners = process.listeners('exit').length

    // An editor still open sends a set.
    const saved = call(route('PUT /api/config'), { body: { revision: null, groups: [], entries: [counter] } })
    assert.equal(saved.statusCode, 503)
    assert.match(saved.body.error, /not running/)
    // Nothing was started, written or published.
    assert.equal(app.subscriptions.length, 0)
    assert.equal(timers.live.size, 0)
    assert.equal(process.listeners('exit').length, listeners)
    assert.equal(app.file(store.ENTRIES_FILE), '{ "groups": [')
    assert.equal(app.file('state.json'), null)
    t.mock.timers.tick(5000)
    assert.deepEqual(app.messages, [])

    // The other routes say the same: the plugin is off.
    for (const [key, params, body] of [['GET /api/config'], ['GET /api/entries'], ['POST /api/entries/:id/reset', { id: 'a.today' }], ['POST /api/preview', {}, { inputs: [], expression: '1 + 1' }]]) {
      const answer = call(route(key), { params, body })
      assert.equal(answer.statusCode, 503, key)
      assert.equal(answer.body.blocked, undefined, key)
    }
  } finally {
    timers.restore()
  }
})

test('a plugin that is running with an unusable entries file still takes a new set', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const app = fakeApp()
  fs.writeFileSync(path.join(app.dataDir, store.ENTRIES_FILE), '{ "groups": [')
  const { plugin, route } = started(app)
  plugin.start({ timeZone: 'UTC' })
  // The preview works while the entries are being put right.
  assert.deepEqual(call(route('POST /api/preview'), { body: { inputs: [], expression: '1 + 1' } }).body, { value: 2, values: {} })
  const saved = call(route('PUT /api/config'), { body: { revision: null, groups: [], entries: [counter] } })
  assert.equal(saved.statusCode, 200)
  assert.equal(app.subscriptions.length, 1)
  plugin.stop()
})

// --------------------------------------------------------- preview limits

test('the preview refuses what a save would refuse: long texts, too many inputs, bad short names', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const now = new Date().toISOString()
  const app = fakeApp({ 'a.x': { value: 2, timestamp: now } })
  const { plugin, route } = started(app)
  plugin.start({ timeZone: 'UTC' })
  const preview = (body) => call(route('POST /api/preview'), { body })

  const long = preview({ inputs: [{ name: 'x', path: 'a.x' }], expression: `x${' + 1'.repeat(125)}` })
  assert.equal(long.statusCode, 200)
  assert.match(long.body.error, new RegExp(`longer than ${store.MAX_TEXT} characters`))
  // At the limit it is worked out.
  const limit = `x${' + 0'.repeat(124)}`.padEnd(store.MAX_TEXT, ' ')
  assert.equal(limit.length, store.MAX_TEXT)
  assert.deepEqual(preview({ inputs: [{ name: 'x', path: 'a.x' }], expression: limit }).body, { value: 2, values: { x: 2 } })

  const many = Array.from({ length: store.MAX_INPUTS + 1 }, (_, i) => ({ name: `x${i}`, path: 'a.x' }))
  assert.match(preview({ inputs: many, expression: 'x0' }).body.error, new RegExp(`more than ${store.MAX_INPUTS} inputs`))
  assert.deepEqual(preview({ inputs: many.slice(0, store.MAX_INPUTS), expression: 'x0' }).body.value, 2)

  assert.match(preview({ inputs: [{ name: 'x', path: `a.${'x'.repeat(store.MAX_TEXT)}` }], expression: 'x' }).body.error, /longer than/)
  // The short names are checked as a save checks them.
  assert.match(preview({ inputs: [{ name: 'constructor', path: 'a.x' }], expression: '1' }).body.error, /is a built-in name/)
  assert.match(preview({ inputs: [{ name: '1x', path: 'a.x' }], expression: '1' }).body.error, /is not a valid short name/)
  assert.match(preview({ inputs: [{ name: 'x', path: 'a.x' }, { name: 'x', path: 'a.x' }], expression: 'x' }).body.error, /used twice/)
  plugin.stop()
})

// ------------------------------------------------ a state file not read

const stateWithTotal = JSON.stringify({ version: 1, savedAt: Date.now(), entries: { 'a.today': { signature: 'counter|a.total|increase', resets: 'manual', total: 42, last: 5 } } })

test('a state file that cannot be read is never written over, and is read again at the next start', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const app = fakeApp()
  writeEntries(app, [counter])
  fs.writeFileSync(path.join(app.dataDir, 'state.json'), stateWithTotal)
  const file = path.join(app.dataDir, 'state.json')
  // A read error as a failing card gives it.
  const read = fs.readFileSync
  const failing = t.mock.method(fs, 'readFileSync', function (name, ...rest) {
    if (name === file) throw Object.assign(new Error(`EIO: i/o error, open '${file}'`), { code: 'EIO' })
    return read.call(this, name, ...rest)
  })
  const { plugin, route } = started(app)
  plugin.start({ timeZone: 'UTC' })
  assert.match(app.errors.at(-1), /state file could not be read/)
  assert.match(app.errors.at(-1), /not saved/)
  const status = call(route('GET /api/entries')).body
  assert.match(status.problems[0], /state file could not be read/)

  // Counting goes on, a reset is made, the save interval passes, the
  // plugin stops: the file keeps the totals it holds.
  app.send('a.total', 10)
  app.send('a.total', 15)
  t.mock.timers.tick(31000)
  assert.equal(call(route('POST /api/entries/:id/reset'), { params: { id: 'a.today' } }).statusCode, 200)
  plugin.stop()
  failing.mock.restore()
  assert.equal(app.file('state.json'), stateWithTotal)
  assert.ok(!fs.readdirSync(app.dataDir).some((name) => name.startsWith('state.json.')))

  // Readable again: the next start carries on from the saved total.
  plugin.start({ timeZone: 'UTC' })
  assert.equal(call(route('GET /api/entries')).body.entries[0].value, 42)
  assert.deepEqual(call(route('GET /api/entries')).body.problems, [])
  plugin.stop()
  assert.equal(JSON.parse(app.file('state.json')).entries['a.today'].total, 42)
})

test('a state file that is a folder is reported and no save is tried', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const app = fakeApp()
  writeEntries(app, [counter])
  fs.mkdirSync(path.join(app.dataDir, 'state.json'))
  const { plugin, route } = started(app)
  plugin.start({ timeZone: 'UTC' })
  assert.match(call(route('GET /api/entries')).body.problems[0], /state file could not be read/)
  app.send('a.total', 10)
  app.send('a.total', 15)
  t.mock.timers.tick(31000)
  plugin.stop()
  assert.ok(fs.statSync(path.join(app.dataDir, 'state.json')).isDirectory())
  assert.ok(!app.logged.some((line) => /Could not save state/.test(line)), app.logged.join('\n'))
  assert.deepEqual(fs.readdirSync(app.dataDir).sort(), [store.ENTRIES_FILE, 'state.json'])
})

test('a state file without read permission is never written over', { skip: typeof process.getuid === 'function' && process.getuid() === 0 ? 'permissions do not apply to root' : process.platform === 'win32' ? 'no POSIX permissions' : false }, (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const app = fakeApp()
  writeEntries(app, [counter])
  const file = path.join(app.dataDir, 'state.json')
  fs.writeFileSync(file, stateWithTotal)
  fs.chmodSync(file, 0)
  t.after(() => fs.chmodSync(file, 0o644))
  const plugin = createPlugin(app)
  plugin.start({ timeZone: 'UTC' })
  app.send('a.total', 10)
  app.send('a.total', 15)
  plugin.stop()
  fs.chmodSync(file, 0o644)
  assert.equal(app.file('state.json'), stateWithTotal)
})

// ------------------------------------------------ a failed publication

for (const repeatInterval of [0, 10]) {
  test(`a number whose publication failed is sent again at the next pass (repeat interval ${repeatInterval})`, (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    let mono = 1e6
    t.mock.method(performance, 'now', () => mono)
    const app = fakeApp()
    const plugin = createPlugin(app)
    plugin.start({ timeZone: 'UTC', repeatInterval, formulas: [{ inputs: [{ name: 'a', path: 'in.a' }], expression: 'a * 2', output: 'out.double', staleTimeout: 0 }] })
    const accept = app.handleMessage
    app.handleMessage = () => { throw new Error('server busy') }
    app.send('in.a', 21)
    mono += 1000
    t.mock.timers.tick(1000)
    assert.match(app.errors.at(-1), /server busy/)
    app.handleMessage = accept
    mono += 1000
    t.mock.timers.tick(1000)
    assert.deepEqual(sentOn(app, 'out.double'), [42])
    plugin.stop()
  })
}

test('a null whose publication failed is sent again at the next pass', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let mono = 1e6
  t.mock.method(performance, 'now', () => mono)
  const app = fakeApp()
  const plugin = createPlugin(app)
  plugin.start({ timeZone: 'UTC', formulas: [{ inputs: [{ name: 'a', path: 'in.a' }], expression: 'a * 2', output: 'out.double', staleTimeout: 0 }] })
  app.send('in.a', 21)
  mono += 1000
  t.mock.timers.tick(1000)
  const accept = app.handleMessage
  app.handleMessage = () => { throw new Error('server busy') }
  app.send('in.a', null)
  mono += 1000
  t.mock.timers.tick(1000)
  app.handleMessage = accept
  mono += 1000
  t.mock.timers.tick(1000)
  assert.deepEqual(sentOn(app, 'out.double'), [42, null])
  plugin.stop()
})

// ------------------------------------------------ the 500 answer

test('a save that fails answers without naming the data folder, and logs the details', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const app = fakeApp()
  const { plugin, route } = started(app)
  plugin.start({ timeZone: 'UTC' })
  const { revision } = call(route('GET /api/config')).body
  // The data folder turns into something no file can be written under.
  const blocker = path.join(app.dataDir, 'blocker')
  fs.writeFileSync(blocker, '')
  const folder = app.dataDir
  app.dataDir = path.join(blocker, 'inside')
  const saved = call(route('PUT /api/config'), { body: { revision, groups: [], entries: [counter] } })
  app.dataDir = folder
  assert.equal(saved.statusCode, 500)
  assert.ok(!saved.body.error.includes(folder), saved.body.error)
  assert.ok(!saved.body.error.includes('ENOTDIR'), saved.body.error)
  assert.match(saved.body.error, /could not be saved/)
  assert.ok(app.logged.some((line) => line.includes('ENOTDIR') && line.includes(blocker)))
  plugin.stop()
})

// ------------------------------------------------ the OpenAPI description

test('the OpenAPI description names every answer the routes give', () => {
  const api = createPlugin(fakeApp()).getOpenApi()
  const put = api.paths['/api/config'].put
  assert.deepEqual(put.requestBody.content['application/json'].schema.required.sort(), ['entries', 'groups', 'revision'])
  assert.deepEqual(Object.keys(put.responses).sort(), ['200', '400', '409', '500', '503'])
  assert.deepEqual(Object.keys(put.responses[200].content['application/json'].schema.properties).sort(), ['entryErrors', 'entryFaults', 'kept', 'revision', 'saved', 'started', 'warning'])
  assert.deepEqual(Object.keys(api.paths['/api/config'].get.responses).sort(), ['200', '503'])
  assert.deepEqual(Object.keys(api.paths['/api/entries'].get.responses).sort(), ['200', '503'])
  assert.ok(api.paths['/api/entries'].get.responses[503].content['application/json'].schema.properties.blocked)
  const reset = api.paths['/api/entries/{id}/reset'].post
  assert.deepEqual(Object.keys(reset.responses).sort(), ['200', '404', '503'])
  assert.ok(reset.responses[200].content['application/json'].schema.properties.reset)
  const preview = api.paths['/api/preview'].post
  assert.deepEqual(Object.keys(preview.responses).sort(), ['200', '503'])
  assert.match(preview.description, new RegExp(`${store.MAX_TEXT} characters`))
  assert.match(preview.description, new RegExp(`${store.MAX_INPUTS} inputs`))
  assert.deepEqual(Object.keys(api.paths['/api/paths'].get.responses), ['200'])
})

// ------------------------------------------------ held and repeated values

test('a repeated value from the source being read is taken, not turned away as an old one', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.parse('2026-10-11T08:00:00Z') })
  const app = fakeApp()
  writeEntries(app, [counter])
  const { plugin, route } = started(app)
  plugin.start({ timeZone: 'UTC' })
  const push = (timestamp, value) => {
    for (const subscription of app.subscriptions) if (subscription.active) subscription.callback({ context: 'vessels.self', updates: [{ $source: 'dev.a', timestamp, values: [{ path: 'a.total', value }] }] })
  }
  push('2026-10-11T08:00:00.000Z', 10)
  push('2026-10-11T08:00:00.000Z', 10)
  t.mock.timers.tick(1000)
  assert.equal(call(route('GET /api/entries')).body.outdatedValues.count, 0)
  plugin.stop()
})

test('values held at start-up are fed oldest first, so a fall of the followed path comes after the step before it', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.parse('2026-10-11T08:00:00Z') })
  const settings = { timeZone: 'UTC', counters: [{ input: 'm.total', output: 'm.today', resets: 'path', resetPath: 'ref.today', staleTimeout: 0 }] }
  const app = fakeApp()
  const { plugin, route } = started(app)
  plugin.start(settings)
  app.send('ref.today', 1540)
  app.send('m.total', 1000)
  app.send('m.total', 1100)
  t.mock.timers.tick(1000)
  assert.equal(call(route('GET /api/entries')).body.entries[0].value, 100)
  plugin.stop()

  // While the plugin was stopped the total moved on by 200 and then, ten
  // seconds ago, the device began a new day. The server replays the newest
  // value first.
  const delta = ($source, timestamp, p, value) => ({ context: 'vessels.self', updates: [{ $source, timestamp, values: [{ path: p, value }] }] })
  app.replay = [delta('dev.ref', '2026-10-11T08:00:51.000Z', 'ref.today', 0), delta('dev.total', '2026-10-11T07:59:01.000Z', 'm.total', 1300)]
  t.mock.timers.tick(60000)
  plugin.start(settings)
  const entry = call(route('GET /api/entries')).body.entries[0]
  // The step to 1300 belongs to the day that ended; the new one starts at 0.
  assert.equal(entry.lastReset.cause, 'path')
  assert.equal(entry.value, 0)
  plugin.stop()
})

test('the value the server reports for a path is preferred to a replayed one', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.parse('2026-10-11T08:00:00Z') })
  const app = fakeApp({ 's.x': { value: 5, timestamp: '2026-10-11T07:59:00.000Z', $source: 'dev.a' } })
  // A newer value from a source the server does not give priority to.
  app.replay = [{ context: 'vessels.self', updates: [{ $source: 'dev.b', timestamp: '2026-10-11T07:59:55.000Z', values: [{ path: 's.x', value: 7 }] }] }]
  const { plugin, route } = started(app)
  plugin.start({ timeZone: 'UTC', formulas: [{ inputs: [{ name: 'x', path: 's.x' }], expression: 'x', output: 's.copy', staleTimeout: 0 }] })
  t.mock.timers.tick(1000)
  assert.equal(call(route('GET /api/entries')).body.entries[0].value, 5)
  assert.deepEqual(sentOn(app, 's.copy'), [5])
  plugin.stop()
})

// ------------------------------------------------ timers

test('stopping clears the timer, also after starting twice', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const timers = trackIntervals()
  try {
    const app = fakeApp()
    const plugin = createPlugin(app)
    plugin.start({ timeZone: 'UTC' })
    assert.equal(timers.live.size, 1)
    plugin.start({ timeZone: 'UTC' })
    assert.equal(timers.live.size, 1)
    plugin.stop()
    assert.equal(timers.live.size, 0)
    // Nothing goes out after the stop.
    const sent = app.messages.length
    t.mock.timers.tick(5000)
    assert.equal(app.messages.length, sent)
  } finally {
    timers.restore()
  }
})
