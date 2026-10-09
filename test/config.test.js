'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')

const { normalizeConfig } = require('../lib/config')
const { serverTimeZone } = require('../lib/periods')
const { schema, uiSchema } = require('../lib/schema')

const errorsOf = (options) => normalizeConfig(options).entries.map((e) => e.error)

test('an empty or missing configuration is valid and has no entries', () => {
  for (const options of [undefined, null, {}, { formulas: null, counters: 'x', integrations: [null, 7] }]) {
    const normalized = normalizeConfig(options)
    assert.deepEqual(normalized.entries, [])
    assert.deepEqual(normalized.problems, [])
  }
})

test('settings fall back to defaults', () => {
  const { settings } = normalizeConfig({})
  assert.deepEqual(settings, { timeZone: serverTimeZone(), dayStartMinutes: 0, weekStart: 'monday', repeatMs: 10000 })
})

test('settings are read from the form values', () => {
  const { settings, problems } = normalizeConfig({ timeZone: ' Europe/Athens ', dayStart: '04:30', weekStart: 'sunday', repeatInterval: 0 })
  assert.deepEqual(settings, { timeZone: 'Europe/Athens', dayStartMinutes: 270, weekStart: 'sunday', repeatMs: 0 })
  assert.deepEqual(problems, [])
})

test('a bad time zone or day start is reported and replaced', () => {
  const { settings, problems } = normalizeConfig({ timeZone: 'Atlantis/Central', dayStart: '25:00' })
  assert.equal(settings.timeZone, serverTimeZone())
  assert.equal(settings.dayStartMinutes, 0)
  assert.equal(problems.length, 2)
  assert.match(problems[0], /Atlantis\/Central/)
  assert.match(problems[1], /25:00/)
})

test('entry defaults', () => {
  const { entries } = normalizeConfig({
    formulas: [{ inputs: [{ name: 'x', path: 'a.x' }], expression: 'x', output: 'a.y' }],
    counters: [{ input: 'a.total', output: 'a.today' }],
    integrations: [{ input: 'a.rate', output: 'a.sum' }]
  })
  const [formula, counter, integration] = entries
  for (const entry of entries) {
    assert.equal(entry.error, null)
    assert.equal(entry.enabled, true)
    assert.equal(entry.staleMs, 60000)
    assert.equal(entry.onStale, 'stop')
  }
  assert.equal(formula.type, 'formula')
  assert.deepEqual({ direction: counter.direction, reversal: counter.reversal, minStep: counter.minStep, resets: counter.resets }, { direction: 'increase', reversal: 'continue', minStep: 0, resets: 'day' })
  assert.deepEqual({ mode: integration.mode, threshold: integration.threshold, gap: integration.gap, resets: integration.resets }, { mode: 'rate', threshold: 0, gap: 'skip', resets: 'day' })
})

test('paths are checked', () => {
  assert.match(errorsOf({ counters: [{ input: 'a.total' }] })[0], /no output path/)
  assert.match(errorsOf({ counters: [{ input: 'a.total', output: 'single' }] })[0], /not a valid output path/)
  assert.match(errorsOf({ counters: [{ input: 'a.total', output: 'has space.x' }] })[0], /not a valid output path/)
  assert.match(errorsOf({ counters: [{ output: 'a.today' }] })[0], /no input path/)
  assert.match(errorsOf({ counters: [{ input: 'a..total', output: 'a.today' }] })[0], /not a valid input path/)
  assert.match(errorsOf({ integrations: [{ input: 'a.rate', output: 'a.sum', resets: 'path' }] })[0], /no path to follow/)
  assert.equal(errorsOf({ counters: [{ input: 'electrical.solar.sp-hardtop.yieldTotal', output: 'electrical.solar.sp-hardtop.yieldToday' }] })[0], null)
})

test('formula inputs and expressions are checked', () => {
  const formula = (extra) => ({ formulas: [{ inputs: [{ name: 'i', path: 'a.i' }], expression: 'i', output: 'a.y', ...extra }] })
  assert.match(errorsOf(formula({ inputs: [] }))[0], /no inputs/)
  assert.match(errorsOf(formula({ inputs: [{ name: 'a.i', path: 'a.i' }] }))[0], /not a valid short name/)
  assert.match(errorsOf(formula({ inputs: [{ name: 'max', path: 'a.i' }] }))[0], /built-in/)
  assert.match(errorsOf(formula({ inputs: [{ name: 'i', path: 'a.i' }, { name: 'i', path: 'a.j' }] }))[0], /used twice/)
  assert.match(errorsOf(formula({ inputs: [{ name: 'i', path: '' }] }))[0], /no path for "i"/)
  assert.match(errorsOf(formula({ expression: 'i * v' }))[0], /uses "v"/)
  assert.match(errorsOf(formula({ expression: '' }))[0], /empty/)
  assert.match(errorsOf(formula({ expression: 'i +' }))[0], /does not parse/)
})

test('two entries may not write the same path', () => {
  const errors = errorsOf({ counters: [{ input: 'a.total', output: 'a.out' }], integrations: [{ input: 'a.rate', output: 'a.out' }] })
  assert.equal(errors[0], null)
  assert.match(errors[1], /already written/)
})

test('a disabled entry does not block another entry from using its output path', () => {
  const errors = errorsOf({ counters: [{ input: 'a.total', output: 'a.out', enabled: false }], integrations: [{ input: 'a.rate', output: 'a.out' }] })
  assert.deepEqual(errors, [null, null])
})

