'use strict'

/*
 * Filling in from the history when an entry starts with nothing saved, from
 * version 0.8.0: lib/history.js and the engine's look-back.
 */

const assert = require('node:assert/strict')
const { test } = require('node:test')

const { normalizeConfig } = require('../lib/config')
const { Engine, LOOKBACK_GIVE_UP_MS, integrateRows } = require('../lib/engine')
const { HistoryReader, lookBack, resolutionFor } = require('../lib/history')
const { fakeHistory } = require('./support')

const T0 = Date.parse('2026-10-24T12:00:00Z')
const H = 3600000

/** Samples every `step` ms from `from` to `to` (not included), valued by `f`. */
function samples (from, to, step, f) {
  const list = []
  for (let t = from; t < to; t += step) list.push({ t, v: f(t) })
  return list
}

function engineFor (entries, saved = null) {
  const doc = { version: 1, groups: [], entries: entries.map((entry, i) => ({ id: `e${i + 1}`, ...entry })) }
  const normalized = normalizeConfig({ timeZone: 'UTC' }, doc)
  for (const entry of normalized.entries) assert.equal(entry.error, null, `${entry.label}: ${entry.error}`)
  return new Engine(normalized, saved)
}

// ---------------------------------------------------------------- reading

test('a read asks for buckets within the budget and leaves out the bucket stamped "to"', async () => {
  const history = fakeHistory({ 'a.b': samples(T0 - 2 * H, T0 + 1000, 1000, () => 1) })
  const reader = new HistoryReader(history)
  const rows = await reader.series('a.b', 'average', T0 - 2 * H, T0, 60)
  assert.equal(rows.length, 120)
  assert.ok(rows.every((row) => row.t < T0))
  assert.equal(history.requests[0].from, new Date(T0 - 2 * H).toISOString())
  assert.equal(resolutionFor(60 * 24 * H), Math.ceil(60 * 24 * 3600 / 40000))
  assert.equal(resolutionFor(H, 10), 10)
})

test('a path the history does not hold reads as empty; other failures are thrown', async () => {
  const history = fakeHistory({ 'a.b': [{ t: T0 - 1000, v: 1 }] })
  const reader = new HistoryReader(history)
  assert.deepEqual(await reader.series('x.y', 'average', T0 - H, T0, 1), [])
  history.fail = 'database is starting'
  await assert.rejects(reader.series('a.b', 'average', T0 - H, T0, 1), /database is starting/)
})

test('a switch stored as true and false is read by its last value when it cannot be averaged', async () => {
  const history = fakeHistory({ 's.on': [{ t: T0 - 10000, v: true }, { t: T0 - 5000, v: false }] })
  const rows = await new HistoryReader(history).series('s.on', 'average', T0 - H, T0, 1)
  assert.deepEqual(rows.map((row) => row.v), [1, 0])
  assert.equal(history.requests[1].pathSpecs[0].aggregate, 'last')
})

test('the last moment at a level and an extreme are found to the second', async () => {
  // A battery full until 07:13:27 three days ago, then falling to its
  // lowest at 05:41:09 this morning.
  const full = Date.parse('2026-10-21T07:13:27Z')
  const low = Date.parse('2026-10-24T05:41:09Z')
  const soc = (t) => (t <= full ? 1 : t === low ? 0.31 : 0.5 + 0.1 * Math.sin(t / 7e6))
  const list = samples(T0 - 10 * 24 * H, T0, 1000, soc)
  const history = fakeHistory({ 'b.soc': list })
  const reader = new HistoryReader(history)
  assert.equal(await reader.lastAt('b.soc', 1, true, T0 - 30 * 24 * H, T0), full)
  assert.deepEqual(await reader.extreme('b.soc', true, full, T0), { value: 0.31, at: low })
  assert.equal(await reader.lastAt('b.soc', 0.2, false, T0 - 30 * 24 * H, T0), null)
  // Every read stayed within the budget.
  for (const request of history.requests) {
    const span = Date.parse(request.to) - Date.parse(request.from)
    assert.ok(span / 1000 / request.resolution <= 40000 + 1)
  }
})

