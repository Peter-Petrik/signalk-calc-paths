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

test('a state file that cannot be read is left where it is and marked', () => {
  const dir = temporaryDirectory()
  fs.mkdirSync(path.join(dir, STATE_FILE))
  const loaded = loadState(dir)
  assert.equal(loaded.state, null)
  assert.equal(loaded.unreadable, true)
  assert.match(loaded.error, /could not be read/)
  assert.deepEqual(fs.readdirSync(dir), [STATE_FILE])
  // A file that was read but is damaged is not marked: it was moved aside.
  const other = temporaryDirectory()
  fs.writeFileSync(path.join(other, STATE_FILE), '{ not json')
  assert.equal(loadState(other).unreadable, undefined)
})

test('a failed save leaves no temporary file behind', () => {
  const dir = temporaryDirectory()
  fs.mkdirSync(path.join(dir, STATE_FILE))
  assert.throws(() => saveState(dir, { savedAt: 1, entries: {} }))
  assert.deepEqual(fs.readdirSync(dir), [STATE_FILE])
})

test('the directory is flushed after the rename, and a refusal to flush it is passed over', (t) => {
  const dir = temporaryDirectory()
  const opened = new Map()
  const synced = []
  const open = fs.openSync
  const sync = fs.fsyncSync
  let refuse = false
  t.mock.method(fs, 'openSync', function (name, ...rest) {
    const handle = open.call(this, name, ...rest)
    opened.set(handle, name)
    return handle
  })
  t.mock.method(fs, 'fsyncSync', function (handle) {
    synced.push(opened.get(handle))
    if (refuse && opened.get(handle) === dir) throw Object.assign(new Error('EINVAL: invalid argument, fsync'), { code: 'EINVAL' })
    return sync.call(this, handle)
  })
  saveState(dir, { savedAt: 1, entries: {} })
  assert.deepEqual(synced, [path.join(dir, `${STATE_FILE}.tmp`), dir])
  refuse = true
  assert.doesNotThrow(() => saveState(dir, { savedAt: 2, entries: {} }))
  assert.equal(loadState(dir).state.savedAt, 2)
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
