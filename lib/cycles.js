'use strict'

/*
 * Cycle detection, for the "Cycles" entry type.
 *
 * A cycle is an ON stretch followed by an OFF stretch: a compressor running
 * and resting, a pump, a heater. The tracker finds those stretches in one or
 * more inputs and combines the inputs, then reports figures over a window of
 * recent cycles, such as the median ON time over the last 24 hours.
 *
 * Each input is read in one of two ways:
 *
 * 1. On/off. The input is ON while its value is above a threshold. A switch
 *    sends true or false, which count as 1 and 0, so a threshold of 0 reads
 *    it directly.
 * 2. Wave. The input rises and falls with the cycles without saying which
 *    state it is in: the humidity in a fridge falls while the compressor
 *    runs and rises while it rests. The input is resampled to fixed steps,
 *    smoothed, and cut into falling and rising stretches wherever it turns
 *    by at least a set swing. Either direction can be the ON one.
 *
 * A wave stretch is known only once the input has turned back by the full
 * swing, so its state is confirmed some time after the fact. Every input
 * therefore keeps a timeline of states, each known up to a moment ("until"),
 * and the inputs are combined only up to the earliest such moment.
 *
 * Inputs are combined like the conditions of a rule, at each moment:
 *
 * 1. "all": ON while every input is ON. OFF as soon as one input is OFF.
 * 2. "any": ON while at least one input is ON. OFF while all are OFF.
 *
 * An input with nothing to say is left out of the combination: one with no
 * value yet or a gap in its data, and a wave that has not turned for longer
 * than the longest stretch, such as a temperature too damped to show the
 * cycles. The others decide alone. With every input left out, nothing is
 * known. A stretch during which an input drops out or comes back is not
 * measured, because it was timed partly by different inputs.
 *
 * An entry that publishes the ON time so far reads a flat wave differently
 * when the wave went flat while ON: it stays ON. A compressor that never
 * stops looks exactly like that, the humidity or temperature falling to its
 * lowest and staying there, and that is the case the figure is for.
 *
 * Inputs that respond with a delay change the combined stretch lengths: two
 * signals that follow the same compressor two minutes apart overlap for two
 * minutes less, so "all" reads ON stretches shorter and "any" longer by
 * that delay. The figures stay comparable over time, which is what a trend
 * or an alert limit needs.
 *
 * A change of the combined state is accepted only once the new state has
 * held for the shortest stretch setting. A brief flicker is thereby kept
 * inside the stretch it interrupts, instead of cutting it in two.
 *
 * All times inside the tracker are monotonic milliseconds; see the engine
 * for why. Finished stretches also carry the wall-clock time they ended,
 * which is what the window and the saved state use.
 */

const STEP_MS = 30000

function median (values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** A timeline of states: the state from each change on, known up to `until`. */
class Timeline {
  constructor () {
    this.changes = []
    this.until = null
  }

  /** Records that the state is `state` from `at` on. Later changes win. */
  set (at, state) {
    while (this.changes.length > 0 && this.changes[this.changes.length - 1].at >= at) this.changes.pop()
    const last = this.changes[this.changes.length - 1]
    if (!last || last.state !== state) this.changes.push({ at, state })
  }

  /** The state at a moment, or null when nothing is known about it. */
  stateAt (at) {
    // The last change at or before `at`, found by halving: a timeline can
    // hold many changes while another input holds the combination back.
    let low = 0
    let high = this.changes.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (this.changes[middle].at <= at) low = middle + 1
      else high = middle
    }
    return low === 0 ? null : this.changes[low - 1].state
  }

  /** Drops changes before `at` that no later question can need. */
  forget (at) {
    let keep = 0
    while (keep + 1 < this.changes.length && this.changes[keep + 1].at <= at) keep++
    if (keep > 0) this.changes.splice(0, keep)
  }
}

/** An input read as on/off against a threshold. */
class OnOffInput {
  constructor (settings, gapMs) {
    this.threshold = settings.threshold
    this.gapMs = gapMs
    this.timeline = new Timeline()
    this.lastMono = null
  }

