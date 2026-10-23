'use strict'

/*
 * Tests of the plugin as the server sees it, for the changes of version
 * 0.7.0 in the adapter: publications that carry a time stamp of their own,
 * metadata that follows the entries as they are edited, and a reset route
 * that a form on another site cannot call.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

const createPlugin = require('../index')
const { Engine } = require('../lib/engine')
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

/** Saves a new set of entries through the editor's route, as the page does. */
function saveEntries (route, entries) {
  const { revision } = call(route('GET /api/config')).body
  const answer = call(route('PUT /api/config'), { body: { revision, groups: [], entries } })
  assert.equal(answer.statusCode, 200, JSON.stringify(answer.body))
}

/** Calls a route handler with request headers, which support.call() does not send. */
function callWith (route, { params = {}, body, headers = {} } = {}) {
  const response = { statusCode: 200, body: null }
  route.handler({ params, body, headers }, {
    status (code) { response.statusCode = code; return this },
    json (value) { response.body = value }
  })
  return response
}

/** The metadata items sent from message `from` on, flattened in order. */
function metaSent (app, from = 0) {
  return app.messages.slice(from).flatMap(({ delta }) => delta.updates.flatMap((u) => u.meta || []))
}

/** The value updates sent from message `from` on, one item per update. */
function valueUpdates (app, from = 0) {
  return app.messages.slice(from).flatMap(({ delta }) => delta.updates.filter((u) => u.values))
}

const counter = { id: 'e1', type: 'counter', name: 'Today', input: 'a.total', output: 'a.today', unit: 'J', resets: 'manual', staleTimeout: 0 }
const formula = { id: 'e2', type: 'formula', name: 'Doubled', inputs: [{ name: 'x', path: 'a.total' }], expression: 'x * 2', output: 'a.doubled', staleTimeout: 0 }

// --------------------------------------- publications with a time stamp

test('publications with a time stamp go out in updates of their own, oldest first, before the rest', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const app = fakeApp()
  writeEntries(app, [counter])
  const { plugin } = started(app)
  const early = Date.parse('2026-10-31T23:59:59.999Z')
  const late = Date.parse('2026-11-01T23:59:59.999Z')
  const output = [
    { path: 'a.week', value: 70, timestamp: late },
    { path: 'a.today', value: 12, timestamp: early },
    { path: 'a.month', value: 300, timestamp: late },
    { path: 'a.today', value: 0 },
    { path: 'a.doubled', value: null }
  ]
  t.mock.method(Engine.prototype, 'tick', () => output.map((item) => ({ ...item })))
  plugin.start({ timeZone: 'UTC' })
  const updates = valueUpdates(app)
  assert.deepEqual(updates[0], { timestamp: '2026-10-31T23:59:59.999Z', values: [{ path: 'a.today', value: 12 }] })
  assert.deepEqual(updates[1], { timestamp: '2026-11-01T23:59:59.999Z', values: [{ path: 'a.week', value: 70 }, { path: 'a.month', value: 300 }] })
  // Without a time stamp of its own a value is stamped by the server on
  // arrival, as before.
  assert.deepEqual(updates[2], { values: [{ path: 'a.today', value: 0 }, { path: 'a.doubled', value: null }] })
  assert.equal(updates.length, 3)
  // All of them in one message, so that a failure leaves none half sent.
  assert.equal(app.messages.filter(({ delta }) => delta.updates.some((u) => u.values)).length, 1)
  plugin.stop()
})

test('a pass with only current values sends one update without a time stamp, as before', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const app = fakeApp()
  writeEntries(app, [counter])
  const { plugin } = started(app)
  plugin.start({ timeZone: 'UTC' })
  app.send('a.total', 10)
  app.send('a.total', 15)
  t.mock.timers.tick(1000)
  assert.deepEqual(valueUpdates(app), [{ values: [{ path: 'a.today', value: 5 }] }])
  plugin.stop()
})