test('loops between entries are refused, and entries outside the loop still run', () => {
  const { entries } = normalizeConfig({
    formulas: [
      { inputs: [{ name: 'x', path: 'loop.b' }], expression: 'x', output: 'loop.a' },
      { inputs: [{ name: 'x', path: 'loop.a' }], expression: 'x', output: 'loop.b' },
      { inputs: [{ name: 'x', path: 'self.a' }], expression: 'x', output: 'self.a' },
      { inputs: [{ name: 'x', path: 'ok.in' }], expression: 'x', output: 'ok.out' },
      { inputs: [{ name: 'x', path: 'ok.out' }], expression: 'x', output: 'ok.out2' }
    ]
  })
  assert.match(entries[0].error, /circular reference/)
  assert.match(entries[1].error, /circular reference/)
  assert.match(entries[2].error, /circular reference: self\.a -> self\.a/)
  assert.equal(entries[3].error, null)
  assert.equal(entries[4].error, null)
})

test('the form schema offers every field the configuration reader uses', () => {
  const fields = (list) => Object.keys(schema.properties[list].items.properties).sort()
  assert.deepEqual(fields('formulas'), ['enabled', 'expression', 'inputs', 'name', 'onStale', 'output', 'staleTimeout', 'unit'])
  assert.deepEqual(fields('counters'), ['direction', 'enabled', 'input', 'minStep', 'name', 'onStale', 'output', 'resetPath', 'resets', 'reversal', 'staleTimeout', 'unit'])
  assert.deepEqual(fields('integrations'), ['enabled', 'gap', 'input', 'mode', 'name', 'onStale', 'output', 'resetPath', 'resets', 'staleTimeout', 'threshold', 'unit'])
  assert.deepEqual(Object.keys(schema.properties).sort(), ['counters', 'dayStart', 'formulas', 'integrations', 'repeatInterval', 'timeZone', 'weekStart'])

  // Every choice list has one label per value, and its default is a value.
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node.enum)) {
      assert.equal(node.enumNames.length, node.enum.length, node.title)
      assert.ok(node.enum.includes(node.default), node.title)
    }
    for (const child of Object.values(node)) walk(child)
  }
  walk(schema)

  // The field order lists only fields that exist.
  for (const list of ['formulas', 'counters', 'integrations']) {
    for (const field of uiSchema[list].items['ui:order']) {
      if (field !== '*') assert.ok(fields(list).includes(field), `${list}.${field}`)
    }
  }
})

test('the schema is plain JSON with no object used in two places', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(schema)), schema)
  const seen = new Set()
  const walk = (node, route) => {
    if (!node || typeof node !== 'object') return
    assert.ok(!seen.has(node), `${route} is shared with another part of the schema`)
    seen.add(node)
    for (const [key, child] of Object.entries(node)) walk(child, `${route}.${key}`)
  }
  walk(schema, 'schema')
  walk(uiSchema, 'uiSchema')
})

test('the schema defaults produce a valid configuration', () => {
  // What the admin form saves when an entry is added and only the required
  // fields are filled in.
  const defaults = (list) => Object.fromEntries(Object.entries(schema.properties[list].items.properties).filter(([, p]) => 'default' in p).map(([k, p]) => [k, p.default]))
  const { entries, problems } = normalizeConfig({
    timeZone: schema.properties.timeZone.default,
    dayStart: schema.properties.dayStart.default,
    weekStart: schema.properties.weekStart.default,
    repeatInterval: schema.properties.repeatInterval.default,
    formulas: [{ ...defaults('formulas'), inputs: [{ name: 'x', path: 'a.x' }], expression: 'x', output: 'a.y' }],
    counters: [{ ...defaults('counters'), input: 'a.total', output: 'a.today' }],
    integrations: [{ ...defaults('integrations'), input: 'a.rate', output: 'a.sum' }]
  })
  assert.deepEqual(problems, [])
  assert.deepEqual(entries.map((e) => e.error), [null, null, null])
})

test('an emptied numeric field falls back to its default', () => {
  for (const empty of [null, undefined, '']) {
    const { settings, entries } = normalizeConfig({
      repeatInterval: empty,
      counters: [{ input: 'a.total', output: 'a.today', staleTimeout: empty, minStep: empty }],
      integrations: [{ input: 'a.rate', output: 'a.sum', staleTimeout: empty, threshold: empty }]
    })
    assert.equal(settings.repeatMs, 10000)
    assert.equal(entries[0].staleMs, 60000)
    assert.equal(entries[0].minStep, 0)
    assert.equal(entries[1].staleMs, 60000)
    assert.equal(entries[1].threshold, 0)
  }
  // An explicit zero is a real setting and is kept.
  const { settings, entries } = normalizeConfig({ repeatInterval: 0, counters: [{ input: 'a.total', output: 'a.today', staleTimeout: 0 }] })
  assert.equal(settings.repeatMs, 0)
  assert.equal(entries[0].staleMs, 0)
})

test('an entry may not follow its own output, or a loop, for resets', () => {
  const { entries } = normalizeConfig({
    counters: [
      { input: 'a.total', output: 'a.today', resets: 'path', resetPath: 'a.today' },
      { input: 'b.total', output: 'b.today', resets: 'path', resetPath: 'c.today' },
      { input: 'b.today', output: 'c.today' }
    ]
  })
  for (const entry of entries) assert.match(entry.error, /circular reference/)
})
