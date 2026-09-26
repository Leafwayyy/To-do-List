// Pure timezone/scheduling math for the group Availability feature.
//
// Zero DOM/Firestore dependency on purpose - this is loaded standalone by
// availability-timezone.test.html, and by group.js for the real feature.
// Requires the global `luxon` (loaded via a CDN <script> tag by whichever
// page includes this file) to already be present - see availability-plan.md
// for why Luxon: this codebase has no other timezone-conversion code, and
// hand-rolled offset arithmetic can't correctly handle DST transitions that
// land on different real-world dates in different countries.

const SLOT_MINUTES = 15;

// This app's existing calendar code (getDateKey, getStartOfCalendarWeek in
// task-shared.js/group.js) uses JS's native Date.getDay() convention:
// 0=Sunday..6=Saturday. Luxon's own .weekday is ISO: 1=Monday..7=Sunday.
// Every weekdaySlots key this feature stores uses the JS convention, to
// match the rest of the app - these two helpers are the only place the
// ISO/JS numbering gap is bridged, so nothing else needs to think about it.
function jsWeekdayToLuxon(jsWeekday) {
    return jsWeekday === 0 ? 7 : jsWeekday;
}

function luxonWeekdayToJs(luxonWeekday) {
    return luxonWeekday === 7 ? 0 : luxonWeekday;
}

function getSlotsPerDay(hourRange) {
    return (hourRange.endHour - hourRange.startHour) * (60 / SLOT_MINUTES);
}

// slotIndex -> {hour, minute}, local wall-clock time within hourRange.
function slotIndexToLocalTime(slotIndex, hourRange) {
    const totalMinutes = hourRange.startHour * 60 + slotIndex * SLOT_MINUTES;
    return { hour: Math.floor(totalMinutes / 60), minute: totalMinutes % 60 };
}

// {hour, minute} -> slotIndex, or null if outside the configured hour range.
function localTimeToSlotIndex(hour, minute, hourRange) {
    const totalMinutes = hour * 60 + minute;
    const startMinutes = hourRange.startHour * 60;
    const index = Math.floor((totalMinutes - startMinutes) / SLOT_MINUTES);
    if (index < 0 || index >= getSlotsPerDay(hourRange)) {
        return null;
    }
    return index;
}

// Resolves the REAL calendar date (year/month/day) for `jsWeekday`, nearest
// to `weekAnchor`. This is the step that makes DST correct everywhere
// below - every conversion is anchored to an actual date before Luxon
// resolves an offset, never a hardcoded/floating one.
//
// Two real bugs caught by peer review before this shipped, both now fixed:
// (1) a naive forward-only `target - anchor` delta (Luxon's own ISO weekday
// numbering, 1=Mon..7=Sun) resolved "which Sunday" inconsistently depending
// on which day of the week the anchor happened to be - fixed with a
// symmetric delta in the range [-3, +3] (nearest occurrence, forward or
// backward), sidestepping the ambiguity without needing a canonical
// week-start at all. (2) this used to call `weekAnchor.setZone(zone)`
// BEFORE computing the delta, per-member - but converting the same anchor
// INSTANT into two different members' zones can land on two different
// calendar days near a week boundary (e.g. Monday 3am UTC is still Sunday
// evening in Edmonton but already Monday morning in Kolkata), silently
// shifting which real week each member's slots get evaluated against and
// breaking overlap detection between them. Fixed by resolving the
// calendar date ONCE in a single fixed frame (UTC), before any per-member
// zone is applied - every member is now guaranteed to be evaluated against
// the exact same calendar date for a given weekday, and each member's own
// zone is only applied afterward, in convertLocalSlotToUtc below.
function getDateForWeekday(weekAnchor, jsWeekday) {
    const anchorUtc = weekAnchor.toUTC();
    const rawDelta = jsWeekdayToLuxon(jsWeekday) - anchorUtc.weekday;
    const dayDelta = ((rawDelta + 3) % 7 + 7) % 7 - 3;
    return anchorUtc.plus({ days: dayDelta });
}

