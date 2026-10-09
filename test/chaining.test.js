'use strict'

/*
 * Tests of how entries affect each other, of start-up edge cases and of
 * faults in the surroundings (clock, configuration changes). Each of these
 * was a defect found in review before the first release.
 */

const assert = require('node:assert/strict')
const { test } = require('node:test')

const { normalizeConfig } = require('../lib/config')
const { Engine } = require('../lib/engine')

const NOON = Date.parse('2026-10-09T12:00:00Z')
const DAY = 86400000
const MIDNIGHT = 12 * 3600

function harness (options, saved, base = NOON) {
  const normalized = normalizeConfig({ timeZone: 'UTC', ...options })
  for (const entry of normalized.entries) assert.equal(entry.error, null, `${entry.label}: ${entry.error}`)
  const engine = new Engine(normalized, saved || null)
  const values = {}
  return {
    engine,
    input: (seconds, path, value) => engine.input(path, value, base + seconds * 1000, seconds * 1000),
    inputs: (seconds, list) => engine.inputs(list, base + seconds * 1000, seconds * 1000),
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

test('a period rollover reaches the entries that read the counter', () => {
  const h = harness({
    counters: [{ input: 'm.total', output: 'm.today', staleTimeout: 0 }],
    formulas: [{ inputs: [{ name: 't', path: 'm.today' }], expression: 't / 3600', output: 'm.todayWh', staleTimeout: 0 }]
  })
  h.input(0, 'm.total', 0)
  h.input(100, 'm.total', 3600)
  h.tick(100)
  assert.equal(h.value('m.todayWh'), 1)
  // The source is quiet through midnight (solar at night).
  h.tick(MIDNIGHT)
  assert.equal(h.value('m.today'), 0)
  assert.equal(h.value('m.todayWh'), 0)
})

test('a manual reset reaches the entries that read the total', () => {
  const h = harness({
    counters: [{ input: 'm.total', output: 'm.sum', resets: 'manual', staleTimeout: 0 }],
    formulas: [{ inputs: [{ name: 't', path: 'm.sum' }], expression: 't * 2', output: 'm.double', staleTimeout: 0 }]
  })
  h.input(0, 'm.total', 0)
  h.input(10, 'm.total', 50)
  h.tick(10)
  assert.equal(h.value('m.double'), 100)
  assert.equal(h.engine.reset('m.sum', NOON + 20000, 20000), true)
  h.tick(20)
  assert.equal(h.value('m.sum'), 0)
  assert.equal(h.value('m.double'), 0)
})

test('a formula that loses an input stops the integration that reads it', () => {
  for (const staleTimeout of [0, 60]) {
    const h = harness({
      formulas: [{ inputs: [{ name: 'i', path: 'a.i' }, { name: 'v', path: 'a.v' }], expression: 'i * v', output: 'a.p', staleTimeout }],
      integrations: [{ input: 'a.p', output: 'a.e', resets: 'manual', staleTimeout }]
    })
    for (let s = 0; s <= 60; s += 10) {
      h.input(s, 'a.v', 10)
      // The current sensor reports "no reading" from 20 s to 50 s.
      h.input(s, 'a.i', s >= 20 && s < 50 ? null : 10)
      for (let t = s; t < s + 10 && s < 60; t++) h.tick(t)
      if (s === 30) assert.equal(h.state('a.p', 39).state, 'waiting')
    }
    h.tick(60)
    // 0-10 s, 10-20 s and 50-60 s at 100 W. The 30 s hole adds nothing,
    // and it is not papered over by joining the readings on either side.
    assert.equal(h.value('a.e'), 3000, `stale timeout ${staleTimeout}`)
  }
})

test('a formula whose result is not finite stops the integration that reads it', () => {
  const h = harness({
    formulas: [{ inputs: [{ name: 'a', path: 'x.a' }, { name: 'b', path: 'x.b' }], expression: 'a / b', output: 'x.ratio', staleTimeout: 0 }],
    integrations: [{ input: 'x.ratio', output: 'x.sum', resets: 'manual', staleTimeout: 0 }]
  })
  h.inputs(0, [{ path: 'x.a', value: 10 }, { path: 'x.b', value: 2 }])
  for (let s = 1; s <= 10; s++) h.tick(s)
  assert.equal(h.value('x.sum'), 50)
  h.input(10, 'x.b', 0)
  for (let s = 11; s <= 100; s++) h.tick(s)
  assert.equal(h.value('x.sum'), 50)
})

test('a formula that goes stale stops a held integration that reads it', () => {
  const h = harness({
    formulas: [{ inputs: [{ name: 'p', path: 'h.raw' }], expression: 'p * 1', output: 'h.power', staleTimeout: 30 }],
    // The integration itself never goes stale and would hold forever.
    integrations: [{ input: 'h.power', output: 'h.energy', resets: 'manual', staleTimeout: 0 }]
  })
  for (let s = 0; s <= 20; s += 2) h.input(s, 'h.raw', 100)
  for (let s = 0; s <= 600; s++) h.tick(s)
  // Counted up to the moment the formula was found stale, about 30 s after
  // its last input at 20 s, and not for the ten minutes that follow.
  assert.ok(h.value('h.energy') >= 2000 && h.value('h.energy') <= 5200, String(h.value('h.energy')))
  assert.equal(h.state('h.power', 600).state, 'stale')
  // When the source returns, counting resumes without bridging the hole.
  const before = h.value('h.energy')
  h.input(700, 'h.raw', 100)
  h.input(710, 'h.raw', 100)
  h.tick(710)
  assert.equal(h.value('h.energy'), before + 1000)
})

test('"keep publishing" freezes the last result instead of recalculating from a stale input', () => {
  const h = harness({
    repeatInterval: 10,
    formulas: [{ inputs: [{ name: 'i', path: 'a.i' }, { name: 'v', path: 'a.v' }], expression: 'i * v', output: 'a.p', staleTimeout: 60, onStale: 'hold' }]
  })
  h.inputs(0, [{ path: 'a.i', value: 2 }, { path: 'a.v', value: 10 }])
  h.tick(0)
  // a.i goes quiet; a.v keeps changing.
  for (let s = 10; s <= 300; s += 10) h.input(s, 'a.v', 10 + s)
  h.tick(300)
  assert.equal(h.value('a.p'), 2 * 70) // last calculated at 60 s
  assert.equal(h.state('a.p', 300).state, 'stale')
})

test('values that arrive in one update are applied as one step', () => {
  const h = harness({
    formulas: [{ inputs: [{ name: 'i', path: 'a.i' }, { name: 'v', path: 'a.v' }], expression: 'i * v', output: 'a.p' }],
    integrations: [{ input: 'a.p', output: 'a.e', resets: 'manual' }]
  })
  // A steep ramp in both inputs, always delivered together.
  h.inputs(0, [{ path: 'a.i', value: 10 }, { path: 'a.v', value: 10 }])
  h.inputs(10, [{ path: 'a.i', value: 20 }, { path: 'a.v', value: 20 }])
  h.inputs(20, [{ path: 'a.i', value: 30 }, { path: 'a.v', value: 30 }])
  h.tick(20)
  // Trapezoids over the true products 100, 400 and 900.
  assert.equal(h.value('a.e'), ((100 + 400) / 2) * 10 + ((400 + 900) / 2) * 10)
})

test('two branches from one input meet again without a transient', () => {
  const h = harness({
    formulas: [
      { inputs: [{ name: 'x', path: 'd.raw' }], expression: 'x * 2', output: 'd.a', staleTimeout: 0 },
      { inputs: [{ name: 'x', path: 'd.raw' }], expression: 'x + x', output: 'd.b', staleTimeout: 0 },
      { inputs: [{ name: 'a', path: 'd.a' }, { name: 'b', path: 'd.b' }], expression: 'a - b', output: 'd.diff', staleTimeout: 0 }
    ],
    counters: [{ input: 'd.diff', output: 'd.moved', resets: 'manual', staleTimeout: 0 }]
  })
  for (let s = 0; s <= 100; s++) h.input(s, 'd.raw', s * 3)
  h.tick(100)
  // d.diff is always zero, so a counter on it must never move.
  assert.equal(h.value('d.diff'), 0)
  assert.equal(h.value('d.moved'), 0)
})

test('a path followed for resets may itself be calculated', () => {
  const h = harness({
    formulas: [{ inputs: [{ name: 'y', path: 'ref.raw' }], expression: 'y * 1', output: 'ref.calc', staleTimeout: 0 }],
    counters: [{ input: 'm.total', output: 'm.today', resets: 'path', resetPath: 'ref.calc', staleTimeout: 0 }]
  })
  assert.deepEqual(h.engine.externalPaths, ['m.total', 'ref.raw'])
  h.input(0, 'ref.raw', 500)
  h.input(0, 'm.total', 10)
  h.input(10, 'm.total', 60)
  h.tick(10)
  assert.equal(h.value('m.today'), 50)
  h.input(20, 'ref.raw', 0)
  h.tick(20)
  assert.equal(h.value('m.today'), 0)
})

test('a start-up value older than the stale timeout does not seed an integration', () => {
  const h = harness({ integrations: [{ input: 'e.rev', output: 'e.run', mode: 'time', staleTimeout: 60, resets: 'manual' }] })
  // At start-up (t = 1000 s) the server holds an engine speed three hours old.
  h.engine.input('e.rev', 1500, NOON + 1000000, 1000000 - 3 * 3600000, 1000000)
  h.tick(1000)
  assert.equal(h.state('e.run', 1000).state, 'stale')
  // The first live reading 50 s later must not credit those 50 s.
  h.input(1050, 'e.rev', 0)
  h.tick(1050)
  assert.equal(h.value('e.run'), 0)
})

test('a recent start-up value counts from the start, not from its own time', () => {
  const h = harness({ integrations: [{ input: 'e.rev', output: 'e.run', mode: 'time', staleTimeout: 60, resets: 'manual' }] })
  // Twenty seconds old at start-up.
  h.engine.input('e.rev', 1500, NOON + 1000000, 1000000 - 20000, 1000000)
  h.input(1030, 'e.rev', 1500)
  h.tick(1030)
  assert.equal(h.value('e.run'), 30)
})

test('an old start-up value does not make an unset clock look settled', () => {
  const options = { counters: [{ input: 'm.total', output: 'm.today', staleTimeout: 0 }] }
  const first = harness(options)
  first.input(0, 'm.total', 1000)
  first.input(100, 'm.total', 1500)
  const saved = first.save(100)

  // Restart with the clock two days behind and a two-hour-old held value.
  const engine = new Engine(normalizeConfig({ timeZone: 'UTC', ...options }), saved)
  const wrong = NOON - 2 * DAY
  engine.input('m.total', 1510, wrong, 5000 - 2 * 3600000, 5000)
  engine.tick(wrong + 1000, 6000)
  assert.equal(engine.clockSuspect, true)
  // The clock is corrected; today's total is intact.
  engine.input('m.total', 1520, NOON + 600000, 60000)
  const published = engine.tick(NOON + 600000, 60000)
  assert.equal(engine.clockSuspect, false)
  assert.equal(published.find((p) => p.path === 'm.today').value, 520)
})

test('a "counting since" in the future does not freeze an integration', () => {
  const options = { integrations: [{ input: 'p.power', output: 'p.energy', resets: 'manual', staleTimeout: 60 }] }
  // First run with the clock 30 days ahead.
  const ahead = harness(options, null, NOON + 30 * DAY)
  ahead.input(0, 'p.power', 100)
  ahead.input(10, 'p.power', 100)
  const saved = ahead.save(10)
  saved.savedAt = NOON - 1000 // as if saved again once the clock was right

  const h = harness(options, saved)
  for (let s = 0; s <= 100; s += 10) h.input(s, 'p.power', 100)
  h.tick(100)
  assert.equal(h.value('p.energy'), 1000 + 10000)
  assert.ok(Date.parse(h.state('p.energy', 100).since) <= NOON + 100000)
})

test('a reset while the clock is unset leaves "counting since" to be filled in later', () => {
  const options = { counters: [{ input: 'm.total', output: 'm.sum', resets: 'manual', staleTimeout: 0 }] }
  const engine = new Engine(normalizeConfig({ timeZone: 'UTC', ...options }), null)
  engine.input('m.total', 10, 2000, 2000)
  engine.input('m.total', 30, 3000, 3000)
  engine.reset('m.sum', 4000, 4000)
  assert.equal(engine.snapshot(4000, 4000)[0].since, null)
  engine.tick(NOON, 5000)
  assert.equal(engine.snapshot(NOON, 5000)[0].since, '2026-10-09T12:00:00.000Z')
})

test('changing how an entry resets clears a total collected under the old rule', () => {
  const manual = harness({ counters: [{ input: 'm.total', output: 'm.out', resets: 'manual', staleTimeout: 0 }] }, null, NOON - 5 * DAY)
  manual.input(0, 'm.total', 1)
  manual.input(10, 'm.total', 100000)
  const saved = manual.save(10)

  const daily = harness({ counters: [{ input: 'm.total', output: 'm.out', resets: 'day', staleTimeout: 0 }] }, saved)
  daily.input(0, 'm.total', 100001)
  daily.tick(0)
  // The counter keeps its place in the input, so only today's change shows.
  assert.equal(daily.value('m.out'), 1)

  // The same rule is kept: the total survives.
  const same = harness({ counters: [{ input: 'm.total', output: 'm.out', resets: 'manual', staleTimeout: 0 }] }, saved)
  same.input(0, 'm.total', 100001)
  same.tick(0)
  assert.equal(same.value('m.out'), 100000)
})

test('reset acts on the running entry when a disabled one shares its output path', () => {
  const h = harness({
    counters: [
      { input: 'old.total', output: 'x.today', enabled: false },
      { input: 'new.total', output: 'x.today', resets: 'manual', staleTimeout: 0 }
    ]
  })
  h.input(0, 'new.total', 1)
  h.input(10, 'new.total', 50)
  h.tick(10)
  assert.equal(h.value('x.today'), 49)
  assert.equal(h.engine.reset('x.today', NOON + 20000, 20000), true)
  h.tick(20)
  assert.equal(h.value('x.today'), 0)
  // Every entry on the status page has its own key.
  const keys = h.engine.snapshot(NOON, 0).map((e) => e.key)
  assert.equal(new Set(keys).size, keys.length)
})

test('a total that stops being finite is cleared, never published', () => {
  const h = harness({ integrations: [{ input: 'p.x', output: 'p.sum', resets: 'manual', staleTimeout: 0 }] })
  h.input(0, 'p.x', 1e308)
  const seen = []
  for (let s = 1; s <= 20; s++) seen.push(...h.tick(s).map((p) => p.value))
  assert.ok(seen.length > 0)
  assert.ok(seen.every(Number.isFinite), JSON.stringify(seen))
  assert.match(h.state('p.sum', 20).message, /no longer a finite number/)
})

test('a stale entry that keeps publishing still passes a rollover downstream', () => {
  const h = harness({
    counters: [{ input: 'm.total', output: 'm.today', staleTimeout: 60, onStale: 'hold' }],
    formulas: [{ inputs: [{ name: 't', path: 'm.today' }], expression: 't / 3600', output: 'm.todayWh', staleTimeout: 0 }]
  })
  h.input(0, 'm.total', 0)
  h.input(100, 'm.total', 3600)
  h.tick(100)
  assert.equal(h.value('m.todayWh'), 1)
  h.tick(MIDNIGHT)
  assert.equal(h.value('m.today'), 0)
  assert.equal(h.value('m.todayWh'), 0)
})

test('a restored counter that has seen no input yet feeds nothing downstream', () => {
  const options = {
    counters: [{ input: 'm.total', output: 'm.today', staleTimeout: 0 }],
    formulas: [{ inputs: [{ name: 't', path: 'm.today' }, { name: 'o', path: 'o.x' }], expression: 't + o', output: 'm.sum', staleTimeout: 0 }]
  }
  const first = harness(options)
  first.input(0, 'm.total', 100)
  first.input(10, 'm.total', 150)
  const saved = first.save(10)
  // Restart the next morning. The other input arrives; the counter's has not.
  const h = harness(options, saved, NOON + 18 * 3600000)
  h.tick(0)
  h.input(1, 'o.x', 7)
  assert.deepEqual(h.tick(1), [])
  assert.equal(h.state('m.sum', 1).state, 'waiting')
  h.input(2, 'm.total', 160)
  h.tick(2)
  assert.equal(h.value('m.sum'), 17)
})

test('pointing an entry at a different path to follow does not clear its total', () => {
  const first = harness({ counters: [{ input: 'm.total', output: 'm.today', resets: 'path', resetPath: 'ref.a', staleTimeout: 0 }] })
  first.input(0, 'ref.a', 5000)
  first.input(0, 'm.total', 0)
  first.input(10, 'm.total', 300)
  const saved = first.save(10)
  const h = harness({ counters: [{ input: 'm.total', output: 'm.today', resets: 'path', resetPath: 'ref.b', staleTimeout: 0 }] }, saved)
  // The new path starts far below the old one's level: not a fall.
  h.input(0, 'ref.b', 20)
  h.input(1, 'm.total', 310)
  h.tick(1)
  assert.equal(h.value('m.today'), 310)
  h.input(2, 'ref.b', 5)
  h.tick(2)
  assert.equal(h.value('m.today'), 0)
})

test('"counting since" is the first value, also when a boundary passed before it', () => {
  const h = harness({ counters: [{ input: 'm.total', output: 'm.today', staleTimeout: 0 }] })
  h.tick(0)
  h.tick(MIDNIGHT + 60)
  // The first value arrives at 10:00 the next day.
  h.input(22 * 3600, 'm.total', 5)
  h.tick(22 * 3600)
  assert.equal(h.state('m.today', 22 * 3600).since, '2026-10-10T10:00:00.000Z')
})

test('a value offered for an entry\'s own output path is not taken in', () => {
  const h = harness({
    formulas: [
      { inputs: [{ name: 'x', path: 'f.raw' }], expression: 'x * 2', output: 'f.x', staleTimeout: 0 },
      { inputs: [{ name: 'x', path: 'f.x' }], expression: 'x + 1', output: 'g.x', staleTimeout: 0 }
    ]
  })
  h.input(0, 'f.raw', 1)
  h.input(1, 'f.x', 1000)
  h.tick(1)
  assert.equal(h.value('f.x'), 2)
  assert.equal(h.value('g.x'), 3)
})
