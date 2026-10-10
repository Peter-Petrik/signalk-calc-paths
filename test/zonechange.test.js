'use strict'

/*
 * What happens to period totals when the time zone changes while the plugin
 * runs, as it does when the ship's time is followed and the ship changes
 * zone. The rule under test: a period is known by its calendar date, a new
 * period begins when a later date does, and no total is cleared twice for
 * one date.
 */

const assert = require('node:assert/strict')
const { test } = require('node:test')

const { normalizeConfig } = require('../lib/config')
const { Engine } = require('../lib/engine')

/**
 * A harness that takes times as ISO text. The monotonic clock runs in step
 * with the wall clock, as in normal running.
 */
function harness (options, { zone = 'UTC', saved = null, base = '2026-10-10T00:00:00Z' } = {}) {
  const normalized = normalizeConfig(options)
  for (const entry of normalized.entries) assert.equal(entry.error, null, `${entry.label}: ${entry.error}`)
  const engine = new Engine(normalized, saved, zone)
  const origin = Date.parse(base)
  const wall = (time) => Date.parse(time)
  const mono = (time) => Date.parse(time) - origin
  const values = {}
  return {
    engine,
    input (time, path, value) {
      engine.input(path, value, wall(time), mono(time))
    },
    tick (time) {
      const published = engine.tick(wall(time), mono(time))
      for (const { path, value } of published) values[path] = value
      return published
    },
    zone (name) {
      return engine.setTimeZone(name)
    },
    value: (path) => values[path],
    state: (output, time) => engine.snapshot(wall(time), mono(time)).find((e) => e.output === output),
    save: (time) => JSON.parse(JSON.stringify(engine.serialize(wall(time))))
  }
}

// The inputs in these tests arrive minutes apart, so the entries are given a
// stale timeout of zero: what is tested here is the calendar, not staleness.
const dailyCounter = { counters: [{ input: 'a.total', output: 'a.today', resets: 'day', staleTimeout: 0 }] }

// In October 2026 Rome is two hours ahead of UTC and Athens three. Midnight
// in Athens is 21:00 UTC; midnight in Rome is 22:00 UTC.

test('going east over midnight starts the new day at once', () => {
  const h = harness(dailyCounter, { zone: 'Europe/Rome' })
  h.input('2026-10-10T21:00:00Z', 'a.total', 1000)
  h.input('2026-10-10T21:20:00Z', 'a.total', 1500)
  h.tick('2026-10-10T21:20:00Z')
  assert.equal(h.value('a.today'), 500)

  // 23:30 in Rome on the 10th becomes 00:30 in Athens on the 11th.
  assert.equal(h.zone('Europe/Athens'), true)
  h.tick('2026-10-10T21:30:00Z')
  assert.equal(h.value('a.today'), 0)
  const state = h.state('a.today', '2026-10-10T21:30:00Z')
  // The total honestly starts at the change, not at the Athens midnight
  // half an hour earlier: what was counted in that half hour is gone.
  assert.equal(state.since, '2026-10-10T21:30:00.000Z')
  assert.match(state.message, /time zone changed/)

  h.input('2026-10-10T21:40:00Z', 'a.total', 1600)
  h.tick('2026-10-10T21:40:00Z')
  assert.equal(h.value('a.today'), 100)

  // Rome's midnight comes and goes without a second reset.
  h.input('2026-10-10T22:05:00Z', 'a.total', 1700)
  h.tick('2026-10-10T22:05:00Z')
  assert.equal(h.value('a.today'), 200)

  // The next reset is the next Athens midnight, and it is an ordinary one.
  h.tick('2026-10-11T21:00:00Z')
  assert.equal(h.value('a.today'), 0)
  const next = h.state('a.today', '2026-10-11T21:00:00Z')
  assert.equal(next.since, '2026-10-11T21:00:00.000Z')
  assert.equal(next.message, '')
})

