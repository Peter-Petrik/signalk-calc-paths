'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')

const { normalizeConfig } = require('../lib/config')
const { Engine } = require('../lib/engine')

const NOON = Date.parse('2026-10-09T12:00:00Z')
const DAY = 86400000

/**
 * A small harness around the engine. Time is given in seconds after noon
 * UTC on 2026-10-09 and drives both clocks together, as in normal running.
 */
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

// ---------------------------------------------------------------- formulas

test('a formula publishes once every input has a value', () => {
  const h = harness({ formulas: [{ inputs: [{ name: 'i', path: 'a.current' }, { name: 'v', path: 'a.voltage' }], expression: 'i * v', output: 'a.power' }] })
  h.input(0, 'a.current', 2)
  assert.deepEqual(h.tick(0), [])
  assert.equal(h.state('a.power', 0).state, 'waiting')
  assert.match(h.state('a.power', 0).message, /a\.voltage/)
  h.input(1, 'a.voltage', 10)
  assert.deepEqual(h.tick(1), [{ path: 'a.power', value: 20 }])
  h.input(2, 'a.current', 3)
  assert.deepEqual(h.tick(2), [{ path: 'a.power', value: 30 }])
})

test('an unchanged value is repeated only at the repeat interval', () => {
  const h = harness({ repeatInterval: 10, formulas: [{ inputs: [{ name: 'x', path: 'a.x' }], expression: 'x * 2', output: 'a.double', staleTimeout: 0 }] })
  h.input(0, 'a.x', 1)
  assert.equal(h.tick(0).length, 1)
  for (let s = 1; s < 10; s++) assert.equal(h.tick(s).length, 0, `second ${s}`)
  assert.equal(h.tick(10).length, 1)
  assert.equal(h.tick(11).length, 0)
})

test('with the repeat interval at zero only changes are published', () => {
  const h = harness({ repeatInterval: 0, formulas: [{ inputs: [{ name: 'x', path: 'a.x' }], expression: 'x', output: 'a.copy', staleTimeout: 0 }] })
  h.input(0, 'a.x', 1)
  assert.equal(h.tick(0).length, 1)
  for (let s = 1; s < 100; s++) assert.equal(h.tick(s).length, 0)
  h.input(100, 'a.x', 2)
  assert.equal(h.tick(100).length, 1)
})

test('a stale input stops a formula, and it resumes when the input returns', () => {
  const h = harness({ formulas: [{ inputs: [{ name: 'i', path: 'a.i' }, { name: 'v', path: 'a.v' }], expression: 'i * v', output: 'a.p', staleTimeout: 30 }] })
  h.input(0, 'a.i', 2)
  h.input(0, 'a.v', 10)
  assert.equal(h.tick(0).length, 1)
  // a.v keeps arriving; a.i goes quiet.
  for (let s = 10; s <= 60; s += 10) h.input(s, 'a.v', 10)
  assert.deepEqual(h.tick(31), [])
  assert.equal(h.state('a.p', 31).state, 'stale')
  assert.deepEqual(h.tick(60), [])
  h.input(61, 'a.i', 4)
  assert.deepEqual(h.tick(61), [{ path: 'a.p', value: 40 }])
  assert.equal(h.state('a.p', 61).state, 'ok')
})

test('"keep publishing" holds the last result through a stale input', () => {
  const h = harness({ repeatInterval: 10, formulas: [{ inputs: [{ name: 'x', path: 'a.x' }], expression: 'x + 1', output: 'a.y', staleTimeout: 30, onStale: 'hold' }] })
  h.input(0, 'a.x', 1)
  h.tick(0)
  assert.deepEqual(h.tick(100), [{ path: 'a.y', value: 2 }])
  assert.equal(h.state('a.y', 100).state, 'stale')
  assert.match(h.state('a.y', 100).message, /still publishing/)
})

test('a stale timeout of zero never goes stale', () => {
  const h = harness({ repeatInterval: 10, formulas: [{ inputs: [{ name: 'x', path: 'a.x' }], expression: 'x', output: 'a.y', staleTimeout: 0 }] })
  h.input(0, 'a.x', 5)
  h.tick(0)
  assert.equal(h.state('a.y', 86400).state, 'ok')
  assert.equal(h.tick(86400).length, 1)
})

