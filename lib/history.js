'use strict'

/*
 * Looking back in the server's history.
 *
 * An entry that starts with nothing saved, a new one or one whose measurement
 * was changed, would otherwise begin at nothing: a counter of today's fuel
 * created at noon would miss the morning, a cycles entry would publish no
 * median for hours, a record would not know the lowest value of last week.
 * Signal K server 2.33 and later lets a plugin read the history another
 * plugin keeps, through app.getHistoryApi() (the History API, provided for
 * example by signalk-to-influxdb2). This module asks it once, when the entry
 * starts, and hands back plain facts. What to do with them is decided by the
 * engine; see Engine#applyLookback().
 *
 * The history is read in buckets: a fixed stretch of time, for each of which
 * the provider returns one figure, such as the lowest value in it. Fine
 * buckets over a long time would return more rows than the server should
 * hold in memory at once, so a read never asks for more than BUDGET buckets
 * and coarser buckets are used for longer stretches. Where only one moment
 * matters, such as the last time the input was at a level, the bucket found
 * is read again at a finer resolution, down to one second.
 *
 * Providers differ in what they accept. The one this was written against,
 * signalk-to-influxdb2 2.3.0, reads `from` and `to` by their text, answers
 * an error for a path it holds nothing for, includes the bucket stamped `to`,
 * and cannot average a switch stored as true and false. Each is handled
 * here. The times are given as objects that read as an ISO 8601 date when
 * turned into text and carry `epochMilliseconds`, which is what providers
 * read from the Temporal instants of the History API types.
 */

// The most buckets one read asks for.
const BUDGET = 40000

// How far back a look-back without a natural start goes: a record kept
// "only by hand", a total reset only by hand. Five years is beyond what a
// boat computer keeps, and keeps the first, coarse read short.
const LIMIT_MS = 5 * 366 * 24 * 3600 * 1000

/**
 * A moment as the History API types expect one. Providers turn it into
 * text (signalk-to-influxdb2 parses `toString()`) or read its milliseconds.
 */
function instant (time) {
  const ms = Math.round(time)
  const iso = new Date(ms).toISOString()
  return {
    epochMilliseconds: ms,
    epochNanoseconds: BigInt(ms) * 1000000n,
    toString: () => iso,
    toJSON: () => iso
  }
}

/** The bucket size, in whole seconds, for a stretch: never more than BUDGET buckets. */
function resolutionFor (spanMs, finestSeconds = 1) {
  return Math.max(Math.max(1, Math.round(finestSeconds)), Math.ceil(spanMs / 1000 / BUDGET))
}

/** Reads a switch state as 1 and 0, like the engine; anything else that is not a number as null. */
function numberOf (value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value ? 1 : 0
  return null
}

class HistoryReader {
  /**
   * @param {object} api - What app.getHistoryApi() resolved to.
   * @param {function} [cancelled] - Answers true once the answer is no
   *   longer wanted, as after a time-out or a stop; no further read is
   *   then made.
   */
  constructor (api, cancelled = () => false) {
    this.api = api
    this.cancelled = cancelled
    // How many reads were made, for the status page and the tests.
    this.reads = 0
  }

  /**
   * Reads one path in buckets of `resolution` seconds between two moments.
   * Returns the buckets that hold a number, oldest first, as { t, v } with
   * `t` the start of the bucket in epoch milliseconds. A path the history
   * holds nothing for gives an empty list.
   *
   * An average of a switch fails in InfluxDB, which stores it as true and
   * false; the read is then made again with the last value of each bucket.
   */
  async series (path, aggregate, fromMs, toMs, resolution) {
    if (!(toMs > fromMs)) return []
    try {
      return await this.read(path, aggregate, fromMs, toMs, resolution)
    } catch (err) {
      if (!(await this.holds(path, fromMs, toMs))) return []
      if (aggregate === 'average') return this.read(path, 'last', fromMs, toMs, resolution)
      throw err
    }
  }

