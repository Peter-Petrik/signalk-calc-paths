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

module.exports = { call, fakeApp, fakeRouter }
