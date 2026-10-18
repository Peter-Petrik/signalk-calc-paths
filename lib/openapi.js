'use strict'

/*
 * OpenAPI description of the plugin's small HTTP interface. The server shows
 * it in the OpenAPI browser of the admin UI. It is a JavaScript
 * module rather than a JSON file so that it travels with the code that
 * implements it.
 */

const group = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' }
  }
}

// An entry as the entries file and the editor hold it. The fields beyond
// these are those of its type; GET /api/config returns their definitions.
const storedEntry = {
  type: 'object',
  required: ['id', 'type'],
  properties: {
    id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,40}$' },
    group: { type: 'string', nullable: true },
    type: { type: 'string', enum: ['formula', 'counter', 'integration', 'cycles'] }
  },
  additionalProperties: true
}

const substituted = {
  type: 'array',
  description: 'Formulas only. The inputs counted as their value when stale at the latest working-out; empty when none is.',
  items: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      path: { type: 'string' },
      value: { type: 'number', description: 'The value when stale used.' },
      reason: { type: 'string', enum: ['stale', 'none', 'invalid'], description: 'stale: no new value for longer than the stale timeout. none: no value since the plugin started or the entry was last changed. invalid: the value is null or not a number, also when it is the output of an entry that is not publishing or has no result.' }
    }
  }
}

const entry = {
  type: 'object',
  properties: {
    key: { type: 'string', description: 'The entry\'s id in the entries file; unique, also when two entries share an output path.' },
    id: { type: 'string', description: 'The output path, which names the entry in the reset route.' },
    group: { type: 'string', nullable: true, description: 'The id of the entry\'s group, or null when it is in none.' },
    name: { type: 'string' },
    type: { type: 'string', enum: ['formula', 'counter', 'integration', 'cycles'] },
    output: { type: 'string' },
    unit: { type: 'string' },
    inputs: { type: 'array', items: { type: 'string' } },
    value: { type: 'number', nullable: true, description: 'Current result, or null when there is none to show.' },
    state: { type: 'string', enum: ['ok', 'waiting', 'stale', 'error', 'disabled'] },
    message: { type: 'string' },
    updated: { type: 'string', format: 'date-time', nullable: true },
    canReset: { type: 'boolean' },
    expression: { type: 'string', description: 'Formulas only.' },
    substituted,
    staleTimeout: { type: 'number', description: 'Formulas only. The stale timeout in seconds.' },
    edited: { type: 'boolean', description: 'Formulas only. Whether the entry was changed since the plugin started, which is when "none" counts from.' },
    resets: { type: 'string', enum: ['day', 'week', 'month', 'year', 'path', 'manual'], description: 'Counters and integrations only.' },
    combine: { type: 'string', enum: ['all', 'any'], description: 'Cycles only. all: ON while every input with a state is ON. any: ON while at least one is.' },
    statistic: { type: 'string', enum: ['onMedian', 'offMedian', 'periodMedian', 'duty', 'lastOn', 'cycles'], description: 'Cycles only. The figure published on the output path.' },
    window: { type: 'number', description: 'Cycles only. The hours of finished stretches the figures are taken from.' },
    minCycles: { type: 'integer', description: 'Cycles only. The complete ON stretches the window must hold before a figure other than the count is published.' },
    cycleInputs: {
      type: 'array',
      description: 'Cycles only. How each input is read.',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          kind: { type: 'string', enum: ['onoff', 'wave'] },
          threshold: { type: 'number', description: 'On/off inputs: ON above this.' },
          direction: { type: 'string', enum: ['falling', 'rising'], description: 'Wave inputs: ON while the value moves this way.' },
          swing: { type: 'number', description: 'Wave inputs: how far the value must turn back before a turning point counts.' }
        }
      }
    },
    cycles: {
      type: 'object',
      description: 'Cycles only. Every figure over the finished stretches in the window, whichever one is published. Times are in seconds; each is null when there is no stretch to take it from.',
      properties: {
        count: { type: 'integer', description: 'Complete ON stretches in the window.' },
        onMedian: { type: 'number', nullable: true },
        offMedian: { type: 'number', nullable: true },
        periodMedian: { type: 'number', nullable: true, description: 'The median of an ON stretch and the OFF stretch after it, taken together.' },
        duty: { type: 'number', nullable: true, description: 'The share of time ON, from 0 to 1, over ON and OFF pairs that are both complete.' },
        lastOn: { type: 'number', nullable: true, description: 'The latest complete ON stretch no longer than the longest stretch.' },
        state: { type: 'string', enum: ['on', 'off'], nullable: true, description: 'The latest stretch found. A turning point of a wave is found a little after it happens, so this can trail the device. null when no stretch has been found since the plugin started.' },
        stateFor: { type: 'number', nullable: true, description: 'Seconds since the latest stretch began, or null when its start was not seen.' }
      }
    },
    resetPath: { type: 'string', nullable: true },
    since: { type: 'string', format: 'date-time', nullable: true, description: 'When the current total started counting.' },
    lastReset: {
      type: 'object',
      nullable: true,
      description: 'Counters, integrations and cycles. Why and when the total, or the cycles counted, were last cleared; null when they never were. Cycles are cleared only by request.',
      properties: {
        at: { type: 'string', format: 'date-time' },
        cause: { type: 'string', enum: ['period', 'zone', 'path', 'request'], description: 'period: a new day, week, month or year began. zone: a change of time zone jumped over a boundary. path: the followed path fell. request: the reset route was called.' },
        period: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: 'With cause period.' },
        zone: { type: 'string', description: 'With cause zone: the zone changed to.' },
        path: { type: 'string', description: 'With cause path: the followed path.' },
        from: { type: 'number', description: 'With cause path: the value before the fall.' },
        to: { type: 'number', description: 'With cause path: the value after the fall.' },
        source: { type: 'string', description: 'With cause path: the source of the lower value, when the server names it.' }
      }
    },
    sinceCorrected: {
      type: 'object',
      nullable: true,
      description: 'Counters and integrations only. Set when the start time was replaced without clearing the total, because it was unknown or lay in the future.',
      properties: {
        at: { type: 'string', format: 'date-time' },
        previous: { type: 'string', format: 'date-time', nullable: true, description: 'The start time that was replaced, or null when there was none.' }
      }
    }
  }
}

