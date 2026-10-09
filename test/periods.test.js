'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')

const { isValidTimeZone, nextPeriodStart, parseDayStart, periodStart } = require('../lib/periods')

const iso = (instant) => new Date(instant).toISOString()
const at = (text) => Date.parse(text)

test('a day in UTC starts at midnight UTC', () => {
  const options = { timeZone: 'UTC' }
  assert.equal(iso(periodStart(at('2026-10-09T13:45:10Z'), 'day', options)), '2026-10-09T00:00:00.000Z')
  assert.equal(iso(periodStart(at('2026-10-09T00:00:00Z'), 'day', options)), '2026-10-09T00:00:00.000Z')
  assert.equal(iso(periodStart(at('2026-10-08T23:59:59.999Z'), 'day', options)), '2026-10-08T00:00:00.000Z')
})

test('a day in another zone starts at that zone\'s midnight', () => {
  // Athens is UTC+3 in summer, so its midnight is 21:00 UTC the day before.
  const options = { timeZone: 'Europe/Athens' }
  assert.equal(iso(periodStart(at('2026-10-09T13:00:00Z'), 'day', options)), '2026-10-08T21:00:00.000Z')
  assert.equal(iso(periodStart(at('2026-10-09T21:30:00Z'), 'day', options)), '2026-10-09T21:00:00.000Z')
  // New York is UTC-4 in summer.
  assert.equal(iso(periodStart(at('2026-07-04T02:00:00Z'), 'day', { timeZone: 'America/New_York' })), '2026-07-03T04:00:00.000Z')
})

test('a day-start time moves the boundary', () => {
  const options = { timeZone: 'UTC', dayStartMinutes: 4 * 60 }
  // 02:30 still belongs to the day that began at 04:00 the day before.
  assert.equal(iso(periodStart(at('2026-10-09T02:30:00Z'), 'day', options)), '2026-10-08T04:00:00.000Z')
  assert.equal(iso(periodStart(at('2026-10-09T04:00:00Z'), 'day', options)), '2026-10-09T04:00:00.000Z')
})

test('days across a daylight saving change are 23 and 25 hours long', () => {
  const options = { timeZone: 'Europe/Athens' }
  // Clocks go back on 2026-10-25 at 04:00 local (01:00 UTC): a 25-hour day.
  const autumn = periodStart(at('2026-10-25T12:00:00Z'), 'day', options)
  assert.equal(iso(autumn), '2026-10-24T21:00:00.000Z')
  assert.equal(iso(nextPeriodStart(autumn, 'day', options)), '2026-10-25T22:00:00.000Z')
  // Clocks go forward on 2026-03-29 at 03:00 local (01:00 UTC): a 23-hour day.
  const spring = periodStart(at('2026-03-29T12:00:00Z'), 'day', options)
  assert.equal(iso(spring), '2026-03-28T22:00:00.000Z')
  assert.equal(iso(nextPeriodStart(spring, 'day', options)), '2026-03-29T21:00:00.000Z')
})

test('a week starts on the configured weekday', () => {
  // 2026-10-09 is a Friday.
  const friday = at('2026-10-09T12:00:00Z')
  assert.equal(iso(periodStart(friday, 'week', { timeZone: 'UTC' })), '2026-10-05T00:00:00.000Z')
  assert.equal(iso(periodStart(friday, 'week', { timeZone: 'UTC', weekStart: 'sunday' })), '2026-10-04T00:00:00.000Z')
  assert.equal(iso(periodStart(friday, 'week', { timeZone: 'UTC', weekStart: 'saturday' })), '2026-10-03T00:00:00.000Z')
  // A week that began in the previous month and year.
  assert.equal(iso(periodStart(at('2026-01-01T12:00:00Z'), 'week', { timeZone: 'UTC' })), '2025-12-29T00:00:00.000Z')
})

test('months and years start on their first day', () => {
  const options = { timeZone: 'Europe/Athens' }
  assert.equal(iso(periodStart(at('2026-10-09T12:00:00Z'), 'month', options)), '2026-09-30T21:00:00.000Z')
  // Winter time in January: UTC+2.
  assert.equal(iso(periodStart(at('2026-10-09T12:00:00Z'), 'year', options)), '2025-12-31T22:00:00.000Z')
})

test('the next period start follows the current one for every kind', () => {
  const options = { timeZone: 'UTC' }
  assert.equal(iso(nextPeriodStart(at('2026-10-05T00:00:00Z'), 'week', options)), '2026-10-12T00:00:00.000Z')
  assert.equal(iso(nextPeriodStart(at('2026-01-01T00:00:00Z'), 'month', options)), '2026-02-01T00:00:00.000Z')
  assert.equal(iso(nextPeriodStart(at('2026-02-01T00:00:00Z'), 'month', options)), '2026-03-01T00:00:00.000Z')
  assert.equal(iso(nextPeriodStart(at('2028-01-01T00:00:00Z'), 'year', options)), '2029-01-01T00:00:00.000Z')
})

test('every instant of a day maps to the same start', () => {
  const options = { timeZone: 'Australia/Adelaide', dayStartMinutes: 90 }
  const start = periodStart(at('2026-06-15T12:00:00Z'), 'day', options)
  const next = nextPeriodStart(start, 'day', options)
  assert.equal(next - start, 24 * 3600000)
  for (let instant = start; instant < next; instant += 17 * 60000) {
    assert.equal(periodStart(instant, 'day', options), start)
  }
  assert.equal(periodStart(next, 'day', options), next)
  assert.equal(periodStart(start - 1, 'day', options), start - 24 * 3600000)
})

