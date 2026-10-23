'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')

const { normalizeConfig } = require('../lib/config')
const { serverTimeZone } = require('../lib/periods')
const { PART_HOUR_OFFSETS, RENAMED_ZONES, entryFields, entryOrder, schema, schemaFor, uiSchema } = require('../lib/schema')
const { checkDocument } = require('../lib/store')

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
  assert.deepEqual(settings, {
    timeZone: serverTimeZone(),
    zone: {
      follow: true,
      regionPath: 'environment.time.timezoneRegion',
      offsetPath: 'environment.time.timezoneOffset',
      fallback: serverTimeZone(),
      fallbackSource: 'server'
    },
    dayStartMinutes: 0,
    weekStart: 'monday',
    repeatMs: 10000
  })
})

test('settings are read from the form values', () => {
  const { settings, problems } = normalizeConfig({ timeZone: ' Europe/Athens ', dayStart: '04:30', weekStart: 'sunday', repeatInterval: 0 })
  assert.deepEqual({ ...settings, zone: undefined }, { timeZone: 'Europe/Athens', zone: undefined, dayStartMinutes: 270, weekStart: 'sunday', repeatMs: 0 })
  assert.equal(settings.zone.fallback, 'Europe/Athens')
  assert.equal(settings.zone.fallbackSource, 'setting')
  assert.deepEqual(problems, [])
})

test('the time zone settings are read from the form values', () => {
  const { settings, problems } = normalizeConfig({ timeZoneSource: 'fixed', timeZoneRegionPath: ' my.zone.name ', timeZoneOffsetPath: 'my.zone.offset', timeZone: '+05:45' })
  assert.deepEqual(settings.zone, { follow: false, regionPath: 'my.zone.name', offsetPath: 'my.zone.offset', fallback: '+05:45', fallbackSource: 'setting' })
  assert.equal(settings.timeZone, '+05:45')
  assert.deepEqual(problems, [])
})

test('the server\'s zone is the fallback for "server", for nothing, and for the empty text 0.1.0 saved', () => {
  for (const timeZone of ['server', '', '   ', undefined, null]) {
    const { settings, problems } = normalizeConfig({ timeZone })
    assert.equal(settings.zone.fallback, serverTimeZone(), String(timeZone))
    assert.equal(settings.zone.fallbackSource, 'server', String(timeZone))
    assert.deepEqual(problems, [])
  }
})

test('a zone is accepted in any spelling and stored in one', () => {
  const fallback = (timeZone) => normalizeConfig({ timeZone }).settings.zone.fallback
  assert.equal(fallback('europe/athens'), 'Europe/Athens')
  assert.equal(fallback('UTC+3'), '+03:00')
  assert.equal(fallback('-0930'), '-09:30')
  assert.equal(fallback('utc'), 'UTC')
  assert.equal(fallback('+00:00'), 'UTC')
})

test('a path to follow that is emptied or malformed goes back to the standard path', () => {
  for (const empty of [null, undefined, '', '  ']) {
    const { settings, problems } = normalizeConfig({ timeZoneRegionPath: empty, timeZoneOffsetPath: empty })
    assert.equal(settings.zone.regionPath, 'environment.time.timezoneRegion')
    assert.equal(settings.zone.offsetPath, 'environment.time.timezoneOffset')
    assert.deepEqual(problems, [])
  }
  const { settings, problems } = normalizeConfig({ timeZoneRegionPath: 'not a path', timeZoneOffsetPath: 'a..b' })
  assert.equal(settings.zone.regionPath, 'environment.time.timezoneRegion')
  assert.equal(settings.zone.offsetPath, 'environment.time.timezoneOffset')
  assert.equal(problems.length, 2)
  assert.match(problems[0], /not a path/)
  assert.match(problems[1], /a\.\.b/)
})

