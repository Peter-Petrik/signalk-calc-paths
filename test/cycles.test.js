'use strict'

/*
 * Tests of the "Cycles" entry type: the detector in lib/cycles.js on
 * synthetic signals whose cycles are known, and the entry inside the engine.
 */

const assert = require('node:assert/strict')
const { test } = require('node:test')

const { normalizeConfig } = require('../lib/config')
const { CycleTracker, median } = require('../lib/cycles')
const { Engine } = require('../lib/engine')

const MIN = 60000
const HOUR = 60 * MIN
const WALL = Date.parse('2026-10-15T00:00:00Z')

/** A pseudo-random noise source that is the same on every run. */
function noise (seed) {
  let state = seed
  return () => {
    state = (state * 16807) % 2147483647
    return state / 2147483647 - 0.5
  }
}

/**
 * A sawtooth that falls for `on` ms and rises for `off` ms, delayed by `lag`:
 * a fridge's temperature or humidity while its compressor cycles.
 */
function sawtooth ({ on, off, lag = 0, depth, base }) {
  return (t) => {
    const period = on + off
    const r = (((t - lag) % period) + period) % period
    return r < on ? base - depth * r / on : base - depth + depth * (r - on) / off
  }
}

function settings (inputs, extra = {}) {
  return { combine: 'all', inputs, staleMs: 60000, smoothingMs: 150000, shortestMs: 120000, longestMs: 2 * HOUR, windowMs: 24 * HOUR, ...extra }
}

/** Feeds a tracker samples every `every` ms for `hours` and returns its figures in minutes. */
function feed (tracker, signals, { hours = 24, every = 6000, skip = () => false } = {}) {
  const start = 1e9
  for (let t = 0; t < hours * HOUR; t += every) {
    signals.forEach((signal, index) => {
      if (!skip(index, t)) tracker.input(index, signal(t), start + t)
    })
    tracker.advance(WALL + t, start + t)
  }
  const f = tracker.figures(WALL + hours * HOUR)
  const minutes = (ms) => (ms === null ? null : Math.round(ms / MIN * 100) / 100)
  return { cycles: f.cycles, on: minutes(f.onMedian), off: minutes(f.offMedian), period: minutes(f.periodMedian), duty: f.duty, lastOn: minutes(f.lastOn) }
}

const n1 = noise(1)
const n2 = noise(2)
const temperature = (t) => sawtooth({ on: 7 * MIN, off: 8 * MIN, depth: 3, base: 280 })(t) + n1() * 0.05
const humidity = (t) => sawtooth({ on: 7 * MIN, off: 8 * MIN, lag: 2 * MIN, depth: 0.08, base: 0.6 })(t) + n2() * 0.003
const wave = (swing) => ({ kind: 'wave', direction: 'falling', swing })

test('one wave input gives the ON and OFF times of the cycle', () => {
  const figures = feed(new CycleTracker(settings([wave(0.01)])), [humidity])
  assert.equal(figures.on, 7)
  assert.equal(figures.off, 8)
  assert.equal(figures.period, 15)
  assert.ok(Math.abs(figures.duty - 7 / 15) < 0.01)
  assert.ok(figures.cycles >= 93 && figures.cycles <= 96, `${figures.cycles} cycles`)
})

test('"all" reads ON stretches shorter, and "any" longer, by the delay between the inputs', () => {
  const all = feed(new CycleTracker(settings([wave(0.3), wave(0.01)])), [temperature, humidity])
  const any = feed(new CycleTracker(settings([wave(0.3), wave(0.01)], { combine: 'any' })), [temperature, humidity])
  // Humidity follows temperature by 2 minutes.
  assert.deepEqual([all.on, all.off, all.period], [5, 10, 15])
  assert.deepEqual([any.on, any.off, any.period], [9, 6, 15])
})

test('a rising wave can be the ON one', () => {
  const heater = (t) => sawtooth({ on: 10 * MIN, off: 20 * MIN, depth: -2, base: 290 })(t)
  const figures = feed(new CycleTracker(settings([{ kind: 'wave', direction: 'rising', swing: 0.5 }])), [heater])
  assert.deepEqual([figures.on, figures.off], [10, 20])
})

