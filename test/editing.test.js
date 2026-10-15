'use strict'

/*
 * Tests of saving edited entries while the plugin runs: which entries keep
 * running untouched, which start again, and what each one keeps.
 */

const assert = require('node:assert/strict')
const { test } = require('node:test')

const { normalizeConfig } = require('../lib/config')
const { Engine } = require('../lib/engine')

const NOON = Date.parse('2026-10-09T12:00:00Z')

const settings = { timeZone: 'UTC' }

function doc (entries, groups = []) {
  return { version: 1, groups, entries }
}

/** An engine whose entries can be replaced by an edited set, as the plugin does. */
function harness (document) {
  let engine = new Engine(normalizeConfig(settings, document), null)
  const values = {}
  const at = (seconds) => [NOON + seconds * 1000, seconds * 1000]
  return {
    get engine () { return engine },
    input: (seconds, path, value) => engine.input(path, value, ...at(seconds)),
    tick (seconds) {
      for (const { path, value } of engine.tick(...at(seconds))) values[path] = value
    },
    edit (seconds, next) {
      const normalized = normalizeConfig(settings, next)
      for (const entry of normalized.entries) assert.equal(entry.error, null, `${entry.label}: ${entry.error}`)
      const replacement = new Engine(normalized, engine.serialize(NOON + seconds * 1000), engine.timeZone, engine)
      const previous = engine
      engine = replacement
      engine.prime(...at(seconds))
      return previous
    },
    value: (path) => values[path],
    entry: (id) => engine.entries.find((e) => e.config.id === id),
    status: (id, seconds) => engine.snapshot(...at(seconds)).find((e) => e.key === id)
  }
}

const power = { id: 'p', type: 'integration', input: 'el.power', output: 'el.energy', unit: 'J', resets: 'manual' }
const yieldToday = { id: 'y', type: 'counter', input: 'el.yieldTotal', output: 'el.yieldToday', unit: 'J', resets: 'manual' }

test('an integration loses nothing when another entry is edited', () => {
  // The same samples go to two engines; one has another entry edited half-way.
  const plain = harness(doc([power, yieldToday]))
  const edited = harness(doc([power, yieldToday]))
  const samples = [[0, 100], [1, 120], [2, 140], [3, 90], [4, 60], [5, 80], [6, 100]]
  for (const [seconds, watts] of samples) {
    if (seconds === 3) {
      const kept = edited.entry('p')
      edited.edit(2.5, doc([power, { ...yieldToday, name: 'Renamed', staleTimeout: 30 }]))
      // The integration is the very same running entry, mid-stretch.
      assert.equal(edited.entry('p'), kept)
      assert.notEqual(edited.entry('y'), undefined)
    }
    plain.input(seconds, 'el.power', watts)
    edited.input(seconds, 'el.power', watts)
  }
  plain.tick(6)
  edited.tick(6)
  // 110 + 130 + 115 + 75 + 70 + 90, the trapezoids between the samples
  assert.equal(plain.value('el.energy'), 590)
  assert.equal(edited.value('el.energy'), 590)
})

test('a change of name, unit or group keeps an entry running untouched', () => {
  const h = harness(doc([yieldToday], [{ id: 'g1', name: 'Solar' }]))
  h.input(0, 'el.yieldTotal', 1000)
  h.input(10, 'el.yieldTotal', 1600)
  const before = h.entry('y')
  h.edit(11, doc([{ ...yieldToday, name: 'Yield', unit: 'Wh', group: 'g1' }], [{ id: 'g1', name: 'Solar' }]))
  assert.equal(h.entry('y'), before)
  assert.equal(h.entry('y').config.name, 'Yield')
  assert.equal(h.entry('y').config.group, 'g1')
  assert.equal(h.engine.fresh.size, 0)
  h.input(20, 'el.yieldTotal', 1700)
  h.tick(20)
  assert.equal(h.value('el.yieldToday'), 700)
})

test('a changed entry starts again and keeps its total when it still measures the same thing', () => {
  const h = harness(doc([yieldToday]))
  h.input(0, 'el.yieldTotal', 1000)
  h.input(10, 'el.yieldTotal', 1600)
  h.edit(11, doc([{ ...yieldToday, minStep: 5 }]))
  const status = h.status('y', 11)
  // Restarted from the saved total, and handed the latest input value at
  // once, so nothing is waiting and nothing is counted twice.
  assert.equal(status.value, 600)
  assert.equal(status.state, 'ok')
  h.input(20, 'el.yieldTotal', 1650)
  h.tick(20)
  assert.equal(h.value('el.yieldToday'), 650)
})

