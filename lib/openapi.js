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
    since: { type: 'string', format: 'date-time', nullable: true, description: 'When the current total started counting.' }
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
                          fallback: { type: 'string', description: 'The zone used when nothing is published.' },
                          problem: { type: 'string', nullable: true, description: 'Set when a followed path holds a value that is neither a zone nor empty.' }
                        }
                      },
                      dayStart: { type: 'string' },
                      clockTrusted: { type: 'boolean', description: 'False while the system clock looks unset; period boundaries are paused until it is true.' },
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