test('an input too damped to show cycles is left out, in either combination', () => {
  const n = noise(3)
  const flat = () => 266 + n() * 0.1
  const freezer = (t) => sawtooth({ on: 6.5 * MIN, off: 6.5 * MIN, depth: 0.05, base: 0.5 })(t)
  for (const combine of ['all', 'any']) {
    const figures = feed(new CycleTracker(settings([wave(0.3), wave(0.01)], { combine })), [flat, freezer])
    assert.deepEqual([figures.on, figures.off], [6.5, 6.5], combine)
    assert.ok(figures.cycles > 90, `${combine}: ${figures.cycles} cycles`)
  }
})

test('a gap in an input loses only the cycles around it', () => {
  const whole = feed(new CycleTracker(settings([wave(0.01)])), [humidity])
  const gapped = feed(new CycleTracker(settings([wave(0.01)])), [humidity], { skip: (index, t) => t >= 10 * HOUR && t < 11 * HOUR })
  assert.equal(gapped.on, 7)
  assert.ok(whole.cycles - gapped.cycles >= 4 && whole.cycles - gapped.cycles <= 7, `${whole.cycles} against ${gapped.cycles}`)
})

test('an on/off input is read against its threshold, and a flicker does not cut a stretch', () => {
  // A pump drawing 4 A for 3 minutes every 20 minutes, with a dip to 0 A for
  // 10 seconds in the middle of each run.
  const current = (t) => {
    const r = t % (20 * MIN)
    if (r >= 90000 && r < 100000) return 0
    return r < 3 * MIN ? 4 : 0.1
  }
  const figures = feed(new CycleTracker(settings([{ kind: 'onoff', threshold: 1 }])), [current], { every: 5000 })
  assert.deepEqual([figures.on, figures.off], [3, 17])
})

test('a switch is read as on/off with a threshold of 0', () => {
  const pump = (t) => (t % (12 * MIN)) < 4 * MIN
  // Sent only when it changes, so its stale timeout is 0.
  const tracker = new CycleTracker(settings([{ kind: 'onoff', threshold: 0 }], { staleMs: 0 }))
  const start = 1e9
  for (let t = 0; t < 6 * HOUR; t += 1000) {
    // A switch is sent only when it changes.
    if (t === 0 || pump(t) !== pump(t - 1000)) tracker.input(0, pump(t) ? 1 : 0, start + t)
    tracker.advance(WALL + t, start + t)
  }
  const figures = tracker.figures(WALL + 6 * HOUR)
  assert.equal(figures.onMedian, 4 * MIN)
  assert.equal(figures.offMedian, 8 * MIN)
})

test('stretches leave the window as they age, and longer ones than the longest are left out', () => {
  const tracker = new CycleTracker(settings([wave(0.01)], { windowMs: 2 * HOUR }))
  const figures = feed(tracker, [humidity], { hours: 6 })
  assert.ok(figures.cycles >= 7 && figures.cycles <= 9, `${figures.cycles} cycles in 2 h`)
  tracker.stretches.push({ on: true, ms: 3 * HOUR, end: WALL + 6 * HOUR })
  assert.equal(tracker.figures(WALL + 6 * HOUR).onMedian, 7 * MIN)
})

test('saved stretches come back, and damaged ones are dropped', () => {
  const tracker = new CycleTracker(settings([wave(0.01)]))
  feed(tracker, [humidity], { hours: 3 })
  const copy = new CycleTracker(settings([wave(0.01)]))
  copy.restore([...JSON.parse(JSON.stringify(tracker.serialize())), { on: 'yes' }, null, { on: true, ms: -1, end: 1 }])
  assert.deepEqual(copy.figures(WALL + 3 * HOUR), tracker.figures(WALL + 3 * HOUR))
})

test('median of an even count is the mean of the middle two', () => {
  assert.equal(median([1, 3, 2, 4]), 2.5)
  assert.equal(median([]), null)
})

// ------------------------------------------------------------- the engine

function engineFor (entry) {
  const normalized = normalizeConfig({ timeZone: 'UTC' }, { version: 1, groups: [], entries: [entry] })
  assert.equal(normalized.entries[0].error, null)
  return { normalized, engine: new Engine(normalized, null) }
}

const fridge = {
  id: 'f',
  type: 'cycles',
  output: 'fridge.compressor.onTime',
  inputs: [{ path: 'fridge.humidity', kind: 'wave', direction: 'falling', swing: 0.01 }],
  minCycles: 3
}

/** Runs an engine over the humidity sawtooth, ticking once a second. */
function drive (engine, from, to) {
  const values = {}
  for (let t = from; t < to; t += 1000) {
    if (t % 6000 === 0) engine.input('fridge.humidity', humidity(t), WALL + t, t)
    for (const { path, value } of engine.tick(WALL + t, t)) values[path] = value
  }
  return values
}