test('a result that is not a finite number is withheld', () => {
  const h = harness({ formulas: [{ inputs: [{ name: 'a', path: 'x.a' }, { name: 'b', path: 'x.b' }], expression: 'a / b', output: 'x.ratio' }] })
  h.input(0, 'x.a', 1)
  h.input(0, 'x.b', 0)
  assert.deepEqual(h.tick(0), [])
  assert.equal(h.state('x.ratio', 0).state, 'waiting')
  assert.match(h.state('x.ratio', 0).message, /no finite number/)
  h.input(1, 'x.b', 4)
  assert.deepEqual(h.tick(1), [{ path: 'x.ratio', value: 0.25 }])
})

test('true and false count as 1 and 0; other non-numbers are ignored', () => {
  const h = harness({ formulas: [{ inputs: [{ name: 's', path: 'sw.state' }], expression: 's * 5', output: 'sw.scaled' }] })
  h.input(0, 'sw.state', true)
  assert.deepEqual(h.tick(0), [{ path: 'sw.scaled', value: 5 }])
  h.input(1, 'sw.state', false)
  assert.deepEqual(h.tick(1), [{ path: 'sw.scaled', value: 0 }])
  // A null withdraws the input: the entry has nothing to calculate from.
  h.input(2, 'sw.state', null)
  assert.deepEqual(h.tick(2), [])
  assert.equal(h.state('sw.scaled', 2).state, 'waiting')
  h.input(3, 'sw.state', { code: 3 })
  assert.deepEqual(h.tick(3), [])
})

// ---------------------------------------------------------- period counters

const counter = (extra) => ({ counters: [{ input: 'm.total', output: 'm.today', ...extra }] })

test('a counter reports the change since it first saw the input', () => {
  const h = harness(counter())
  h.input(0, 'm.total', 1000)
  assert.deepEqual(h.tick(0), [{ path: 'm.today', value: 0 }])
  h.input(10, 'm.total', 1030)
  h.input(20, 'm.total', 1045)
  assert.deepEqual(h.tick(20), [{ path: 'm.today', value: 45 }])
  assert.equal(h.state('m.today', 20).since, '2026-10-09T12:00:00.000Z')
})

test('a daily counter restarts from zero at midnight with the last value as baseline', () => {
  const h = harness(counter())
  h.input(0, 'm.total', 1000)
  h.input(11 * 3600, 'm.total', 1500) // 23:00
  h.tick(11 * 3600)
  assert.equal(h.value('m.today'), 500)
  // The input keeps reporting 1500 through midnight.
  h.input(12 * 3600 - 2, 'm.total', 1500)
  h.tick(12 * 3600 - 1)
  assert.equal(h.value('m.today'), 500)
  assert.deepEqual(h.tick(12 * 3600), [{ path: 'm.today', value: 0 }])
  assert.equal(h.state('m.today', 12 * 3600).since, '2026-10-10T00:00:00.000Z')
  h.input(12 * 3600 + 5, 'm.total', 1500)
  h.input(18 * 3600, 'm.total', 1620)
  h.tick(18 * 3600)
  assert.equal(h.value('m.today'), 120)
})

test('change that arrives with the first value after midnight belongs to the new day', () => {
  const h = harness(counter({ staleTimeout: 0 }))
  h.input(0, 'm.total', 1000)
  h.input(12 * 3600 - 30, 'm.total', 1400) // 23:59:30
  h.tick(12 * 3600 - 30)
  assert.equal(h.value('m.today'), 400)
  // The next value arrives 40 s later, after midnight, 7 higher.
  h.input(12 * 3600 + 10, 'm.total', 1407)
  h.tick(12 * 3600 + 10)
  assert.equal(h.value('m.today'), 7)
})

