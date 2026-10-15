# Signal K Calculated Paths
![Calculated Paths icon](icon.svg)

This plugin calculates new Signal K paths from existing ones and publishes them like any other data. It offers four kinds of calculation: a formula over live values, a counter that reports how much a running total has changed since the start of a day, week, month or year, an integration that adds up a rate over time, and a cycle finder that reports how long a cycling device such as a fridge compressor runs and rests. It targets the Signal K Node server and is meant for boats whose instruments report a raw figure (a current and a voltage, a lifetime energy total, an engine speed) where a derived figure is wanted (power, energy today, engine hours today).

## Project Status

New and actively maintained. The first public release was 0.1.0, in October 2026. The calculations are covered by automated tests and were checked against recorded data from a boat, and the plugin has run inside Signal K server 2.33.0. Wider field use is still to come. See [CHANGELOG.md](CHANGELOG.md) for release history and [Issues](https://github.com/Peter-Petrik/signalk-calc-paths/issues) for planned work.

The plugin publishes calculated values into Signal K paths. It is not an automation tool and does not replace Node-RED: it switches nothing and raises no notifications. A rules or automation plugin can act on the values it publishes, for example to warn when a freezer's compressor cycles have grown long enough to call for a defrost.

## Features

- **Formulas**: An expression over any number of live paths and constants, for example `i * v` or `(a + b + c) / 3600`. Arithmetic, comparisons, conditions and common mathematical functions are available. Expressions are parsed by a library and never passed to JavaScript's `eval`.
- **Period Counters**: The change in a running total since the start of the day, week, month or year, or since a manual reset. Counting increases suits lifetime energy and engine run time; counting decreases turns a falling tank level into consumption.
- **Integrations**: A rate added up over time (power into energy, flow into volume), or the time an input spends above a threshold (engine running time, time a switch is on).
- **Cycles (v0.4.0+)**: The ON and OFF stretches of a device that cycles, found from a switch, from a value against a threshold, or from a value that rises and falls with the device, such as the temperature or humidity inside a fridge. Two or more inputs can be combined, ON while all of them are ON or while any of them is. The median ON time, median OFF time, median cycle, duty cycle, last ON time or number of cycles over a window such as 24 hours is published.
- **Selectable Resets**: Each total resets at the start of a day, week, month or year, with a configurable start of day, or in step with another path, so that a calculated daily total can follow a device that keeps its own day.
- **Ship's Time Zone (v0.2.0+)**: Days begin at local midnight in the time zone the vessel keeps. The zone is read from Signal K, where a plugin such as Ship's Time publishes it, and changes by itself when the boat changes time zone. A zone chosen in the settings is used when nothing is published.
- **Chaining**: An entry can read the output of another entry. A formula can feed an integration, and a counter can feed a formula. Entries are calculated in dependency order, each once per incoming update.
- **Stale Input Handling**: Each entry stops publishing, or keeps publishing its last result, when an input goes quiet for longer than its stale timeout. The choice is per entry.
- **State Persistence**: Totals survive server restarts. The state file is rewritten in place and holds no history.
- **Unit Metadata**: Each output announces its unit and name, so instrument displays can label it.
- **Entry Editor (v0.3.0+)**: Entries are created and changed on the plugin's page under **Webapps**, with suggestions from the server's live paths, the current value and unit of each path, a live preview of a formula's result, and a note of which entries read each other's results. Saving restarts only the entries that changed; the others keep counting without interruption.
- **Groups (v0.3.0+)**: Entries can be sorted into groups with names of the user's choosing, and ordered within them. The status page shows a heading per group, and each group can be folded away.
- **Status Page**: A page under **Webapps** lists every entry with its current value, its state and a reset button. Paths named in its sentences are set in a code font.
- **Reset Record (v0.2.1+)**: Each total records when and why it was last cleared: a new period, the followed path falling from one value to another, a request, or a change of time zone. The status page shows the record, together with the last change of the followed time zone and the time the plugin started.
- **Clock Safety**: Sums are measured on a monotonic clock, and period resets pause while the system clock is recognisably unset, so a computer that boots at 1970 does not reset its totals or count the correction as elapsed time.

## Configuration

Configuration has two parts:

1. **Settings** that apply to every entry (the time zone, the start of the day and week, the repeat interval) are entered under **Apps & Plugins > Configuration > Calculated Paths**. The **Edit plugin configuration** link at the top of the plugin's page opens them.
2. **Entries** are created and changed under **Webapps > Calculated Paths > Edit entries**. See [Editing Entries](#editing-entries). Up to version 0.2.1 entries were kept in three lists in the settings; see [Upgrading From 0.2.x](#upgrading-from-02x).

### General Settings

| Setting | Default | Meaning |
| :--- | :--- | :--- |
| Time zone for day boundaries | Follow the ship's time published in Signal K | Follow the ship's time, or always use the time zone chosen below. See [Time Zones and Day Boundaries](#time-zones-and-day-boundaries). |
| Path that carries the time zone name | `environment.time.timezoneRegion` | Read when following the ship's time. Expected to hold a zone name such as `Europe/Athens`. |
| Path that carries the UTC offset | `environment.time.timezoneOffset` | Read when following the ship's time and no zone name is published. Expected to hold a number such as `300`. |
| Time zone when none is published | The server's own time zone | A list with the server's zone, UTC, the fixed offsets from UTC-12:00 to UTC+14:00, and the named zones. Many boat computers run on UTC, in which case the server's zone is not local time. |
| Day starts at | `00:00` | Time of day, as `HH:MM` in the time zone in use, at which a new day begins. Weeks, months and years begin at the same time of day. |
| Week starts on | Monday | Monday, Sunday or Saturday. |
| Repeat unchanged values every | 10 s | A result is published when it changes, at most once a second. An unchanged result is sent again at this interval. `0` publishes changes only. |

### Fields Shared by All Entries

| Field | Default | Meaning |
| :--- | :--- | :--- |
| Switched on | on | An entry that is switched off publishes nothing and keeps its saved total. It may be saved unfinished. |
| Name | empty | Label shown on the status page and published as the output's description. |
| Output path | none | The Signal K path the result is published on. It needs at least two segments and must not be written by another source. |
| Unit | empty | Unit published with the output. Signal K uses SI units: `W`, `J`, `V`, `A`, `s`, `m3`, `K`, `Pa`, `ratio`. |
| Stale timeout | 60 s | An input with no new value for this long is stale. `0` means the input is sent only when it changes and never goes stale. |
| When an input is stale | Stop publishing | Stop publishing until the input returns, or keep publishing the last result. |

### Formulas

| Field | Meaning |
| :--- | :--- |
| Inputs | A list of short names, each mapped to a path. A short name is made of letters, digits and underscores and starts with a letter. Paths cannot be written directly in an expression because they contain dots and dashes. |
| Expression | The calculation, written with the short names. |

Operators: `+`, `-`, `*`, `/`, `%`, `^`, the comparisons `==`, `!=`, `<`, `<=`, `>`, `>=`, the logical `and`, `or`, `not`, and the condition `test ? a : b`. A comparison used as the whole expression publishes `1` or `0`. The constants `PI` and `E` are available.

Functions: `abs`, `acos`, `acosh`, `asin`, `asinh`, `atan`, `atan2`, `atanh`, `cbrt`, `ceil`, `cos`, `cosh`, `exp`, `expm1`, `floor`, `hypot`, `if`, `lg`, `ln`, `log`, `log10`, `log1p`, `log2`, `max`, `min`, `pow`, `pyt`, `round`, `roundTo`, `sign`, `sin`, `sinh`, `sqrt`, `tan`, `tanh`, `trunc`.

Assignment, function definitions, arrays, string concatenation and property access are switched off. A result that is not a finite number, such as a division by zero, is not published.

### Period Counters

| Field | Default | Meaning |
| :--- | :--- | :--- |
| Input path | none | The path of the running total. |
| Resets | Every day | Every day, week, month or year; when another path resets; or only by hand. |
| Path to follow for resets | empty | Used with "When another path resets". The total is cleared whenever the value on this path falls. |
| Count | Increases only | Increases only, decreases only, or net change (signed). |
| When the input moves the other way | Carry on | Carry on counting from the new value, or wait until the previous level is passed again. Applies to the two one-way settings. |
| Smallest change to count | 0 | Changes smaller than this, in the input's unit, are ignored until they add up to at least this much. |

### Integrations

| Field | Default | Meaning |
| :--- | :--- | :--- |
| Input path | none | The path to add up. |
| Add up | The value multiplied by time | Value multiplied by time gives the input's unit times seconds (`W` becomes `J`, `m3/s` becomes `m3`). The alternative adds up the time the value is above the threshold, in seconds. |
| Threshold | 0 | Used when adding up time. Time counts while the input is greater than this. |
| Resets, Path to follow for resets | Every day | As for period counters. |
| When values stop for longer than the stale timeout | Leave the gap out | Leave the gap out of the total, or bridge it with the last value. |

### Cycles

A Cycles entry finds the ON and OFF stretches of a device that cycles and publishes one figure about them. See [How Cycles Are Found](#how-cycles-are-found) for the details, and [Fridge and Freezer Compressors](#fridge-and-freezer-compressors) for a worked example.

| Field | Default | Meaning |
| :--- | :--- | :--- |
| Inputs | none | One or more paths that show when the device runs. Each is read as on/off or as a wave, as set below. |
| Read as | On/off | **On/off, against a threshold**: the input is ON while its value is greater than **ON above**. A switch sends true or false, which count as 1 and 0. **Wave**: the input rises and falls with the device without saying which state it is in; every stretch between two turning points is one ON or one OFF stretch. |
| ON above | 0 | On/off inputs. In the input's own unit, for example `1` for a current in amperes. |
| ON while the value is | Falling | Wave inputs. Falling for the temperature or humidity in a fridge or freezer, which drop while the compressor runs; rising for something a heater warms. |
| Swing | none, required | Wave inputs. How far the value must turn back before a turning point counts, in the input's own unit as Signal K publishes it. See [Choosing the Swing](#choosing-the-swing). |
| Combine inputs | All inputs ON (and) | With more than one input: ON while every input is ON, or while at least one is. See [Combining Inputs](#combining-inputs). |
| Publish | Median ON time | Median ON time, median OFF time, median cycle (an ON stretch plus the OFF stretch after it), duty cycle (the share of time ON), last ON time, or number of cycles. Times are published in seconds, the duty cycle as a ratio from 0 to 1, the number of cycles as a plain number. |
| Window | 24 hours | The figure is taken from the stretches that ended within this many hours. |
| Cycles needed | 3 | Nothing is published until the window holds this many complete ON stretches. Not used for the number of cycles, which is always published. |
| Smoothing | 150 s | Wave inputs. The span the 30-second step means are averaged over before turning points are looked for. `30` switches this second averaging off. |
| Shortest stretch | 120 s | A change of the combined state counts only once it has held this long. |
| Longest stretch | 7200 s | Stretches longer than this are left out of the figures. A wave that has not turned for this long is left out of the combination. |
| Unit | empty | Left empty, the unit of the figure is published: `s` for times, `ratio` for the duty cycle. |
| Stale timeout | 180 s | An input with no new value for this long has a gap, and the stretch under way is not measured. Two or three times the interval at which the slowest input reports; `0` for an input sent only when it changes, such as a switch state. Cycles entries default to 180 s rather than 60 s, so that a sensor reporting about once a minute is not cut by one late report. |

#### Combining Inputs

The inputs are combined at each moment, as the conditions of a rule are. "All" is ON only while every input says ON, so a cycle that only one input shows, such as a fridge door left open, is not counted. "Any" is ON while at least one input says ON.

Inputs that respond with a delay change the lengths read. In a fridge the humidity follows the compressor a little later than the temperature does. Take a compressor that runs from 10:00 to 10:10:

| Input | ON while falling |
| :--- | :--- |
| Temperature | 10:00 to 10:10 |
| Humidity | 10:02 to 10:12 |
| **All inputs ON (and)** | 10:02 to 10:10, read as **8 minutes** |
| **Any input ON (or)** | 10:00 to 10:12, read as **12 minutes** |

Neither is the compressor's own 10 minutes, and the difference is the same from one cycle to the next. A combined figure therefore shows a trend as well as a single input does, but an alert limit must be chosen on the combined figure, not taken from a measurement of one input or of the compressor itself.

An input with nothing to say is left out, and the others decide alone: an input with no value yet or with a gap in its data, and a wave that has not turned for longer than the longest stretch. The last covers a sensor too slow or too well insulated to show the cycles at all. A stretch during which an input drops out or comes back is not measured, because part of it was timed by different inputs.

#### Choosing the Swing

The swing is in the unit Signal K publishes, which is not always the unit a display shows:

| Input | Unit in Signal K | A swing of |
| :--- | :--- | :--- |
| Temperature | kelvin (`K`) | `0.05` is 0.05 °C |
| Relative humidity | ratio from 0 to 1 | `0.01` is one percentage point |
| Current | amperes (`A`) | `0.5` is half an ampere |

Set it above the noise of the sensor and below the rise and fall of one cycle. Too small, and noise cuts stretches into pieces; too large, and cycles are missed. A third of the typical rise and fall of one cycle is a reasonable start. A history of the input in a database such as InfluxDB, viewed over an hour, shows both. Then compare the number of cycles on the status page with the graph.

## Time Zones and Day Boundaries

A total that resets "every day" resets at midnight, and midnight depends on the time zone. The same holds for weeks, months and years, which begin at the same time of day. This section explains which time zone the plugin uses and what happens when it changes. Entries that reset when another path resets, or only by hand, are not affected by any of it.

### Which Time Zone Is Used

With **Time zone for day boundaries** set to follow the ship's time, the plugin takes the first of these that is available:

1. **The zone name published in Signal K.** The path `environment.time.timezoneRegion` holds a name such as `Europe/Athens`. A name is preferred because it carries the zone's daylight saving rules.
2. **The UTC offset published in Signal K.** The path `environment.time.timezoneOffset` holds a number such as `300`. Both paths are defined by the Signal K specification as the time zone the vessel keeps. It is used when no name is published. It is also used when it was published after the name and disagrees with it, which happens when a source stops publishing a name and the old one is still held by the server. Which of the two is newer is read from their time stamps. A name and an offset published together are taken as belonging together, and the name is used.
3. **The last zone followed.** It is remembered across restarts, so that a restart does not fall back to the setting while the source has not spoken yet.
4. **The zone chosen under "Time zone when none is published".** The default choice is the server's own time zone.
5. **UTC**, if the server's time zone cannot be read.

With the setting on "Always use the time zone chosen below", only steps 4 and 5 apply and nothing is read from Signal K.

The status page states the zone in use and where it comes from, for example "Days begin at 00:00, Europe/Athens time, the ship's time read from environment.time.timezoneRegion." The plugin's status line in the admin UI includes "Time zone Europe/Athens" while a zone is being followed.

### Setting It Up

**A ship's time plugin is installed.** Nothing needs to be set in this plugin. The [Ship's Time](https://www.npmjs.com/package/@meri-imperiumi/signalk-ships-time) plugin, in its automatic mode, works out the zone from the vessel's position and publishes both standard paths, and they are followed as installed.

Ship's Time itself needs one look. Version 0.1.0 of it is enabled as soon as it is installed and starts in manual mode with an offset of zero, which is UTC. Until it is switched to automatic, or given the right offset, it publishes UTC and this plugin follows that, whatever zone is chosen in the settings here. The status page shows the zone in use, which makes this easy to spot.

**Another source publishes the zone.** Custom code, Node-RED or another plugin can publish the zone on any path. That path is entered under **Path that carries the time zone name** or **Path that carries the UTC offset**, depending on what it holds. Either field accepts either form, and the same path may be entered in both.

**Nothing publishes the zone.** A zone is picked under **Time zone when none is published**. A named zone such as `Europe/Athens` is the better choice where one fits, because it changes with daylight saving by itself. A fixed offset such as "UTC+03:00" never changes: it has to be changed by hand when the clocks change and when the boat moves to another zone.

**Nothing is set at all.** The server's own time zone is used. On a boat computer set to UTC, a day then runs from midnight UTC, which is 02:00 or 03:00 by the clock in the eastern Mediterranean.

### What a Followed Path May Hold

| Value on the path | Read as |
| :--- | :--- |
| `"Europe/Athens"` | The named zone, with its daylight saving rules. |
| `"Pacific/Marquesas"` | The named zone, 9 hours 30 minutes behind UTC. |
| `300` | 3 hours ahead of UTC. The number is hours and minutes written together, as the Signal K specification defines the offset path. |
| `-930` | 9 hours 30 minutes behind UTC. |
| `545` | 5 hours 45 minutes ahead of UTC. |
| `0` | UTC. |
| `"+03:00"`, `"UTC+3"` | 3 hours ahead of UTC, written as text. |
| `180`, `10800` | Refused. `180` would be 1 hour 80 minutes, and `10800` is further from UTC than any clock. An offset given in minutes or seconds is not understood. |
| `3` | 3 minutes ahead of UTC, not 3 hours. An offset given in whole hours is misread; `300` is the form for 3 hours. |
| `null` | No value. On the name path the offset is then used, if one is published; otherwise the last zone followed stays in use. |
| An object, other text | Not used, and reported on the status page. |

A value that cannot be read is never used. It is reported on the status page for as long as the path holds it, also when the other path is fine: an unreadable name means the zone's daylight saving rules are not being followed.

### When the Boat Changes Time Zone

A total belongs to a calendar date. When the time zone changes, the plugin asks one question: has a later date begun? If so, the total is cleared. If not, it carries on. A total is never cleared twice for the same date.

This is the same thing that happens to every clock twice a year at a daylight saving change: one day is an hour short and another an hour long.

**Example 1: sailing east, away from midnight.** The boat goes from Italian time to Greek time at 14:00 on 10 October. The clock becomes 15:00, still 10 October. Nothing is cleared. The day's total carries on and resets at Greek midnight, so that day was 23 hours long.

**Example 2: sailing east, across midnight.** The change comes at 23:30 Italian time on 10 October. The clock becomes 00:30 on 11 October: a new date has begun.

| Time | Clock | What happens |
| :--- | :--- | :--- |
| Before the change | 23:30, 10 October, Italian time | The total for 10 October stands at 5.2 kWh. |
| The change | 00:30, 11 October, Greek time | The total is cleared. Counting for 11 October starts here. |
| An hour later | 01:30, 11 October | The total holds what was produced since the change. |
| Next midnight | 00:00, 12 October | The total is cleared as on any other day. |

The half hour between Greek midnight and the change was counted in the total for 10 October, which is gone. The total for 11 October therefore starts at the moment of the change, and the status page says so: "The time zone changed and a new period had already begun in the new zone. This period is counted from the moment of the change."

**Example 3: sailing west, back across midnight.** The change comes at 00:30 Greek time on 11 October, half an hour after the day's total was cleared. The clock becomes 23:30 on 10 October: the date has stepped back.

| Time | Clock | What happens |
| :--- | :--- | :--- |
| Greek midnight | 00:00, 11 October, Greek time | The total is cleared. Counting for 11 October starts. |
| The change | 23:30, 10 October, Italian time | Nothing is cleared. The total for 11 October carries on. |
| Half an hour later | 00:00, 11 October, Italian time | The 11th begins a second time. Nothing is cleared. |
| Next midnight | 00:00, 12 October | The total is cleared. The total for 11 October covered 25 hours. |

While the date is behind the total, the status page says: "The date has stepped back since this period began, as it does when the time zone changes going west. This period carries on until the next one begins."

**Weeks, months and years** follow the same rule. A change of zone at 23:30 on 31 October that makes it 00:30 on 1 November starts the new month at once.

### Restarts

The last zone followed is saved with the totals. After a restart the plugin starts in that zone and the status page says the zone was "last read" from its path until the source publishes it again. If the source publishes a different zone, for instance because the boat moved while the server was off, the change is handled as described above.

Switching **Time zone for day boundaries** to the fixed setting, or changing either path, discards the remembered zone.

### Seeing When the Zone Changed

From version 0.2.1 the status page states the last change of the followed zone: when it happened, and from which zone to which. A change of the path the zone is read from, with the clock time unchanged, is stated as well, because a name carries daylight saving rules and a bare offset does not. The record is saved with the totals. A zone that changes although the vessel has not moved points at the plugin that publishes it; see item 5 under [Limitations and Assumptions](#limitations-and-assumptions).

## Editing Entries

From version 0.3.0 entries are edited on the plugin's page: **Webapps > Calculated Paths**, tab **Edit entries**. The tab appears for users who may change data (read/write or admin access); a read-only login sees the status only.

### Building an Entry

1. **Add entry**, at the foot of a group or of the entries outside any group, offers the three kinds, each explained in one line.
2. Path fields suggest the paths the server knows on the vessel, including the outputs of other entries. Under each path field the current value and unit are shown, or a note that the path holds nothing, or holds something that cannot be calculated with, such as a position.
3. A formula shows its result with the current values a moment after typing stops, or says why there is none yet.
4. An entry that reads another entry's result, or whose result another entry reads, says so, so a chain of entries can be followed.
5. Fields that apply only to some settings, such as the threshold of an integration that adds up time, appear only when they apply.

### Groups and Order

1. **Add group** creates a group. Its name is edited in place, and the arrow buttons beside it move it up or down.
2. An entry is moved into a group with its **Group** selector, or by dragging it by its handle onto another entry or onto a group's list. Dragging needs a mouse; on a touch screen the arrow buttons move an entry within its group.
3. **Delete group** keeps the group's entries: they join the entries outside any group.
4. On the status page the entries outside any group come first, without a heading, followed by the groups in their order. A set with no groups reads as one plain list. A group's heading folds it away; each browser remembers which groups are folded.
5. Groups and order change only what is shown. They change no calculation, path or total.

### Saving

1. Nothing reaches the server until **Save**. The page warns before it is left with unsaved changes, and **Discard changes** returns to the set last saved.
2. The set is checked on the server before anything is saved. An entry that is switched on and cannot run (a missing path, an expression that does not parse, two entries writing one path, entries that feed each other in a loop) stops the save, and the fault is shown at the entry. An entry that is switched off may be saved unfinished.
3. When a save costs a total, the page lists what is lost and asks first: a counter or integration that is deleted, or whose output path, input path, direction, integration mode, threshold (when adding up time) or **Resets** setting changes. Other changes keep the total. Totals belong to output paths, so the comparison is made by output path: an entry that takes over an output, from an import for instance, continues its total.
4. Saving restarts only the entries whose calculation changed. An entry that differs only in its name, unit or group, and every entry left alone, keeps running as it was, in the middle of whatever it was adding up, also when it reads the result of an entry that restarted. The page reports how many entries kept running and how many started. A restarted integration begins its next stretch at the save: the time since its input's last value, at most one sampling interval, is not added.
5. A started entry is handed the latest value of each path it reads at once, so an entry on a path that is sent rarely, such as a switch state, does not wait for the path to speak again.
6. If the entries were saved elsewhere since the editor read them, for instance from a second browser, the save is refused, and the page offers to reload or to export the changes first. A save must name the version of the entries it was based on; the HTTP interface refuses one that does not.

### Import and Export

**Export** downloads the set shown in the editor, with its groups, as `calculated-paths-entries.json`. **Import** reads such a file and replaces the set shown; nothing is saved until **Save**. A file can serve as a backup or carry a set to another server. Totals belong to output paths, so an imported entry continues a saved total on the same output path where it measures the same thing.

## Upgrading From 0.2.x

On its first start, version 0.3.0 moves the entries out of the plugin settings:

1. The entries are written to `entries.json` in the plugin's data directory, in the order the status page showed them (formulas, then period counters, then integrations), without groups.
2. The plugin settings as they were are kept as `settings-before-0.3.0.json` in the same directory.
3. The three lists are removed from the plugin settings, which keep the time zone, day start, week start and repeat interval.
4. Every total carries on: totals are kept by output path in `state.json`, which is unchanged.
5. The status page says once that the entries were moved.

Nothing needs to be done by hand. A later start moves nothing.

**Going back to 0.2.1.** The copy restores the settings that version reads. On the server, with the plugin's data in the default place:

```bash
cp ~/.signalk/plugin-config-data/signalk-calc-paths/settings-before-0.3.0.json ~/.signalk/plugin-config-data/signalk-calc-paths.json
```

Then install version 0.2.1 and restart the server. `entries.json` is left in place and not read by 0.2.1. The totals of the entries in the copy carry on, because `state.json` is shared. Version 0.2.1 keeps only the totals of the entries it runs, so the totals of entries created under 0.3.0, or whose output path or calculation changed under 0.3.0, are deleted at its first save. To keep them for a return to 0.3.0, copy `state.json` aside before going back; restoring it later brings those totals back, but loses what 0.2.1 counted in between.

**Forward again.** If the settings hold entries while `entries.json` exists, `entries.json` stays in charge: the entries in the settings are not used, and are kept as `settings-removed-<number>.json` and removed from the settings. Changes made under 0.2.1 are therefore not carried forward. To carry them forward instead, delete `entries.json` before starting 0.3.0, and the settings' entries are moved again.

**Going back from 0.4.0 to 0.3.0.** Version 0.3.0 does not know the cycles entry type and refuses an `entries.json` that holds one: no entry runs until a new set is saved. Before going back, export the entries as a backup, then delete every cycles entry in the editor and save. The other entries and their totals carry on under 0.3.0. Importing the export after returning to 0.4.0 brings the cycles entries back, with their cycles counted from that moment.

## How the Calculations Behave

### Period Boundaries

1. The baseline of a period is the last input value seen before the boundary. At the boundary the output publishes `0`.
2. Change that arrives with the first value after a boundary belongs to the new period. With an input that reports every few seconds this moves at most a few seconds of change across the boundary.
3. Days follow the time zone in use (see [Time Zones and Day Boundaries](#time-zones-and-day-boundaries)), including its daylight saving changes: a day is 23 or 25 hours long on the two change dates. Where a clock change skips the day-start time itself, that day begins later by the length of the skipped stretch; where the day-start time occurs twice, the day begins the first time.
4. With "When another path resets", the boundary settings are not used. The total clears whenever the followed value falls. A fall that happened while the server was stopped is noticed at restart only if the followed value is still below the last one seen before the stop.

### Restarts

1. Totals, baselines, period starts and the last time zone followed are restored from the state file. Changing an entry's **Resets** setting clears its total, because a total collected under one rule means nothing under another; a period counter keeps its place in its input.
2. A period counter resumes from the last input value it saw. Whatever the source counted while the server was stopped is added when the first new value arrives. If a boundary passed in the meantime, that change lands in the current period and the status page says so.
3. An integration adds nothing for the time the server was stopped.
4. From version 0.2.1 a restored total is the entry's value from the first moment, before any input has arrived. Until the input sends a value the entry is shown as stale, with the text "No value on ... since the plugin started", and its total is published or not as **When an input is stale** says. An entry with a stale timeout of `0` never counts as stale, so its restored total is always published. An engine that is switched off therefore does not make "engine hours today" disappear when the server restarts, provided the entry is set to keep publishing. The total still rolls over at its period boundary while the input stays silent, and the text then says the total has been cleared since. Version 0.2.0 showed such an entry as waiting, with no value, until its input spoke.
5. An entry that reads a restored total which is being published receives it at the first pass after the start. In version 0.2.0 it received nothing until the restored entry's own input had spoken, and a counter chained on it then missed a boundary that had passed in between.
6. Values the server already holds when the plugin starts are used at once, each judged against the stale timeout by its real age. An integration counts from the start, not from the age of such a value.
7. The server keeps the last value of every source that ever wrote to a path. From version 0.2.1 only one of them is used at start-up; see [Input Values](#input-values).

### Counter Direction

1. With "Increases only", a fall in the input is not counted. By default counting carries on from the new, lower value, which is the right behaviour for a source counter that restarts from zero. The alternative waits until the input has passed its previous level, which ignores a brief dip in a total that should never go back.
2. With "Decreases only", a rise is not counted. This suits a tank: the level falling is consumption, and a refill is ignored.
3. "Net change" reports the signed difference since the period began.

### Integration Method

1. An input with a stale timeout above zero is treated as regularly sampled. Consecutive values are joined by a straight line (the trapezoid rule), and the total grows when each new value arrives.
2. An input with a stale timeout of `0` is treated as a value that holds until the next one arrives. The total grows every second in between. This suits a switch state or any input that is sent only when it changes.
3. A stretch between two values that is longer than the stale timeout is a gap. By default it is left out, so the total undercounts and never invents data. With "bridge" the input is assumed to have stayed at its last value for the whole gap.
4. A stretch that spans a period boundary is split at the boundary.

### Input Values

1. Numbers are used as they are. `true` and `false` count as `1` and `0`.
2. `null` means the source has no reading: a formula waits and publishes nothing, and an integration does not join the values on either side of it.
3. Text, objects such as a position, and numbers that are not finite are treated the same way as `null`.
4. Where several sources publish one path, the plugin receives the source the server's source priority prefers.
5. Values that a source sends in one Signal K update are applied together, so a formula over two of them is calculated once, from both.
6. The server keeps the last value of every source that ever wrote to a path, and can hand such a value over long after its source went quiet: all of them when the plugin starts, and single ones later. A device that once appeared under a different source name leaves that name's last value behind in this way. Read as a new value, it would look like a change that never happened: a period counter would add the difference, and a total that resets when a path falls would be cleared. From version 0.2.1 such values are kept out by two rules.
7. **At start-up** one value per path is used: the one the server itself reports for the path, or, where it reports none, the held value with the newest time stamp.
8. **While running** a value from a source other than the one last read is ignored in two cases. From a source seen before on that path: when it repeats exactly what that source sent last, with the same time stamp and the same value, which is what a held value handed over again looks like. From a source not seen before: when it is older than the value last read. Everything the server held at start-up counts as seen. Any other value is a new reading, whatever its source's clock says. Values from the source last read are never ignored, so a recorded log that is played again from its beginning is still read. A time stamp that lies in the future counts as the moment of arrival.
9. The status page reports how many values were ignored since the plugin started, and names the last one.

### How Cycles Are Found

1. **On/off inputs** are ON while the value is above the threshold. A change counts from the moment the value arrives.
2. **Wave inputs** are averaged into 30-second steps, then smoothed over the smoothing span. The smoothed value stands for the middle of the steps it covers, so smoothing does not delay the turning points. A turning point is found when the smoothed value has turned back by the swing, and placed on the highest or lowest step mean nearby, so a wave that falls fast and rises slowly is not pulled out of shape by the smoothing.
3. **Delay.** A wave's turning point is known only once the value has turned back by the full swing, and a change of state counts once it has held for the shortest stretch. A stretch is therefore recorded some minutes after it ends: about five minutes for a fridge with the defaults. Inputs are combined only up to the moment every input is known for, so an input that turns out not to show cycles holds the others back until it has not turned for the longest stretch; from then on it is left out. The status page names the latest stretch found, which can trail the device.
4. **Flicker.** A change of the combined state is accepted once the new state has held for the shortest stretch. A shorter interruption stays inside the stretch it interrupts.
5. **Gaps.** An input with no new value for longer than the stale timeout has a gap. With a stale timeout of `0`, a wave input has a gap when a whole 30-second step passes without a value. The stretch under way during a gap is not measured.
6. **What is counted.** Only stretches whose start and end were both seen are measured. The first stretch after the plugin starts, after a gap, or after an entry is changed is not. Stretches longer than the longest stretch are left out of the figures.
7. **Figures.** The medians are taken over the ON stretches, the OFF stretches and the complete cycles (an ON stretch and the OFF stretch straight after it) that ended within the window. The duty cycle is taken over complete cycles alone, so a window that holds one more OFF than ON stretch does not tilt it. The number of cycles is the number of ON stretches in the window.
8. **Restarts.** The finished stretches in the window are saved with the totals and survive a restart. The stretch under way at a restart is lost, and so is a wave stretch not yet recorded. After a start, a wave input needs three turning points, about a cycle and a half, before its first stretch is measured. An ON and an OFF stretch on either side of a restart do not count as a complete cycle.
9. **Changes.** A change of the inputs, how each is read, the combination, the smoothing, the shortest stretch or the stale timeout forgets the stretches counted, and the editor says so before saving. A change of the figure published, the window, the cycles needed or the longest stretch keeps them, and only the stretches not yet recorded are lost, as at a restart. A change of name, unit or group leaves the entry running as it was.
10. **Forget cycles.** The button on the status page, or the reset route, forgets every stretch counted, for example after a defrost. The stretch under way, and a wave stretch not yet recorded, began before and are left out too, so the figures describe only stretches that began afterwards.

### Stale Inputs

1. An entry whose input is older than its stale timeout is stale. A formula is stale when any one of its inputs is.
2. With "Stop publishing", a stale entry publishes nothing until the input returns.
3. With "Keep publishing the last result", a stale entry goes on sending its last result. A formula is not recalculated while one of its inputs is stale, even if the others keep changing.
4. To the entries that read it, an entry that has stopped publishing, or a formula with no result, counts as having no value. An integration fed by such an entry stops adding and does not join the values on either side of the hole.

### System Clock

1. Durations are measured on a monotonic clock, so a jump of the system clock neither adds nor removes counted time.
2. Period boundaries need the real date. While the system clock reads earlier than 2024 or earlier than the last saved state, period resets are paused and totals keep counting. Resets resume when the clock is correct.
3. If the clock stays behind the saved state for an hour, the clock is believed and the saved time is discarded.
4. A clock that is wrong but plausible cannot be detected. A computer that restores its last shutdown time at boot runs on a date that is not earlier than the saved state, so it is trusted; if the correction later crosses a period boundary, the total resets at that moment.

## Examples

The paths below are examples; the actual paths depend on the installation.

### Power From Current and Voltage

A formula with inputs `i` = `electrical.solar.hardtop.current` and `v` = `electrical.solar.hardtop.voltage`, expression `i * v`, output `electrical.solar.hardtop.panelPower`, unit `W`.

### Energy Today From a Lifetime Total

A period counter on `electrical.solar.hardtop.yieldTotal`, output `electrical.solar.hardtop.yieldToday`, unit `J`, reset every day.

### A Daily Total That Follows Another Device

Some charge controllers publish their own daily yield and reset it at their own time, not at midnight. To make a calculated daily total reset at the same moment, set **Resets** to "When another path resets" and **Path to follow for resets** to that device's daily yield, for example `electrical.solar.port.yieldToday`.

### A Total Across Devices With Different Units

Not every source publishes SI units. A formula can convert while adding. With a calculated total in joules and two devices that report watt-hours: inputs `hardtop`, `port` and `starboard`, expression `hardtop + (port + starboard) * 3600`, unit `J`.

### Engine Hours Today

Two methods are available, and the right one depends on the engine.

| Method | Entry | Suits |
| :--- | :--- | :--- |
| Counter | A period counter on `propulsion.port.runTime`, unit `s`. | An engine computer that reports run time in fine steps. |
| Running time | An integration on `propulsion.port.revolutions`, adding up the time above a threshold of `0`, unit `s`. | An engine computer that reports run time in whole hours. |

The difference matters. On a boat whose engine computer counts whole hours, a run recorded at 3.25 hours by engine speed appeared as 4 hours on the run time counter, because four hour marks happened to fall inside the run. The running-time method depends on the engine speed being published while the engine runs and reading `0`, or nothing, when it is stopped.

### Fuel Used

An integration on `propulsion.port.fuel.rate` (in `m3/s`), adding up the value multiplied by time, unit `m3`. The result is as good as the rate: where the rate is an estimate derived from engine speed, the total is an estimate too.

### Water Used From a Tank Level

A period counter on `tanks.freshWater.0.currentVolume`, counting decreases only, unit `m3`. A smallest change of a few litres (`0.002` is two litres) keeps the ripple of the level sensor out of the total.

### Time a Switch Is On

An integration on a switch state such as `electrical.switches.inverter.state`, adding up the time above a threshold of `0`, with a stale timeout of `0`, unit `s`.

### Fridge and Freezer Compressors

A fridge or freezer whose compressor is not monitored directly can be read from a temperature and humidity sensor inside the box. While the compressor runs, both fall; while it rests, both rise. As frost builds up on the evaporator, it insulates it, and the compressor runs longer to cool the box. The median ON time over a day follows that, while a single long stretch after loading provisions or a door left open barely moves a median.

Humidity is usually the clearer signal. A box's air holds little heat, so its humidity rises and falls by several percentage points every cycle, while a sensor's temperature may move by only a few tenths of a degree, or less where the sensor sits away from the evaporator. A Cycles entry with one wave input:

| Field | Value |
| :--- | :--- |
| Inputs | `environment.inside.refrigerator.relativeHumidity`, read as a wave, ON while falling, swing `0.01` |
| Publish | Median ON time |
| Window | 24 hours |
| Output path | `environment.inside.refrigerator.compressor.onMedian` |

Where the temperature also shows the cycles clearly, it can be added as a second input, read as a wave, ON while falling, with a swing such as `0.05`, and combined with "All inputs ON (and)", so that a stretch counts only when both agree. See [Combining Inputs](#combining-inputs) for how this shortens the stretches read.

The figure is published in seconds. A rules or automation plugin can then raise a notification when it passes a limit. To choose the limit:

1. Let the entry run for a few days after a defrost. The status page shows every figure, not only the one published, so the median ON time, the median OFF time and the duty cycle of the clean box can be read there.
2. Set the limit somewhat above that clean figure, and tighten it after the next defrost, once the frosted figure is known too.
3. After each defrost, press **Forget cycles** so the figure starts again from the clean state.

As an example of what to expect, six weeks of one boat's recorded data, replayed through this entry type with the settings above, gave these daily medians of the ON time:

| Unit | Clean | Frosted | A limit between them |
| :--- | :--- | :--- | :--- |
| Fridge | 9.5 to 12 min | 14.5 to 19 min in the ten days before a defrost | 14 min |
| Freezer | 6.5 to 8 min | 19 to 27 min in the month before a defrost | 15 min |

The day after each defrost the figure fell back to the clean range. Loading provisions raised it by two to four minutes for a day or two, which stays below the limits. The freezer's temperature, with a swing of `0.05`, gave the same figures as its humidity; the fridge's temperature moved too little to be read reliably at any swing, and its humidity alone was used.

### Duty Cycle of a Pump

A Cycles entry with one input, `electrical.switches.pump.state`, read as on/off with **ON above** `0`, stale timeout `0`, publishing the duty cycle. A pump that starts to run more of the time than usual, such as a bilge pump, shows up as a rising duty cycle.

The defaults suit a compressor and need changing for a pump. A pump that runs for a minute would be lost inside the default shortest stretch of 120 seconds, and one that rests for hours would have its OFF stretches left out by the default longest stretch of two hours, leaving no complete cycle. For a pump that runs for a minute or two and rests for hours, set **Shortest stretch** to `10` and **Longest stretch** to `86400`, a day.

## Limitations and Assumptions

1. An integration adds nothing while the server or the plugin is stopped. A period counter does not have this limit, because the source keeps the total.
2. Changed totals are written to disk every 30 seconds, when the plugin is stopped and at every reset. While any total is changing, the state file is therefore rewritten every 30 seconds. Up to 30 seconds of an integration's total can be lost at a crash, a power cut, and also a restart of the server: Signal K server 2.33 ends its process on a restart without stopping its plugins. Disabling the plugin, saving its settings and saving entries in the editor do stop it, or save, first.
3. The first value an entry ever sees only sets its starting point. The first period after an entry is created is therefore partial; the status page shows when counting began.
4. A period counter in a one-way mode counts every change of at least the smallest change. Sensor noise larger than that setting is counted as real change.
5. A followed time zone is as good as its source. The plugin does not work out a zone from the position itself; it reads what another plugin publishes. A source that looks the zone up from old or coarse data can be wrong near borders and on the open ocean.
6. At a change of zone that jumps over a boundary, whatever was counted between the new zone's boundary and the moment of the change stays in the total of the period that ended. With a one-hour change this is at most an hour of counting. See [When the Boat Changes Time Zone](#when-the-boat-changes-time-zone).
7. A fixed offset does not follow daylight saving. Where the offset path is the only source, the day boundary is right only as long as that source updates the offset when the clocks change.
8. A total is cleared at most once for a calendar date. A vessel that crosses the date line eastward lives the same date twice, and one total then covers both.
9. A zone name left behind in the server by a source that no longer publishes it is believed until a newer offset contradicts it. Name and offset are compared again every minute, so a disagreement that only arises at a daylight saving change is noticed then.
10. Period resets depend on the system clock being correct. An unset clock is detected; a wrong but plausible one is not. See [System Clock](#system-clock).
11. Units are neither checked nor converted. The unit entered is published as given, and a formula that mixes units must convert them itself.
12. Only numbers and true/false values can be read. A field inside an object value cannot be selected.
13. The plugin does not stop an output path that another source already writes. Two writers on one path give alternating values. The editor warns when the server already holds a value on the path from another source.
14. A formula is evaluated on every input value and published at most once a second. It does not average or smooth.
15. "When another path resets" treats any fall of the followed value as a reset. The status page records the two values and the source of the lower one.
16. Whether a value is an old one handed over again is judged partly by time stamps, and the time stamps of two sources need not share a clock. A source that first appears with a clock running behind the source being read loses its first value. An old value from a source the plugin has never seen, stamped later than the current one, is taken as new once. At start-up, where the server reports no value of its own for a path and two sources left values stamped by different clocks, the wrong one can be picked; the first live value then puts it right, at the cost of one false step. See [Input Values](#input-values).
17. Published numbers are rounded to twelve significant digits.
18. Node.js 22 or later is required.
19. A total belongs to its output path. Renaming an output path in the editor starts the total from zero, and the old path keeps its last value in the server until the server restarts.
20. The editor and its routes need read/write access. On servers that predate per-route access levels they need admin access.
21. A Cycles entry measures what its inputs show, not the device. A temperature or humidity inside a box responds later than the compressor and is changed by the door and by what is loaded, so its stretches differ from the compressor's own. The figures suit a trend and an alert limit set on them, not a reading of the compressor's run time.
22. A wave input is read in 30-second steps. A sensor that reports less often, up to about once a minute, leaves some steps empty, and the smoothing averages the steps there are. A pause longer than the stale timeout is a gap, which is why cycles entries default to a stale timeout of 180 seconds; a shorter one, such as 60 seconds for a sensor that reports once a minute, breaks the series at every late report.

## Prerequisites

- **Signal K Server**: Developed and tested on Signal K server 2.33.0.
- **Node.js**: Version 22 or later.
- **Input Paths**: The paths to calculate from must already be present in Signal K. **Data > Browser** shows them with their units.
- **Ship's Time (optional)**: A plugin that publishes the vessel's time zone, such as [Ship's Time](https://www.npmjs.com/package/@meri-imperiumi/signalk-ships-time), lets day boundaries follow the boat. Without one, a time zone is chosen in the settings.

## Quick Start Guide

1. Open the Signal K admin UI, navigate to **Apps & Plugins > Store** and install `signalk-calc-paths`.
2. Restart the server when prompted.
3. Go to **Apps & Plugins > Configuration > Calculated Paths**, enable the plugin and check the time zone. With a ship's time plugin installed nothing needs to be set. Otherwise pick a zone under **Time zone when none is published** if the server does not run on local time.
4. Click **Submit**.
5. Open **Webapps > Calculated Paths** and the **Edit entries** tab.
6. Click **Add entry**, choose a formula, a period counter, an integration or a cycles entry, and fill in its paths and unit.
7. Click **Save**.
8. The **Status** tab shows each entry's value and state, and the time zone in use. Check the new path under **Data > Browser**.

## Technical Details

### Status Page and Access

The page is at `/signalk-calc-paths/`, with the status at `#status` and the editor at `#edit`. With server security enabled, any logged-in user can view the status; resetting a total and editing entries require read/write or admin access. On servers that predate per-route access levels, everything but viewing requires admin access.

The status shows each value in an everyday unit (Wh or kWh for joules, hours and minutes for seconds, litres for small volumes, knots for speeds, nautical miles from 1 nm up) with the published SI value beneath it.

From version 0.2.1 the page also answers why a total reads what it reads:

1. **Last reset.** Under each counter and integration: when the total was last cleared and why. For a total that follows another path, the sentence gives the value the path fell from, the value it fell to, and the source of the lower value, for example "Last reset Oct 11, 23:40: electrical.solar.center.yieldToday fell from 1,540 to 0, a value from ...".
2. **Corrected start time.** When "counting since" was replaced without clearing the total, because it was unknown or lay in the future after a clock correction, the page says so and gives the time it replaced.
3. **Zone change.** In the first line: the last change of the followed time zone.
4. **Plugin start.** In the last line: when the plugin last started. A start that nobody asked for shows up here.
5. **Ignored values.** A notice counts the input values ignored as outdated; see [Input Values](#input-values).

### HTTP Interface

| Request | Access | Result |
| :--- | :--- | :--- |
| `GET /plugins/signalk-calc-paths/api/entries` | Any logged-in user | Every entry with its value, state, message and last reset (`lastReset`, `sinceCorrected`), the time zone in use with its source and last change (`timeZoneSource.lastChange`), the time the plugin started (`startedAt`) and the count of ignored values (`outdatedValues`). |
| `POST /plugins/signalk-calc-paths/api/entries/{output path}/reset` | Read/write or admin | Clears the total of one counter or integration, or makes a cycles entry forget the cycles counted. |
| `GET /plugins/signalk-calc-paths/api/config` | Read/write or admin | The groups and entries as saved, their revision, and the field definitions the editor builds its forms from. |
| `PUT /plugins/signalk-calc-paths/api/config` | Read/write or admin | Saves a set of groups and entries, given with the revision read. Answers 400 with the faults by entry, or 409 when the set was changed since that revision. |
| `GET /plugins/signalk-calc-paths/api/paths` | Read/write or admin | Every path on the vessel with its current value and unit, for the editor's suggestions. |
| `POST /plugins/signalk-calc-paths/api/preview` | Read/write or admin | Works out a formula with the current values, without saving it. |

The interface is described in the server's OpenAPI browser, opened from **OpenApi** in the admin menu.

### Files

The entries and the totals are kept in the plugin's data directory:

```
~/.signalk/plugin-config-data/signalk-calc-paths/entries.json
~/.signalk/plugin-config-data/signalk-calc-paths/state.json
```

`entries.json` holds the groups and entries as the editor saves them. A file that cannot be read is left exactly as it is and reported in the plugin status and on the page; no entry runs and no total is saved until a new set is saved in the editor. That save writes the new set in full first, then moves the old file aside as `entries.json.unreadable-<number>`. Signal K's own backup, under **Server > Backup/Restore**, includes the directory.

`state.json` is rewritten in place and holds one small record per counter and integration, including the time and cause of its last reset, and the last time zone followed with its last change. For a cycles entry the record holds the finished stretches in its window, a few hundred numbers for a day of fridge cycles. It keeps no older history and does not grow. Deleting an entry in the editor removes its record at the next save; switching an entry off keeps it. A record that no entry uses when the plugin starts, such as one left after a damaged `entries.json` was replaced by a smaller set, is kept for 30 days, so an entry with that output that comes back, typed in again or imported, continues its total; after that it is removed. An entry's record is discarded when its output path, its input path, its direction, its integration mode, its **Resets** setting or, when adding up time, its threshold is changed, because the old total no longer describes the new calculation.

To clear every total, stop the plugin, delete the file and start the plugin. A file that cannot be read is moved aside as `state.json.unreadable-<number>` and reported in the plugin status.

### History and Databases

The plugin keeps no history. Its outputs are ordinary Signal K paths, so a history plugin such as `signalk-to-influxdb2` stores them like any other path, unless a filter there excludes them.

### Validation

The calculations were replayed over five days of recorded data from one boat and compared with figures computed independently:

1. Daily energy from a lifetime counter matched to 0.1 Wh on each of the five days.
2. Energy from integrating current times voltage matched the lifetime counter within 0.1 % on both days checked.
3. Engine running time and fuel used matched an independent calculation over a run of 3.25 hours.

From version 0.4.0, cycles entries were replayed over six weeks of recorded fridge and freezer data from the same boat. The median ON times matched those found independently from the same data by a separate analysis script: about 10.5 minutes for the clean fridge, 22.5 minutes for the frosted freezer and 6.5 minutes for the freezer the day after its defrost.

The recorded data is not part of this repository. The automated tests use synthetic data.

### Log Monitoring

To stream log lines from this plugin:

```bash
journalctl -u signalk -f | grep "signalk-calc-paths"
```

Detailed messages appear after switching on **Enable debug log** on the plugin's configuration page.

### Troubleshooting

**An entry stays at "Waiting".** No value has arrived on one of its inputs. The status page names the path. Check its spelling against **Data > Browser**.

**An entry shows "Stale".** The input stopped updating for longer than the stale timeout. For an input that is sent only when it changes, set the stale timeout to `0`. From version 0.2.1 an entry also shows "Stale" with the text "No value on ... since the plugin started" while it holds a total restored after a restart and its input has not sent anything yet; this ends with the input's first value.

**A daily total resets at the wrong time.** The status page states the time zone in use and where it comes from. If it says UTC read from a followed path, the plugin publishing the ship's time is probably still at its default; see [Setting It Up](#setting-it-up). If it says the server's own time zone and the server runs on UTC, either install a ship's time plugin or pick a zone under **Time zone when none is published**. If it names a followed path, the zone published there is the one to check, under **Data > Browser**.

**The status page says no ship's time has been published.** Nothing has arrived on either followed path. Check under **Data > Browser** that `environment.time.timezoneRegion` or `environment.time.timezoneOffset` exists, and that the plugin publishing it is enabled. A ship's time plugin that works from the position publishes nothing until the vessel has a position.

**The status page says a followed value is not a time zone.** The path holds something other than a zone name or an offset in hours and minutes. See [What a Followed Path May Hold](#what-a-followed-path-may-hold).

**A total started again at an unexpected time.** From version 0.2.1 the status page says when and why under the entry, after "Last reset". A fall of the followed path is given with both values and the source. If the lower value came from a source that should not be writing that path, the fault is upstream of this plugin. If the page instead says the start time was set without clearing the total, the system clock was corrected; see [System Clock](#system-clock).

**A total is missing after a server restart.** Version 0.2.0 showed a restored total only once its input had sent a value. Version 0.2.1 shows it at once. Whether it is also published while the input is silent is decided by **When an input is stale**; an entry with a stale timeout of `0` always publishes it.

**A daily total was cleared, or not cleared, when the boat changed time zone.** This follows the calendar date. See the examples under [When the Boat Changes Time Zone](#when-the-boat-changes-time-zone).

**The status reports a configuration error.** One entry cannot run: a path is missing or malformed, an expression does not parse, two entries write the same path, or entries feed each other in a loop. The other entries keep running. The message names the entry. From version 0.3.0 the editor refuses to save such an entry while it is switched on.

**The Edit entries tab is missing.** The login may read data but not change it. Editing needs read/write or admin access.

**The page says entries.json cannot be used.** The file was damaged or edited by hand into a form the plugin cannot read. It has been left as it is. Either repair it and restart the plugin, or build a set in the editor and save it, which keeps the damaged file beside the new one. A set exported earlier can be imported. Saved totals are kept: an entry with the same output path as before continues its total, and totals no entry uses are kept for 30 days.

**The settings no longer show the formulas, counters and integrations.** From version 0.3.0 entries are edited on the plugin's page under **Webapps**; see [Upgrading From 0.2.x](#upgrading-from-02x).

**A total is higher than expected on a tank or level.** Sensor ripple is being counted. Raise **Smallest change to count**.

**A cycles entry stays at "Waiting".** The message says how many of the cycles needed have been counted in the window, or that no complete cycle within the longest stretch has ended; for the second, raise **Longest stretch**. The first stretch after a start is never measured, and a wave input needs about a cycle and a half to find its first stretch, so with the defaults a figure appears after four to five cycles: about two hours for a fridge. If the count stays at zero while the device cycles, see the next item.

**A cycles entry counts too few or too many cycles.** Compare the number of cycles on the status page with the device, or with a graph of the input. Too few: the swing is larger than the input's rise and fall, or the inputs combined with "All" rarely agree; lower the swing, or try each input on its own. Too many, with short stretches: the swing is within the sensor's noise; raise the swing or the smoothing. Remember that the swing is in Signal K's unit: kelvin for temperature, a ratio for humidity.

## Future Enhancements

These are not implemented.

* **Previous-Period Values**: Publishing the finished total of the last period, such as yesterday's yield, on a second path.
* **Fields Inside Object Values**: Reading one field of an object-valued path.
* **Reset by Signal K PUT**: Resetting a total from another plugin or a phone shortcut.
* **Averages and Extremes**: A fourth entry type for the mean, minimum or maximum over a period.

## Support

For bug reports and feature requests, open an issue at [GitHub Issues](https://github.com/Peter-Petrik/signalk-calc-paths/issues). Include the Signal K server version, the Node.js version, the plugin version, the configuration of the entry concerned and relevant log output.

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Screenshots

### Status Page
![Status page with groups](screenshots/webapp-status.png)
![A cycles entry on the status page](screenshots/webapp-status-cycles.png)

### Entry Editor
![Entry editor with groups](screenshots/webapp-editor.png)
![A formula in the editor, with its live preview](screenshots/webapp-editor-formula.png)
![A cycles entry with two wave inputs](screenshots/webapp-editor-cycles.png)

### Plugin Settings
![Time zone settings](screenshots/configuration-timezone.png)

## License

Copyright 2026 Peter Petrik. Licensed under the [GNU General Public License v3.0 or later](LICENSE).