test('the last fall of a followed path is found', async () => {
  const fall = Date.parse('2026-10-24T00:00:00Z')
  const list = samples(T0 - 2 * 24 * H, T0, 60000, (t) => t < fall ? 500 + (t - (T0 - 2 * 24 * H)) / 1e5 : (t - fall) / 1e5)
  const reader = new HistoryReader(fakeHistory({ 'y.today': list }))
  const found = await reader.lastFall('y.today', T0 - 5 * 24 * H, T0)
  // Read again in finer buckets, the fall is placed at the sample after it,
  // not at the start of the coarse bucket it shows in.
  assert.ok(found >= fall && found - fall <= 60000, new Date(found).toISOString())
})

test('a counter that follows another path fills in from that path\'s last fall, to the second', async () => {
  const fall = Date.parse('2026-10-24T00:00:00Z')
  const history = fakeHistory({
    'y.today': samples(T0 - 3 * 24 * H, T0, 1000, (t) => ((t - fall) % (24 * H) + 24 * H) % (24 * H) / 1000),
    'c.total': samples(T0 - 3 * 24 * H, T0, 60000, (t) => (t - (T0 - 3 * 24 * H)) / 60000)
  })
  const engine = engineFor([{ type: 'counter', input: 'c.total', output: 'c.sinceReset', resets: 'path', resetPath: 'y.today', staleTimeout: 0 }])
  engine.tick(T0, 0)
  const [plan] = engine.lookbackPlans(T0, 0)
  const answer = await lookBack(history, plan)
  assert.equal(answer.from, fall)
  engine.applyLookback(plan, answer, T0 + 1000, 1000)
  // One a minute for the twelve hours since the fall, less the first minute
  // the first bucket stands at.
  const value = engine.snapshot(T0 + 1000, 1000)[0].value
  assert.ok(value >= 718 && value <= 720, String(value))
})

test('a counter that follows a path with no fall in the history fills in nothing', async () => {
  const history = fakeHistory({ 'c.total': samples(T0 - 400 * 24 * H, T0, 3600000, (t) => (t - (T0 - 400 * 24 * H)) / 3600000) })
  const engine = engineFor([{ type: 'counter', input: 'c.total', output: 'c.trip', resets: 'path', resetPath: 't.trip', staleTimeout: 0 }])
  engine.tick(T0, 0)
  const [plan] = engine.lookbackPlans(T0, 0)
  const answer = await lookBack(history, plan)
  engine.applyLookback(plan, answer, T0 + 1000, 1000)
  const state = engine.snapshot(T0 + 1000, 1000)[0]
  assert.equal(state.value, null)
  assert.equal(state.history.outcome, 'empty')
  assert.match(state.history.reason, /no fall of t\.trip/)
})

test('a read that is given up makes no further request', async () => {
  const history = fakeHistory({ 'a.b': samples(T0 - H, T0, 1000, () => 1) })
  let stop = false
  const reader = new HistoryReader(history, () => stop)
  await reader.series('a.b', 'min', T0 - H, T0, 1)
  stop = true
  await assert.rejects(reader.read('a.b', 'min', T0 - H, T0, 1), /given up/)
  assert.equal(history.requests.length, 1)
})

// -------------------------------------------------------------- integrals

test('an integration adds up buckets as held values, leaving gaps out or bridging them', () => {
  const rows = [{ t: 0, v: 10 }, { t: 1000, v: 20 }, { t: 2000, v: 30 }, { t: 100000, v: 40 }]
  const base = { mode: 'rate', threshold: 0, gap: 'skip', staleMs: 5000 }
  // 10 + 20 + 30 for a second each, the gap after 30 left out, then 40 up to "to".
  assert.equal(integrateRows(rows, 1, 0, 101000, base), 10 + 20 + 30 + 40)
  assert.equal(integrateRows(rows, 1, 0, 101000, { ...base, gap: 'bridge' }), 10 + 20 + 30 * 98 + 40)
  // An input sent only when it changes holds across any stretch.
  assert.equal(integrateRows(rows, 1, 0, 101000, { ...base, staleMs: 0 }), 10 + 20 + 30 * 98 + 40)
  // Time above a threshold.
  assert.equal(integrateRows(rows, 1, 0, 101000, { ...base, mode: 'time', threshold: 25 }), 2)
  // Only what lies between "from" and "to" counts.
  assert.equal(integrateRows(rows, 1, 1500, 2500, base), 20 * 0.5 + 30 * 0.5)
})

