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

function isValidDateValue(value) {
    if (!value) {
        return false;
    }

    const parsedDate = new Date(value);
    return !Number.isNaN(parsedDate.getTime());
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
// steps: [{ selector, title, text, beforeShow?(), isRelevant?(), waitFor? }].
// beforeShow runs right before that step's target is looked up (e.g. to
// open a collapsed panel the target lives inside). waitFor (optional):
// { event, selector? } - makes the step interactive instead of a passive
// Next-through: the Next button is disabled/relabeled, the target gets a
// pulsing highlight instead of a static one, and the step only advances
// once the user actually performs `event` on `selector` (defaults to the
// step's own selector) - Skip still works normally throughout.
function createTourController({ steps, storageKey, onEnd }) {
    const tourOverlay = document.querySelector('.tourOverlay');
    const tourCard = document.querySelector('.tourCard');
    const tourStepLabel = document.querySelector('.tourStepLabel');
    const tourTitle = document.querySelector('.tourTitle');
    const tourText = document.querySelector('.tourText');
    const tourSkipBtn = document.querySelector('.tourSkipBtn');
    const tourNextBtn = document.querySelector('.tourNextBtn');

    let activeStepIndex = -1;
    let highlightedElement = null;
    // The still-pending listener for the current interactive step, if any -
    // { element, eventName, handler, waitingElement }, so it can be torn
    // down the moment it's no longer relevant (next step prepared, or the
    // tour ends) instead of firing late or leaking.
    let pendingInteraction = null;

    function clearPendingInteraction() {
        tourOverlay?.classList.remove('interactive');
        if (!pendingInteraction) {
            return;
        }
        pendingInteraction.element.removeEventListener(pendingInteraction.eventName, pendingInteraction.handler);
        pendingInteraction.waitingElement.classList.remove('tourTargetWaiting');
        pendingInteraction = null;
        if (tourNextBtn) {
            tourNextBtn.disabled = false;
        }
    }

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

    function prepareStep(stepIndex) {
        // Whatever the previous step set up (interactive or not) is no
        // longer relevant the moment a new one is being prepared - clear it
        // first, unconditionally, so an isRelevant()/missing-target bail-out
        // below can never leave a stale listener behind.
        clearPendingInteraction();

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

        if (highlightedElement) {
            highlightedElement.classList.remove('tourTarget');
        }

        activeStepIndex = stepIndex;
        highlightedElement = target;
        highlightedElement.classList.add('tourTarget');

        tourStepLabel.textContent = `Step ${stepIndex + 1} of ${steps.length}`;
        tourTitle.textContent = step.title;
        tourText.textContent = step.text;
        tourNextBtn.textContent = stepIndex === steps.length - 1 ? 'Finish' : 'Next';

        if (step.waitFor) {
            const waitTarget = step.waitFor.selector ? document.querySelector(step.waitFor.selector) : target;
            if (waitTarget) {
                const handler = () => goToNextStep();
                waitTarget.addEventListener(step.waitFor.event, handler, { once: true });
                pendingInteraction = { element: waitTarget, eventName: step.waitFor.event, handler, waitingElement: target };
                target.classList.add('tourTargetWaiting');
                tourOverlay?.classList.add('interactive');
                tourNextBtn.disabled = true;
                tourNextBtn.textContent = 'Try it →';
            }
        }

        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(positionCard, 180);
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
        goToNextStep();
    }

    function end(skipped) {
        if (!tourOverlay || !tourCard) {
            return;
        }

        clearPendingInteraction();

        if (highlightedElement) {
            highlightedElement.classList.remove('tourTarget');
        }

        highlightedElement = null;
        activeStepIndex = -1;
        tourOverlay.classList.add('hidden');
        tourOverlay.setAttribute('aria-hidden', 'true');
        tourCard.style.left = '';
        tourCard.style.top = '';

        localStorage.setItem(storageKey, skipped ? 'dismissed' : 'tour-completed');
        onEnd?.(skipped);
    }

    if (tourSkipBtn) {
        tourSkipBtn.addEventListener('click', () => end(true));
    }
    if (tourNextBtn) {
        tourNextBtn.addEventListener('click', goToNextStep);
    }
    window.addEventListener('resize', positionCard);
    window.addEventListener('scroll', positionCard, true);

    return { start, end, isOpen, hasBeenSeen };
}

function generateTaskId() {
    return `task-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function generateSubtaskId() {
    return `sub-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
