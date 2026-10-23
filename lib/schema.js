'use strict'

/*
 * The configuration form, and the fields of the entry editor.
 *
 * The Signal K admin UI draws the settings schema as the plugin's settings
 * page. From version 0.3.0 it holds only what applies to every entry: the
 * time zone, the day start, the week start and the repeat interval.
 *
 * The entries are edited on the plugin's page under Webapps. That page
 * builds its forms from `entryFields`, one JSON Schema object per entry
 * type, so the titles, explanations and choices are written once, here.
 */

const { DEFAULT_REPEAT_SECONDS, DEFAULT_STALE_SECONDS, SERVER_ZONE } = require('./config')
const { MAX_OFFSET_MINUTES, canonicalTimeZone, offsetZone } = require('./periods')
const { DEFAULT_OFFSET_PATH, DEFAULT_REGION_PATH, describeZone } = require('./timezone')

// Offsets from UTC, in minutes, that are not whole hours and that some zone
// keeps at some time of the year: UTC+05:30 in India, UTC+05:45 in Nepal,
// UTC-03:30 and UTC-02:30 in Newfoundland, and so on. They are written out
// instead of being asked of the runtime, because asking means building a
// date formatter for each of some four hundred zones every time the server
// loads the plugin. A test checks the list against the runtime.
const PART_HOUR_OFFSETS = [-570, -210, -150, 210, 270, 330, 345, 390, 525, 570, 630, 765, 825]

// Zone names in current use that some runtimes accept but do not list: the
// runtime's list may give only the older name of a zone that was renamed
// ("Europe/Kiev" for "Europe/Kyiv"). Each is offered when the runtime
// accepts it and has not listed it already.
const RENAMED_ZONES = [
  'Africa/Asmara',
  'America/Argentina/Buenos_Aires',
  'America/Argentina/Catamarca',
  'America/Argentina/Cordoba',
  'America/Argentina/Jujuy',
  'America/Argentina/Mendoza',
  'America/Atikokan',
  'America/Indiana/Indianapolis',
  'America/Kentucky/Louisville',
  'America/Nuuk',
  'Asia/Ho_Chi_Minh',
  'Asia/Kathmandu',
  'Asia/Kolkata',
  'Asia/Yangon',
  'Atlantic/Faroe',
  'Europe/Kyiv',
  'Pacific/Chuuk',
  'Pacific/Kanton',
  'Pacific/Pohnpei'
]

/**
 * Builds the choices of the time zone dropdown.
 *
 * 1. The server's own zone and UTC come first.
 * 2. Fixed offsets follow: every whole hour from UTC-12:00 to UTC+14:00 and
 *    the part-hour offsets above.
 * 3. Zone names come last, in alphabetical order: the names the runtime
 *    lists, and the renamed zones it accepts.
 *
 * A named zone changes with daylight saving by itself; a fixed offset
 * never changes. The labels say so, because the difference only shows
 * twice a year.
 */
function timeZoneChoices () {
  let names = []
  try {
    names = Intl.supportedValuesOf('timeZone')
  } catch (err) {
    // A runtime without the list still offers the server zone, UTC and the
    // fixed offsets.
  }
  const listed = new Set(names)
  for (const name of RENAMED_ZONES) {
    if (!listed.has(name) && canonicalTimeZone(name) === name) listed.add(name)
  }
  listed.delete('UTC')
  names = [...listed].sort()

  const minutes = new Set(PART_HOUR_OFFSETS)
  for (let m = -12 * 60; m <= MAX_OFFSET_MINUTES; m += 60) minutes.add(m)
  minutes.delete(0)
  const offsets = [...minutes].sort((a, b) => a - b).map(offsetZone)

  return {
    values: [SERVER_ZONE, 'UTC', ...offsets, ...names],
    labels: [
      'The server\'s own time zone',
      'UTC',
      ...offsets.map((zone) => `${describeZone(zone)} (fixed, no daylight saving)`),
      ...names
    ]
  }
}

