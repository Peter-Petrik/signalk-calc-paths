'use strict'

/*
 * Record entries, from version 0.8.0: the lowest or highest value of an
 * input with the moment it was reached, and the time since the input was
 * last at a level.
 */

const assert = require('node:assert/strict')
const { test } = require('node:test')

const { normalizeConfig } = require('../lib/config')
const { Engine } = require('../lib/engine')
const { checkDocument } = require('../lib/store')

const NOON = Date.parse('2026-10-09T12:00:00Z')
const iso = (seconds, base = NOON) => new Date(base + seconds * 1000).toISOString()

function documentOf (entries) {
  return { version: 1, groups: [], entries: entries.map((entry, index) => ({ id: `e${index + 1}`, type: 'record', ...entry })) }
}

/**
 * A harness around the engine for entries given as an entries document.
 * Time is in seconds after noon UTC on 2026-10-09 and drives both clocks.
 */
function harness (entries, saved, base = NOON, settings = {}) {
  const normalized = normalizeConfig({ timeZone: 'UTC', ...settings }, documentOf(entries))
  for (const entry of normalized.entries) assert.equal(entry.error, null, `${entry.label}: ${entry.error}`)
  const engine = new Engine(normalized, saved || null)
  const values = {}
  const sent = []
  return {
    engine,
    input (seconds, path, value) {
      engine.input(path, value, base + seconds * 1000, seconds * 1000)
    },
    tick (seconds) {
      const published = engine.tick(base + seconds * 1000, seconds * 1000)
      for (const item of published) {
        values[item.path] = item.value
        sent.push({ seconds, ...item })
      }
      return published
    },
    value: (path) => values[path],
    sent,
    save: (seconds) => JSON.parse(JSON.stringify(engine.serialize(base + seconds * 1000))),
    state: (output, seconds) => engine.snapshot(base + seconds * 1000, seconds * 1000).find((e) => e.output === output)
  }
}

const LOWEST = { input: 'b.soc', keep: 'lowest', output: 'b.lowest', timeOutput: 'b.lowestTime', staleTimeout: 0 }

test('a lowest value is kept with the moment it was first reached', () => {
  const h = harness([LOWEST])
  h.input(0, 'b.soc', 0.8)
  h.tick(0)
  assert.equal(h.value('b.lowest'), 0.8)
  assert.equal(h.value('b.lowestTime'), iso(0))
  h.input(5, 'b.soc', 0.7)
  h.tick(5)
  assert.equal(h.value('b.lowest'), 0.7)
  assert.equal(h.value('b.lowestTime'), iso(5))
  // Equal and higher values leave the record and its moment alone.
  h.input(8, 'b.soc', 0.7)
  h.input(9, 'b.soc', 0.9)
  h.tick(9)
  assert.equal(h.value('b.lowest'), 0.7)
  assert.equal(h.value('b.lowestTime'), iso(5))
  const state = h.state('b.lowest', 9)
  assert.equal(state.state, 'ok')
  assert.deepEqual(state.record, { value: 0.7, at: iso(5) })
  assert.equal(state.canReset, true)
})

test('a highest value is kept the same way', () => {
  const h = harness([{ ...LOWEST, keep: 'highest', output: 'b.highest', timeOutput: '' }])
  for (const [s, v] of [[0, 0.5], [1, 0.9], [2, 0.6]]) h.input(s, 'b.soc', v)
  h.tick(2)
  assert.equal(h.value('b.highest'), 0.9)
  assert.deepEqual(h.state('b.highest', 2).record, { value: 0.9, at: iso(1) })
  // Without a path for the time nothing else is published.
  assert.deepEqual(Object.keys(Object.fromEntries(h.sent.map((item) => [item.path, 1]))), ['b.highest'])
})