  input (value, mono) {
    this.advance(mono)
    // A value handed over late, such as the held value of a path read anew
    // after an edit, counts from the time already combined: what lies
    // before has been decided.
    const at = this.timeline.until === null ? mono : Math.max(mono, this.timeline.until)
    this.timeline.set(at, value === null ? null : value > this.threshold)
    this.lastMono = at
    this.timeline.until = at
  }

  advance (mono) {
    if (this.lastMono === null) {
      // Never heard from: nothing to say, which is known up to now, so the
      // other inputs decide alone.
      this.timeline.until = Math.max(this.timeline.until === null ? mono : this.timeline.until, mono)
      return
    }
    // Within the gap a state holds; past it, the input has nothing to say.
    if (this.gapMs > 0 && mono - this.lastMono > this.gapMs) {
      this.timeline.set(this.lastMono + this.gapMs, null)
    }
    this.timeline.until = Math.max(this.timeline.until || mono, mono)
  }
}

/** An input read as a wave: falling and rising stretches. */
class WaveInput {
  constructor (settings, gapMs, smoothingMs, longestMs, holdOn = false) {
    this.longestMs = longestMs
    // Whether a wave that goes flat while ON stays ON; see the top of the file.
    this.holdOn = holdOn
    // Set while the wave is flat and held ON.
    this.held = false
    this.firstMono = null
    this.onWhen = settings.direction === 'rising' ? 'up' : 'down'
    this.swing = settings.swing
    this.gapMs = gapMs
    // The number of steps averaged. One step means no smoothing.
    this.span = Math.max(1, Math.round(smoothingMs / STEP_MS))
    this.timeline = new Timeline()
    this.bucket = null
    this.lastMono = null
    this.recent = []
    this.raw = []
    this.windowStart = null
    // Set while the data has a gap, until the next step arrives.
    this.silent = false
    // Set while the wave has not turned for longer than the longest stretch.
    this.flat = false
    this.resetTurn()
  }

  /**
   * Places a turning point on the step means near the one found on the
   * smoothed values. Smoothing moves a peak towards its slower side when
   * the wave falls and rises at different rates; the step means do not.
   *
   * Among equal values the latest wins, here and in turn(): a humidity
   * sensor at saturation reads exactly 100 % for minutes on end, and the
   * stretch that follows begins where the value moves away from such a
   * plateau, not where it first reached it.
   */
  extreme (at, highest) {
    const reach = (this.span / 2 + 0.5) * STEP_MS
    let best = null
    for (const step of this.raw) {
      if (Math.abs(step.at - at) > reach) continue
      if (!best || (highest ? step.value >= best.value : step.value <= best.value)) best = step
    }
    return best ? best.at : at
  }

  resetTurn () {
    // Whether the timeline holds the state after the last turning point.
    this.open = false
    this.direction = null
    this.turnedAt = null
    // When the last turning point was found: the swing back that confirms
    // a turn comes some minutes after the turn itself.
    this.turnFoundAt = null
    this.held = false
    this.high = null
    this.low = null
  }

  /**
   * A gap in the data: the stretch under way can no longer be measured.
   * Its state since the last confirmed turning point stays as confirm()
   * set it; from the gap on nothing is known.
   */
  breakOff (at) {
    // What lies before `until` has been combined already.
    if (this.timeline.until !== null) at = Math.max(at, this.timeline.until)
    this.timeline.set(at, null)
    this.firstMono = null
    this.timeline.until = at
    this.recent = []
    this.resetTurn()
  }

  input (value, mono) {
    this.advance(mono)
    if (value === null) return
    // A value handed over late counts from the latest time seen.
    if (this.lastMono !== null && mono < this.lastMono) mono = this.lastMono
    if (this.timeline.until !== null && mono < this.timeline.until) mono = this.timeline.until
    const index = Math.floor(mono / STEP_MS)
    if (this.bucket && this.bucket.index !== index) this.closeBucket()
    if (!this.bucket) this.bucket = { index, sum: 0, count: 0 }
    this.bucket.sum += value
    this.bucket.count++
    if (this.firstMono === null) this.firstMono = mono
    this.lastMono = mono
  }