test('weekly, monthly and yearly counters reset only at their own boundaries', () => {
  const h = harness({
    counters: [
      { input: 'm.total', output: 'm.week', resets: 'week', staleTimeout: 0 },
      { input: 'm.total', output: 'm.month', resets: 'month', staleTimeout: 0 },
      { input: 'm.total', output: 'm.year', resets: 'year', staleTimeout: 0 },
      { input: 'm.total', output: 'm.ever', resets: 'manual', staleTimeout: 0 }
    ]
  })
  // Friday 2026-10-09 noon. One unit per hour for 100 days.
  let total = 0
  const perDay = {}
  for (let hour = 0; hour <= 100 * 24; hour++) {
    h.input(hour * 3600, 'm.total', total)
    h.tick(hour * 3600)
    perDay[hour] = { week: h.value('m.week'), month: h.value('m.month'), year: h.value('m.year'), ever: h.value('m.ever') }
    total += 1
  }
  // Monday 2026-10-12 00:00 is 60 hours after the start. The value that
  // arrives exactly on the boundary is one higher than the last value of
  // the old week, and that one unit is the first of the new week.
  assert.equal(perDay[59].week, 59)
  assert.equal(perDay[60].week, 1)
  assert.equal(perDay[61].week, 2)
  assert.equal(perDay[60].month, 60)
  // 2026-11-01 00:00 is 22.5 days after the start: hour 540.
  assert.equal(perDay[539].month, 539)
  assert.equal(perDay[540].month, 1)
  assert.equal(perDay[540].year, 540)
  // 2027-01-01 00:00 is 83.5 days after the start: hour 2004.
  assert.equal(perDay[2003].year, 2003)
  assert.equal(perDay[2004].year, 1)
  assert.equal(perDay[2400].ever, 2400)
})

test('counting decreases turns a falling level into consumption and ignores a refill', () => {
  const h = harness(counter({ direction: 'decrease' }))
  h.input(0, 'm.total', 0.80)
  h.input(10, 'm.total', 0.75)
  h.input(20, 'm.total', 0.70)
  h.tick(20)
  near(h.value('m.today'), 0.10)
  h.input(30, 'm.total', 1.00) // refill
  h.tick(30)
  near(h.value('m.today'), 0.10)
  h.input(40, 'm.total', 0.95)
  h.tick(40)
  near(h.value('m.today'), 0.15)
})

test('net change is signed', () => {
  const h = harness(counter({ direction: 'net' }))
  h.input(0, 'm.total', 50)
  h.input(10, 'm.total', 60)
  h.input(20, 'm.total', 35)
  h.tick(20)
  assert.equal(h.value('m.today'), -15)
})

test('a counter that restarts from zero carries on by default', () => {
  const h = harness(counter())
  h.input(0, 'm.total', 9000)
  h.input(10, 'm.total', 9040)
  h.input(20, 'm.total', 0) // the source counter was reset
  h.input(30, 'm.total', 25)
  h.tick(30)
  assert.equal(h.value('m.today'), 65)
})

test('"wait until the previous level is passed" ignores a dip and what follows it', () => {
  const h = harness(counter({ reversal: 'wait' }))
  h.input(0, 'm.total', 9000)
  h.input(10, 'm.total', 9040)
  h.input(20, 'm.total', 8990) // glitch
  h.input(30, 'm.total', 9040) // back to the old level: nothing counted twice
  h.input(40, 'm.total', 9050)
  h.tick(40)
  assert.equal(h.value('m.today'), 50)
})

test('a smallest change keeps sensor ripple out of the total', () => {
  const h = harness(counter({ direction: 'decrease', minStep: 0.02 }))
  h.input(0, 'm.total', 0.500)
  // Ripple of +/- 0.005 around a level that is not moving.
  for (let s = 1; s <= 200; s++) h.input(s, 'm.total', 0.500 + (s % 2 === 0 ? 0.005 : -0.005))
  h.tick(200)
  assert.equal(h.value('m.today'), 0)
  // A real fall, in small steps, is counted once it adds up to the step.
  for (let s = 201; s <= 300; s++) h.input(s, 'm.total', 0.500 - (s - 200) * 0.001)
  h.tick(300)
  near(h.value('m.today'), 0.10, 0.02)
})