const timeZones = timeZoneChoices()

const enabled = {
  type: 'boolean',
  title: 'Switched on',
  default: true
}

const name = {
  type: 'string',
  title: 'Name',
  description: 'A label for this entry. Shown on the Calculated Paths page and published as the description of the output path.'
}

const output = {
  type: 'string',
  title: 'Output path',
  description: 'The Signal K path the result is published on, for example electrical.solar.hardtop.yieldToday. Pick a path no other source writes.'
}

const unit = {
  type: 'string',
  title: 'Unit',
  description: 'Unit of the result, published with the output path so displays can label it. Signal K uses SI units: W, J, V, A, s, m3, K, Pa, ratio. Leave empty for a plain number.'
}

const staleTimeout = {
  type: 'number',
  title: 'Stale timeout (seconds)',
  description: 'An input with no new value for this long is treated as stale. Set 0 for inputs that are sent only when they change, such as a switch state.',
  default: DEFAULT_STALE_SECONDS,
  minimum: 0
}

const onStale = {
  type: 'string',
  title: 'When an input is stale',
  description: 'Stop publishing until the input returns, or keep publishing the last result. Either way nothing is recalculated from a stale input. An entry that stops publishing, for this or any other reason, such as an input with no reading or a result that is not a number, sends null once on its output path, so that readers of the path see that there is no reading rather than the last result; the result is sent again as soon as there is one. Keeping the last result applies only to a stale input.',
  default: 'stop',
  enum: ['stop', 'hold'],
  enumNames: ['Stop publishing', 'Keep publishing the last result']
}

const resets = {
  type: 'string',
  title: 'Resets',
  description: 'When the total goes back to zero. Changing this setting clears the total.',
  default: 'day',
  enum: ['day', 'week', 'month', 'year', 'path', 'manual'],
  enumNames: ['Every day', 'Every week', 'Every month', 'Every year', 'When another path resets', 'Only by hand']
}

const resetPath = {
  type: 'string',
  title: 'Path to follow for resets',
  description: 'Used only with "When another path resets". The total is cleared whenever the value on this path falls, for example a daily yield that another device sets back to zero.'
}

const resetsWording = 'When the total goes back to zero. Day, week, month and year begin at the day start in the plugin settings, in the ship\'s time zone when one is followed and otherwise in the time zone chosen there. Any total can also be reset by hand on the status page. Changing this setting clears the total.'

