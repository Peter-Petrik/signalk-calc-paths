'use strict'

/*
 * The entries file.
 *
 * From version 0.3.0 the entries and their groups are kept in entries.json
 * in the plugin's data directory, beside state.json, and are edited on the
 * plugin's page under Webapps. The plugin settings keep only what applies to
 * every entry: the time zone, the day start, the week start and the repeat
 * interval.
 *
 * Keeping entries out of the plugin settings has two reasons. Saving the
 * settings makes the server stop and start the whole plugin, so every edit
 * would interrupt every total; the page instead applies an edit to the
 * entries that changed and leaves the others running. And with one place to
 * edit entries, the settings form and the page cannot overwrite each
 * other's changes.
 *
 * The file holds the groups in the order they are shown and the entries in
 * the order they are shown within their groups:
 *
 *   {
 *     "version": 1,
 *     "groups": [{ "id": "g1a2b3c4d", "name": "Solar" }],
 *     "entries": [{ "id": "e5f6a7b8c", "group": "g1a2b3c4d", "type": "formula", ... }]
 *   }
 *
 * An entry carries the same fields as the entries in the plugin settings of
 * versions 0.1.0 to 0.2.1, plus its id, its group and its type.
 */

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const { writeAtomic } = require('./state')

const ENTRIES_FILE = 'entries.json'
const ENTRIES_VERSION = 1
// The copy of the plugin settings made when their entries are moved into
// the entries file. Restoring it is the way back to version 0.2.1.
const SETTINGS_COPY = 'settings-before-0.3.0.json'

const TYPES = ['formula', 'counter', 'integration', 'cycles']
// The three lists of the plugin settings of versions 0.1.0 to 0.2.1, in
// the order their entries were shown.
const LISTS = [['formulas', 'formula'], ['counters', 'counter'], ['integrations', 'integration']]

// The fields kept for each type. Anything else is dropped on saving, so the
// file holds nothing the plugin does not read.
const COMMON_FIELDS = ['enabled', 'name', 'output', 'unit', 'staleTimeout', 'onStale']
// Fields that hold a number. An emptied or typed-in number may arrive as
// text, which the configuration reader accepts; anything else is dropped.
const NUMBER_FIELDS = new Set(['staleTimeout', 'minStep', 'threshold', 'window', 'minCycles', 'smoothing', 'shortest', 'longest', 'swing'])
const TYPE_FIELDS = {
  formula: ['inputs', 'expression'],
  counter: ['input', 'resets', 'resetPath', 'direction', 'reversal', 'minStep'],
  integration: ['input', 'mode', 'threshold', 'resets', 'resetPath', 'gap'],
  cycles: ['inputs', 'combine', 'statistic', 'window', 'minCycles', 'smoothing', 'shortest', 'longest']
}

// The fields of one input, by entry type.
const INPUT_FIELDS = {
  formula: ['name', 'path'],
  cycles: ['path', 'kind', 'threshold', 'direction', 'swing']
}

/** Keeps a value of the kind a field holds; see pickFields(). */
function keepValue (target, field, value) {
  if (value === undefined) return
  if (field === 'enabled') {
    if (typeof value === 'boolean') target.enabled = value
  } else if (NUMBER_FIELDS.has(field)) {
    if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'string') target[field] = value
  } else if (typeof value === 'string') {
    target[field] = value
  }
}

// Limits that keep a mistaken or hostile request from filling the disk or
// the page. They are far above any boat's needs.
const MAX_ENTRIES = 500
const MAX_GROUPS = 100
const MAX_INPUTS = 50
const MAX_TEXT = 500
const MAX_DOCUMENT = 1024 * 1024
const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/

/**
 * Whether an id can be used. Names every JavaScript object carries, such
 * as "constructor" or "__proto__", are refused: ids are used as keys of
 * plain objects, where such a name would not behave as a key.
 */
function validId (id) {
  return typeof id === 'string' && ID_PATTERN.test(id) && !(id in {}) && id !== '__proto__'
}

/** A new id: a letter for the kind of thing, then eight hex digits. */
function newId (prefix) {
  return `${prefix}${crypto.randomBytes(4).toString('hex')}`
}

function isObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Copies the fields an entry of the given type uses. Values are copied as
 * they are, unchecked: whether they make a runnable entry is decided by
 * normalizeConfig(), which reports a bad field on the entry itself.
 */
