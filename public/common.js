'use strict'

/*
 * Calculated Paths page: helpers shared by the status view and the editor.
 *
 * Everything the server sends is written with textContent, never as HTML.
 */

;(function () {
  const BASE = '/plugins/signalk-calc-paths/api'
  const SETTINGS_URL = '/admin/#/serverConfiguration/plugins/signalk-calc-paths'

  // A Signal K path, as the plugin checks it: dot-separated segments of
  // letters, digits, dashes and underscores. An output needs two segments.
  const PATH_PATTERN = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/
  const OUTPUT_PATTERN = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/
  const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

  function element (tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  function button (text, className, onClick, label) {
    const node = element('button', className, text)
    node.type = 'button'
    if (label) node.setAttribute('aria-label', label)
    if (onClick) node.addEventListener('click', onClick)
    return node
  }

  /** Formats a number with a sensible count of decimals for its size. */
  function figure (value) {
    const size = Math.abs(value)
    // Below 1 a fixed count of decimals would round a small reading away
    // to zero, so three significant digits are kept instead.
    if (size > 0 && size < 1) return new Intl.NumberFormat(undefined, { maximumSignificantDigits: 3 }).format(value)
    let decimals = 2
    if (size >= 1000) decimals = 0
    else if (size >= 100) decimals = 1
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: decimals }).format(value)
  }

  /**
   * Turns a value in a Signal K unit into the everyday reading for that
   * unit: joules into Wh or kWh, seconds into hours and minutes, and so on.
   * Returns null when the published unit is already the natural reading.
   */
  function everyday (value, unit, type) {
    const size = Math.abs(value)
    switch (unit) {
      case 'J':
        if (size >= 3.6e6) return { figure: figure(value / 3.6e6), unit: 'kWh' }
        if (size >= 3600) return { figure: figure(value / 3600), unit: 'Wh' }
        return null
      case 'W':
        return size >= 1000 ? { figure: figure(value / 1000), unit: 'kW' } : null
      case 's': {
        if (size < 60) return null
        if (type === 'cycles' && size < 3600) {
          // Cycle lengths are compared by the half minute, so seconds stay.
          const whole = Math.round(size)
          const rest = whole % 60
          return { figure: `${value < 0 ? '-' : ''}${Math.floor(whole / 60)} min${rest ? ` ${rest} s` : ''}`, unit: '' }
        }
        const sign = value < 0 ? '-' : ''
        const minutes = Math.round(size / 60)
        const hours = Math.floor(minutes / 60)
        return hours > 0
          ? { figure: `${sign}${hours} h ${String(minutes % 60).padStart(2, '0')} min`, unit: '' }
          : { figure: `${sign}${minutes} min`, unit: '' }
      }
      case 'm':
        return size >= 1852 ? { figure: figure(value / 1852), unit: 'nm' } : null
      case 'm/s':
        return { figure: figure(value * 3600 / 1852), unit: 'kn' }
      case 'm3':
        return size < 1 ? { figure: figure(value * 1000), unit: 'L' } : null
      case 'ratio':
        return { figure: figure(value * 100), unit: '%' }
      case 'K':
        // Only a formula can hold a temperature. A counter or integration
        // in kelvin is a difference or a sum, where the offset is wrong.
        return type === 'formula' ? { figure: figure(value - 273.15), unit: '°C' } : null
      default:
        return null
    }
  }

  /**
   * The unit a setting in a path's own unit is shown and typed in, as the
   * Signal K rules editor shows them: kelvin as °C, ratios as %, pascals as
   * hPa. The value is kept in the Signal K unit. A difference, such as a
   * swing, has no offset: 0.3 K is 0.3 °C. Other units are shown as they
   * are; `unit` is null when the path's unit is not known.
   */
  function shownUnit (units, difference) {
    const clean = (value) => Number(value.toPrecision(12))
    switch (units) {
      case 'K':
        return difference
          ? { unit: '°C', show: (v) => v, store: (v) => v }
          : { unit: '°C', show: (v) => clean(v - 273.15), store: (v) => clean(v + 273.15) }
      case 'ratio':
        return { unit: '%', show: (v) => clean(v * 100), store: (v) => clean(v / 100) }
      case 'Pa':
        return { unit: 'hPa', show: (v) => clean(v / 100), store: (v) => clean(v * 100) }
      default:
        return { unit: units || null, show: (v) => v, store: (v) => v }
    }
  }

  function escapeRegExp (text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  /**
   * Writes a sentence into a node with every path it names set apart in
   * a code font. Only the paths given are marked, so a figure such as 13.75
   * is never mistaken for one.
   */
  function writeWithPaths (node, text, paths) {
    node.replaceChildren()
    const known = [...new Set(paths)].filter((path) => typeof path === 'string' && path.includes('.'))
    if (known.length === 0) {
      node.append(text)
      return node
    }
    known.sort((a, b) => b.length - a.length)
    const pattern = new RegExp(`(?<![A-Za-z0-9_.-])(${known.map(escapeRegExp).join('|')})(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_-])`, 'g')
    let last = 0
    for (const match of text.matchAll(pattern)) {
      if (match.index > last) node.append(text.slice(last, match.index))
      node.append(element('code', 'path', match[0]))
      last = match.index + match[0].length
    }
    if (last < text.length) node.append(text.slice(last))
    return node
  }

  /** Reads and writes a small per-browser preference. Browser storage may be missing or refuse, so every access is guarded. */
  const remembered = {
    get (key, fallback) {
      try {
        const text = window.localStorage.getItem(`calc-paths.${key}`)
        return text === null ? fallback : JSON.parse(text)
      } catch (err) {
        return fallback
      }
    },
    set (key, value) {
      try {
        window.localStorage.setItem(`calc-paths.${key}`, JSON.stringify(value))
      } catch (err) {
        // Not remembered; nothing else depends on it.
      }
    }
  }

  /** Calls the plugin's API and returns the status and the parsed body. */
  async function api (route, options = {}) {
    const init = { credentials: 'same-origin', cache: 'no-store', method: options.method || 'GET', headers: {} }
    if (options.body !== undefined) {
      init.body = JSON.stringify(options.body)
      init.headers['Content-Type'] = 'application/json'
    }
    const response = await fetch(`${BASE}${route}`, init)
    let body = null
    try {
      body = await response.json()
    } catch (err) {
      body = null
    }
    return { status: response.status, ok: response.ok, body }
  }

  window.CalcPaths = {
    BASE,
    NAME_PATTERN,
    OUTPUT_PATTERN,
    PATH_PATTERN,
    SETTINGS_URL,
    api,
    button,
    element,
    everyday,
    shownUnit,
    figure,
    remembered,
    writeWithPaths
  }
})()
