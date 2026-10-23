'use strict'

/*
 * Tests of the move from the plugin settings to the entries file, and of the
 * editor's routes, against the stand-in server in support.js.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

const createPlugin = require('../index')
const store = require('../lib/store')
const { call, fakeApp, fakeRouter } = require('./support')

const legacySettings = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'settings-0.2.1.json'), 'utf8'))

/** Saves a set the way the editor does: with the revision just read. */
function put (route, body) {
  const read = call(route('GET /api/config')).body
  return call(route('PUT /api/config'), { body: { revision: read.revision, ...body } })
}

function started (app) {
  const plugin = createPlugin(app)
  const router = fakeRouter()
  plugin.registerWithRouter(router)
  return { plugin, route: (key) => router.routes[key] }
}

test('the first start of 0.3.0 moves the entries out of the settings, keeps a copy and keeps every total', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const app = fakeApp({}, JSON.parse(JSON.stringify(legacySettings)))
  // State saved by 0.2.1: a manual total on one of the outputs.
  fs.writeFileSync(path.join(app.dataDir, 'state.json'), JSON.stringify({
    version: 1,
    savedAt: Date.now() - 60000,
    entries: { 'navigation.distance.overGround.total': { signature: 'integration|navigation.distance.overGround.movingSpeed|rate|', resets: 'manual', total: 1852, since: Date.now() - 86400000 } }
  }))
  const { plugin, route } = started(app)
  plugin.start(legacySettings.configuration)

  const doc = JSON.parse(app.file(store.ENTRIES_FILE))
  assert.equal(doc.entries.length, 14)
  assert.deepEqual(doc.groups, [])
  // The settings now hold only what applies to every entry.
  assert.ok(!store.hasListEntries(app.pluginOptions.configuration))
  assert.equal(app.pluginOptions.configuration.timeZoneSource, 'follow')
  assert.equal(app.pluginOptions.enabled, true)
  // The copy is the whole settings file as it was: the way back to 0.2.1.
  assert.deepEqual(JSON.parse(app.file(store.SETTINGS_COPY)), legacySettings)

  const status = call(route('GET /api/entries')).body
  assert.equal(status.entries.length, 14)
  assert.deepEqual(status.entries.map((e) => e.key), doc.entries.map((e) => e.id))
  assert.equal(status.entries.find((e) => e.output === 'navigation.distance.overGround.total').value, 1852)
  assert.match(status.notes[0], /^The 14 entries were moved from the plugin settings into the editor on this page/)
  plugin.stop()

  // A second start moves nothing and keeps the same ids.
  const app2 = app
  const second = started(app2)
  second.plugin.start(app2.pluginOptions.configuration)
  assert.deepEqual(JSON.parse(app2.file(store.ENTRIES_FILE)), doc)
  assert.deepEqual(call(second.route('GET /api/entries')).body.notes, [])
  assert.deepEqual(fs.readdirSync(app.dataDir).filter((f) => f.startsWith('settings-')), [store.SETTINGS_COPY])
  second.plugin.stop()
})

test('entries that turn up in the settings again are not used, and are kept and removed', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const app = fakeApp({}, JSON.parse(JSON.stringify(legacySettings)))
  const first = started(app)
  first.plugin.start(legacySettings.configuration)
  first.plugin.stop()
  const doc = app.file(store.ENTRIES_FILE)

  // As after going back to 0.2.1 and forward again.
  app.pluginOptions = JSON.parse(JSON.stringify(legacySettings))
  app.pluginOptions.configuration.formulas = [{ inputs: [{ name: 'x', path: 'a.x' }], expression: 'x', output: 'a.y' }]
  const second = started(app)
  second.plugin.start(app.pluginOptions.configuration)
  assert.equal(app.file(store.ENTRIES_FILE), doc)
  assert.ok(!store.hasListEntries(app.pluginOptions.configuration))
  const copies = fs.readdirSync(app.dataDir).filter((f) => f.startsWith('settings-removed-'))
  assert.equal(copies.length, 1)
  assert.match(call(second.route('GET /api/entries')).body.notes[0], /^The plugin settings held entries, which were not used/)
  second.plugin.stop()
})

