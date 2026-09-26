# Group availability scheduling ("Availability" tab)

Describes what is actually built. It started as the approved implementation plan (the fuller planning-process copy lives at `C:\Users\abirr\.claude\plans\as-a-group-owner-moonlit-yao.md` on the machine that built this); anything that changed from that plan is marked **Changed from original plan**, with the reason.

## What it does

Group members paint their weekly busy / if-needed time on a grid in the group dashboard's Availability tab. The group sees where everyone overlaps and gets live "best times" recommendations. Correct across real timezones, including half-hour and 45-minute offsets (India, Nepal) and DST changes that happen on different dates in different countries.

Locked-in decisions (unchanged):
- **Per-group data.** Timezone is personal and lives on the user's profile.
- **Open to every member.** No owner/admin gating on painting or viewing.
- **Luxon via CDN `<script>` tag**, used only by the availability code.

## The tab as built

Three sub-tabs inside Availability (`.availabilitySubTabs`):

1. **My availability**: your own paint grid.
2. **Team overlap**: heatmap of how many members are free per slot, with a hover/tap detail line: the slot in each member's own local time ("12:00 PM for you, 11:30 PM for Priya (Kolkata)", same-clock members skipped, capped at 3 with "and N more", weekday added when their date differs), then who is free, if-needed, busy, and outside their usual hours.
3. **Best times**: the always-live top-3 recommendations, with a meeting-length selector (client-side only, never stored).

**Changed from original plan:** the plan stacked grid, heatmap and recommendations on one long page. Real use showed that was a lot of scrolling on a phone, so each got its own sub-tab.

### Grid layout

- 7 columns, **today first**: column 0 is always today in the viewer's saved zone, column 6 is six days out. Each header shows the day name plus the real date (e.g. "Sat Sep 26"), refreshed on every render and by a 60-second timer so it stays right past midnight.
- Storage is still keyed by absolute weekday (`0`=Sunday..`6`=Saturday), so column order is display-only.
- 30-minute rows over the group's view window (default 7am-11pm), sticky header row and time column, inside its own bounded scroll box.

**Changed from original plan:** it was a fixed Sun-Sat week. Feedback after real use: this is a book-ahead tool, so "the next 7 days starting today" is what people actually look at.

### Week and Day views

A **Week | Day** toggle sits under the brush row on My availability and above the heatmap on Team overlap (default Week, never auto-switched). Both share one layout state, so switching sub-tabs always shows the same mode and day. Day shows the time column plus one wide column for a single day, with prev/next buttons stepping through the same 7 days ("Today, Sat Sep 26", "Sunday, Sep 27", ...). Rows are a little taller in Day view, which makes it the easier layout to paint on a phone.