  advance (mono) {
    if (this.lastMono === null && !this.bucket) {
      // Never heard from: nothing to say, known up to now.
      this.timeline.until = Math.max(this.timeline.until === null ? mono : this.timeline.until, mono)
      return
    }
    if (this.bucket && mono >= (this.bucket.index + 1) * STEP_MS) this.closeBucket()
    if (this.lastMono !== null && this.gapMs > 0 && mono - this.lastMono > this.gapMs && !this.silent) {
      this.breakOff(this.lastMono)
      this.silent = true
    }
    if (this.silent) {
      // In a gap: nothing to say, known up to now.
      this.timeline.until = Math.max(this.timeline.until, mono)
      return
    }
    // A wave's state is known only up to its last turn. A wave that has not
    // turned for longer than the longest stretch shows no cycles, and has
    // nothing to say from its last turn (or its first value) on; it then
    // stops holding the other inputs back, for as long as it stays flat.
    if (this.flat) {
      this.timeline.until = Math.max(this.timeline.until, mono)
      return
    }
    // Measured from when the last turning point was found, not from `until`:
    // a wave that drifts one way after a turn reaches new extremes, which
    // move `until` on (see extend()), but it shows no cycles either. Not
    // from the turning point itself either: the turn that ends a stretch is
    // found as long after its end as the turn that began it was after its
    // start, so a stretch shorter than the longest would otherwise be cut
    // off before its end could be found.
    const since = this.turnFoundAt !== null ? this.turnFoundAt : this.firstMono
    if (since !== null && mono - since > this.longestMs) {
      const at = this.timeline.until !== null ? this.timeline.until : since
      this.flat = true
      // Held: the state since the last turn, ON, goes on being known; the
      // timeline keeps it and `until` follows the present (see above).
      this.held = this.holdOn && this.open && this.direction === this.onWhen
      if (!this.held) this.timeline.set(at, null)
      this.open = false
      this.timeline.until = Math.max(at, mono)
    }
  }

  closeBucket () {
    const { index, sum, count } = this.bucket
    this.bucket = null
    const at = index * STEP_MS + STEP_MS / 2
    const previous = this.raw[this.raw.length - 1]
    // A hole longer than the gap (or than one step, with no gap set) breaks
    // the series: averaging across it would invent values. A shorter hole,
    // from a sensor that reports less often than every step, leaves the
    // steps present to be averaged.
    if (previous && at - previous.at > Math.max(this.gapMs, STEP_MS * 1.5)) {
      this.breakOff(previous.at)
      this.recent = []
      this.raw = []
    }
    this.silent = false
    if (this.firstMono === null) this.firstMono = at
    if (this.recent.length === 0) this.windowStart = at
    // The step means themselves, for placing turning points; see extreme().
    // Kept back to the extremes still being tracked, within a bound.
    this.raw.push({ at, value: sum / count })
    const tracked = this.high && this.low ? Math.min(this.high.at, this.low.at) : at
    const from = Math.max(tracked - (this.span + 1) * STEP_MS, at - this.longestMs - this.span * 2 * STEP_MS)
    while (this.raw.length > 0 && this.raw[0].at < from) this.raw.shift()
    // The steps within the smoothing span, by time.
    this.recent.push({ at, value: sum / count })
    while (this.recent[0].at <= at - this.span * STEP_MS) this.recent.shift()
    // Averaged once the span is covered since the series began.
    if (at - this.windowStart < (this.span - 1) * STEP_MS) return
    const mean = this.recent.reduce((total, item) => total + item.value, 0) / this.recent.length
    // The average stands for the middle of the steps it covers, so the
    // smoothing adds no delay to the turning points.
    const centre = this.recent.reduce((total, item) => total + item.at, 0) / this.recent.length
    const turned = this.turnedAt
    this.turn(centre, mean)
    if (this.turnedAt !== turned) this.turnFoundAt = at
    this.extend()
  }