test('a damaged entries file is reported, nothing runs or is saved, and a saved set moves it aside', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const app = fakeApp({ 'a.total': { value: 5, timestamp: new Date().toISOString() } })
  fs.writeFileSync(path.join(app.dataDir, store.ENTRIES_FILE), '{ "groups": [')
  fs.writeFileSync(path.join(app.dataDir, 'state.json'), JSON.stringify({ version: 1, savedAt: Date.now(), entries: { 'a.today': { signature: 'counter|a.total|increase', resets: 'manual', total: 42, last: 5 }, 'b.engineHours': { signature: 'counter|b.total|increase', resets: 'manual', total: 999999, last: 3 } } }))
  const stateBefore = app.file('state.json')
  const { plugin, route } = started(app)
  plugin.start({ timeZone: 'UTC' })
  assert.match(app.errors.at(-1), /^entries\.json is not valid JSON/)
  assert.equal(app.subscriptions.length, 0)
  const status = call(route('GET /api/entries'))
  assert.equal(status.statusCode, 503)
  assert.equal(status.body.blocked, true)
  const config = call(route('GET /api/config')).body
  assert.match(config.blocked, /^entries\.json is not valid JSON/)
  assert.deepEqual(config.entries, [])
  plugin.stop()
  assert.equal(app.file(store.ENTRIES_FILE), '{ "groups": [')
  assert.equal(app.file('state.json'), stateBefore)

  plugin.start({ timeZone: 'UTC' })
  const saved = put(route, { groups: [], entries: [{ id: 'e1', type: 'counter', input: 'a.total', output: 'a.today', resets: 'manual' }] })
  assert.equal(saved.statusCode, 200)
  assert.equal(fs.readdirSync(app.dataDir).filter((f) => f.startsWith('entries.json.unreadable-')).length, 1)
  const running = call(route('GET /api/entries')).body
  // The total saved before the file was damaged carries on.
  assert.equal(running.entries[0].value, 42)
  assert.match(running.notes.at(-1), /moved aside as entries\.json\.unreadable-\d+/)
  plugin.stop()
  // A total whose output the new set does not use is kept, to continue if
  // an entry with that output comes back.
  assert.ok(JSON.parse(app.file('state.json')).entries['b.engineHours'])
})

test('a set with faults is refused whole and names each fault at its entry', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const app = fakeApp()
  const { plugin, route } = started(app)
  plugin.start({ timeZone: 'UTC' })
  const save = (body) => put(route, body)

  const structure = save({ groups: [], entries: [{ id: 'e1', type: 'nope' }] })
  assert.equal(structure.statusCode, 400)
  assert.deepEqual(structure.body.errors, ['entry 1 has no known type (formula, counter, integration or cycles)'])

  const faults = save({
    groups: [],
    entries: [
      { id: 'good', type: 'counter', input: 'a.total', output: 'a.today' },
      { id: 'bad', type: 'formula', inputs: [{ name: 'x', path: 'a.x' }], expression: 'x +', output: 'a.y' },
      { id: 'twice', type: 'counter', input: 'b.total', output: 'a.today' },
      { id: 'draft', type: 'formula', enabled: false, inputs: [], expression: '', output: '' }
    ]
  })
  assert.equal(faults.statusCode, 400)
  assert.equal(faults.body.error, '2 entries cannot run as set. Nothing was saved.')
  assert.deepEqual(Object.keys(faults.body.entryErrors).sort(), ['bad', 'draft', 'twice'])
  assert.match(faults.body.entryErrors.bad, /^the expression does not parse/)
  assert.match(faults.body.entryErrors.twice, /already written by/)
  assert.equal(app.file(store.ENTRIES_FILE), null)

  // A switched-off draft may be saved unfinished.
  const draft = save({ groups: [], entries: [{ id: 'draft', type: 'formula', enabled: false, inputs: [], expression: '', output: '' }] })
  assert.equal(draft.statusCode, 200)
  assert.deepEqual(Object.keys(draft.body.entryErrors), ['draft'])
  plugin.stop()
})