// The core conversion: a slot painted by `ownerZone` on `jsWeekday` at
// `slotIndex` (within hourRange), for the real week containing weekAnchor -
// returned as a Luxon DateTime already in ownerZone (call .toUTC() for the
// UTC instant). DST-correct because getDateForWeekday resolves a real date
// first (in a fixed UTC frame, shared by every member), and Luxon then
// resolves ownerZone's actual offset for THAT specific date.
function convertLocalSlotToUtc(jsWeekday, slotIndex, ownerZone, hourRange, weekAnchor) {
    const { hour, minute } = slotIndexToLocalTime(slotIndex, hourRange);
    const targetDate = getDateForWeekday(weekAnchor, jsWeekday);
    return luxon.DateTime.fromObject(
        { year: targetDate.year, month: targetDate.month, day: targetDate.day, hour, minute, second: 0, millisecond: 0 },
        { zone: ownerZone }
    );
}

// The inverse view: given a UTC instant, where does it land on viewerZone's
// own grid? May return slotIndex: null if it falls outside the viewer's
// configured waking hours - still a valid, convertible time (used for the
// hover/tap tooltip), just not plottable as a grid cell.
function convertUtcToViewerLocal(utcDateTime, viewerZone, hourRange) {
    const local = utcDateTime.setZone(viewerZone);
    return {
        jsWeekday: luxonWeekdayToJs(local.weekday),
        slotIndex: localTimeToSlotIndex(local.hour, local.minute, hourRange),
        dateTime: local
    };
}

// Builds { utcIsoString -> Map<uid, 'A'|'B'|'I'> } for every member, for the
// real week containing weekAnchor. Shared by the heatmap and the
// recommendation search so both always agree on the same timeline.
function buildUtcTimeline(members, hourRange, weekAnchor) {
    const timeline = new Map();
    members.forEach((member) => {
        for (let jsWeekday = 0; jsWeekday <= 6; jsWeekday += 1) {
            const packed = member.weekdaySlots ? member.weekdaySlots[String(jsWeekday)] : null;
            if (!packed) {
                continue;
            }
            for (let slotIndex = 0; slotIndex < packed.length; slotIndex += 1) {
                const value = packed[slotIndex];
                const key = convertLocalSlotToUtc(jsWeekday, slotIndex, member.timezone, hourRange, weekAnchor)
                    .toUTC().toISO();
                if (!timeline.has(key)) {
                    timeline.set(key, new Map());
                }
                timeline.get(key).set(member.uid, value);
            }
        }
    });
    return timeline;
}

// Value for "outside this member's usual hours" - never stored, only
// produced when a view window is passed in below.
const OUTSIDE_HOURS_VALUE = 'O';

// A member's stored value ('A'|'B'|'I') at one absolute instant, read in the
// MEMBER's own zone. weekdaySlots is always the full 24h, so the index is
// simply local hour * 4 + quarter-hour. Anything unreadable (no zone, an
// invalid zone, a missing day string) counts as busy.
//
// viewHourRange (optional, the group's view-only {startHour, endHour}):
// when given, any instant outside it in the member's own local hours
// returns 'O' instead of the stored value. The one meaning used everywhere:
// outside the window is "not available for meetings" - not free (the
// heatmap must not count it) and not busy (the explanation must not say
// "busy" for a slot the member left free). Storage is never touched.
function getMemberValueAtInstant(member, utcDateTime, viewHourRange = null) {
    if (!member.timezone) {
        return 'B';
    }
    const local = utcDateTime.setZone(member.timezone);
    if (!local.isValid) {
        return 'B';
    }
    if (viewHourRange && (local.hour < viewHourRange.startHour || local.hour >= viewHourRange.endHour)) {
        return OUTSIDE_HOURS_VALUE;
    }
    const packed = member.weekdaySlots ? member.weekdaySlots[String(luxonWeekdayToJs(local.weekday))] : null;
    const index = local.hour * (60 / SLOT_MINUTES) + Math.floor(local.minute / SLOT_MINUTES);
    return (packed && packed[index]) || 'B';
}

