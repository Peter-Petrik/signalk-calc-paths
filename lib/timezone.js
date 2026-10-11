'use strict'

/*
 * Which time zone the day boundaries are worked out in.
 *
 * A boat moves, and the time its crew keeps moves with it. Signal K has two
 * paths for the time zone a vessel keeps, environment.time.timezoneRegion
 * (a name such as "Europe/Athens") and environment.time.timezoneOffset (a
 * number such as 300 for three hours east of UTC). A plugin that publishes
 * them, or any other source writing to a path of the same form, lets this
 * plugin follow the ship's time without a setting to maintain.
 *
 * The tracker below decides, from the values seen on those paths and from
 * the settings, which zone is in use. In order of preference:
 *
 * 1. The zone name on the region path, when it names a known zone. A name
 *    is preferred because it carries the zone's daylight saving rules.
 * 2. The offset on the offset path. It is also used when it was published
 *    after the name and disagrees with it: a source that stops publishing a
 *    name leaves the old one behind in the server, and the newer value is
 *    then the one to believe.
 * 3. The last zone followed, remembered across restarts. Without this,
 *    every restart would fall back to the setting until the source spoke
 *    again, and could move a day boundary in the meantime.
 * 4. The zone chosen in the settings, which defaults to the server's own.
 *
 * "Published after" is judged by the time stamps the values carry, never by
 * the order in which they happen to reach this plugin. The server delivers
 * the two values of one update one after the other, and hands over the
 * values it already holds in an order of its own; a rule based on arrival
 * would choose differently after a restart than before it, with nothing
 * having been published in between.
 *
 * The tracker knows nothing about Signal K. It is fed path values and
 * answers with a zone.
 */

const { MAX_OFFSET_MINUTES, canonicalTimeZone, fixedOffsetMs, offsetZone, zoneOffset } = require('./periods')

const DEFAULT_REGION_PATH = 'environment.time.timezoneRegion'
const DEFAULT_OFFSET_PATH = 'environment.time.timezoneOffset'

/**
 * Reads a time zone from a value found on a followed path.
 *
 * Two forms are understood, on either path:
 *
 * 1. Text naming a zone: an IANA name, or a fixed offset such as "+03:00".
 * 2. A number in the encoding the Signal K specification gives for
 *    environment.time.timezoneOffset: hours and minutes written as one
 *    number, so 300 is +03:00, -930 is -09:30 and 0 is UTC.
 *
 * Anything else (null, an object, a number whose last two digits are not
 * minutes, an offset beyond what any clock keeps) yields null.
 */
function zoneFromValue (value) {
  if (typeof value === 'string') return canonicalTimeZone(value)
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  const size = Math.abs(value)
  const hours = Math.floor(size / 100)
  const minutes = size % 100
  if (minutes > 59) return null
  const total = hours * 60 + minutes
  if (total > MAX_OFFSET_MINUTES) return null
  return offsetZone(value < 0 ? -total : total)
}

/**
 * Writes a zone for people: a fixed offset as "UTC+03:00", a name as it is.
 */
function describeZone (timeZone) {
  return fixedOffsetMs(timeZone) === null ? timeZone : `UTC${timeZone}`
}

/** Whether a zone is a name with rules of its own, not a bare offset. */
function isNamed (timeZone) {
  return fixedOffsetMs(timeZone) === null && timeZone !== 'UTC'
}

/**
 * Reads a saved record of a zone change, keeping only what has the
 * expected form. It is shown to people and decides nothing.
 */
function readChange (raw) {
  if (!raw || typeof raw !== 'object' || !Number.isFinite(raw.at)) return null
  const from = canonicalTimeZone(raw.from)
  const to = canonicalTimeZone(raw.to)
  if (!from || !to) return null
  return {
    at: raw.at,
    from,
    to,
    fromPath: typeof raw.fromPath === 'string' ? raw.fromPath : null,
    toPath: typeof raw.toPath === 'string' ? raw.toPath : null
  }
}