test('an editor that read an older version cannot overwrite a newer one', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const app = fakeApp()
  const { plugin, route } = started(app)
  plugin.start({ timeZone: 'UTC' })
  const first = call(route('GET /api/config')).body
  const entry = { id: 'e1', type: 'counter', input: 'a.total', output: 'a.today' }
  const saved = call(route('PUT /api/config'), { body: { revision: first.revision, groups: [], entries: [entry] } })
  assert.equal(saved.statusCode, 200)
  const stale = call(route('PUT /api/config'), { body: { revision: first.revision, groups: [], entries: [] } })
  assert.equal(stale.statusCode, 409)
  // A save without a revision is refused too.
  const blind = call(route('PUT /api/config'), { body: { groups: [], entries: [] } })
  assert.equal(blind.statusCode, 409)
  assert.match(blind.body.error, /^The revision of the entries read is missing/)
  assert.equal(JSON.parse(app.file(store.ENTRIES_FILE)).entries.length, 1)
  const fresh = call(route('PUT /api/config'), { body: { revision: saved.body.revision, groups: [], entries: [] } })
  assert.equal(fresh.statusCode, 200)
  plugin.stop()
})

test('saving subscribes again only for new paths, and takes in their held values', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const now = new Date().toISOString()
  const app = fakeApp({ 'a.total': { value: 10, timestamp: now }, 'b.total': { value: 70, timestamp: now } })
  const { plugin, route } = started(app)
  plugin.start({ timeZoneSource: 'fixed', timeZone: 'UTC' })
  const a = { id: 'a', type: 'counter', input: 'a.total', output: 'a.today', resets: 'manual', staleTimeout: 0 }
  put(route, { groups: [], entries: [a] })
  assert.equal(app.subscriptions.filter((s) => s.active).length, 1)
  app.send('a.total', 15)

  // A rename changes no path: the subscription stays as it is.
  const count = app.subscriptions.length
  const renamed = put(route, { groups: [], entries: [{ ...a, name: 'A' }] })
  assert.deepEqual([renamed.body.kept, renamed.body.started], [1, 0])
  assert.equal(app.subscriptions.length, count)

  // A new path: subscribed afresh, its held value taken in at once.
  const b = { id: 'b', type: 'counter', input: 'b.total', output: 'b.today', resets: 'manual', staleTimeout: 0 }
  const added = put(route, { groups: [{ id: 'g1', name: 'Tanks' }], entries: [{ ...b, group: 'g1' }, { ...a, name: 'A' }] })
  assert.deepEqual([added.body.kept, added.body.started], [1, 1])
  assert.equal(app.subscriptions.length, count + 1)
  assert.deepEqual(app.subscriptions.at(-1).command.subscribe.map((s) => s.path), ['a.total', 'b.total'])
  app.send('a.total', 20)
  app.send('b.total', 75)
  // Live values are handed to the engine once the server has finished
  // delivering; see onDelta() in index.js.
  await new Promise(setImmediate)
  const status = call(route('GET /api/entries')).body
  assert.deepEqual(status.groups, [{ id: 'g1', name: 'Tanks' }])
  assert.deepEqual(status.entries.map((e) => [e.key, e.group, e.value]), [['b', 'g1', 5], ['a', null, 10]])
  plugin.stop()
})

test('the editor routes ask for write permission, and the status route only for reading', () => {
  const router = fakeRouter()
  createPlugin(fakeApp()).registerWithRouter(router)
  const levels = Object.fromEntries(Object.entries(router.routes).map(([key, route]) => [key, route.level]))
  assert.deepEqual(levels, {
    'GET /api/entries': 'readonly',
    'POST /api/entries/:id/reset': 'readwrite',
    'GET /api/config': 'readwrite',
    'PUT /api/config': 'readwrite',
    'GET /api/paths': 'readwrite',
    'POST /api/preview': 'readwrite'
  })
})