const schema = {
  type: 'object',
  title: 'Calculated Paths',
  description: 'Calculates new Signal K paths from existing ones. Formulas combine live values, period counters report how much a running total has changed since the start of a day, week, month or year, integrations add up a rate over time, and cycles entries report how long a device such as a fridge compressor runs and rests. The entries are created and edited on the Calculated Paths page under Webapps, which also shows their values and status. The settings here apply to every entry.',
  properties: {
    timeZoneSource: {
      type: 'string',
      title: 'Time zone for day boundaries',
      description: 'A day, week, month or year begins at local midnight, and "local" needs a time zone. Following the ship\'s time means the zone is read from Signal K, where a plugin such as Ship\'s Time publishes it, and changes by itself when the boat changes time zone. If nothing is published, the time zone chosen below is used.',
      default: 'follow',
      enum: ['follow', 'fixed'],
      enumNames: ['Follow the ship\'s time published in Signal K', 'Always use the time zone chosen below']
    },
    timeZoneRegionPath: {
      type: 'string',
      title: 'Path that carries the time zone name',
      description: 'Used when following the ship\'s time. The standard Signal K path is filled in; change it only if another source publishes the zone elsewhere. The value is usually a zone name such as Europe/Athens; an offset such as 300 or +03:00 is read too.',
      default: DEFAULT_REGION_PATH
    },
    timeZoneOffsetPath: {
      type: 'string',
      title: 'Path that carries the UTC offset',
      description: 'Used when following the ship\'s time and no zone name is published. The value is usually a number in hours and minutes written together: 300 is three hours ahead of UTC, -930 is nine and a half hours behind. A zone name is read too.',
      default: DEFAULT_OFFSET_PATH
    },
    timeZone: {
      type: 'string',
      title: 'Time zone when none is published',
      description: 'The zone used when the ship\'s time is not followed, or is followed but nothing has been published yet. The server\'s own time zone is UTC on many boat computers. A named zone such as Europe/Athens changes with daylight saving by itself; a fixed offset such as UTC+03:00 does not.',
      default: SERVER_ZONE,
      enum: timeZones.values,
      enumNames: timeZones.labels
    },
    dayStart: {
      type: 'string',
      title: 'Day starts at',
      description: 'Time of day, as HH:MM in the time zone in use, at which a new day begins. Weeks, months and years begin at the same time of day.',
      default: '00:00'
    },
    weekStart: {
      type: 'string',
      title: 'Week starts on',
      default: 'monday',
      enum: ['monday', 'sunday', 'saturday'],
      enumNames: ['Monday', 'Sunday', 'Saturday']
    },
    repeatInterval: {
      type: 'number',
      title: 'Repeat unchanged values every (seconds)',
      description: 'A result is published when it changes, at most once a second. An unchanged result is sent again at this interval so that displays and other plugins do not treat it as lost. Set 0 to publish changes only.',
      default: DEFAULT_REPEAT_SECONDS,
      minimum: 0
    }
  }
}

