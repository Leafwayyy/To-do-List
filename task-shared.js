// Task vocabulary and pure display/ID logic shared by the solo app
// (script.js) and the group app (group/group.js). Defined once, here, and
// loaded by both pages before their own script - so "how a matrix badge is
// labeled" or "when a deadline counts as critical" can never drift between
// the two surfaces the way it did when the group side was a separate React
// rewrite of the same rules.
//
// Classic script (not a module) on purpose, so both index.html and
// group/index.html can load it with a plain <script> tag and every name
// below just becomes available as a global, exactly like the rest of
// script.js already works.

const MATRIX_CONFIG = {
    do: { label: 'Do', rank: 4, className: 'matrix-do' },
    schedule: { label: 'Schedule', rank: 3, className: 'matrix-schedule' },
    delegate: { label: 'Delegate', rank: 2, className: 'matrix-delegate' },
    eliminate: { label: 'Eliminate', rank: 1, className: 'matrix-eliminate' }
};

const DIFFICULTY_CONFIG = {
    1: { label: 'Very Easy', rank: 1 },
    2: { label: 'Easy', rank: 2 },
    3: { label: 'Medium', rank: 3 },
    4: { label: 'Hard', rank: 4 },
    5: { label: 'Very Hard', rank: 5 }
};

function getValidMatrixValue(value) {
    return Object.prototype.hasOwnProperty.call(MATRIX_CONFIG, value) ? value : 'do';
}

const TASK_TYPE_CONFIG = {
    timeboxed: { label: 'Estimate time', rank: 2 },
    open: { label: 'No time estimate', rank: 1 }
};

function getValidTaskType(value) {
    return Object.prototype.hasOwnProperty.call(TASK_TYPE_CONFIG, value) ? value : 'open';
}

function parseDurationMinutes(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return null;
    }

    return Math.round(parsed);
}

function getEffortLabel(task) {
    const taskType = getValidTaskType(task.taskType);
    if (taskType === 'timeboxed') {
        const minutes = task.estimateMinutes || 0;
        return minutes > 0 ? `Est. ${minutes}m` : 'Estimate time';
    }
    return 'No estimate';
}

function getValidDifficultyLevel(value) {
    const parsed = Number(value);
    const normalized = Number.isFinite(parsed) ? Math.round(parsed) : 3;
    return Object.prototype.hasOwnProperty.call(DIFFICULTY_CONFIG, normalized) ? normalized : 3;
}

function getDifficultyLabel(level) {
    const normalizedLevel = getValidDifficultyLevel(level);
    const difficulty = DIFFICULTY_CONFIG[normalizedLevel];
    return `D${normalizedLevel} (${difficulty.label})`;
}

// Rough hours-to-complete per difficulty rank (Very Easy..Very Hard), used
// only as a fallback when a task has no explicit time estimate - most
// tasks never get one, and "how long will this actually take" is exactly
// the signal getPriorityScore/getGroupPriorityScore need to tell whether a
// deadline still has comfortable room or is genuinely tight, instead of
// treating difficulty as urgency all on its own regardless of how much
// time is actually left.
const DIFFICULTY_DEFAULT_EFFORT_HOURS = [0.25, 0.5, 1, 2, 4];

function getEstimatedEffortHours(task) {
    if (getValidTaskType(task.taskType) === 'timeboxed' && task.estimateMinutes) {
        return Math.max(0.1, Number(task.estimateMinutes) / 60);
    }
    const rank = DIFFICULTY_CONFIG[getValidDifficultyLevel(task.difficulty)].rank;
    return DIFFICULTY_DEFAULT_EFFORT_HOURS[rank - 1];
}

function isValidDateValue(value) {
    if (!value) {
        return false;
    }

    const parsedDate = new Date(value);
    return !Number.isNaN(parsedDate.getTime());
}

// Recurrence: a repeating task advances IN PLACE (same doc/id) rather than
// spawning a new task per occurrence - one doc per conceptual recurring
// task, so activity history/heatmap/leaderboard counts (which already
// assume one doc per task) need no special handling, and existing signals
// like snooze-based stall detection reset cleanly each cycle instead of
// accumulating across occurrences that were never actually a problem.
// Kept as a plain string field (like matrix/taskType), not an object -
// v1 is fixed daily/weekly/monthly, no custom interval yet.
const RECURRENCE_OPTIONS = [
    { value: '', label: 'Does not repeat' },
    { value: 'daily', label: 'Daily' },
    { value: 'weekly', label: 'Weekly' },
    { value: 'monthly', label: 'Monthly' }
];

function getValidRecurrenceValue(value) {
    return RECURRENCE_OPTIONS.some((option) => option.value === value && option.value !== '') ? value : null;
}

function getRecurrenceLabel(value) {
    const match = RECURRENCE_OPTIONS.find((option) => option.value === value);
    return match ? match.label : 'Does not repeat';
}

