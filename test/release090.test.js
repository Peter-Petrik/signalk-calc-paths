'use strict'

/*
 * Version 0.9.0: what the status route says about an entry reads as a
 * sentence after the state's label, and a formula names its inputs.
 */

const assert = require('node:assert/strict')
const { test } = require('node:test')

const { normalizeConfig } = require('../lib/config')
const { Engine } = require('../lib/engine')

const NOON = Date.parse('2026-10-25T12:00:00Z')

function engineFor (entries) {
  const document = { version: 1, groups: [], entries: entries.map((entry, index) => ({ id: `e${index + 1}`, ...entry })) }
  return new Engine(normalizeConfig({ timeZone: 'UTC' }, document), null)
}

test('a message does not repeat the label of its state', () => {
  const engine = engineFor([
    { type: 'formula', inputs: [{ name: 'a', path: 'x.a' }], expression: 'a * 2', output: 'x.f' },
    { type: 'counter', input: 'x.total', output: 'x.c' },
    { type: 'cycles', inputs: [{ path: 'x.switch', kind: 'onoff' }], output: 'x.cy' },
    { type: 'record', input: 'x.soc', keep: 'lowest', output: 'x.r' },
    { type: 'formula', enabled: false, inputs: [{ name: 'a', path: 'x.a' }], expression: 'a *', output: 'x.off' }
  ])
  engine.tick(NOON, 0)
  const byId = Object.fromEntries(engine.snapshot(NOON, 0).map((item) => [item.key, item]))
  assert.equal(byId.e1.message, 'No value yet on x.a.')
  assert.equal(byId.e2.message, 'No value yet on x.total.')
  assert.equal(byId.e3.message, '0 of the 3 cycles needed in the last 24 h have been counted.')
  assert.equal(byId.e4.message, 'No value yet on x.soc.')
  for (const item of Object.values(byId)) assert.doesNotMatch(item.message, /^(Waiting|Switched off|Disabled)/)
  // Disabled wins over a fault: an entry may be saved unfinished once it is
  // disabled, so its unfinished expression is no configuration error.
  assert.equal(byId.e5.state, 'disabled')
  assert.equal(byId.e5.message, 'Nothing is calculated or published.')
})

test('a formula reports the short name of each input, in the order of its inputs', () => {
  const engine = engineFor([{ type: 'formula', inputs: [{ name: 'i', path: 'x.current' }, { name: 'v', path: 'x.voltage' }], expression: 'i * v', output: 'x.power' }])
  const item = engine.snapshot(NOON, 0)[0]
  assert.deepEqual(item.inputs, ['x.current', 'x.voltage'])
  assert.deepEqual(item.inputNames, ['i', 'v'])
})

test('an entry that reads its own output says so plainly', () => {
  const { entries } = normalizeConfig({ timeZone: 'UTC' }, { version: 1, groups: [], entries: [{ id: 'e1', type: 'formula', inputs: [{ name: 'a', path: 'x.a' }], expression: 'a', output: 'x.a' }] })
  assert.equal(entries[0].error, 'it reads its own output path x.a; an entry cannot read what it publishes')
})

test('a time since that has not met its level names the input after a word, so the path keeps its case', () => {
  const engine = engineFor([{ type: 'record', input: 'electrical.batteries.house.capacity.stateOfCharge', keep: 'sinceAbove', level: 1, output: 'x.sinceFull', staleTimeout: 0 }])
  engine.input('electrical.batteries.house.capacity.stateOfCharge', 0.8, NOON, 0)
  engine.tick(NOON + 1000, 1000)
  const item = engine.snapshot(NOON + 1000, 1000)[0]
  assert.equal(item.state, 'waiting')
  assert.equal(item.message, 'The input electrical.batteries.house.capacity.stateOfCharge has not been at the level since the plugin started.')
})