// The three kinds of entry, as the lists of the settings form held them up
// to version 0.2.1. The editor uses the `items` of each.
const entryLists = {
  formulas: {
    type: 'array',
    title: 'Formulas',
    default: [],
    items: {
      type: 'object',
      title: 'Formula',
      required: ['output', 'expression'],
      properties: {
        enabled,
        name,
        inputs: {
          type: 'array',
          title: 'Inputs',
          default: [],
          items: {
            type: 'object',
            title: 'Input',
            required: ['name', 'path'],
            properties: {
              name: {
                type: 'string',
                title: 'Short name',
                description: 'The name used for this input in the expression, for example i or volts. Letters, digits and underscores, not starting with a digit, and not the name of a function or constant such as max, E or PI.'
              },
              path: {
                type: 'string',
                title: 'Path',
                description: 'A Signal K path, for example electrical.solar.hardtop.current, or the output path of another entry.'
              },
              whenStale: {
                type: 'number',
                title: 'Value when stale',
                description: 'Optional. The value the formula uses for this input while the input is stale (no new value for longer than the stale timeout), has had no value since the plugin started or the entry was last changed, or holds no number, in the unit Signal K publishes for the path. An input with such a value never makes the entry wait or go stale: a device that leaves the bus, such as a shore charger at anchor, can count as 0. Left empty, the input works as before: the entry waits for it and goes stale with it.'
              }
            }
          }
        },
        expression: {
          type: 'string',
          title: 'Expression',
          description: 'Written with the short names of the inputs, for example: i * v, or (a + b + c) / 3600, or rpm > 0 ? 1 : 0. Operators: + - * / % ^, comparisons, and, or, not, and condition ? a : b. Functions include min, max, abs, round, floor, ceil, sqrt, pow, roundTo and the trigonometric functions.'
        },
        output,
        unit,
        staleTimeout,
        onStale
      }
    }
  },
  counters: {
    type: 'array',
    title: 'Period counters',
    default: [],
    items: {
      type: 'object',
      title: 'Period counter',
      required: ['input', 'output'],
      properties: {
        enabled,
        name,
        input: {
          type: 'string',
          title: 'Input path',
          description: 'The path of the running total, or the output path of another entry.'
        },
        output,
        unit: { ...unit, description: 'Normally the same unit as the input. ' + unit.description },
        resets,
        resetPath,
        direction: {
          type: 'string',
          title: 'Count',
          description: 'Increases suits totals that only grow, such as energy yield. Decreases turns a falling level, such as a tank, into consumption. Net change reports the signed difference.',
          default: 'increase',
          enum: ['increase', 'decrease', 'net'],
          enumNames: ['Increases only', 'Decreases only', 'Net change']
        },
        reversal: {
          type: 'string',
          title: 'When the input moves the other way',
          description: 'Applies to the two one-way settings above. Carrying on suits a counter that restarts from zero and a tank that is refilled. Waiting ignores a brief dip or spike in a total that should never go back.',
          default: 'continue',
          enum: ['continue', 'wait'],
          enumNames: ['Carry on counting from the new value', 'Wait until the previous level is passed again']
        },
        minStep: {
          type: 'number',
          title: 'Smallest change to count',
          description: 'Changes smaller than this are ignored until they add up to at least this much. In the unit shown beside the title: °C for a temperature, % for a ratio, hPa for a pressure, otherwise the input\'s own unit. Use it to keep the ripple of a level sensor from being counted. 0 counts every change.',
          default: 0,
          minimum: 0
        },
        staleTimeout,
        onStale
      }
    }
  },
  integrations: {
    type: 'array',
    title: 'Integrations',
    default: [],
    items: {
      type: 'object',
      title: 'Integration',
      required: ['input', 'output'],
      properties: {
        enabled,
        name,
        input: {
          type: 'string',
          title: 'Input path',
          description: 'The path to add up, or the output path of another entry.'
        },
        mode: {
          type: 'string',
          title: 'Add up',
          description: 'Value multiplied by time gives the input\'s unit times seconds: W becomes J, m3/s becomes m3. Time above the threshold gives seconds. With a stale timeout of 0 the input is taken to hold its last value until the next one arrives, and the total grows every second in between.',
          default: 'rate',
          enum: ['rate', 'time'],
          enumNames: ['The value multiplied by time', 'The time the value is above the threshold']
        },
        threshold: {
          type: 'number',
          title: 'Threshold',
          description: 'Used only when adding up time. Time counts while the input is greater than this, in the unit shown beside the title: °C for a temperature, % for a ratio, hPa for a pressure, otherwise the input\'s own unit. Left empty, 0 in the unit Signal K publishes is used: any positive value counts, and a switch that is on counts as 1. For a temperature, published in kelvin, set a value.',
          default: 0
        },
        output,
        unit: { ...unit, description: 'J for power added up over time, m3 for a flow in m3/s, s for time. ' + unit.description },
        resets,
        resetPath,
        gap: {
          type: 'string',
          title: 'When values stop for longer than the stale timeout',
          description: 'Leaving the gap out undercounts but never invents data. Bridging assumes the input stayed at its last value for the whole gap.',
          default: 'skip',
          enum: ['skip', 'bridge'],
          enumNames: ['Leave the gap out of the total', 'Bridge the gap with the last value']
        },
        staleTimeout,
        onStale
      }
    }
  }
}

/**
 * The fields of each entry type, for the editor on the plugin's page. The
 * group and the id of an entry are handled by the editor itself.
 */
const entryFields = {
  formula: entryLists.formulas.items,
  counter: entryLists.counters.items,
  integration: entryLists.integrations.items
}
entryFields.counter.properties.resets.description = resetsWording
entryFields.integration.properties.resets.description = resetsWording