test('the lowest since the input last reached a level starts again at the level', () => {
  const h = harness([{ ...LOWEST, resets: 'level', resetLevel: 1 }])
  h.input(0, 'b.soc', 0.6)
  h.input(10, 'b.soc', 0.5)
  h.tick(10)
  assert.equal(h.value('b.lowest'), 0.5)
  // Full: while the battery is full, the lowest since it was last full is
  // its present charge.
  h.input(20, 'b.soc', 1)
  h.tick(20)
  assert.equal(h.value('b.lowest'), 1)
  assert.equal(h.value('b.lowestTime'), iso(20))
  const first = h.state('b.lowest', 20).lastReset
  assert.deepEqual(first, { at: iso(20), cause: 'level', level: 1 })
  // Staying full moves the record along, but the reason is recorded once.
  h.input(30, 'b.soc', 1)
  h.tick(30)
  assert.deepEqual(h.state('b.lowest', 30).lastReset, first)
  h.input(40, 'b.soc', 0.98)
  h.input(50, 'b.soc', 0.95)
  h.tick(50)
  assert.equal(h.value('b.lowest'), 0.95)
  assert.equal(h.value('b.lowestTime'), iso(50))
})

test('the time since the input was last at a level grows by itself and is 0 at the level', () => {
  const h = harness([{ input: 'b.soc', keep: 'sinceAbove', level: 1, output: 'b.sinceFull', timeOutput: 'b.lastFull', staleTimeout: 0 }])
  assert.equal(h.engine.entries[0].config.unit, 's')
  h.input(0, 'b.soc', 0.9)
  h.tick(0)
  // Never at the level: nothing to publish yet.
  assert.equal(h.value('b.sinceFull'), undefined)
  assert.equal(h.state('b.sinceFull', 0).state, 'waiting')
  h.input(10, 'b.soc', 1)
  h.tick(10)
  assert.equal(h.value('b.sinceFull'), 0)
  assert.equal(h.value('b.lastFull'), iso(10))
  // At the level the time follows the input, sent at most once a minute.
  for (let s = 11; s <= 69; s++) {
    h.input(s, 'b.soc', 1)
    h.tick(s)
  }
  // Repeated at the repeat interval, the time first sent stays the one sent.
  assert.deepEqual([...new Set(h.sent.filter((item) => item.path === 'b.lastFull').map((item) => item.value))], [iso(10)])
  h.input(70, 'b.soc', 1)
  h.tick(70)
  assert.equal(h.value('b.lastFull'), iso(70))
  h.input(75, 'b.soc', 1)
  h.input(76, 'b.soc', 0.99)
  // Leaving the level sends the exact last moment at once.
  h.tick(76)
  assert.equal(h.value('b.lastFull'), iso(75))
  assert.equal(h.value('b.sinceFull'), 1)
  // With no input at all the time goes on growing.
  h.tick(3676)
  assert.equal(h.value('b.sinceFull'), 3601)
  assert.equal(h.state('b.sinceFull', 3676).canReset, false)
  assert.equal(h.engine.reset('b.sinceFull', NOON + 3676000, 3676000), false)
})

test('a time since a value was last at or below a level', () => {
  const h = harness([{ input: 'w.level', keep: 'sinceBelow', level: 0.1, output: 'w.sinceEmpty', staleTimeout: 0 }])
  h.input(0, 'w.level', 0.05)
  h.input(5, 'w.level', 0.5)
  h.tick(65)
  assert.equal(h.value('w.sinceEmpty'), 65)
})

test('a daily lowest starts again at midnight from the latest value', () => {
  const base = Date.parse('2026-10-09T23:59:00Z')
  const h = harness([{ ...LOWEST, resets: 'day' }], null, base)
  h.input(0, 'b.soc', 0.4)
  h.input(30, 'b.soc', 0.45)
  h.tick(30)
  assert.equal(h.value('b.lowest'), 0.4)
  h.tick(61)
  assert.equal(h.value('b.lowest'), 0.45)
  assert.equal(h.value('b.lowestTime'), '2026-10-10T00:00:00.000Z')
  const state = h.state('b.lowest', 61)
  assert.equal(state.lastReset.cause, 'period')
  assert.equal(state.windowStart, '2026-10-10T00:00:00.000Z')
})