// Adds one recurrence interval to a date, anchored to the task's OWN due
// date (not "today"), so a task due every Monday keeps landing on Monday
// even if it happens to get completed early or late. Monthly clamps to
// the target month's real last day instead of letting a naive setMonth
// silently roll over into the month after (Jan 31 + 1 month would
// otherwise land on Mar 2/3, skipping February entirely).
function getNextRecurrenceDueAt(currentDueAtIso, frequency) {
    const validFrequency = getValidRecurrenceValue(frequency);
    if (!validFrequency) {
        return null;
    }
    const base = currentDueAtIso && isValidDateValue(currentDueAtIso) ? new Date(currentDueAtIso) : new Date();
    const next = new Date(base.getTime());

    if (validFrequency === 'daily') {
        next.setDate(next.getDate() + 1);
    } else if (validFrequency === 'weekly') {
        next.setDate(next.getDate() + 7);
    } else if (validFrequency === 'monthly') {
        const originalDay = next.getDate();
        const targetMonthIndex = next.getMonth() + 1;
        next.setDate(1); // avoid overflow while stepping the month itself
        next.setMonth(targetMonthIndex);
        const lastDayOfTargetMonth = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
        next.setDate(Math.min(originalDay, lastDayOfTargetMonth));
    }
    return next.toISOString();
}

function getDeadlineStatus(dueAt) {
    if (!dueAt || !isValidDateValue(dueAt)) {
        return {
            hasDeadline: false,
            isOverdue: false,
            deadlineTimestamp: Number.MAX_SAFE_INTEGER,
            timeUntilMs: Number.MAX_SAFE_INTEGER,
            urgencyLevel: 'normal',
            deadlineLabel: 'No deadline',
            deadlineClassName: 'deadline-none',
            countdownLabel: 'No timer',
            countdownClassName: 'countdown-none'
        };
    }

    const deadlineDate = new Date(dueAt);
    const now = Date.now();
    const deadlineTimestamp = deadlineDate.getTime();
    const distance = deadlineTimestamp - now;
    const absoluteDistance = Math.abs(distance);

    const days = Math.floor(absoluteDistance / 86400000);
    const hours = Math.floor((absoluteDistance % 86400000) / 3600000);
    const minutes = Math.floor((absoluteDistance % 3600000) / 60000);
    const seconds = Math.floor((absoluteDistance % 60000) / 1000);
    // Under an hour, seconds matter more than the d/h/m breakdown - shows
    // "12m 34s" (and keeps ticking down second by second) instead of being
    // stuck on "0d 0h 12m" for up to 59 seconds at a time.
    const compactTime = (days > 0 || hours > 0)
        ? `${days}d ${hours}h ${minutes}m`
        : `${minutes}m ${seconds}s`;

    const deadlineLabel = `Due ${deadlineDate.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
    })}`;

    if (distance < 0) {
        return {
            hasDeadline: true,
            isOverdue: true,
            deadlineTimestamp,
            timeUntilMs: distance,
            urgencyLevel: 'overdue',
            deadlineLabel,
            deadlineClassName: 'deadline-overdue',
            countdownLabel: `Overdue by ${compactTime}`,
            countdownClassName: 'countdown-overdue'
        };
    }

    if (distance <= 1800000) {
        return {
            hasDeadline: true,
            isOverdue: false,
            deadlineTimestamp,
            timeUntilMs: distance,
            urgencyLevel: 'critical',
            deadlineLabel,
            deadlineClassName: 'deadline-critical',
            countdownLabel: `${compactTime} left`,
            countdownClassName: 'countdown-critical'
        };
    }

    if (distance <= 7200000) {
        return {
            hasDeadline: true,
            isOverdue: false,
            deadlineTimestamp,
            timeUntilMs: distance,
            urgencyLevel: 'soon',
            deadlineLabel,
            deadlineClassName: 'deadline-soon',
            countdownLabel: `${compactTime} left`,
            countdownClassName: 'countdown-soon'
        };
    }

    if (distance <= 86400000) {
        return {
            hasDeadline: true,
            isOverdue: false,
            deadlineTimestamp,
            timeUntilMs: distance,
            urgencyLevel: 'normal',
            deadlineLabel,
            deadlineClassName: 'deadline-soon',
            countdownLabel: `${compactTime} left`,
            countdownClassName: 'countdown-soon'
        };
    }

    return {
        hasDeadline: true,
        isOverdue: false,
        deadlineTimestamp,
        timeUntilMs: distance,
        urgencyLevel: 'normal',
        deadlineLabel,
        deadlineClassName: 'deadline-normal',
        countdownLabel: `${compactTime} left`,
        countdownClassName: 'countdown-normal'
    };
}

// A completed task always displays as "no deadline pressure" regardless of
// what dueAt still says, whether it's a solo task or a group task.
function getTaskDisplayDeadlineStatus(task) {
    if (task.completed) {
        return {
            hasDeadline: false,
            isOverdue: false,
            deadlineTimestamp: Number.MAX_SAFE_INTEGER,
            timeUntilMs: Number.MAX_SAFE_INTEGER,
            urgencyLevel: 'normal',
            deadlineLabel: 'Completed',
            deadlineClassName: 'deadline-none',
            countdownLabel: 'Timer stopped',
            countdownClassName: 'countdown-none'
        };
    }

    return getDeadlineStatus(task.dueAt);
}

