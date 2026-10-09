'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const { STATE_FILE, loadState, saveState } = require('../lib/state')

const temporaryDirectory = () => fs.mkdtempSync(path.join(os.tmpdir(), 'calc-paths-state-'))

test('a missing state file is not an error', () => {
  const dir = temporaryDirectory()
  assert.deepEqual(loadState(dir), { state: null, error: null })
  assert.deepEqual(loadState(path.join(dir, 'does-not-exist')), { state: null, error: null })
})

test('state is written and read back unchanged', () => {
  const dir = temporaryDirectory()
  const state = { savedAt: 1791547200000, entries: { 'a.today': { signature: 'counter|a.total|increase', total: 12.5, last: 1000, since: 1791504000000, periodStart: 1791504000000, referenceLast: null } } }
  saveState(dir, state)
  const loaded = loadState(dir)
  assert.equal(loaded.error, null)
  assert.deepEqual(loaded.state, { version: 1, ...state })
  // Only the state file is left behind, no temporary file.
  assert.deepEqual(fs.readdirSync(dir), [STATE_FILE])
})

test('saving replaces the file instead of growing it', () => {
  const dir = temporaryDirectory()
  for (let i = 0; i < 50; i++) saveState(dir, { savedAt: i, entries: { 'a.b': { total: i } } })
  assert.equal(loadState(dir).state.entries['a.b'].total, 49)
  assert.ok(fs.statSync(path.join(dir, STATE_FILE)).size < 200)
})

test('the data directory is created when it does not exist yet', () => {
  const dir = path.join(temporaryDirectory(), 'nested', 'signalk-calc-paths')
  saveState(dir, { savedAt: 1, entries: {} })
  assert.equal(loadState(dir).error, null)
})

test('an unusable state file is moved aside and reported', () => {
  for (const content of ['{ not json', '[]', '{"version":99,"entries":{}}', '{"version":1}']) {
    const dir = temporaryDirectory()
    fs.writeFileSync(path.join(dir, STATE_FILE), content)
    const loaded = loadState(dir)
    assert.equal(loaded.state, null)
    assert.match(loaded.error, /not usable/)
    const files = fs.readdirSync(dir)
    assert.equal(files.length, 1)
    assert.match(files[0], /^state\.json\.unreadable-\d+$/)
    assert.equal(fs.readFileSync(path.join(dir, files[0]), 'utf8'), content)
  }
})