test('going west back over midnight does not clear the same day twice', () => {
  const h = harness(dailyCounter, { zone: 'Europe/Athens' })
  h.input('2026-10-10T20:50:00Z', 'a.total', 1000)
  h.input('2026-10-10T20:55:00Z', 'a.total', 1200)
  h.tick('2026-10-10T20:55:00Z')
  assert.equal(h.value('a.today'), 200)

  // Athens midnight: the 11th begins.
  h.tick('2026-10-10T21:00:00Z')
  assert.equal(h.value('a.today'), 0)
  h.input('2026-10-10T21:05:00Z', 'a.total', 1300)
  h.tick('2026-10-10T21:05:00Z')
  assert.equal(h.value('a.today'), 100)

  // 00:10 in Athens on the 11th becomes 23:10 in Rome on the 10th.
  assert.equal(h.zone('Europe/Rome'), true)
  h.tick('2026-10-10T21:10:00Z')
  assert.equal(h.value('a.today'), 100)
  assert.match(h.state('a.today', '2026-10-10T21:10:00Z').message, /date has stepped back/)

  h.input('2026-10-10T21:30:00Z', 'a.total', 1400)
  h.tick('2026-10-10T21:30:00Z')
  assert.equal(h.value('a.today'), 200)

  // Rome midnight: the 11th begins a second time. Nothing is cleared, and
  // the explanation is no longer needed.
  h.tick('2026-10-10T22:00:01Z')
  assert.equal(h.state('a.today', '2026-10-10T22:00:01Z').message, '')
  h.input('2026-10-10T22:30:00Z', 'a.total', 1500)
  h.tick('2026-10-10T22:30:00Z')
  assert.equal(h.value('a.today'), 300)
  assert.equal(h.state('a.today', '2026-10-10T22:30:00Z').since, '2026-10-10T21:00:00.000Z')

  // The total for the 11th runs until Rome's next midnight: a 25-hour day.
  h.input('2026-10-11T21:59:00Z', 'a.total', 2000)
  h.tick('2026-10-11T21:59:00Z')
  assert.equal(h.value('a.today'), 800)
  h.tick('2026-10-11T22:00:00Z')
  assert.equal(h.value('a.today'), 0)
  assert.equal(h.state('a.today', '2026-10-11T22:00:00Z').message, '')
})

test('a change of zone inside the same date changes nothing', () => {
  const h = harness(dailyCounter, { zone: 'Europe/Rome' })
  h.input('2026-10-10T10:00:00Z', 'a.total', 1000)
  h.input('2026-10-10T10:10:00Z', 'a.total', 1300)
  h.tick('2026-10-10T10:10:00Z')
  assert.equal(h.zone('Europe/Athens'), true)
  h.tick('2026-10-10T10:11:00Z')
  assert.equal(h.value('a.today'), 300)
  const state = h.state('a.today', '2026-10-10T10:11:00Z')
  assert.equal(state.message, '')
  assert.equal(state.since, '2026-10-10T10:00:00.000Z')
  // From now on the day ends at Athens midnight, an hour before Rome's.
  h.tick('2026-10-10T21:00:00Z')
  assert.equal(h.value('a.today'), 0)
})

test('setting the zone it already has is not a change', () => {
  const h = harness(dailyCounter, { zone: 'Europe/Rome' })
  assert.equal(h.zone('Europe/Rome'), false)
  assert.equal(h.zone(''), false)
  assert.equal(h.zone(undefined), false)
  assert.equal(h.engine.timeZone, 'Europe/Rome')
})

test('the engine starts in the zone from the settings when none is given', () => {
  const normalized = normalizeConfig({ timeZone: 'Europe/Athens', ...dailyCounter })
  assert.equal(new Engine(normalized, null).timeZone, 'Europe/Athens')
  assert.equal(new Engine(normalized, null, 'Europe/Rome').timeZone, 'Europe/Rome')
})

test('a day on a fixed offset begins at that offset\'s midnight', () => {
  const h = harness(dailyCounter, { zone: '-09:30' })
  h.input('2026-10-10T09:00:00Z', 'a.total', 100)
  h.input('2026-10-10T09:29:00Z', 'a.total', 150)
  h.tick('2026-10-10T09:29:00Z')
  assert.equal(h.value('a.today'), 50)
  // Midnight at UTC-09:30 is 09:30 UTC.
  h.tick('2026-10-10T09:30:00Z')
  assert.equal(h.value('a.today'), 0)
  assert.equal(h.state('a.today', '2026-10-10T09:30:00Z').since, '2026-10-10T09:30:00.000Z')
})

