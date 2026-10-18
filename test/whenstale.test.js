'use strict'

/*
 * Tests of "value when stale" on formula inputs: an input with such a value
 * is counted as it while the input is stale, has no value or no number,
 * and never makes the entry wait or go stale.
 */

const assert = require('node:assert/strict')
const { test } = require('node:test')

const { normalizeConfig } = require('../lib/config')
const { Engine } = require('../lib/engine')
const { checkDocument } = require('../lib/store')

const NOON = Date.parse('2026-10-18T12:00:00Z')

function harness (entries) {
  const engine = new Engine(normalizeConfig({ timeZone: 'UTC' }, { version: 1, groups: [], entries }), null)
  const published = {}
  const at = (seconds) => [NOON + seconds * 1000, seconds * 1000]
  return {
    engine,
    input: (seconds, path, value) => engine.input(path, value, ...at(seconds)),
    tick (seconds) {
      for (const { path, value } of engine.tick(...at(seconds))) published[path] = value
    },
    published: (path) => published[path],
    status: (id, seconds) => engine.snapshot(...at(seconds)).find((e) => e.key === id)
  }
}

// A house load: solar power, plus a shore charger that leaves the bus when
// there is no shore power (V × I, counted as 0 while it is away).
const house = {
  id: 'h',
  type: 'formula',
  inputs: [
    { name: 'solar', path: 'el.solar.power' },
    { name: 'v', path: 'el.charger.voltage', whenStale: 0 },
    { name: 'i', path: 'el.charger.current', whenStale: 0 }
  ],
  expression: 'solar + v * i',
  output: 'el.house.load',
  unit: 'W',
  staleTimeout: 60
}

test('a charger that leaves the bus is counted as 0, and the entry carries on', () => {
  const h = harness([house])
  for (let t = 0; t <= 30; t += 1) h.input(t, 'el.solar.power', 300)
  h.input(0, 'el.charger.voltage', 28)
  h.input(0, 'el.charger.current', 10)
  h.tick(30)
  assert.equal(h.published('el.house.load'), 580)
  assert.deepEqual(h.status('h', 30).substituted, [])
  // The charger says nothing more; solar keeps coming.
  for (let t = 31; t <= 120; t += 1) {
    h.input(t, 'el.solar.power', 300)
    h.tick(t)
  }
  const status = h.status('h', 120)
  assert.equal(status.state, 'ok')
  assert.equal(h.published('el.house.load'), 300)
  assert.deepEqual(status.substituted.map((s) => [s.name, s.value, s.reason]), [['v', 0, 'stale'], ['i', 0, 'stale']])
  // Shore power again.
  h.input(121, 'el.charger.voltage', 28.4)
  h.input(121, 'el.charger.current', 5)
  h.input(121, 'el.solar.power', 300)
  h.tick(121)
  assert.equal(h.published('el.house.load'), 442)
  assert.deepEqual(h.status('h', 121).substituted, [])
})

test('the switch to the value when stale needs no other input to arrive', () => {
  // Solar reports every 30 s. The charger stops at 50 s and is stale from
  // 111 s; the once-a-second pass counts it as 0 then, before solar's next
  // value at 120 s.
  const h = harness([house])
  for (let t = 0; t <= 112; t++) {
    if (t % 30 === 0) h.input(t, 'el.solar.power', 300)
    if (t <= 50) {
      h.input(t, 'el.charger.voltage', 28)
      h.input(t, 'el.charger.current', 10)
    }
    h.tick(t)
  }
  assert.equal(h.published('el.house.load'), 300)
  assert.equal(h.status('h', 112).state, 'ok')
})

test('the charger counts as 0 from the start when it has sent nothing yet', () => {
  const h = harness([house])
  h.input(0, 'el.solar.power', 250)
  h.tick(1)
  assert.equal(h.published('el.house.load'), 250)
  const status = h.status('h', 1)
  assert.equal(status.state, 'ok')
  assert.deepEqual(status.substituted.map((s) => s.reason), ['none', 'none'])
})

test('a null or a value that is not a number counts as the value when stale', () => {
  const h = harness([house])
  h.input(0, 'el.solar.power', 250)
  h.input(0, 'el.charger.voltage', 28)
  h.input(0, 'el.charger.current', 'off')
  h.tick(1)
  assert.equal(h.published('el.house.load'), 250)
  assert.deepEqual(h.status('h', 1).substituted.map((s) => [s.name, s.reason]), [['i', 'invalid']])
  h.input(2, 'el.charger.current', null)
  h.tick(2)
  assert.deepEqual(h.status('h', 2).substituted.map((s) => [s.name, s.reason]), [['i', 'invalid']])
})

test('an input without a value when stale still makes the entry wait and go stale', () => {
  const h = harness([house])
  h.input(0, 'el.charger.voltage', 28)
  h.input(0, 'el.charger.current', 10)
  h.tick(1)
  const waiting = h.status('h', 1)
  assert.equal(waiting.state, 'waiting')
  assert.match(waiting.message, /el\.solar\.power/)
  assert.doesNotMatch(waiting.message, /el\.charger/)
  h.input(2, 'el.solar.power', 100)
  h.tick(2)
  assert.equal(h.published('el.house.load'), 380)
  h.tick(70)
  assert.equal(h.status('h', 70).state, 'stale')
})

