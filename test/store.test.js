'use strict'

/*
 * Tests of the entries file: its structure check, reading and writing, and
 * building it from the plugin settings of versions before 0.3.0.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const store = require('../lib/store')

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'calc-paths-store-'))

test('a well-formed document passes and keeps only the fields of its type', () => {
  const { doc, errors } = store.checkDocument({
    groups: [{ id: 'g1', name: '  Solar  ' }],
    entries: [
      { id: 'e1', group: 'g1', type: 'counter', input: 'a.total', output: 'a.today', expression: 'left over', extra: 1 },
      { id: 'e2', type: 'formula', inputs: [{ name: 'x', path: 'a.x', note: 'dropped' }], expression: 'x', output: 'a.y' }
    ]
  }, true)
  assert.deepEqual(errors, [])
  assert.deepEqual(doc.groups, [{ id: 'g1', name: 'Solar' }])
  assert.deepEqual(doc.entries[0], { id: 'e1', group: 'g1', type: 'counter', input: 'a.total', output: 'a.today' })
  assert.deepEqual(doc.entries[1], { id: 'e2', group: null, type: 'formula', inputs: [{ name: 'x', path: 'a.x' }], expression: 'x', output: 'a.y' })
  assert.equal(doc.version, store.ENTRIES_VERSION)
})

test('structural faults are named, and a document with any is refused whole', () => {
  const faults = (raw, strict = true) => store.checkDocument(raw, strict).errors
  assert.deepEqual(faults(null), ['the document is not a JSON object'])
  assert.deepEqual(faults({ groups: {}, entries: [] }), ['"groups" is not a list'])
  assert.deepEqual(faults({ version: 2, groups: [], entries: [] }), ['version 2 is not known to this version of the plugin'])
  assert.deepEqual(faults({ groups: [{ id: 'g1', name: 'A' }, { id: 'g1', name: 'B' }], entries: [] }), ['the group id "g1" is used twice'])
  assert.deepEqual(faults({ groups: [{ id: 'g1', name: ' ' }], entries: [] }), ['group 1 has no name'])
  assert.deepEqual(faults({ groups: [], entries: [{ id: 'e1', type: 'sum' }] }), ['entry 1 has no known type (formula, counter or integration)'])
  assert.deepEqual(faults({ groups: [], entries: [{ id: 'bad id', type: 'formula' }] }), ['entry 1 has no valid id'])
  assert.deepEqual(faults({ groups: [], entries: [{ id: 'e1', type: 'formula' }, { id: 'e1', type: 'counter' }] }), ['the entry id "e1" is used twice'])
  assert.deepEqual(faults({ groups: [], entries: [{ id: 'e1', type: 'formula', group: 'g9' }] }), ['entry 1 names a group that does not exist'])
  assert.deepEqual(faults({ groups: [], entries: [{ id: 'e1', type: 'formula', name: 'x'.repeat(501) }] }), ['entry 1 has a text longer than 500 characters'])
  assert.deepEqual(faults({ groups: [], entries: Array.from({ length: store.MAX_ENTRIES + 1 }, (_, i) => ({ id: `e${i}`, type: 'formula' })) }), [`more than ${store.MAX_ENTRIES} entries`])
  assert.equal(store.checkDocument({ groups: [], entries: [{ id: 'e1', type: 'sum' }] }, true).doc, null)
})

test('read at start-up, an entry naming a missing group is shown without one', () => {
  const { doc, errors } = store.checkDocument({ groups: [], entries: [{ id: 'e1', type: 'formula', group: 'g9' }] }, false)
  assert.deepEqual(errors, [])
  assert.equal(doc.entries[0].group, null)
})

test('the file is written, read back, and missing means nothing yet', () => {
  const dir = tempDir()
  assert.deepEqual(store.loadEntries(dir), { doc: null, error: null })
  const doc = { version: 1, groups: [{ id: 'g1', name: 'Engine' }], entries: [{ id: 'e1', group: 'g1', type: 'integration', input: 'p.rate', output: 'p.used' }] }
  store.saveEntries(dir, doc)
  assert.deepEqual(store.loadEntries(dir), { doc, error: null })
  assert.ok(!fs.existsSync(path.join(dir, `${store.ENTRIES_FILE}.tmp`)))
})

test('an unusable file is reported and left exactly as it is', () => {
  const dir = tempDir()
  const file = path.join(dir, store.ENTRIES_FILE)
  for (const text of ['{ not json', JSON.stringify({ groups: 'x', entries: [] }), JSON.stringify({ version: 1, groups: [], entries: [{ id: 'e1', type: 'nope' }] })]) {
    fs.writeFileSync(file, text)
    const { doc, error } = store.loadEntries(dir)
    assert.equal(doc, null)
    assert.match(error, /^entries\.json (is not valid JSON|cannot be used)/)
    assert.equal(fs.readFileSync(file, 'utf8'), text)
  }
  const doc = { version: 1, groups: [], entries: [] }
  const aside = store.replaceUnreadable(dir, doc)
  assert.match(aside, /^entries\.json\.unreadable-\d+$/)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), doc)
  assert.ok(fs.existsSync(path.join(dir, aside)))
  // With nothing to move aside, the new set is simply written.
  fs.rmSync(file)
  assert.equal(store.replaceUnreadable(dir, doc), null)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), doc)
})

test('each field keeps only a value of its kind, so a stray value cannot break the editor', () => {
  const { doc } = store.checkDocument({
    groups: [],
    entries: [{ id: 'e1', type: 'integration', enabled: 'no', name: 5, output: ['a', 'b'], unit: null, staleTimeout: '30', threshold: {}, minStep: 3, input: 'a.rate' }]
  }, true)
  assert.deepEqual(doc.entries[0], { id: 'e1', group: null, type: 'integration', staleTimeout: '30', input: 'a.rate' })
  const formula = store.checkDocument({ groups: [], entries: [{ id: 'e2', type: 'formula', inputs: [{ name: 1, path: 'a.b' }, 'x'] }] }, true).doc.entries[0]
  assert.deepEqual(formula.inputs, [{ name: '', path: 'a.b' }])
})

test('ids that every JavaScript object carries are refused, and the size is capped', () => {
  for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.deepEqual(store.checkDocument({ groups: [], entries: [{ id, type: 'formula' }] }, true).errors, ['entry 1 has no valid id'], id)
    assert.deepEqual(store.checkDocument({ groups: [{ id, name: 'G' }], entries: [] }, true).errors, ['group 1 has no valid id'], id)
  }
  const big = { groups: [], entries: Array.from({ length: 400 }, (_, i) => ({ id: `e${i}`, type: 'formula', expression: 'x'.repeat(490), name: 'y'.repeat(490), inputs: Array.from({ length: 10 }, () => ({ name: 'n'.repeat(400), path: 'p'.repeat(400) })) })) }
  assert.deepEqual(store.checkDocument(big, true).errors, ['the document is larger than 1024 KB'])
})

test('entries from the plugin settings keep the order the status page showed', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'settings-0.2.1.json'), 'utf8')).configuration
  assert.ok(store.hasListEntries(settings))
  const doc = store.documentFromLists(settings)
  const expected = [...settings.formulas.map((e) => ['formula', e.output]), ...settings.counters.map((e) => ['counter', e.output]), ...settings.integrations.map((e) => ['integration', e.output])]
  assert.deepEqual(doc.entries.map((e) => [e.type, e.output]), expected)
  assert.equal(doc.entries.length, 14)
  assert.deepEqual(doc.groups, [])
  // Every id is new, unique and valid, and no entry is in a group.
  assert.equal(new Set(doc.entries.map((e) => e.id)).size, 14)
  for (const entry of doc.entries) {
    assert.match(entry.id, store.ID_PATTERN)
    assert.equal(entry.group, null)
  }
  // The fields come across unchanged.
  const { id, group, type, ...fields } = doc.entries[2]
  assert.deepEqual(fields, settings.formulas[2])
  // The document passes its own check.
  assert.deepEqual(store.checkDocument(doc, true).errors, [])

  const rest = store.withoutLists(settings)
  assert.ok(!store.hasListEntries(rest))
  assert.deepEqual(Object.keys(rest).sort(), ['dayStart', 'repeatInterval', 'timeZone', 'timeZoneOffsetPath', 'timeZoneRegionPath', 'timeZoneSource', 'weekStart'])
  assert.ok(!store.hasListEntries({ formulas: [], counters: [] }))
})

test('the first copy of the settings keeps its fixed name, later ones are dated', () => {
  const dir = tempDir()
  assert.equal(store.keepSettingsCopy(dir, { configuration: { a: 1 } }), store.SETTINGS_COPY)
  assert.match(store.keepSettingsCopy(dir, { configuration: { a: 2 } }), /^settings-removed-\d+\.json$/)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, store.SETTINGS_COPY), 'utf8')), { configuration: { a: 1 } })
})