// ------------------------------------------------------------- the engine

test('an entry with nothing saved plans one look-back up to the moment it began counting', () => {
  const engine = engineFor([
    { type: 'counter', input: 'f.used', output: 'f.today', resets: 'day' },
    { type: 'integration', input: 'p.w', output: 'p.j', resets: 'manual', lookback: false },
    { type: 'formula', inputs: [{ name: 'a', path: 'p.w' }], expression: 'a', output: 'p.copy' }
  ])
  engine.tick(T0, 0)
  const plans = engine.lookbackPlans(T0 + 5000, 5000)
  assert.equal(plans.length, 1)
  assert.equal(plans[0].type, 'counter')
  assert.equal(plans[0].to, T0)
  assert.equal(plans[0].from, Date.parse('2026-10-24T00:00:00Z'))
  // Planned once.
  assert.deepEqual(engine.lookbackPlans(T0 + 6000, 6000), [])
  engine.input('f.used', 5, T0 + 7000, 7000)
  // Saved while the look-back is under way, the entry carries it on after a
  // restart, up to the same moment.
  const counter = [{ type: 'counter', input: 'f.used', output: 'f.today', resets: 'day' }]
  const carried = engineFor(counter, engine.serialize(T0 + 8000))
  carried.tick(T0 + 9000, 9000)
  const replans = carried.lookbackPlans(T0 + 9000, 9000)
  assert.equal(replans.length, 1)
  assert.equal(replans[0].to, T0)
  // Once it is done, a restart does not look back.
  carried.applyLookback(replans[0], { from: replans[0].from, resolution: 3, rows: [] }, T0 + 9500, 9500)
  const again = engineFor(counter, carried.serialize(T0 + 10000))
  again.tick(T0 + 11000, 11000)
  assert.deepEqual(again.lookbackPlans(T0 + 11000, 11000), [])
})

test('a new counter fills in what its input changed by since the period began', async () => {
  const midnight = Date.parse('2026-10-24T00:00:00Z')
  // A fuel total that grew by 0.01 every minute since 06:00, with one bad
  // reading of 0 that the next value undoes.
  const list = samples(midnight - H, T0, 60000, (t) => 100 + Math.max(0, t - (midnight + 6 * H)) / 6e6)
  list[500].v = 0
  const history = fakeHistory({ 'f.used': list })
  const engine = engineFor([{ type: 'counter', input: 'f.used', output: 'f.today', resets: 'day', staleTimeout: 0 }])
  engine.tick(T0, 0)
  // The first live value arrives after the entry started.
  engine.input('f.used', 100 + 6 * H / 6e6 + 0.02, T0 + 2000, 2000)
  const [plan] = engine.lookbackPlans(T0 + 3000, 3000)
  const answer = await lookBack(history, plan)
  assert.equal(answer.from, midnight)
  assert.equal(engine.applyLookback(plan, answer, T0 + 4000, 4000), true)
  const state = engine.snapshot(T0 + 4000, 4000)[0]
  // 0.6 an hour for six hours, plus the step to the first live value; the
  // bad reading of 0 is not counted as a restart.
  assert.ok(Math.abs(state.value - (3.6 + 0.02)) < 0.011, String(state.value))
  assert.equal(state.history.outcome, 'filled')
  assert.equal(state.history.from, '2026-10-24T00:00:00.000Z')
  assert.equal(state.since, '2026-10-24T00:00:00.000Z')
  // Live counting carries on from there.
  engine.input('f.used', 100 + 6 * H / 6e6 + 0.05, T0 + 5000, 5000)
  assert.ok(Math.abs(engine.snapshot(T0 + 5000, 5000)[0].value - 3.65) < 0.011)
  // The look-back is saved with the total, for the status page.
  assert.equal(engine.serialize(T0 + 5000).entries['f.today'].history.outcome, 'filled')
})