test('a counter resets when the path it follows falls', () => {
  const h = harness({ counters: [{ input: 'm.total', output: 'm.today', resets: 'path', resetPath: 'ref.yieldToday', staleTimeout: 0 }] })
  h.input(0, 'ref.yieldToday', 500)
  h.input(0, 'm.total', 1000)
  h.input(10, 'm.total', 1100)
  h.input(10, 'ref.yieldToday', 510)
  h.tick(10)
  assert.equal(h.value('m.today'), 100)
  // Midnight UTC passes without a reset.
  h.input(13 * 3600, 'm.total', 1100)
  h.tick(13 * 3600)
  assert.equal(h.value('m.today'), 100)
  // The reference device starts its new day.
  h.input(14 * 3600, 'ref.yieldToday', 0)
  assert.deepEqual(h.tick(14 * 3600), [{ path: 'm.today', value: 0 }])
  h.input(20 * 3600, 'm.total', 1130)
  h.tick(20 * 3600)
  assert.equal(h.value('m.today'), 30)
})

test('a manual reset clears the total and restarts "counting since"', () => {
  const h = harness(counter({ resets: 'manual', staleTimeout: 0 }))
  h.input(0, 'm.total', 10)
  h.input(100, 'm.total', 25)
  h.tick(100)
  assert.equal(h.value('m.today'), 15)
  assert.equal(h.engine.reset('m.today', NOON + 200000), true)
  assert.deepEqual(h.tick(200), [{ path: 'm.today', value: 0 }])
  assert.equal(h.state('m.today', 200).since, '2026-10-09T12:03:20.000Z')
  h.input(300, 'm.total', 30)
  h.tick(300)
  assert.equal(h.value('m.today'), 5)
  assert.equal(h.engine.reset('no.such.path', NOON), false)
})

test('a stale counter stops publishing and loses nothing over the gap', () => {
  const h = harness(counter({ staleTimeout: 60 }))
  h.input(0, 'm.total', 100)
  h.input(30, 'm.total', 110)
  h.tick(30)
  assert.deepEqual(h.tick(100), [])
  assert.equal(h.state('m.today', 100).state, 'stale')
  // Ten minutes of silence, during which the source counted on.
  h.input(630, 'm.total', 190)
  assert.deepEqual(h.tick(630), [{ path: 'm.today', value: 90 }])
})

// ------------------------------------------------------------- integrations

const integration = (extra) => ({ integrations: [{ input: 'p.power', output: 'p.energy', ...extra }] })

test('an integration adds up value times seconds between values', () => {
  const h = harness(integration())
  h.input(0, 'p.power', 100)
  h.input(10, 'p.power', 100)
  h.tick(10)
  assert.equal(h.value('p.energy'), 1000)
  // A ramp from 100 to 300 over 10 s averages 200.
  h.input(20, 'p.power', 300)
  h.tick(20)
  assert.equal(h.value('p.energy'), 3000)
})

test('an integration matches the exact integral of a smooth curve', () => {
  const h = harness(integration({ resets: 'manual' }))
  // Half a sine wave peaking at 500 W over one hour: integral is
  // 500 * 3600 * 2 / pi joules.
  for (let s = 0; s <= 3600; s += 2) h.input(s, 'p.power', 500 * Math.sin((Math.PI * s) / 3600))
  h.tick(3600)
  near(h.value('p.energy'), (500 * 3600 * 2) / Math.PI, 1)
})

test('time mode adds up the seconds the input is above the threshold', () => {
  const h = harness({ integrations: [{ input: 'e.rev', output: 'e.running', mode: 'time', threshold: 0 }] })
  h.input(0, 'e.rev', 0)
  h.input(10, 'e.rev', 12) // starts
  h.input(20, 'e.rev', 30)
  h.input(70, 'e.rev', 0) // stops
  h.input(80, 'e.rev', 0)
  h.tick(80)
  assert.equal(h.value('e.running'), 60)
})

test('time mode works on a switch state', () => {
  const h = harness({ integrations: [{ input: 'sw.state', output: 'sw.onTime', mode: 'time', staleTimeout: 0 }] })
  h.input(0, 'sw.state', false)
  h.input(100, 'sw.state', true)
  h.input(400, 'sw.state', false)
  h.input(500, 'sw.state', false)
  h.tick(500)
  assert.equal(h.value('sw.onTime'), 300)
})

