'use strict'

/*
 * Tests of the defects fixed in version 0.6.1 in the engine, the formula
 * check and the zone names, and of behaviours a mutation run showed to be
 * untested.
 */

const assert = require('node:assert/strict')
const { test } = require('node:test')

const { normalizeConfig } = require('../lib/config')
const { Engine, toNumber } = require('../lib/engine')
const { availableFunctions, checkName, compileFormula } = require('../lib/formula')
const { canonicalTimeZone, periodInfo } = require('../lib/periods')
const { zoneFromValue } = require('../lib/timezone')

const NOON = Date.parse('2026-10-09T12:00:00Z')
const DAY = 86400000

/**
 * Runs an engine over a list of entries. Time is given in seconds after
 * `base` and drives both clocks together, as in normal running.
 */
function harness (entries, { saved = null, base = NOON, settings = {} } = {}) {
  const normalized = normalizeConfig({ timeZone: 'UTC', ...settings }, { version: 1, groups: [], entries })
  for (const entry of normalized.entries) assert.equal(entry.error, null, `${entry.label}: ${entry.error}`)
  const engine = new Engine(normalized, saved)
  const values = {}
  const log = []
  const at = (seconds) => [base + seconds * 1000, seconds * 1000]
  return {
    engine,
    normalized,
    log,
    input: (seconds, path, value) => engine.input(path, value, ...at(seconds)),
    tick (seconds) {
      const published = engine.tick(...at(seconds))
      for (const { path, value } of published) {
        values[path] = value
        log.push({ seconds, path, value })
      }
      return published
    },
    value: (path) => values[path],
    save: (seconds) => JSON.parse(JSON.stringify(engine.serialize(base + seconds * 1000))),
    state: (output, seconds) => engine.snapshot(...at(seconds)).find((e) => e.output === output)
  }
}