test('a change of what an entry measures starts it from zero', () => {
  const h = harness(doc([yieldToday]))
  h.input(0, 'el.yieldTotal', 1000)
  h.input(10, 'el.yieldTotal', 1600)
  h.edit(11, doc([{ ...yieldToday, direction: 'net' }]))
  h.input(20, 'el.yieldTotal', 1650)
  h.tick(20)
  assert.equal(h.value('el.yieldToday'), 50)
})

test('a new entry on a path already read gets its latest value at once, the others see nothing extra', () => {
  // A switch that is sent only when it changes, read by a time integration.
  const pump = { id: 'pump', type: 'integration', input: 'sw.pump', output: 'sw.pumpTime', mode: 'time', staleTimeout: 0, resets: 'manual' }
  const h = harness(doc([pump]))
  h.input(0, 'sw.pump', true)
  h.tick(100)
  assert.equal(h.value('sw.pumpTime'), 100)
  // Added while the switch has been on for 100 s and has said nothing since.
  const count = { id: 'c', type: 'counter', input: 'sw.pump', output: 'sw.pumpOn', direction: 'net', staleTimeout: 0, resets: 'manual' }
  h.edit(100, doc([pump, count]))
  const status = h.status('c', 100)
  assert.equal(status.state, 'ok')
  assert.equal(status.value, 0)
  h.tick(160)
  // The running integration counted every second, and nothing twice.
  assert.equal(h.value('sw.pumpTime'), 160)
})

test('a new entry that reads another entry gets that entry\'s current result at once', () => {
  const h = harness(doc([yieldToday]))
  h.input(0, 'el.yieldTotal', 1000)
  h.input(10, 'el.yieldTotal', 4600)
  const wh = { id: 'wh', type: 'formula', inputs: [{ name: 't', path: 'el.yieldToday' }], expression: 't / 3600', output: 'el.yieldTodayWh', unit: 'Wh' }
  const before = h.entry('y')
  h.edit(11, doc([yieldToday, wh]))
  assert.equal(h.entry('y'), before)
  assert.equal(h.status('wh', 11).value, 1)
  // The counter did not take its own result in again.
  assert.equal(h.status('y', 11).value, 3600)
})

test('deleting an entry leaves the others running, and switching one off keeps its total for later', () => {
  const h = harness(doc([power, yieldToday]))
  h.input(0, 'el.yieldTotal', 1000)
  h.input(10, 'el.yieldTotal', 1500)
  h.input(0, 'el.power', 10)
  h.input(10, 'el.power', 10)
  const integration = h.entry('p')
  h.edit(11, doc([power, { ...yieldToday, enabled: false }]))
  assert.equal(h.entry('p'), integration)
  assert.equal(h.status('y', 11).state, 'disabled')
  h.edit(12, doc([power, yieldToday]))
  assert.equal(h.status('y', 12).value, 500)
  h.edit(13, doc([power]))
  assert.equal(h.entry('p'), integration)
  assert.equal(h.engine.entries.length, 1)
})

test('entries keep the order of the document, and the status names each one\'s group', () => {
  const h = harness(doc([{ ...yieldToday, group: 'g2' }, power], [{ id: 'g1', name: 'Engine' }, { id: 'g2', name: 'Solar' }]))
  const snapshot = h.engine.snapshot(NOON, 0)
  assert.deepEqual(snapshot.map((e) => [e.key, e.group]), [['y', 'g2'], ['p', null]])
})

test('an entry left alone loses nothing when an entry it reads is restarted', () => {
  // A formula sampled every 10 s feeds an integration. Only the formula is
  // changed, between two samples. The integration must add up exactly what
  // it adds up when nothing is edited.
  const formula = { id: 'f', type: 'formula', inputs: [{ name: 'x', path: 'm.x' }], expression: 'x', output: 'm.f', staleTimeout: 60 }
  const sum = { id: 's', type: 'integration', input: 'm.f', output: 'm.sum', staleTimeout: 15, resets: 'manual' }
  for (const interval of [10, 14]) {
    const plain = harness(doc([formula, sum]))
    const edited = harness(doc([formula, sum]))
    for (let t = 0; t <= 42; t += interval) {
      if (t > 0 && t - interval < 8 && t > 8) {
        const kept = edited.entry('s')
        edited.edit(8, doc([{ ...formula, staleTimeout: 30 }, sum]))
        assert.equal(edited.entry('s'), kept)
      }
      plain.input(t, 'm.x', 20)
      edited.input(t, 'm.x', 20)
    }
    const end = Math.floor(42 / interval) * interval
    plain.tick(end)
    edited.tick(end)
    assert.equal(edited.value('m.sum'), plain.value('m.sum'), `samples every ${interval} s`)
    assert.equal(plain.value('m.sum'), 20 * end)
  }
})

