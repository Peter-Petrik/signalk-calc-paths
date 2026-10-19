'use strict'

/*
 * End-to-end check against a running Signal K server.
 *
 * Run by `npm run test:integration` with SIGNALK_URL pointing at a server
 * that has this plugin installed and security switched off. The Signal K
 * plugin CI workflow provides exactly that, with sample NMEA data playing,
 * for every server version it tests.
 *
 * The check configures three entries the way version 0.2.1 kept them, in
 * the lists of the plugin settings, saved through the server's own plugin
 * configuration route. Version 0.3.0 moves them into its entries file on
 * start, which the check verifies, together with the values, the metadata,
 * the status route, the reset route and the status page. It then saves an
 * edited set through the editor's route and verifies that the unchanged
 * entries keep running. It publishes a time zone on a followed path,
 * the way a ship's time plugin would, and verifies that the plugin takes it
 * up. Last it adds a cycles entry on a switch it toggles itself, and checks
 * that an entry that stops sending leaves null on its output path.
 *
 * This file lives outside test/ on purpose: the Node.js test runner picks up
 * every file under a test directory, and this one needs a server.
 */

const assert = require('node:assert/strict')

const BASE = (process.env.SIGNALK_URL || 'http://localhost:3000').replace(/\/$/, '')
// A numeric path that the sample data keeps updating.
const INPUT = process.env.CALC_PATHS_TEST_INPUT || 'navigation.speedOverGround'
const PLUGIN = 'signalk-calc-paths'
const WAIT_MS = 45000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function getJson (path) {
  const response = await fetch(BASE + path)
  assert.equal(response.status, 200, `GET ${path} answered ${response.status}`)
  return response.json()
}

async function selfPath (path) {
  const response = await fetch(`${BASE}/signalk/v1/api/vessels/self/${path.replaceAll('.', '/')}`)
  return response.status === 200 ? response.json() : null
}

/**
 * Sends one value into the server over its WebSocket stream, as any Signal K
 * client may. The server hands it to every subscriber like data from a
 * sensor.
 */