const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`)

// ------------------------------------------- 1. an entry read by another

// A generator's running time: a switch sent only when it changes, summed
// with a stale timeout of zero, and shown in hours by a formula with the
// default stale timeout.
const runningTime = [
  { id: 'i', type: 'integration', input: 'gen.on', mode: 'rate', staleTimeout: 0, resets: 'day', output: 'gen.secondsToday' },
  { id: 'f', type: 'formula', inputs: [{ name: 's', path: 'gen.secondsToday' }], expression: 's / 3600', output: 'gen.hoursToday' }
]

test('a formula that reads a total that stops changing stays fresh while the total is published', () => {
  const h = harness(runningTime)
  h.input(0, 'gen.on', true)
  for (let s = 0; s <= 100; s++) h.tick(s)
  h.input(100, 'gen.on', false)
  for (let s = 100; s <= 300; s++) h.tick(s)
  assert.equal(h.state('gen.secondsToday', 300).state, 'ok')
  assert.equal(h.state('gen.hoursToday', 300).state, 'ok')
  near(h.value('gen.hoursToday'), 100 / 3600)
  // No null went out on the formula's path.
  assert.ok(!h.log.some((p) => p.path === 'gen.hoursToday' && p.value === null), JSON.stringify(h.log.filter((p) => p.value === null)))
})

test('a formula input with a value when stale is read as it is while its producer publishes', () => {
  const h = harness([
    runningTime[0],
    { id: 'f', type: 'formula', inputs: [{ name: 's', path: 'gen.secondsToday', whenStale: -1 }], expression: 's / 3600', output: 'gen.hoursToday' }
  ])
  h.input(0, 'gen.on', true)
  for (let s = 0; s <= 100; s++) h.tick(s)
  h.input(100, 'gen.on', false)
  for (let s = 100; s <= 300; s++) h.tick(s)
  const formula = h.state('gen.hoursToday', 300)
  assert.deepEqual(formula.substituted, [])
  near(formula.value, 100 / 3600)
})

test('a counter that reads a formula over a held input stays fresh while the formula publishes', () => {
  const h = harness([
    { id: 'f', type: 'formula', inputs: [{ name: 'x', path: 'tank.raw' }], expression: 'x * 2', output: 'tank.level', staleTimeout: 0 },
    { id: 'c', type: 'counter', input: 'tank.level', resets: 'manual', output: 'tank.used', direction: 'decrease' }
  ])
  h.input(0, 'tank.raw', 50)
  h.tick(0)
  h.input(10, 'tank.raw', 40)
  for (let s = 10; s <= 300; s++) h.tick(s)
  const counter = h.state('tank.used', 300)
  assert.equal(counter.state, 'ok', counter.message)
  assert.equal(h.value('tank.used'), 20)
})

test('an integration over a formula that is quiet keeps adding while the formula publishes', () => {
  const h = harness([
    { id: 'f', type: 'formula', inputs: [{ name: 'on', path: 'pump.on' }], expression: 'on * 100', output: 'pump.power', staleTimeout: 0 },
    { id: 'i', type: 'integration', input: 'pump.power', resets: 'manual', output: 'pump.energy' }
  ])
  h.input(0, 'pump.on', true)
  for (let s = 0; s <= 300; s++) h.tick(s)
  const energy = h.state('pump.energy', 300)
  assert.equal(energy.state, 'ok', energy.message)
  near(h.value('pump.energy'), 100 * 300)
  // Switched off: the total stops growing but stays fresh.
  h.input(300, 'pump.on', false)
  for (let s = 300; s <= 600; s++) h.tick(s)
  near(h.value('pump.energy'), 100 * 300)
  assert.equal(h.state('pump.energy', 600).state, 'ok')
})

test('an integration over a formula still leaves out a gap while the formula is stale', () => {
  // The formula itself has a stale timeout, and keeps publishing its last
  // result when stale; the integration must not sum across that.
  const h = harness([
    { id: 'f', type: 'formula', inputs: [{ name: 'p', path: 'pump.raw' }], expression: 'p', output: 'pump.power', staleTimeout: 30, onStale: 'hold' },
    { id: 'i', type: 'integration', input: 'pump.power', resets: 'manual', output: 'pump.energy', staleTimeout: 60 }
  ])
  h.input(0, 'pump.raw', 100)
  for (let s = 0; s <= 200; s++) h.tick(s)
  h.input(200, 'pump.raw', 100)
  h.tick(200)
  assert.equal(h.value('pump.energy'), 0)
})

test('an integration that carried a quiet formula on stops at the moment the formula goes stale', () => {
  const h = harness([
    { id: 'f', type: 'formula', inputs: [{ name: 'p', path: 'pump.raw' }], expression: 'p', output: 'pump.power', staleTimeout: 100, onStale: 'hold' },
    { id: 'i', type: 'integration', input: 'pump.power', resets: 'manual', output: 'pump.energy', staleTimeout: 60 }
  ])
  h.input(0, 'pump.raw', 100)
  for (let s = 0; s <= 150; s++) h.tick(s)
  near(h.value('pump.energy'), 100 * 100)
  // Stale itself a stale timeout later, and nothing more was added.
  for (let s = 151; s <= 300; s++) h.tick(s)
  assert.equal(h.value('pump.energy'), null)
  // The stretch while the formula was stale is a gap.
  h.input(300, 'pump.raw', 100)
  h.tick(300)
  near(h.value('pump.energy'), 100 * 100)
})

test('a cycles entry over a formula of a held switch counts its cycles', () => {
  const h = harness([
    { id: 'f', type: 'formula', inputs: [{ name: 'x', path: 'sw.raw' }], expression: 'x', output: 'sw.copy', staleTimeout: 0 },
    { id: 'c', type: 'cycles', inputs: [{ path: 'sw.copy', kind: 'onoff', threshold: 0.5 }], statistic: 'onMedian', output: 'sw.onTime', minCycles: 2, shortest: 30 }
  ])
  // Ten minutes on, twenty off; the switch sends only when it changes.
  for (let s = 0; s <= 3 * 3600; s++) {
    if (s % 1800 === 0) h.input(s, 'sw.raw', 1)
    if (s % 1800 === 600) h.input(s, 'sw.raw', 0)
    h.tick(s)
  }
  const cycles = h.state('sw.onTime', 3 * 3600)
  assert.equal(cycles.state, 'ok', cycles.message)
  assert.equal(cycles.value, 600)
})

test('a reader still goes stale when the entry it reads stops publishing', () => {
  const h = harness([
    { id: 'f', type: 'formula', inputs: [{ name: 'x', path: 'a.x' }], expression: 'x', output: 'a.copy', staleTimeout: 30 },
    { id: 'g', type: 'formula', inputs: [{ name: 'c', path: 'a.copy' }], expression: 'c * 2', output: 'a.double', staleTimeout: 60 }
  ])
  h.input(0, 'a.x', 1)
  for (let s = 0; s <= 100; s++) h.tick(s)
  assert.equal(h.state('a.copy', 100).state, 'stale')
  assert.equal(h.state('a.double', 100).state, 'waiting')
  assert.equal(h.value('a.double'), null)
})

// ------------------------------------------------- 5. formula names

test('a formula may name only its inputs, the documented functions and the constants', () => {
  for (const expression of ['toString(1)', 'constructor(a)', 'valueOf(a)', 'isPrototypeOf(a)', 'hasOwnProperty(a)', 'a + toString(a)', 'max(a, valueOf(a))', 'a ? toString(a) : 1']) {
    assert.throws(() => compileFormula(expression, ['a']), /is not an input or a built-in function/, expression)
  }
  // Every documented function still compiles and gives a number.
  for (const name of availableFunctions()) {
    const args = name === 'if' ? 'a, 1, 2' : ['atan2', 'hypot', 'max', 'min', 'pow', 'pyt', 'roundTo'].includes(name) ? 'a, 2' : 'a'
    const formula = compileFormula(`${name}(${args})`, ['a'])
    // atanh needs a value below 1 and acosh one above it.
    assert.ok([0.5, 1.5].some((a) => typeof formula.evaluate({ a }) === 'number'), name)
  }
  assert.equal(compileFormula('not a', ['a']).evaluate({ a: 0 }), 1)
  assert.equal(compileFormula('abs a', ['a']).evaluate({ a: -2 }), 2)
  assert.equal(compileFormula('a > 1 and a < 3 or PI > E', ['a']).evaluate({ a: 5 }), 1)
  assert.equal(compileFormula('a == 2 ? -a : a % 2', ['a']).evaluate({ a: 2 }), -2)
  assert.equal(compileFormula('true + false', ['a']).evaluate({ a: 1 }), 1)
  // A semicolon, accepted by earlier versions, still separates statements.
  assert.equal(compileFormula('a; a * 2', ['a']).evaluate({ a: 3 }), 6)
  assert.equal(compileFormula('; a', ['a']).evaluate({ a: 3 }), 3)
})

test('the rule for short names is stated as it is applied', () => {
  assert.match(checkName('9a'), /not starting with a digit/)
  assert.equal(checkName('_a'), null)
  assert.match(checkName('__a'), /may not start with two underscores/)
  assert.match(checkName('max'), /built-in name/)
})

// ---------------------------------------------------- 6. zone names

test('a zone name in any letter case is one zone', () => {
  const variants = ['asia/kathmandu', 'ASIA/KATHMANDU', 'Asia/kathmandu', 'aSiA/KaThMaNdU']
  const spellings = new Set(variants.map(canonicalTimeZone))
  assert.equal(spellings.size, 1)
  assert.ok(['Asia/Kathmandu', 'Asia/Katmandu'].includes([...spellings][0]))
  for (const [a, b] of [['europe/athens', 'Europe/Athens'], ['america/new_york', 'America/New_York'], ['europe/kiev', 'Europe/Kiev'], ['etc/gmt+5', 'Etc/GMT+5']]) {
    assert.equal(canonicalTimeZone(a), canonicalTimeZone(b), a)
  }
  // A name the runtime files under another one is kept as chosen.
  for (const name of ['US/Pacific', 'EST', 'CET', 'Asia/Calcutta']) assert.equal(canonicalTimeZone(name), name)
  assert.equal(zoneFromValue('asia/KATHMANDU'), canonicalTimeZone('Asia/Kathmandu'))
  // The day is worked out the same in every spelling.
  const instant = Date.parse('2026-10-09T20:00:00Z')
  assert.equal(periodInfo(instant, 'day', { timeZone: canonicalTimeZone('ASIA/KATHMANDU') }).key, '2026-10-10')
})

test('a saved period dated in a zone spelt another way is in the zone in use', () => {
  const entries = [{ id: 'c', type: 'counter', input: 'm.total', output: 'm.today', staleTimeout: 0 }]
  const first = harness(entries, { settings: { timeZone: 'Europe/Athens' } })
  first.input(0, 'm.total', 1)
  const saved = first.save(0)
  saved.entries['m.today'].periodZone = 'europe/athens'
  const second = harness(entries, { saved, settings: { timeZone: 'Europe/Athens' } })
  assert.equal(second.engine.entries[0].periodZone, 'Europe/Athens')
})

// ------------------------------------------ 7. a total too large to hold

test('a total that would overflow keeps its value and leaves the addition out', () => {
  const h = harness([{ id: 'c', type: 'counter', input: 'm.total', output: 'm.sum', resets: 'manual', staleTimeout: 0 }])
  h.input(0, 'm.total', 0)
  h.input(1, 'm.total', 1e308)
  h.input(2, 'm.total', 0)
  h.input(3, 'm.total', 1.5e308)
  h.tick(3)
  assert.equal(h.value('m.sum'), 1e308)
  assert.equal(h.state('m.sum', 3).lastReset, null)
  assert.match(h.state('m.sum', 3).message, /left out/)
})

// ------------------------------------------- 8. sending again what failed

test('values the host failed to send go out again on the next tick', () => {
  const h = harness([
    { id: 'f', type: 'formula', inputs: [{ name: 'x', path: 'a.x' }], expression: 'x * 2', output: 'a.double', staleTimeout: 30 },
    { id: 'g', type: 'formula', inputs: [{ name: 'y', path: 'a.y' }], expression: 'y', output: 'a.copy', staleTimeout: 0 }
  ], { settings: { repeatInterval: 0 } })
  h.input(0, 'a.x', 1)
  h.input(0, 'a.y', 5)
  const first = h.tick(0)
  assert.deepEqual(first, [{ path: 'a.double', value: 2 }, { path: 'a.copy', value: 5 }])
  h.engine.republish(first)
  assert.deepEqual(h.tick(1), first)
  assert.deepEqual(h.tick(2), [])

  // A null that failed is owed again too.
  const stale = h.tick(31)
  assert.deepEqual(stale, [{ path: 'a.double', value: null }])
  assert.equal(h.state('a.double', 31).message.includes('Null was sent'), true)
  h.engine.republish(stale)
  assert.equal(h.engine.entries[0].nullSent, false)
  assert.deepEqual(h.tick(32), stale)
  assert.equal(h.engine.entries[0].nullSent, true)
  assert.deepEqual(h.tick(33), [])
})

test('a null for a path no entry publishes any more is owed again when it failed', () => {
  const h = harness([{ id: 'g', type: 'formula', inputs: [{ name: 'y', path: 'a.y' }], expression: 'y', output: 'a.copy', staleTimeout: 0 }])
  h.input(0, 'a.y', 5)
  h.tick(0)
  const edited = normalizeConfig({ timeZone: 'UTC' }, { version: 1, groups: [], entries: [{ id: 'g', type: 'formula', inputs: [{ name: 'y', path: 'a.y' }], expression: 'y', output: 'a.other', staleTimeout: 0 }] })
  const engine = new Engine(edited, h.engine.serialize(NOON), undefined, h.engine)
  engine.prime(NOON + 1000, 1000)
  const sent = engine.tick(NOON + 1000, 1000)
  assert.deepEqual(sent, [{ path: 'a.other', value: 5 }, { path: 'a.copy', value: null }])
  engine.republish(sent)
  assert.deepEqual(engine.tick(NOON + 2000, 2000), sent)
  assert.deepEqual(engine.tick(NOON + 3000, 3000), [])
  // Anything that is not a publication of this engine is ignored.
  engine.republish([null, {}, { path: 'not.ours', value: 1 }, { path: 'a.other', value: 'x' }])
  engine.republish(undefined)
  assert.deepEqual(engine.tick(NOON + 4000, 4000), [])
})

// ------------------------------------- 9. behaviours the mutation run found

test('an entry is stale only once its input is older than the stale timeout', () => {
  const h = harness([{ id: 'c', type: 'counter', input: 'm.total', output: 'm.sum', resets: 'manual', staleTimeout: 30 }])
  h.input(0, 'm.total', 1)
  h.tick(0)
  assert.equal(h.state('m.sum', 30).state, 'ok')
  assert.equal(h.state('m.sum', 30.001).state, 'stale')
})

test('a step of exactly the smallest step is counted', () => {
  const h = harness([{ id: 'c', type: 'counter', input: 'm.total', output: 'm.sum', resets: 'manual', staleTimeout: 0, minStep: 5 }])
  h.input(0, 'm.total', 100)
  h.input(1, 'm.total', 104)
  h.input(2, 'm.total', 105)
  h.tick(2)
  assert.equal(h.value('m.sum'), 5)
})

test('a counter fed null or a number that is not finite ignores it', () => {
  assert.equal(toNumber(Infinity), null)
  assert.equal(toNumber(-Infinity), null)
  assert.equal(toNumber(NaN), null)
  assert.equal(toNumber(-0.5), -0.5)
  const h = harness([{ id: 'c', type: 'counter', input: 'm.total', output: 'm.sum', resets: 'manual', staleTimeout: 0 }])
  h.input(0, 'm.total', 10)
  h.input(1, 'm.total', null)
  h.input(2, 'm.total', 12)
  h.input(3, 'm.total', Infinity)
  h.input(4, 'm.total', 15)
  h.tick(4)
  assert.equal(h.value('m.sum'), 5)
})

test('a formula with a stale timeout of zero never counts an input as stale', () => {
  const h = harness([{ id: 'f', type: 'formula', inputs: [{ name: 'x', path: 'a.x', whenStale: 0 }, { name: 'y', path: 'a.y' }], expression: 'x + y', output: 'a.sum', staleTimeout: 0 }])
  h.input(0, 'a.x', 3)
  h.input(0, 'a.y', 4)
  for (let s = 0; s <= 7200; s += 60) h.tick(s)
  const formula = h.state('a.sum', 7200)
  assert.equal(formula.state, 'ok')
  assert.deepEqual(formula.substituted, [])
  assert.equal(h.value('a.sum'), 7)
})

test('a value held at start-up is summed from the start, and kept up to exactly the stale timeout', () => {
  for (const [age, expected] of [[20, 100], [60, 100], [61, 0]]) {
    const h = harness([{ id: 'i', type: 'integration', input: 'p.w', output: 'p.energy', resets: 'manual', staleTimeout: 60 }])
    // The value was published `age` seconds before the start.
    h.engine.input('p.w', 10, NOON - age * 1000, -age * 1000, 0)
    h.input(10, 'p.w', 10)
    h.tick(10)
    assert.equal(h.value('p.energy'), expected, `aged ${age} s`)
  }
})

test('kept totals of entries no longer there are dated and dropped only by a trusted clock', () => {
  const entries = [{ id: 'c', type: 'counter', input: 'm.total', output: 'm.today', staleTimeout: 0 }]
  const record = { signature: 'counter|x.total|increase', resets: 'day', total: 42, since: NOON - DAY }
  // Undated, and the clock not yet set.
  const undated = harness(entries, { saved: { entries: { 'x.today': { ...record } } } })
  undated.engine.tick(Date.UTC(1970, 0, 2), 0)
  assert.equal(undated.engine.clockSuspect, true)
  const early = undated.engine.serialize(Date.UTC(1970, 0, 2))
  assert.equal(early.entries['x.today'].orphanedAt, null)
  undated.engine.tick(NOON + 40 * DAY, 1000)
  const later = undated.engine.serialize(NOON + 40 * DAY)
  assert.equal(later.entries['x.today'].orphanedAt, NOON + 40 * DAY)
  // Dated long ago, read while the clock is behind the saved time.
  const saved = { savedAt: NOON + 40 * DAY, entries: { 'x.today': { ...record, orphanedAt: NOON - 40 * DAY } } }
  const suspect = harness(entries, { saved })
  suspect.tick(0)
  assert.equal(suspect.engine.clockSuspect, true)
  assert.equal(suspect.save(0).entries['x.today'].total, 42)
})

test('a period dated up to 27 hours ahead in another zone is held over; one further ahead is pulled back', () => {
  const entries = [{ id: 'c', type: 'counter', input: 'm.total', output: 'm.today', staleTimeout: 0 }]
  const begins = Date.parse('2026-10-11T00:00:00Z')
  for (const [ahead, held] of [[27 * 3600000, true], [27 * 3600000 + 1000, false]]) {
    const wall = begins - ahead
    const first = harness(entries)
    first.input(0, 'm.total', 1)
    const saved = first.save(0)
    Object.assign(saved.entries['m.today'], { total: 5, periodKey: '2026-10-11', periodZone: 'Pacific/Kiritimati', periodStart: Date.parse('2026-10-10T10:00:00Z') })
    saved.savedAt = wall
    const engine = new Engine(first.normalized, saved)
    engine.tick(wall, 0)
    const entry = engine.entries[0]
    assert.equal(entry.heldOver, held, `${ahead / 3600000} h`)
    assert.equal(entry.periodKey, held ? '2026-10-11' : '2026-10-09')
    assert.equal(entry.total, 5)
  }
})

// ------------------------------------------- numbers that are not numbers

test('a numeric setting that is not a number is a fault on its field, not 0 or the default', () => {
  const check = (entry) => {
    const built = normalizeConfig({}, { version: 1, groups: [], entries: [{ id: 'e', output: 'a.b', ...entry }] }).entries[0]
    return built.faults
  }
  const fields = (entry) => check(entry).map((f) => f.field)
  assert.deepEqual(fields({ type: 'integration', input: 'a.x', mode: 'time', threshold: '1.234,5' }), ['threshold'])
  assert.match(check({ type: 'integration', input: 'a.x', mode: 'time', threshold: '1.234,5' })[0].text, /"1\.234,5" is not a number/)
  // In rate mode the threshold is not used, and the editor hides it.
  assert.deepEqual(fields({ type: 'integration', input: 'a.x', threshold: '1.234,5' }), [])
  // A decimal comma is read as the point, as the editor reads it, and as
  // text saved by earlier versions holds it; a comma before three digits
  // could separate thousands and is refused with a hint.
  assert.deepEqual(fields({ type: 'integration', input: 'a.x', staleTimeout: '1,5' }), [])
  assert.equal(normalizeConfig({}, { version: 1, groups: [], entries: [{ id: 'e', output: 'a.b', type: 'integration', input: 'a.x', staleTimeout: '1,5' }] }).entries[0].staleMs, 1500)
  assert.deepEqual(fields({ type: 'integration', input: 'a.x', staleTimeout: '1,500' }), ['staleTimeout'])
  assert.match(check({ type: 'integration', input: 'a.x', staleTimeout: '1,500' })[0].text, /three digits could separate thousands/)
  assert.deepEqual(fields({ type: 'counter', input: 'a.x', minStep: 'five' }), ['minStep'])
  assert.deepEqual(fields({ type: 'formula', inputs: [{ name: 'x', path: 'a.x' }], expression: 'x', staleTimeout: true }), ['staleTimeout'])
  const cycles = { type: 'cycles', inputs: [{ path: 'a.x', kind: 'onoff' }] }
  for (const field of ['window', 'minCycles', 'shortest', 'longest', 'staleTimeout']) {
    assert.deepEqual(fields({ ...cycles, [field]: '2h' }), [field], field)
  }
  // The smoothing applies to wave inputs only, and the editor hides it otherwise.
  assert.deepEqual(fields({ ...cycles, smoothing: '2h' }), [])
  assert.deepEqual(fields({ ...cycles, inputs: [{ path: 'a.x', kind: 'wave', swing: 1 }], smoothing: '2h' }), ['smoothing'])
  assert.deepEqual(fields({ ...cycles, inputs: [{ path: 'a.x', kind: 'onoff', threshold: 'x' }] }), ['inputs.0.threshold'])
  assert.deepEqual(fields({ ...cycles, inputs: [{ path: 'a.x', kind: 'wave', swing: '0,1' }] }), [])
  assert.deepEqual(fields({ ...cycles, inputs: [{ path: 'a.x', kind: 'wave', swing: '0;1' }] }), ['inputs.0.swing'])
  assert.match(check({ ...cycles, inputs: [{ path: 'a.x', kind: 'wave', swing: '0;1' }] })[0].text, /"0;1" is not a number/)
  // An emptied field still means the default, and a number in text is read.
  for (const empty of [null, undefined, '', '  ']) {
    const built = normalizeConfig({ repeatInterval: empty }, { version: 1, groups: [], entries: [{ id: 'e', type: 'integration', input: 'a.x', output: 'a.b', staleTimeout: empty, threshold: empty }] })
    assert.deepEqual(built.entries[0].faults, [], String(empty))
    assert.equal(built.entries[0].staleMs, 60000)
    assert.equal(built.entries[0].threshold, 0)
    assert.equal(built.settings.repeatMs, 10000)
    assert.deepEqual(built.problems, [])
  }
  assert.equal(normalizeConfig({}, { version: 1, groups: [], entries: [{ id: 'e', type: 'integration', input: 'a.x', output: 'a.b', staleTimeout: ' 30 ', threshold: '-2.5' }] }).entries[0].staleMs, 30000)
  // The repeat interval is a setting of the plugin: it is reported, and the
  // default used.
  const settings = normalizeConfig({ repeatInterval: '10s' })
  assert.equal(settings.settings.repeatMs, 10000)
  assert.deepEqual(settings.problems, ['"10s" is not a number for the repeat interval; using 10 s'])
})

test('a long chain of entries over a held input is checked in linear time', () => {
  // Each formula reads the one before; the first reads a switch sent only
  // when it changes. Freshness is asked down the chain at every pass, and
  // must not double at every link.
  const entries = [{ id: 'f0', type: 'formula', inputs: [{ name: 'x', path: 'sw.state' }], expression: 'x', output: 'chain.f0', staleTimeout: 0 }]
  for (let i = 1; i < 60; i++) {
    entries.push({ id: `f${i}`, type: 'formula', inputs: [{ name: 'x', path: `chain.f${i - 1}` }], expression: 'x + 1', output: `chain.f${i}`, staleTimeout: 30 })
  }
  const engine = new Engine(normalizeConfig({ timeZone: 'UTC' }, { version: 1, groups: [], entries }), null)
  const T = Date.parse('2026-10-23T12:00:00Z')
  engine.input('sw.state', 1, T, 0)
  engine.tick(T, 0)
  const started = process.hrtime.bigint()
  let published = []
  for (let s = 1; s <= 120; s++) published = engine.tick(T + s * 1000, s * 1000).concat(published)
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  assert.ok(ms < 2000, `${ms} ms for 120 passes`)
  // Every entry is still fresh two minutes on, past every stale timeout.
  assert.ok(engine.snapshot(T + 120000, 120000).every((e) => e.state === 'ok'))
})