test('every publication of a pass that could not be sent is handed back to the engine, also those with a time stamp', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const app = fakeApp()
  writeEntries(app, [counter])
  const { plugin } = started(app)
  const output = [{ path: 'a.today', value: 12, timestamp: Date.parse('2026-10-31T23:59:59.999Z') }, { path: 'a.today', value: 0 }]
  t.mock.method(Engine.prototype, 'tick', () => output.map((item) => ({ ...item })))
  const handedBack = []
  t.mock.method(Engine.prototype, 'republish', (publications) => handedBack.push(publications))
  app.handleMessage = (id, delta) => {
    if (delta.updates.some((u) => u.values)) throw new Error('bus closed')
    app.messages.push({ id, delta })
  }
  plugin.start({ timeZone: 'UTC' })
  assert.deepEqual(handedBack, [output])
  assert.match(app.logged.at(-1), /bus closed/)
  plugin.stop()
})

test('the closing total of a day goes out stamped a millisecond before midnight, then the new day\'s total', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.parse('2026-10-22T23:59:50Z') })
  const app = fakeApp()
  writeEntries(app, [{ ...counter, resets: 'day' }])
  const { plugin } = started(app)
  plugin.start({ timeZone: 'UTC' })
  app.send('a.total', 100)
  app.send('a.total', 130)
  t.mock.timers.tick(1000)
  assert.equal(app.values()['a.today'], 30)
  const from = app.messages.length
  t.mock.timers.tick(10000)
  const updates = valueUpdates(app, from)
  const closing = updates.find((u) => u.timestamp)
  assert.deepEqual(closing, { timestamp: '2026-10-22T23:59:59.999Z', values: [{ path: 'a.today', value: 30 }] })
  // The new day starts from nothing, sent after the closing figure and
  // stamped by the server on arrival.
  const after = updates.slice(updates.indexOf(closing) + 1)
  assert.deepEqual(after[0], { values: [{ path: 'a.today', value: 0 }] })
  plugin.stop()
})

// ------------------------------------------------- metadata after edits

test('an edit sends metadata only for outputs whose metadata changed, and empties what was taken away', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const app = fakeApp()
  writeEntries(app, [counter, formula])
  const { plugin, route } = started(app)
  plugin.start({ timeZone: 'UTC' })
  assert.deepEqual(metaSent(app), [
    { path: 'a.today', value: { units: 'J', displayName: 'Today', description: 'Today' } },
    { path: 'a.doubled', value: { displayName: 'Doubled', description: 'Doubled' } }
  ])

  // The unit is taken away: only it is sent, as null.
  let from = app.messages.length
  saveEntries(route, [{ ...counter, unit: '' }, formula])
  assert.deepEqual(metaSent(app, from), [{ path: 'a.today', value: { units: null } }])

  // An edit that leaves the metadata as it is sends none.
  from = app.messages.length
  saveEntries(route, [{ ...counter, unit: '', staleTimeout: 30 }, formula])
  assert.deepEqual(metaSent(app, from), [])

  // A new name replaces the old one.
  from = app.messages.length
  saveEntries(route, [{ ...counter, unit: '', name: 'Yield today' }, formula])
  assert.deepEqual(metaSent(app, from), [{ path: 'a.today', value: { displayName: 'Yield today', description: 'Yield today' } }])

  // The name is taken away, and a unit given back.
  from = app.messages.length
  saveEntries(route, [{ ...counter, name: '' }, formula])
  assert.deepEqual(metaSent(app, from), [{ path: 'a.today', value: { units: 'J', displayName: null, description: '' } }])
  plugin.stop()
})

