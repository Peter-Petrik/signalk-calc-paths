'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')

const { ZoneTracker, describeZone, zoneFromValue } = require('../lib/timezone')

const REGION = 'environment.time.timezoneRegion'
const OFFSET = 'environment.time.timezoneOffset'
const NOON = Date.parse('2026-10-10T12:00:00Z')

const settings = (overrides = {}) => ({ follow: true, regionPath: REGION, offsetPath: OFFSET, fallback: 'UTC', fallbackSource: 'server', ...overrides })

test('a zone name on a path is read as that zone', () => {
  assert.equal(zoneFromValue('Europe/Athens'), 'Europe/Athens')
  assert.equal(zoneFromValue(' pacific/marquesas '), 'Pacific/Marquesas')
  assert.equal(zoneFromValue('UTC'), 'UTC')
  assert.equal(zoneFromValue('+03:00'), '+03:00')
  assert.equal(zoneFromValue('UTC-9:30'), '-09:30')
})

test('a number is read as hours and minutes written together', () => {
  assert.equal(zoneFromValue(300), '+03:00')
  assert.equal(zoneFromValue(200), '+02:00')
  assert.equal(zoneFromValue(-930), '-09:30')
  assert.equal(zoneFromValue(545), '+05:45')
  assert.equal(zoneFromValue(1245), '+12:45')
  assert.equal(zoneFromValue(-1200), '-12:00')
  assert.equal(zoneFromValue(1400), '+14:00')
  assert.equal(zoneFromValue(0), 'UTC')
  assert.equal(zoneFromValue(-0), 'UTC')
})

test('values that are not a zone are refused', () => {
  // Minutes above 59, offsets beyond any clock, fractions, and non-values.
  for (const value of [260, 1401, -1500, 2.5, NaN, Infinity, null, undefined, true, {}, [], '', 'Atlantis/Central', '+15:00', '25']) {
    assert.equal(zoneFromValue(value), null, JSON.stringify(value))
  }
})

test('a fixed offset is written for people with "UTC" in front', () => {
  assert.equal(describeZone('+03:00'), 'UTC+03:00')
  assert.equal(describeZone('-09:30'), 'UTC-09:30')
  assert.equal(describeZone('Europe/Athens'), 'Europe/Athens')
  assert.equal(describeZone('UTC'), 'UTC')
})

test('with nothing published the zone from the settings is used', () => {
  const tracker = new ZoneTracker(settings({ fallback: 'Europe/Rome', fallbackSource: 'setting' }), null)
  assert.equal(tracker.zone, 'Europe/Rome')
  assert.deepEqual(tracker.paths, [REGION, OFFSET])
  const info = tracker.describe()
  assert.equal(info.source, 'setting')
  assert.equal(info.follow, true)
  assert.equal(info.path, null)
  assert.equal(info.problem, null)
  assert.equal(tracker.serialize(), null)
})

test('a published zone name is followed', () => {
  const tracker = new ZoneTracker(settings(), null)
  assert.equal(tracker.input(REGION, 'Europe/Athens', NOON), true)
  assert.equal(tracker.zone, 'Europe/Athens')
  const info = tracker.describe()
  assert.equal(info.source, 'path')
  assert.equal(info.path, REGION)
  assert.equal(info.since, new Date(NOON).toISOString())
  // The same zone again changes nothing.
  assert.equal(tracker.input(REGION, 'Europe/Athens', NOON + 1000), false)
  assert.equal(tracker.describe().since, new Date(NOON).toISOString())
})

test('an offset is followed when no name is published', () => {
  const tracker = new ZoneTracker(settings(), null)
  assert.equal(tracker.input(OFFSET, 300, NOON), true)
  assert.equal(tracker.zone, '+03:00')
  assert.equal(tracker.describe().path, OFFSET)
  assert.equal(tracker.describe().label, 'UTC+03:00')
})

test('the name is preferred to the offset when both are published together', () => {
  // The order the server delivers them in must not matter.
  for (const order of [[OFFSET, REGION], [REGION, OFFSET]]) {
    const tracker = new ZoneTracker(settings(), null)
    for (const path of order) tracker.input(path, path === REGION ? 'Europe/Athens' : 300, NOON)
    assert.equal(tracker.zone, 'Europe/Athens', order.join(' then '))
    assert.equal(tracker.describe().path, REGION)
  }
})