module.exports = function openApi (version) {
  return {
    openapi: '3.0.0',
    info: {
      title: 'Calculated Paths',
      version,
      description: 'Status of the calculated paths, a reset action for totals, and the routes of the entry editor.'
    },
    servers: [{ url: '/plugins/signalk-calc-paths' }],
    paths: {
      '/api/entries': {
        get: {
          summary: 'List every entry with its current value and status',
          description: 'Available to any logged-in user.',
          responses: {
            200: {
              description: 'The entries and the settings that decide period boundaries.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      version: { type: 'string' },
                      startedAt: { type: 'string', format: 'date-time', description: 'When the plugin last started.' },
                      timeZone: { type: 'string', description: 'The time zone in use for period boundaries: an IANA name, or a fixed offset such as +03:00.' },
                      timeZoneLabel: { type: 'string', description: 'The same zone written for display, a fixed offset as UTC+03:00.' },
                      timeZoneSource: {
                        type: 'object',
                        description: 'Where the zone in use comes from.',
                        properties: {
                          kind: { type: 'string', enum: ['path', 'remembered', 'setting', 'server'], description: 'path: read from a followed path since start. remembered: the last zone followed, not read again since start. setting: chosen in the settings. server: the server\'s own zone.' },
                          follow: { type: 'boolean', description: 'Whether the ship\'s time is followed.' },
                          paths: { type: 'array', items: { type: 'string' }, description: 'The paths read for the zone.' },
                          path: { type: 'string', nullable: true, description: 'The path the zone in use was read from.' },
                          since: { type: 'string', format: 'date-time', nullable: true, description: 'When the zone in use was taken up, or read again after a restart.' },
                          lastChange: {
                            type: 'object',
                            nullable: true,
                            description: 'The last change of the followed zone or of the path it is read from; null when there has been none.',
                            properties: {
                              at: { type: 'string', format: 'date-time' },
                              from: { type: 'string' },
                              to: { type: 'string' },
                              fromPath: { type: 'string', nullable: true },
                              toPath: { type: 'string', nullable: true }
                            }
                          },
                          fallback: { type: 'string', description: 'The zone used when nothing is published.' },
                          problem: { type: 'string', nullable: true, description: 'Set when a followed path holds a value that is neither a zone nor empty.' }
                        }
                      },
                      dayStart: { type: 'string' },
                      clockTrusted: { type: 'boolean', description: 'False while the system clock looks unset; period boundaries are paused until it is true.' },
                      outdatedValues: {
                        type: 'object',
                        description: 'Input values ignored since the plugin started as old values handed over again: an exact repeat of what their source sent before, or, from a source not seen before, older than the value last read, in both cases while another source is the one being read.',
                        properties: {
                          count: { type: 'integer' },
                          last: {
                            type: 'object',
                            nullable: true,
                            properties: {
                              path: { type: 'string' },
                              source: { type: 'string', nullable: true },
                              timestamp: { type: 'string', format: 'date-time', description: 'The time stamp the ignored value carried.' },
                              at: { type: 'string', format: 'date-time', description: 'When it was ignored.' }
                            }
                          }
                        }
                      },
                      problems: { type: 'array', items: { type: 'string' } },
                      notes: { type: 'array', items: { type: 'string' }, description: 'Things said once per start, such as entries having been moved out of the plugin settings.' },
                      groups: { type: 'array', items: group, description: 'The groups in the order they are shown.' },
                      entries: { type: 'array', items: entry, description: 'In the order the editor sets.' }
                    }
                  }
                }
              }
            }
          }
        }
      },
      '/api/entries/{id}/reset': {
        post: {
          summary: 'Reset the total of one counter or integration to zero, or make a cycles entry forget the cycles counted',
          description: 'Requires read/write or admin access. The id is the URL-encoded output path.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'The total was reset, or the cycles forgotten.' },
            404: { description: 'No running counter, integration or cycles entry has that output path.' }
          }
        }
      },
      '/api/config': {
        get: {
          summary: 'Read the groups and entries as saved',
          description: 'Requires read/write or admin access.',
          responses: {
            200: {
              description: 'The groups and entries, the revision to send back when saving, and the field definitions of each entry type.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      version: { type: 'integer' },
                      revision: { type: 'string', nullable: true },
                      blocked: { type: 'string', nullable: true, description: 'Why the entries file cannot be used, while that is so.' },
                      groups: { type: 'array', items: group },
                      entries: { type: 'array', items: storedEntry },
                      fields: { type: 'object', description: 'A JSON Schema object per entry type.' },
                      order: { type: 'object', description: 'The order of the fields per entry type.' }
                    }
                  }
                }
              }
            }
          }
        },
        put: {
          summary: 'Save the groups and entries',
          description: 'Requires read/write or admin access. Entries whose calculation is unchanged keep running; the others start, keeping their totals where they still measure the same thing.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['groups', 'entries'],
                  properties: {
                    revision: { type: 'string', description: 'The revision read. When given and no longer current, the save is refused.' },
                    groups: { type: 'array', items: group },
                    entries: { type: 'array', items: storedEntry }
                  }
                }
              }
            }
          },
          responses: {
            200: { description: 'Saved. The answer gives the new revision, how many entries kept running (kept) and how many started (started), and the faults of entries saved switched off: the first fault of each (entryErrors) and every fault with the field it lies in (entryFaults), both by entry id.' },
            400: { description: 'Nothing was saved: the structure is wrong (errors), or an entry that is switched on cannot run (entryErrors and entryFaults, by entry id). A fault\'s field is a setting name, inputs.<n>.<setting> for the nth input counted from 0, or null.' },
            409: { description: 'Nothing was saved: the entries were changed since the given revision.' }
          }
        }
      },
      '/api/paths': {
        get: {
          summary: 'List the vessel\'s paths with their current values and units',
          description: 'Requires read/write or admin access. A value that is not a number or true/false is named by kind only.',
          responses: {
            200: {
              description: 'One item per path.',
              content: {
                'application/json': {
                  schema: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        path: { type: 'string' },
                        value: { oneOf: [{ type: 'number' }, { type: 'boolean' }] },
                        kind: { type: 'string', enum: ['null', 'none', 'object', 'string'] },
                        units: { type: 'string' },
                        description: { type: 'string' },
                        entry: { type: 'string', description: 'The id of the entry that publishes the path.' }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      '/api/preview': {
        post: {
          summary: 'Work out a formula with the current values',
          description: 'Requires read/write or admin access. Nothing is saved.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    inputs: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          name: { type: 'string' },
                          path: { type: 'string' },
                          whenStale: { type: 'number', description: 'Optional. The value used while the input is stale or has no value.' }
                        }
                      }
                    },
                    expression: { type: 'string' },
                    staleTimeout: { type: 'number', description: 'Optional. The stale timeout in seconds, 60 when left out; 0 means an input never goes stale.' }
                  }
                }
              }
            }
          },
          responses: {
            200: { description: 'One of: value (with the values used), missing (the paths with no value now), or error (why there is no result). substituted lists the inputs counted as their value when stale, when there are any.' }
          }
        }
      }
    }
  }
}
