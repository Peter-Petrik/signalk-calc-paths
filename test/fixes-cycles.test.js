'use strict'

/*
 * Tests of the defects fixed in version 0.6.1 in the cycle tracker, and of
 * behaviours a mutation run showed to be untested.
 */

const assert = require('node:assert/strict')
const { test } = require('node:test')

const { CycleTracker } = require('../lib/cycles')

const MIN = 60000
const HOUR = 60 * MIN
const WALL = Date.parse('2026-10-15T00:00:00Z')
const YEAR = 365 * 24 * HOUR

function settings (inputs, extra = {}) {
  return { combine: 'all', inputs, staleMs: 60000, smoothingMs: 150000, shortestMs: 120000, longestMs: 2 * HOUR, windowMs: 24 * HOUR, ...extra }
}

const onOff = { kind: 'onoff', threshold: 0 }

/** A pump that runs `on` ms out of every `period` ms. */
const pump = (on, period) => (t) => ((t % period) < on ? 1 : 0)

/**
 * Feeds a tracker one value every `every` ms from `from` to `to`, with the
 * wall clock given by `wall`. Returns the tracker.
 */
function run (tracker, signal, { from = 0, to, every = 1000, wall = (t) => WALL + t }) {
  for (let t = from; t < to; t += every) {
    tracker.input(0, signal(t), 1e9 + t)
    tracker.advance(wall(t), 1e9 + t)
  }
  return tracker
}

// ------------------------------------- 3. a wall clock that ran ahead

test('stretches dated by a clock that ran ahead do not keep old ones in the window', () => {
  const tracker = new CycleTracker(settings([onOff], { staleMs: 0 }))
  // The clock runs a year ahead for half an hour, then is set right.
  const wall = (t) => WALL + t + (t >= HOUR && t < 1.5 * HOUR ? YEAR : 0)
  run(tracker, pump(4 * MIN, 12 * MIN), { to: 30 * HOUR, wall })
  const now = wall(30 * HOUR)
  const used = tracker.inWindow(now)
  assert.ok(used.length > 0)
  assert.ok(used.every((s) => s.end >= now - 24 * HOUR), 'a stretch older than the window is used')
  // The stretches dated a year ahead are dropped, and nothing older than
  // the window is kept behind them.
  assert.ok(tracker.stretches.every((s) => s.end >= now - 24 * HOUR && s.end <= now + 24 * HOUR))
  const figures = tracker.figures(now)
  assert.equal(figures.cycles, used.filter((s) => s.on).length)
  assert.ok(figures.cycles >= 118 && figures.cycles <= 121, `${figures.cycles} cycles`)
})

test('while the clock is not trusted, stretches dated after it are kept, not dropped', () => {
  // A day of cycles, then a restart on a computer whose clock reads 1970
  // until the time is set: the stretches must survive that pass.
  const tracker = run(new CycleTracker(settings([onOff])), pump(10 * MIN, 30 * MIN), { to: 6 * HOUR })
  const kept = tracker.stretches.length
  assert.ok(kept >= 20)
  tracker.clockTrusted = false
  assert.equal(tracker.figures(0).cycles, 0)
  assert.equal(tracker.stretches.length, kept)
  tracker.clockTrusted = true
  assert.ok(tracker.figures(WALL + 6 * HOUR).cycles >= 10)
  assert.equal(tracker.stretches.length, kept)
})

test('a stretch dated a little after the present is kept, and used once the present reaches it', () => {
  const tracker = new CycleTracker(settings([onOff]))
  const now = WALL + 10 * HOUR
  tracker.restore([
    { on: true, ms: 4 * MIN, end: now - HOUR },
    { on: true, ms: 5 * MIN, end: now + 30000 },
    { on: true, ms: 6 * MIN, end: now + 10 * MIN }
  ])
  // Up to a minute ahead counts as the present.
  assert.equal(tracker.figures(now).cycles, 2)
  assert.equal(tracker.stretches.length, 3)
  assert.equal(tracker.figures(now + 10 * MIN).cycles, 3)
})

// ------------------------------- 4. a wave stretch just under the longest

test('a wave stretch a few minutes shorter than the longest stretch is recorded', () => {
  // Falls (ON) for 57 minutes and rises for 20, with the longest stretch at
  // 60 minutes. The turn at the end of an ON stretch is confirmed minutes
  // after it.
  const saw = (t) => {
    const r = t % (77 * MIN)
    return r < 57 * MIN ? 1 - r / (57 * MIN) : (r - 57 * MIN) / (20 * MIN)
  }
  const tracker = new CycleTracker(settings([{ kind: 'wave', direction: 'falling', swing: 0.1 }], { longestMs: HOUR }))
  run(tracker, saw, { to: 12 * HOUR, every: 6000 })
  const figures = tracker.figures(WALL + 12 * HOUR)
  assert.ok(figures.cycles >= 8, `${figures.cycles} cycles`)
  assert.ok(Math.abs(figures.onMedian / MIN - 57) <= 1, `${figures.onMedian / MIN} min ON`)
  assert.ok(Math.abs(figures.offMedian / MIN - 20) <= 1, `${figures.offMedian / MIN} min OFF`)
})

test('a wave that stops turning is still left out after the longest stretch', () => {
  const tracker = new CycleTracker(settings([{ kind: 'wave', direction: 'falling', swing: 0.1 }], { longestMs: HOUR }))
  const saw = (t) => {
    const r = t % (30 * MIN)
    return r < 15 * MIN ? 1 - r / (15 * MIN) : (r - 15 * MIN) / (15 * MIN)
  }
  // Cycles for three hours, then a flat line.
  run(tracker, (t) => (t < 3 * HOUR ? saw(t) : saw(3 * HOUR)), { to: 3 * HOUR + 2 * HOUR, every: 6000 })
  assert.equal(tracker.inputs[0].flat, true)
})

// ------------------------------------- 9. behaviours the mutation run found

test('a change that holds for exactly the shortest stretch is accepted', () => {
  const tracker = new CycleTracker(settings([onOff], { staleMs: 0, shortestMs: 120000 }))
  // OFF, then ON for exactly two minutes, then OFF again for ten.
  const signal = (t) => (t >= 10 * MIN && t < 12 * MIN ? 1 : 0)
  run(tracker, signal, { to: 30 * MIN })
  assert.deepEqual(tracker.stretches.filter((s) => s.on).map((s) => s.ms), [2 * MIN])
})

test('an on/off input silent for longer than the stale timeout breaks the stretch under way', () => {
  const signal = pump(4 * MIN, 12 * MIN)
  const count = (skip) => {
    const tracker = new CycleTracker(settings([onOff], { staleMs: 60000, shortestMs: 30000 }))
    for (let t = 0; t < 3 * HOUR; t += 1000) {
      if (!skip(t)) tracker.input(0, signal(t), 1e9 + t)
      tracker.advance(WALL + t, 1e9 + t)
    }
    return tracker.stretches.filter((s) => s.on)
  }
  const whole = count(() => false)
  // Three minutes without a value inside the ON stretch of the sixth cycle.
  const broken = count((t) => t >= 60 * MIN + 30000 && t < 63 * MIN + 30000)
  assert.equal(broken.length, whole.length - 1)
  assert.ok(broken.every((s) => s.ms === 4 * MIN), JSON.stringify(broken.map((s) => s.ms)))
})