// The "Cycles" type. Its help texts are longer than the others, because
// its settings interact: how each input is read, how the inputs are
// combined, and which figure is published.
entryFields.cycles = {
  type: 'object',
  title: 'Cycles',
  required: ['inputs', 'output'],
  properties: {
    enabled,
    name,
    inputs: {
      type: 'array',
      title: 'Inputs',
      description: 'One or more paths that show when the device runs. Each is read as on/off or as a wave. With several inputs, "Combine inputs" below decides how they agree.',
      default: [],
      items: {
        type: 'object',
        title: 'Input',
        required: ['path'],
        properties: {
          path: {
            type: 'string',
            title: 'Path',
            description: 'A Signal K path, or the output path of another entry.'
          },
          kind: {
            type: 'string',
            title: 'Read as',
            description: 'On/off: the input is ON while its value is above the threshold. A switch sends true or false, which count as 1 and 0, so a threshold of 0 reads it directly; a current or a power reads as ON above a level such as 1 A. Wave: the input rises and falls with the device without saying which state it is in, such as the humidity or the temperature in a fridge. Each stretch between two turning points is one ON or OFF stretch.',
            default: 'onoff',
            enum: ['onoff', 'wave'],
            enumNames: ['On/off, against a threshold', 'Wave: rising and falling stretches']
          },
          threshold: {
            type: 'number',
            title: 'ON above',
            description: 'On/off only. The input is ON while its value is greater than this, in the unit shown beside it: °C for a temperature, % for a ratio, hPa for a pressure, otherwise the input\'s own unit. Left empty, 0 in the unit Signal K publishes is used, which suits a switch; for a temperature, published in kelvin, set a value.',
            default: 0
          },
          direction: {
            type: 'string',
            title: 'ON while the value is',
            description: 'Wave only. In a fridge the temperature and the humidity both fall while the compressor runs. A heater warms while it runs.',
            default: 'falling',
            enum: ['falling', 'rising'],
            enumNames: ['Falling', 'Rising']
          },
          swing: {
            type: 'number',
            title: 'Swing',
            description: 'Wave only. How far the value must turn back before a turning point counts, in the unit shown beside it: % for humidity, °C for temperature, hPa for pressure, otherwise the input\'s own unit. Set it above the noise of the sensor and below the rise and fall of one cycle; a third of that rise and fall is a good start. Too small and noise cuts stretches apart; too large and cycles are missed.'
          }
        }
      }
    },
    combine: {
      type: 'string',
      title: 'Combine inputs',
      description: 'Used with more than one input, like the conditions of a rule, at each moment. "All" is ON only while every input says ON, so it rejects a cycle that only one input shows, such as a door left open. "Any" is ON while at least one input says ON. Inputs that respond with a delay change the stretch lengths: two signals that follow the same compressor two minutes apart overlap two minutes less, so "All" reads ON stretches two minutes shorter and "Any" two minutes longer than either input alone. The figures still show a trend, but alert limits must be set on the combined figure. An input with nothing to say (no value, a gap, or a wave that does not turn) is left out until it has.',
      default: 'all',
      enum: ['all', 'any'],
      enumNames: ['All inputs ON (and)', 'Any input ON (or)']
    },
    statistic: {
      type: 'string',
      title: 'Publish',
      description: 'The figure taken from the cycles in the window. The median ON time follows frost building up in a fridge or freezer: frost insulates the evaporator, so the compressor runs longer to cool the box, while a single long stretch after loading barely moves a median. Times are published in seconds, the duty cycle as a ratio from 0 to 1.',
      default: 'onMedian',
      enum: ['onMedian', 'offMedian', 'periodMedian', 'duty', 'lastOn', 'cycles'],
      enumNames: ['Median ON time', 'Median OFF time', 'Median cycle (ON plus OFF)', 'Duty cycle (share of time ON)', 'Last ON time', 'Number of cycles']
    },
    window: {
      type: 'number',
      title: 'Window (hours)',
      description: 'The figure is taken from the cycles that ended within this many hours. 24 hours evens out the day and the night and outlasts the longer cycles after loading provisions.',
      default: 24,
      exclusiveMinimum: 0
    },
    minCycles: {
      type: 'number',
      title: 'Cycles needed',
      description: 'Nothing is published until the window holds at least this many complete ON stretches. Not used for the number of cycles.',
      default: 3,
      minimum: 0
    },
    smoothing: {
      type: 'number',
      title: 'Smoothing (seconds)',
      description: 'Wave inputs only. Values are averaged into 30-second steps and then over this span before turning points are looked for. 150 seconds suits a sensor that reports every few seconds or every minute; 30 switches the second averaging off. At most 1800.',
      default: 150,
      minimum: 0
    },
    shortest: {
      type: 'number',
      title: 'Shortest stretch (seconds)',
      description: 'A change of state counts only once it has held this long. A shorter flicker, such as a current dipping for a moment, stays inside the stretch it interrupts.',
      default: 120,
      minimum: 0
    },
    longest: {
      type: 'number',
      title: 'Longest stretch (seconds)',
      description: 'Stretches longer than this are left out of the figures: a pull-down after loading, a door left open, a device switched off. A wave input that has not turned for this long is taken to show no cycles and is left out of the combination.',
      default: 7200,
      minimum: 0
    },
    output,
    unit: { ...unit, description: 'Published with the output path so displays can label it. Left empty, the unit of the figure is used: s for the times, ratio for the duty cycle, none for the number of cycles.' },
    staleTimeout: { ...staleTimeout, default: 180, description: 'An input with no new value for this long is treated as having a gap, and the stretch under way is not measured. Set it to two or three times the interval at which the slowest input reports. Set 0 for an input that is sent only when it changes, such as a switch state.' },
    onStale
  }
}

