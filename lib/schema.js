'use strict'

/*
 * The configuration form.
 *
 * The Signal K admin UI draws this JSON Schema as the plugin's settings
 * page. Entries are kept in three lists, one per calculation type, so that
 * each list shows only the fields its type uses and no field depends on the
 * value of another.
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
  title: 'Enabled',
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
  description: 'Stop publishing until the input returns, or keep publishing the last result. Either way nothing is recalculated from a stale input.',
  default: 'stop',
  enum: ['stop', 'hold'],
  enumNames: ['Stop publishing', 'Keep publishing the last result']
}

const resets = {
  type: 'string',
  title: 'Resets',
  description: 'When the total goes back to zero. Day, week, month and year begin at the day start set above, in the ship\'s time zone when one is followed and otherwise in the time zone chosen above. Any total can also be reset by hand on the Calculated Paths page. Changing this setting clears the total.',
  default: 'day',
  enum: ['day', 'week', 'month', 'year', 'path', 'manual'],
  enumNames: ['Every day', 'Every week', 'Every month', 'Every year', 'When another path resets', 'Only by hand']
}

const resetPath = {
  type: 'string',
  title: 'Path to follow for resets',
  description: 'Used only with "When another path resets". The total is cleared whenever the value on this path falls, for example a daily yield that another device sets back to zero.'
}

// The admin form prints the description of a list both above and below its
// heading, so list descriptions are kept to a single short sentence.
const schema = {
  type: 'object',
  title: 'Calculated Paths',
  description: 'Calculates new Signal K paths from existing ones. Formulas combine live values, period counters report how much a running total has changed since the start of a day, week, month or year, and integrations add up a rate over time. Live values, status and reset buttons are on the Calculated Paths page under Webapps.',
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
      description: 'Used when following the ship\'s time. The standard Signal K path is filled in; change it only if another source publishes the zone elsewhere. The value must be a zone name such as Europe/Athens.',
      default: DEFAULT_REGION_PATH
    },
    timeZoneOffsetPath: {
      type: 'string',
      title: 'Path that carries the UTC offset',
      description: 'Used when following the ship\'s time and no zone name is published. The value must be a number in hours and minutes written together: 300 is three hours ahead of UTC, -930 is nine and a half hours behind.',
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
    },
    formulas: {
      type: 'array',
      title: 'Formulas',
      description: 'One value calculated from live paths and constants.',
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
                  description: 'The name used for this input in the expression, for example i or volts. Letters, digits and underscores, starting with a letter.'
                },
                path: {
                  type: 'string',
                  title: 'Path',
                  description: 'A Signal K path, for example electrical.solar.hardtop.current, or the output path of another entry.'
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
      description: 'How much a running total, such as lifetime energy or engine run time, has changed since the period began.',
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
            description: 'Changes smaller than this, in the input\'s unit, are ignored until they add up to at least this much. Use it to keep the ripple of a level sensor from being counted. 0 counts every change.',
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
      description: 'An input added up over time: power becomes energy, a flow rate becomes a volume, a running signal becomes running time.',
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
            description: 'Used only when adding up time. Time counts while the input is greater than this. With 0, any positive value counts; a switch that is on counts as 1.',
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
}

// Field order within each entry. Listing "*" last keeps any field added in
// a later version visible without having to revisit this list.
const uiSchema = {
  'ui:order': ['timeZoneSource', 'timeZoneRegionPath', 'timeZoneOffsetPath', 'timeZone', 'dayStart', 'weekStart', 'repeatInterval', 'formulas', 'counters', 'integrations', '*'],
  formulas: {
    items: {
      'ui:order': ['enabled', 'name', 'inputs', 'expression', 'output', 'unit', 'staleTimeout', 'onStale', '*']
    }
  },
  counters: {
    items: {
      'ui:order': ['enabled', 'name', 'input', 'output', 'unit', 'resets', 'resetPath', 'direction', 'reversal', 'minStep', 'staleTimeout', 'onStale', '*']
    }
  },
  integrations: {
    items: {
      'ui:order': ['enabled', 'name', 'input', 'mode', 'threshold', 'output', 'unit', 'resets', 'resetPath', 'gap', 'staleTimeout', 'onStale', '*']
    }
  }
}

// The field definitions above are shared between the three entry types.
// A deep copy gives every use its own object: the server stores the schema
// as JSON, and tools that walk it treat one object reached by two routes as
// a circular reference.
const plainSchema = JSON.parse(JSON.stringify(schema))

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

module.exports = { PART_HOUR_OFFSETS, RENAMED_ZONES, schema: plainSchema, schemaFor, uiSchema }