test('weekly and monthly totals follow the ship\'s calendar too', () => {
  const h = harness({
    counters: [
      { input: 'a.total', output: 'a.week', resets: 'week', staleTimeout: 0 },
      { input: 'a.total', output: 'a.month', resets: 'month', staleTimeout: 0 }
    ]
  }, { zone: 'Europe/Rome', base: '2026-10-31T00:00:00Z' })
  // Saturday 31 October, after the clocks went back: Rome is UTC+1 and
  // Athens UTC+2. 23:30 in Rome is 22:30 UTC.
  h.input('2026-10-31T22:00:00Z', 'a.total', 1000)
  h.input('2026-10-31T22:20:00Z', 'a.total', 1400)
  h.tick('2026-10-31T22:20:00Z')
  assert.equal(h.value('a.week'), 400)
  assert.equal(h.value('a.month'), 400)

  // East: 23:30 on the 31st becomes 00:30 on 1 November, a Sunday. A new
  // month has begun; the week, which starts on Monday, has not.
  h.zone('Europe/Athens')
  h.tick('2026-10-31T22:30:00Z')
  assert.equal(h.value('a.month'), 0)
  assert.equal(h.value('a.week'), 400)

  // West again: back to 23:35 on the 31st. November is not started twice.
  h.zone('Europe/Rome')
  h.tick('2026-10-31T22:35:00Z')
  h.input('2026-10-31T22:40:00Z', 'a.total', 1500)
  h.tick('2026-10-31T22:40:00Z')
  assert.equal(h.value('a.month'), 100)
  h.tick('2026-10-31T23:00:01Z')
  h.input('2026-10-31T23:10:00Z', 'a.total', 1600)
  h.tick('2026-10-31T23:10:00Z')
  assert.equal(h.value('a.month'), 200)
  assert.equal(h.value('a.week'), 600)

  // The week turns over at Rome's Monday midnight.
  h.tick('2026-11-01T23:00:00Z')
  assert.equal(h.value('a.week'), 0)
  assert.equal(h.value('a.month'), 200)
})

test('totals that do not reset by the calendar ignore the zone', () => {
  const h = harness({
    formulas: [{ inputs: [{ name: 'x', path: 'a.x' }], expression: 'x * 2', output: 'a.double', staleTimeout: 0 }],
    counters: [
      { input: 'a.total', output: 'a.manual', resets: 'manual', staleTimeout: 0 },
      { input: 'a.total', output: 'a.follows', resets: 'path', resetPath: 'a.other', staleTimeout: 0 }
    ]
  }, { zone: 'Europe/Rome' })
  h.input('2026-10-10T21:00:00Z', 'a.x', 4)
  h.input('2026-10-10T21:00:00Z', 'a.total', 1000)
  h.input('2026-10-10T21:00:00Z', 'a.other', 50)
  h.input('2026-10-10T21:20:00Z', 'a.total', 1500)
  h.tick('2026-10-10T21:20:00Z')
  h.zone('Europe/Athens')
  h.tick('2026-10-10T21:30:00Z')
  h.zone('Pacific/Honolulu')
  h.tick('2026-10-10T21:31:00Z')
  assert.equal(h.value('a.double'), 8)
  assert.equal(h.value('a.manual'), 500)
  assert.equal(h.value('a.follows'), 500)
  for (const output of ['a.manual', 'a.follows']) assert.equal(h.state(output, '2026-10-10T21:31:00Z').message, '')
})

test('an integration starts its new total at the moment of an eastward change', () => {
  const h = harness({ integrations: [{ input: 'a.power', output: 'a.energy', resets: 'day', staleTimeout: 120 }] }, { zone: 'Europe/Rome' })
  // A steady 100 W, one reading a minute.
  for (let minute = 0; minute <= 29; minute++) h.input(`2026-10-10T21:${String(minute).padStart(2, '0')}:00Z`, 'a.power', 100)
  h.tick('2026-10-10T21:29:00Z')
  assert.equal(h.value('a.energy'), 100 * 29 * 60)

  h.zone('Europe/Athens')
  h.tick('2026-10-10T21:29:30Z')
  assert.equal(h.value('a.energy'), 0)
  // The reading at 21:30 closes a minute that began before the change.
  // Only the half minute after the change belongs to the new total.
  h.input('2026-10-10T21:30:00Z', 'a.power', 100)
  h.tick('2026-10-10T21:30:00Z')
  assert.equal(h.value('a.energy'), 100 * 30)
  h.input('2026-10-10T21:31:00Z', 'a.power', 100)
  h.tick('2026-10-10T21:31:00Z')
  assert.equal(h.value('a.energy'), 100 * 90)
})