  async read (path, aggregate, fromMs, toMs, resolution) {
    if (this.cancelled()) throw new Error('the read was given up')
    this.reads++
    const answer = await this.api.getValues({
      from: instant(fromMs),
      to: instant(toMs),
      resolution,
      pathSpecs: [{ path, aggregate, parameter: [] }]
    })
    const values = answer && Array.isArray(answer.values) ? answer.values : []
    // The column is found by its path: a provider may order the columns
    // its own way. Column 0 holds the time.
    const found = values.findIndex((column) => column && column.path === path)
    const column = found === -1 ? 1 : found + 1
    const rows = answer && Array.isArray(answer.data) ? answer.data : []
    const result = []
    for (const row of rows) {
      if (!Array.isArray(row)) continue
      const t = Date.parse(row[0])
      const v = numberOf(row[column])
      // The bucket stamped `to` begins where the entry's own counting does.
      if (!Number.isFinite(t) || v === null || t >= toMs || t + resolution * 1000 <= fromMs) continue
      result.push({ t, v })
    }
    result.sort((a, b) => a.t - b.t)
    return result
  }

  /**
   * Whether the history holds a path at all between two moments. A failed
   * read of a path it does not hold is no fault; anything else is.
   */
  async holds (path, fromMs, toMs) {
    if (typeof this.api.getPaths !== 'function') return true
    try {
      const paths = await this.api.getPaths({ from: instant(fromMs), to: instant(toMs) })
      return !Array.isArray(paths) || paths.includes(path)
    } catch (err) {
      return true
    }
  }

  /**
   * The last moment the path was at or above a level (`atLeast`), or at or
   * below it, between two moments, to the second; null when it never was.
   */
  async lastAt (path, level, atLeast, fromMs, toMs) {
    let from = fromMs
    let to = toMs
    for (;;) {
      const resolution = resolutionFor(to - from)
      const rows = await this.series(path, atLeast ? 'max' : 'min', from, to, resolution)
      let found = null
      for (let i = rows.length - 1; i >= 0; i--) {
        if (atLeast ? rows[i].v >= level : rows[i].v <= level) {
          found = rows[i]
          break
        }
      }
      if (!found) return null
      if (resolution === 1) return Math.max(found.t, from)
      from = Math.max(found.t, from)
      to = Math.min(found.t + resolution * 1000, to)
    }
  }

  /**
   * The lowest (`lowest`) or highest value of the path between two moments,
   * with the moment it was first reached, to the second; null when the
   * history holds nothing there.
   */
  async extreme (path, lowest, fromMs, toMs) {
    let from = fromMs
    let to = toMs
    let best = null
    for (;;) {
      const resolution = resolutionFor(to - from)
      const rows = await this.series(path, lowest ? 'min' : 'max', from, to, resolution)
      let found = null
      for (const row of rows) {
        if (!found || (lowest ? row.v < found.v : row.v > found.v)) found = row
      }
      if (!found) return best
      best = { value: best === null ? found.v : best.value, at: Math.max(found.t, from) }
      if (resolution === 1) return best
      from = Math.max(found.t, from)
      to = Math.min(found.t + resolution * 1000, to)
    }
  }

  /** The start of the first bucket that holds a value of the path, or null. */
  async earliest (path, fromMs, toMs) {
    const rows = await this.series(path, 'average', fromMs, toMs, resolutionFor(toMs - fromMs))
    return rows.length > 0 ? Math.max(rows[0].t, fromMs) : null
  }

  /**
   * The last fall of a path that the engine would read as a reset (see
   * Engine#followReference()): to below half the value before, or to zero
   * or below from above zero, to the second; null when there is none.
   *
   * The lowest value of each bucket is compared with the one before it.
   * The fall lies between the start of the bucket before and the end of the
   * bucket it shows in; that stretch is read again in finer buckets until
   * they are one second long. A fall that the finer buckets no longer show,
   * such as one spread over many small steps, is placed at the start of the
   * coarsest bucket it was seen in.
   */
  async lastFall (path, fromMs, toMs) {
    let from = fromMs
    let to = toMs
    let found = null
    for (;;) {
      const resolution = resolutionFor(to - from)
      const rows = await this.series(path, 'min', from, to, resolution)
      let at = null
      for (let i = rows.length - 1; i > 0; i--) {
        const previous = rows[i - 1].v
        const value = rows[i].v
        if (value < previous && (value < previous / 2 || (previous > 0 && value <= 0))) {
          at = { t: rows[i].t, before: rows[i - 1].t }
          break
        }
      }
      if (at === null) return found
      found = Math.max(at.t, from)
      if (resolution === 1) return found
      from = Math.max(at.before, from)
      to = Math.min(at.t + resolution * 1000, to)
    }
  }
}