// The nearest deadline that should actually drive urgency for this task
// right now: either the task's own dueAt, or an incomplete step's dueAt,
// whichever is sooner. A completed step's deadline no longer counts - it's
// done. null only when neither the task nor any incomplete step has one.
// Returns { dueAt, fromStepId } rather than a bare string so callers can
// tell whether the date came from a step (and phrase the countdown
// accordingly) or from the task's own deadline.
function getEffectiveDueAt(task) {
    const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];
    let best = null; // { time, fromStepId }

    subtasks.forEach((subtask) => {
        if (subtask.completed || !subtask.dueAt || !isValidDateValue(subtask.dueAt)) {
            return;
        }
        const time = new Date(subtask.dueAt).getTime();
        if (!best || time < best.time) {
            best = { time, fromStepId: subtask.id };
        }
    });

    if (task.dueAt && isValidDateValue(task.dueAt)) {
        const time = new Date(task.dueAt).getTime();
        if (!best || time < best.time) {
            best = { time, fromStepId: null };
        }
    }

    if (!best) {
        return { dueAt: null, fromStepId: null };
    }
    return { dueAt: new Date(best.time).toISOString(), fromStepId: best.fromStepId };
}

// Like getTaskDisplayDeadlineStatus, but for URGENCY (sort order, the
// countdown badge, the status-* row class) rather than the literal "Due
// <date>" label - resolves against getEffectiveDueAt instead of the task's
// own dueAt alone, so a task that isn't due for weeks still rises when one
// of its steps needs to happen soon. fromStep on the returned object is the
// id of whichever step supplied the date, or null when it was the task's
// own deadline (or there's no deadline pressure at all) - callers use this
// to phrase the countdown as "Next step: ..." instead of a plain countdown,
// so it never reads as the task's own final deadline having moved.
function getTaskUrgencyStatus(task) {
    if (task.completed) {
        return {
            hasDeadline: false,
            isOverdue: false,
            deadlineTimestamp: Number.MAX_SAFE_INTEGER,
            timeUntilMs: Number.MAX_SAFE_INTEGER,
            urgencyLevel: 'normal',
            deadlineLabel: 'Completed',
            deadlineClassName: 'deadline-none',
            countdownLabel: 'Timer stopped',
            countdownClassName: 'countdown-none',
            fromStep: null
        };
    }

    const { dueAt, fromStepId } = getEffectiveDueAt(task);
    const status = getDeadlineStatus(dueAt);
    if (fromStepId && status.hasDeadline) {
        return { ...status, countdownLabel: `Next step: ${status.countdownLabel}`, fromStep: fromStepId };
    }
    return { ...status, fromStep: null };
}

// Deadline/schedule preset shortcuts ("in 2 hours", "end of day", "tomorrow
// morning"...) - shared by the deadline preset chips, the schedule preset
// chips, and quick-add parsing below.
function computePresetDate(preset, baseDate = new Date()) {
    const result = new Date(baseDate);

    switch (preset) {
        case 'hour2': {
            result.setMinutes(0, 0, 0);
            result.setHours(result.getHours() + 2);
            return result;
        }
        case 'hour6': {
            result.setMinutes(0, 0, 0);
            result.setHours(result.getHours() + 6);
            return result;
        }
        case 'eod': {
            result.setHours(23, 0, 0, 0);
            return result;
        }
        case 'tomorrow':
        case 'tomorrowMorning': {
            result.setDate(result.getDate() + 1);
            result.setHours(9, 0, 0, 0);
            return result;
        }
        case 'plus3days': {
            result.setDate(result.getDate() + 3);
            result.setHours(9, 0, 0, 0);
            return result;
        }
        case 'nextweek': {
            result.setDate(result.getDate() + 7);
            result.setHours(9, 0, 0, 0);
            return result;
        }
        case 'morning': {
            result.setHours(9, 0, 0, 0);
            return result;
        }
        case 'afternoon': {
            result.setHours(13, 0, 0, 0);
            return result;
        }
        case 'evening': {
            result.setHours(18, 0, 0, 0);
            return result;
        }
        case 'clear':
        default:
            return null;
    }
}