// Rounds up to the next 15-min UTC boundary (unchanged if already on one).
// Every real zone offset is a multiple of 15 minutes, so a UTC slot boundary
// is also a local slot boundary for every member.
function roundUpToSlotBoundary(dateTime) {
    const slotMillis = SLOT_MINUTES * 60 * 1000;
    const millis = Math.ceil(dateTime.toMillis() / slotMillis) * slotMillis;
    return luxon.DateTime.fromMillis(millis, { zone: 'utc' });
}

// Same { utcIsoString -> Map<uid, 'A'|'B'|'I'> } shape as buildUtcTimeline,
// but for a ROLLING window: every 15-min instant from windowStartUtc
// (rounded up to the next slot) through windowStartUtc + days, each member
// read at that exact instant in their own zone.
// Real bug this replaces for the live panel: buildUtcTimeline maps each
// weekday to ONE calendar date shared by every member, then reads that date
// in each member's own zone. For members far apart (Kolkata vs Edmonton,
// 11.5h+) the two "weeks" end up offset by most of a day, so a slot that
// is free for everyone right now (Edmonton's Thursday evening = Kolkata's
// Friday morning) had no data for one of them and scored as busy. Stepping
// absolute instants gives every member the same real 7-day span.
// viewHourRange (optional): see getMemberValueAtInstant - adds 'O' values.
function buildUtcTimelineForRollingWindow(members, windowStartUtc, days, viewHourRange = null) {
    const timeline = new Map();
    const start = roundUpToSlotBoundary(windowStartUtc);
    const totalSlots = days * 24 * (60 / SLOT_MINUTES);
    for (let i = 0; i < totalSlots; i += 1) {
        const instant = start.plus({ minutes: i * SLOT_MINUTES });
        const values = new Map();
        members.forEach((member) => {
            values.set(member.uid, getMemberValueAtInstant(member, instant, viewHourRange));
        });
        timeline.set(instant.toISO(), values);
    }
    return timeline;
}

function memberSetKey(members) {
    return members.map((member) => member.uid).sort().join(',');
}

// Merges chronologically-adjacent windows that have the exact same
// missing/if-needed member sets into one contiguous block, so e.g.
// "4:00-4:15 works" and "4:15-4:30 works" (identical outcome) become one
// "4:00-4:30" recommendation instead of two near-duplicates. Must run
// BEFORE ranking - it depends on candidates still being in chronological
// (start-time) order.
// Real bug caught by peer review before this shipped: candidate windows
// slide by one 15-min slot at a time regardless of meeting length, so for
// any meeting longer than 15 minutes, consecutive candidates OVERLAP
// rather than exactly touch (a 60-min window starting at 4:00 ends at 5:00,
// but the very next candidate starts at 4:15 - `last.end.equals(candidate.
// start)` is never true for these). That made this function effectively
// never fire, and the "top 3" came back as near-identical windows 15
// minutes apart instead of one merged block. Fixed by merging whenever the
// next candidate starts at or before the current merged block's end
// (overlapping OR touching, not just exactly touching) - safe to just
// extend `last.end` to `candidate.end` rather than max() the two, since
// every candidate has the same fixed duration and monotonically
// increasing start times, so a later start always means a later-or-equal
// end.
function mergeAdjacentCandidates(chronologicalCandidates) {
    const merged = [];
    chronologicalCandidates.forEach((candidate) => {
        const last = merged[merged.length - 1];
        if (
            last
            && candidate.start <= last.end
            && memberSetKey(last.missing) === memberSetKey(candidate.missing)
            && memberSetKey(last.ifNeeded) === memberSetKey(candidate.ifNeeded)
        ) {
            last.end = candidate.end;
        } else {
            merged.push({ ...candidate });
        }
    });
    return merged;
}