test('a reset caused by a change of zone reaches the entries that read the total', () => {
  const h = harness({
    counters: [{ input: 'a.total', output: 'a.today', resets: 'day', staleTimeout: 0 }],
    formulas: [{ inputs: [{ name: 't', path: 'a.today' }], expression: 't / 1000', output: 'a.todayK', staleTimeout: 0 }]
  }, { zone: 'Europe/Rome' })
  h.input('2026-10-10T21:00:00Z', 'a.total', 1000)
  h.input('2026-10-10T21:20:00Z', 'a.total', 3000)
  h.tick('2026-10-10T21:20:00Z')
  assert.equal(h.value('a.todayK'), 2)
  h.zone('Europe/Athens')
  h.tick('2026-10-10T21:30:00Z')
  assert.equal(h.value('a.today'), 0)
  assert.equal(h.value('a.todayK'), 0)
})

test('a day held over a westward change is still held after a restart', () => {
  const first = harness(dailyCounter, { zone: 'Europe/Athens' })
  first.input('2026-10-10T20:50:00Z', 'a.total', 1000)
  first.tick('2026-10-10T21:00:00Z')
  first.input('2026-10-10T21:05:00Z', 'a.total', 1300)
  first.zone('Europe/Rome')
  first.tick('2026-10-10T21:10:00Z')
  assert.equal(first.value('a.today'), 300)
  const saved = first.save('2026-10-10T21:10:00Z')
  assert.equal(saved.entries['a.today'].periodKey, '2026-10-11')

  // Restarted in Rome time, before Rome's midnight.
  const second = harness(dailyCounter, { zone: 'Europe/Rome', saved })
  second.input('2026-10-10T21:40:00Z', 'a.total', 1400)
  second.tick('2026-10-10T21:40:00Z')
  assert.equal(second.value('a.today'), 400)
  // The status page still explains why the day has not turned over.
  assert.match(second.state('a.today', '2026-10-10T21:40:00Z').message, /date has stepped back/)
  second.tick('2026-10-10T22:00:05Z')
  second.input('2026-10-10T22:10:00Z', 'a.total', 1500)
  second.tick('2026-10-10T22:10:00Z')
  assert.equal(second.value('a.today'), 500)
  second.tick('2026-10-11T22:00:00Z')
  assert.equal(second.value('a.today'), 0)
})

test('a change of zone while the plugin was stopped is handled at the restart', () => {
  // Stopped in Rome at 23:20 on the 10th, started again in Athens at 00:40
  // on the 11th: the new day began while nothing was running.
  const first = harness(dailyCounter, { zone: 'Europe/Rome' })
  first.input('2026-10-10T21:00:00Z', 'a.total', 1000)
  first.input('2026-10-10T21:20:00Z', 'a.total', 1500)
  first.tick('2026-10-10T21:20:00Z')
  const saved = first.save('2026-10-10T21:20:00Z')

  const second = harness(dailyCounter, { zone: 'Europe/Athens', saved })
  second.input('2026-10-10T21:40:00Z', 'a.total', 1700)
  second.tick('2026-10-10T21:40:00Z')
  // The counter's place in its input survived, so the 200 gained since the
  // last value before the stop is counted in the new day.
  assert.equal(second.value('a.today'), 200)
  assert.match(second.state('a.today', '2026-10-10T21:40:00Z').message, /while the plugin was not running/)
})

test('state saved by version 0.1.0 is taken over without losing the day\'s total', () => {
  // Version 0.1.0 saved the start instant of the period and no date key.
  const saved = {
    savedAt: Date.parse('2026-10-10T12:00:00Z'),
    entries: {
      'a.today': {
        signature: 'counter|a.total|increase',
        resets: 'day',
        resetPath: null,
        total: 500,
        since: Date.parse('2026-10-10T06:00:00Z'),
        periodStart: Date.parse('2026-10-10T00:00:00Z'),
        referenceLast: null,
        last: 1500
      }
    }
  }
  const h = harness(dailyCounter, { zone: 'UTC', saved })
  h.input('2026-10-10T12:30:00Z', 'a.total', 1600)
  h.tick('2026-10-10T12:30:00Z')
  assert.equal(h.value('a.today'), 600)
  assert.equal(h.save('2026-10-10T12:30:00Z').entries['a.today'].periodKey, '2026-10-10')
  h.tick('2026-10-11T00:00:00Z')
  assert.equal(h.value('a.today'), 0)
})