const QUICK_ADD_WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// Fixed-vocabulary date/time parsing for the quick-add input (not general
// NLP). Finds at most one day phrase and one time-of-day phrase, strips them
// out of the text, and returns the resulting deadline. dueAt is null when
// nothing recognizable was found, in which case cleanedText === rawText.
function parseQuickAddPhrase(rawText, now = new Date()) {
    let text = rawText;

    const relativeMatch = text.match(/\bin\s+(\d+)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?)\b/i);
    if (relativeMatch) {
        const amount = parseInt(relativeMatch[1], 10);
        const unit = relativeMatch[2].toLowerCase();
        const result = new Date(now);
        if (unit.startsWith('min')) {
            result.setMinutes(result.getMinutes() + amount);
        } else if (unit.startsWith('hour') || unit.startsWith('hr')) {
            result.setHours(result.getHours() + amount);
        } else if (unit.startsWith('week')) {
            result.setDate(result.getDate() + (amount * 7));
        } else {
            result.setDate(result.getDate() + amount);
        }
        return { cleanedText: stripQuickAddMatch(text, relativeMatch[0]), dueAt: result };
    }

    const eodMatch = text.match(/\b(eod|end of day)\b/i);
    if (eodMatch) {
        return { cleanedText: stripQuickAddMatch(text, eodMatch[0]), dueAt: computePresetDate('eod', now) };
    }

    let dayDate = null;
    let defaultHour = 9;
    let dayMatchText = null;

    const tonightMatch = text.match(/\btonight\b/i);
    const tomorrowMatch = !tonightMatch && text.match(/\b(tomorrow|tmrw)\b/i);
    const todayMatch = !tonightMatch && !tomorrowMatch && text.match(/\btoday\b/i);
    const nextWeekdayMatch = !tonightMatch && !tomorrowMatch && !todayMatch
        && text.match(/\bnext\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
    const bareWeekdayMatch = !tonightMatch && !tomorrowMatch && !todayMatch && !nextWeekdayMatch
        && text.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);

    if (tonightMatch) {
        dayDate = new Date(now);
        defaultHour = 20;
        dayMatchText = tonightMatch[0];
    } else if (tomorrowMatch) {
        dayDate = new Date(now);
        dayDate.setDate(dayDate.getDate() + 1);
        dayMatchText = tomorrowMatch[0];
    } else if (todayMatch) {
        dayDate = new Date(now);
        dayMatchText = todayMatch[0];
    } else if (nextWeekdayMatch) {
        dayDate = getNextQuickAddWeekday(now, nextWeekdayMatch[1].toLowerCase());
        dayMatchText = nextWeekdayMatch[0];
    } else if (bareWeekdayMatch) {
        dayDate = getNextQuickAddWeekday(now, bareWeekdayMatch[0].toLowerCase());
        dayMatchText = bareWeekdayMatch[0];
    }

    if (dayMatchText) {
        text = stripQuickAddMatch(text, dayMatchText);
    }

    const timeMatch = text.match(/\b(?:at\s+)?(\d{1,2})(?::([0-5]\d))?\s*(am|pm)\b/i)
        || text.match(/\bnoon\b/i)
        || text.match(/\bmidnight\b/i);

    if (!dayDate && !timeMatch) {
        return { cleanedText: rawText, dueAt: null };
    }

    const result = dayDate ? new Date(dayDate) : new Date(now);
    result.setSeconds(0, 0);

    if (timeMatch) {
        const parsedTime = parseQuickAddTimeMatch(timeMatch);
        result.setHours(parsedTime.hours, parsedTime.minutes, 0, 0);
        text = stripQuickAddMatch(text, timeMatch[0]);

        if (!dayDate && result.getTime() <= now.getTime()) {
            // A bare time with no day phrase that's already passed today rolls to tomorrow.
            result.setDate(result.getDate() + 1);
        }
    } else {
        result.setHours(defaultHour, 0, 0, 0);
    }

    return { cleanedText: text.trim().replace(/\s{2,}/g, ' '), dueAt: result };
}

function stripQuickAddMatch(text, matchedText) {
    return text.replace(matchedText, '').trim().replace(/\s{2,}/g, ' ');
}

function parseQuickAddTimeMatch(match) {
    if (/noon/i.test(match[0])) {
        return { hours: 12, minutes: 0 };
    }
    if (/midnight/i.test(match[0])) {
        return { hours: 0, minutes: 0 };
    }

    let hours = parseInt(match[1], 10) % 12;
    const minutes = match[2] ? parseInt(match[2], 10) : 0;
    if (/pm/i.test(match[3])) {
        hours += 12;
    }
    return { hours, minutes };
}

function getNextQuickAddWeekday(now, weekdayName) {
    const targetIndex = QUICK_ADD_WEEKDAYS.indexOf(weekdayName);
    if (targetIndex < 0) {
        return new Date(now);
    }

    const result = new Date(now);
    let daysAhead = (targetIndex - result.getDay() + 7) % 7;
    if (daysAhead === 0) {
        // Naming today's own weekday (rather than saying "today") means next week.
        daysAhead = 7;
    }
    result.setDate(result.getDate() + daysAhead);
    return result;
}

// Shared "human" date/time label used by the quick-add preview and the
// schedule badge - "Today 3:00 PM" / "Tomorrow 9:00 AM" / "Wed 2:00 PM" /
// falls back to an absolute date further out.
function formatFriendlyDateTime(date, now = new Date()) {
    const timeLabel = date.toLocaleString([], { hour: 'numeric', minute: '2-digit' });

    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const startOfTarget = new Date(date);
    startOfTarget.setHours(0, 0, 0, 0);
    const dayDiff = Math.round((startOfTarget - startOfToday) / 86400000);

    if (dayDiff === 0) {
        return `Today ${timeLabel}`;
    }
    if (dayDiff === 1) {
        return `Tomorrow ${timeLabel}`;
    }
    if (dayDiff > 1 && dayDiff < 7) {
        const weekdayLabel = date.toLocaleString([], { weekday: 'short' });
        return `${weekdayLabel} ${timeLabel}`;
    }

    const dateLabel = date.toLocaleString([], { month: 'short', day: 'numeric' });
    return `${dateLabel}, ${timeLabel}`;
}

function getScheduleLabel(scheduledAt) {
    if (!scheduledAt || !isValidDateValue(scheduledAt)) {
        return '';
    }
    return formatFriendlyDateTime(new Date(scheduledAt));
}

// Native <input type="number"> still lets someone type "-5" or "5e10" even
// with min="5" set (the min attribute only blocks form submission, not
// keystrokes) - strip anything that isn't a plain digit as they type, and
// block the keys that would produce a sign or exponent in the first place.
// Shared by solo's and group's estimated-minutes input.
function sanitizeNumberInputAsPositiveInteger(inputEl) {
    if (!inputEl) {
        return;
    }
    inputEl.addEventListener('keydown', (event) => {
        if (['e', 'E', '+', '-'].includes(event.key)) {
            event.preventDefault();
        }
    });
    inputEl.addEventListener('input', () => {
        const digitsOnly = inputEl.value.replace(/[^0-9]/g, '');
        if (digitsOnly !== inputEl.value) {
            inputEl.value = digitsOnly;
        }
    });
}