test('a Cycles entry waits for enough cycles, then publishes the median ON time in seconds', () => {
  const { engine } = engineFor(fridge)
  drive(engine, 0, 30 * MIN)
  const early = engine.snapshot(WALL + 30 * MIN, 30 * MIN)[0]
  assert.equal(early.state, 'waiting')
  assert.match(early.message, /^\d of the 3 cycles needed in the last 24 h have been counted\.$/)
  const values = drive(engine, 30 * MIN, 3 * HOUR)
  assert.equal(values['fridge.compressor.onTime'], 420)
  const item = engine.snapshot(WALL + 3 * HOUR, 3 * HOUR)[0]
  assert.equal(item.state, 'ok')
  assert.equal(item.unit, 's')
  assert.equal(item.cycles.offMedian, 480)
  assert.equal(item.canReset, true)
})

test('the duty cycle is published as a ratio', () => {
  const { engine } = engineFor({ ...fridge, statistic: 'duty' })
  const values = drive(engine, 0, 3 * HOUR)
  assert.ok(Math.abs(values['fridge.compressor.onTime'] - 7 / 15) < 0.01)
  assert.equal(engine.snapshot(WALL, 0)[0].unit, 'ratio')
})

test('the cycles survive a restart, and a reset forgets them', () => {
  const first = engineFor(fridge)
  drive(first.engine, 0, 3 * HOUR)
  const saved = JSON.parse(JSON.stringify(first.engine.serialize(WALL + 3 * HOUR)))
  assert.ok(saved.entries['fridge.compressor.onTime'].stretches.length > 10)

  const second = new Engine(first.normalized, saved)
  const values = {}
  for (const { path, value } of second.tick(WALL + 3 * HOUR + 1000, 0)) values[path] = value
  // The figure is back at once; with no input since the start it is stale.
  const item = second.snapshot(WALL + 3 * HOUR + 1000, 0)[0]
  assert.equal(item.value, 420)
  assert.equal(item.state, 'stale')

  assert.equal(second.reset('fridge.compressor.onTime', WALL + 3 * HOUR + 2000, 1000), true)
  const cleared = second.snapshot(WALL + 3 * HOUR + 2000, 1000)[0]
  assert.equal(cleared.cycles.count, 0)
  assert.equal(cleared.lastReset.cause, 'request')
})

test('changing how stretches are found drops the saved cycles; changing what is reported keeps them', () => {
  const first = engineFor(fridge)
  drive(first.engine, 0, 3 * HOUR)
  const saved = JSON.parse(JSON.stringify(first.engine.serialize(WALL + 3 * HOUR)))
  const reported = engineFor({ ...fridge, statistic: 'offMedian', window: 12 })
  const keeps = new Engine(reported.normalized, saved)
  assert.ok(keeps.entries[0].tracker.stretches.length > 10)
  const found = engineFor({ ...fridge, inputs: [{ ...fridge.inputs[0], swing: 0.02 }] })
  const drops = new Engine(found.normalized, saved)
  assert.equal(drops.entries[0].tracker.stretches.length, 0)
})

test('a Cycles entry is checked like the others', () => {
  const check = (entry) => normalizeConfig({}, { version: 1, groups: [], entries: [{ id: 'c', type: 'cycles', output: 'a.b', ...entry }] }).entries[0].error
  assert.equal(check({ inputs: [] }), 'no inputs are set')
  assert.match(check({ inputs: [{ path: 'a.x', kind: 'wave' }] }), /needs a swing above 0/)
  assert.match(check({ inputs: [{ path: 'a x' }] }), /is not a valid path of input 1/)
  assert.equal(check({ inputs: [{ path: 'a.x' }], shortest: 600, longest: 300 }), 'the longest stretch must be longer than the shortest')
  assert.equal(check({ inputs: [{ path: 'a.x' }], window: 0 }), 'the window must be longer than 0 hours')
  assert.equal(check({ inputs: [{ path: 'a.x' }] }), null)
})

test('an input that never sends a value is left out, and the others decide alone', () => {
  const pump = (t) => ((t % (12 * MIN)) < 4 * MIN ? 1 : 0)
  for (const combine of ['all', 'any']) {
    const tracker = new CycleTracker(settings([{ kind: 'onoff', threshold: 0 }, { kind: 'onoff', threshold: 0 }], { combine, staleMs: 0 }))
    const figures = feed(tracker, [pump, () => 0], { hours: 6, every: 1000, skip: (index) => index === 1 })
    assert.deepEqual([figures.on, figures.off], [4, 8], combine)
    assert.ok(figures.cycles >= 28, `${combine}: ${figures.cycles} cycles`)
    // Nothing piles up while it waits.
    assert.ok(tracker.inputs[0].timeline.changes.length <= 2)
  }
})