test('a newer offset that disagrees with an old name wins', () => {
  // A source that stops publishing a name leaves the old one in the server.
  const tracker = new ZoneTracker(settings(), null)
  tracker.input(OFFSET, 300, NOON)
  tracker.input(REGION, 'Europe/Athens', NOON)
  assert.equal(tracker.input(OFFSET, 200, NOON + 3600000), true)
  assert.equal(tracker.zone, '+02:00')
  // A name published after that is believed again.
  assert.equal(tracker.input(REGION, 'Europe/Rome', NOON + 7200000), true)
  assert.equal(tracker.zone, 'Europe/Rome')
})

test('a newer offset that agrees with the name does not replace it', () => {
  const tracker = new ZoneTracker(settings(), null)
  tracker.input(REGION, 'Europe/Athens', NOON)
  // In October Athens is three hours ahead of UTC.
  assert.equal(tracker.input(OFFSET, 300, NOON + 1000), false)
  assert.equal(tracker.zone, 'Europe/Athens')
})

test('a value that is not a zone is ignored and reported', () => {
  const tracker = new ZoneTracker(settings(), null)
  assert.equal(tracker.input(REGION, 'Atlantis/Central', NOON), false)
  assert.equal(tracker.zone, 'UTC')
  assert.match(tracker.describe().problem, /environment\.time\.timezoneRegion/)
  // A usable offset is followed, but the unreadable name is still reported:
  // without a name the zone's daylight saving rules are not being followed.
  tracker.input(OFFSET, 300, NOON)
  assert.equal(tracker.zone, '+03:00')
  assert.match(tracker.describe().problem, /environment\.time\.timezoneRegion is not/)
  // The complaint goes when the path holds a zone, or nothing.
  tracker.input(REGION, 'Europe/Athens', NOON)
  assert.equal(tracker.describe().problem, null)
  tracker.input(OFFSET, 180, NOON)
  assert.equal(tracker.zone, 'Europe/Athens')
  assert.match(tracker.describe().problem, /environment\.time\.timezoneOffset is not/)
  tracker.input(OFFSET, null, NOON)
  assert.equal(tracker.describe().problem, null)
})

test('a path that turns to null keeps the last zone followed', () => {
  const tracker = new ZoneTracker(settings(), null)
  tracker.input(REGION, 'Europe/Athens', NOON)
  assert.equal(tracker.input(REGION, null, NOON + 1000), false)
  assert.equal(tracker.zone, 'Europe/Athens')
  // A null is "no value", not a wrong one, and is not complained about.
  assert.equal(tracker.describe().problem, null)
})

test('values on paths that are not followed are ignored', () => {
  const tracker = new ZoneTracker(settings(), null)
  assert.equal(tracker.input('environment.time.somethingElse', 'Europe/Athens', NOON), false)
  assert.equal(tracker.zone, 'UTC')
})

test('the last zone followed is remembered across a restart', () => {
  const first = new ZoneTracker(settings(), null)
  first.input(REGION, 'Europe/Athens', NOON)
  assert.equal(first.dirty, true)
  const saved = JSON.parse(JSON.stringify(first.serialize()))
  assert.equal(first.dirty, false)

  const second = new ZoneTracker(settings(), saved)
  assert.equal(second.zone, 'Europe/Athens')
  assert.equal(second.describe().source, 'remembered')
  assert.equal(second.describe().path, REGION)
  // Hearing the same zone again confirms it without changing it.
  assert.equal(second.input(REGION, 'Europe/Athens', NOON + 60000), false)
  assert.equal(second.describe().source, 'path')
  // A different zone after the restart is a change.
  assert.equal(second.input(REGION, 'Europe/Rome', NOON + 120000), true)
  assert.equal(second.zone, 'Europe/Rome')
})

test('a remembered zone is dropped when the followed paths were changed', () => {
  const first = new ZoneTracker(settings(), null)
  first.input(REGION, 'Europe/Athens', NOON)
  const saved = first.serialize()
  const second = new ZoneTracker(settings({ regionPath: 'my.own.zone' }), saved)
  assert.equal(second.zone, 'UTC')
  assert.equal(second.describe().source, 'server')
})

