'use strict'

/*
 * Tests of the null sent on an output path when an entry stops sending:
 * the server keeps the last value of a path, so without it a reader would
 * see the last result as if it were current.
 */

const assert = require('node:assert/strict')
const { test } = require('node:test')

const { normalizeConfig } = require('../lib/config')
const { Engine } = require('../lib/engine')

const NOON = Date.parse('2026-10-19T12:00:00Z')

function harness (entries) {
  let engine = new Engine(normalizeConfig({ timeZone: 'UTC' }, { version: 1, groups: [], entries }), null)
  const at = (seconds) => [NOON + seconds * 1000, seconds * 1000]
  return {
    get engine () { return engine },
    input: (seconds, path, value) => engine.input(path, value, ...at(seconds)),
    /** What one pass sends, as [path, value] pairs. */
    tick: (seconds) => engine.tick(...at(seconds)).map(({ path, value }) => [path, value]),
    status: (id, seconds) => engine.snapshot(...at(seconds)).find((e) => e.key === id),
    reset: (output, seconds) => engine.reset(output, ...at(seconds)),
    edit (seconds, next) {
      const normalized = normalizeConfig({ timeZone: 'UTC' }, { version: 1, groups: [], entries: next })
      const replacement = new Engine(normalized, engine.serialize(NOON + seconds * 1000), engine.timeZone, engine)
      engine = replacement
      engine.prime(...at(seconds))
    }
  }
}

const formula = (extra) => ({ id: 'f', type: 'formula', inputs: [{ name: 'x', path: 'in.x' }], expression: 'x * 2', output: 'out.f', staleTimeout: 30, ...extra })
const counter = (extra) => ({ id: 'c', type: 'counter', input: 'in.total', output: 'out.c', resets: 'manual', staleTimeout: 30, ...extra })
const integration = (extra) => ({ id: 'i', type: 'integration', input: 'in.power', output: 'out.i', resets: 'manual', staleTimeout: 30, ...extra })

test('a stale entry of every type that stops publishing sends null once, and its result again on return', () => {
  const h = harness([formula(), counter(), integration()])
  h.input(0, 'in.x', 5)
  h.input(0, 'in.total', 100)
  h.input(0, 'in.power', 10)
  assert.deepEqual(h.tick(1), [['out.f', 10], ['out.c', 0], ['out.i', 0]])
  assert.deepEqual(h.tick(31), [['out.f', null], ['out.c', null], ['out.i', null]])
  assert.deepEqual(h.tick(32), [])
  assert.deepEqual(h.tick(120), [])
  for (const id of ['f', 'c', 'i']) {
    assert.equal(h.status(id, 120).state, 'stale')
    assert.match(h.status(id, 120).message, /publishing is paused\. Null was sent on out\.\w, so that readers do not see the last result\.$/)
  }
  h.input(121, 'in.x', 6)
  h.input(121, 'in.total', 130)
  assert.deepEqual(h.tick(121), [['out.f', 12], ['out.c', 30]])
  assert.doesNotMatch(h.status('f', 121).message, /Null was sent/)
  // A second silence sends a second null.
  assert.deepEqual(h.tick(152), [['out.f', null], ['out.c', null]])
})

test('"keep publishing" sends no null while an input is stale', () => {
  const h = harness([formula({ onStale: 'hold' })])
  h.input(0, 'in.x', 5)
  assert.deepEqual(h.tick(1), [['out.f', 10]])
  // The last result may be repeated, but no null is sent.
  for (let s = 2; s <= 300; s++) assert.ok(h.tick(s).every(([, value]) => value === 10))
  assert.equal(h.status('f', 300).state, 'stale')
  assert.doesNotMatch(h.status('f', 300).message, /Null/)
})

test('a result withdrawn for any other reason sends null, also with "keep publishing"', () => {
  for (const onStale of ['stop', 'hold']) {
    const h = harness([formula({ onStale, expression: '10 / x' })])
    h.input(0, 'in.x', 5)
    assert.deepEqual(h.tick(1), [['out.f', 2]])
    // The source has no reading.
    h.input(2, 'in.x', null)
    assert.deepEqual(h.tick(2), [['out.f', null]], onStale)
    assert.equal(h.status('f', 2).state, 'waiting')
    assert.match(h.status('f', 2).message, /Null was sent on out\.f/)
    h.input(3, 'in.x', 4)
    assert.deepEqual(h.tick(3), [['out.f', 2.5]])
    // No finite result.
    h.input(4, 'in.x', 0)
    assert.deepEqual(h.tick(4), [['out.f', null]], onStale)
  }
})