test('a gap longer than the stale timeout is left out by default', () => {
  const h = harness(integration({ staleTimeout: 60 }))
  h.input(0, 'p.power', 100)
  h.input(10, 'p.power', 100)
  h.input(610, 'p.power', 100) // ten minutes of silence
  h.input(620, 'p.power', 100)
  h.tick(620)
  assert.equal(h.value('p.energy'), 2000)
})

test('"bridge" fills a gap with the last value', () => {
  const h = harness(integration({ staleTimeout: 60, gap: 'bridge' }))
  h.input(0, 'p.power', 100)
  h.input(10, 'p.power', 100)
  h.input(610, 'p.power', 400) // held at 100 across the gap, not ramped
  h.input(620, 'p.power', 400)
  h.tick(620)
  assert.equal(h.value('p.energy'), 1000 + 60000 + 4000)
})

test('an interval that spans midnight is split at the boundary', () => {
  const h = harness(integration({ staleTimeout: 0 }))
  const midnight = 12 * 3600
  h.input(midnight - 30, 'p.power', 100)
  h.tick(midnight - 30)
  // One value 30 s before midnight, the next 30 s after, constant power.
  h.input(midnight + 30, 'p.power', 100)
  h.tick(midnight + 30)
  assert.equal(h.value('p.energy'), 3000)
  assert.equal(h.state('p.energy', midnight + 30).since, '2026-10-10T00:00:00.000Z')
})

test('a ramp across midnight is credited by its part after the boundary', () => {
  const h = harness(integration({ staleTimeout: 120 }))
  const midnight = 12 * 3600
  h.input(midnight - 10, 'p.power', 0)
  h.input(midnight + 30, 'p.power', 400)
  h.tick(midnight + 30)
  // At midnight the ramp stands at 100; from there to 400 over 30 s.
  assert.equal(h.value('p.energy'), ((100 + 400) / 2) * 30)
})

test('with a stale timeout of zero the input holds its value between readings', () => {
  const h = harness(integration({ staleTimeout: 0, resets: 'manual' }))
  // A heater that reports its power only when it changes.
  h.input(0, 'p.power', 750)
  h.input(600, 'p.power', 0)
  h.input(900, 'p.power', 750)
  h.input(1000, 'p.power', 0)
  h.tick(1000)
  // 600 s and 100 s at 750 W, with no ramps in between.
  assert.equal(h.value('p.energy'), 750 * 700)
})

test('a held input keeps adding up every second while nothing new arrives', () => {
  const h = harness({ integrations: [{ input: 'sw.state', output: 'sw.onTime', mode: 'time', staleTimeout: 0, resets: 'day' }] })
  h.input(0, 'sw.state', true)
  h.tick(0)
  assert.equal(h.value('sw.onTime'), 0)
  // No further value arrives; the total still follows the clock.
  h.tick(1)
  assert.equal(h.value('sw.onTime'), 1)
  for (let s = 2; s <= 3600; s++) h.tick(s)
  assert.equal(h.value('sw.onTime'), 3600)
  // Across midnight the new day starts from zero and carries on.
  for (let s = 3601; s <= 12 * 3600 + 120; s++) h.tick(s)
  assert.equal(h.value('sw.onTime'), 120)
  h.input(12 * 3600 + 150, 'sw.state', false)
  for (let s = 12 * 3600 + 121; s <= 12 * 3600 + 400; s++) h.tick(s)
  assert.equal(h.value('sw.onTime'), 150)
})

test('a regularly sampled input is not extended between readings', () => {
  const h = harness(integration({ staleTimeout: 60 }))
  h.input(0, 'p.power', 100)
  h.tick(0)
  for (let s = 1; s <= 30; s++) h.tick(s)
  // Nothing is added until the next reading closes the stretch.
  assert.equal(h.value('p.energy'), 0)
  h.input(31, 'p.power', 100)
  h.tick(31)
  assert.equal(h.value('p.energy'), 3100)
})

test('published numbers carry no binary rounding noise', () => {
  const h = harness({ formulas: [{ inputs: [{ name: 'i', path: 'a.i' }, { name: 'v', path: 'a.v' }], expression: 'i * v', output: 'a.p' }] })
  h.input(0, 'a.i', 10.86)
  h.input(0, 'a.v', 26.36)
  assert.equal(10.86 * 26.36, 286.26959999999997)
  assert.deepEqual(h.tick(0), [{ path: 'a.p', value: 286.2696 }])
})