test('a remembered zone that is not a zone is dropped', () => {
  for (const saved of [{ zone: 'Atlantis/Central', regionPath: REGION, offsetPath: OFFSET }, { regionPath: REGION, offsetPath: OFFSET }, 'text', 7, []]) {
    const tracker = new ZoneTracker(settings(), saved)
    assert.equal(tracker.zone, 'UTC')
  }
})

test('with following switched off nothing is read and nothing is remembered', () => {
  const first = new ZoneTracker(settings(), null)
  first.input(REGION, 'Europe/Athens', NOON)
  const saved = first.serialize()

  const tracker = new ZoneTracker(settings({ follow: false, fallback: 'Europe/Rome', fallbackSource: 'setting' }), saved)
  assert.deepEqual(tracker.paths, [])
  assert.equal(tracker.zone, 'Europe/Rome')
  assert.equal(tracker.input(REGION, 'Europe/Athens', NOON), false)
  assert.equal(tracker.zone, 'Europe/Rome')
  assert.equal(tracker.describe().source, 'setting')
  assert.equal(tracker.describe().follow, false)
  assert.equal(tracker.serialize(), null)
})

test('one path may be given for both the name and the offset', () => {
  const tracker = new ZoneTracker(settings({ regionPath: 'my.zone', offsetPath: 'my.zone' }), null)
  assert.deepEqual(tracker.paths, ['my.zone'])
  assert.equal(tracker.input('my.zone', -930, NOON), true)
  assert.equal(tracker.zone, '-09:30')
  assert.equal(tracker.input('my.zone', 'Pacific/Marquesas', NOON), true)
  assert.equal(tracker.zone, 'Pacific/Marquesas')
})

test('either path accepts either form', () => {
  const tracker = new ZoneTracker(settings(), null)
  // A custom source may put a name where an offset is expected.
  tracker.input(OFFSET, 'Europe/Athens', NOON)
  assert.equal(tracker.zone, 'Europe/Athens')
  const other = new ZoneTracker(settings(), null)
  other.input(REGION, 300, NOON)
  assert.equal(other.zone, '+03:00')
})

test('after a restart an agreeing offset confirms the remembered name', () => {
  // The source publishes the offset a moment before the name. The zone must
  // not switch to the bare offset and back.
  const first = new ZoneTracker(settings(), null)
  first.input(OFFSET, 300, NOON)
  first.input(REGION, 'Europe/Athens', NOON)
  const saved = first.serialize()

  const second = new ZoneTracker(settings(), saved)
  assert.equal(second.input(OFFSET, 300, NOON + 60000), false)
  assert.equal(second.zone, 'Europe/Athens')
  // The name itself has not been read again yet, and the status says so.
  assert.equal(second.describe().source, 'remembered')
  assert.equal(second.describe().path, REGION)
  assert.equal(second.input(REGION, 'Europe/Athens', NOON + 60000), false)
  assert.equal(second.zone, 'Europe/Athens')
  assert.equal(second.describe().source, 'path')
})

test('after a restart an offset that disagrees with the remembered name replaces it', () => {
  // The boat moved while the server was off and the source now gives an
  // offset only.
  const first = new ZoneTracker(settings(), null)
  first.input(REGION, 'Europe/Athens', NOON)
  const second = new ZoneTracker(settings(), first.serialize())
  assert.equal(second.input(OFFSET, 200, NOON + 60000), true)
  assert.equal(second.zone, '+02:00')
  assert.equal(second.describe().path, OFFSET)
  // A name published afterwards takes over again.
  assert.equal(second.input(REGION, 'Europe/Rome', NOON + 61000), true)
  assert.equal(second.zone, 'Europe/Rome')
})

test('a remembered offset is replaced by whatever is heard', () => {
  const first = new ZoneTracker(settings(), null)
  first.input(OFFSET, 300, NOON)
  const second = new ZoneTracker(settings(), first.serialize())
  assert.equal(second.zone, '+03:00')
  assert.equal(second.input(OFFSET, 300, NOON + 60000), false)
  assert.equal(second.describe().source, 'path')
  assert.equal(second.input(REGION, 'Europe/Athens', NOON + 60000), true)
  assert.equal(second.zone, 'Europe/Athens')
})