class ZoneTracker {
  /**
   * @param {object} settings - The `zone` part of normalizeConfig()'s
   *   settings: `follow`, `regionPath`, `offsetPath`, `fallback` and
   *   `fallbackSource`.
   * @param {object|null} saved - The `zone` part of the saved state.
   */
  constructor (settings, saved) {
    this.settings = settings
    // Latest value read from each followed path: { zone, stamp } when
    // usable, { raw, stamp } when not. `stamp` is the time the value was
    // published, in milliseconds.
    this.seen = new Map()
    this.followed = null
    // Whether the zone in use was read from its path since the plugin
    // started, as opposed to being remembered from before.
    this.confirmed = false
    this.dirty = false
    // The last time the zone in use, or the path it is read from, changed
    // while following: when, from what and to what. Kept for people; a
    // zone that changes without the boat moving is otherwise invisible.
    this.lastChange = null

    this.paths = []
    if (settings.follow) {
      for (const path of [settings.regionPath, settings.offsetPath]) {
        if (path && !this.paths.includes(path)) this.paths.push(path)
      }
      // A remembered zone is only meaningful for the paths it was read
      // from. After the paths are changed in the settings, what the old
      // ones said is forgotten.
      if (saved && typeof saved === 'object' && saved.regionPath === settings.regionPath && saved.offsetPath === settings.offsetPath) {
        const zone = canonicalTimeZone(saved.zone)
        if (zone) {
          this.followed = {
            zone,
            path: typeof saved.path === 'string' && this.paths.includes(saved.path) ? saved.path : this.paths[0],
            heardAt: Number.isFinite(saved.heardAt) ? saved.heardAt : null
          }
        }
        this.lastChange = readChange(saved.lastChange)
      }
    }
  }

  /** The zone in use. */
  get zone () {
    return this.followed ? this.followed.zone : this.settings.fallback
  }

  /**
   * Takes in one value from a followed path. Returns true when the zone in
   * use changed as a result.
   *
   * @param {string} path
   * @param {*} value
   * @param {number} wall - The present moment.
   * @param {number} [stamp] - When the value was published, when known.
   *   Without it the value is taken to have been published now.
   * @param {string} [source] - The source of the value, when known. Used
   *   only to tell a source's own later value from another source's old one.
   */
  input (path, value, wall, stamp, source) {
    if (!this.paths.includes(path)) return false
    // A time stamp from the future (a source with a wrong clock) counts as
    // now, so that it cannot outrank everything published later.
    const published = Number.isFinite(stamp) ? Math.min(stamp, wall) : wall
    // A value from another source that is older than the one already read
    // for this path is not news. The server keeps the last value of every
    // source that ever wrote to a path and may hand over an old one after
    // the current one. A source's own values are always taken, also with
    // an earlier time stamp: its clock may have been set back.
    const known = this.seen.get(path)
    if (known && published < known.stamp && source !== known.source) return false
    const zone = zoneFromValue(value)
    this.seen.set(path, zone ? { zone, stamp: published, source } : { raw: value, stamp: published, source })
    return this.apply(wall)
  }

  /**
   * Looks again at what the paths last said. A name and an offset that
   * agreed when they were published can come to disagree later, at the
   * name's next daylight saving change, without anything new being
   * published; this is called now and then to notice. Returns true when
   * the zone in use changed.
   */
  recheck (wall) {
    return this.apply(wall)
  }

  /** Makes the choice and records it. Returns true when the zone changed. */
  apply (wall) {
    const chosen = this.choose(wall)
    // Paths that give no usable value change nothing: the last zone
    // followed stays in force.
    if (!chosen) return false

    const before = this.zone
    if (!this.followed || this.followed.zone !== chosen.zone || this.followed.path !== chosen.path) {
      this.lastChange = {
        at: wall,
        from: before,
        to: chosen.zone,
        fromPath: this.followed ? this.followed.path : null,
        toPath: chosen.path
      }
      this.followed = { zone: chosen.zone, path: chosen.path, heardAt: wall }
      this.dirty = true
    } else if (chosen.heard && !this.confirmed) {
      // Read again after a restart: the zone is confirmed, not remembered.
      this.followed.heardAt = wall
      this.dirty = true
    }
    if (chosen.heard) this.confirmed = true
    return this.zone !== before
  }