  /** Finds turning points by the swing, as a zigzag does. */
  turn (at, value) {
    if (this.high === null) {
      this.high = { at, value }
      this.low = { at, value }
      return
    }
    if (this.direction === null) {
      if (value >= this.high.value) this.high = { at, value }
      if (value <= this.low.value) this.low = { at, value }
      if (value <= this.high.value - this.swing) {
        this.direction = 'down'
        this.turnedAt = this.extreme(this.high.at, true)
        this.low = { at, value }
      } else if (value >= this.low.value + this.swing) {
        this.direction = 'up'
        this.turnedAt = this.extreme(this.low.at, false)
        this.high = { at, value }
      }
      return
    }
    if (this.direction === 'down') {
      if (value <= this.low.value) {
        this.low = { at, value }
      } else if (value >= this.low.value + this.swing) {
        const bottom = this.extreme(this.low.at, false)
        this.confirm(this.turnedAt, bottom, 'down')
        this.direction = 'up'
        this.turnedAt = bottom
        this.high = { at, value }
      }
    } else {
      if (value >= this.high.value) {
        this.high = { at, value }
      } else if (value <= this.high.value - this.swing) {
        const top = this.extreme(this.high.at, true)
        this.confirm(this.turnedAt, top, 'up')
        this.direction = 'down'
        this.turnedAt = top
        this.low = { at, value }
      }
    }
  }

  /**
   * A stretch between two turning points is now certain, and so is the
   * change at its end: the value has turned back by the swing since. The
   * state after that change is known only up to the change itself, since
   * the next turning point may lie anywhere after it.
   */
  confirm (from, to, direction) {
    // What lies before `until` has been combined already: after a flat
    // spell, a gap, or the first value, it is not rewritten. When the whole
    // stretch lies before it, only the state since its end is new.
    const until = this.timeline.until
    this.flat = false
    this.open = true
    if (this.held) {
      // The wave held ON has turned at last. Where the turn lies has been
      // combined as ON already, so the stretch that follows cannot be timed
      // from its start: nothing is known for a moment, as after an
      // ordinary flat spell, and the new state counts from the present.
      this.held = false
      if (until !== null && to <= until) {
        this.timeline.set(until, null)
        this.timeline.set(until + 1, direction !== this.onWhen)
        this.timeline.until = until + 1
        return
      }
    }
    if (until !== null && to <= until) {
      this.timeline.set(until, direction !== this.onWhen)
      return
    }
    const start = until === null ? from : Math.max(from, until)
    this.timeline.set(start, direction === this.onWhen)
    this.timeline.set(to, direction !== this.onWhen)
    this.timeline.until = to
  }

  /**
   * After a confirmed turn the new state holds at least up to the most
   * extreme value seen since, less the reach of extreme(): the next turning
   * point cannot lie earlier. Knowing this lets a change be accepted, and a
   * stretch recorded, a few minutes after it ends instead of a stretch later.
   */
  extend () {
    if (this.flat || !this.open || this.direction === null) return
    const extreme = this.direction === 'down' ? this.low.at : this.high.at
    const safe = extreme - (this.span / 2 + 0.5) * STEP_MS
    if (safe > this.timeline.until) this.timeline.until = safe
  }
}

class CycleTracker {
  /**
   * @param {object} config - A normalized "cycles" entry; see lib/config.js.
   */
  constructor (config) {
    this.config = config
    this.inputs = config.inputs.map((input) => input.kind === 'wave'
      ? new WaveInput(input, config.staleMs, config.smoothingMs, config.longestMs, config.statistic === 'onSoFar')
      : new OnOffInput(input, config.staleMs))
    // Which inputs had something to say in the stretch under way.
    this.members = ''
    // The combined state, as accepted, and since when.
    this.state = null
    this.since = null
    // Whether the stretch in progress began with a change between ON and
    // OFF, and so can be measured from its start.
    this.measurable = false
    // A change of the combined state waiting to hold for the shortest
    // stretch before it is accepted.
    this.pending = null
    this.doneUntil = null
    // Finished stretches: { on, ms, end } with end in wall-clock time.
    this.stretches = []
    this.lastInputMono = null
    // The end of the last stretch recorded, on the monotonic clock.
    this.lastEnd = null
    // When the stretches were last forgotten: a stretch that began before
    // is not recorded when it ends.
    this.clearedAt = null
  }

  input (index, value, mono) {
    this.inputs[index].input(value, mono)
    this.lastInputMono = mono
  }

  /** The combined state of the inputs at a moment. */
  combine (at) {
    const states = this.inputs.map((input) => input.timeline.stateAt(at))
    const members = states.map((state) => (state === null ? '-' : '+')).join('')
    const known = states.filter((state) => state !== null)
    let state = null
    if (known.length > 0) state = this.config.combine === 'any' ? known.includes(true) : !known.includes(false)
    return { state, members }
  }