test('a record starts again when a followed path falls', () => {
  const h = harness([{ ...LOWEST, resets: 'path', resetPath: 'b.cycle' }])
  h.input(0, 'b.cycle', 5)
  h.input(1, 'b.soc', 0.4)
  h.input(2, 'b.soc', 0.6)
  h.input(3, 'b.cycle', 0)
  h.tick(3)
  assert.equal(h.value('b.lowest'), 0.6)
  assert.equal(h.state('b.lowest', 3).lastReset.cause, 'path')
})

test('a lowest value starts again by request, a time since does not', () => {
  const h = harness([LOWEST])
  h.input(0, 'b.soc', 0.4)
  h.input(5, 'b.soc', 0.7)
  h.tick(5)
  assert.equal(h.engine.reset('b.lowest', NOON + 6000, 6000), true)
  h.tick(6)
  assert.equal(h.value('b.lowest'), 0.7)
  assert.equal(h.value('b.lowestTime'), iso(6))
  assert.equal(h.state('b.lowest', 6).lastReset.cause, 'request')
})

test('a record is saved and carried on after a restart', () => {
  const h = harness([{ ...LOWEST, onStale: 'hold' }, { input: 'b.soc', keep: 'sinceAbove', level: 1, output: 'b.sinceFull', timeOutput: 'b.lastFull', staleTimeout: 0, onStale: 'hold' }])
  h.input(0, 'b.soc', 1)
  h.input(10, 'b.soc', 0.6)
  h.tick(10)
  const saved = h.save(10)
  assert.equal(saved.entries['b.lowest'].record.value, 0.6)
  assert.equal(saved.entries['b.sinceFull'].lastMet, NOON)
  const later = harness([{ ...LOWEST, onStale: 'hold' }, { input: 'b.soc', keep: 'sinceAbove', level: 1, output: 'b.sinceFull', timeOutput: 'b.lastFull', staleTimeout: 0, onStale: 'hold' }], saved, NOON + 3600000)
  later.tick(0)
  assert.equal(later.value('b.lowest'), 0.6)
  assert.equal(later.value('b.lowestTime'), iso(10))
  assert.equal(later.value('b.sinceFull'), 3600)
  assert.equal(later.value('b.lastFull'), iso(0))
  // A changed measurement starts the record afresh.
  const changed = harness([{ ...LOWEST, keep: 'highest' }], saved, NOON + 3600000)
  changed.tick(0)
  assert.equal(changed.value('b.lowest'), undefined)
})

test('a start entered by hand is taken in when it beats the record', () => {
  const h = harness([{ ...LOWEST, startValue: 0.37, startTime: '2026-10-07T03:00:00Z' }, { input: 'b.soc', keep: 'sinceAbove', level: 1, output: 'b.sinceFull', staleTimeout: 0, startTime: '2026-09-24T14:05:00Z' }])
  h.input(0, 'b.soc', 0.5)
  h.tick(0)
  assert.equal(h.value('b.lowest'), 0.37)
  assert.deepEqual(h.state('b.lowest', 0).record, { value: 0.37, at: '2026-10-07T03:00:00.000Z' })
  assert.equal(h.value('b.sinceFull'), (NOON - Date.parse('2026-09-24T14:05:00Z')) / 1000)
  // While it is not known when the record last started again, the start
  // counts; once the battery has been full since, it no longer does.
  const level = { ...LOWEST, resets: 'level', resetLevel: 1, startValue: 0.37, startTime: '2026-10-07T03:00:00Z' }
  const later = harness([level])
  later.input(0, 'b.soc', 0.9)
  later.tick(0)
  assert.equal(later.value('b.lowest'), 0.37)
  later.input(1, 'b.soc', 1)
  later.input(2, 'b.soc', 0.8)
  later.tick(2)
  assert.equal(later.value('b.lowest'), 0.8)
  const after = harness([level], later.save(2), NOON + 10000)
  after.input(0, 'b.soc', 0.85)
  after.tick(0)
  assert.equal(after.value('b.lowest'), 0.8)
})

