'use strict'

/*
 * Version 0.8.0: the API description and the status route agree, and the
 * record's messages name where a record shown came from.
 */

const assert = require('node:assert/strict')
const { test } = require('node:test')

const { normalizeConfig } = require('../lib/config')
const { Engine } = require('../lib/engine')
const openApi = require('../lib/openapi')
const { TYPES } = require('../lib/store')

const NOON = Date.parse('2026-10-09T12:00:00Z')

function engineFor (entries) {
  const document = { version: 1, groups: [], entries: entries.map((entry, index) => ({ id: `e${index + 1}`, ...entry })) }
  const normalized = normalizeConfig({ timeZone: 'UTC' }, document)
  for (const entry of normalized.entries) assert.equal(entry.error, null, `${entry.label}: ${entry.error}`)
  return new Engine(normalized, null)
}

const ENTRIES = [
  { type: 'formula', inputs: [{ name: 'a', path: 'x.a' }], expression: 'a * 2', output: 'x.formula' },
  { type: 'counter', input: 'x.total', output: 'x.counter' },
  { type: 'integration', input: 'x.power', output: 'x.integration' },
  { type: 'cycles', inputs: [{ path: 'x.switch', kind: 'onoff' }], output: 'x.cycles' },
  { type: 'record', input: 'x.soc', keep: 'lowest', resets: 'level', resetLevel: 1, output: 'x.lowest', timeOutput: 'x.lowestAt' },
  { type: 'record', input: 'x.soc', keep: 'sinceAbove', level: 1, output: 'x.since' }
]

test('the API description names every entry type and every field the status route gives', () => {
  const description = openApi('0.8.0')
  const schema = description.paths['/api/entries'].get.responses[200].content['application/json'].schema
  const entry = schema.properties.entries.items
  assert.deepEqual(entry.properties.type.enum, TYPES)
  const config = description.paths['/api/config'].get.responses[200].content['application/json'].schema
  assert.deepEqual(config.properties.entries.items.properties.type.enum, TYPES)
  const engine = engineFor(ENTRIES)
  engine.input('x.soc', 0.5, NOON, 0)
  engine.tick(NOON, 0)
  // inputUnit is added by the status route; see withInputUnit() in index.js.
  const described = new Set([...Object.keys(entry.properties)])
  for (const item of engine.snapshot(NOON, 0)) {
    for (const key of Object.keys(item)) assert.ok(described.has(key), `${item.type} gives ${key}, which the API description leaves out`)
  }
  assert.ok(entry.properties.inputUnit)
  assert.ok(entry.properties.lastReset.properties.cause.enum.includes('level'))
  assert.ok(entry.properties.resets.enum.includes('level'))
})

test('a record shown before any input says where it came from', () => {
  const plain = engineFor([{ type: 'record', input: 'x.soc', keep: 'lowest', startValue: 0.3, startTime: '2026-10-09T10:00:00Z', staleTimeout: 0, output: 'x.lowest' }])
  plain.tick(NOON, 0)
  const item = plain.snapshot(NOON, 0)[0]
  assert.equal(item.value, 0.3)
  assert.match(item.message, /the start entered by hand/)
})