test('a wave input that reports once a minute is still read', () => {
  for (const every of [45000, 60000]) {
    const figures = feed(new CycleTracker(settings([wave(0.01)], { staleMs: 180000 })), [humidity], { every })
    assert.ok(figures.cycles >= 90, `every ${every / 1000} s: ${figures.cycles} cycles`)
    assert.ok(Math.abs(figures.on - 7) <= 0.5 && Math.abs(figures.off - 8) <= 0.5, `every ${every / 1000} s: ${figures.on}/${figures.off}`)
  }
})

test('a wave stretch is recorded a few minutes after it ends, not a stretch later', () => {
  const tracker = new CycleTracker(settings([wave(0.01)]))
  const start = 1e9
  const lags = []
  let seen = 0
  for (let t = 0; t < 6 * HOUR; t += 6000) {
    tracker.input(0, humidity(t), start + t)
    tracker.advance(WALL + t, start + t)
    for (; seen < tracker.stretches.length; seen++) lags.push((WALL + t - tracker.stretches[seen].end) / MIN)
  }
  const late = Math.max(...lags.slice(2))
  assert.ok(late <= 6, `recorded up to ${late} min after the end`)
})

test('forgetting the cycles also leaves out the stretch under way', () => {
  const pump = (t) => ((t % (20 * MIN)) < 5 * MIN ? 1 : 0)
  const tracker = new CycleTracker(settings([{ kind: 'onoff', threshold: 0 }], { staleMs: 0 }))
  const start = 1e9
  for (let t = 0; t <= 2 * HOUR + 2 * MIN; t += 1000) {
    tracker.input(0, pump(t), start + t)
    tracker.advance(WALL + t, start + t)
  }
  // Two minutes into an ON stretch.
  tracker.clear(start + 2 * HOUR + 2 * MIN)
  for (let t = 2 * HOUR + 2 * MIN + 1000; t < 3 * HOUR; t += 1000) {
    tracker.input(0, pump(t), start + t)
    tracker.advance(WALL + t, start + t)
  }
  // Recorded since: the OFF from 2:05, the cycle from 2:20 and the ON from
  // 2:40, not the ON that was under way.
  assert.deepEqual(tracker.stretches.map((s) => [s.on, s.ms / MIN]), [[false, 15], [true, 5], [false, 15], [true, 5]])
})

test('a pair of ON and OFF split by a restart is not a cycle', () => {
  const pump = (t) => ((t % (20 * MIN)) < 5 * MIN ? 1 : 0)
  const first = new CycleTracker(settings([{ kind: 'onoff', threshold: 0 }], { staleMs: 0 }))
  for (let t = 0; t < 2 * HOUR + 7 * MIN; t += 1000) {
    first.input(0, pump(t), 1e9 + t)
    first.advance(WALL + t, 1e9 + t)
  }
  const second = new CycleTracker(settings([{ kind: 'onoff', threshold: 0 }], { staleMs: 0 }))
  second.restore(JSON.parse(JSON.stringify(first.serialize())))
  // Restarted a minute later, on a new monotonic clock, during an OFF stretch.
  for (let t = 2 * HOUR + 8 * MIN; t < 4 * HOUR; t += 1000) {
    second.input(0, pump(t), t - 2 * HOUR)
    second.advance(WALL + t, t - 2 * HOUR)
  }
  const before = first.figures(WALL + 2 * HOUR + 7 * MIN)
  const after = second.figures(WALL + 4 * HOUR)
  assert.equal(after.duty, 0.25)
  assert.ok(after.cycles > before.cycles)
  assert.equal(second.stretches.filter((s) => s.joined === false).length, 2)
})

