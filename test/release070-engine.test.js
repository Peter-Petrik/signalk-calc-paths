'use strict'

/*
 * Tests of the engine and cycles changes in version 0.7.0: a counter that
 * drops for one value, a clock that is set after the counting began, the
 * closing total of a period, the "ON time so far" figure, plateaus in a
 * wave input, a followed path that wobbles, and an output on a followed
 * time zone path.
 */

const assert = require('node:assert/strict')
const { test } = require('node:test')

const { normalizeConfig } = require('../lib/config')
const { CycleTracker } = require('../lib/cycles')
const { Engine } = require('../lib/engine')
const { entryFields } = require('../lib/schema')

const NOON = Date.parse('2026-10-09T12:00:00Z')
const MIDNIGHT = Date.parse('2026-10-10T00:00:00Z')
const MIN = 60000
const HOUR = 60 * MIN

/** Time is given in seconds after `base` and drives both clocks together. */
function harness (options, saved, base = NOON) {
  const normalized = normalizeConfig({ timeZone: 'UTC', ...options })
  for (const entry of normalized.entries) assert.equal(entry.error, null, `${entry.label}: ${entry.error}`)
  const engine = new Engine(normalized, saved || null)
  const values = {}
  return {
    engine,
    input (seconds, path, value) {
      engine.input(path, value, base + seconds * 1000, seconds * 1000)
    },
    tick (seconds) {
      const published = engine.tick(base + seconds * 1000, seconds * 1000)
      for (const { path, value } of published) values[path] = value
      return published
    },
    value: (path) => values[path],
    save: (seconds) => JSON.parse(JSON.stringify(engine.serialize(base + seconds * 1000))),
    state: (output, seconds) => engine.snapshot(base + seconds * 1000, seconds * 1000).find((e) => e.output === output)
  }
}