// Field order of the settings form, and of each entry in the editor.
// Listing "*" last keeps any field added in a later version visible without
// having to revisit these lists.
const uiSchema = {
  'ui:order': ['timeZoneSource', 'timeZoneRegionPath', 'timeZoneOffsetPath', 'timeZone', 'dayStart', 'weekStart', 'repeatInterval', '*']
}

const entryOrder = {
  formula: ['enabled', 'name', 'inputs', 'expression', 'output', 'unit', 'staleTimeout', 'onStale', '*'],
  counter: ['enabled', 'name', 'input', 'output', 'unit', 'resets', 'resetPath', 'direction', 'reversal', 'minStep', 'staleTimeout', 'onStale', '*'],
  integration: ['enabled', 'name', 'input', 'mode', 'threshold', 'output', 'unit', 'resets', 'resetPath', 'gap', 'staleTimeout', 'onStale', '*'],
  cycles: ['enabled', 'name', 'inputs', 'combine', 'statistic', 'window', 'minCycles', 'output', 'unit', 'smoothing', 'shortest', 'longest', 'staleTimeout', 'onStale', '*']
}

// The field definitions above are shared between the three entry types.
// A deep copy gives every use its own object: the server stores the schema
// as JSON, and tools that walk it treat one object reached by two routes as
// a circular reference.
const plainSchema = JSON.parse(JSON.stringify(schema))
const plainEntryFields = JSON.parse(JSON.stringify(entryFields))

/**
 * Returns the form schema for a configuration whose saved time zone is
 * `savedTimeZone`.
 *
 * The form replaces a value that is not among a list's choices with the
 * list's default when it opens. A saved zone that the plugin accepts but
 * the list lacks (a name the runtime knows without listing it, an older
 * spelling, a name in lower case) would be swapped for "the server's own
 * time zone" and saved that way, with nothing said. Such a zone is added to
 * the list, exactly as it was saved, so that opening and saving the form
 * leaves it alone.
 */
function schemaFor (savedTimeZone) {
  const copy = JSON.parse(JSON.stringify(plainSchema))
  const saved = typeof savedTimeZone === 'string' ? savedTimeZone : ''
  const field = copy.properties.timeZone
  if (saved !== '' && !field.enum.includes(saved) && canonicalTimeZone(saved) !== null) {
    field.enum.push(saved)
    field.enumNames.push(`${saved} (as saved)`)
  }
  return copy
}

module.exports = { PART_HOUR_OFFSETS, RENAMED_ZONES, entryFields: plainEntryFields, entryOrder, schema: plainSchema, schemaFor, uiSchema }