function pickFields (raw, type) {
  const entry = {}
  for (const field of [...COMMON_FIELDS, ...TYPE_FIELDS[type]]) {
    const value = raw[field]
    if (value === undefined) continue
    // Each field keeps only a value of the kind it holds, so a stray value
    // can neither break the editor nor slip past the length limit.
    if (field === 'enabled') {
      if (typeof value === 'boolean') entry.enabled = value
    } else if (field === 'inputs') {
      if (Array.isArray(value)) {
        entry.inputs = value.filter(isObject).map((input) => {
          const kept = {}
          for (const name of INPUT_FIELDS[type]) keepValue(kept, name, input[name])
          // A formula's input always has its two texts.
          if (type === 'formula') return { name: kept.name || '', path: kept.path || '' }
          return kept
        })
      }
    } else if (NUMBER_FIELDS.has(field)) {
      if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'string') entry[field] = value
    } else if (typeof value === 'string') {
      entry[field] = value
    }
  }
  return entry
}

/** Whether a field holds text longer than the limit, at any depth. */
function tooLong (value) {
  if (typeof value === 'string') return value.length > MAX_TEXT
  if (Array.isArray(value)) return value.some(tooLong)
  if (isObject(value)) return Object.values(value).some(tooLong)
  return false
}

/**
 * Checks the structure of an entries document: the parts the plugin needs
 * to find its way around it. Whether each entry can run is a separate
 * question, answered by normalizeConfig().
 *
 * With `strict` (a document sent by the page) every fault is reported and
 * nothing is repaired. Without it (the file read at start-up) an entry
 * that names a group that does not exist is shown without a group instead,
 * so that one stray reference cannot stop every entry.
 *
 * @returns {{doc: (object|null), errors: string[]}}
 */
function checkDocument (raw, strict) {
  const errors = []
  if (!isObject(raw)) return { doc: null, errors: ['the document is not a JSON object'] }
  if (strict && JSON.stringify(raw).length > MAX_DOCUMENT) return { doc: null, errors: [`the document is larger than ${MAX_DOCUMENT / 1024} KB`] }
  if (raw.version !== undefined && raw.version !== ENTRIES_VERSION) {
    return { doc: null, errors: [`version ${raw.version} is not known to this version of the plugin`] }
  }
  if (!Array.isArray(raw.groups)) errors.push('"groups" is not a list')
  if (!Array.isArray(raw.entries)) errors.push('"entries" is not a list')
  if (errors.length > 0) return { doc: null, errors }
  if (raw.groups.length > MAX_GROUPS) errors.push(`more than ${MAX_GROUPS} groups`)
  if (raw.entries.length > MAX_ENTRIES) errors.push(`more than ${MAX_ENTRIES} entries`)
  if (errors.length > 0) return { doc: null, errors }

  const groups = []
  const groupIds = new Set()
  raw.groups.forEach((group, index) => {
    if (!isObject(group) || !validId(group.id)) {
      errors.push(`group ${index + 1} has no valid id`)
      return
    }
    if (groupIds.has(group.id)) {
      errors.push(`the group id "${group.id}" is used twice`)
      return
    }
    const name = typeof group.name === 'string' ? group.name.trim() : ''
    if (name === '' && strict) errors.push(`group ${index + 1} has no name`)
    if (name.length > MAX_TEXT) errors.push(`the name of group ${index + 1} is too long`)
    groupIds.add(group.id)
    groups.push({ id: group.id, name: name || 'Unnamed group' })
  })

  const entries = []
  const entryIds = new Set()
  raw.entries.forEach((entry, index) => {
    const label = `entry ${index + 1}`
    if (!isObject(entry)) {
      errors.push(`${label} is not an object`)
      return
    }
    if (!validId(entry.id)) {
      errors.push(`${label} has no valid id`)
      return
    }
    if (entryIds.has(entry.id)) {
      errors.push(`the entry id "${entry.id}" is used twice`)
      return
    }
    if (!TYPES.includes(entry.type)) {
      errors.push(`${label} has no known type (formula, counter, integration or cycles)`)
      return
    }
    let group = entry.group === undefined || entry.group === '' ? null : entry.group
    if (group !== null && !groupIds.has(group)) {
      if (strict) {
        errors.push(`${label} names a group that does not exist`)
        return
      }
      group = null
    }
    const fields = pickFields(entry, entry.type)
    if (Array.isArray(fields.inputs) && fields.inputs.length > MAX_INPUTS) errors.push(`${label} has more than ${MAX_INPUTS} inputs`)
    if (tooLong(fields)) errors.push(`${label} has a text longer than ${MAX_TEXT} characters`)
    entryIds.add(entry.id)
    entries.push({ id: entry.id, group, type: entry.type, ...fields })
  })

  if (errors.length > 0) return { doc: null, errors }
  return { doc: { version: ENTRIES_VERSION, groups, entries }, errors: [] }
}

