# Upgrading From Earlier Versions

This page records what happens when an installation of an earlier version is updated, and how to go back. The current version needs no steps by hand: entries, groups and totals carry over.

## From 0.8.0 Back to 0.7.0

Version 0.7.0 does not know the record entry type and refuses an `entries.json` that holds one: no entry runs until a new set is saved. Before going back, export the entries as a backup, then delete every record in the editor and save. The other entries and their totals carry on under 0.7.0, which ignores the **Fill in from history** setting and what the look-backs found. Importing the export after returning to 0.8.0 brings the records back, from their saved state where 0.7.0 kept it and otherwise filled in from the history again.

## From 0.7.0 Back to 0.6.x

Version 0.6.x does not know the **ON time so far** figure of a cycles entry and reads it, without a fault, as the median ON time, so an alert on such a path would get a different figure. Before going back, delete those entries or switch them to another figure, and save. The rest carries over: a counter's held value and the closing totals in the reset records are ignored by 0.6.x.

## From 0.4.0 or Later Back to 0.3.0

Version 0.3.0 does not know the cycles entry type and refuses an `entries.json` that holds one: no entry runs until a new set is saved. Before going back, export the entries as a backup, then delete every cycles entry in the editor and save. The other entries and their totals carry on under 0.3.0. Importing the export after returning to 0.4.0 brings the cycles entries back, with their cycles counted from that moment.

## From 0.2.x to 0.3.0 or Later

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