function publish (path, value) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${BASE.replace(/^http/, 'ws')}/signalk/v1/stream?subscribe=none`)
    const timer = setTimeout(() => reject(new Error(`could not publish ${path}: no connection`)), 10000)
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error(`could not publish ${path}: the stream refused the connection`))
    })
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ context: 'vessels.self', updates: [{ $source: 'calc-paths-check', timestamp: new Date().toISOString(), values: [{ path, value }] }] }))
      // The message is sent before the close handshake completes.
      socket.close()
      clearTimeout(timer)
      resolve()
    })
  })
}

/** Polls until `probe` returns something other than null or undefined. */
async function eventually (what, probe) {
  const deadline = Date.now() + WAIT_MS
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const result = await probe()
      if (result !== null && result !== undefined) return result
    } catch (err) {
      lastError = err
    }
    await sleep(1000)
  }
  throw new Error(`Timed out waiting for ${what}${lastError ? `: ${lastError.message}` : ''}`)
}

async function main () {
  console.log(`Checking ${PLUGIN} on ${BASE} with input ${INPUT}`)

  const plugins = await getJson('/skServer/plugins')
  const plugin = plugins.find((p) => p.id === PLUGIN)
  assert.ok(plugin, 'the plugin is not loaded')
  console.log(`  loaded, version ${plugin.version}`)

  const page = await fetch(`${BASE}/${PLUGIN}/`)
  assert.equal(page.status, 200, 'the status page is not served')
  assert.match(await page.text(), /Calculated Paths/)
  console.log('  status page served')

  await eventually(`a value on ${INPUT}`, async () => {
    const node = await selfPath(INPUT)
    return node && typeof node.value === 'number' ? node : null
  })

  // The zone is followed on a path of the check's own, so that nothing the
  // sample data or another plugin publishes can interfere.
  const ZONE_PATH = 'calcPathsCheck.shipsZone'
  const configuration = {
    timeZoneSource: 'follow',
    timeZoneRegionPath: ZONE_PATH,
    timeZoneOffsetPath: 'calcPathsCheck.shipsOffset',
    timeZone: 'UTC',
    formulas: [{ name: 'Check doubled', inputs: [{ name: 'x', path: INPUT }], expression: 'x * 2', output: 'calcPathsCheck.doubled', unit: 'm/s' }],
    counters: [{ name: 'Check change', input: 'calcPathsCheck.doubled', output: 'calcPathsCheck.change', direction: 'net', resets: 'manual' }],
    integrations: [{ name: 'Check sum', input: INPUT, output: 'calcPathsCheck.sum', unit: 'm', resets: 'day', staleTimeout: 0 }]
  }
  const saved = await fetch(`${BASE}/skServer/plugins/${PLUGIN}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true, enableLogging: false, enableDebug: false, configuration })
  })
  assert.equal(saved.status, 200, `saving the configuration answered ${saved.status}`)
  console.log('  configuration saved')

  const doubled = await eventually('the formula output', async () => {
    const node = await selfPath('calcPathsCheck.doubled')
    return node && typeof node.value === 'number' ? node : null
  })
  assert.equal(doubled.$source, PLUGIN)
  assert.equal(doubled.meta.units, 'm/s')
  assert.equal(doubled.meta.displayName, 'Check doubled')
  const source = await selfPath(INPUT)
  // The input keeps moving, so the two readings are compared loosely.
  assert.ok(Math.abs(doubled.value - source.value * 2) <= Math.max(1, Math.abs(source.value)), `formula gave ${doubled.value} for an input of ${source.value}`)
  console.log(`  formula publishes ${doubled.value} with unit ${doubled.meta.units}`)

  const firstSum = await eventually('the integration output', async () => {
    const node = await selfPath('calcPathsCheck.sum')
    return node && typeof node.value === 'number' ? node.value : null
  })
  assert.ok(firstSum >= 0)
  console.log(`  integration publishes ${firstSum}`)

  const status = await eventually('every entry to publish', async () => {
    const body = await getJson(`/plugins/${PLUGIN}/api/entries`)
    return body.entries.length === 3 && body.entries.every((e) => e.state === 'ok') ? body : null
  })
  // Nothing has been published on the followed paths yet, so the zone from
  // the settings is in use.
  assert.equal(status.timeZone, 'UTC')
  assert.equal(status.timeZoneSource.kind, 'setting')
  assert.equal(status.timeZoneSource.follow, true)
  assert.equal(status.clockTrusted, true)
  assert.deepEqual(status.problems, [])
  assert.deepEqual(status.entries.map((e) => e.type), ['formula', 'counter', 'integration'])
  console.log('  status route reports three entries publishing')

  // The entries were moved out of the plugin settings into the editor.
  const settings = await getJson(`/skServer/plugins/${PLUGIN}/config`)
  assert.equal(settings.configuration.formulas, undefined, 'the formulas are still in the plugin settings')
  assert.equal(settings.configuration.timeZoneRegionPath, ZONE_PATH)
  const edited = await getJson(`/plugins/${PLUGIN}/api/config`)
  assert.deepEqual(edited.entries.map((e) => e.output), ['calcPathsCheck.doubled', 'calcPathsCheck.change', 'calcPathsCheck.sum'])
  assert.equal(typeof edited.revision, 'string')
  assert.equal(typeof edited.fields.formula.properties.expression.title, 'string')
  console.log('  entries moved from the plugin settings into the editor')

  // An edited set: a group, a new name, and the same calculations.
  const group = { id: 'gcheck', name: 'Check' }
  const entries = edited.entries.map((entry) => ({ ...entry, group: group.id }))
  entries[0].name = 'Check doubled, renamed'
  const put = await fetch(`${BASE}/plugins/${PLUGIN}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: edited.revision, groups: [group], entries })
  })
  assert.equal(put.status, 200, `saving the edited entries answered ${put.status}`)
  const answer = await put.json()
  assert.deepEqual([answer.kept, answer.started], [3, 0])
  const regrouped = await getJson(`/plugins/${PLUGIN}/api/entries`)
  assert.deepEqual(regrouped.groups, [group])
  assert.equal(regrouped.entries[0].name, 'Check doubled, renamed')
  assert.ok(regrouped.entries.every((e) => e.group === group.id && e.state === 'ok'))
  const stale = await fetch(`${BASE}/plugins/${PLUGIN}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: edited.revision, groups: [], entries: [] })
  })
  assert.equal(stale.status, 409, 'a save from an outdated editor should answer 409')
  const paths = await getJson(`/plugins/${PLUGIN}/api/paths`)
  assert.ok(paths.some((p) => p.path === INPUT && typeof p.value === 'number'), `${INPUT} is not offered to the editor`)
  console.log('  edited entries saved; all three kept running')

  await publish(ZONE_PATH, 'Pacific/Marquesas')
  const followed = await eventually('the published time zone to be followed', async () => {
    const body = await getJson(`/plugins/${PLUGIN}/api/entries`)
    return body.timeZone === 'Pacific/Marquesas' ? body : null
  })
  assert.equal(followed.timeZoneSource.kind, 'path')
  assert.equal(followed.timeZoneSource.path, ZONE_PATH)
  // An offset published afterwards disagrees with the name and is newer,
  // so it takes over: -930 is nine and a half hours behind UTC, 300 is
  // three hours ahead.
  await publish('calcPathsCheck.shipsOffset', 300)
  const offset = await eventually('the published offset to be followed', async () => {
    const body = await getJson(`/plugins/${PLUGIN}/api/entries`)
    return body.timeZone === '+03:00' ? body : null
  })
  assert.equal(offset.timeZoneLabel, 'UTC+03:00')
  assert.equal(offset.entries.every((e) => e.state === 'ok'), true, 'an entry stopped publishing after the zone changed')
  console.log('  a time zone published in Signal K is followed')

  const reset = await fetch(`${BASE}/plugins/${PLUGIN}/api/entries/${encodeURIComponent('calcPathsCheck.sum')}/reset`, { method: 'POST' })
  assert.equal(reset.status, 200, `the reset route answered ${reset.status}`)
  const missing = await fetch(`${BASE}/plugins/${PLUGIN}/api/entries/${encodeURIComponent('calcPathsCheck.doubled')}/reset`, { method: 'POST' })
  assert.equal(missing.status, 404, 'resetting a formula should answer 404')
  console.log('  reset route works')

  // The status line is refreshed once a second, so it is waited for.
  const statusMessage = await eventually('the plugin status to name the followed zone', async () => {
    const pluginsAfter = await getJson('/skServer/plugins')
    const message = String(pluginsAfter.find((p) => p.id === PLUGIN).statusMessage)
    return /3 entries: 3 publishing\. Time zone UTC\+03:00/.test(message) ? message : null
  })
  console.log(`  plugin status: ${statusMessage}`)

  // A cycles entry on a switch of the check's own, switched every three
  // seconds; a shortest stretch of one second lets it count them quickly.
  const SWITCH = 'calcPathsCheck.switch'
  const before = await getJson(`/plugins/${PLUGIN}/api/config`)
  const cycles = { id: 'checkCycles', type: 'cycles', name: 'Check cycles', inputs: [{ path: SWITCH, kind: 'onoff', threshold: 0 }], statistic: 'onMedian', minCycles: 2, shortest: 1, longest: 60, staleTimeout: 0, output: 'calcPathsCheck.onMedian' }
  const withCycles = await fetch(`${BASE}/plugins/${PLUGIN}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: before.revision, groups: before.groups, entries: [...before.entries, cycles] })
  })
  assert.equal(withCycles.status, 200, `saving a cycles entry answered ${withCycles.status}`)
  for (let i = 0; i < 10; i++) {
    await publish(SWITCH, i % 2 === 0)
    await sleep(3000)
  }
  const counted = await eventually('the cycles entry to publish', async () => {
    const body = await getJson(`/plugins/${PLUGIN}/api/entries`)
    const entry = body.entries.find((e) => e.key === 'checkCycles')
    return entry && entry.state === 'ok' && entry.cycles.count >= 2 ? entry : null
  })
  // Each ON stretch lasted about three seconds.
  assert.ok(counted.value > 1 && counted.value < 6, `median ON time ${counted.value} s`)
  assert.equal(counted.unit, 's')
  const onMedian = await selfPath('calcPathsCheck.onMedian')
  assert.equal(onMedian.$source, PLUGIN)
  const forget = await fetch(`${BASE}/plugins/${PLUGIN}/api/entries/${encodeURIComponent('calcPathsCheck.onMedian')}/reset`, { method: 'POST' })
  assert.equal(forget.status, 200, `forgetting the cycles answered ${forget.status}`)
  const forgotten = (await getJson(`/plugins/${PLUGIN}/api/entries`)).entries.find((e) => e.key === 'checkCycles')
  assert.equal(forgotten.cycles.count, 0)
  assert.equal(forgotten.lastReset.cause, 'request')
  console.log(`  cycles entry counted ${counted.cycles.count} cycles with a median ON time of ${counted.value} s, and forgot them on request`)

  // With its cycles forgotten the entry has no figure, so it sends null,
  // and the server serves null rather than the last median.
  await eventually('null on the cycles output', async () => {
    const node = await selfPath('calcPathsCheck.onMedian')
    return node && node.value === null ? node : null
  })
  // An entry switched off in the editor sends null on its output too.
  const latest = await getJson(`/plugins/${PLUGIN}/api/config`)
  const switchedOff = latest.entries.map((entry) => (entry.output === 'calcPathsCheck.doubled' ? { ...entry, enabled: false } : entry))
  const off = await fetch(`${BASE}/plugins/${PLUGIN}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: latest.revision, groups: latest.groups, entries: switchedOff })
  })
  assert.equal(off.status, 200, `switching an entry off answered ${off.status}`)
  await eventually('null on the output of the entry switched off', async () => {
    const node = await selfPath('calcPathsCheck.doubled')
    return node && node.value === null ? node : null
  })
  console.log('  null is served on the output of an entry that stopped sending')

  // Leave the server as it was found.
  const current = await getJson(`/plugins/${PLUGIN}/api/config`)
  await fetch(`${BASE}/plugins/${PLUGIN}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: current.revision, groups: [], entries: [] })
  })
  await fetch(`${BASE}/skServer/plugins/${PLUGIN}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true, configuration: {} })
  })
  console.log('All checks passed')
}

main().catch((err) => {
  console.error(`FAILED: ${err.message}`)
  process.exit(1)
})