test('a record takes in no values while the clock cannot be trusted', () => {
  const h = harness([LOWEST], null, Date.parse('1970-01-02T00:00:00Z'))
  h.input(0, 'b.soc', 0.5)
  h.tick(0)
  assert.equal(h.value('b.lowest'), undefined)
  assert.equal(h.state('b.lowest', 0).state, 'waiting')
})

test('a record that stops publishing sends null on its output and its time', () => {
  const h = harness([{ ...LOWEST, staleTimeout: 10 }])
  h.input(0, 'b.soc', 0.5)
  h.tick(0)
  assert.equal(h.value('b.lowestTime'), iso(0))
  h.tick(11)
  assert.equal(h.value('b.lowest'), null)
  assert.equal(h.value('b.lowestTime'), null)
  h.input(12, 'b.soc', 0.6)
  h.tick(12)
  assert.equal(h.value('b.lowest'), 0.5)
  assert.equal(h.value('b.lowestTime'), iso(0))
})

test('the settings of a record are checked', () => {
  const check = (entry) => normalizeConfig({ timeZone: 'UTC' }, documentOf([entry])).entries[0]
  assert.equal(check({ input: 'a.b', keep: 'sinceAbove', output: 'x.y' }).faults[0].field, 'level')
  assert.equal(check({ ...LOWEST, resets: 'level' }).faults[0].field, 'resetLevel')
  assert.equal(check({ ...LOWEST, timeOutput: 'b.lowest' }).faults[0].field, 'timeOutput')
  assert.equal(check({ ...LOWEST, startValue: 0.3 }).faults[0].field, 'startTime')
  assert.equal(check({ ...LOWEST, startTime: '2026-10-07T03:00:00Z' }).faults[0].field, 'startValue')
  // A time without a zone could mean any of three clocks.
  assert.match(check({ ...LOWEST, startValue: 0.3, startTime: '2026-10-07 03:00' }).error, /time zone/)
  assert.equal(check({ input: 'a.b', keep: 'sinceAbove', level: 1, output: 'x.y', startTime: '2026-10-07T03:00:00+02:00' }).error, null)
  // No other entry may write the path for the time.
  const both = normalizeConfig({ timeZone: 'UTC' }, documentOf([LOWEST, { ...LOWEST, output: 'b.lowestTime', timeOutput: '' }])).entries
  assert.match(both[1].error, /already written/)
})

test('the entries file keeps the fields of a record', () => {
  const entry = { id: 'e1', type: 'record', ...LOWEST, resets: 'level', resetLevel: 1, resetPath: 'p.q', startValue: '0,37', startTime: '2026-10-07T03:00:00Z', lookback: false, level: 1, stray: 'x' }
  const { doc } = checkDocument({ groups: [], entries: [entry] }, true)
  const kept = doc.entries[0]
  assert.equal(kept.stray, undefined)
  assert.equal(kept.lookback, false)
  assert.equal(kept.startValue, '0,37')
  assert.equal(normalizeConfig({}, doc).entries[0].startValue, 0.37)
})

// ------------------------------------------------- found by review of 0.8.0

test('a time since stays 0 while the input holds at the level between values', () => {
  const h = harness([{ input: 's.shore', keep: 'sinceAbove', level: 1, output: 's.sinceShore', staleTimeout: 0 }])
  h.input(0, 's.shore', true)
  h.tick(0)
  for (let t = 1; t <= 7200; t += 600) h.tick(t)
  assert.equal(h.value('s.sinceShore'), 0)
  assert.equal(h.state('s.sinceShore', 7200).atLevel, true)
  h.input(7300, 's.shore', false)
  h.tick(7300)
  h.tick(7400)
  // Last at the level when the next value said otherwise was not yet known:
  // the moment of the last value at the level counts.
  assert.equal(h.value('s.sinceShore'), 7400)
})

test('a start value from before a daily record\'s day is not taken in', () => {
  const h = harness([{ ...LOWEST, resets: 'day', startValue: 0.2, startTime: iso(-17 * 3600) }])
  h.tick(0)
  assert.equal(h.value('b.lowest'), undefined)
  assert.equal(h.state('b.lowest', 0).record, null)
  // One from today is.
  const today = harness([{ ...LOWEST, resets: 'day', startValue: 0.2, startTime: iso(-3600) }])
  today.tick(0)
  assert.equal(today.value('b.lowest'), 0.2)
})