test('an unknown source for the time zone falls back to following', () => {
  assert.equal(normalizeConfig({ timeZoneSource: 'sometimes' }).settings.zone.follow, true)
  assert.equal(normalizeConfig({ timeZoneSource: 'fixed' }).settings.zone.follow, false)
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
  assert.equal(errorsOf({ counters: [{ input: 'electrical.solar.hardtop.yieldTotal', output: 'electrical.solar.hardtop.yieldToday' }] })[0], null)
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
  const fields = (type) => Object.keys(entryFields[type].properties).sort()
  assert.deepEqual(fields('formula'), ['enabled', 'expression', 'inputs', 'name', 'onStale', 'output', 'staleTimeout', 'unit'])
  assert.deepEqual(fields('counter'), ['direction', 'enabled', 'input', 'minStep', 'name', 'onStale', 'output', 'resetPath', 'resets', 'reversal', 'staleTimeout', 'unit'])
  assert.deepEqual(fields('integration'), ['enabled', 'gap', 'input', 'mode', 'name', 'onStale', 'output', 'resetPath', 'resets', 'staleTimeout', 'threshold', 'unit'])
  // The settings form holds only what applies to every entry.
  assert.deepEqual(Object.keys(schema.properties).sort(), ['dayStart', 'repeatInterval', 'timeZone', 'timeZoneOffsetPath', 'timeZoneRegionPath', 'timeZoneSource', 'weekStart'])
  // Every top-level field has a place in the field order.
  for (const field of Object.keys(schema.properties)) assert.ok(uiSchema['ui:order'].includes(field), field)

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
  walk(entryFields)

  // The editor's field order lists every field once and only fields that
  // exist, and the entries file keeps every field the editor offers.
  for (const type of ['formula', 'counter', 'integration', 'cycles']) {
    const listed = entryOrder[type].filter((field) => field !== '*')
    assert.deepEqual([...listed].sort(), fields(type), type)
    const sample = (f) => (f === 'enabled' ? true : f === 'inputs' ? [] : entryFields[type].properties[f].type === 'number' ? 1 : 'x')
    const kept = Object.keys(checkDocument({ groups: [], entries: [{ id: 'e1', type, ...Object.fromEntries(fields(type).map((f) => [f, sample(f)])) }] }, true).doc.entries[0])
    assert.deepEqual(kept.filter((f) => !['id', 'group', 'type'].includes(f)).sort(), fields(type), type)
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
  seen.clear()
  walk(entryFields, 'entryFields')
})

test('the schema defaults produce a valid configuration', () => {
  // What the admin form saves when an entry is added and only the required
  // fields are filled in.
  const defaults = (type) => Object.fromEntries(Object.entries(entryFields[type].properties).filter(([, p]) => 'default' in p).map(([k, p]) => [k, p.default]))
  const { entries, problems } = normalizeConfig({
    timeZoneSource: schema.properties.timeZoneSource.default,
    timeZoneRegionPath: schema.properties.timeZoneRegionPath.default,
    timeZoneOffsetPath: schema.properties.timeZoneOffsetPath.default,
    timeZone: schema.properties.timeZone.default,
    dayStart: schema.properties.dayStart.default,
    weekStart: schema.properties.weekStart.default,
    repeatInterval: schema.properties.repeatInterval.default,
    formulas: [{ ...defaults('formula'), inputs: [{ name: 'x', path: 'a.x' }], expression: 'x', output: 'a.y' }],
    counters: [{ ...defaults('counter'), input: 'a.total', output: 'a.today' }],
    integrations: [{ ...defaults('integration'), input: 'a.rate', output: 'a.sum' }]
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

test('every choice in the time zone list is a zone the plugin accepts', () => {
  const { canonicalTimeZone } = require('../lib/periods')
  const choices = schema.properties.timeZone
  assert.equal(choices.enum[0], 'server')
  assert.equal(choices.enum[1], 'UTC')
  assert.equal(new Set(choices.enum).size, choices.enum.length, 'a zone is listed twice')
  for (const zone of choices.enum.slice(1)) {
    const { settings, problems } = normalizeConfig({ timeZone: zone })
    assert.deepEqual(problems, [], zone)
    // A choice is saved as written and must come back as the same zone.
    assert.equal(settings.zone.fallback, canonicalTimeZone(zone), zone)
    assert.equal(settings.zone.fallbackSource, 'setting', zone)
  }
  // The fixed offsets cover every whole hour and the part-hour zones.
  for (const offset of ['-12:00', '-09:30', '-03:30', '+03:00', '+05:30', '+05:45', '+12:45', '+14:00']) {
    assert.ok(choices.enum.includes(offset), offset)
  }
  assert.ok(choices.enum.includes('Europe/Athens'))
  // A fixed offset says in its label that it does not follow daylight saving.
  assert.match(choices.enumNames[choices.enum.indexOf('+03:00')], /^UTC\+03:00 \(fixed, no daylight saving\)$/)
})

test('the list of fixed offsets covers every offset a zone keeps', () => {
  // The part-hour offsets are written out in the code. This asks the
  // runtime, as the code deliberately does not, and fails when a zone keeps
  // an offset that is in neither the list nor the whole hours.
  const { zoneOffset } = require('../lib/periods')
  const year = new Date().getUTCFullYear()
  const missing = new Set()
  for (const name of Intl.supportedValuesOf('timeZone')) {
    for (const month of [0, 6]) {
      const minutes = zoneOffset(Date.UTC(year, month, 1), name) / 60000
      if (minutes % 60 !== 0 && !PART_HOUR_OFFSETS.includes(minutes)) missing.add(`${name}: ${minutes}`)
    }
  }
  assert.deepEqual([...missing], [])
})

test('renamed zones are offered where the runtime accepts them', () => {
  const { canonicalTimeZone } = require('../lib/periods')
  const choices = schema.properties.timeZone.enum
  for (const name of RENAMED_ZONES) {
    if (canonicalTimeZone(name) === name) assert.ok(choices.includes(name), name)
  }
  // The names stay in alphabetical order after the fixed offsets.
  const names = choices.filter((zone) => zone.includes('/'))
  assert.deepEqual(names, [...names].sort())
})

test('the form for a saved zone outside the list holds that zone', () => {
  // Every spelling the plugin accepts must survive opening and saving the
  // form, which replaces a value outside its list with the default.
  for (const saved of ['US/Eastern', 'Etc/UTC', 'europe/athens', 'Etc/GMT-3', 'GMT', 'utc', '+3', 'UTC+05:45']) {
    const field = schemaFor(saved).properties.timeZone
    assert.ok(field.enum.includes(saved), saved)
    assert.equal(field.enumNames.length, field.enum.length, saved)
    assert.equal(new Set(field.enum).size, field.enum.length, saved)
    // What the form would save is what the plugin was already running with.
    assert.equal(normalizeConfig({ timeZone: saved }).problems.length, 0, saved)
  }
  // Nothing is added for a zone already listed, or for text that is no zone.
  const base = schema.properties.timeZone.enum.length
  for (const saved of ['Europe/Athens', 'UTC', 'server', '+03:00', '', undefined, null, 7, 'Atlantis/Central']) {
    assert.equal(schemaFor(saved).properties.timeZone.enum.length, base, String(saved))
  }
  // The shared schema is never changed by a request.
  schemaFor('US/Eastern')
  assert.equal(schema.properties.timeZone.enum.length, base)
})

test('every fault of an entry is listed with its field, the first one stopping it', () => {
  const doc = {
    version: 1,
    groups: [],
    entries: [
      { id: 'c', type: 'cycles', inputs: [{ path: 'a.b', kind: 'wave' }, { path: 'not a path', kind: 'onoff' }], window: 0, longest: 10, shortest: 20 },
      { id: 'f', type: 'formula', output: 'x.y', inputs: [{ name: '1a', path: 'a.b' }, { name: 'b', path: '' }], expression: 'b +' }
    ]
  }
  const [cycles, formula] = normalizeConfig({ timeZone: 'UTC' }, doc).entries
  assert.deepEqual(cycles.faults.map((f) => f.field), ['output', 'inputs.0.swing', 'inputs.1.path', 'window', 'longest'])
  assert.equal(cycles.error, 'no output path is set')
  // The expression is not checked against short names that cannot be used.
  assert.deepEqual(formula.faults.map((f) => f.field), ['inputs.0.name', 'inputs.1.path'])
  assert.equal(formula.error, formula.faults[0].text)
})