test('a null breaks the chain of values instead of being read as zero', () => {
  const h = harness(integration({ staleTimeout: 0 }))
  h.input(0, 'p.power', 100)
  h.input(10, 'p.power', 100)
  h.input(20, 'p.power', null)
  h.input(30, 'p.power', 100)
  h.input(40, 'p.power', 100)
  h.tick(40)
  assert.equal(h.value('p.energy'), 2000)
})

// ------------------------------------------------------------------ chaining

test('entries feed each other in dependency order', () => {
  const h = harness({
    formulas: [
      // Listed before the entries it depends on, on purpose.
      { inputs: [{ name: 'e', path: 'c.energy' }], expression: 'e / 3600', output: 'c.energyWh' },
      { inputs: [{ name: 'i', path: 'c.current' }, { name: 'v', path: 'c.voltage' }], expression: 'i * v', output: 'c.power' }
    ],
    integrations: [{ input: 'c.power', output: 'c.energy' }]
  })
  assert.deepEqual(h.engine.externalPaths, ['c.current', 'c.voltage'])
  for (let s = 0; s <= 3600; s += 2) {
    h.input(s, 'c.voltage', 24)
    h.input(s, 'c.current', 10)
  }
  h.tick(3600)
  assert.equal(h.value('c.power'), 240)
  assert.equal(h.value('c.energy'), 240 * 3600)
  assert.equal(h.value('c.energyWh'), 240)
})

test('a stale source makes everything downstream stale too', () => {
  const h = harness({
    formulas: [{ inputs: [{ name: 'x', path: 'd.raw' }], expression: 'x * 2', output: 'd.double', staleTimeout: 30 }],
    integrations: [{ input: 'd.double', output: 'd.sum', staleTimeout: 30 }]
  })
  h.input(0, 'd.raw', 1)
  h.input(10, 'd.raw', 1)
  h.tick(10)
  assert.equal(h.state('d.sum', 10).state, 'ok')
  assert.equal(h.state('d.double', 100).state, 'stale')
  assert.equal(h.state('d.sum', 100).state, 'stale')
  assert.deepEqual(h.tick(100), [])
})

// ------------------------------------------------------ restarts and storage

test('totals survive a restart', () => {
  const options = { counters: [{ input: 'm.total', output: 'm.today' }], integrations: [{ input: 'p.power', output: 'p.energy' }] }
  const first = harness(options)
  first.input(0, 'm.total', 1000)
  first.input(0, 'p.power', 100)
  first.input(60, 'm.total', 1050)
  first.input(60, 'p.power', 100)
  first.tick(60)
  const saved = first.save(60)

  // The plugin is down for ten minutes; the source counter moves on by 25.
  const second = harness(options, saved, NOON + 660000)
  assert.deepEqual(second.tick(0), [])
  assert.equal(second.state('m.today', 0).state, 'waiting')
  second.input(1, 'm.total', 1075)
  second.input(1, 'p.power', 100)
  second.tick(1)
  // The counter picks up what the source counted during the downtime.
  assert.equal(second.value('m.today'), 75)
  // The integration adds nothing for the downtime.
  assert.equal(second.value('p.energy'), 6000)
  second.input(11, 'p.power', 100)
  second.tick(11)
  assert.equal(second.value('p.energy'), 7000)
  assert.equal(second.state('m.today', 11).since, '2026-10-09T12:00:00.000Z')
})

test('a boundary that passes during downtime starts a new period with a note', () => {
  const options = counter({ staleTimeout: 0 })
  const first = harness(options)
  first.input(0, 'm.total', 1000)
  first.input(3600, 'm.total', 1200)
  first.tick(3600)
  const saved = first.save(3600)

  // Back up the next morning at 06:00; the source gained 40 overnight.
  const second = harness(options, saved, NOON + 18 * 3600000)
  second.input(0, 'm.total', 1240)
  second.tick(0)
  assert.equal(second.value('m.today'), 40)
  const state = second.state('m.today', 0)
  assert.equal(state.since, '2026-10-10T00:00:00.000Z')
  assert.match(state.message, /while the plugin was not running/)
  // The note clears at the next boundary seen live.
  second.input(18 * 3600 + 5, 'm.total', 1300)
  second.tick(18 * 3600 + 5)
  assert.equal(second.state('m.today', 18 * 3600 + 5).message, '')
})

