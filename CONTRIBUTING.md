# Contributing to signalk-calc-paths

Contributions are welcome. This document covers the basics for getting started.

## Reporting Bugs

Open an issue at [GitHub Issues](https://github.com/Peter-Petrik/signalk-calc-paths/issues) with:

- Signal K server version and Node.js version
- Plugin version
- The configuration of the entry concerned (its type, paths and settings)
- What was expected and what was published instead
- Relevant log output

To capture plugin logs:

```bash
journalctl -u signalk -n 200 --no-pager | grep "signalk-calc-paths"
```

## Development Setup

The plugin is plain JavaScript with no build step and one runtime dependency, `expr-eval-fork`.

| Path | Contents |
| :--- | :--- |
| `index.js` | The adapter between the Signal K server and the engine: subscriptions, publishing, state saving, HTTP routes. |
| `lib/engine.js` | The calculations. It has no knowledge of Signal K and is driven by input values and two clock readings. |
| `lib/periods.js` | Period boundaries in a time zone, including fixed offsets. |
| `lib/timezone.js` | Which time zone is in use: the ship's time followed from Signal K paths, or the setting. |
| `lib/formula.js` | Expression parsing and its restrictions. |
| `lib/config.js` | Checking of the saved configuration. |
| `lib/schema.js` | The configuration form. |
| `lib/state.js` | Reading and writing the state file. |
| `public/` | The status page shown under Webapps. |
| `test/` | Automated tests. |

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

4. Restart the Signal K server. The plugin appears under **Apps & Plugins > Configuration**.
5. Switch on **Enable debug log** on the plugin's configuration page to see detailed output.

### Tests

```bash
npm test
```

This checks the syntax of `index.js` and runs the test suite with the Node.js test runner. No test framework is installed. Node.js 22 or later is required.

The engine takes its time from the caller, so a test can replay hours or days of input in milliseconds. New behaviour in `lib/engine.js` is expected to come with a test in `test/engine.test.js`.

## Pull Requests

- One logical change per PR.
- Include a clear description of what the change does and why.
- Update `CHANGELOG.md` under an `[Unreleased]` section with a summary of the change.
- Run `npm test` before submitting. For a change to `index.js` or `public/`, also try it against a running Signal K server and say so in the PR description.
- A change to how a total is calculated, reset or restored must be reflected in the "How the Calculations Behave" and "Limitations and Assumptions" sections of the README.

## Code Style

- Comments explain what the code does and why, not just what. Assume the reader is not familiar with the codebase.
- Use the Signal K plugin API for logging: `app.debug()` for diagnostic information, `app.error()` for error conditions, `app.setPluginStatus()` for the status line and `app.setPluginError()` for errors shown in the admin UI.
- Text shown to the user (form labels, status messages, the status page) is written in plain language and names the thing the user configured, not the internal mechanism.
- Follow [Keep a Changelog](https://keepachangelog.com/) format for changelog entries.
- Versioning follows [SemVer](https://semver.org/): major for breaking changes, minor for features, patch for fixes.

## License

By contributing, contributions are licensed under the [GNU General Public License v3.0 or later](LICENSE).