test('an entry whose inputs all have a value when stale always publishes', () => {
  const chargers = {
    id: 'c',
    type: 'formula',
    inputs: [
      { name: 'a', path: 'el.charger1.power', whenStale: 0 },
      { name: 'b', path: 'el.charger2.power', whenStale: 0 }
    ],
    expression: 'a + b',
    output: 'el.chargers.power',
    unit: 'W'
  }
  const h = harness([chargers])
  h.tick(1)
  assert.equal(h.published('el.chargers.power'), 0)
  assert.equal(h.status('c', 1).state, 'ok')
  assert.equal(h.status('c', 1).substituted.length, 2)
  h.input(2, 'el.charger1.power', 900)
  h.tick(2)
  assert.equal(h.published('el.chargers.power'), 900)
  h.tick(400)
  assert.equal(h.status('c', 400).state, 'ok')
  assert.equal(h.published('el.chargers.power'), 0)
})

test('a value when stale feeds an entry that reads the formula', () => {
  const daily = { id: 'e', type: 'integration', input: 'el.house.load', output: 'el.house.energy', unit: 'J', resets: 'manual', staleTimeout: 0 }
  const h = harness([house, daily])
  for (let t = 0; t <= 200; t++) {
    h.input(t, 'el.solar.power', 100)
    h.tick(t)
  }
  // 100 W for 200 s, the charger never there.
  assert.equal(h.published('el.house.energy'), 20000)
})

test('a value held at start-up older than the stale timeout is replaced at once', () => {
  // The server held 300 W from the charger, 120 s old, when the plugin
  // started. The formula counts it as 0 straight away, so the integration
  // on its output never sees the old 300 W.
  const charger = { id: 'f', type: 'formula', inputs: [{ name: 'c', path: 'el.charger', whenStale: 0 }], expression: 'c', output: 'el.f', unit: 'W', staleTimeout: 60 }
  const energy = { id: 'i', type: 'integration', input: 'el.f', output: 'el.e', unit: 'J', resets: 'manual', staleTimeout: 300 }
  const engine = new Engine(normalizeConfig({ timeZone: 'UTC' }, { version: 1, groups: [], entries: [charger, energy] }), null)
  const now = 1000000
  engine.inputs([{ path: 'el.charger', value: 300 }], NOON, now - 120000, now)
  const published = {}
  for (let s = 1; s <= 5; s++) for (const { path, value } of engine.tick(NOON + s * 1000, now + s * 1000)) published[path] = value
  assert.equal(published['el.f'], 0)
  assert.equal(published['el.e'] || 0, 0)
  const status = engine.snapshot(NOON + 5000, now + 5000).find((e) => e.key === 'f')
  assert.deepEqual(status.substituted.map((s) => s.reason), ['stale'])
})

test('a result held while an input without a value is stale keeps the inputs it was worked out with', () => {
  const held = { ...house, onStale: 'hold' }
  const h = harness([held])
  h.input(0, 'el.solar.power', 300)
  h.input(0, 'el.charger.voltage', 28)
  h.input(0, 'el.charger.current', 10)
  h.tick(1)
  h.tick(61)
  const status = h.status('h', 61)
  assert.equal(status.state, 'stale')
  assert.equal(status.value, 580)
  // 580 holds the charger's 280 W, so nothing is listed as replaced.
  assert.deepEqual(status.substituted, [])
})

test('an entry read by the formula that stops publishing counts as no number', () => {
  const upstream = { id: 'u', type: 'formula', inputs: [{ name: 'x', path: 'el.x' }], expression: 'x', output: 'el.u', unit: 'W', staleTimeout: 10 }
  const reader = { id: 'r', type: 'formula', inputs: [{ name: 'a', path: 'el.u', whenStale: 0 }], expression: 'a', output: 'el.r', unit: 'W', staleTimeout: 300 }
  const h = harness([upstream, reader])
  h.input(0, 'el.x', 5)
  h.tick(1)
  assert.equal(h.published('el.r'), 5)
  for (let t = 2; t <= 20; t++) h.tick(t)
  assert.equal(h.published('el.r'), 0)
  assert.deepEqual(h.status('r', 20).substituted.map((s) => s.reason), ['invalid'])
})

test('the value when stale is checked, kept and saved as a number', () => {
  const entries = (whenStale) => normalizeConfig({ timeZone: 'UTC' }, {
    version: 1,
    groups: [],
    entries: [{ ...house, inputs: [house.inputs[0], { ...house.inputs[1], whenStale }, house.inputs[2]] }]
  }).entries[0]
  assert.equal(entries('0').inputs[1].whenStale, 0)
  assert.equal(entries(-12.5).inputs[1].whenStale, -12.5)
  assert.equal(entries('').inputs[1].whenStale, null)
  assert.equal(entries(null).inputs[1].whenStale, null)
  // Blank text is empty, not 0.
  assert.equal(entries('  ').inputs[1].whenStale, null)
  assert.equal(entries(' 5 ').inputs[1].whenStale, 5)
  const bad = entries('off')
  assert.deepEqual(bad.faults.map((f) => f.field), ['inputs.1.whenStale'])
  assert.equal(bad.error, 'the value when stale of "v" is not a number')
  // An input without one is saved exactly as before 0.5.0.
  const { doc } = checkDocument({ version: 1, groups: [], entries: [{ ...house, inputs: [{ name: 'solar', path: 'el.solar.power' }, { name: 'v', path: 'el.charger.voltage', whenStale: 0 }, { name: 'i', path: 'el.charger.current', whenStale: '  ' }] }] }, true)
  assert.deepEqual(doc.entries[0].inputs, [{ name: 'solar', path: 'el.solar.power' }, { name: 'v', path: 'el.charger.voltage', whenStale: 0 }, { name: 'i', path: 'el.charger.current' }])
})