test('day-start text is parsed strictly', () => {
  assert.equal(parseDayStart('00:00'), 0)
  assert.equal(parseDayStart('04:30'), 270)
  assert.equal(parseDayStart('4:05'), 245)
  assert.equal(parseDayStart(''), 0)
  assert.equal(parseDayStart(undefined), 0)
  assert.equal(parseDayStart('24:00'), null)
  assert.equal(parseDayStart('12:60'), null)
  assert.equal(parseDayStart('noon'), null)
})

test('time zone names are checked', () => {
  assert.equal(isValidTimeZone('Europe/Athens'), true)
  assert.equal(isValidTimeZone('UTC'), true)
  assert.equal(isValidTimeZone('Mars/Olympus'), false)
  assert.equal(isValidTimeZone(''), false)
})

test('period starts hold their invariants across daylight saving changes', () => {
  // In zones with different daylight saving rules, and with awkward
  // day-start times: the period start is never in the future, asking again
  // from the start gives the same start, and the next period begins after
  // this one, is its own start, and leaves no gap.
  const { zoneOffset } = require('../lib/periods')
  const zones = ['UTC', 'Europe/Athens', 'America/New_York', 'America/Havana', 'Australia/Lord_Howe']
  const dayStarts = [0, 150, 210, 360, 1410]
  const from = at('2026-01-01T00:00:00Z')
  const to = at('2027-01-01T00:00:00Z')

  for (const timeZone of zones) {
    // Instants to probe: every 7 hours through the year, plus every 15
    // minutes for two days either side of each change of offset.
    const instants = []
    for (let instant = from; instant < to; instant += 7 * 3600000) instants.push(instant)
    for (let day = from; day < to; day += 86400000) {
      if (zoneOffset(day, timeZone) !== zoneOffset(day + 86400000, timeZone)) {
        for (let instant = day - 2 * 86400000; instant < day + 3 * 86400000; instant += 900000) instants.push(instant)
      }
    }

    for (const dayStartMinutes of dayStarts) {
      const options = { timeZone, dayStartMinutes }
      for (const period of ['day', 'week', 'month', 'year']) {
        const checked = new Set()
        for (const instant of instants) {
          const start = periodStart(instant, period, options)
          const label = `${timeZone} ${dayStartMinutes} ${period} ${iso(instant)}`
          assert.ok(start <= instant, `start in the future: ${label}`)
          if (checked.has(start)) continue
          checked.add(start)
          assert.equal(periodStart(start, period, options), start, `not its own start: ${label}`)
          const next = nextPeriodStart(start, period, options)
          assert.ok(next > instant, `next not after the instant: ${label}`)
          assert.equal(periodStart(next, period, options), next, `next is not a start: ${label}`)
          assert.equal(periodStart(next - 1, period, options), start, `gap before next: ${label}`)
        }
      }
    }
  }
})

test('a day start later than the clock change keeps its wall-clock time', () => {
  const options = { timeZone: 'Europe/Athens', dayStartMinutes: 6 * 60 }
  // 29 March 2026: clocks go forward at 03:00. 06:00 local is 03:00 UTC.
  assert.equal(iso(periodStart(at('2026-03-29T12:00:00Z'), 'day', options)), '2026-03-29T03:00:00.000Z')
  assert.equal(iso(periodStart(at('2026-03-29T02:59:00Z'), 'day', options)), '2026-03-28T04:00:00.000Z')
  // 25 October 2026: clocks go back at 04:00. 06:00 local is 04:00 UTC.
  assert.equal(iso(periodStart(at('2026-10-25T12:00:00Z'), 'day', options)), '2026-10-25T04:00:00.000Z')
  assert.equal(iso(periodStart(at('2026-10-25T03:30:00Z'), 'day', options)), '2026-10-24T03:00:00.000Z')
})

test('a day start inside the repeated or the skipped hour is handled', () => {
  // 03:30 local occurs twice on 25 October in Athens (00:30 and 01:30 UTC).
  // The day begins the first time.
  const repeated = { timeZone: 'Europe/Athens', dayStartMinutes: 3 * 60 + 30 }
  assert.equal(iso(periodStart(at('2026-10-25T12:00:00Z'), 'day', repeated)), '2026-10-25T00:30:00.000Z')
  assert.equal(iso(periodStart(at('2026-10-25T01:45:00Z'), 'day', repeated)), '2026-10-25T00:30:00.000Z')
  // 03:30 local does not exist on 29 March. The day begins an hour later
  // by the clock, at 04:30 local (01:30 UTC), still on the 29th.
  assert.equal(iso(periodStart(at('2026-03-29T12:00:00Z'), 'day', repeated)), '2026-03-29T01:30:00.000Z')
  // Havana skips midnight itself; the day still starts on its own date.
  const havana = { timeZone: 'America/Havana' }
  const start = periodStart(at('2026-03-08T12:00:00Z'), 'day', havana)
  assert.equal(iso(start), '2026-03-08T05:00:00.000Z')
  assert.equal(periodStart(start, 'day', havana), start)
})

test('a skipped hour that runs past midnight never puts a day start in the future', () => {
  // America/Nuuk moves from 23:00 straight to 00:00 on 28 March 2026.
  const options = { timeZone: 'America/Nuuk', dayStartMinutes: 23 * 60 + 59 }
  for (let instant = at('2026-03-28T00:00:00Z'); instant < at('2026-03-30T00:00:00Z'); instant += 60000) {
    const start = periodStart(instant, 'day', options)
    assert.ok(start <= instant, iso(instant))
    assert.equal(periodStart(start, 'day', options), start, iso(instant))
  }
})