// Reward/celebration reel - shared by solo's milestone celebration and the
// group app's personal (not team-wide) one. Suggestions, reel geometry, and
// the tile factory are pure/generic; each page keeps its own trigger
// conditions and DOM overlay refs, since "what counts as a milestone"
// differs (solo's own full task list vs. one person's tasks in one group).
const REWARD_SUGGESTIONS = [
    { text: 'Take a 10-minute walk', icon: 'fa-person-walking' },
    { text: 'Grab your favorite snack', icon: 'fa-cookie-bite' },
    { text: 'Text a friend hello', icon: 'fa-comment' },
    { text: 'Stretch for 5 minutes', icon: 'fa-dumbbell' },
    { text: 'Watch one video guilt-free', icon: 'fa-clapperboard' },
    { text: 'Make a cup of tea or coffee', icon: 'fa-mug-hot' },
    { text: 'Step outside for fresh air', icon: 'fa-sun' },
    { text: 'Play one song you love', icon: 'fa-music' },
    { text: 'Do a quick tidy of your desk', icon: 'fa-broom' },
    { text: 'Take a proper screen break', icon: 'fa-eye' },
    { text: 'Do a 2-minute breathing exercise', icon: 'fa-wind' },
    { text: 'Journal for a few minutes', icon: 'fa-book' },
    { text: 'Pet your dog or cat', icon: 'fa-paw' },
    { text: 'Water your plants', icon: 'fa-seedling' },
    { text: 'Do 10 jumping jacks', icon: 'fa-person-running' },
    { text: 'Take a power nap', icon: 'fa-bed' },
    { text: 'Listen to a podcast episode', icon: 'fa-headphones' },
    { text: 'Doodle or sketch something', icon: 'fa-pencil' },
    { text: 'Look out a window for a minute', icon: 'fa-window-maximize' },
    { text: 'Splash cold water on your face', icon: 'fa-droplet' },
    { text: 'Eat a piece of fruit', icon: 'fa-apple-whole' },
    { text: 'Call a family member', icon: 'fa-phone' },
    { text: 'Read a few pages of a book', icon: 'fa-book-open' },
    { text: 'Do a quick puzzle or crossword', icon: 'fa-puzzle-piece' },
    { text: 'Tidy up one small space', icon: 'fa-box-open' },
    { text: 'Light a candle or diffuser', icon: 'fa-fire' },
    { text: 'Dance to one song', icon: 'fa-compact-disc' },
    { text: 'Play a quick mobile game', icon: 'fa-gamepad' },
    { text: 'Write down 3 things you’re grateful for', icon: 'fa-heart' },
    { text: 'Take a hot shower', icon: 'fa-shower' },
    { text: 'Do a quick skincare routine', icon: 'fa-spa' },
    { text: 'Refill your water bottle', icon: 'fa-bottle-water' },
    { text: 'Take the stairs a few times', icon: 'fa-stairs' },
    { text: 'Clear out your inbox for a bit', icon: 'fa-envelope' },
    { text: 'Watch the clouds for a minute', icon: 'fa-cloud' },
    { text: 'Give yourself a compliment', icon: 'fa-star' },
    { text: 'Try a quick stretch or yoga pose', icon: 'fa-child-reaching' },
    { text: 'Close out unused browser tabs', icon: 'fa-bookmark' },
    { text: 'Treat yourself to dessert', icon: 'fa-ice-cream' },
    { text: 'Do a quick mental check-in', icon: 'fa-brain' },
    { text: 'Send someone a thank-you note', icon: 'fa-envelope-open-text' },
    { text: 'Check the mailbox', icon: 'fa-inbox' },
    { text: 'Declutter one folder on your phone', icon: 'fa-mobile' },
    { text: 'Take 5 slow deep breaths', icon: 'fa-lungs' },
    { text: 'Look through old photos', icon: 'fa-images' },
    { text: 'Pick out tomorrow’s outfit', icon: 'fa-shirt' },
    { text: 'Jot down tomorrow’s first task', icon: 'fa-list-check' },
    { text: 'Enjoy a small treat', icon: 'fa-gift' },
    { text: 'Do a quick set of push-ups', icon: 'fa-heart-pulse' },
    { text: 'Sit in silence for a minute', icon: 'fa-om' }
];

// Reel geometry for the case-opening-style spin (kept in sync with the
// .rewardTile / .rewardReelTrack CSS in style.css: tile width + gap).
const REEL_TILE_WIDTH = 108;
const REEL_TILE_GAP = 10;
const REEL_TILE_STEP = REEL_TILE_WIDTH + REEL_TILE_GAP;
const REEL_FILLER_COUNT = 46;
const REEL_LANDING_INDEX = REEL_FILLER_COUNT - 5;

function createRewardTile(reward) {
    const tile = document.createElement('div');
    const tier = 1 + Math.floor(Math.random() * 4);
    tile.classList.add('rewardTile', `rewardTile-tier-${tier}`);
    tile.innerHTML = `<i class="fa-solid ${reward.icon}"></i><span>${reward.text}</span>`;
    return tile;
}

function getDateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// Sound effects - shared by solo and group so both play the exact same
// clips. task-shared.js is always the same physical file at the repo root
// regardless of whether the page loading it is at the root (index.html) or
// one directory down (group/index.html, group/browse.html), so the mp3s
// are resolved relative to *this script's own* URL (via document.currentScript,
// captured synchronously here before any later async code could clear it),
// not the page's - a plain relative path would mean two different places
// depending on which page loaded it, and a leading "/" would break entirely
// once the site is served from a subpath (e.g. github.io/repo-name/) rather
// than a domain root.
const TASK_SHARED_SCRIPT_URL = document.currentScript?.src || window.location.href;

const clickAudio = new Audio(new URL('Button Click SFX.mp3', TASK_SHARED_SCRIPT_URL).href);
clickAudio.preload = 'auto';

const taskCompleteAudio = new Audio(new URL('Goal SFX.mp3', TASK_SHARED_SCRIPT_URL).href);
taskCompleteAudio.preload = 'auto';

// Read fresh on every play (not cached) so the Settings panel's mute
// toggle takes effect immediately without needing to notify this file.
const SOUND_MUTED_KEY = 'todoSoundMutedV1';
function isSoundMuted() {
    try {
        return localStorage.getItem(SOUND_MUTED_KEY) === 'true';
    } catch (error) {
        return false;
    }
}

function playClickSound() {
    if (isSoundMuted()) {
        return;
    }
    clickAudio.currentTime = 0;
    clickAudio.play();
}

function playTaskCompleteSound() {
    if (isSoundMuted()) {
        return;
    }
    taskCompleteAudio.currentTime = 0;
    taskCompleteAudio.play();
}

// A separate Audio element (not the shared clickAudio) so rapid reel ticks
// don't fight with an ordinary button click the user makes elsewhere while
// the reel is still spinning.
const reelTickAudio = new Audio(new URL('Button Click SFX.mp3', TASK_SHARED_SCRIPT_URL).href);
reelTickAudio.preload = 'auto';

function playReelTickSound() {
    if (isSoundMuted()) {
        return;
    }
    reelTickAudio.currentTime = 0;
    reelTickAudio.play();
}

// Rolling sound for the reward reel spin - rather than assuming the CSS
// easing curve, this samples the track's actual on-screen position every
// frame and fires one tick each time it crosses a full tile width. That
// makes the ticking automatically fast at the start and taper off exactly
// as the reel visually slows down, in sync with whatever's really
// rendered, not a guess at the timing. Returns a stop() function the
// caller must call both on normal spin-end and on any early interruption
// (closing the overlay mid-spin), or the sampling loop runs forever.
function startRewardReelTicking(track, tileStepPx) {
    let lastTileCount = 0;
    let rafId = null;
    let stopped = false;

    function readTranslateXPx() {
        const transform = getComputedStyle(track).transform;
        if (!transform || transform === 'none') {
            return 0;
        }
        const match = transform.match(/matrix\(([^)]+)\)/);
        if (!match) {
            return 0;
        }
        const parts = match[1].split(',').map((value) => parseFloat(value.trim()));
        return Math.abs(parts[4] || 0);
    }

    function frame() {
        if (stopped) {
            return;
        }
        const tileCount = Math.floor(readTranslateXPx() / tileStepPx);
        if (tileCount > lastTileCount) {
            lastTileCount = tileCount;
            playReelTickSound();
        }
        rafId = requestAnimationFrame(frame);
    }

    rafId = requestAnimationFrame(frame);

    return function stop() {
        stopped = true;
        if (rafId !== null) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }
    };
}