test('a value held from before the day began is not taken into today\'s record', () => {
  // Restarted ten minutes after midnight; the server still holds a value
  // from ten minutes before it.
  const midnight = Date.parse('2026-10-10T00:00:00Z')
  const base = midnight + 600000
  const h = harness([{ ...LOWEST, resets: 'day', staleTimeout: 60 }], null, base)
  // Handed over at start-up, twenty minutes old: counted from 20 minutes
  // on the monotonic clock.
  h.engine.input('b.soc', 0.4, base, 0, 1200000)
  h.engine.tick(base, 1200000)
  assert.equal(h.engine.snapshot(base, 1200000)[0].record, null)
  h.engine.input('b.soc', 0.7, base + 10000, 1210000)
  h.engine.tick(base + 10000, 1210000)
  assert.equal(h.engine.snapshot(base + 10000, 1210000)[0].record.value, 0.7)
  // An input that is never stale starts today's record from its value, as
  // the boundary itself would have, dated at midnight.
  const kept = harness([{ ...LOWEST, resets: 'day' }], null, base)
  kept.engine.input('b.soc', 0.4, base, 0, 1200000)
  kept.engine.tick(base, 1200000)
  assert.deepEqual(kept.engine.snapshot(base, 1200000)[0].record, { value: 0.4, at: new Date(midnight).toISOString() })
})

test('a lowest reached under a clock that ran ahead survives the clock being set back', () => {
  const day = 24 * 3600
  const h = harness([{ ...LOWEST, resets: 'manual' }])
  h.engine.input('b.soc', 0.3, NOON + day * 1000, 0)
  h.engine.tick(NOON + day * 1000, 0)
  // Set back, and the next value comes before the next tick.
  h.engine.input('b.soc', 0.8, NOON + 1000, 1000)
  const state = h.engine.snapshot(NOON + 1000, 1000)[0]
  assert.equal(state.record.value, 0.3)
  assert.equal(state.record.at, iso(0))
})

test('a time since counts on once its input has no reading', () => {
  const h = harness([{ input: 'b.soc', keep: 'sinceAbove', level: 1, output: 'b.sinceFull', staleTimeout: 0 }])
  h.input(0, 'b.soc', 1)
  h.tick(0)
  h.input(10, 'b.soc', null)
  h.tick(10)
  h.tick(3600)
  assert.equal(h.value('b.sinceFull'), 3600)
})

test('the moment of a record held at its starting level is sent at most once a minute', () => {
  const h = harness([{ ...LOWEST, resets: 'level', resetLevel: 1 }])
  for (let t = 0; t <= 180; t++) {
    h.input(t, 'b.soc', 1)
    h.tick(t)
  }
  const times = h.sent.filter((item) => item.path === 'b.lowestTime')
  // The first value at the level, then one a minute; the repeat interval
  // resends the moment last sent.
  const moved = [...new Set(times.map((item) => item.value))]
  assert.ok(moved.length <= 4, String(moved.length))
  h.input(181, 'b.soc', 0.9)
  h.tick(181)
  assert.equal(h.value('b.lowestTime'), iso(181))
})

test('a moment dated by a clock that ran ahead is moved back once the clock is right', () => {
  const day = 24 * 3600
  const h = harness([{ input: 'b.soc', keep: 'sinceAbove', level: 1, output: 'b.sinceFull', staleTimeout: 0 }])
  // For a minute the clock reads a day ahead while the battery is full.
  const ahead = (seconds) => NOON + (seconds + day) * 1000
  h.engine.input('b.soc', 1, ahead(0), 0)
  h.engine.tick(ahead(0), 0)
  // Then it is set right, and the battery leaves full.
  h.input(60, 'b.soc', 0.9)
  h.tick(60)
  h.tick(3 * 3600)
  const value = h.value('b.sinceFull')
  assert.ok(Math.abs(value - (3 * 3600)) <= 120, String(value))
})