Day view is purely a display filter over the same grid: the other six columns get `display: none` (CSS `nth-child` on the grid's fixed child order, see `.availabilityGrid.dayMode` in style.css). Storage, painting, saving and the pointer/touch code are unchanged, and a hidden cell can never be painted. The selected day is remembered as a date, so a midnight rollover keeps showing the same day while it's still in range (falling back to today once it isn't), and an hour-range change keeps both mode and day. Switching Day to Week and back loses nothing.

**Changed from original plan:** the original spec's day view (Phase 3) was built later as this filter rather than a separate grid, so there is only ever one set of cells to keep in sync. The heatmap uses the same filter (same grid child order), re-applied after every heatmap re-render since that rebuilds its grid element; the hover/tap detail line works unchanged, and hidden heatmap cells can't be hovered, tapped or focused. The heatmap's toggle hides while there's no heatmap grid (nobody has painted yet).

### Painting model

- A new grid starts **fully free**. You only paint the exceptions.
- Brushes: **Busy** (default, listed first), **If needed**, and **Free**, which acts as the eraser.
- Leaving My availability with a loaded but never-painted grid asks for confirmation once (`hasBeenPainted`). This is skipped while the guided tour is open, so the tour's Availability step never triggers it.

**Changed from original plan:** the plan had a start-state setup step ("paint free time" vs "paint busy time") before you could paint. In real use most time is free, so marking only busy time is far less work, and the setup step was removed.

### Mouse, touch and pen

- **Mouse**: press to start a stroke, drag to paint, release to end. The brush is fixed for the whole stroke.
- **Touch**: tap paints one cell. A swipe scrolls normally and paints nothing. **Press and hold (300ms)** arms a stroke (accent ring around the grid, plus a short vibration where supported), then drag to paint. A hint explaining this shows only on coarse pointers.
- **Pen**: a pen that hovers before touching paints immediately like a mouse; otherwise it follows the touch rules.
- Holding near the edge of the grid's scroll box while painting auto-scrolls it.

**Changed from original plan:** the plan toggled `touch-action` to `none` per stroke. That can't work for touch: the browser fixes `touch-action` when the touch starts, so on a phone a drag became a scroll and only the first cell painted. Making the grid permanently `touch-action: none` would have trapped page scrolling instead. Press-and-hold keeps normal scrolling and makes painting deliberate.

## Data model (unchanged)

**`users/{uid}.timezone`**: IANA zone, auto-detected, user-editable. Self-read only; it's just the default copied onto a new availability doc.

**`groups/{groupId}/availability/{uid}`**, one doc per member:
```js
{
  timezone: "America/Edmonton",  // the zone this grid was painted in
  weekdaySlots: {                // "0".."6" (Sun..Sat), ALWAYS 96 chars each:
    "0": "AAAABBBB...",          // one char per 15-min slot over the full 24h.
    ...                          // 'A' free, 'B' busy, 'I' if-needed.
  },
  hasBeenPainted: true,
  updatedAt: serverTimestamp
}
```
- The timezone lives on this doc, not only on the profile, because teammates can't read each other's profiles. It also keeps an already-painted grid correct if its owner later changes their profile zone.
- Storage always covers the full 24 hours. The group's `availabilityHourRange` (owner-only, default 7-23) is a **view** window only, so changing it never needs to rewrite anyone else's data. The owner sets it under Group Settings > "Availability hours" (two hour dropdowns, start before end, end up to midnight), which writes exactly `{ availabilityHourRange: { startHour, endHour } }` via `setGroupAvailabilityHourRange` in `groups-data.js`. The grid, heatmap and Best times re-render live from it.
- A doc is only ever created for a grid that was actually painted (or deliberately saved untouched via the "save this untouched grid anyway?" confirm). Changing your timezone on an unpainted grid writes nothing to the group; the new zone is stamped on the first real paint.
- **Leave deletes your own doc** (`leaveGroup`, and account deletion). **A kick does not** (same convention as tasks); views filter to current `memberIds` instead, so a kicked member's doc never shows. Every member's doc is deleted in `deleteGroupCompletely`.
- Writes are debounced: one write about 1.5s after the last change, plus a `beforeunload` flush. Never one write per cell (dev and prod share one Firebase project).

## Timezone strategy (unchanged)

Slots are stored as local wall-clock time + weekday in the painter's zone, never pre-converted to UTC. For each real date, Luxon resolves that zone's actual offset, converts to a UTC instant, then into the viewer's zone. So a slot can land on a different day for different viewers, half-hour and 45-minute offsets need no special handling, and DST is handled per date. 15-minute storage behind 30-minute UI rows is what keeps Kathmandu's :15/:45 boundaries exact for everyone.

Weekday numbering: storage uses JS `getDay()` (`0`=Sunday); Luxon uses ISO (`7`=Sunday). The conversion lives in one helper pair, and dates are resolved by a day-delta from a real anchor date, never `DateTime.fromObject({ weekday })`.

DST gap/overlap times use Luxon's defaults (gap: shift forward; overlap: earlier instant).

### Timezone picker

The zone name next to "Times shown in" has a Change button that opens a searchable zone picker with each zone's live local time. Saving updates your profile, and the `timezone` on your existing availability doc in every group you're in (the current group via the normal debounced save if you've painted it, every other group with one read and one update each, skipping groups where you have no doc yet). An unpainted grid never gets a doc from this.

## Live data and recommendations

- **Group-wide availability listener is only open while Team overlap or Best times is showing.** Leaving those sub-tabs (or the Availability tab) closes it. If the listener errors, it retries with bounded backoff (2s, 5s, 30s, then stops).
- **Members are filtered by the group's current `memberIds`**, so a kicked or departed member's leftover doc never shows up in the heatmap or recommendations.
- **Never-painted members are excluded from scoring** and listed separately ("haven't set their availability yet").
- **Recommendations are always live** over a **rolling next-7-days window of absolute instants** starting from now.

**Changed from original plan:** the plan searched "this week." A fixed calendar week goes stale on a Friday (almost nothing left to suggest) and misses slots that fall just past the week boundary for far-apart zones. A rolling window starting now always searches the same distance ahead.

Algorithm (client-side, no writes): build one UTC timeline at 15-minute resolution from every scorable member's grid, slide a window of the chosen meeting length across it, rank by fewest missing, then fewest if-needed, then earliest, merge overlapping equally-good windows, return the top 3 with a plain-English explanation. There is no "reason" field anywhere, so teammates only ever see free/busy/if-needed.

## Files

- `group/availability-timezone.js`: pure conversion and scoring functions (no DOM/Firestore), depends only on global `luxon`.
- `group/availability-timezone.test.html`: standalone browser test page (no test runner in this project).
- `group/group.js`: the Availability section (starts at the comment "Availability scheduling - see availability-plan.md"), plus one guided-tour step in `GROUP_TOUR_STEPS`.
- `group/index.html`: the Availability tab button and panel, sub-tabs, Luxon `<script>` tag.
- `style.css`: `.availability*` rules.
- `firestore.rules`: `match /availability/{uid}` under `groups/{groupId}` (create/update self-only AND a current member, strict key/type/size checks, delete by self or group owner), plus an owner-only `availabilityHourRange` update on the group doc. **Needs a manual Firebase Console republish** (no CLI in this repo).

## Tests (`availability-timezone.test.html`, 10 cases)

1. Kolkata evening slot shows at the correct local time and day in Edmonton.
2. A slot crossing midnight lands on the correct day for both viewers.
3. The same recurring slot stays correct across the 2026-10-25 / 2026-11-01 DST boundary.
4. Asia/Kathmandu (UTC+5:45) round-trips with no drift.
5. Three-timezone overlap finds the correct shared window.
6. A weekday resolved from an anchor on a different weekday lands on the nearby date, not the following week (found in peer review).
7. A long free block merges into one recommendation, not several overlapping ones (found in peer review).
8. Rolling window finds the soonest all-free slot for zones 11.5h apart (near edge).
9. Rolling window reaches the far edge, and its bounds are exact.
10. Usual-hours window: time outside a member's hours in their own zone reads as outside (`O`), not free or busy, and Best times never suggests it (found in live E2E testing).

The touch/mouse painting behavior was verified separately with a headless Edge harness (touch emulation): swipe scrolls without painting, tap paints one cell, hold-then-drag paints a run without scrolling, edge auto-scroll, second finger ignored, correct cells when the grid is scrolled, group switch mid-stroke ends the stroke cleanly.

## Not built yet / open

Done since the original plan: the owner-only hour-range setting (Group Settings > "Availability hours", originally Phase 6), the Day view (see Week and Day views), and Leave/Delete group inside Group Settings (now open to every member; plain members see only Leave).

- Not yet tested on a real phone, iOS Safari, or with a real pen.
- The group-wide listener reads every member's doc at once. That's fine at normal group sizes; very large groups may need a cap.