test('state saved by version 0.1.0 before a boundary rolls over at the first check', () => {
  const saved = {
    savedAt: Date.parse('2026-10-09T23:00:00Z'),
    entries: {
      'a.today': {
        signature: 'counter|a.total|increase',
        resets: 'day',
        resetPath: null,
        total: 500,
        since: Date.parse('2026-10-09T06:00:00Z'),
        periodStart: Date.parse('2026-10-09T00:00:00Z'),
        referenceLast: null,
        last: 1500
      }
    }
  }
  const h = harness(dailyCounter, { zone: 'UTC', saved })
  h.input('2026-10-10T08:00:00Z', 'a.total', 1650)
  h.tick('2026-10-10T08:00:00Z')
  assert.equal(h.value('a.today'), 150)
  assert.match(h.state('a.today', '2026-10-10T08:00:00Z').message, /while the plugin was not running/)
})

test('a period dated far in the future by a wrong clock is pulled back', () => {
  // The clock read 2030 when this was saved. The total is kept and the
  // period is brought back to today, so tonight's midnight is seen.
  const saved = {
    savedAt: Date.parse('2026-10-10T09:00:00Z'),
    entries: {
      'a.today': {
        signature: 'counter|a.total|increase',
        resets: 'day',
        resetPath: null,
        total: 500,
        since: Date.parse('2026-10-10T06:00:00Z'),
        periodStart: Date.parse('2030-03-03T00:00:00Z'),
        periodKey: '2030-03-03',
        referenceLast: null,
        last: 1500
      }
    }
  }
  const h = harness(dailyCounter, { zone: 'UTC', saved })
  h.input('2026-10-10T12:00:00Z', 'a.total', 1600)
  h.tick('2026-10-10T12:00:00Z')
  assert.equal(h.value('a.today'), 600)
  assert.equal(h.state('a.today', '2026-10-10T12:00:00Z').message, '')
  assert.equal(h.save('2026-10-10T12:00:00Z').entries['a.today'].periodKey, '2026-10-10')
  h.tick('2026-10-11T00:00:00Z')
  assert.equal(h.value('a.today'), 0)
})

test('a saved date key that is not a date is worked out again', () => {
  const saved = {
    savedAt: Date.parse('2026-10-10T09:00:00Z'),
    entries: {
      'a.today': {
        signature: 'counter|a.total|increase',
        resets: 'day',
        resetPath: null,
        total: 500,
        since: Date.parse('2026-10-10T06:00:00Z'),
        periodStart: Date.parse('2026-10-10T00:00:00Z'),
        periodKey: 'tomorrow',
        referenceLast: null,
        last: 1500
      }
    }
  }
  const h = harness(dailyCounter, { zone: 'UTC', saved })
  h.input('2026-10-10T12:00:00Z', 'a.total', 1600)
  h.tick('2026-10-10T12:00:00Z')
  assert.equal(h.value('a.today'), 600)
  assert.equal(h.save('2026-10-10T12:00:00Z').entries['a.today'].periodKey, '2026-10-10')
})

test('a change of zone while the clock is unset waits for the clock', () => {
  const h = harness(dailyCounter, { zone: 'Europe/Rome' })
  h.input('2026-10-10T21:00:00Z', 'a.total', 1000)
  h.input('2026-10-10T21:20:00Z', 'a.total', 1500)
  h.tick('2026-10-10T21:20:00Z')
  h.zone('Europe/Athens')
  // The clock drops to 1970: nothing may be decided about periods.
  const mono = Date.parse('2026-10-10T21:25:00Z') - Date.parse('2026-10-10T00:00:00Z')
  h.engine.tick(1000, mono)
  assert.equal(h.engine.clockSuspect, true)
  assert.equal(h.engine.entries[0].total, 500)
  // Once the clock is right, the change of zone is acted on as usual.
  h.tick('2026-10-10T21:30:00Z')
  assert.equal(h.value('a.today'), 0)
  assert.match(h.state('a.today', '2026-10-10T21:30:00Z').message, /time zone changed/)
})