/**
 * Carries out a look-back the engine planned (Engine#lookbackPlan()) and
 * returns what it found, for Engine#applyLookback(). Throws when the history
 * cannot be read; an empty history is no error.
 *
 * Plans and their answers:
 *
 * 1. Counter and integration: the input in buckets from the start of what
 *    the total covers, which is the start of the period, the last fall of
 *    the followed path, or the start of what the history holds. Answer:
 *    { from, resolution, rows }. A followed path with no fall in the
 *    history leaves no rows and a reason in `unknown`, as for a record.
 * 2. Cycles: each input in buckets over the window. Answer:
 *    { from, resolution, inputs: [rows, ...] }.
 * 3. Record of a lowest or highest value: the extreme since the record last
 *    started again, which is the period start, the last time the input was
 *    at the level, or the last fall of the followed path. Answer:
 *    { from, extreme: { value, at } | null }.
 * 4. Record of a time since: the last time the input was at the level.
 *    Answer: { from, lastMet }.
 */
async function lookBack (api, plan, cancelled) {
  const reader = new HistoryReader(api, cancelled)
  const to = plan.to
  const answer = { from: null }
  const start = async (path) => {
    if (plan.from !== null) return plan.from
    if (plan.resets === 'path') {
      // Without the last fall of the followed path, what the entry covers
      // is not known, and nothing is filled in.
      const fall = await reader.lastFall(plan.resetPath, to - LIMIT_MS, to)
      if (fall === null) answer.unknown = `the history holds no fall of ${plan.resetPath}, so where the ${plan.type === 'record' ? 'record' : 'total'} starts is not known`
      return fall
    }
    if (plan.resets === 'level') return reader.lastAt(path, plan.resetLevel, plan.keep === 'lowest', to - LIMIT_MS, to)
    return null
  }
  if (plan.type === 'counter' || plan.type === 'integration') {
    let from = await start(plan.input)
    if (from === null && !answer.unknown) from = await reader.earliest(plan.input, to - LIMIT_MS, to)
    answer.from = from
    if (from === null) {
      answer.rows = []
      answer.resolution = null
    } else {
      // A counter's running total is read as its highest value in each
      // bucket when it counts increases and its lowest when it counts
      // decreases, so that a dip in a bucket is not taken for a restart;
      // net change and integrations take the average.
      const aggregate = plan.type === 'counter' ? ({ increase: 'max', decrease: 'min' }[plan.direction] || 'average') : 'average'
      answer.resolution = resolutionFor(to - from, plan.finest)
      answer.rows = await reader.series(plan.input, aggregate, from, to, answer.resolution)
    }
  } else if (plan.type === 'cycles') {
    answer.from = plan.from
    answer.resolution = resolutionFor(to - plan.from, plan.finest)
    answer.inputs = []
    for (const path of plan.inputs) answer.inputs.push(await reader.series(path, 'average', plan.from, to, answer.resolution))
  } else if (plan.type === 'record') {
    if (plan.timeSince) {
      answer.from = to - LIMIT_MS
      answer.lastMet = await reader.lastAt(plan.input, plan.level, plan.keep === 'sinceAbove', answer.from, to)
    } else {
      // The record starts again at the moment found, from the value then.
      const from = await start(plan.input)
      answer.from = from
      answer.extreme = answer.unknown ? null : await reader.extreme(plan.input, plan.keep === 'lowest', from === null ? to - LIMIT_MS : from, to)
    }
  }
  answer.reads = reader.reads
  return answer
}

module.exports = { BUDGET, HistoryReader, LIMIT_MS, instant, lookBack, resolutionFor }
