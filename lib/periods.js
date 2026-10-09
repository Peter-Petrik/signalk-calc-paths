'use strict'

/*
 * Period boundaries in a configured time zone.
 *
 * A period entry needs one answer: "at this instant, when did the current
 * day, week, month or year begin?" The answer is computed in an IANA time
 * zone with the runtime's Intl data, so no time zone library is needed and
 * daylight saving changes are handled by the platform.
 *
 * All instants are milliseconds since the Unix epoch.
 */

const PERIODS = ['day', 'week', 'month', 'year']

// Day-of-week numbers as returned by Date#getUTCDay.
const WEEK_START_DAYS = { sunday: 0, monday: 1, saturday: 6 }

// A formatter is expensive to build, so one is kept per time zone.
const formatters = new Map()

function formatterFor (timeZone) {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric'
    })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

/**
 * Returns the time zone the server process runs in. On a server set to UTC
 * this is "UTC", which is why the plugin offers its own setting.
 */
function serverTimeZone () {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/**
 * Reports whether a string is a time zone the runtime knows.
 */
function isValidTimeZone (timeZone) {
  if (typeof timeZone !== 'string' || timeZone.trim() === '') return false
  try {
    // The constructor throws a RangeError for an unknown zone.
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch (err) {
    return false
  }
}

/**
 * Parses a day-start time written as "HH:MM" into minutes after midnight.
 * Returns null when the text is not a valid time of day.
 */
function parseDayStart (text) {
  if (text === undefined || text === null || text === '') return 0
  const match = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(text))
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

/**
 * Breaks an instant into calendar fields as a clock in the time zone shows
 * them.
 */
function zonedParts (instant, timeZone) {
  const parts = {}
  for (const part of formatterFor(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value)
  }
  return parts
}

/**
 * Returns the zone's offset from UTC at an instant, in milliseconds
 * (positive east of Greenwich).
 */
function zoneOffset (instant, timeZone) {
  const p = zonedParts(instant, timeZone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  // The formatter drops milliseconds, so the instant is truncated to match.
  return asUtc - Math.floor(instant / 1000) * 1000
}

/**
 * Converts a wall-clock time in the zone to an instant.
 *
 * The offset depends on the instant, which is what is being solved for.
 * Two candidates cover every case: the wall-clock time read with the offset
 * in force a day earlier, and with the offset in force a day later. Each is
 * checked by converting it back.
 *
 * 1. Normally exactly one candidate converts back to the requested time
 *    (or both are the same instant).
 * 2. When clocks go back, the wall-clock time occurs twice and both
 *    candidates are valid. The earlier one is used, so a period begins the
 *    first time its start time comes round.
 * 3. When clocks go forward, the wall-clock time may not exist at all. The
 *    later candidate is used: the requested time moved forward by the
 *    length of the skipped stretch, which keeps it on the requested date.
 */
function zonedToInstant (year, month, day, minutes, timeZone) {
  const naive = Date.UTC(year, month - 1, day, 0, minutes)
  const candidates = [
    naive - zoneOffset(naive - 86400000, timeZone),
    naive - zoneOffset(naive + 86400000, timeZone)
  ]

  const matches = candidates.filter((instant) => {
    const p = zonedParts(instant, timeZone)
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) === naive
  })
  return matches.length > 0 ? Math.min(...matches) : Math.max(...candidates)
}

/** Moves a calendar date by a number of days, across month and year ends. */
function shiftDate ({ year, month, day }, days) {
  const date = new Date(Date.UTC(year, month - 1, day + days))
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
}

/**
 * Returns the instant at which the period containing `instant` began.
 *
 * @param {number} instant - Milliseconds since the epoch.
 * @param {string} period - One of "day", "week", "month", "year".
 * @param {object} options
 * @param {string} options.timeZone - IANA time zone name.
 * @param {number} [options.dayStartMinutes=0] - Minutes after local midnight
 *   at which a day begins. Weeks, months and years begin at the same time of
 *   day.
 * @param {string} [options.weekStart='monday'] - First day of the week.
 */
function periodStart (instant, period, options) {
  const timeZone = options.timeZone
  const dayStartMinutes = options.dayStartMinutes || 0
  const weekStartDay = WEEK_START_DAYS[options.weekStart] ?? WEEK_START_DAYS.monday

  const startOf = (date) => zonedToInstant(date.year, date.month, date.day, dayStartMinutes, timeZone)

  // First find the day the instant belongs to. Its calendar date is the
  // candidate; if that date's day has not started yet (02:30 with a 04:00
  // day start), the instant belongs to the day before. Working with
  // calendar dates, and never with fixed numbers of hours, keeps this right
  // on the 23-hour and 25-hour days of a daylight saving change.
  const local = zonedParts(instant, timeZone)
  let date = { year: local.year, month: local.month, day: local.day }
  // One step back is the normal case. A second is needed only where a day
  // start falls in a skipped hour that runs past midnight, which moves that
  // day's start onto the next calendar date.
  for (let steps = 0; steps < 3 && startOf(date) > instant; steps++) date = shiftDate(date, -1)

  if (period === 'week') {
    const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()
    date = shiftDate(date, -((weekday - weekStartDay + 7) % 7))
  } else if (period === 'month') {
    date = { year: date.year, month: date.month, day: 1 }
  } else if (period === 'year') {
    date = { year: date.year, month: 1, day: 1 }
  } else if (period !== 'day') {
    throw new Error(`Unknown period: ${period}`)
  }

  return startOf(date)
}

// A probe this far past a period's start always falls inside the next
// period: longer than the longest period of its kind (a 25-hour day at the
// end of daylight saving, a 31-day month, a leap year) and shorter than two.
const NEXT_PROBE_MS = {
  day: 26 * 3600000,
  week: 7 * 86400000 + 2 * 3600000,
  month: 32 * 86400000,
  year: 367 * 86400000
}

/**
 * Returns the instant at which the period after the one starting at `start`
 * begins.
 */
function nextPeriodStart (start, period, options) {
  return periodStart(start + NEXT_PROBE_MS[period], period, options)
}

module.exports = {
  PERIODS,
  WEEK_START_DAYS,
  isValidTimeZone,
  nextPeriodStart,
  parseDayStart,
  periodStart,
  serverTimeZone,
  zoneOffset,
  zonedParts
}