  /**
   * Picks between the followed paths. Returns { zone, path, heard } or null
   * when there is nothing to go on. `heard` is false when the zone is the
   * remembered one standing in for a path that has not spoken.
   */
  choose (wall) {
    const [regionPath, offsetPath] = this.paths
    const heard = (path) => {
      const latest = path === undefined ? undefined : this.seen.get(path)
      return latest && latest.zone ? { zone: latest.zone, path, stamp: latest.stamp, heard: true } : null
    }

    let name = heard(regionPath)
    // After a restart of the server the region path is silent until its
    // source publishes again, and the offset is often published a moment
    // before the name. Until the region path has spoken, a remembered name
    // stands in for it, dated when it was last heard. An offset that agrees
    // with it then leaves it in place; without this, every restart would
    // switch to the bare offset and back to the name a moment later.
    if (!name && !this.seen.has(regionPath) && this.followed && isNamed(this.followed.zone)) {
      name = {
        zone: this.followed.zone,
        path: this.followed.path,
        stamp: this.followed.heardAt === null ? -Infinity : this.followed.heardAt,
        heard: false
      }
    }
    const offset = heard(offsetPath)

    if (!name) return offset
    // The name wins unless the offset was published strictly later and the
    // two disagree at this moment. Two values published together, as one
    // update or with the same time stamp, are a name and its own offset.
    if (offset && offset.stamp > name.stamp && zoneOffset(wall, offset.zone) !== zoneOffset(wall, name.zone)) {
      return offset
    }
    return name
  }

  /**
   * Describes the zone in use and where it comes from, for the status page.
   *
   * `source` is one of:
   *   "path"       read from a followed path since the plugin started
   *   "remembered" the last zone followed, not read again since start
   *   "setting"    the zone chosen in the settings
   *   "server"     the server's own time zone
   */
  describe () {
    const settings = this.settings
    const info = {
      timeZone: this.zone,
      label: describeZone(this.zone),
      follow: settings.follow,
      paths: [...this.paths],
      path: null,
      since: null,
      lastChange: this.lastChange === null ? null : { ...this.lastChange, at: new Date(this.lastChange.at).toISOString() },
      problem: null
    }

    if (this.followed) {
      info.source = this.confirmed ? 'path' : 'remembered'
      info.path = this.followed.path
      info.since = this.followed.heardAt === null ? null : new Date(this.followed.heardAt).toISOString()
    } else {
      info.source = settings.fallbackSource
    }

    // A followed path that carries something unreadable is worth saying,
    // also when the other path is fine: a name that cannot be read means
    // the zone's daylight saving rules are not being followed. A null is
    // "no value" and is not complained about.
    const unreadable = this.paths.filter((path) => {
      const latest = this.seen.get(path)
      return latest && !latest.zone && latest.raw !== null && latest.raw !== undefined
    })
    if (unreadable.length > 0) {
      info.problem = `The value on ${unreadable.join(' and ')} is not a time zone name or an offset in hours and minutes, and is ignored.`
    }
    return info
  }

  /** What to save: the last zone followed and the paths it came from. */
  serialize () {
    this.dirty = false
    if (!this.settings.follow || !this.followed) return null
    return {
      zone: this.followed.zone,
      path: this.followed.path,
      heardAt: this.followed.heardAt,
      lastChange: this.lastChange,
      regionPath: this.settings.regionPath,
      offsetPath: this.settings.offsetPath
    }
  }
}

module.exports = {
  DEFAULT_OFFSET_PATH,
  DEFAULT_REGION_PATH,
  ZoneTracker,
  describeZone,
  zoneFromValue
}