test('a figure read by a formula stays fresh while the input keeps coming', () => {
  const doc = {
    version: 1,
    groups: [],
    entries: [
      { id: 'c', type: 'cycles', inputs: [{ path: 'sw.pump', kind: 'onoff' }], statistic: 'onMedian', output: 'sw.pumpOn', staleTimeout: 60, shortest: 30 },
      { id: 'f', type: 'formula', inputs: [{ name: 'a', path: 'sw.pumpOn' }], expression: 'a / 60', output: 'sw.pumpOnMinutes', staleTimeout: 60 }
    ]
  }
  const engine = new Engine(normalizeConfig({ timeZone: 'UTC' }, doc), null)
  for (let t = 0; t <= 3 * HOUR; t += 5000) {
    engine.input('sw.pump', (t % (12 * MIN)) < 4 * MIN, WALL + t, t)
    engine.tick(WALL + t, t)
  }
  const formula = engine.snapshot(WALL + 3 * HOUR, 3 * HOUR).find((e) => e.key === 'f')
  assert.equal(formula.state, 'ok')
  assert.equal(formula.value, 4)
})

test('a cycles entry with nothing counted leaves a kept total on its output in place', () => {
  const saved = { savedAt: WALL, entries: { 'x.total': { signature: 'counter|a.b|increase', resets: 'day', total: 1234, since: WALL - 1000, orphanedAt: WALL } } }
  const doc = { version: 1, groups: [], entries: [{ id: 'k', type: 'cycles', inputs: [{ path: 'other.path', kind: 'onoff' }], output: 'x.total' }] }
  const engine = new Engine(normalizeConfig({ timeZone: 'UTC' }, doc), saved)
  assert.equal(engine.serialize(WALL + 1000).entries['x.total'].total, 1234)
})

test('an input that turns once and then drifts is left out like a flat one', () => {
  // Temperature dips once, then warms slowly for good; humidity cycles.
  const drift = (t) => (t < 20 * MIN ? 268 - (t < 10 * MIN ? t / MIN * 0.1 : (20 * MIN - t) / MIN * 0.1) : 268 + (t - 20 * MIN) / HOUR * 0.1)
  const freezer = (t) => sawtooth({ on: 6.5 * MIN, off: 6.5 * MIN, depth: 0.05, base: 0.5 })(t)
  const both = feed(new CycleTracker(settings([wave(0.3), wave(0.01)])), [drift, freezer], { hours: 12 })
  const alone = feed(new CycleTracker(settings([wave(0.01)])), [freezer], { hours: 12 })
  assert.ok(both.cycles >= alone.cycles - 10, `${both.cycles} against ${alone.cycles}`)
  assert.deepEqual([both.on, both.off], [6.5, 6.5])
})

test('a stretch after a flat spell is read the right way round', () => {
  // An on/off input always ON, and a wave that is flat for three hours and
  // then cycles 7 minutes falling (ON), 8 rising.
  const flatTo = 3 * HOUR
  const wavy = (t) => (t < flatTo ? 0.6 : sawtooth({ on: 7 * MIN, off: 8 * MIN, depth: 0.08, base: 0.6 })(t - flatTo))
  const figures = feed(new CycleTracker(settings([{ kind: 'onoff', threshold: 0 }, wave(0.01)], { staleMs: 0 })), [() => 1, wavy], { hours: 8 })
  assert.deepEqual([figures.on, figures.off], [7, 8])
})

test('a value handed over late does not rewrite what was combined', () => {
  const tracker = new CycleTracker(settings([{ kind: 'onoff', threshold: 0 }, { kind: 'onoff', threshold: 0 }], { staleMs: 0 }))
  tracker.input(0, 1, 0)
  tracker.advance(WALL + 400000, 400000)
  // The held value of input 2 dates from 50 s, but arrives at 400 s.
  tracker.input(1, 0, 50000)
  tracker.advance(WALL + 1000000, 1000000)
  assert.equal(tracker.state, false)
  assert.equal(tracker.members, '++')
})

test('a wave sensor that reports about once a minute, a little late at times, is read with the default stale timeout', () => {
  const doc = { version: 1, groups: [], entries: [{ id: 'w', type: 'cycles', inputs: [{ path: 'env.rh', kind: 'wave', swing: 0.01 }], output: 'env.on' }] }
  const config = normalizeConfig({ timeZone: 'UTC' }, doc).entries[0]
  assert.equal(config.staleMs, 180000)
  const j = noise(9)
  const tracker = new CycleTracker(config)
  let next = 0
  for (let t = 0; t < 24 * HOUR; t += 1000) {
    if (t >= next) {
      tracker.input(0, humidity(t), 1e9 + t)
      next = t + 60000 + Math.round(j() * 6) * 1000
    }
    tracker.advance(WALL + t, 1e9 + t)
  }
  assert.ok(tracker.figures(WALL + 24 * HOUR).cycles >= 90)
})
