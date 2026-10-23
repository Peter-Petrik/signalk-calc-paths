# Time Zone Changes, Worked Through

The README's section [Time Zones and Day Boundaries](https://github.com/Peter-Petrik/signalk-calc-paths#time-zones-and-day-boundaries) explains which zone is used. This page shows what happens to a total when the boat changes time zone.

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
