# Contributing to signalk-calc-paths

Contributions are welcome. This document covers the basics for getting started.

## Reporting Bugs

Open an issue at [GitHub Issues](https://github.com/Peter-Petrik/signalk-calc-paths/issues) with:

1. Signal K server version and Node.js version
2. Plugin version
3. The configuration of the entry concerned (its type, paths and settings); **Export** in the editor writes the whole set to a file
4. What was expected and what was published instead
5. Relevant log output

To capture plugin logs:

```bash
journalctl -u signalk -n 200 --no-pager | grep "signalk-calc-paths"
```

## Development Setup

The plugin is plain JavaScript with no build step and one runtime dependency, `expr-eval-fork`.

| Path | Contents |
| :--- | :--- |
| `index.js` | The adapter between the Signal K server and the engine: subscriptions, publishing, state saving, the HTTP routes the status page and the editor use. |
| `lib/engine.js` | The calculations. It has no knowledge of Signal K and is driven by input values and two clock readings. |
| `lib/cycles.js` | Finding the ON and OFF stretches of a cycles entry. |
| `lib/history.js` | Reading the server's history through the History API for an entry that starts with nothing saved. |
| `lib/periods.js` | Period boundaries in a time zone, including fixed offsets. |
| `lib/timezone.js` | Which time zone is in use: the ship's time followed from Signal K paths, or the setting. |
| `lib/formula.js` | Expression parsing and its restrictions. |
| `lib/config.js` | Checking of the entries and settings before they run. |
| `lib/store.js` | Reading, checking and writing `entries.json`, and taking over the lists kept in the plugin settings before 0.3.0. |
| `lib/state.js` | Reading and writing the state file. |
| `lib/schema.js` | The plugin settings form and the field definitions the editor builds its forms from: titles, full help, the one-line summaries, the order of the fields and those folded under Advanced settings. |
| `lib/openapi.js` | The description of the HTTP routes shown in the server's OpenAPI browser. |
| `public/` | The page under Webapps: the status page and the entry editor. |
| `docs/` | Pages the README links to: upgrading from earlier versions, and time zone changes worked through. |
| `test/` | Automated tests. |
| `integration/` | An end-to-end check against a running Signal K server. |

### Local Testing

1. Clone the repository.
2. Run `npm install` to install dependencies.
3. Link the plugin to a local Signal K server:

```bash
cd signalk-calc-paths
npm link
cd ~/.signalk
npm link signalk-calc-paths
```

4. Restart the Signal K server. The plugin appears under **Apps & Plugins > Configuration**, and its page under **Webapps**.
5. Switch on **Enable debug log** on the plugin's configuration page to see detailed output.

### Tests

```bash
npm test
```

This checks the syntax of `index.js` and runs the test suite with the Node.js test runner. No test framework is installed. Node.js 22 or later is required.

The engine takes its time from the caller, so a test can replay hours or days of input in milliseconds. New behaviour in `lib/engine.js` or `lib/cycles.js` is expected to come with a test under `test/` that fails without the change.

The end-to-end check runs against a Signal K server with this plugin installed, security switched off and sample data playing:

```bash
SIGNALK_URL=http://localhost:3000 npm run test:integration
```

Every push runs Signal K's plugin CI workflow, which installs the plugin into a server and runs the tests on Linux (x64 and arm64), macOS and Windows under Node.js 22 and 24. Its server is started with `--override-timestamps`, which stamps every value with the time it arrives, so the time stamp of a period's closing total can only be checked against a server started without it.

## Pull Requests

1. One logical change per pull request.
2. Include a clear description of what the change does and why. The maintainer writes the `CHANGELOG.md` entry when the change is released.
3. Run `npm test` before submitting. For a change to `index.js` or `public/`, also try it against a running Signal K server and say so in the description.
4. A change to how a total is calculated, reset or restored must be reflected in the "How the Calculations Behave" and "Limitations and Assumptions" sections of the README. A new or moved field of an entry is listed in the README's table for its type, in the order the editor shows it (`entryOrder` in `lib/schema.js`). A new field also needs a one-line summary (`SUMMARIES`), and a field most entries leave at its default goes under Advanced settings (`entryAdvanced`), where the README's table marks it as advanced.

## Code Style

1. The code follows [JavaScript Standard Style](https://standardjs.com/), checked with `npx standard`.
2. Comments explain what the code does and why, not just what. Assume the reader is not familiar with the codebase.
3. Use the Signal K plugin API for logging: `app.debug()` for diagnostic information, `app.error()` for error conditions, `app.setPluginStatus()` for the status line and `app.setPluginError()` for errors shown in the admin UI.
4. Text shown to the user (form labels, status messages, the status page) is written in plain language and names the thing the user configured, not the internal mechanism.
5. Changelog entries follow [Keep a Changelog](https://keepachangelog.com/).
6. Versioning follows [SemVer](https://semver.org/): major for breaking changes, minor for features, patch for fixes.

## License

Contributions are licensed under the [GNU General Public License v3.0 or later](LICENSE).