test('a new integration fills in its sum, and is published like a saved total until its input speaks', async () => {
  const midnight = Date.parse('2026-10-24T00:00:00Z')
  const history = fakeHistory({ 'p.w': samples(midnight, T0, 5000, () => 100) })
  const engine = engineFor([{ type: 'integration', input: 'p.w', output: 'p.today', resets: 'day', unit: 'J', onStale: 'hold' }])
  engine.tick(T0, 0)
  const [plan] = engine.lookbackPlans(T0, 0)
  engine.applyLookback(plan, await lookBack(history, plan), T0 + 1000, 1000)
  const published = engine.tick(T0 + 1000, 1000)
  assert.equal(published.length, 1)
  assert.ok(Math.abs(published[0].value - 100 * 12 * 3600) < 1)
  assert.match(engine.snapshot(T0 + 1000, 1000)[0].message, /filled in from the history/)
})

test('a look-back that comes after the period ended is dropped', async () => {
  const late = Date.parse('2026-10-24T23:59:30Z')
  const history = fakeHistory({ 'p.w': samples(late - H, late, 5000, () => 100) })
  const engine = engineFor([{ type: 'integration', input: 'p.w', output: 'p.today', resets: 'day', staleTimeout: 0 }])
  engine.tick(late, 0)
  engine.input('p.w', 100, late, 0)
  const [plan] = engine.lookbackPlans(late, 0)
  const answer = await lookBack(history, plan)
  engine.tick(late + 60000, 60000)
  engine.applyLookback(plan, answer, late + 60000, 60000)
  const state = engine.snapshot(late + 60000, 60000)[0]
  assert.equal(state.history.outcome, 'skipped')
  assert.ok(state.value < 100 * 31)
})

test('a new cycles entry rebuilds the stretches of its window from the history', async () => {
  // A compressor ON for 20 minutes and OFF for 40, all day.
  const list = samples(T0 - 25 * H, T0, 10000, (t) => (Math.floor(t / 60000) % 60) < 20 ? 3 : 0)
  const history = fakeHistory({ 'f.amps': list })
  const engine = engineFor([{ type: 'cycles', inputs: [{ path: 'f.amps', kind: 'onoff', threshold: 1 }], statistic: 'onMedian', output: 'f.onMedian', staleTimeout: 60 }])
  engine.tick(T0, 0)
  const [plan] = engine.lookbackPlans(T0, 0)
  assert.equal(plan.from, T0 - 24 * H)
  const answer = await lookBack(history, plan)
  engine.applyLookback(plan, answer, T0, 0)
  const state = engine.snapshot(T0, 0)[0]
  assert.equal(state.history.outcome, 'filled')
  assert.ok(state.cycles.count >= 22, String(state.cycles.count))
  assert.equal(state.cycles.onMedian, 1200)
  assert.ok(Math.abs(state.cycles.duty - 1 / 3) < 1e-9)
  // The figure is there at once, as the entry's value.
  assert.equal(state.value, 1200)
})