test('an entry that has sent nothing since start sends no null', () => {
  const h = harness([formula({ inputs: [{ name: 'x', path: 'in.x' }, { name: 'y', path: 'in.y' }], expression: 'x + y' })])
  h.input(0, 'in.x', 1)
  for (let s = 1; s <= 100; s++) assert.deepEqual(h.tick(s), [])
  assert.doesNotMatch(h.status('f', 100).message, /Null/)
})

test('a cycles figure that drops out after Forget cycles sends null', () => {
  const cycles = { id: 'y', type: 'cycles', inputs: [{ path: 'in.sw', kind: 'onoff', threshold: 0 }], statistic: 'onMedian', minCycles: 2, output: 'out.y', staleTimeout: 0 }
  const h = harness([cycles])
  let sent = []
  for (let s = 0; s <= 3600; s++) {
    // ON 5 min, OFF 5 min.
    if (s % 300 === 0) h.input(s, 'in.sw', Math.floor(s / 300) % 2 === 0 ? 1 : 0)
    sent = sent.concat(h.tick(s))
  }
  assert.ok(sent.some(([path, value]) => path === 'out.y' && value === 300), JSON.stringify(sent))
  assert.equal(h.reset('out.y', 3601), true)
  assert.deepEqual(h.tick(3601), [['out.y', null]])
  assert.equal(h.status('y', 3601).state, 'waiting')
})

test('an edit sends null on a path no entry publishes any more', () => {
  const h = harness([formula(), formula({ id: 'g', output: 'out.g' }), formula({ id: 'k', output: 'out.k' }), formula({ id: 'r', output: 'out.r' })])
  h.input(0, 'in.x', 5)
  assert.deepEqual(h.tick(1).length, 4)
  // f switched off, g deleted, k given another output path, r unchanged.
  h.edit(2, [formula({ enabled: false }), formula({ id: 'k', output: 'out.k2' }), formula({ id: 'r', output: 'out.r' })])
  const sent = h.tick(2)
  assert.deepEqual(sent.filter(([, value]) => value === null).map(([path]) => path).sort(), ['out.f', 'out.g', 'out.k'])
  assert.deepEqual(sent.filter(([, value]) => value !== null), [['out.k2', 10]])
  assert.deepEqual(h.tick(3), [])
})

test('an edited entry that cannot publish at once replaces the old result with null', () => {
  const h = harness([formula()])
  h.input(0, 'in.x', 5)
  assert.deepEqual(h.tick(1), [['out.f', 10]])
  // The entry now also needs in.y, which has no value yet.
  h.edit(2, [formula({ inputs: [{ name: 'x', path: 'in.x' }, { name: 'y', path: 'in.y' }], expression: 'x + y' })])
  assert.deepEqual(h.tick(2), [['out.f', null]])
  h.input(3, 'in.y', 1)
  assert.deepEqual(h.tick(3), [['out.f', 6]])
})

test('an entry switched off says that null was sent on its path', () => {
  const h = harness([formula()])
  h.input(0, 'in.x', 5)
  assert.deepEqual(h.tick(1), [['out.f', 10]])
  h.edit(2, [formula({ enabled: false })])
  assert.deepEqual(h.tick(2), [['out.f', null]])
  const status = h.status('f', 2)
  assert.equal(status.state, 'disabled')
  assert.equal(status.message, 'Nothing is calculated or published. Null was sent on out.f, so that readers do not see the last result.')
})

test('a saved total that is not published at start sends no null', () => {
  const first = harness([counter()])
  first.input(0, 'in.total', 100)
  first.input(10, 'in.total', 150)
  assert.deepEqual(first.tick(10), [['out.c', 50]])
  const saved = first.engine.serialize(NOON + 10000)
  // A restart: the counter's input stays silent, and with "Stop publishing"
  // and a stale timeout the saved total is shown but not published.
  const engine = new Engine(normalizeConfig({ timeZone: 'UTC' }, { version: 1, groups: [], entries: [counter()] }), saved)
  for (let s = 0; s <= 120; s++) assert.deepEqual(engine.tick(NOON + 1e6 + s * 1000, 1e6 + s * 1000), [])
})