// Guided-tour engine - shared by solo's tutorial and the group workspace's
// own tutorial, since both use the exact same overlay markup
// (.tourOverlay/.tourCard/.tourStepLabel/.tourTitle/.tourText/.tourSkipBtn/
// .tourNextBtn - see the tourOverlay block in each page's HTML) and the
// exact same step-through/highlight/reposition mechanics. Each page creates
// its own controller with its own step list and its own localStorage key,
// so solo's and group's tour progress are tracked independently.
//
// steps: [{ selector, title, text, beforeShow?(), isRelevant?(), action? }].
// beforeShow runs right before that step's target is looked up (e.g. to
// open a collapsed panel the target lives inside). onStart (optional):
// called right as the tour opens, e.g. to hide a page's separate passive
// "quick start" hint card so it doesn't sit underneath/behind the modal
// for the whole tour.
//
// action (optional): { event: 'click' | 'change' | 'input', validate?(target) }
// - makes a step genuinely interactive instead of a slideshow. The Next
// button still always works (never taken away - a real fallback for anyone
// who can't or doesn't want to perform the exact action), but doing the
// real thing on the real element - clicking it, changing it, typing into
// it - is what the step is actually asking for, and doing it gives a brief
// "Nice, that's it" confirmation (checkmark, glowing ring) rather than
// silently doing nothing. It does NOT auto-advance except on the tour's
// very last step (see armActionListener) - it used to, on every gated
// step, but that meant a typing step yanked you forward on the very first
// keystroke, mid-word, before you'd finished. Confirming and then waiting
// for you to hit Next yourself keeps you in control of when a step is
// actually done. validate, when given, is checked every time the event
// fires and the step keeps waiting until it returns true - e.g. an
// 'input' step requiring real non-whitespace text, not just an empty
// keystroke. Only steps whose action is low-friction and non-destructive/
// non-navigating ever set this (see TOUR_STEPS/GROUP_TOUR_STEPS for which)
// - anything that would change a real setting or navigate away stays
// informational-only.
function createTourController({ steps, storageKey, onEnd, onStart }) {
    const tourOverlay = document.querySelector('.tourOverlay');
    const tourCard = document.querySelector('.tourCard');
    const tourDustyAvatar = document.querySelector('.tourDustyAvatar');
    const tourStepLabel = document.querySelector('.tourStepLabel');
    const tourTitle = document.querySelector('.tourTitle');
    const tourText = document.querySelector('.tourText');
    const tourActionHint = document.querySelector('.tourActionHint');
    const tourActionConfirmed = document.querySelector('.tourActionConfirmed');
    const tourSkipBtn = document.querySelector('.tourSkipBtn');
    const tourNextBtn = document.querySelector('.tourNextBtn');
    const tourCurtainTop = document.querySelector('.tourCurtainTop');
    const tourCurtainBottom = document.querySelector('.tourCurtainBottom');
    const tourCurtainLeft = document.querySelector('.tourCurtainLeft');
    const tourCurtainRight = document.querySelector('.tourCurtainRight');

    // Dusty's portrait, built once - buildDustyAvatarMarkup is defined in
    // brain-dump.js, which loads before whichever page-specific script
    // actually calls createTourController, so this is safe despite
    // task-shared.js itself loading first; guarded anyway in case that
    // ever changes, so a missing avatar never breaks the tour itself.
    if (tourDustyAvatar && typeof buildDustyAvatarMarkup === 'function') {
        tourDustyAvatar.innerHTML = buildDustyAvatarMarkup(32);
    }

    let activeStepIndex = -1;
    let highlightedElement = null;
    let pendingActionCleanup = null;
    let advanceTimeoutId = null;

    function isOpen() {
        return Boolean(tourOverlay && !tourOverlay.classList.contains('hidden'));
    }

    function hasBeenSeen() {
        const state = localStorage.getItem(storageKey);
        return state === 'dismissed' || state === 'tour-completed';
    }

    function positionCard() {
        if (!isOpen() || !tourCard || !highlightedElement) {
            return;
        }

        const targetRect = highlightedElement.getBoundingClientRect();
        const cardRect = tourCard.getBoundingClientRect();
        const spacing = 12;

        const centeredLeft = Math.max(12, Math.min(window.innerWidth - cardRect.width - 12, targetRect.left + ((targetRect.width - cardRect.width) / 2)));
        const belowTop = targetRect.bottom + spacing;
        const aboveTop = targetRect.top - cardRect.height - spacing;
        const top = belowTop + cardRect.height <= window.innerHeight - 10
            ? belowTop
            : Math.max(10, aboveTop);

        tourCard.style.left = `${centeredLeft}px`;
        tourCard.style.top = `${top}px`;
    }

    // The real fix for "the highlighted thing is dark and I can't click
    // it" - 4 curtain panels tiled around the target's live rect (a small
    // padding outside it) so the target itself sits in a genuine gap with
    // nothing painted over it, rather than trying to out-z-index an
    // overlay that a nested stacking context (.container's own position+
    // z-index) was silently defeating anyway. Recomputed on every step
    // change, resize, and scroll, same triggers positionCard already uses.
    function positionCurtains() {
        if (!tourCurtainTop || !tourCurtainBottom || !tourCurtainLeft || !tourCurtainRight) {
            return;
        }
        if (!isOpen() || !highlightedElement) {
            [tourCurtainTop, tourCurtainBottom, tourCurtainLeft, tourCurtainRight].forEach((el) => {
                el.style.width = '0px';
                el.style.height = '0px';
            });
            return;
        }

        const rect = highlightedElement.getBoundingClientRect();
        const pad = 8;
        const top = Math.max(0, rect.top - pad);
        const left = Math.max(0, rect.left - pad);
        const right = Math.min(window.innerWidth, rect.right + pad);
        const bottom = Math.min(window.innerHeight, rect.bottom + pad);

        Object.assign(tourCurtainTop.style, { left: '0px', top: '0px', width: '100%', height: `${top}px` });
        Object.assign(tourCurtainBottom.style, { left: '0px', top: `${bottom}px`, width: '100%', height: `${Math.max(0, window.innerHeight - bottom)}px` });
        Object.assign(tourCurtainLeft.style, { left: '0px', top: `${top}px`, width: `${left}px`, height: `${Math.max(0, bottom - top)}px` });
        Object.assign(tourCurtainRight.style, { left: `${right}px`, top: `${top}px`, width: `${Math.max(0, window.innerWidth - right)}px`, height: `${Math.max(0, bottom - top)}px` });
    }

    function repositionOverlay() {
        positionCard();
        positionCurtains();
    }

    // Clears whatever the PREVIOUS step set up - the real event listener
    // waiting for an action, and/or a pending auto-advance timeout - so
    // leaving a step early (Next clicked instead, or the tour ends) never
    // leaves a stale listener that could fire later on a completely
    // different step, or a double-advance race between the action firing
    // and Next being clicked around the same moment.
    function clearPendingAction() {
        pendingActionCleanup?.();
        pendingActionCleanup = null;
        clearTimeout(advanceTimeoutId);
        advanceTimeoutId = null;
        tourActionHint?.classList.add('hidden');
        tourActionConfirmed?.classList.add('hidden');
    }

    function armActionListener(step, target, stepIndex) {
        if (!step.action) {
            return;
        }
        tourActionHint?.classList.remove('hidden');

        const eventName = step.action.event || 'click';
        // The last step's action (tapping Dusty himself) opens the real
        // chat panel underneath - that overlay sits at a lower z-index
        // than the tour's own darkened backdrop, so lingering on the usual
        // confirmation pause here would visibly dim the chat he just
        // opened for most of a second. Ending almost immediately instead
        // means the tour gets out of the way right as the real thing takes
        // over, rather than the confirmation flash competing with it.
        //
        // Every OTHER step used to auto-advance too, on a fixed delay after
        // firing - real bug, reported live: on a typing step that delay ran
        // from the very first keystroke, so it yanked you to the next step
        // mid-word before you'd finished typing your actual task. Now
        // firing just confirms (checkmark, glowing ring) and leaves Next
        // for you to hit whenever you're actually done - typing, or just
        // re-reading what you did - matching Dusty's own copy on the
        // confirmation line below.
        const isLastStep = stepIndex === steps.length - 1;
        let fired = false;
        const handler = () => {
            if (fired) {
                return;
            }
            // Some actions (typing real text, not just any keystroke) need
            // more than "the event fired" - step.action.validate lets a
            // step check the target's actual state and keep waiting until
            // it's genuinely met, e.g. the add-a-task step requires real
            // non-whitespace text, not just an empty input event.
            if (step.action.validate && !step.action.validate(target)) {
                return;
            }
            fired = true;
            tourActionHint?.classList.add('hidden');
            tourActionConfirmed?.classList.remove('hidden');
            target.classList.add('tourTargetConfirmed');
            if (isLastStep) {
                advanceTimeoutId = setTimeout(goToNextStep, 60);
            }
        };
        target.addEventListener(eventName, handler);
        pendingActionCleanup = () => target.removeEventListener(eventName, handler);
    }

    function prepareStep(stepIndex) {
        const step = steps[stepIndex];
        if (!step) {
            return false;
        }

        // A step's target can be legitimately present-but-hidden (e.g.
        // group's "Whose tasks" tabs, hidden for a solo group) rather than
        // absent from the DOM entirely - querySelector alone can't tell the
        // difference, so a step that only matters sometimes declares that
        // itself via isRelevant() and gets skipped here instead of getting
        // highlighted/scrolled-to while invisible. Steps that don't set it
        // (every existing solo/group step) are always relevant, unchanged.
        if (step.isRelevant && !step.isRelevant()) {
            return false;
        }

        step.beforeShow?.();

        const target = document.querySelector(step.selector);
        if (!target) {
            return false;
        }

        clearPendingAction();
        if (highlightedElement) {
            highlightedElement.classList.remove('tourTarget', 'tourTargetConfirmed');
        }

        activeStepIndex = stepIndex;
        highlightedElement = target;
        highlightedElement.classList.add('tourTarget');

        tourStepLabel.textContent = `Step ${stepIndex + 1} of ${steps.length}`;
        tourTitle.textContent = step.title;
        tourText.textContent = step.text;
        tourNextBtn.textContent = stepIndex === steps.length - 1 ? 'Finish' : 'Next';

        armActionListener(step, target, stepIndex);

        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(repositionOverlay, 180);
        return true;
    }

    function goToNextStep() {
        let nextIndex = activeStepIndex + 1;

        while (nextIndex < steps.length) {
            if (prepareStep(nextIndex)) {
                return;
            }
            nextIndex += 1;
        }

        end(false);
    }

    function start() {
        if (!tourOverlay || !tourCard || !tourStepLabel || !tourTitle || !tourText) {
            return;
        }

        localStorage.removeItem(storageKey);
        activeStepIndex = -1;
        tourOverlay.classList.remove('hidden');
        tourOverlay.setAttribute('aria-hidden', 'false');
        onStart?.();
        goToNextStep();
    }

    function end(skipped) {
        if (!tourOverlay || !tourCard) {
            return;
        }

        clearPendingAction();
        if (highlightedElement) {
            highlightedElement.classList.remove('tourTarget', 'tourTargetConfirmed');
        }

        highlightedElement = null;
        activeStepIndex = -1;
        tourOverlay.classList.add('hidden');
        tourOverlay.setAttribute('aria-hidden', 'true');
        tourCard.style.left = '';
        tourCard.style.top = '';
        positionCurtains();

        localStorage.setItem(storageKey, skipped ? 'dismissed' : 'tour-completed');
        onEnd?.(skipped);
    }

    if (tourSkipBtn) {
        tourSkipBtn.addEventListener('click', () => end(true));
    }
    if (tourNextBtn) {
        tourNextBtn.addEventListener('click', goToNextStep);
    }
    window.addEventListener('resize', repositionOverlay);
    window.addEventListener('scroll', repositionOverlay, true);

    return { start, end, isOpen, hasBeenSeen };
}

function generateTaskId() {
    return `task-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function generateSubtaskId() {
    return `sub-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