test('a new record looks back for the lowest since the input was last at the level', async () => {
  const full = Date.parse('2026-09-24T14:05:00Z')
  const low = Date.parse('2026-10-07T03:00:00Z')
  const list = samples(T0 - 60 * 24 * H, T0, 10000, (t) => t <= full ? 1 : t === low ? 0.37 : 0.6)
  const history = fakeHistory({ 'b.soc': list })
  const engine = engineFor([
    { type: 'record', input: 'b.soc', keep: 'lowest', resets: 'level', resetLevel: 1, output: 'b.lowest', timeOutput: 'b.lowestTime', staleTimeout: 0 },
    { type: 'record', input: 'b.soc', keep: 'sinceAbove', level: 1, output: 'b.sinceFull', timeOutput: 'b.lastFull', staleTimeout: 0 }
  ])
  engine.tick(T0, 0)
  engine.input('b.soc', 0.53, T0 + 1000, 1000)
  for (const plan of engine.lookbackPlans(T0 + 1000, 1000)) engine.applyLookback(plan, await lookBack(history, plan), T0 + 2000, 2000)
  const published = Object.fromEntries(engine.tick(T0 + 2000, 2000).map((item) => [item.path, item.value]))
  assert.equal(published['b.lowest'], 0.37)
  assert.equal(published['b.lowestTime'], '2026-10-07T03:00:00.000Z')
  assert.equal(published['b.lastFull'], '2026-09-24T14:05:00.000Z')
  assert.equal(published['b.sinceFull'], Math.floor((T0 + 2000 - full) / 1000))
  const lowest = engine.snapshot(T0 + 2000, 2000)[0]
  assert.equal(lowest.windowStart, '2026-09-24T14:05:00.000Z')
})

test('a look-back with no history provider is tried again, then given up', () => {
  const engine = engineFor([{ type: 'counter', input: 'f.used', output: 'f.today' }])
  engine.tick(T0, 0)
  let [plan] = engine.lookbackPlans(T0, 0)
  engine.failLookback(plan, 'no history provider answered', true, T0, 0)
  assert.equal(engine.snapshot(T0, 0)[0].history.outcome, 'waiting')
  assert.deepEqual(engine.lookbackPlans(T0 + 10000, 10000), [])
  ;[plan] = engine.lookbackPlans(T0 + 30000, 30000)
  assert.ok(plan)
  engine.failLookback(plan, 'no history provider answered', true, T0 + LOOKBACK_GIVE_UP_MS, LOOKBACK_GIVE_UP_MS)
  const state = engine.snapshot(T0, 0)[0]
  assert.equal(state.history.outcome, 'failed')
  assert.equal(state.lookback, 'done')
})

test('a changed measurement looks back afresh; a changed name does not', () => {
  const engine = engineFor([{ type: 'counter', input: 'f.used', output: 'f.today', resets: 'day' }])
  engine.input('f.used', 5, T0, 0)
  engine.tick(T0, 0)
  // The entry's own look-back is done before it is saved.
  const [plan] = engine.lookbackPlans(T0, 0)
  engine.applyLookback(plan, { from: plan.from, resolution: 3, rows: [] }, T0, 0)
  const saved = engine.serialize(T0)
  const renamed = engineFor([{ type: 'counter', input: 'f.used', output: 'f.today', resets: 'day', name: 'Fuel' }], saved)
  renamed.tick(T0 + 1000, 1000)
  assert.deepEqual(renamed.lookbackPlans(T0 + 1000, 1000), [])
  const changed = engineFor([{ type: 'counter', input: 'f.used', output: 'f.today', resets: 'week' }], saved)
  changed.tick(T0 + 1000, 1000)
  assert.equal(changed.lookbackPlans(T0 + 1000, 1000).length, 1)
})

// ------------------------------------------------------------ the plugin

const fs = require('node:fs')
const path = require('node:path')
const createPlugin = require('../index')
const store = require('../lib/store')
const { call, fakeApp, fakeRouter } = require('./support')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function startWith (app, entries) {
  fs.writeFileSync(path.join(app.dataDir, store.ENTRIES_FILE), JSON.stringify({ version: 1, groups: [], entries }))
  const plugin = createPlugin(app)
  const router = fakeRouter()
  plugin.registerWithRouter(router)
  plugin.start({ timeZone: 'UTC' })
  return { plugin, entries: () => call(router.routes['GET /api/entries']).body.entries }
}

const RECORD = { id: 'e1', type: 'record', name: 'Since full', input: 'b.soc', keep: 'sinceAbove', level: 1, output: 'b.sinceFull', timeOutput: 'b.lastFull', staleTimeout: 0 }

