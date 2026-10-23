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
 * that was read but cannot be used is moved aside under a dated name instead
 * of being overwritten, so the totals in it can still be recovered by hand,
 * and the reason is returned for the plugin status.
 *
 * A file that cannot be read at all (a disk error, a permission, a folder
 * in its place) may well hold good totals, and nothing about it is known.
 * It is left where it is and marked `unreadable`: the plugin then saves
 * nothing until a later start reads it, since any save would replace it.
 *
 * @returns {{state: (object|null), error: (string|null), unreadable: (boolean|undefined)}}
 */
function loadState (dir) {
  const file = path.join(dir, STATE_FILE)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return { state: null, error: null }
    return {
      state: null,
      error: `the state file could not be read (${err.message}). The totals start from zero for now and are not saved, so that the file is not written over; once it can be read, restart the plugin to carry on from it`,
      unreadable: true
    }
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
 *
 * The rename itself is an entry in the directory, which the file system may
 * also hold back in memory; the directory is therefore flushed as well. A
 * failed write removes the temporary file, so that no half-written copy is
 * left beside the real one.
 */
function writeAtomic (file, text) {
  const directory = path.dirname(file)
  fs.mkdirSync(directory, { recursive: true })
  const temporary = `${file}.tmp`
  try {
    const handle = fs.openSync(temporary, 'w')
    try {
      fs.writeFileSync(handle, text)
      fs.fsyncSync(handle)
    } finally {
      fs.closeSync(handle)
    }
    fs.renameSync(temporary, file)
  } catch (err) {
    try {
      fs.unlinkSync(temporary)
    } catch (unlinkErr) {
      // There was none, or it cannot be removed either; the error that
      // matters is the one thrown below.
    }
    throw err
  }
  syncDirectory(directory)
}

/**
 * Flushes a directory's entries to the disk. Some systems refuse this
 * (Windows cannot open a directory as a file, and some file systems do not
 * flush directories); the file itself is written by then, so a refusal is
 * passed over.
 */
function syncDirectory (directory) {
  let handle
  try {
    handle = fs.openSync(directory, 'r')
    fs.fsyncSync(handle)
  } catch (err) {
    // See above.
  } finally {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle)
      } catch (err) {
        // Nothing to do.
      }
    }
  }
}

/** Writes the state file; see writeAtomic(). */
function saveState (dir, state) {
  writeAtomic(path.join(dir, STATE_FILE), JSON.stringify({ version: STATE_VERSION, ...state }, null, 2))
}

module.exports = { STATE_FILE, STATE_VERSION, loadState, saveState, writeAtomic }