test('an unreadable value does not count as hearing from the source', () => {
  const first = new ZoneTracker(settings(), null)
  first.input(REGION, 'Europe/Athens', NOON)
  const second = new ZoneTracker(settings(), first.serialize())
  assert.equal(second.input(OFFSET, 'soon', NOON + 60000), false)
  assert.equal(second.zone, 'Europe/Athens')
  assert.equal(second.describe().source, 'remembered')
})

test('which value was published later is read from the time stamps, not the order of arrival', () => {
  // A name and an offset that disagree, published in one update: on
  // 26 October Athens is two hours ahead, and the offset says three. They
  // carry one time stamp, so the name wins in whichever order they arrive,
  // live or when the plugin reads what the server already holds.
  const late = Date.parse('2026-10-26T21:30:00Z')
  const stamp = Date.parse('2026-10-26T08:00:00Z')
  for (const order of [[OFFSET, REGION], [REGION, OFFSET]]) {
    const tracker = new ZoneTracker(settings(), null)
    for (const path of order) tracker.input(path, path === REGION ? 'Europe/Athens' : 300, late, stamp)
    assert.equal(tracker.zone, 'Europe/Athens', order.join(' then '))
  }
  // An offset with a later stamp wins although it arrives first.
  const tracker = new ZoneTracker(settings(), null)
  tracker.input(OFFSET, 300, late, stamp + 1000)
  tracker.input(REGION, 'Europe/Athens', late, stamp)
  assert.equal(tracker.zone, '+03:00')
  // An offset with an earlier stamp loses although it arrives last.
  const other = new ZoneTracker(settings(), null)
  other.input(REGION, 'Europe/Athens', late, stamp)
  other.input(OFFSET, 300, late, stamp - 1000)
  assert.equal(other.zone, 'Europe/Athens')
})

test('a name and a newer offset that come to disagree at a clock change are noticed without a new value', () => {
  // The source stopped publishing the name and now gives only the offset
  // the crew set by hand. In summer the two agree.
  const summer = Date.parse('2026-10-10T12:00:00Z')
  const tracker = new ZoneTracker(settings(), null)
  tracker.input(REGION, 'Europe/Athens', summer, summer - 86400000)
  tracker.input(OFFSET, 300, summer, summer)
  assert.equal(tracker.zone, 'Europe/Athens')
  assert.equal(tracker.recheck(summer + 3600000), false)
  // On 25 October Athens goes to two hours ahead; the ship still keeps
  // three. Nothing is published, and a later look notices.
  const winter = Date.parse('2026-10-26T12:00:00Z')
  assert.equal(tracker.recheck(winter), true)
  assert.equal(tracker.zone, '+03:00')
  assert.equal(tracker.describe().path, OFFSET)
  assert.equal(tracker.recheck(winter + 60000), false)
})

test('a name that turns to null gives way to the offset', () => {
  const tracker = new ZoneTracker(settings(), null)
  tracker.input(OFFSET, 300, NOON, NOON)
  tracker.input(REGION, 'Europe/Athens', NOON, NOON)
  assert.equal(tracker.zone, 'Europe/Athens')
  assert.equal(tracker.input(REGION, null, NOON + 1000, NOON + 1000), true)
  assert.equal(tracker.zone, '+03:00')
})

test('looking again with nothing heard changes nothing', () => {
  const tracker = new ZoneTracker(settings({ fallback: 'Europe/Rome', fallbackSource: 'setting' }), null)
  assert.equal(tracker.recheck(NOON), false)
  assert.equal(tracker.zone, 'Europe/Rome')
  const off = new ZoneTracker(settings({ follow: false }), null)
  assert.equal(off.recheck(NOON), false)
})

test('a missing or unreadable time stamp counts as now', () => {
  const tracker = new ZoneTracker(settings(), null)
  tracker.input(REGION, 'Europe/Athens', NOON, NaN)
  tracker.input(OFFSET, 200, NOON + 1000, undefined)
  // The offset counts as published a second later, and disagrees.
  assert.equal(tracker.zone, '+02:00')
})