test('an output given up by an entry renamed, switched off or deleted has its metadata emptied', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const app = fakeApp()
  writeEntries(app, [counter, formula])
  const { plugin, route } = started(app)
  plugin.start({ timeZone: 'UTC' })

  // A new output path: the old one is emptied, the new one announced.
  let from = app.messages.length
  saveEntries(route, [{ ...counter, output: 'a.daily' }, formula])
  assert.deepEqual(metaSent(app, from), [
    { path: 'a.today', value: { units: null, displayName: null, description: '' } },
    { path: 'a.daily', value: { units: 'J', displayName: 'Today', description: 'Today' } }
  ])

  // Switched off: the entry no longer publishes there.
  from = app.messages.length
  saveEntries(route, [{ ...counter, output: 'a.daily' }, { ...formula, enabled: false }])
  assert.deepEqual(metaSent(app, from), [{ path: 'a.doubled', value: { displayName: null, description: '' } }])

  // Deleted.
  from = app.messages.length
  saveEntries(route, [{ ...formula, enabled: false }])
  assert.deepEqual(metaSent(app, from), [{ path: 'a.daily', value: { units: null, displayName: null, description: '' } }])

  // Switched on again: announced afresh.
  from = app.messages.length
  saveEntries(route, [formula])
  assert.deepEqual(metaSent(app, from), [{ path: 'a.doubled', value: { displayName: 'Doubled', description: 'Doubled' } }])
  plugin.stop()
})

test('metadata that could not be sent is sent again at the next edit', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const app = fakeApp()
  writeEntries(app, [counter])
  const { plugin, route } = started(app)
  plugin.start({ timeZone: 'UTC' })
  const handle = app.handleMessage
  app.handleMessage = (id, delta) => {
    if (delta.updates.some((u) => u.meta)) throw new Error('bus closed')
    handle(id, delta)
  }
  saveEntries(route, [{ ...counter, unit: 'Wh' }])
  app.handleMessage = handle
  const from = app.messages.length
  saveEntries(route, [{ ...counter, unit: 'Wh', staleTimeout: 30 }])
  assert.deepEqual(metaSent(app, from), [{ path: 'a.today', value: { units: 'Wh' } }])
  plugin.stop()
})

// ------------------------------------------------------ the reset route

test('the reset route acts only on a request sent as JSON', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const app = fakeApp()
  writeEntries(app, [counter])
  const { plugin, route } = started(app)
  plugin.start({ timeZone: 'UTC' })
  app.send('a.total', 10)
  app.send('a.total', 15)
  t.mock.timers.tick(1000)
  const reset = route('POST /api/entries/:id/reset')
  const params = { id: 'a.today' }

  // What a form on another site can send, and a request without any type.
  for (const type of [undefined, 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'text/plain', 'application/jsonx']) {
    const answer = callWith(reset, { params, headers: type === undefined ? {} : { 'content-type': type } })
    assert.equal(answer.statusCode, 415, String(type))
    assert.match(answer.body.error, /application\/json/)
  }
  assert.equal(call(reset, { params }).statusCode, 415)
  assert.equal(app.values()['a.today'], 5, 'a refused request reset the total')

  assert.deepEqual(callWith(reset, { params, headers: { 'content-type': 'Application/JSON; charset=utf-8' } }), { statusCode: 200, body: { reset: 'a.today' } })
  t.mock.timers.tick(1000)
  assert.equal(app.values()['a.today'], 0)
  plugin.stop()
})

// ----------------------------------------------------------- OpenAPI

test('the OpenAPI description names the 415 answer, the closing total and the ON time so far', () => {
  const api = createPlugin(fakeApp()).getOpenApi()
  const reset = api.paths['/api/entries/{id}/reset'].post
  assert.deepEqual(Object.keys(reset.responses).sort(), ['200', '404', '415', '503'])
  assert.match(reset.description, /Content-Type: application\/json/)
  assert.ok(reset.requestBody.content['application/json'])
  const entry = api.paths['/api/entries'].get.responses[200].content['application/json'].schema.properties.entries.items
  assert.equal(entry.properties.lastReset.properties.total.type, 'number')
  assert.ok(entry.properties.statistic.enum.includes('onSoFar'))
  assert.equal(entry.properties.cycles.properties.onSoFar.type, 'number')
  assert.equal(entry.properties.cycles.properties.onSoFar.nullable, true)
})