/**
 * Reads the entries file.
 *
 * A missing file yields `doc: null` and no error: either the plugin is new
 * or its entries are still in the plugin settings. A file that exists but
 * cannot be used is left exactly where it is and reported. It is never
 * replaced by an empty set: the entries in it would be lost, and with them,
 * at the next save, every saved total.
 *
 * @returns {{doc: (object|null), error: (string|null)}}
 */
function loadEntries (dir) {
  const file = path.join(dir, ENTRIES_FILE)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return { doc: null, error: null }
    return { doc: null, error: `${ENTRIES_FILE} could not be read: ${err.message}` }
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return { doc: null, error: `${ENTRIES_FILE} is not valid JSON (${err.message})` }
  }
  const { doc, errors } = checkDocument(raw, false)
  if (!doc) return { doc: null, error: `${ENTRIES_FILE} cannot be used: ${errors[0]}` }
  return { doc, error: null }
}

/** Writes the entries file in one step; see writeAtomic(). */
function saveEntries (dir, doc) {
  writeAtomic(path.join(dir, ENTRIES_FILE), JSON.stringify(doc, null, 2) + '\n')
}

/**
 * Replaces an unusable entries file with a new set, keeping the old file
 * under a dated name. The new set is written in full first, so a failed
 * write leaves the old file where it was. Returns the name the old file
 * was given, or null when there was none.
 */
function replaceUnreadable (dir, doc) {
  const file = path.join(dir, ENTRIES_FILE)
  const incoming = `${file}.incoming`
  writeAtomic(incoming, JSON.stringify(doc, null, 2) + '\n')
  const aside = `${file}.unreadable-${Date.now()}`
  let moved = true
  try {
    fs.renameSync(file, aside)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    moved = false
  }
  fs.renameSync(incoming, file)
  return moved ? path.basename(aside) : null
}

/** Whether plugin settings hold entries in the lists of versions before 0.3.0. */
function hasListEntries (configuration) {
  return isObject(configuration) && LISTS.some(([list]) => Array.isArray(configuration[list]) && configuration[list].some(isObject))
}

/**
 * Builds an entries document from the lists of the plugin settings, in the
 * order the status page of version 0.2.1 showed them: formulas, then
 * counters, then integrations. No entry is put in a group.
 */
function documentFromLists (configuration) {
  const entries = []
  for (const [list, type] of LISTS) {
    const items = isObject(configuration) && Array.isArray(configuration[list]) ? configuration[list] : []
    for (const item of items) {
      if (!isObject(item)) continue
      entries.push({ id: newId('e'), group: null, type, ...pickFields(item, type) })
    }
  }
  return { version: ENTRIES_VERSION, groups: [], entries }
}

/** The plugin settings without the three lists. */
function withoutLists (configuration) {
  const copy = { ...configuration }
  for (const [list] of LISTS) delete copy[list]
  return copy
}

/**
 * Writes a copy of the plugin settings before their lists are removed. The
 * first copy is kept under SETTINGS_COPY, the way back to version 0.2.1;
 * a later one, made when lists turn up again, gets a dated name.
 */
function keepSettingsCopy (dir, options) {
  let name = SETTINGS_COPY
  if (fs.existsSync(path.join(dir, name))) name = `settings-removed-${Date.now()}.json`
  writeAtomic(path.join(dir, name), JSON.stringify(options, null, 2) + '\n')
  return name
}

module.exports = {
  ENTRIES_FILE,
  ENTRIES_VERSION,
  ID_PATTERN,
  MAX_ENTRIES,
  SETTINGS_COPY,
  TYPES,
  checkDocument,
  documentFromLists,
  hasListEntries,
  keepSettingsCopy,
  loadEntries,
  newId,
  replaceUnreadable,
  saveEntries,
  validId,
  withoutLists
}
