'use strict'

/*
 * Saved state.
 *
 * The plugin keeps one small JSON file holding what each counter and
 * integration needs to carry on after a restart. The file is rewritten in
 * place, never appended to, so it does not grow and holds no history.
 */

const fs = require('fs')
const path = require('path')

const STATE_VERSION = 1
const STATE_FILE = 'state.json'

/**
 * Reads the state file from a directory.
 *
 * A missing file is the normal first-run case and yields no error. A file
 * that exists but cannot be used is moved aside under a dated name instead
 * of being overwritten, so the totals in it can still be recovered by hand,
 * and the reason is returned for the plugin status.
 *
 * @returns {{state: (object|null), error: (string|null)}}
 */
function loadState (dir) {
  const file = path.join(dir, STATE_FILE)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return { state: null, error: null }
    return { state: null, error: `the state file could not be read: ${err.message}` }
  }

  try {
    const state = JSON.parse(text)
    if (!state || typeof state !== 'object' || state.version !== STATE_VERSION || typeof state.entries !== 'object' || state.entries === null) {
      throw new Error('unexpected structure')
    }
    return { state, error: null }
  } catch (err) {
    const aside = `${file}.unreadable-${Date.now()}`
    try {
      fs.renameSync(file, aside)
    } catch (renameErr) {
      // Nothing more can be done; the next save replaces the file.
    }
    return { state: null, error: `the state file was not usable (${err.message}) and was moved to ${path.basename(aside)}; all totals start again` }
  }
}

/**
 * Writes a file so that it is either the old version or the new one, never
 * a mixture.
 *
 * The data goes to a temporary file first, is flushed to the disk, and is
 * then renamed over the real file. A rename within one directory replaces
 * the file in one step, so an interrupted save leaves the old file or the
 * new one. The flush matters on a boat: without it a power cut shortly
 * after the rename could leave the new name pointing at data that never
 * reached the disk.
 */
function writeAtomic (file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  const handle = fs.openSync(temporary, 'w')
  try {
    fs.writeFileSync(handle, text)
    fs.fsyncSync(handle)
  } finally {
    fs.closeSync(handle)
  }
  fs.renameSync(temporary, file)
}

/** Writes the state file; see writeAtomic(). */
function saveState (dir, state) {
  writeAtomic(path.join(dir, STATE_FILE), JSON.stringify({ version: STATE_VERSION, ...state }, null, 2))
}

module.exports = { STATE_FILE, STATE_VERSION, loadState, saveState, writeAtomic }