const near = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`)

const counter = (extra = {}) => ({ counters: [{ input: 'm.total', output: 'm.today', staleTimeout: 0, ...extra }] })

// ------------------------------------------------------- 1. counter glitch

test('a counter that drops to zero for one value and comes back counts only the climb past the old level', () => {
  const h = harness(counter())
  h.input(0, 'm.total', 3600000)
  h.input(1, 'm.total', 3600010)
  h.input(2, 'm.total', 0) // a device restarting sends one 0
  h.tick(2)
  assert.equal(h.value('m.today'), 10)
  h.input(3, 'm.total', 3600020)
  h.tick(3)
  assert.equal(h.value('m.today'), 20)
})

test('a drop that the next value confirms is a restart of the source, counted from the new level', () => {
  const h = harness(counter())
  h.input(0, 'm.total', 100)
  h.input(1, 'm.total', 110)
  h.input(2, 'm.total', 0)
  h.input(3, 'm.total', 5)
  h.tick(3)
  assert.equal(h.value('m.today'), 15)
  h.input(4, 'm.total', 9)
  h.tick(4)
  assert.equal(h.value('m.today'), 19)
})

test('a counter of decreases reads a single rise as a glitch and two as a refill', () => {
  const glitch = harness(counter({ direction: 'decrease' }))
  glitch.input(0, 'm.total', 0.5)
  glitch.input(1, 'm.total', 0.4)
  glitch.input(2, 'm.total', 0.9)
  glitch.input(3, 'm.total', 0.35)
  glitch.tick(3)
  near(glitch.value('m.today'), 0.15)
  const refill = harness(counter({ direction: 'decrease' }))
  refill.input(0, 'm.total', 0.5)
  refill.input(1, 'm.total', 0.4)
  refill.input(2, 'm.total', 0.9)
  refill.input(3, 'm.total', 0.8)
  refill.tick(3)
  near(refill.value('m.today'), 0.2)
})

test('a level with ripple around it counts nothing for a counter of decreases', () => {
  const h = harness(counter({ direction: 'decrease' }))
  for (let s = 0; s < 600; s++) h.input(s, 'm.total', 0.5 + (s % 2 ? 0.002 : -0.002))
  h.tick(600)
  near(h.value('m.today'), 0)
})

test('the value that moved the other way survives a restart', () => {
  const first = harness(counter({ resets: 'manual' }))
  first.input(0, 'm.total', 100)
  first.input(1, 'm.total', 110)
  first.input(2, 'm.total', 0)
  first.tick(2)
  const saved = first.save(2)
  assert.equal(saved.entries['m.today'].pending, 0)
  assert.equal(saved.entries['m.today'].last, 110)
  const second = harness(counter({ resets: 'manual' }), saved)
  second.input(10, 'm.total', 5)
  second.tick(10)
  assert.equal(second.value('m.today'), 15)
  assert.equal(second.save(10).entries['m.today'].pending, null)
})

test('"wait" and "net" are unchanged by the glitch rule', () => {
  const wait = harness(counter({ reversal: 'wait' }))
  for (const [s, v] of [[0, 100], [1, 110], [2, 0], [3, 5], [4, 120]]) wait.input(s, 'm.total', v)
  wait.tick(4)
  assert.equal(wait.value('m.today'), 20)
  const net = harness(counter({ direction: 'net' }))
  for (const [s, v] of [[0, 100], [1, 0], [2, 5]]) net.input(s, 'm.total', v)
  net.tick(2)
  assert.equal(net.value('m.today'), -95)
})

// ------------------------------------------------ 2. clock unset at boot

const hoursToday = { counters: [{ input: 'eng.hours', output: 'eng.hoursToday', staleTimeout: 0 }] }

function dayOne () {
  const evening = Date.parse('2026-10-09T20:00:00Z')
  const a = harness(hoursToday, null, evening)
  a.input(0, 'eng.hours', 1000)
  a.input(3600, 'eng.hours', 1003600)
  a.tick(3600)
  return a.save(3600)
}

/** Boots at 08:00 real time with the wall clock at `bootWall` for the first ten minutes. */
function bootNextMorning (saved, bootWall) {
  const real = Date.parse('2026-10-10T08:00:00Z')
  const normalized = normalizeConfig({ timeZone: 'UTC', ...hoursToday })
  const engine = new Engine(normalized, saved)
  const wallAt = (s) => (s < 600 ? bootWall + s * 1000 : real + s * 1000)
  const published = []
  const tick = (s) => published.push(...engine.tick(wallAt(s), s * 1000))
  engine.input('eng.hours', 1003600 + 7200, wallAt(0), 0)
  tick(0)
  engine.input('eng.hours', 1003600 + 7800, wallAt(599), 599000)
  tick(599)
  tick(600)
  engine.input('eng.hours', 1003600 + 7860, wallAt(660), 660000)
  tick(660)
  return { engine, published, item: engine.snapshot(wallAt(660), 660000)[0] }
}

test('what was counted before the clock was set stays in the new day when the boot came after midnight', () => {
  const saved = dayOne()
  const trusted = bootNextMorning(saved, Date.parse('2026-10-10T08:00:00Z'))
  const unset = bootNextMorning(saved, 0)
  assert.equal(trusted.item.value, 7860)
  assert.equal(unset.item.value, 7860)
  // The day before closed at its saved total; nothing is sent for it,
  // since it was published before the stop.
  assert.equal(unset.item.lastReset.total, 1002600)
  assert.ok(unset.published.every((p) => p.timestamp === undefined))
})

test('with the boot before the boundary, what was counted under an unset clock goes with the old period', () => {
  const saved = dayOne()
  const real = Date.parse('2026-10-09T23:50:00Z')
  const normalized = normalizeConfig({ timeZone: 'UTC', ...hoursToday })
  const engine = new Engine(normalized, saved)
  const wallAt = (s) => (s < 1200 ? s * 1000 : real + s * 1000)
  engine.input('eng.hours', 1003700, wallAt(0), 0)
  engine.tick(wallAt(0), 0)
  engine.input('eng.hours', 1003800, wallAt(1100), 1100000)
  engine.tick(wallAt(1100), 1100000)
  engine.tick(wallAt(1200), 1200000) // 00:10, clock set
  engine.input('eng.hours', 1003830, wallAt(1260), 1260000)
  engine.tick(wallAt(1260), 1260000)
  const item = engine.snapshot(wallAt(1260), 1260000)[0]
  assert.equal(item.value, 30)
  assert.equal(item.lastReset.total, 1002800)
})

test('a clock step back accepted after an hour keeps what was added since the step when it lies in the new day', () => {
  // Saved by a clock that ran two hours ahead, before the day ended.
  const options = { counters: [{ input: 'eng.hours', output: 'eng.hoursToday', staleTimeout: 0 }] }
  const saved = {
    savedAt: Date.parse('2026-10-10T02:00:00Z'),
    entries: {
      'eng.hoursToday': { signature: 'counter|eng.hours|increase', resets: 'day', resetPath: null, total: 500, since: Date.parse('2026-10-09T00:00:00Z'), periodStart: Date.parse('2026-10-09T00:00:00Z'), periodKey: '2026-10-09', periodZone: 'UTC', referenceLast: null, last: 1000 }
    }
  }
  const base = Date.parse('2026-10-10T00:10:00Z')
  const h = harness(options, saved, base)
  h.input(0, 'eng.hours', 1100)
  h.tick(0)
  h.input(1800, 'eng.hours', 1200)
  h.tick(1800)
  assert.equal(h.value('eng.hoursToday'), 700)
  h.input(3700, 'eng.hours', 1250)
  h.tick(3700)
  // The clock is believed after an hour; the step lay after midnight.
  assert.equal(h.value('eng.hoursToday'), 250)
  assert.equal(h.state('eng.hoursToday', 3700).lastReset.total, 500)
})

// --------------------------------------------- 3. closing total of a period

test('the closing total of a day includes the stretch up to midnight and goes out just before it', () => {
  const base = Date.parse('2026-10-09T23:58:00Z')
  const h = harness({ integrations: [{ input: 'p.w', staleTimeout: 60, output: 'e.today' }] }, null, base)
  let boundary = null
  for (let s = 0; s <= 240; s++) {
    if (s % 30 === 15) h.input(s, 'p.w', 10)
    const published = h.tick(s)
    if (s === 120) boundary = published
  }
  assert.deepEqual(boundary, [
    { path: 'e.today', value: 1050, timestamp: MIDNIGHT - 1 },
    { path: 'e.today', value: 0 }
  ])
  assert.deepEqual(h.state('e.today', 240).lastReset, { at: '2026-10-10T00:00:00.000Z', cause: 'period', period: 'day', total: 1050 })
  assert.equal(h.state('e.today', 240).value, 1050)
})

test('a stretch longer than the stale timeout before the boundary is not added to the closing total', () => {
  const base = Date.parse('2026-10-09T23:58:00Z')
  const h = harness({ integrations: [{ input: 'p.w', staleTimeout: 60, output: 'e.today', onStale: 'hold' }] }, null, base)
  h.input(0, 'p.w', 10)
  h.input(30, 'p.w', 10)
  for (let s = 30; s <= 121; s++) h.tick(s)
  assert.equal(h.state('e.today', 121).lastReset.total, 300)
})

test('a held input is closed at the boundary, and a bridged gap too', () => {
  const base = Date.parse('2026-10-09T23:58:00Z')
  const held = harness({ integrations: [{ input: 'p.w', staleTimeout: 0, output: 'e.today' }] }, null, base)
  held.input(0.5, 'p.w', 10)
  for (let s = 1; s <= 121; s++) held.tick(s)
  assert.equal(held.state('e.today', 121).lastReset.total, 1195)
  const bridged = harness({ integrations: [{ input: 'p.w', staleTimeout: 60, gap: 'bridge', output: 'e.today', onStale: 'hold' }] }, null, base)
  bridged.input(0, 'p.w', 10)
  for (let s = 0; s <= 121; s++) bridged.tick(s)
  assert.equal(bridged.state('e.today', 121).lastReset.total, 1200)
})

test('a counter publishes its closing total too, and the day after counts from the last value', () => {
  const base = Date.parse('2026-10-09T23:59:00Z')
  const h = harness(counter(), null, base)
  h.input(0, 'm.total', 10)
  h.input(30, 'm.total', 25.000000000000004)
  h.tick(30)
  assert.deepEqual(h.tick(60), [
    { path: 'm.today', value: 15, timestamp: MIDNIGHT - 1 },
    { path: 'm.today', value: 0 }
  ])
  assert.equal(h.state('m.today', 60).lastReset.total, 15)
  assert.deepEqual(h.tick(61), [])
})

test('a closing total of zero is followed by the zero of the new day', () => {
  const base = Date.parse('2026-10-09T23:59:00Z')
  const h = harness({ repeatInterval: 0, ...counter() }, null, base)
  h.input(0, 'm.total', 10)
  h.tick(0)
  assert.deepEqual(h.tick(60), [
    { path: 'm.today', value: 0, timestamp: MIDNIGHT - 1 },
    { path: 'm.today', value: 0 }
  ])
})

test('a boundary passed while the plugin was stopped is recorded but not published', () => {
  const base = Date.parse('2026-10-09T23:00:00Z')
  const first = harness(counter(), null, base)
  first.input(0, 'm.total', 10)
  first.input(60, 'm.total', 40)
  first.tick(60)
  const saved = first.save(60)
  const second = harness(counter(), saved, base)
  const published = second.tick(7200)
  assert.ok(published.every((p) => p.timestamp === undefined), JSON.stringify(published))
  assert.equal(second.state('m.today', 7200).lastReset.total, 30)
})

test('an entry that is not publishing at the boundary sends no closing total', () => {
  const base = Date.parse('2026-10-09T23:58:00Z')
  const h = harness({ counters: [{ input: 'm.total', output: 'm.today', staleTimeout: 30 }] }, null, base)
  h.input(0, 'm.total', 10)
  h.input(10, 'm.total', 20)
  h.tick(10)
  assert.deepEqual(h.tick(41), [{ path: 'm.today', value: null }])
  for (let s = 42; s < 120; s++) assert.deepEqual(h.tick(s), [])
  assert.deepEqual(h.tick(120), [])
  assert.equal(h.state('m.today', 120).lastReset.total, 10)
})

test('a closing total that could not be sent goes out again once, before the current value', () => {
  const base = Date.parse('2026-10-09T23:59:00Z')
  const h = harness(counter(), null, base)
  h.input(0, 'm.total', 10)
  h.input(30, 'm.total', 25)
  h.tick(30)
  const failed = h.tick(60)
  assert.equal(failed.length, 2)
  h.engine.republish(failed)
  assert.deepEqual(h.tick(61), [
    { path: 'm.today', value: 15, timestamp: MIDNIGHT - 1 },
    { path: 'm.today', value: 0 }
  ])
  assert.deepEqual(h.tick(62), [])
})

test('only period resets record a closing total', () => {
  const h = harness({ counters: [{ input: 'm.total', output: 'm.today', staleTimeout: 0, resets: 'manual' }] })
  h.input(0, 'm.total', 10)
  h.input(1, 'm.total', 20)
  h.tick(1)
  h.engine.reset('m.today', NOON + 2000, 2000)
  assert.deepEqual(h.tick(2), [{ path: 'm.today', value: 0 }])
  assert.equal(h.state('m.today', 2).lastReset.total, undefined)
})

test('a saved closing total comes back after a restart', () => {
  const base = Date.parse('2026-10-09T23:59:00Z')
  const h = harness(counter(), null, base)
  h.input(0, 'm.total', 10)
  h.input(30, 'm.total', 25)
  h.tick(60)
  const again = harness(counter(), h.save(60), base)
  assert.equal(again.state('m.today', 61).lastReset.total, 15)
})

// ---------------------------------------------------- 4. ON time so far

function onOff (extra = {}) {
  return new CycleTracker({ combine: 'all', inputs: [{ kind: 'onoff', threshold: 0 }], staleMs: 0, smoothingMs: 30000, shortestMs: 120000, longestMs: 600000, windowMs: 24 * HOUR, ...extra })
}

test('"ON time so far" is the length of the ON stretch under way, 0 while OFF and null while unknown', () => {
  const tracker = onOff()
  const start = 1e9
  const at = (s) => [Date.parse('2026-10-15T00:00:00Z') + s * 1000, start + s * 1000]
  tracker.advance(...at(0))
  assert.equal(tracker.figures(...at(0)).onSoFar, null)
  tracker.input(0, 0, start)
  // A state counts once it has held for the shortest stretch, 120 s.
  tracker.advance(...at(10))
  assert.equal(tracker.figures(...at(10)).onSoFar, null)
  tracker.advance(...at(130))
  assert.equal(tracker.figures(...at(130)).onSoFar, 0)
  tracker.input(0, 1, start + 300000)
  tracker.advance(...at(600))
  assert.equal(tracker.figures(...at(600)).onSoFar, 300000)
  // Longer than the longest stretch, which the other figures leave out.
  tracker.advance(...at(3600))
  assert.equal(tracker.figures(...at(3600)).onSoFar, 3300000)
  tracker.input(0, 0, start + 3600000)
  tracker.advance(...at(3800))
  assert.equal(tracker.figures(...at(3800)).onSoFar, 0)
  tracker.input(0, null, start + 3800000)
  tracker.advance(...at(3801))
  assert.equal(tracker.figures(...at(3801)).onSoFar, null)
})

test('a Cycles entry publishes the ON time so far without waiting for cycles, every second while ON', () => {
  const normalized = normalizeConfig({ timeZone: 'UTC' }, { version: 1, groups: [], entries: [{ id: 'c', type: 'cycles', output: 'fridge.onSoFar', statistic: 'onSoFar', staleTimeout: 0, inputs: [{ path: 'fridge.on', kind: 'onoff', threshold: 0 }] }] })
  assert.equal(normalized.entries[0].error, null)
  assert.equal(normalized.entries[0].unit, 's')
  const engine = new Engine(normalized, null)
  const WALL = Date.parse('2026-10-15T00:00:00Z')
  engine.input('fridge.on', true, WALL, 0)
  const seen = []
  for (let s = 0; s <= 200; s++) {
    for (const p of engine.tick(WALL + s * 1000, s * 1000)) seen.push([s, p.value])
  }
  // The ON state is accepted once it has held for the shortest stretch,
  // 120 s; from then on the figure goes out every second.
  assert.deepEqual(seen.slice(0, 2), [[120, 120], [121, 121]])
  assert.ok(seen.every(([s, v]) => v === s), JSON.stringify(seen.slice(0, 5)))
  assert.equal(seen.length, 81)
  const item = engine.snapshot(WALL + 200000, 200000)[0]
  assert.equal(item.state, 'ok')
  assert.equal(item.value, 200)
  assert.equal(item.cycles.onSoFar, 200)
})

// A fridge humidity: 10 min falling while the compressor runs, 15 min
// rising while it rests, until `stuckAt`, when the compressor runs without
// a stop for `stuckFor` and the humidity stays at its lowest; then the
// cycles go on.
function stuckWave (statistic, stuckAt, stuckFor) {
  const ON = 10 * MIN
  const OFF = 15 * MIN
  const level = (t) => {
    if (t >= stuckAt && t < stuckAt + stuckFor) return 0.72
    // After the run the humidity rises first: the compressor rests.
    const r = (t >= stuckAt + stuckFor ? t - stuckAt - stuckFor + ON : t) % (ON + OFF)
    return r < ON ? 0.9 - 0.18 * r / ON : 0.72 + 0.18 * (r - ON) / OFF
  }
  const tracker = new CycleTracker({ combine: 'all', statistic, inputs: [{ kind: 'wave', direction: 'falling', swing: 0.01 }], staleMs: 180000, smoothingMs: 150000, shortestMs: 120000, longestMs: 2 * HOUR, windowMs: 24 * HOUR })
  const start = 1e9
  const WALL = Date.parse('2026-10-15T00:00:00Z')
  return (from, to, each) => {
    for (let t = from; t <= to; t += 10000) {
      tracker.input(0, level(t), start + t)
      tracker.advance(WALL + t, start + t)
      if (each) each(t, tracker.figures(WALL + t, start + t))
    }
    return tracker
  }
}

test('"ON time so far" counts on while a wave stays at its lowest, as a compressor that does not stop leaves it', () => {
  // Cycles for 5 h, then the compressor runs for 6 h without stopping; the
  // humidity falls in the first 10 min of it and then stays put.
  const stuckAt = 5 * HOUR
  const run = stuckWave('onSoFar', stuckAt, 6 * HOUR)
  const seen = new Map()
  run(0, 13 * HOUR, (t, f) => { if (t % (10 * MIN) === 0) seen.set(t, f.onSoFar) })
  // Past the longest stretch of 2 h and on to the end of the run.
  for (const hours of [1, 2, 3, 5, 5.5]) {
    const value = seen.get(stuckAt + hours * HOUR)
    assert.ok(value !== null && Math.abs(value - hours * HOUR) <= 5 * MIN, `${hours} h into the run: ${value === null ? null : value / 1000} s`)
  }
  // Once the humidity rises again, the figure goes back to 0 and the cycles
  // are read as before.
  assert.equal(seen.get(stuckAt + 6 * HOUR + 10 * MIN), 0)
  const later = [...seen].filter(([t]) => t >= stuckAt + 7 * HOUR).map(([, v]) => v)
  assert.ok(later.some((v) => v > 5 * MIN) && later.every((v) => v !== null && v <= 15 * MIN), JSON.stringify(later.map((v) => v / 1000)))
})

test('the other figures still take a wave that has not turned for the longest stretch as saying nothing', () => {
  const stuckAt = 5 * HOUR
  const run = stuckWave('onMedian', stuckAt, 6 * HOUR)
  const tracker = run(0, stuckAt + 4 * HOUR)
  assert.equal(tracker.figures(Date.parse('2026-10-15T00:00:00Z') + stuckAt + 4 * HOUR, 1e9 + stuckAt + 4 * HOUR).onSoFar, null)
  assert.equal(tracker.state, null)
})

test('"ON time so far" is offered in the editor', () => {
  const field = entryFields.cycles.properties.statistic
  assert.ok(field.enum.includes('onSoFar'))
  assert.equal(field.enumNames[field.enum.indexOf('onSoFar')], 'ON time so far')
  assert.match(field.description, /ON time so far/)
})

// ------------------------------------------------------- 5. plateau ties

test('a turning point on a plateau is placed where the value starts to move away', () => {
  const ON = 10 * MIN
  const OFF = 20 * MIN
  // Falls for the ON stretch, rises for half the OFF stretch, then holds at
  // exactly 1.0 (a humidity sensor at saturation) until the next ON.
  const signal = (t) => {
    const r = t % (ON + OFF)
    if (r < ON) return 1 - 0.1 * r / ON
    return Math.min(1, 0.9 + 0.1 * (r - ON) / (OFF / 2))
  }
  const tracker = new CycleTracker({ combine: 'all', inputs: [{ kind: 'wave', direction: 'falling', swing: 0.01 }], staleMs: 180000, smoothingMs: 150000, shortestMs: 120000, longestMs: 2 * HOUR, windowMs: 24 * HOUR })
  const start = 1e9
  const WALL = Date.parse('2026-10-15T00:00:00Z')
  for (let t = 3 * MIN; t < 12 * HOUR; t += 10000) {
    tracker.input(0, signal(t), start + t)
    tracker.advance(WALL + t, start + t)
  }
  const f = tracker.figures(WALL + 12 * HOUR)
  assert.ok(f.cycles >= 20, `${f.cycles} cycles`)
  assert.ok(Math.abs(f.onMedian - ON) <= 60000, `ON median ${f.onMedian / 1000} s`)
  assert.ok(Math.abs(f.offMedian - OFF) <= 60000, `OFF median ${f.offMedian / 1000} s`)
})

// --------------------------------------------- 6. followed path wobbles

const following = { counters: [{ input: 'm.total', output: 'm.today', resets: 'path', resetPath: 'ref.yieldToday', staleTimeout: 0 }] }

test('a tiny fall of the followed path does not clear the total; a fall to zero does', () => {
  const h = harness(following)
  h.input(0, 'ref.yieldToday', 1000)
  h.input(0, 'm.total', 10)
  h.input(10, 'm.total', 30)
  h.input(11, 'ref.yieldToday', 999.9999999)
  h.tick(11)
  assert.equal(h.value('m.today'), 20)
  assert.equal(h.state('m.today', 11).lastReset, null)
  h.input(20, 'ref.yieldToday', 1540)
  h.input(30, 'ref.yieldToday', 0)
  h.tick(30)
  assert.equal(h.value('m.today'), 0)
  assert.deepEqual(h.state('m.today', 30).lastReset, { at: '2026-10-09T12:00:30.000Z', cause: 'path', path: 'ref.yieldToday', from: 1540, to: 0 })
})

test('a fall to below half of the followed value clears the total; a smaller one moves the level it is measured from', () => {
  const h = harness(following)
  h.input(0, 'ref.yieldToday', 1000)
  h.input(0, 'm.total', 10)
  h.input(1, 'm.total', 30)
  h.input(2, 'ref.yieldToday', 600)
  h.tick(2)
  assert.equal(h.value('m.today'), 20)
  // Measured from 600, not from 1000: a fall to 400 is not a reset.
  h.input(3, 'ref.yieldToday', 400)
  h.tick(3)
  assert.equal(h.value('m.today'), 20)
  h.input(4, 'ref.yieldToday', 150)
  h.tick(4)
  assert.equal(h.value('m.today'), 0)
  assert.equal(h.state('m.today', 4).lastReset.from, 400)
})

// ----------------------------------- 7. output on a followed time zone path

test('an output on the path the time zone is read from is a fault on the output', () => {
  const entries = [
    { id: 'a', type: 'formula', inputs: [{ name: 'x', path: 'a.x' }], expression: 'x', output: 'environment.time.timezoneRegion' },
    { id: 'b', type: 'formula', inputs: [{ name: 'x', path: 'a.x' }], expression: 'x', output: 'my.offset' },
    { id: 'c', type: 'formula', inputs: [{ name: 'x', path: 'a.x' }], expression: 'x', output: 'a.fine' }
  ]
  const followed = normalizeConfig({ timeZone: 'UTC', timeZoneOffsetPath: 'my.offset' }, { version: 1, groups: [], entries })
  assert.deepEqual(followed.entries[0].faults, [{ field: 'output', text: 'the output path is the path the time zone is read from' }])
  assert.deepEqual(followed.entries[1].faults, [{ field: 'output', text: 'the output path is the path the time zone is read from' }])
  assert.equal(followed.entries[2].error, null)
  const fixed = normalizeConfig({ timeZone: 'UTC', timeZoneSource: 'fixed', timeZoneOffsetPath: 'my.offset' }, { version: 1, groups: [], entries })
  assert.ok(fixed.entries.every((entry) => entry.error === null))
})

test('"ON time so far" says why it waits while its first state has not held for the shortest stretch', () => {
  const normalized = normalizeConfig({ timeZone: 'UTC' }, { version: 1, groups: [], entries: [{ id: 'c', type: 'cycles', output: 'pump.onSoFar', statistic: 'onSoFar', staleTimeout: 0, inputs: [{ path: 'pump.on', kind: 'onoff', threshold: 0 }] }] })
  const engine = new Engine(normalized, null)
  const WALL = Date.parse('2026-10-15T00:00:00Z')
  const status = (s) => { engine.tick(WALL + s * 1000, s * 1000); return engine.snapshot(WALL + s * 1000, s * 1000)[0] }
  assert.match(status(0).message, /not known/)
  engine.input('pump.on', true, WALL + 1000, 1000)
  assert.equal(status(60).message, 'The state counts once it has held for the shortest stretch, 120 s.')
  assert.equal(status(121).state, 'ok')
})

// ------------------------------------------------- review of 0.7.0, fixes

/** Like harness(), with the wall clock given apart from the monotonic one. */
function clocked (options, saved, base) {
  const engine = new Engine(normalizeConfig({ timeZone: 'UTC', ...options }), saved || null)
  const published = []
  return {
    engine,
    input: (s, path, value, wall = base + s * 1000) => engine.input(path, value, wall, s * 1000),
    tick: (s, wall = base + s * 1000) => { for (const p of engine.tick(wall, s * 1000)) published.push(p) },
    published,
    entry: (output) => engine.entries.find((e) => e.config.output === output)
  }
}

test('a glitch back within the smallest change to count is still a glitch', () => {
  const tank = clocked({ counters: [{ input: 'tank.level', output: 'tank.used', direction: 'decrease', minStep: 0.002, resets: 'manual', staleTimeout: 0 }] }, null, NOON)
  tank.input(0, 'tank.level', 0.150)
  tank.input(1, 'tank.level', 0.200) // one high reading
  tank.input(2, 'tank.level', 0.1505) // back, within the ripple ignored anyway
  tank.tick(2)
  assert.equal(tank.entry('tank.used').total, 0)
  const total = clocked({ counters: [{ input: 'm.total', output: 'm.sum', minStep: 0.1, resets: 'manual', staleTimeout: 0 }] }, null, NOON)
  total.input(0, 'm.total', 100)
  total.input(1, 'm.total', 0)
  total.input(2, 'm.total', 99.95)
  total.tick(2)
  assert.equal(total.entry('m.sum').total, 0)
})

test('a fall of the followed path while the plugin was stopped resets the total at the first value, even to above half', () => {
  const options = { integrations: [{ input: 'p.power', output: 'p.energy', resets: 'path', resetPath: 'c.yieldToday', staleTimeout: 0 }] }
  const before = clocked(options, null, NOON)
  before.input(0, 'c.yieldToday', 5.2)
  before.input(0, 'p.power', 100)
  before.tick(100)
  const saved = JSON.parse(JSON.stringify(before.engine.serialize(NOON + 100000)))
  assert.equal(saved.entries['p.energy'].total, 10000)
  const after = clocked(options, saved, NOON + 20 * HOUR)
  after.input(0, 'c.yieldToday', 3.0)
  after.tick(1)
  assert.equal(after.entry('p.energy').total, 0)
  assert.deepEqual([after.entry('p.energy').lastReset.from, after.entry('p.energy').lastReset.to], [5.2, 3])
  // From then on a fall to above half is not a reset.
  after.input(2, 'p.power', 100)
  after.input(10, 'c.yieldToday', 2.0)
  after.tick(10)
  assert.equal(after.entry('p.energy').lastReset.to, 3)
})

test('an edit while the clock is unset keeps where counting began, so what was counted since the boot stays in the new day', () => {
  const options = (stale) => ({ counters: [{ input: 'm.total', output: 'm.today', staleTimeout: stale }] })
  const yesterday = Date.parse('2026-10-09T12:00:00Z')
  const first = new Engine(normalizeConfig({ timeZone: 'UTC', ...options(0) }), null)
  first.input('m.total', 1000, yesterday, 0)
  first.input('m.total', 1400, yesterday + 1000, 1000)
  first.tick(yesterday + 1000, 1000)
  const saved = JSON.parse(JSON.stringify(first.serialize(yesterday + 1000)))
  const real = (s) => Date.parse('2026-10-10T08:00:00Z') + s * 1000
  const run = (edit) => {
    let engine = new Engine(normalizeConfig({ timeZone: 'UTC', ...options(0) }), saved)
    const wall = (s) => (s < 3600 ? 5000 + s * 1000 : real(s)) // 1970 until 09:00
    let value = 1400
    for (let s = 0; s <= 3700; s += 10) {
      if (edit && s === 1800) {
        engine = new Engine(normalizeConfig({ timeZone: 'UTC', ...options(5) }), engine.serialize(wall(s)), 'UTC', engine)
        engine.prime(wall(s), s * 1000)
      }
      if (s < 3600) value += 150 / 360
      engine.input('m.total', value, wall(s), s * 1000)
      engine.tick(wall(s), s * 1000)
    }
    const item = engine.snapshot(wall(3700), 3700000)[0]
    return [Number(item.value.toFixed(3)), Number(item.lastReset.total.toFixed(3))]
  }
  assert.deepEqual(run(false), [150, 400])
  assert.deepEqual(run(true), [150, 400])
})

test('a boundary passed twice, by a clock that ran ahead and was set back a little, closes once with the whole day', () => {
  const base = Date.parse('2026-10-09T23:50:00Z')
  const h = clocked({ counters: [{ input: 'm.total', output: 'm.today', staleTimeout: 0 }] }, null, base)
  let value = 0
  for (let s = 0; s <= 900; s += 5) {
    // Three minutes fast until real 23:59, when the clock is set back.
    const wall = base + s * 1000 + (s < 540 ? 3 * MIN : 0)
    value += 1
    h.input(s, 'm.total', value, wall)
    h.tick(s, wall)
  }
  const stamped = h.published.filter((p) => p.timestamp !== undefined)
  assert.deepEqual(stamped.map((p) => p.timestamp), [MIDNIGHT - 1, MIDNIGHT - 1])
  // The second closing is the whole day: what was counted before the first
  // passage and what was counted between the two.
  assert.equal(stamped[1].value, 119)
  assert.equal(h.entry('m.today').lastReset.total, 119)
})

test('a new date begun by a change of time zone closes the total too, dated just before the change', () => {
  const base = Date.parse('2026-10-10T21:00:00Z')
  const h = clocked({ timeZone: 'Europe/Rome', counters: [{ input: 'm.total', output: 'm.today', staleTimeout: 0 }] }, null, base)
  h.engine.setTimeZone('Europe/Rome')
  h.input(0, 'm.total', 100)
  h.tick(0)
  h.input(1700, 'm.total', 152)
  h.tick(1700)
  h.engine.setTimeZone('Europe/Athens')
  h.input(1800, 'm.total', 153)
  h.tick(1800)
  const stamped = h.published.filter((p) => p.timestamp !== undefined)
  assert.deepEqual(stamped.map((p) => [p.value, p.timestamp]), [[52, base + 1800000 - 1]])
  assert.equal(h.entry('m.today').lastReset.cause, 'zone')
  assert.equal(h.entry('m.today').lastReset.total, 52)
})

test('a window or cycles needed that cannot be used is no fault for the ON time so far, which hides them', () => {
  for (const extra of [{ window: 0 }, { window: 'abc' }, { minCycles: 'x' }]) {
    const normalized = normalizeConfig({ timeZone: 'UTC' }, { version: 1, groups: [], entries: [{ id: 'c', type: 'cycles', output: 'f.onSoFar', statistic: 'onSoFar', inputs: [{ path: 'f.on', kind: 'onoff' }], ...extra }] })
    assert.equal(normalized.entries[0].error, null, JSON.stringify(extra))
    assert.equal(normalized.entries[0].windowMs, 24 * HOUR)
  }
  const median = normalizeConfig({ timeZone: 'UTC' }, { version: 1, groups: [], entries: [{ id: 'c', type: 'cycles', output: 'f.on', statistic: 'onMedian', inputs: [{ path: 'f.on', kind: 'onoff' }], window: 0 }] })
  assert.match(median.entries[0].error, /window/)
})