test('the plugin reads the history for a new entry, publishes it and saves it', async () => {
  const full = Date.now() - 3 * 24 * H
  const app = fakeApp()
  const history = fakeHistory({ 'b.soc': samples(full - H, Date.now() - 1000, 60000, (t) => t <= full ? 1 : 0.6) })
  app.getHistoryApi = async () => history
  const { plugin, entries } = startWith(app, [RECORD])
  try {
    await sleep(1300)
    const [entry] = entries()
    assert.equal(entry.history.outcome, 'filled')
    assert.ok(Math.abs(Date.parse(entry.lastMet) - full) <= 60000)
    const values = app.values()
    assert.ok(values['b.sinceFull'] >= 3 * 24 * 3600 - 60, String(values['b.sinceFull']))
    assert.equal(typeof values['b.lastFull'], 'string')
    // The time path is described after the entry.
    const meta = app.messages.flatMap(({ delta }) => delta.updates.flatMap((u) => u.meta || []))
    assert.ok(meta.some((item) => item.path === 'b.lastFull' && item.value.displayName === 'Since full (time)'))
    // Saved at once, so a restart does not read the history again.
    assert.equal(JSON.parse(app.file('state.json')).entries['b.sinceFull'].history.outcome, 'filled')
  } finally {
    plugin.stop()
  }
  const requests = history.requests.length
  const again = startWith(app, [RECORD])
  try {
    await sleep(100)
    assert.equal(history.requests.length, requests)
    assert.equal(again.entries()[0].history.outcome, 'filled')
  } finally {
    again.plugin.stop()
  }
})

test('without a History API the entry says so and counts from its start', async () => {
  const app = fakeApp()
  const { plugin, entries } = startWith(app, [RECORD])
  try {
    await sleep(50)
    const [entry] = entries()
    assert.equal(entry.history.outcome, 'failed')
    assert.match(entry.history.reason, /History API/)
  } finally {
    plugin.stop()
  }
})

test('a provider that is not there yet is asked again later', async () => {
  const app = fakeApp()
  app.getHistoryApi = () => Promise.reject(new Error('No history api provider configured'))
  const { plugin, entries } = startWith(app, [RECORD])
  try {
    await sleep(50)
    const [entry] = entries()
    assert.equal(entry.history.outcome, 'waiting')
    assert.match(entry.history.reason, /No history api provider configured/)
    assert.equal(entry.lookback, 'wanted')
  } finally {
    plugin.stop()
  }
})

test('an entry saved before its look-back was planned carries it on after a restart', () => {
  const daily = [{ type: 'counter', input: 'f.used', output: 'f.today', resets: 'day' }]
  const engine = engineFor(daily)
  engine.input('f.used', 5, T0, 0)
  engine.tick(T0, 0)
  // No plan was made: another entry's read was under way.
  const carried = engineFor(daily, engine.serialize(T0 + 60000))
  carried.tick(T0 + 70000, 70000)
  const plans = carried.lookbackPlans(T0 + 70000, 70000)
  assert.equal(plans.length, 1)
  assert.equal(plans[0].to, T0)
})

test('an edit made before the look-back is done carries it on', () => {
  const daily = { type: 'counter', input: 'f.used', output: 'f.today', resets: 'day' }
  const engine = engineFor([daily])
  engine.input('f.used', 5, T0, 0)
  engine.tick(T0, 0)
  const [plan] = engine.lookbackPlans(T0, 0)
  engine.failLookback(plan, 'no history provider answered', true, T0 + 1000, 1000)
  // The stale timeout changes: the entry is rebuilt from what was saved.
  const doc = { version: 1, groups: [], entries: [{ id: 'e1', ...daily, staleTimeout: 120 }] }
  const edited = new Engine(normalizeConfig({ timeZone: 'UTC' }, doc), engine.serialize(T0 + 2000), undefined, engine)
  edited.tick(T0 + 40000, 40000)
  const plans = edited.lookbackPlans(T0 + 40000, 40000)
  assert.equal(plans.length, 1)
  assert.equal(plans[0].to, T0)
})