test('the editor gets the paths with values and units, and a preview of a formula', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const now = new Date().toISOString()
  const app = fakeApp({
    'el.current': { value: 7.5, timestamp: now, meta: { units: 'A', description: 'Current' } },
    'el.voltage': { value: 26, timestamp: now, meta: { units: 'V' } },
    'navigation.position': { value: { latitude: 1, longitude: 2 }, timestamp: now }
  })
  const { plugin, route } = started(app)
  plugin.start({ timeZone: 'UTC' })
  put(route, { groups: [], entries: [{ id: 'w', type: 'formula', inputs: [{ name: 'i', path: 'el.current' }, { name: 'v', path: 'el.voltage' }], expression: 'i * v', output: 'el.power', unit: 'W' }] })

  const paths = call(route('GET /api/paths')).body
  assert.deepEqual(paths.find((p) => p.path === 'el.current'), { path: 'el.current', value: 7.5, units: 'A', description: 'Current' })
  assert.deepEqual(paths.find((p) => p.path === 'navigation.position'), { path: 'navigation.position', kind: 'object' })
  // An entry's own output is offered too, marked as such.
  assert.equal(paths.find((p) => p.path === 'el.power').entry, 'w')

  const preview = (body) => call(route('POST /api/preview'), { body }).body
  assert.deepEqual(preview({ inputs: [{ name: 'i', path: 'el.current' }, { name: 'v', path: 'el.voltage' }], expression: 'i * v' }), { value: 195, values: { i: 7.5, v: 26 } })
  assert.deepEqual(preview({ inputs: [{ name: 'p', path: 'el.power' }], expression: 'p / 1000' }), { value: 0.195, values: { p: 195 } })
  assert.deepEqual(preview({ inputs: [{ name: 'x', path: 'no.such' }], expression: 'x' }), { missing: ['no.such'] })
  assert.match(preview({ inputs: [], expression: 'y + 1' }).error, /"y", which is not an input/)
  assert.match(preview({ inputs: [{ name: 'i', path: 'el.current' }], expression: 'i / 0' }).error, /no finite number/)
  // An input with a value when stale and no value on the server counts as
  // that value; one with a value that is fresh is read as it is.
  assert.deepEqual(preview({ inputs: [{ name: 'i', path: 'el.current', whenStale: 1 }, { name: 'c', path: 'el.charger', whenStale: 0 }], expression: 'i + c' }), {
    value: 7.5,
    values: { i: 7.5, c: 0 },
    substituted: [{ name: 'c', path: 'el.charger', value: 0, reason: 'none' }]
  })
  // A path that holds something other than a number is 'invalid', as in
  // the engine.
  assert.deepEqual(preview({ inputs: [{ name: 'p', path: 'navigation.position', whenStale: 5 }], expression: 'p' }).substituted, [{ name: 'p', path: 'navigation.position', value: 5, reason: 'invalid' }])
  plugin.stop()
})

test('the preview counts an input as its value when stale once the value is older than the stale timeout', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const old = new Date(Date.now() - 120000).toISOString()
  const app = fakeApp({ 'el.charger': { value: 300, timestamp: old, meta: { units: 'W' } } })
  const { plugin, route } = started(app)
  plugin.start({ timeZone: 'UTC' })
  const preview = (body) => call(route('POST /api/preview'), { body }).body
  const inputs = [{ name: 'c', path: 'el.charger', whenStale: 0 }]
  assert.deepEqual(preview({ inputs, expression: 'c', staleTimeout: 60 }).values, { c: 0 })
  assert.deepEqual(preview({ inputs, expression: 'c', staleTimeout: 300 }).values, { c: 300 })
  assert.deepEqual(preview({ inputs, expression: 'c', staleTimeout: 0 }).values, { c: 300 })
  // A timeout left out or emptied is the default of 60 s, as in the entries
  // file, not 0.
  assert.deepEqual(preview({ inputs, expression: 'c', staleTimeout: null }).values, { c: 0 })
  assert.deepEqual(preview({ inputs, expression: 'c', staleTimeout: '' }).values, { c: 0 })
  assert.deepEqual(preview({ inputs, expression: 'c' }).values, { c: 0 })
  plugin.stop()
})
