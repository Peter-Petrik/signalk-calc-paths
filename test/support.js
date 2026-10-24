'use strict'

/*
 * A stand-in for the Signal K server API, for tests of the plugin as the
 * server sees it. It records what the plugin subscribes to, publishes and
 * saves, and lets a test push deltas through the subscription.
 *
 * The Node.js test runner also runs this file, as it runs every file under
 * test/. It holds no tests, so that run passes at once.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function fakeApp (selfPaths = {}, pluginOptions = null) {
  const app = {
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'calc-paths-plugin-')),
    selfPaths,
    // The plugin options file as the server keeps it.
    pluginOptions,
    messages: [],
    statuses: [],
    errors: [],
    logged: [],
    subscriptions: [],
    unsubscribed: 0,
    getDataDirPath: () => app.dataDir,
    getSelfPath: (p) => app.selfPaths[p],
    handleMessage: (id, delta) => app.messages.push({ id, delta }),
    setPluginStatus: (text) => app.statuses.push(text),
    setPluginError: (text) => app.errors.push(text),
    debug: () => {},
    error: (text) => app.logged.push(text),
    readPluginOptions: () => app.pluginOptions || {},
    savePluginOptions (configuration, callback) {
      app.pluginOptions = { ...(app.pluginOptions || {}), configuration }
      callback(null)
    },
    streambundle: {
      getAvailablePaths: () => Object.keys(app.selfPaths)
    },
    replay: [],
    subscriptionmanager: {
      subscribe (command, unsubscribes, onError, callback) {
        const subscription = { command, callback, active: true }
        app.subscriptions.push(subscription)
        unsubscribes.push(() => { subscription.active = false; app.unsubscribed++ })
        for (const delta of app.replay) callback(delta)
      }
    },
    /** Pushes one value through every live subscription, as the server would. */
    send (p, value, source = 'test', timestamp = new Date().toISOString()) {
      for (const subscription of app.subscriptions) {
        if (!subscription.active) continue
        if (!subscription.command.subscribe.some((s) => s.path === p)) continue
        subscription.callback({ context: 'vessels.self', updates: [{ $source: source, timestamp, values: [{ path: p, value }] }] })
      }
    },
    /** The latest value published on each path. */
    values () {
      const latest = {}
      for (const { delta } of app.messages) {
        for (const update of delta.updates) {
          for (const item of update.values || []) latest[item.path] = item.value
        }
      }
      return latest
    },
    file (name) {
      const file = path.join(app.dataDir, name)
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
    }
  }
  return app
}

/** A router stand-in that records routes and the access level they asked for. */
function fakeRouter () {
  const routes = {}
  const add = (level, method) => (route, handler) => { routes[`${method} ${route}`] = { level, handler } }
  const methods = (level) => ({ get: add(level, 'GET'), post: add(level, 'POST'), put: add(level, 'PUT') })
  return { ...methods('admin'), access: methods, routes }
}

/** Calls a route handler and returns what it answered. */
function call (route, { params = {}, body } = {}) {
  const response = { statusCode: 200, body: null }
  route.handler({ params, body }, {
    status (code) { response.statusCode = code; return this },
    json (value) { response.body = value }
  })
  return response
}

/**
 * A stand-in for a History API provider, answering as signalk-to-influxdb2
 * 2.3.0 does: buckets aligned to whole multiples of the resolution since
 * the epoch, stamped with their start, empty buckets left out, the bucket
 * that holds `to` included, an error for a path it holds nothing for, and
 * an error for the average of a switch stored as true and false.
 *
 * @param {object} samples - Per path, a list of { t, v } with t in epoch ms.
 */
function fakeHistory (samples) {
  const history = {
    requests: [],
    async getValues (query) {
      history.requests.push({ from: String(query.from), to: String(query.to), resolution: query.resolution, pathSpecs: query.pathSpecs })
      if (history.fail) throw new Error(history.fail)
      const from = Date.parse(String(query.from))
      const to = Date.parse(String(query.to))
      const size = query.resolution * 1000
      const columns = query.pathSpecs.map((spec) => {
        const list = samples[spec.path]
        if (!list) throw new Error(`no measurement ${spec.path}`)
        const buckets = new Map()
        for (const sample of list) {
          if (sample.t < from || sample.t > to) continue
          const start = Math.floor(sample.t / size) * size
          if (!buckets.has(start)) buckets.set(start, [])
          buckets.get(start).push(sample.v)
        }
        const result = new Map()
        for (const [start, values] of buckets) {
          if (spec.aggregate === 'average' && values.some((v) => typeof v === 'boolean')) throw new Error('unsupported mean iterator type: *query.booleanInterruptibleIterator')
          let v
          if (spec.aggregate === 'min') v = Math.min(...values)
          else if (spec.aggregate === 'max') v = Math.max(...values)
          else if (spec.aggregate === 'last') v = values[values.length - 1]
          else if (spec.aggregate === 'first') v = values[0]
          else v = values.reduce((a, b) => a + b, 0) / values.length
          result.set(start, v)
        }
        return result
      })
      const times = [...new Set(columns.flatMap((column) => [...column.keys()]))].sort((a, b) => a - b)
      return {
        context: 'vessels.self',
        range: { from: String(query.from), to: String(query.to) },
        values: query.pathSpecs.map((spec) => ({ path: spec.path, method: spec.aggregate })),
        data: times.map((t) => [new Date(t).toISOString(), ...columns.map((column) => column.has(t) ? column.get(t) : null)])
      }
    },
    async getPaths () {
      return Object.keys(samples)
    },
    async getContexts () {
      return ['vessels.self']
    }
  }
  return history
}

module.exports = { call, fakeApp, fakeHistory, fakeRouter }