  /**
   * Brings the combined timeline up to the latest moment every input is
   * known for, and records the stretches that finished. `wall` and `mono`
   * are the present moment, used to date finished stretches.
   */
  advance (wall, mono) {
    for (const input of this.inputs) input.advance(mono)
    const known = Math.min(...this.inputs.map((input) => input.timeline.until === null ? -Infinity : input.timeline.until))
    if (!Number.isFinite(known)) return
    const start = this.doneUntil === null ? -Infinity : this.doneUntil
    if (known <= start) return

    // Every moment at which some input changes, in order.
    const moments = new Set()
    for (const input of this.inputs) {
      for (const change of input.timeline.changes) {
        if (change.at >= start && change.at <= known) moments.add(change.at)
      }
    }
    if (this.doneUntil === null) moments.add(Math.min(...this.inputs.map((input) => input.timeline.changes.length > 0 ? input.timeline.changes[0].at : known)))
    for (const at of [...moments].sort((a, b) => a - b)) {
      const { state, members } = this.combine(at)
      if (members !== this.members) {
        // An input dropped out or came back: the stretch under way was
        // timed partly by other inputs and is not measured.
        this.settle(at, wall, mono)
        this.members = members
        this.pending = null
        this.measurable = false
      }
      this.consider(at, state, wall, mono)
    }
    // A change still waiting is accepted once it has held long enough.
    this.settle(known, wall, mono)
    this.doneUntil = known
    for (const input of this.inputs) input.timeline.forget(known)
  }

  /**
   * Accepts a waiting change once it has held for the shortest stretch,
   * counting short interruptions as part of it, or drops it when the state
   * it interrupted has come back for that long.
   */
  settle (time, wall, mono) {
    const pending = this.pending
    if (!pending) return
    if (pending.interruptedAt !== null) {
      if (time - pending.interruptedAt >= this.config.shortestMs) this.pending = null
      return
    }
    if (time - pending.at >= this.config.shortestMs) this.accept(pending, wall, mono)
  }

  consider (at, state, wall, mono) {
    this.settle(at, wall, mono)
    if (state === null) {
      // Not knowing is accepted at once: a stretch it interrupts cannot be
      // measured, whatever follows.
      this.pending = null
      this.accept({ at, state: null }, wall, mono)
      return
    }
    if (this.pending) {
      if (state === this.pending.state) {
        this.pending.interruptedAt = null
        return
      }
      if (state === this.state) {
        // Back to the accepted state for a moment: an interruption of the
        // change, which still counts if it is short.
        if (this.pending.interruptedAt === null) this.pending.interruptedAt = at
        return
      }
    }
    if (state !== this.state) this.pending = { at, state, interruptedAt: null }
  }

  accept (change, wall, mono) {
    this.pending = null
    if (change.state === this.state) return
    const counted = this.clearedAt === null || this.since >= this.clearedAt
    if (this.state !== null && this.since !== null && this.measurable && change.state !== null && counted) {
      const ms = change.at - this.since
      // Whether it follows the last stretch recorded without a break, told
      // by the monotonic clock: a pair of ON and OFF is a complete cycle.
      const joined = this.lastEnd === this.since
      this.stretches.push({ on: this.state, ms, end: wall - (mono - change.at), joined })
      this.lastEnd = change.at
    }
    this.measurable = this.state !== null && change.state !== null
    this.state = change.state
    this.since = change.at
  }

  /**
   * Drops stretches that ended before the window and, while the clock is
   * trusted, those dated more than a window after the present: a clock
   * that ran that far ahead and was set back dated them, and the present
   * would not reach them for longer than the window. Both ends are checked
   * on every stretch, since a stretch dated ahead can sit among older ones.
   *
   * While the clock is not trusted, such as at a boot that starts in 1970
   * before the time is set, every stretch lies after the present; dropping
   * them would lose the cycles of the window, so they are kept and only
   * left out of the figures until the clock is right.
   */
  trim (wall) {
    const window = this.config.windowMs
    const ahead = this.clockTrusted === false ? Infinity : wall + window
    if (this.stretches.some((s) => s.end < wall - window || s.end > ahead)) {
      this.stretches = this.stretches.filter((s) => s.end >= wall - window && s.end <= ahead)
    }
  }