test('a path read again after a pause is not handed its value from before the pause', () => {
  const counter = { id: 'c', type: 'counter', input: 'm.total', output: 'm.today', resets: 'manual', staleTimeout: 0 }
  const h = harness(doc([counter]))
  h.input(0, 'm.total', 1000)
  // The counter is deleted: nothing reads m.total any more.
  h.edit(10, doc([]))
  // Later a new counter on the same path is added. The value from before
  // the pause must not become its starting point.
  h.edit(3600, doc([{ ...counter, id: 'c2' }]))
  assert.equal(h.status('c2', 3600).state, 'waiting')
  h.input(3601, 'm.total', 1500)
  h.input(3602, 'm.total', 1510)
  h.tick(3602)
  assert.equal(h.value('m.today'), 10)
})

test('deleting an entry deletes its total, while totals no entry used at the start are kept', () => {
  const a = { id: 'a', type: 'counter', input: 'a.total', output: 'a.today', resets: 'manual' }
  const b = { id: 'b', type: 'counter', input: 'b.total', output: 'b.today', resets: 'manual' }
  const saved = { savedAt: NOON - 1000, entries: { 'old.today': { signature: 'counter|old.total|increase', resets: 'manual', total: 7 } } }
  const h = { engine: new Engine(normalizeConfig(settings, doc([a, b])), saved) }
  h.engine.input('a.total', 1, NOON, 0)
  h.engine.input('b.total', 1, NOON, 0)
  h.engine.input('b.total', 4, NOON + 1000, 1000)
  const next = new Engine(normalizeConfig(settings, doc([a])), h.engine.serialize(NOON + 2000), 'UTC', h.engine)
  const state = next.serialize(NOON + 3000)
  assert.deepEqual(Object.keys(state.entries).sort(), ['a.today', 'old.today'])
})

test('a kept total is taken up only by an entry that restores from it', () => {
  const saved = { savedAt: NOON - 1000, entries: { 'b.hours': { signature: 'counter|b.total|increase', resets: 'manual', total: 999, last: 3 } } }
  // An unfinished entry with the same output, switched off, takes nothing.
  const draft = { id: 'd', type: 'counter', enabled: false, input: '', output: 'b.hours', resets: 'manual' }
  const first = new Engine(normalizeConfig(settings, doc([draft])), saved)
  assert.equal(first.serialize(NOON).entries['b.hours'].total, 999)
  // Finished later, it continues the total.
  const finished = new Engine(normalizeConfig(settings, doc([{ ...draft, enabled: true, input: 'b.total' }])), first.serialize(NOON + 1000), 'UTC', first)
  assert.equal(finished.snapshot(NOON + 1000, 1000).find((e) => e.key === 'd').value, 999)
})

test('a cycles entry keeps running on a new name, and keeps its stretches on a new window', () => {
  const pump = { id: 'cy', type: 'cycles', inputs: [{ path: 'sw.pump', kind: 'onoff' }], statistic: 'cycles', output: 'sw.pumpCycles', staleTimeout: 0, shortest: 30 }
  const h = harness(doc([pump]))
  // Five minutes ON, five OFF, four times.
  for (let t = 0; t <= 2400; t += 300) h.input(t, 'sw.pump', (t / 300) % 2 === 0)
  h.tick(2400)
  const counted = h.status('cy', 2400).cycles.count
  assert.ok(counted >= 3, `counted ${counted}`)
  const before = h.entry('cy')
  h.edit(2401, doc([{ ...pump, name: 'Pump cycles' }]))
  assert.equal(h.entry('cy'), before)
  h.edit(2402, doc([{ ...pump, name: 'Pump cycles', window: 12 }]))
  assert.notEqual(h.entry('cy'), before)
  assert.equal(h.status('cy', 2402).cycles.count, counted)
  // A new swing or input forgets them.
  h.edit(2403, doc([{ ...pump, inputs: [{ path: 'sw.pump', kind: 'onoff', threshold: 0.5 }] }]))
  assert.equal(h.status('cy', 2403).cycles.count, 0)
})