test('a reset of the followed path during downtime is caught on restart', () => {
  const options = { counters: [{ input: 'm.total', output: 'm.today', resets: 'path', resetPath: 'ref.today', staleTimeout: 0 }] }
  const first = harness(options)
  first.input(0, 'ref.today', 900)
  first.input(0, 'm.total', 1000)
  first.input(10, 'm.total', 1200)
  first.tick(10)
  const second = harness(options, first.save(10), NOON + DAY)
  second.input(0, 'ref.today', 20)
  second.input(1, 'm.total', 1210)
  second.tick(1)
  assert.equal(second.value('m.today'), 10)
})

test('saved totals are dropped when the entry now measures something else', () => {
  const first = harness(counter())
  first.input(0, 'm.total', 1000)
  first.input(10, 'm.total', 1500)
  const saved = first.save(10)

  const sameInput = harness(counter({ name: 'Renamed', staleTimeout: 5 }), saved, NOON + 60000)
  sameInput.input(0, 'm.total', 1500)
  sameInput.tick(0)
  assert.equal(sameInput.value('m.today'), 500)

  const otherInput = harness({ counters: [{ input: 'other.total', output: 'm.today' }] }, saved, NOON + 60000)
  otherInput.input(0, 'other.total', 7)
  otherInput.tick(0)
  assert.equal(otherInput.value('m.today'), 0)
})

test('only current entries are saved, and a disabled entry keeps its total', () => {
  const both = { counters: [{ input: 'a.total', output: 'a.today' }, { input: 'b.total', output: 'b.today' }] }
  const first = harness(both)
  first.input(0, 'a.total', 1)
  first.input(0, 'b.total', 1)
  first.input(10, 'a.total', 6)
  first.input(10, 'b.total', 9)
  const saved = first.save(10)
  assert.deepEqual(Object.keys(saved.entries).sort(), ['a.today', 'b.today'])

  // b is switched off: its total is kept. a is removed: its total goes.
  const second = harness({ counters: [{ input: 'b.total', output: 'b.today', enabled: false }] }, saved, NOON + 60000)
  const resaved = second.save(0)
  assert.deepEqual(Object.keys(resaved.entries), ['b.today'])
  assert.equal(resaved.entries['b.today'].total, 8)
})

test('a value known before start-up is aged correctly and counted from the start', () => {
  const h = harness({
    formulas: [{ inputs: [{ name: 'x', path: 'f.x' }], expression: 'x', output: 'f.copy', staleTimeout: 60 }],
    integrations: [{ input: 'sw.state', output: 'sw.onTime', mode: 'time', staleTimeout: 0, resets: 'manual' }]
  })
  // At start-up (t = 1000 s) the server holds a switch state that is two
  // hours old and a reading that is ten minutes old.
  h.engine.input('sw.state', true, NOON + 1000000, 1000000 - 7200000, 1000000)
  h.engine.input('f.x', 5, NOON + 1000000, 1000000 - 600000, 1000000)
  h.tick(1000)
  // The old reading is already stale.
  assert.equal(h.state('f.copy', 1000).state, 'stale')
  // The switch has been on for two hours, but only time since the start is
  // added up.
  h.input(1300, 'sw.state', false)
  h.tick(1300)
  assert.equal(h.value('sw.onTime'), 300)
})

// -------------------------------------------------------------------- clocks

