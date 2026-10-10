'use strict'

/*
 * Period boundaries in a time zone.
 *
 * A period entry needs one answer: "at this instant, when did the current
 * day, week, month or year begin?" The answer is computed in an IANA time
 * zone with the runtime's Intl data, so no time zone library is needed and
 * daylight saving changes are handled by the platform.
 *
 * A zone may also be a fixed offset from UTC, written "+03:00" or "-09:30".
 * Fixed offsets are worked out here by plain arithmetic and never passed to
 * Intl: runtimes differ in whether they accept an offset as a zone name,
 * and the arithmetic needs no data at all.
 *
 * All instants are milliseconds since the Unix epoch.
 */

const PERIODS = ['day', 'week', 'month', 'year']

// The widest offsets in civil use are UTC-12:00 and UTC+14:00. Fourteen
// hours either way is accepted, which keeps the check to one number.
const MAX_OFFSET_MINUTES = 14 * 60

// The canonical spelling of a fixed offset: sign, two-digit hours, a colon,
// two-digit minutes.
const OFFSET_ZONE = /^([+-])(\d{2}):(\d{2})$/

// Spellings of a fixed offset that are accepted and brought to the
// canonical form: "+3", "+03", "+0300", "+03:00", each with an optional
// "UTC" or "GMT" in front.
const LOOSE_OFFSET = /^(?:UTC|GMT)?\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i

/**
 * Returns a fixed-offset zone's distance from UTC in milliseconds (positive
 * east of Greenwich), or null when the name is not a fixed offset.
 */
function fixedOffsetMs (timeZone) {
  const match = OFFSET_ZONE.exec(timeZone)
  if (!match) return null
  const minutes = Number(match[2]) * 60 + Number(match[3])
  return (match[1] === '-' ? -minutes : minutes) * 60000
}

/**
 * Writes an offset in minutes east of UTC as a fixed-offset zone name.
 * Returns null for an offset no clock on Earth keeps.
 */
function offsetZone (minutes) {
  if (!Number.isInteger(minutes) || Math.abs(minutes) > MAX_OFFSET_MINUTES) return null
  if (minutes === 0) return 'UTC'
  const size = Math.abs(minutes)
  const pad = (n) => String(n).padStart(2, '0')
  return `${minutes < 0 ? '-' : '+'}${pad(Math.floor(size / 60))}:${pad(size % 60)}`
}

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
 * Brings a time zone name to the one spelling used everywhere else, or
 * returns null when the text names no usable zone.
 *
 * 1. A fixed offset in any accepted spelling becomes "+HH:MM" or "-HH:MM";
 *    a zero offset, "Z", "UTC" and "GMT" become "UTC".
 * 2. An IANA name the runtime knows is returned with the runtime's use of
 *    capitals, so "europe/athens" and "Europe/Athens" are one zone and not
 *    two. A name the runtime files under another name is kept as given:
 *    runtimes disagree on which of "Asia/Kathmandu" and "Asia/Katmandu" is
 *    the main one, and the name a person chose is the one to show them.
 */
function canonicalTimeZone (timeZone) {
  if (typeof timeZone !== 'string') return null
  const name = timeZone.trim()
  if (name === '') return null
  if (/^(Z|UTC|GMT)$/i.test(name)) return 'UTC'

  const offset = LOOSE_OFFSET.exec(name)
  if (offset) {
    const hours = Number(offset[2])
    const minutes = offset[3] === undefined ? 0 : Number(offset[3])
    if (minutes > 59) return null
    const total = hours * 60 + minutes
    return offsetZone(offset[1] === '-' ? -total : total)
  }

  try {
    // The constructor throws a RangeError for an unknown zone.
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone
    return resolved.toLowerCase() === name.toLowerCase() ? resolved : name
  } catch (err) {
    return null
  }
}

/**
 * Reports whether a string is a time zone that can be used: an IANA name
 * the runtime knows, or a fixed offset.
 */
function isValidTimeZone (timeZone) {
  return canonicalTimeZone(timeZone) !== null
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
  const fixed = fixedOffsetMs(timeZone)
  if (fixed !== null) {
    // A clock on a fixed offset shows what a UTC clock shows that much
    // later (or earlier).
    const shifted = new Date(instant + fixed)
    return {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(),
      second: shifted.getUTCSeconds()
    }
  }
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
  const fixed = fixedOffsetMs(timeZone)
  if (fixed !== null) return fixed
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
 * Describes the period containing `instant`: the instant it began, and the
 * calendar date it began on.
 *
 * The date is returned as a key, "YYYY-MM-DD", that names the period
 * independently of the time zone it was worked out in: the day of 10 October
 * is "2026-10-10" whether the ship keeps Athens time or Rome time. Keys of
 * the same kind of period sort in time order, so comparing two keys tells
 * whether a later period has begun. That is what lets a total follow the
 * ship's calendar when the ship changes time zone; comparing start instants
 * could not, because the same date begins at a different instant in every
 * zone.
 *
 * @param {number} instant - Milliseconds since the epoch.
 * @param {string} period - One of "day", "week", "month", "year".
 * @param {object} options
 * @param {string} options.timeZone - IANA time zone name or fixed offset.
 * @param {number} [options.dayStartMinutes=0] - Minutes after local midnight
 *   at which a day begins. Weeks, months and years begin at the same time of
 *   day.
 * @param {string} [options.weekStart='monday'] - First day of the week.
 * @returns {{start: number, key: string}}
 */
function periodInfo (instant, period, options) {
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

  const pad = (n, width) => String(n).padStart(width, '0')
  return { start: startOf(date), key: `${pad(date.year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}` }
}

/**
 * Returns the instant at which the period with the given date key begins in
 * the zone, or null when the key is not a date. This is the reverse of
 * periodInfo(): it asks when a named period starts, in whatever zone is in
 * use now, which may not be the zone the key was worked out in.
 */
function keyStart (key, options) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!match) return null
  return zonedToInstant(Number(match[1]), Number(match[2]), Number(match[3]), options.dayStartMinutes || 0, options.timeZone)
}

/**
 * Returns the instant at which the period containing `instant` began. See
 * periodInfo() for the parameters.
 */
function periodStart (instant, period, options) {
  return periodInfo(instant, period, options).start
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
  return nextPeriodInfo(start, period, options).start
}

/** As nextPeriodStart(), with the next period's date key as well. */
function nextPeriodInfo (start, period, options) {
  return periodInfo(start + NEXT_PROBE_MS[period], period, options)
}

module.exports = {
  MAX_OFFSET_MINUTES,
  PERIODS,
  WEEK_START_DAYS,
  canonicalTimeZone,
  fixedOffsetMs,
  isValidTimeZone,
  keyStart,
  nextPeriodInfo,
  nextPeriodStart,
  offsetZone,
  parseDayStart,
  periodInfo,
  periodStart,
  serverTimeZone,
  zoneOffset,
  zonedParts
}