  /**
   * The stretches the figures are taken from. One dated after the present
   * by more than a minute was dated by a clock that was later set back; it
   * is kept, but left out until the present catches up with it.
   */
  inWindow (wall) {
    this.trim(wall)
    return this.stretches.filter((s) => s.end >= wall - this.config.windowMs && s.end <= wall + 60000)
  }

  /**
   * The figures over the window. Stretches longer than the longest setting
   * are left out of them, as a pull-down after loading or a door left open
   * would otherwise distort a median.
   *
   * The ON time so far is the exception: it is the stretch under way, not
   * one from the window, and it goes on growing past the longest stretch,
   * which is what shows a compressor that never stops. It needs `mono`, the
   * present moment; without it, it is null.
   */
  figures (wall, mono) {
    const stretches = this.inWindow(wall)
    const longest = this.config.longestMs
    const usable = stretches.filter((s) => s.ms <= longest)
    const on = usable.filter((s) => s.on).map((s) => s.ms)
    const off = usable.filter((s) => !s.on).map((s) => s.ms)
    // Complete cycles: an ON stretch and the OFF stretch straight after it.
    // The duty cycle is taken over these alone, so that a window that
    // happens to hold one more OFF than ON stretch does not tilt it.
    const pairs = []
    for (let i = 1; i < stretches.length; i++) {
      const a = stretches[i - 1]
      const b = stretches[i]
      // Saved before `joined` was kept, adjacency is told by the dates.
      const joined = typeof b.joined === 'boolean' ? b.joined : Math.abs(b.end - b.ms - a.end) < 1000
      if (a.on && !b.on && a.ms <= longest && b.ms <= longest && joined) pairs.push([a.ms, b.ms])
    }
    const periods = pairs.map(([a, b]) => a + b)
    const pairOn = pairs.reduce((total, [a]) => total + a, 0)
    const pairAll = periods.reduce((total, p) => total + p, 0)
    const lastOn = [...usable].reverse().find((s) => s.on)
    return {
      cycles: on.length,
      onMedian: median(on),
      offMedian: median(off),
      periodMedian: median(periods),
      duty: pairAll > 0 ? pairOn / pairAll : null,
      lastOn: lastOn ? lastOn.ms : null,
      onSoFar: mono === undefined ? null : this.onSoFar(mono)
    }
  }

  /**
   * How long the combined state has been ON, in ms: 0 while it is OFF and
   * null while it is not known (a gap, a wave that showed no cycles, no
   * input yet). A wave that went flat while ON is held ON for this figure. An ON stretch whose start was not seen, such as one under
   * way when the plugin started, is counted from when the state became
   * known, which is as long as it has certainly lasted.
   */
  onSoFar (mono) {
    if (this.state === null || this.since === null) return null
    return this.state ? Math.max(0, mono - this.since) : 0
  }

  /** The current combined state and how long it has lasted, for the status page. */
  current (mono) {
    if (this.state === null || this.since === null) return { state: null, ms: null }
    return { state: this.state, ms: this.measurable ? Math.max(0, mono - this.since) : null }
  }

  /**
   * Forgets every finished stretch, as after a defrost. The stretch under
   * way, and a wave stretch not yet confirmed, began before and are not
   * recorded either.
   */
  clear (mono) {
    this.stretches = []
    this.clearedAt = mono
  }

  serialize () {
    return this.stretches.map((s) => ({ on: s.on, ms: s.ms, end: s.end, joined: s.joined }))
  }

  restore (saved) {
    if (!Array.isArray(saved)) return
    this.stretches = saved
      .filter((s) => s && typeof s.on === 'boolean' && Number.isFinite(s.ms) && s.ms >= 0 && Number.isFinite(s.end))
      .map((s) => typeof s.joined === 'boolean' ? { on: s.on, ms: s.ms, end: s.end, joined: s.joined } : { on: s.on, ms: s.ms, end: s.end })
      .sort((a, b) => a.end - b.end)
  }
}

module.exports = { CycleTracker, STEP_MS, median }