// members: [{ uid, name, timezone, weekdaySlots, hasBeenPainted }]. Returns
// up to 3 ranked windows: { start, end (Luxon DateTime, UTC), missing:
// [member], ifNeeded: [member] }, fewest missing first, then fewest
// if-needed compromises, then earliest.
//
// Members who have never painted anything (hasBeenPainted !== true) are
// excluded from scoring entirely - a real gap found in peer review: every
// unpainted slot defaults to 'busy' (the safe default for someone who HAS
// painted but left a slot untouched), but applying that same default to
// someone who hasn't engaged with the feature at all made every single
// recommendation read as "1 missing" for any group with a new member,
// which is misleading rather than informative. Excluded members aren't
// returned in `missing`/`ifNeeded` at all - a caller that wants to note
// "N people haven't set their availability yet" should check
// members.filter(m => !m.hasBeenPainted) separately.
//
// options.rollingWindow = { startUtc, days }: search the real next `days`
// days from startUtc (see buildUtcTimelineForRollingWindow) instead of the
// weekAnchor week. hourRange/weekAnchor are ignored in that mode, and
// weekdaySlots must be the full 96-slot days.
// options.rollingWindow.viewHourRange (optional): the group's usual meeting
// hours. A window that falls outside ANY scorable member's usual hours (in
// their own zone) is never suggested at all - so every member listed in
// `missing` really did mark themselves busy, and "is busy" is honest.
function findBestMeetingTimes(members, meetingLengthMinutes, hourRange, weekAnchor, options = {}) {
    const scorableMembers = members.filter((member) => member.hasBeenPainted);
    const timeline = options.rollingWindow
        ? buildUtcTimelineForRollingWindow(
            scorableMembers,
            options.rollingWindow.startUtc,
            options.rollingWindow.days,
            options.rollingWindow.viewHourRange || null
        )
        : buildUtcTimeline(scorableMembers, hourRange, weekAnchor);
    const sortedKeys = Array.from(timeline.keys()).sort();
    const slotsNeeded = meetingLengthMinutes / SLOT_MINUTES;

    const chronologicalCandidates = [];
    for (let i = 0; i + slotsNeeded <= sortedKeys.length; i += 1) {
        const windowKeys = sortedKeys.slice(i, i + slotsNeeded);
        const start = luxon.DateTime.fromISO(windowKeys[0], { zone: 'utc' });
        const end = start.plus({ minutes: meetingLengthMinutes });
        // The timeline can have gaps (e.g. different members painting
        // different hour ranges, or a member with no data at all for some
        // slots) - a window is only valid if its slots are truly
        // back-to-back, not just N keys that happen to sort together.
        const lastSlotEnd = luxon.DateTime.fromISO(windowKeys[windowKeys.length - 1], { zone: 'utc' })
            .plus({ minutes: SLOT_MINUTES });
        if (!lastSlotEnd.equals(end)) {
            continue;
        }

        const missing = [];
        const ifNeeded = [];
        let outsideSomeonesHours = false;
        scorableMembers.forEach((member) => {
            const statuses = windowKeys.map((key) => (timeline.get(key) || new Map()).get(member.uid) || 'B');
            if (statuses.includes(OUTSIDE_HOURS_VALUE)) {
                outsideSomeonesHours = true;
            } else if (statuses.includes('B')) {
                missing.push(member);
            } else if (statuses.includes('I')) {
                ifNeeded.push(member);
            }
        });
        // Skipped, not scored: this also breaks merging correctly, since a
        // later window only merges if it starts at or before the last kept
        // window's end, and every slot of both is inside everyone's hours.
        if (outsideSomeonesHours) {
            continue;
        }

        chronologicalCandidates.push({ start, end, missing, ifNeeded });
    }

    // A window nobody can make isn't a recommendation - without this, the
    // all-busy stretches around a free block fill out the "top 3".
    const ranked = mergeAdjacentCandidates(chronologicalCandidates)
        .filter((candidate) => candidate.missing.length < scorableMembers.length)
        .sort((a, b) => {
            if (a.missing.length !== b.missing.length) {
                return a.missing.length - b.missing.length;
            }
            if (a.ifNeeded.length !== b.ifNeeded.length) {
                return a.ifNeeded.length - b.ifNeeded.length;
            }
            return a.start.toMillis() - b.start.toMillis();
        });

    return ranked.slice(0, 3);
}
