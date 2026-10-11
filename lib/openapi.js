'use strict'

/*
 * OpenAPI description of the plugin's small HTTP interface. The server shows
 * it in the OpenAPI browser of the admin UI. It is a JavaScript
 * module rather than a JSON file so that it travels with the code that
 * implements it.
 */

const entry = {
  type: 'object',
  properties: {
    key: { type: 'string', description: 'Unique within the list, also when two entries share an output path.' },
    id: { type: 'string', description: 'The output path, which names the entry in the reset route.' },
    name: { type: 'string' },
    type: { type: 'string', enum: ['formula', 'counter', 'integration'] },
    output: { type: 'string' },
    unit: { type: 'string' },
    inputs: { type: 'array', items: { type: 'string' } },
    value: { type: 'number', nullable: true, description: 'Current result, or null when there is none to show.' },
    state: { type: 'string', enum: ['ok', 'waiting', 'stale', 'error', 'disabled'] },
    message: { type: 'string' },
    updated: { type: 'string', format: 'date-time', nullable: true },
    canReset: { type: 'boolean' },
    expression: { type: 'string', description: 'Formulas only.' },
    resets: { type: 'string', enum: ['day', 'week', 'month', 'year', 'path', 'manual'], description: 'Counters and integrations only.' },
    resetPath: { type: 'string', nullable: true },
    since: { type: 'string', format: 'date-time', nullable: true, description: 'When the current total started counting.' },
    lastReset: {
      type: 'object',
      nullable: true,
      description: 'Counters and integrations only. Why and when the total was last cleared; null when it never was.',
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
      description: 'Status of the calculated paths and a reset action for totals.'
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
                      entries: { type: 'array', items: entry }
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
          summary: 'Reset the total of one counter or integration to zero',
          description: 'Requires read/write or admin access. The id is the URL-encoded output path.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'The total was reset.' },
            404: { description: 'No counter or integration has that output path.' }
          }
        }
      }
    }
  }
}
