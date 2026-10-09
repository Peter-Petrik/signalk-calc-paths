'use strict'

/*
 * End-to-end check against a running Signal K server.
 *
 * Run by `npm run test:integration` with SIGNALK_URL pointing at a server
 * that has this plugin installed and security switched off. The Signal K
 * plugin CI workflow provides exactly that, with sample NMEA data playing,
 * for every server version it tests.
 *
 * The check configures three entries through the server's own plugin
 * configuration route, waits for them to publish, and verifies the values,
 * the metadata, the status route, the reset route and the status page.
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

  const configuration = {
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
  assert.equal(status.timeZone, 'UTC')
  assert.equal(status.clockTrusted, true)
  assert.deepEqual(status.problems, [])
  assert.deepEqual(status.entries.map((e) => e.type), ['formula', 'counter', 'integration'])
  console.log('  status route reports three entries publishing')

  const reset = await fetch(`${BASE}/plugins/${PLUGIN}/api/entries/${encodeURIComponent('calcPathsCheck.sum')}/reset`, { method: 'POST' })
  assert.equal(reset.status, 200, `the reset route answered ${reset.status}`)
  const missing = await fetch(`${BASE}/plugins/${PLUGIN}/api/entries/${encodeURIComponent('calcPathsCheck.doubled')}/reset`, { method: 'POST' })
  assert.equal(missing.status, 404, 'resetting a formula should answer 404')
  console.log('  reset route works')

  const pluginsAfter = await getJson('/skServer/plugins')
  const statusMessage = pluginsAfter.find((p) => p.id === PLUGIN).statusMessage
  assert.match(String(statusMessage), /3 entries: 3 publishing/)
  console.log(`  plugin status: ${statusMessage}`)

  // Leave the server as it was found.
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