test('however the zone moves, a total is cleared at most once for a date', () => {
  // A counter is driven through twenty days in ten-minute steps while the
  // zone jumps about at random. Zones up to a day apart are used, which is
  // more than any real passage covers in one step.
  const zones = ['-11:00', '-09:30', '-05:00', 'America/New_York', 'UTC', 'Europe/Rome', 'Europe/Athens', '+05:45', 'Asia/Tokyo', '+12:00', 'Pacific/Auckland']
  // A small repeatable random number generator, so a failure can be rerun.
  let seed = 20261010
  const random = () => {
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  for (let run = 0; run < 12; run++) {
    const h = harness(dailyCounter, { zone: zones[Math.floor(random() * zones.length)] })
    const entry = h.engine.entries[0]
    const start = Date.parse('2026-10-10T00:00:00Z')
    const clearedFor = []
    let total = 0
    let previousKey = null

    for (let step = 0; step < 20 * 144; step++) {
      const wall = start + step * 600000
      const time = new Date(wall).toISOString()
      if (random() < 0.03) h.zone(zones[Math.floor(random() * zones.length)])
      total += 10
      h.input(time, 'a.total', total)
      h.tick(time)
      if (entry.periodKey !== previousKey) {
        if (previousKey !== null) {
          // Every change of key is a step to a later date, and comes with
          // a cleared total.
          assert.ok(entry.periodKey > previousKey, `run ${run}: ${previousKey} then ${entry.periodKey} at ${time}`)
          clearedFor.push(entry.periodKey)
        }
        previousKey = entry.periodKey
      }
      // Between clearings the total only grows.
      assert.ok(entry.total >= 0 && entry.total <= total, `run ${run} at ${time}`)
    }

    assert.equal(new Set(clearedFor).size, clearedFor.length, `run ${run}: a date was started twice`)
    // Twenty days of running give about twenty new days, whatever the zone
    // did: the jumps can add or drop a day or two at the ends.
    assert.ok(clearedFor.length >= 17 && clearedFor.length <= 22, `run ${run}: ${clearedFor.length} days`)
  }
})

test('the note about a date that stepped back goes when the zone moves forward again', () => {
  const h = harness(dailyCounter, { zone: 'Europe/Athens' })
  h.input('2026-10-10T20:50:00Z', 'a.total', 1000)
  h.tick('2026-10-10T21:00:00Z')
  h.input('2026-10-10T21:05:00Z', 'a.total', 1300)
  h.zone('Europe/Rome')
  h.tick('2026-10-10T21:10:00Z')
  assert.match(h.state('a.today', '2026-10-10T21:10:00Z').message, /date has stepped back/)
  // Back to Athens time before Rome's midnight: the 11th again, same total.
  h.zone('Europe/Athens')
  h.tick('2026-10-10T21:15:00Z')
  assert.equal(h.value('a.today'), 300)
  assert.equal(h.state('a.today', '2026-10-10T21:15:00Z').message, '')
})

test('state saved by version 0.1.0 is taken over in whatever zone is now in use', () => {
  // 0.1.0 worked in the zone from the settings, here Europe/Athens, and
  // saved the day's start as Athens midnight. That instant is the day
  // before in every zone further west. Whichever zone is followed after
  // the upgrade, the day's total must still be there.
  const saved = () => ({
    savedAt: Date.parse('2026-10-10T09:59:00Z'),
    entries: {
      'a.today': {
        signature: 'counter|a.total|increase',
        resets: 'day',
        resetPath: null,
        total: 5200,
        since: Date.parse('2026-10-09T21:00:00Z'),
        periodStart: Date.parse('2026-10-09T21:00:00Z'),
        referenceLast: null,
        last: 90000
      }
    }
  })
  for (const zone of ['Europe/Athens', 'Europe/Rome', 'Europe/London', 'UTC', 'America/New_York', 'Asia/Tokyo', '+05:45', '-09:30']) {
    const h = harness({ timeZone: 'Europe/Athens', ...dailyCounter }, { zone, saved: saved() })
    h.input('2026-10-10T10:00:00Z', 'a.total', 90100)
    h.tick('2026-10-10T10:00:00Z')
    assert.equal(h.value('a.today'), 5300, zone)
    const record = h.save('2026-10-10T10:00:00Z').entries['a.today']
    assert.equal(record.periodKey, '2026-10-10', zone)
  }
})

test('a clock a few hours ahead over a false midnight is pulled back as before', () => {
  // The zone never changes. The clock runs three hours fast, passes a
  // midnight that has not happened, and is then corrected. As in version
  // 0.1.0 the period is pulled back and the real midnight clears the total.
  const h = harness(dailyCounter, { zone: 'UTC' })
  const wall = (time) => Date.parse(time)
  const base = wall('2026-10-10T00:00:00Z')
  const feed = (shown, real, value) => h.engine.input('a.total', value, wall(shown), wall(real) - base)
  const tick = (shown, real) => h.engine.tick(wall(shown), wall(real) - base)

  feed('2026-10-10T23:30:00Z', '2026-10-10T20:30:00Z', 1000)
  feed('2026-10-10T23:50:00Z', '2026-10-10T20:50:00Z', 1100)
  // The fast clock passes midnight: the total is cleared, wrongly but
  // unavoidably.
  tick('2026-10-11T00:10:00Z', '2026-10-10T21:10:00Z')
  feed('2026-10-11T00:20:00Z', '2026-10-10T21:20:00Z', 1140)
  assert.equal(h.engine.entries[0].total, 40)
  // The clock is corrected to 23:50 on the 10th.
  tick('2026-10-10T23:50:00Z', '2026-10-10T23:50:00Z')
  assert.equal(h.engine.entries[0].periodKey, '2026-10-10')
  assert.equal(h.state('a.today', '2026-10-10T23:50:00Z').message, '')
  feed('2026-10-10T23:55:00Z', '2026-10-10T23:55:00Z', 1320)
  assert.equal(h.engine.entries[0].total, 220)
  // The real midnight clears it.
  tick('2026-10-11T00:00:01Z', '2026-10-11T00:00:01Z')
  assert.equal(h.engine.entries[0].total, 0)
})

test('a later day start set in the small hours is taken up as before', () => {
  // The day start is moved from 00:00 to 06:00 at 03:00. By the new
  // setting it is still yesterday. The zone has not changed, so nothing is
  // held over: the period is pulled back and 06:00 clears the total.
  const first = harness(dailyCounter, { zone: 'UTC' })
  first.input('2026-10-10T01:00:00Z', 'a.total', 1000)
  first.input('2026-10-10T02:50:00Z', 'a.total', 1030)
  first.tick('2026-10-10T02:50:00Z')
  const saved = first.save('2026-10-10T02:50:00Z')

  const second = harness({ dayStart: '06:00', ...dailyCounter }, { zone: 'UTC', saved })
  second.input('2026-10-10T03:00:00Z', 'a.total', 1040)
  second.tick('2026-10-10T03:00:00Z')
  assert.equal(second.value('a.today'), 40)
  assert.equal(second.state('a.today', '2026-10-10T03:00:00Z').message, '')
  second.tick('2026-10-10T06:00:00Z')
  assert.equal(second.value('a.today'), 0)
  second.input('2026-10-10T06:01:00Z', 'a.total', 1050)
  second.tick('2026-10-10T06:01:00Z')
  assert.equal(second.value('a.today'), 10)
})

test('the zone a period was dated in is saved with it', () => {
  const h = harness(dailyCounter, { zone: 'Europe/Athens' })
  h.input('2026-10-10T20:50:00Z', 'a.total', 1000)
  h.tick('2026-10-10T21:00:00Z')
  assert.equal(h.save('2026-10-10T21:00:00Z').entries['a.today'].periodZone, 'Europe/Athens')
  // Held over a change going west, the period stays dated in Athens.
  h.zone('Europe/Rome')
  h.tick('2026-10-10T21:10:00Z')
  assert.equal(h.save('2026-10-10T21:10:00Z').entries['a.today'].periodZone, 'Europe/Athens')
  // Once the same date has begun in Rome it is dated there.
  h.tick('2026-10-10T22:00:01Z')
  assert.equal(h.save('2026-10-10T22:00:01Z').entries['a.today'].periodZone, 'Europe/Rome')
})