test('an unset system clock pauses period resets but not counting', () => {
  const options = { counters: [{ input: 'm.total', output: 'm.today', staleTimeout: 0 }], integrations: [{ input: 'p.power', output: 'p.energy', staleTimeout: 0 }] }
  const first = harness(options)
  first.input(0, 'm.total', 1000)
  first.input(0, 'p.power', 100)
  first.input(100, 'm.total', 1300)
  first.input(100, 'p.power', 100)
  first.tick(100)
  const saved = first.save(100)

  // The computer restarts with its clock at 1 January 1970.
  const normalized = normalizeConfig({ timeZone: 'UTC', ...options })
  const engine = new Engine(normalized, saved)
  const published = {}
  const tick = (wall, mono) => { for (const p of engine.tick(wall, mono)) published[p.path] = p.value }
  engine.input('m.total', 1310, 5000, 5000)
  engine.input('p.power', 100, 5000, 5000)
  engine.input('m.total', 1320, 15000, 15000)
  engine.input('p.power', 100, 15000, 15000)
  tick(15000, 15000)
  assert.equal(engine.clockSuspect, true)
  // Nothing was reset, and both totals kept growing.
  assert.equal(published['m.today'], 320)
  assert.equal(published['p.energy'], 11000)

  // The clock is set: same day, 13:00.
  const now = NOON + 3600000
  engine.input('m.total', 1330, now, 25000)
  engine.input('p.power', 100, now, 25000)
  tick(now, 25000)
  assert.equal(engine.clockSuspect, false)
  assert.equal(published['m.today'], 330)
  assert.equal(published['p.energy'], 12000)

  // The wrong clock was never written into the saved state.
  assert.equal(engine.serialize(now).savedAt, now)
})

test('a clock that stays behind the saved time is accepted after an hour', () => {
  const options = counter({ staleTimeout: 0 })
  const first = harness(options)
  first.input(0, 'm.total', 1)
  // The state was saved by a clock that ran a year ahead.
  const saved = first.save(0)
  saved.savedAt = NOON + 365 * DAY
  saved.entries['m.today'].periodStart = NOON + 365 * DAY - 12 * 3600000

  const engine = new Engine(normalizeConfig({ timeZone: 'UTC', ...options }), saved)
  engine.tick(NOON, 0)
  assert.equal(engine.clockSuspect, true)
  engine.tick(NOON + 3500000, 3500000)
  assert.equal(engine.clockSuspect, true)
  engine.tick(NOON + 3700000, 3700000)
  assert.equal(engine.clockSuspect, false)
  // The total was kept, and the next real midnight resets as usual.
  engine.input('m.total', 11, NOON + 3800000, 3800000)
  assert.equal(engine.tick(NOON + 3800000, 3800000)[0].value, 10)
  assert.equal(engine.tick(NOON + 12 * 3600000, 12 * 3600000)[0].value, 0)
})

// ------------------------------------------------------------------- summary

test('the summary and snapshot describe every entry', () => {
  const normalized = normalizeConfig({
    timeZone: 'UTC',
    formulas: [{ name: 'Power', inputs: [{ name: 'i', path: 'a.i' }], expression: 'i * 24', output: 'a.power', unit: 'W' }, { inputs: [], expression: 'x', output: 'bad.formula' }],
    counters: [{ input: 'm.total', output: 'm.today', enabled: false }, { input: 'n.total', output: 'n.today', resets: 'path', resetPath: 'n.ref' }]
  })
  const engine = new Engine(normalized, null)
  engine.input('a.i', 2, NOON, 0)
  engine.tick(NOON, 0)
  assert.deepEqual(engine.summary(0), { ok: 1, waiting: 1, stale: 0, error: 1, disabled: 1 })
  assert.deepEqual(engine.externalPaths, ['a.i', 'n.ref', 'n.total'])

  const [power, bad, disabled, following] = engine.snapshot(NOON, 0)
  assert.deepEqual(
    { id: power.id, name: power.name, type: power.type, unit: power.unit, value: power.value, state: power.state, canReset: power.canReset, expression: power.expression },
    { id: 'a.power', name: 'Power', type: 'formula', unit: 'W', value: 48, state: 'ok', canReset: false, expression: 'i * 24' }
  )
  assert.equal(bad.state, 'error')
  assert.equal(bad.canReset, false)
  assert.equal(disabled.state, 'disabled')
  assert.equal(disabled.canReset, false)
  assert.equal(following.state, 'waiting')
  assert.equal(following.resets, 'path')
  assert.equal(following.resetPath, 'n.ref')
  assert.equal(following.canReset, true)
})
