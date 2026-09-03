// Brain Dump chat - shared controller. Solo (script.js) and Group
// (group/group.js) both instantiate this same factory, each with its own
// commitTasks callback, since solo and group create tasks completely
// differently under the hood (see script.js's commitAiTasksSolo vs.
// group/group.js's commitAiTasksGroup). Mirrors two conventions already
// established elsewhere in this app: createTourController's "shared
// engine, page-specific callback" factory shape (task-shared.js), and the
// JS-constructed overlay pattern used by initializeTaskEditor()/
// initializeSuggestModal() (built once, appended to document.body,
// visibility toggled via an .open class).
//
// Talks to a small external Cloudflare Worker (see /worker in this repo)
// that holds the Gemini API key server-side and verifies every request
// carries a real Firebase ID token for this project before spending one.
// It only ever gets back a list of PROPOSED tasks, shown as editable/
// uncheckable review cards, and hands whatever the user actually confirms
// to the page's own commitTasks callback, which writes them the exact same
// way manual task entry does - so this file can't create/modify a task on
// its own, only propose one. Chat history and any attachment are entirely
// in-memory - nothing here is ever persisted (except the read-only task
// snapshot below, which is never written anywhere, just read).
//
// It DOES read Firestore directly for one thing: gatherTaskContext(), a
// fresh read-only snapshot of the user's solo tasks and every group they're
// in (not just whichever one happens to be selected), sent along with every
// message so the AI can see the user's real existing workload - avoid
// duplicate suggestions, give prioritization guidance, answer "what should
// I focus on" style questions - regardless of which page Brain Dump is
// opened from. This is a plain read (same security rules as the rest of
// the app already enforce - a user can already see everything gathered
// here), never a write.

// Fill this in after deploying the Worker - see worker/README.md.
const BRAIN_DUMP_WORKER_URL = 'https://todo-brain-dump.leafwayyy.workers.dev';

const BRAIN_DUMP_MATRIX_OPTIONS = [
    { value: 'do', label: 'Important & Urgent' },
    { value: 'schedule', label: 'Important' },
    { value: 'delegate', label: 'Urgent' },
    { value: 'eliminate', label: 'None' }
];

const BRAIN_DUMP_DIFFICULTY_OPTIONS = [
    { value: 1, label: '1 (Very Easy)' },
    { value: 2, label: '2 (Easy)' },
    { value: 3, label: '3 (Medium)' },
    { value: 4, label: '4 (Hard)' },
    { value: 5, label: '5 (Very Hard)' }
];

const BRAIN_DUMP_ACCEPTED_TYPES = 'image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain';
const BRAIN_DUMP_MAX_FILE_BYTES = 4 * 1024 * 1024; // 4MB per attachment, checked client-side
const BRAIN_DUMP_MAX_HISTORY_TURNS = 10;
const BRAIN_DUMP_MAX_CONTEXT_TASKS = 150; // per list (solo, or each group) - a defensive cap, not a realistic ceiling
const BRAIN_DUMP_MAX_MEMORIES = 60; // how many saved memories get sent as context per message - a defensive cap
const BRAIN_DUMP_MEMORY_SOFT_LIMIT = 60; // stop offering to save new ones past this - nudges toward deleting stale ones from Settings instead of growing forever

// Recurring idle hints (see startIdleHintCycle) - unlike maybeShowIntroHint
// (once ever, for a first-time visitor), these keep showing periodically for
// the life of the page, for anyone: the whole point is ongoing discoverability
// of what Dusty can actually do, not just a first-run nudge. Rotates through
// a small pool per context so it doesn't say the same thing every time.
const DUSTY_IDLE_HINTS_SOLO = [
    "Got a lot on your mind? Just tell me about it.",
    'I can turn a messy brain-dump into real tasks.',
    "Not sure what to focus on? Ask me what's most urgent.",
    "Need to add a bunch of tasks at once? I've got you.",
    'Plans changed? I can edit an existing task too, just ask.',
    'Stuck on how to break a task down? I can suggest some steps.'
];
const DUSTY_IDLE_HINTS_GROUP = [
    "Got a lot on your mind? Just tell me about it.",
    'I can turn a messy brain-dump into real tasks.',
    'I can suggest a task to a teammate for you, just ask.',
    "I can comment on a teammate's task too.",
    "Not sure what to focus on? Ask me what's most urgent.",
    'Plans changed? I can edit an existing task too, just ask.'
];
// ~30s between hints, per explicit request (was ~15s) - kept a small
// amount of jitter either side rather than a flat 30000 so it doesn't feel
// like a metronome, still centered right on 30s. Shared by solo and group -
// both instantiate this same brain-dump.js controller, so this one constant
// covers both.
const DUSTY_IDLE_HINT_MIN_DELAY_MS = 25 * 1000;
const DUSTY_IDLE_HINT_MAX_DELAY_MS = 35 * 1000;
const DUSTY_IDLE_HINT_VISIBLE_MS = 7000;
const DUSTY_IDLE_HINT_LAST_INDEX_KEY = 'dustyIdleHintLastIndex';

function brainDumpToDatetimeLocalValue(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function brainDumpSummarizeTask(task) {
    return {
        id: task.id, // needed so Dusty can target an exact task when commenting on a teammate's
        text: task.text,
        completed: Boolean(task.completed),
        matrix: task.matrix || null,
        difficulty: task.difficulty || null,
        dueAt: task.dueAt || null,
        scheduledAt: task.scheduledAt || null,
        owner: task.ownerName || null // only meaningful for group tasks - absent on solo ones
    };
}

// Planning signals (see computeSoloPlanningSignals/computeGroupPlanningSignals
// below) need raw fields this summary deliberately strips (estimateMinutes,
// snoozeCount, ownerId) - kept as a separate function rather than adding
// those to brainDumpSummarizeTask itself, since the per-task text sent to
// Gemini doesn't need them individually, only the aggregate numbers computed
// from them.

// Solo: "is the user actually overloaded, or just busy-looking" and "which
// task keeps getting pushed instead of done" - both real arithmetic/
// counting questions that belong in code, not left for the model to
// eyeball from a flat task list (the same reasoning already applied to
// task-id validation elsewhere in this app: compute the hard facts
// reliably, let the LLM reason narratively on top of them).
function computeSoloPlanningSignals(rawTasks) {
    const now = new Date();
    const todayEnd = new Date(now);
    todayEnd.setHours(23, 59, 59, 999);
    const weekEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    let dueTodayMinutes = 0;
    let dueTodayCount = 0;
    let dueTodayUnestimatedCount = 0;
    let dueWeekMinutes = 0;
    let dueWeekCount = 0;
    let dueWeekUnestimatedCount = 0;
    const stalled = [];

    rawTasks.forEach((task) => {
        const minutes = Number(task.estimateMinutes) || 0;
        if (task.dueAt) {
            const due = new Date(task.dueAt);
            if (!Number.isNaN(due.getTime()) && due >= now && due <= weekEnd) {
                dueWeekCount += 1;
                if (minutes > 0) dueWeekMinutes += minutes; else dueWeekUnestimatedCount += 1;
                if (due <= todayEnd) {
                    dueTodayCount += 1;
                    if (minutes > 0) dueTodayMinutes += minutes; else dueTodayUnestimatedCount += 1;
                }
            }
        }
        // 3+ snoozes - a genuine repeating pattern, not just "life happened
        // once." Only ever set by an explicit user action (the snooze
        // button), never inferred.
        const snoozeCount = Number(task.snoozeCount) || 0;
        if (snoozeCount >= 3) {
            stalled.push({ id: task.id, text: String(task.text || '').slice(0, 120), snoozeCount });
        }
    });

    return {
        dueTodayMinutes, dueTodayCount, dueTodayUnestimatedCount,
        dueWeekMinutes, dueWeekCount, dueWeekUnestimatedCount,
        stalled: stalled.slice(0, 20)
    };
}

// Group: per-member workload (raw counts/minutes, comparative judgment left
// to the model - "overloaded" is relative, the arithmetic isn't) and
// deadline collisions (2+ different people with something due the same
// calendar day - often a shared external deadline worth coordinating on,
// not a coincidence). Bucketed by the literal date portion of the ISO
// string rather than trying to reconcile different members' timezones -
// simple and transparent beats a precision this doesn't actually need.
function computeGroupPlanningSignals(rawTasks) {
    const now = new Date();
    const perMember = new Map();
    const byDate = new Map();

    rawTasks.forEach((task) => {
        const owner = task.ownerName || 'Teammate';
        if (!perMember.has(owner)) {
            perMember.set(owner, { activeTaskCount: 0, totalEstimateMinutes: 0, overdueCount: 0 });
        }
        const stats = perMember.get(owner);
        stats.activeTaskCount += 1;
        stats.totalEstimateMinutes += Number(task.estimateMinutes) || 0;

        if (task.dueAt && typeof task.dueAt === 'string') {
            const due = new Date(task.dueAt);
            if (!Number.isNaN(due.getTime())) {
                if (due < now) stats.overdueCount += 1;
                const dayKey = task.dueAt.slice(0, 10);
                if (!byDate.has(dayKey)) byDate.set(dayKey, []);
                byDate.get(dayKey).push({ id: task.id, text: String(task.text || '').slice(0, 100), owner });
            }
        }
    });

    const deadlineCollisions = [];
    byDate.forEach((tasksOnDay, date) => {
        const distinctOwners = new Set(tasksOnDay.map((t) => t.owner));
        if (distinctOwners.size >= 2) {
            deadlineCollisions.push({ date, tasks: tasksOnDay.slice(0, 10) });
        }
    });
    deadlineCollisions.sort((a, b) => a.date.localeCompare(b.date));

    return {
        perMember: Array.from(perMember.entries()).map(([name, stats]) => ({ name, ...stats })).slice(0, 30),
        deadlineCollisions: deadlineCollisions.slice(0, 10),
        // Filled in separately by gatherTaskContext (needs its own Firestore
        // read) - defaulted here so the shape is always consistent even if
        // that second read fails or never runs.
        pendingSuggestions: []
    };
}

// A fresh, one-time, read-only snapshot - not a live subscription, since
// this only ever needs "what does their workload look like right now, at
// the moment they hit send" rather than staying continuously in sync.
// currentGroupId: only used to scope the two extra reads planning signals
// need for the CURRENTLY OPEN group (its own raw task fields for
// computeGroupPlanningSignals, and its pending suggestions) - same "only
// the open group" scoping teammateSuggestions/teammateComments already
// use, so this doesn't add a read per group the user happens to be in.
async function gatherTaskContext(user, currentGroupId) {
    const { db, firestore } = window.ToDoAuth;
    const { collection, getDocs, query, where } = firestore;

    let soloTasks = [];
    let soloSignals = null;
    try {
        const soloSnapshot = await getDocs(collection(db, 'users', user.uid, 'tasks'));
        const rawSoloTasks = soloSnapshot.docs
            .map((taskDoc) => ({ id: taskDoc.id, ...taskDoc.data() }))
            .filter((task) => !task.completed)
            .slice(0, BRAIN_DUMP_MAX_CONTEXT_TASKS);
        soloSignals = computeSoloPlanningSignals(rawSoloTasks);
        soloTasks = rawSoloTasks.map(brainDumpSummarizeTask);
    } catch (error) {
        console.error('Brain Dump: failed to load solo tasks for context:', error);
    }

    let groupsContext = [];
    let groupSignals = null;
    try {
        const groupsQuery = query(collection(db, 'groups'), where('memberIds', 'array-contains', user.uid));
        const groupsSnapshot = await getDocs(groupsQuery);
        // memberNames (parallel to memberIds) is already a field on the group
        // doc - free to include, and needed so Dusty knows a teammate's name
        // even if they have zero active tasks right now.
        const groups = groupsSnapshot.docs.map((groupDoc) => ({
            id: groupDoc.id,
            name: groupDoc.data().name,
            memberIds: groupDoc.data().memberIds || [],
            memberNames: groupDoc.data().memberNames || []
        }));

        groupsContext = await Promise.all(groups.map(async (group) => {
            try {
                const tasksSnapshot = await getDocs(collection(db, 'groups', group.id, 'tasks'));
                const rawGroupTasks = tasksSnapshot.docs
                    .map((taskDoc) => ({ id: taskDoc.id, ...taskDoc.data() }))
                    .filter((task) => !task.completed)
                    .slice(0, BRAIN_DUMP_MAX_CONTEXT_TASKS);
                if (currentGroupId && group.id === currentGroupId) {
                    groupSignals = computeGroupPlanningSignals(rawGroupTasks);
                }
                const groupTasks = rawGroupTasks.map(brainDumpSummarizeTask);
                return { id: group.id, name: group.name, memberNames: group.memberNames, tasks: groupTasks };
            } catch (error) {
                console.error(`Brain Dump: failed to load tasks for group ${group.id}:`, error);
                return { id: group.id, name: group.name, memberNames: group.memberNames, tasks: [] };
            }
        }));

        if (currentGroupId && groupSignals) {
            try {
                // forUserId -> a real display name via the roster already
                // fetched above (memberIds/memberNames are parallel arrays
                // on the group doc), rather than a second query per name.
                const currentGroup = groups.find((g) => g.id === currentGroupId);
                const nameForId = (id) => {
                    const idx = currentGroup ? currentGroup.memberIds.indexOf(id) : -1;
                    return idx !== -1 ? currentGroup.memberNames[idx] : 'a teammate';
                };
                const suggestionsSnapshot = await getDocs(collection(db, 'groups', currentGroupId, 'suggestions'));
                groupSignals.pendingSuggestions = suggestionsSnapshot.docs
                    .map((suggestionDoc) => suggestionDoc.data())
                    .filter((suggestion) => suggestion.status === 'pending')
                    .slice(0, 30)
                    .map((suggestion) => ({
                        forUserName: nameForId(suggestion.forUserId),
                        text: String(suggestion.text || '').slice(0, 150)
                    }));
            } catch (error) {
                console.error(`Brain Dump: failed to load pending suggestions for group ${currentGroupId}:`, error);
            }
        }
    } catch (error) {
        console.error('Brain Dump: failed to load groups for context:', error);
    }

    return { soloTasks, groups: groupsContext, signals: { solo: soloSignals, group: groupSignals } };
}

// A fresh, one-time, read-only snapshot of users/{uid}/dustyMemory - the
// short list of facts Dusty has asked to remember and the user explicitly
// confirmed (see createMemoryReviewCard/commitMemories below). Sent with
// every message, solo or group, since this is about the PERSON, not
// whichever list they happen to have open.
async function gatherDustyMemories(user) {
    const { db, firestore } = window.ToDoAuth;
    const { collection, getDocs } = firestore;

    try {
        const snapshot = await getDocs(collection(db, 'users', user.uid, 'dustyMemory'));
        return snapshot.docs
            .map((memoryDoc) => ({ id: memoryDoc.id, text: memoryDoc.data().text }))
            .slice(0, BRAIN_DUMP_MAX_MEMORIES);
    } catch (error) {
        console.error('Brain Dump: failed to load saved memories:', error);
        return [];
    }
}

function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result || '');
            const commaIndex = result.indexOf(',');
            resolve(commaIndex === -1 ? result : result.slice(commaIndex + 1));
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

// Date#toISOString() always converts to UTC ("Z"), which is exactly wrong
// here - the Worker takes this string completely literally ("The current
// date/time is <this>."), so a UTC timestamp reads as a UTC "today" to
// Gemini. Anyone west of UTC whose local clock has already rolled past
// midnight-UTC (e.g. it's 6pm in Calgary, already past midnight in UTC)
// gets tomorrow's date treated as today - "prepare for my 9:30am class
// tomorrow" resolves against the wrong day entirely. This builds a proper
// ISO 8601 string with the LOCAL wall-clock time and its real UTC offset
// (plus the IANA zone name, for a human-readable double-check) instead, so
// "today"/"tomorrow" always resolve against the user's own calendar date.
function getClientTimeString() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');

    const offsetMinutes = -now.getTimezoneOffset();
    const offsetSign = offsetMinutes >= 0 ? '+' : '-';
    const absOffsetMinutes = Math.abs(offsetMinutes);
    const offset = `${offsetSign}${pad(Math.floor(absOffsetMinutes / 60))}:${pad(absOffsetMinutes % 60)}`;

    const localIso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
        + `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offset}`;

    let timeZoneName = '';
    try {
        timeZoneName = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch {
        // Some environments don't support this - the offset above is
        // already unambiguous on its own.
    }

    return timeZoneName ? `${localIso} (${timeZoneName})` : localIso;
}

// Dusty's portrait - built fresh at whatever pixel size a given spot needs
// (the bottom-right FAB, the chat header, each assistant message). Pure
// inline SVG - no image file, no build step, scales crisply, and the named
// classes on individual parts (eyes/eyelids) are what style.css's blink/
// bounce/greet animations target. A bust portrait (head + ears + a hint of
// back/shoulder) rather than a full sitting-body illustration, since a full
// body wouldn't read cleanly at the ~24px size used next to chat messages.
function buildDustyAvatarMarkup(size) {
    return `
        <svg class="dustyArt" viewBox="0 0 100 100" width="${size}" height="${size}" aria-hidden="true" focusable="false">
            <defs>
                <radialGradient id="dustyFurGrad" cx="35%" cy="28%" r="80%">
                    <stop offset="0%" stop-color="#fffaf0"/>
                    <stop offset="100%" stop-color="#eee0c8"/>
                </radialGradient>
                <filter id="dustyGlow" x="-80%" y="-80%" width="260%" height="260%">
                    <feGaussianBlur stdDeviation="2.4" result="blur"/>
                    <feMerge>
                        <feMergeNode in="blur"/>
                        <feMergeNode in="SourceGraphic"/>
                    </feMerge>
                </filter>
            </defs>

            <path d="M16 80 Q28 54 55 59 Q77 63 80 84 Z" fill="#f2b979"/>

            <path d="M20 36 L11 8 L41 28 Z" fill="url(#dustyFurGrad)" stroke="#3a2a63" stroke-width="3.5" stroke-linejoin="round"/>
            <path d="M80 36 L89 8 L59 28 Z" fill="url(#dustyFurGrad)" stroke="#3a2a63" stroke-width="3.5" stroke-linejoin="round"/>
            <path d="M22 29 L17 14 L32 25 Z" fill="#f6c68f"/>

            <circle cx="50" cy="53" r="35" fill="url(#dustyFurGrad)" stroke="#3a2a63" stroke-width="3.5"/>

            <path d="M18 56 Q11 61 16 70" stroke="#3a2a63" stroke-width="2" fill="none" stroke-linecap="round" opacity="0.35"/>
            <path d="M82 56 Q89 61 84 70" stroke="#3a2a63" stroke-width="2" fill="none" stroke-linecap="round" opacity="0.35"/>

            <g stroke="#3a2a63" stroke-width="1.4" opacity="0.5" stroke-linecap="round">
                <path d="M10 58 L27 60"/>
                <path d="M10 66 L27 64"/>
                <path d="M90 58 L73 60"/>
                <path d="M90 66 L73 64"/>
            </g>

            <g filter="url(#dustyGlow)">
                <ellipse cx="37" cy="53" rx="8.5" ry="9.5" fill="#3fc7ff"/>
                <ellipse cx="63" cy="53" rx="8.5" ry="9.5" fill="#3fc7ff"/>
                <circle cx="37" cy="53" r="3.2" fill="#0d2b40"/>
                <circle cx="63" cy="53" r="3.2" fill="#0d2b40"/>
                <circle cx="34" cy="49.5" r="1.7" fill="#fff"/>
                <circle cx="60" cy="49.5" r="1.7" fill="#fff"/>
            </g>
            <rect class="dustyEyelid dustyEyelidL" x="27.5" y="42" width="19" height="19" rx="9.5" fill="#eee0c8"/>
            <rect class="dustyEyelid dustyEyelidR" x="53.5" y="42" width="19" height="19" rx="9.5" fill="#eee0c8"/>

            <path d="M50 61 L45.5 65.5 L54.5 65.5 Z" fill="#e8879c"/>
            <path d="M50 65.5 Q50 70 43.5 69.5 M50 65.5 Q50 70 56.5 69.5" stroke="#3a2a63" stroke-width="2" fill="none" stroke-linecap="round"/>
        </svg>
    `;
}

// context: 'solo' | 'group' - only ever changes prompt wording server-side,
// never auth or Firestore access. commitTasks(draftTasks): called with the
// user-confirmed, still-checked draft objects (possibly hand-edited) when
// "Add" is clicked - may return a promise. Each draft is
// { text, matrix, taskType, difficulty, estimateMinutes, dueAt, scheduledAt }
// exactly as the AI (or the user's own edit) left it - NOTHING here is
// trusted or sanitized; that's commitTasks' job, same as it would be for
// any other task-creation entry point.
function createBrainDumpController({ context, commitTasks, commitSuggestions, commitComments, commitTaskEdits, getCurrentGroupId }) {
    let overlay = null;
    let messagesEl = null;
    let attachmentsRowEl = null;
    let textInput = null;
    let sendBtn = null;
    let attachBtn = null;
    let fileInput = null;
    let rateStatusEl = null;

    let history = []; // [{ role: 'user'|'assistant', text }] - capped, never persisted
    let pendingAttachments = []; // [{ mimeType, data, name }] for the NEXT send only
    let isSending = false;
    let rateCountdownIntervalId = null;

    // Dusty, the floating bottom-right mascot that opens this chat. Both
    // script.js and group/group.js already look up the SAME
    // .brainDumpToggleBtn element themselves (for click wiring, and for
    // group.js's hidden-until-a-group-is-selected gating) - this file grabs
    // it too, independently, just to inject Dusty's portrait/animations
    // into it. Nothing here changes what that element IS to those files.
    const fabEl = document.querySelector('.brainDumpToggleBtn');
    let greetTimeoutId = null;

    function isOpen() {
        return Boolean(overlay && overlay.classList.contains('open'));
    }

    // Shows once ever, across the whole app (same key checked/set from
    // both Solo and Group) - not account-level tracking like the onboarding
    // tour, just a plain localStorage flag, since this is a cosmetic nudge
    // rather than something that needs to survive a different device.
    function maybeShowIntroHint() {
        if (!fabEl) {
            return;
        }
        let alreadySeen = false;
        try {
            alreadySeen = localStorage.getItem('dustyIntroSeen') === '1';
        } catch {
            alreadySeen = false;
        }
        if (alreadySeen) {
            return;
        }

        const hint = document.createElement('div');
        hint.className = 'dustyHint';
        hint.textContent = "Hi, I'm Dusty! Tap me if you need help.";
        fabEl.appendChild(hint);

        let dismissed = false;
        const dismiss = () => {
            if (dismissed) {
                return;
            }
            dismissed = true;
            try {
                localStorage.setItem('dustyIntroSeen', '1');
            } catch {
                // localStorage unavailable - non-fatal, the hint just
                // reappears next load, which is harmless.
            }
            hint.classList.add('dustyHintHide');
            setTimeout(() => hint.remove(), 400);
        };

        setTimeout(dismiss, 6000);
        fabEl.addEventListener('click', dismiss, { once: true });
    }

    // Recurring reminder that Dusty is actually useful, not just a mascot
    // that blinks - unlike maybeShowIntroHint above (shows once, ever, for
    // a first-time visitor), this keeps firing every few minutes for the
    // life of the page, for anyone, rotating through a small pool of real
    // things Dusty can do. Paused (not shown, but still rescheduled for
    // later) whenever the chat is open, the tab isn't visible, or a hint is
    // already on screen - never stacks, never interrupts an active chat.
    let idleHintTimeoutId = null;

    function pickIdleHintMessage() {
        const pool = context === 'group' ? DUSTY_IDLE_HINTS_GROUP : DUSTY_IDLE_HINTS_SOLO;
        if (pool.length <= 1) {
            return pool[0] || '';
        }
        let lastIndex = -1;
        try {
            const stored = localStorage.getItem(DUSTY_IDLE_HINT_LAST_INDEX_KEY);
            // getItem returns null on first-ever run - Number(null) is 0, not
            // NaN, which would wrongly treat index 0 as "just shown". Only
            // trust a stored value that was actually written.
            lastIndex = stored === null ? -1 : Number(stored);
        } catch {
            lastIndex = -1;
        }
        let nextIndex = Math.floor(Math.random() * pool.length);
        if (nextIndex === lastIndex) {
            nextIndex = (nextIndex + 1) % pool.length;
        }
        try {
            localStorage.setItem(DUSTY_IDLE_HINT_LAST_INDEX_KEY, String(nextIndex));
        } catch {
            // Non-fatal - worst case the same line can repeat back to back.
        }
        // Defensive fallback - pool[nextIndex] should always be a real line
        // given the bounds above, but never hand the caller an empty bubble.
        return pool[nextIndex] || pool[0] || '';
    }

    function scheduleIdleHint() {
        clearTimeout(idleHintTimeoutId);
        const delay = DUSTY_IDLE_HINT_MIN_DELAY_MS
            + Math.random() * (DUSTY_IDLE_HINT_MAX_DELAY_MS - DUSTY_IDLE_HINT_MIN_DELAY_MS);
        idleHintTimeoutId = setTimeout(showIdleHint, delay);
    }

    function showIdleHint() {
        // THE BUG: this used to check fabEl.offsetParent === null as an
        // "is this actually visible" test. That works for normal in-flow
        // elements, but .brainDumpToggleBtn is position:fixed - and a
        // position:fixed element's offsetParent is ALWAYS null in every
        // browser, regardless of whether it's actually on screen (verified
        // directly against real Chromium, not just spec-reading). So this
        // check was unconditionally true, every single time, forever - the
        // idle hint scheduled itself over and over but could never actually
        // pass this guard, which is exactly why it never appeared for
        // anyone. getClientRects().length is the fix: it's empty when the
        // element (or an ancestor, e.g. group.js's hidden-until-a-group-
        // is-selected class) is display:none, but non-empty for a rendered
        // position:fixed element - verified against both cases directly.
        // Every skip case still reschedules - a hidden/backgrounded moment
        // now just means try again next cycle, not give up entirely.
        if (!fabEl || isOpen() || document.hidden || fabEl.getClientRects().length === 0 || fabEl.querySelector('.dustyHint')) {
            scheduleIdleHint();
            return;
        }

        // Small bounce alongside the bubble (same burst already used when
        // Dusty reappears after the chat closes) - a static bubble next to
        // an otherwise-idle mascot is easy to miss out of the corner of an
        // eye; the motion is what actually draws attention to it.
        playGreetBurst();

        const hint = document.createElement('div');
        hint.className = 'dustyHint dustyIdleHint';
        hint.textContent = pickIdleHintMessage();
        fabEl.appendChild(hint);

        let dismissed = false;
        const dismiss = () => {
            if (dismissed) {
                return;
            }
            dismissed = true;
            hint.classList.add('dustyHintHide');
            setTimeout(() => hint.remove(), 400);
        };

        const hideTimeoutId = setTimeout(dismiss, DUSTY_IDLE_HINT_VISIBLE_MS);
        fabEl.addEventListener('click', () => {
            clearTimeout(hideTimeoutId);
            dismiss();
        }, { once: true });

        scheduleIdleHint();
    }

    // Runs once, immediately, rather than lazily in build() (which only
    // fires on first open) - Dusty needs to be visible and idling on the
    // page well before anyone opens the chat.
    function mountFab() {
        if (!fabEl) {
            return;
        }
        fabEl.innerHTML = buildDustyAvatarMarkup(40);
        fabEl.setAttribute('aria-label', 'Chat with Dusty');
        fabEl.title = "Chat with Dusty - let AI turn what you type into tasks";
        maybeShowIntroHint();
        // Own minimum delay (2-4 min) already puts this well clear of the
        // one-time intro hint's 6-second window, so no explicit sequencing
        // needed between the two - starts counting down regardless of
        // whether the intro hint fires on this visit.
        scheduleIdleHint();
    }
    mountFab();

    // Little "happy to see you" burst when Dusty reappears after the chat
    // closes - not literally a wave (no arm in a bust-only portrait), a
    // quick perk/bounce instead.
    function playGreetBurst() {
        if (!fabEl) {
            return;
        }
        clearTimeout(greetTimeoutId);
        fabEl.classList.remove('dustyGreet');
        // Force reflow so re-adding the class restarts the animation even
        // if a previous greet burst is still finishing.
        void fabEl.offsetWidth;
        fabEl.classList.add('dustyGreet');
        greetTimeoutId = setTimeout(() => fabEl.classList.remove('dustyGreet'), 700);
    }

    function scrollToBottom() {
        if (messagesEl) {
            messagesEl.scrollTop = messagesEl.scrollHeight;
        }
    }

    function appendUserBubble(text, attachmentNames) {
        const bubble = document.createElement('div');
        bubble.classList.add('brainDumpMsg', 'brainDumpMsgUser');
        const p = document.createElement('p');
        p.textContent = text;
        bubble.appendChild(p);
        if (attachmentNames.length > 0) {
            const names = document.createElement('p');
            names.classList.add('brainDumpMsgAttachments');
            names.textContent = `📎 ${attachmentNames.join(', ')}`;
            bubble.appendChild(names);
        }
        messagesEl.appendChild(bubble);
        scrollToBottom();
    }

    // Small Dusty portrait shown next to each of her own messages, so the
    // conversation visibly reads as chatting with a character rather than
    // a bare utility - not used for the user's own bubbles or system-y
    // error bubbles, only Dusty's actual replies/typing indicator.
    function buildAvatarEl() {
        const el = document.createElement('div');
        el.className = 'brainDumpMsgAvatar';
        el.innerHTML = buildDustyAvatarMarkup(24);
        return el;
    }

    function appendAssistantBubble(replyText, quickReplies) {
        const row = document.createElement('div');
        row.classList.add('brainDumpMsgRow');
        row.appendChild(buildAvatarEl());
        const bubble = document.createElement('div');
        bubble.classList.add('brainDumpMsg', 'brainDumpMsgAssistant');
        const p = document.createElement('p');
        p.textContent = replyText;
        bubble.appendChild(p);
        row.appendChild(bubble);
        messagesEl.appendChild(row);

        if (Array.isArray(quickReplies) && quickReplies.length > 0) {
            appendQuickReplies(quickReplies);
        }

        scrollToBottom();
    }

    // Tappable, one-tap version of whatever multiple-choice-style question
    // Dusty just asked in her reply (see the Worker's STEP 3 quickReplies
    // rule) - tapping one drops it into the input, still editable, rather
    // than sending it outright, so a slightly-off option can be tweaked
    // before it's actually sent. The whole set removes itself once any one
    // is picked - by then they're answered/stale, and clicking them again
    // later wouldn't make sense against a newer message.
    function appendQuickReplies(options) {
        const wrap = document.createElement('div');
        wrap.classList.add('brainDumpQuickReplies');

        // Section J: a brief first-use cue clarifying these fill the input
        // rather than send immediately - the one real ambiguity gap found
        // in Dusty's chat. Shown once ever per browser, same
        // localStorage-flag pattern as dustyIntroSeen above.
        let quickReplyCueSeen = true;
        try {
            quickReplyCueSeen = localStorage.getItem('dustyQuickReplyCueSeen') === '1';
        } catch {
            // localStorage unavailable - default to "seen" so this doesn't
            // reappear every message for someone who can't have it persist.
        }
        if (!quickReplyCueSeen) {
            const cue = document.createElement('p');
            cue.classList.add('brainDumpQuickReplyCue');
            cue.textContent = 'Tap one to fill it in - you can still edit before sending.';
            wrap.appendChild(cue);
            try {
                localStorage.setItem('dustyQuickReplyCueSeen', '1');
            } catch {
                // Non-fatal - worst case the cue just reappears next time.
            }
        }

        options.slice(0, 4).forEach((optionText) => {
            const trimmed = String(optionText || '').trim();
            if (!trimmed) {
                return;
            }
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.classList.add('brainDumpQuickReplyChip');
            chip.textContent = trimmed;
            chip.addEventListener('click', () => {
                textInput.value = trimmed;
                textInput.focus();
                textInput.style.height = 'auto';
                textInput.style.height = `${Math.min(textInput.scrollHeight, 160)}px`;
                wrap.remove();
            });
            wrap.appendChild(chip);
        });
        if (wrap.children.length > 0) {
            messagesEl.appendChild(wrap);
        }
    }

    function appendErrorBubble(text) {
        const bubble = document.createElement('div');
        bubble.classList.add('brainDumpMsg', 'brainDumpMsgError');
        bubble.textContent = text;
        messagesEl.appendChild(bubble);
        scrollToBottom();
    }

    // 429 specifically means the app's ENTIRE shared free-tier Gemini quota
    // is exhausted for the day (one API key/quota pool for every user, not
    // per-account - see the Worker's own comment), not a brief throttle -
    // resetsAt (the Worker's own best estimate, Google doesn't publish an
    // exact guaranteed instant) gets converted to the user's own local time
    // here rather than shown as a bare UTC/ISO string.
    function describeErrorResponse(status, data) {
        if (status === 429 && data?.resetsAt) {
            const resetDate = new Date(data.resetsAt);
            if (!Number.isNaN(resetDate.getTime())) {
                const resetLabel = resetDate.toLocaleString([], {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit'
                });
                // Two distinct reasons share the 429 status - the Worker's
                // own per-user session-block cap (error: 'rate_limited',
                // bounds cost exposure from one account, see
                // getRateLimitState/RATE_LIMIT_WINDOW_MS in
                // brain-dump-worker.js) vs. the whole app's shared Gemini
                // quota (error: 'busy'). Worth telling apart - one is "you
                // specifically", the other is "everyone, including you".
                // The rate-limited case also normally gets caught earlier
                // by updateRateStatus's own live countdown before a send
                // even goes out - this is the fallback wording for it.
                if (data.error === 'rate_limited') {
                    return `You've used up this session's message budget. It resets around ${resetLabel} your time.`;
                }
                return `Dusty's hit her shared daily message limit. She should be back around ${resetLabel} your time.`;
            }
        }
        return (data && data.reply) || 'Something went wrong - try again in a bit.';
    }

    // Reflects the Worker's per-session token budget (see rateLimit on
    // every response, success or error) as a small persistent status line,
    // and - once it's actually exhausted - locks the composer and counts
    // down live until the window resets, auto-unlocking on its own rather
    // than needing a reload or a failed send to notice it's over.
    function updateRateStatus(rateLimit) {
        clearInterval(rateCountdownIntervalId);
        if (!rateLimit || !rateStatusEl) {
            return;
        }
        const { tokensUsed, tokenBudget, resetsAt } = rateLimit;
        const resetDate = new Date(resetsAt);
        if (Number.isNaN(resetDate.getTime()) || !tokenBudget) {
            return;
        }
        const isBlocked = tokensUsed >= tokenBudget;

        const renderTick = () => {
            const msLeft = resetDate.getTime() - Date.now();
            if (msLeft <= 0) {
                clearInterval(rateCountdownIntervalId);
                rateStatusEl.classList.add('hidden');
                setComposerDisabled(false);
                return;
            }
            const totalSeconds = Math.ceil(msLeft / 1000);
            const hours = Math.floor(totalSeconds / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = totalSeconds % 60;
            const countdownLabel = hours > 0
                ? `${hours}h ${minutes}m`
                : minutes > 0
                    ? `${minutes}m ${seconds}s`
                    : `${seconds}s`;

            rateStatusEl.textContent = isBlocked
                ? `You've used this session's message budget. Resets in ${countdownLabel}.`
                : `${Math.min(100, Math.round((tokensUsed / tokenBudget) * 100))}% of this session's budget used - resets in ${countdownLabel}.`;
        };

        rateStatusEl.classList.remove('hidden');
        rateStatusEl.classList.toggle('blocked', isBlocked);
        setComposerDisabled(isBlocked);
        renderTick();
        rateCountdownIntervalId = setInterval(renderTick, 1000);
    }

    function setComposerDisabled(disabled) {
        if (textInput) textInput.disabled = disabled;
        if (sendBtn) sendBtn.disabled = disabled;
        if (attachBtn) attachBtn.disabled = disabled;
    }

    function appendTypingIndicator() {
        const row = document.createElement('div');
        row.classList.add('brainDumpMsgRow');
        row.appendChild(buildAvatarEl());
        const bubble = document.createElement('div');
        bubble.classList.add('brainDumpMsg', 'brainDumpMsgAssistant', 'brainDumpTyping');
        bubble.textContent = 'Dusty is thinking...';
        row.appendChild(bubble);
        messagesEl.appendChild(row);
        scrollToBottom();
        return row;
    }

    // Returns { element, read() } rather than stashing state on the DOM
    // node - read() closes over the actual live input elements so it
    // always reflects whatever the user has since edited/unchecked.
    function createTaskReviewCard(draft) {
        const card = document.createElement('div');
        card.classList.add('brainDumpTaskCard');

        const header = document.createElement('div');
        header.classList.add('brainDumpTaskCardHeader');

        const checkboxLabel = document.createElement('label');
        checkboxLabel.classList.add('brainDumpTaskCardCheck');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = true;
        checkboxLabel.appendChild(checkbox);
        header.appendChild(checkboxLabel);

        // Adds just this one task right away, independent of the bulk
        // "Add checked" footer button below - so picking one specific task
        // out of several proposed doesn't require unchecking every other one.
        const addOneBtn = document.createElement('button');
        addOneBtn.type = 'button';
        addOneBtn.classList.add('brainDumpTaskCardAddBtn');
        addOneBtn.textContent = 'Add';
        header.appendChild(addOneBtn);

        const fields = document.createElement('div');
        fields.classList.add('brainDumpTaskCardFields');

        const textInputEl = document.createElement('input');
        textInputEl.type = 'text';
        textInputEl.classList.add('brainDumpTaskCardText');
        textInputEl.value = draft.text || '';
        textInputEl.maxLength = 240;
        fields.appendChild(textInputEl);

        const row = document.createElement('div');
        row.classList.add('brainDumpTaskCardRow');

        const matrixSelectEl = document.createElement('select');
        matrixSelectEl.classList.add('brainDumpTaskCardMatrix');
        BRAIN_DUMP_MATRIX_OPTIONS.forEach((option) => {
            const opt = document.createElement('option');
            opt.value = option.value;
            opt.textContent = option.label;
            matrixSelectEl.appendChild(opt);
        });
        matrixSelectEl.value = BRAIN_DUMP_MATRIX_OPTIONS.some((o) => o.value === draft.matrix) ? draft.matrix : 'schedule';
        row.appendChild(matrixSelectEl);

        const difficultySelectEl = document.createElement('select');
        difficultySelectEl.classList.add('brainDumpTaskCardDifficulty');
        BRAIN_DUMP_DIFFICULTY_OPTIONS.forEach((option) => {
            const opt = document.createElement('option');
            opt.value = String(option.value);
            opt.textContent = option.label;
            difficultySelectEl.appendChild(opt);
        });
        const parsedDifficulty = Number(draft.difficulty);
        difficultySelectEl.value = (Number.isInteger(parsedDifficulty) && parsedDifficulty >= 1 && parsedDifficulty <= 5)
            ? String(parsedDifficulty)
            : '3';
        row.appendChild(difficultySelectEl);

        const dueAtWrap = document.createElement('div');
        dueAtWrap.classList.add('brainDumpTaskCardDeadlineWrap');
        const dueAtInputEl = document.createElement('input');
        dueAtInputEl.type = 'datetime-local';
        dueAtInputEl.classList.add('brainDumpTaskCardDeadline');
        if (draft.dueAt && !Number.isNaN(new Date(draft.dueAt).getTime())) {
            dueAtInputEl.value = brainDumpToDatetimeLocalValue(new Date(draft.dueAt));
        }
        dueAtWrap.appendChild(dueAtInputEl);
        // The bare native input's own calendar glyph is small and easy to
        // miss - an explicit button makes "click here to set a deadline"
        // obvious, same as every other deadline field in this app
        // (see .editorDeadlineWrap/.editorCalendarBtn).
        const dueAtCalendarBtn = document.createElement('button');
        dueAtCalendarBtn.type = 'button';
        dueAtCalendarBtn.classList.add('brainDumpTaskCardDeadlineBtn');
        dueAtCalendarBtn.setAttribute('aria-label', 'Set deadline');
        dueAtCalendarBtn.title = 'Set deadline';
        dueAtCalendarBtn.innerHTML = '<i class="fa-regular fa-calendar"></i>';
        dueAtCalendarBtn.addEventListener('click', () => {
            if (typeof dueAtInputEl.showPicker === 'function') {
                dueAtInputEl.showPicker();
            } else {
                dueAtInputEl.focus();
            }
        });
        dueAtWrap.appendChild(dueAtCalendarBtn);
        row.appendChild(dueAtWrap);
        fields.appendChild(row);

        // One subtask per line - simpler to read/edit than a full dynamic
        // add/remove-row UI, and matches how short these lists actually are.
        // Sized to its actual line count (via the rows attribute, not a
        // fixed height + scrollbar) so every step is visible without
        // scrolling, and grows/shrinks live as the user edits it.
        const subtasksInputEl = document.createElement('textarea');
        subtasksInputEl.classList.add('brainDumpTaskCardSubtasks');
        subtasksInputEl.placeholder = 'Steps (one per line, optional)';
        subtasksInputEl.value = Array.isArray(draft.subtasks) ? draft.subtasks.filter(Boolean).join('\n') : '';
        const resizeSubtasksInput = () => {
            subtasksInputEl.rows = Math.min(8, Math.max(2, subtasksInputEl.value.split('\n').length));
        };
        resizeSubtasksInput();
        subtasksInputEl.addEventListener('input', resizeSubtasksInput);
        fields.appendChild(subtasksInputEl);

        card.appendChild(header);
        card.appendChild(fields);

        const read = () => ({
            included: checkbox.checked,
            text: textInputEl.value,
            matrix: matrixSelectEl.value,
            difficulty: difficultySelectEl.value,
            taskType: draft.taskType || 'open',
            estimateMinutes: draft.estimateMinutes || null,
            dueAt: dueAtInputEl.value ? new Date(dueAtInputEl.value).toISOString() : null,
            scheduledAt: draft.scheduledAt || null,
            subtasks: subtasksInputEl.value.split('\n').map((line) => line.trim()).filter(Boolean)
        });

        const markAdded = () => {
            fields.querySelectorAll('input, select, textarea').forEach((el) => { el.disabled = true; });
            checkbox.disabled = true;
            checkbox.checked = false;
            addOneBtn.remove();
            const addedLabel = document.createElement('span');
            addedLabel.classList.add('brainDumpTaskCardAddedLabel');
            addedLabel.textContent = 'Added';
            header.appendChild(addedLabel);
        };

        addOneBtn.addEventListener('click', async () => {
            const draftNow = read();
            if (!draftNow.text.trim()) {
                return;
            }
            addOneBtn.disabled = true;
            addOneBtn.textContent = 'Adding...';
            try {
                await commitTasks([draftNow]);
                markAdded();
            } catch (error) {
                console.error('Failed to add brain-dump task:', error);
                addOneBtn.disabled = false;
                addOneBtn.textContent = 'Try again';
            }
        });

        return { element: card, read, markAdded };
    }

    function appendTaskReview(tasks, typeLabel) {
        if (!tasks || tasks.length === 0) {
            return;
        }

        const section = document.createElement('div');
        section.classList.add('brainDumpTaskReview');

        if (typeLabel) {
            const label = document.createElement('p');
            label.classList.add('brainDumpReviewTypeLabel');
            label.textContent = typeLabel;
            section.appendChild(label);
        }

        const cards = tasks.map((draft) => {
            const { element, read } = createTaskReviewCard(draft);
            section.appendChild(element);
            return { read };
        });

        const footer = document.createElement('div');
        footer.classList.add('brainDumpTaskReviewFooter');

        const status = document.createElement('p');
        status.classList.add('brainDumpTaskReviewStatus');
        footer.appendChild(status);

        // Not a static count in the label - individual "Add" buttons on
        // each card (see createTaskReviewCard) can change how many are
        // actually still checked before this is ever clicked.
        const addBtnLabel = 'Add checked tasks';
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.classList.add('brainDumpAddBtn');
        addBtn.textContent = addBtnLabel;
        addBtn.addEventListener('click', async () => {
            const confirmed = cards.map((card) => card.read()).filter((draft) => draft.included && draft.text.trim());
            if (confirmed.length === 0) {
                status.textContent = 'Nothing checked to add.';
                return;
            }

            addBtn.disabled = true;
            addBtn.textContent = 'Adding...';
            try {
                await commitTasks(confirmed);
                section.innerHTML = '';
                const done = document.createElement('p');
                done.classList.add('brainDumpTaskReviewDone');
                done.textContent = confirmed.length === 1 ? 'Added 1 task.' : `Added ${confirmed.length} tasks.`;
                section.appendChild(done);
                scrollToBottom();
            } catch (error) {
                console.error('Failed to add brain-dump tasks:', error);
                addBtn.disabled = false;
                addBtn.textContent = addBtnLabel;
                status.textContent = 'Could not add those - try again.';
            }
        });
        footer.appendChild(addBtn);

        section.appendChild(footer);
        messagesEl.appendChild(section);
        scrollToBottom();
    }

    // "Edit an existing task" draft - only ever populated when the user
    // explicitly asked to change a specific task (see the EDITING EXISTING
    // TASKS rule in the Worker's system instruction). Only whichever of
    // matrix/difficulty/dueAt/scheduledAt/completed Gemini actually
    // proposed changing get a control here - never a field the draft didn't
    // touch, so confirming this can't silently reset something the user
    // never asked about. taskId is the only thing that actually matters for
    // the write; commitTaskEdits (script.js/group.js) independently
    // re-checks it against the real, already-loaded task list before
    // applying anything - never trusted blind, same discipline as
    // commitComments/commitSuggestions.
    function createTaskEditReviewCard(draft) {
        const card = document.createElement('div');
        card.classList.add('brainDumpTaskCard');

        const header = document.createElement('div');
        header.classList.add('brainDumpTaskCardHeader');

        const checkboxLabel = document.createElement('label');
        checkboxLabel.classList.add('brainDumpTaskCardCheck');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = true;
        checkboxLabel.appendChild(checkbox);
        header.appendChild(checkboxLabel);

        const applyOneBtn = document.createElement('button');
        applyOneBtn.type = 'button';
        applyOneBtn.classList.add('brainDumpTaskCardAddBtn');
        applyOneBtn.textContent = 'Apply';
        header.appendChild(applyOneBtn);

        const fields = document.createElement('div');
        fields.classList.add('brainDumpTaskCardFields');

        const targetLabel = document.createElement('p');
        targetLabel.classList.add('brainDumpTaskCardTarget');
        targetLabel.textContent = `Editing: "${draft.taskPreview || 'this task'}"`;
        fields.appendChild(targetLabel);

        // Only a field genuinely present on the draft (including an
        // explicit null, meaning "clear this") gets a row + a read()
        // contribution - hasOwnProperty, not a truthiness check, so an
        // explicit dueAt:null (clear the deadline) still gets its own row
        // instead of being silently skipped like an omitted field would be.
        const fieldReaders = {};

        if (Object.prototype.hasOwnProperty.call(draft, 'matrix') && draft.matrix) {
            const row = document.createElement('label');
            row.classList.add('brainDumpTaskEditRow');
            const labelSpan = document.createElement('span');
            labelSpan.textContent = 'Matrix';
            row.appendChild(labelSpan);
            const select = document.createElement('select');
            BRAIN_DUMP_MATRIX_OPTIONS.forEach((option) => {
                const opt = document.createElement('option');
                opt.value = option.value;
                opt.textContent = option.label;
                select.appendChild(opt);
            });
            select.value = BRAIN_DUMP_MATRIX_OPTIONS.some((o) => o.value === draft.matrix) ? draft.matrix : 'schedule';
            row.appendChild(select);
            fields.appendChild(row);
            fieldReaders.matrix = () => select.value;
        }

        if (Object.prototype.hasOwnProperty.call(draft, 'difficulty') && draft.difficulty) {
            const row = document.createElement('label');
            row.classList.add('brainDumpTaskEditRow');
            const labelSpan = document.createElement('span');
            labelSpan.textContent = 'Difficulty';
            row.appendChild(labelSpan);
            const select = document.createElement('select');
            BRAIN_DUMP_DIFFICULTY_OPTIONS.forEach((option) => {
                const opt = document.createElement('option');
                opt.value = String(option.value);
                opt.textContent = option.label;
                select.appendChild(opt);
            });
            const parsedDifficulty = Number(draft.difficulty);
            select.value = (Number.isInteger(parsedDifficulty) && parsedDifficulty >= 1 && parsedDifficulty <= 5)
                ? String(parsedDifficulty)
                : '3';
            row.appendChild(select);
            fields.appendChild(row);
            fieldReaders.difficulty = () => select.value;
        }

        const addDateRow = (fieldKey, label) => {
            if (!Object.prototype.hasOwnProperty.call(draft, fieldKey)) {
                return;
            }
            const row = document.createElement('label');
            row.classList.add('brainDumpTaskEditRow');
            const labelSpan = document.createElement('span');
            labelSpan.textContent = label;
            row.appendChild(labelSpan);
            const wrap = document.createElement('div');
            wrap.classList.add('brainDumpTaskCardDeadlineWrap');
            const input = document.createElement('input');
            input.type = 'datetime-local';
            input.classList.add('brainDumpTaskCardDeadline');
            const value = draft[fieldKey];
            if (value && !Number.isNaN(new Date(value).getTime())) {
                input.value = brainDumpToDatetimeLocalValue(new Date(value));
            }
            wrap.appendChild(input);
            const calendarBtn = document.createElement('button');
            calendarBtn.type = 'button';
            calendarBtn.classList.add('brainDumpTaskCardDeadlineBtn');
            calendarBtn.setAttribute('aria-label', `Set ${label.toLowerCase()}`);
            calendarBtn.innerHTML = '<i class="fa-solid fa-calendar"></i>';
            calendarBtn.addEventListener('click', () => {
                if (typeof input.showPicker === 'function') {
                    input.showPicker();
                } else {
                    input.focus();
                }
            });
            wrap.appendChild(calendarBtn);
            row.appendChild(wrap);
            fields.appendChild(row);
            fieldReaders[fieldKey] = () => (input.value ? new Date(input.value).toISOString() : null);
        };
        addDateRow('dueAt', 'Deadline');
        addDateRow('scheduledAt', 'Schedule');

        if (Object.prototype.hasOwnProperty.call(draft, 'completed')) {
            const row = document.createElement('label');
            row.classList.add('brainDumpTaskEditRow', 'brainDumpTaskEditCompletedRow');
            const completedCheckbox = document.createElement('input');
            completedCheckbox.type = 'checkbox';
            completedCheckbox.checked = Boolean(draft.completed);
            row.appendChild(completedCheckbox);
            const labelSpan = document.createElement('span');
            labelSpan.textContent = 'Mark as completed';
            row.appendChild(labelSpan);
            fields.appendChild(row);
            fieldReaders.completed = () => completedCheckbox.checked;
        }

        card.appendChild(header);
        card.appendChild(fields);

        const read = () => {
            const result = { included: checkbox.checked, taskId: draft.taskId };
            Object.keys(fieldReaders).forEach((key) => { result[key] = fieldReaders[key](); });
            return result;
        };

        const markApplied = () => {
            fields.querySelectorAll('input, select').forEach((el) => { el.disabled = true; });
            checkbox.disabled = true;
            checkbox.checked = false;
            applyOneBtn.remove();
            const appliedLabel = document.createElement('span');
            appliedLabel.classList.add('brainDumpTaskCardAddedLabel');
            appliedLabel.textContent = 'Applied';
            header.appendChild(appliedLabel);
        };

        applyOneBtn.addEventListener('click', async () => {
            const draftNow = read();
            applyOneBtn.disabled = true;
            applyOneBtn.textContent = 'Applying...';
            try {
                await commitTaskEdits([draftNow]);
                markApplied();
            } catch (error) {
                console.error('Failed to apply brain-dump task edit:', error);
                applyOneBtn.disabled = false;
                applyOneBtn.textContent = 'Try again';
            }
        });

        return { element: card, read };
    }

    function appendTaskEditReview(edits, typeLabel) {
        if (!commitTaskEdits || !edits || edits.length === 0) {
            return;
        }
        appendReviewSection({
            drafts: edits,
            buildCard: createTaskEditReviewCard,
            commit: commitTaskEdits,
            sectionClass: 'brainDumpTaskEditReview',
            addBtnLabel: 'Apply checked changes',
            doneLabel: 'Updated',
            typeLabel
        });
    }

    // Shared checkbox-then-bulk-confirm footer scaffolding for the two
    // teammate-facing review types below (suggestions/comments) - same
    // shape as appendTaskReview above, factored out so those two don't
    // each duplicate the whole "read every card, filter to checked,
    // bulk-commit, show a result line" dance.
    function appendReviewSection({ drafts, buildCard, commit, sectionClass, addBtnLabel, doneLabel, typeLabel }) {
        const section = document.createElement('div');
        section.classList.add('brainDumpTaskReview', sectionClass);

        // Section J: a type-label chip at the top, but only when the caller
        // says this response mixed more than one review type together
        // (tasks + suggestions + comments + memories all in one reply is a
        // lot to parse as one undifferentiated scroll - Miller's Law). A
        // response with just one type carries no label, since there's
        // nothing to disambiguate.
        if (typeLabel) {
            const label = document.createElement('p');
            label.classList.add('brainDumpReviewTypeLabel');
            label.textContent = typeLabel;
            section.appendChild(label);
        }

        const cards = drafts.map((draft) => {
            const { element, read } = buildCard(draft);
            section.appendChild(element);
            return { read };
        });

        const footer = document.createElement('div');
        footer.classList.add('brainDumpTaskReviewFooter');

        const status = document.createElement('p');
        status.classList.add('brainDumpTaskReviewStatus');
        footer.appendChild(status);

        const bulkBtn = document.createElement('button');
        bulkBtn.type = 'button';
        bulkBtn.classList.add('brainDumpAddBtn');
        bulkBtn.textContent = addBtnLabel;
        bulkBtn.addEventListener('click', async () => {
            // draft.text === undefined check: task-edit drafts (see
            // createTaskEditReviewCard) have no text field at all, unlike
            // every other review type this scaffold serves - a bare
            // draft.text.trim() threw a TypeError for them, crashing the
            // whole bulk-apply click silently (an unhandled rejection, no
            // status message). Every other type still gets the exact same
            // empty-text filtering as before; task edits fall through to
            // whatever their own commit function already validates
            // (findTaskById/groupTasks.find), same as it always did. Real
            // bug caught by code review.
            const confirmed = cards.map((card) => card.read())
                .filter((draft) => draft.included && (draft.text === undefined || draft.text.trim()));
            if (confirmed.length === 0) {
                status.textContent = 'Nothing checked.';
                return;
            }

            bulkBtn.disabled = true;
            bulkBtn.textContent = 'Sending...';
            try {
                await commit(confirmed);
                section.innerHTML = '';
                const done = document.createElement('p');
                done.classList.add('brainDumpTaskReviewDone');
                done.textContent = confirmed.length === 1 ? `${doneLabel} 1.` : `${doneLabel} ${confirmed.length}.`;
                section.appendChild(done);
                scrollToBottom();
            } catch (error) {
                console.error('Failed to commit brain-dump review section:', error);
                bulkBtn.disabled = false;
                bulkBtn.textContent = addBtnLabel;
                status.textContent = 'Something went wrong - try again.';
            }
        });
        footer.appendChild(bulkBtn);

        section.appendChild(footer);
        messagesEl.appendChild(section);
        scrollToBottom();
    }

    // "Suggest a task for a teammate" draft - only ever rendered when Dusty
    // was explicitly asked to suggest something to a named group member
    // (see the Worker's system prompt). Confirming here calls
    // commitSuggestions, which resolves forMemberName to a real uid against
    // the CURRENT group's live roster and posts through the exact same
    // suggestTaskForMember() a manual suggestion already uses - the
    // teammate still has to accept it from their own Suggestions for You
    // panel before it becomes a real task, same as any other suggestion.
    function createSuggestionReviewCard(draft) {
        const card = document.createElement('div');
        card.classList.add('brainDumpTaskCard');

        const header = document.createElement('div');
        header.classList.add('brainDumpTaskCardHeader');

        const checkboxLabel = document.createElement('label');
        checkboxLabel.classList.add('brainDumpTaskCardCheck');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = true;
        checkboxLabel.appendChild(checkbox);
        header.appendChild(checkboxLabel);

        const sendOneBtn = document.createElement('button');
        sendOneBtn.type = 'button';
        sendOneBtn.classList.add('brainDumpTaskCardAddBtn');
        sendOneBtn.textContent = 'Send';
        header.appendChild(sendOneBtn);

        const fields = document.createElement('div');
        fields.classList.add('brainDumpTaskCardFields');

        const targetLabel = document.createElement('p');
        targetLabel.classList.add('brainDumpTaskCardTarget');
        targetLabel.textContent = `Suggesting to: ${draft.forMemberName || 'Unknown'}`;
        fields.appendChild(targetLabel);

        const textInputEl = document.createElement('input');
        textInputEl.type = 'text';
        textInputEl.classList.add('brainDumpTaskCardText');
        textInputEl.value = draft.text || '';
        textInputEl.maxLength = 240;
        fields.appendChild(textInputEl);

        const row = document.createElement('div');
        row.classList.add('brainDumpTaskCardRow');

        const matrixSelectEl = document.createElement('select');
        matrixSelectEl.classList.add('brainDumpTaskCardMatrix');
        BRAIN_DUMP_MATRIX_OPTIONS.forEach((option) => {
            const opt = document.createElement('option');
            opt.value = option.value;
            opt.textContent = option.label;
            matrixSelectEl.appendChild(opt);
        });
        matrixSelectEl.value = BRAIN_DUMP_MATRIX_OPTIONS.some((o) => o.value === draft.matrix) ? draft.matrix : 'schedule';
        row.appendChild(matrixSelectEl);

        const difficultySelectEl = document.createElement('select');
        difficultySelectEl.classList.add('brainDumpTaskCardDifficulty');
        BRAIN_DUMP_DIFFICULTY_OPTIONS.forEach((option) => {
            const opt = document.createElement('option');
            opt.value = String(option.value);
            opt.textContent = option.label;
            difficultySelectEl.appendChild(opt);
        });
        const parsedDifficulty = Number(draft.difficulty);
        difficultySelectEl.value = (Number.isInteger(parsedDifficulty) && parsedDifficulty >= 1 && parsedDifficulty <= 5)
            ? String(parsedDifficulty)
            : '3';
        row.appendChild(difficultySelectEl);

        const dueAtWrap = document.createElement('div');
        dueAtWrap.classList.add('brainDumpTaskCardDeadlineWrap');
        const dueAtInputEl = document.createElement('input');
        dueAtInputEl.type = 'datetime-local';
        dueAtInputEl.classList.add('brainDumpTaskCardDeadline');
        if (draft.dueAt && !Number.isNaN(new Date(draft.dueAt).getTime())) {
            dueAtInputEl.value = brainDumpToDatetimeLocalValue(new Date(draft.dueAt));
        }
        dueAtWrap.appendChild(dueAtInputEl);
        const dueAtCalendarBtn = document.createElement('button');
        dueAtCalendarBtn.type = 'button';
        dueAtCalendarBtn.classList.add('brainDumpTaskCardDeadlineBtn');
        dueAtCalendarBtn.setAttribute('aria-label', 'Set deadline');
        dueAtCalendarBtn.title = 'Set deadline';
        dueAtCalendarBtn.innerHTML = '<i class="fa-regular fa-calendar"></i>';
        dueAtCalendarBtn.addEventListener('click', () => {
            if (typeof dueAtInputEl.showPicker === 'function') {
                dueAtInputEl.showPicker();
            } else {
                dueAtInputEl.focus();
            }
        });
        dueAtWrap.appendChild(dueAtCalendarBtn);
        row.appendChild(dueAtWrap);
        fields.appendChild(row);

        card.appendChild(header);
        card.appendChild(fields);

        const read = () => ({
            included: checkbox.checked,
            forMemberName: draft.forMemberName,
            text: textInputEl.value,
            matrix: matrixSelectEl.value,
            difficulty: difficultySelectEl.value,
            dueAt: dueAtInputEl.value ? new Date(dueAtInputEl.value).toISOString() : null
        });

        const markSent = () => {
            fields.querySelectorAll('input, select').forEach((el) => { el.disabled = true; });
            checkbox.disabled = true;
            checkbox.checked = false;
            sendOneBtn.remove();
            const sentLabel = document.createElement('span');
            sentLabel.classList.add('brainDumpTaskCardAddedLabel');
            sentLabel.textContent = 'Sent';
            header.appendChild(sentLabel);
        };

        sendOneBtn.addEventListener('click', async () => {
            const draftNow = read();
            if (!draftNow.text.trim()) {
                return;
            }
            sendOneBtn.disabled = true;
            sendOneBtn.textContent = 'Sending...';
            try {
                await commitSuggestions([draftNow]);
                markSent();
            } catch (error) {
                console.error('Failed to send brain-dump suggestion:', error);
                sendOneBtn.disabled = false;
                sendOneBtn.textContent = 'Try again';
            }
        });

        return { element: card, read };
    }

    // "Comment on a teammate's task" draft - same explicit-ask-only gating
    // as suggestions above. taskId/taskPreview both come straight from
    // Gemini, but only taskId is ever used for the actual write, and
    // commitComments (group.js) independently re-checks it against the
    // group's own live, already-loaded task list before posting - never
    // trusted blind.
    function createCommentReviewCard(draft) {
        const card = document.createElement('div');
        card.classList.add('brainDumpTaskCard');

        const header = document.createElement('div');
        header.classList.add('brainDumpTaskCardHeader');

        const checkboxLabel = document.createElement('label');
        checkboxLabel.classList.add('brainDumpTaskCardCheck');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = true;
        checkboxLabel.appendChild(checkbox);
        header.appendChild(checkboxLabel);

        const postOneBtn = document.createElement('button');
        postOneBtn.type = 'button';
        postOneBtn.classList.add('brainDumpTaskCardAddBtn');
        postOneBtn.textContent = 'Post';
        header.appendChild(postOneBtn);

        const fields = document.createElement('div');
        fields.classList.add('brainDumpTaskCardFields');

        const targetLabel = document.createElement('p');
        targetLabel.classList.add('brainDumpTaskCardTarget');
        targetLabel.textContent = `Commenting on ${draft.memberName || 'teammate'}'s task: "${draft.taskPreview || ''}"`;
        fields.appendChild(targetLabel);

        // Reuses the subtasks textarea's auto-sizing styling/behavior -
        // same "grow to line count, no forced scrolling" treatment.
        const textInputEl = document.createElement('textarea');
        textInputEl.classList.add('brainDumpTaskCardSubtasks');
        textInputEl.value = draft.text || '';
        textInputEl.maxLength = 500;
        const resizeInput = () => {
            textInputEl.rows = Math.min(6, Math.max(2, textInputEl.value.split('\n').length));
        };
        resizeInput();
        textInputEl.addEventListener('input', resizeInput);
        fields.appendChild(textInputEl);

        card.appendChild(header);
        card.appendChild(fields);

        const read = () => ({
            included: checkbox.checked,
            taskId: draft.taskId,
            memberName: draft.memberName,
            taskPreview: draft.taskPreview,
            text: textInputEl.value
        });

        const markPosted = () => {
            textInputEl.disabled = true;
            checkbox.disabled = true;
            checkbox.checked = false;
            postOneBtn.remove();
            const postedLabel = document.createElement('span');
            postedLabel.classList.add('brainDumpTaskCardAddedLabel');
            postedLabel.textContent = 'Posted';
            header.appendChild(postedLabel);
        };

        postOneBtn.addEventListener('click', async () => {
            const draftNow = read();
            if (!draftNow.text.trim()) {
                return;
            }
            postOneBtn.disabled = true;
            postOneBtn.textContent = 'Posting...';
            try {
                await commitComments([draftNow]);
                markPosted();
            } catch (error) {
                console.error('Failed to post brain-dump comment:', error);
                postOneBtn.disabled = false;
                postOneBtn.textContent = 'Try again';
            }
        });

        return { element: card, read };
    }

    function appendSuggestionReview(suggestions, typeLabel) {
        if (!commitSuggestions || !suggestions || suggestions.length === 0) {
            return;
        }
        appendReviewSection({
            drafts: suggestions,
            buildCard: createSuggestionReviewCard,
            commit: commitSuggestions,
            sectionClass: 'brainDumpSuggestionReview',
            addBtnLabel: 'Send checked suggestions',
            doneLabel: 'Sent',
            typeLabel
        });
    }

    function appendCommentReview(comments, typeLabel) {
        if (!commitComments || !comments || comments.length === 0) {
            return;
        }
        appendReviewSection({
            drafts: comments,
            buildCard: createCommentReviewCard,
            commit: commitComments,
            sectionClass: 'brainDumpCommentReview',
            addBtnLabel: 'Post checked comments',
            doneLabel: 'Posted',
            typeLabel
        });
    }

    // "Remember this about me" draft - unlike suggestions/comments, Dusty
    // may propose one without being explicitly asked (see the Worker's
    // MEMORY prompt section), but it's still just a draft: nothing is
    // saved to users/{uid}/dustyMemory until confirmed here. Deliberately
    // simple - no matrix/difficulty/deadline, just a short editable fact.
    function createMemoryReviewCard(draft) {
        const card = document.createElement('div');
        card.classList.add('brainDumpTaskCard');

        const header = document.createElement('div');
        header.classList.add('brainDumpTaskCardHeader');

        const checkboxLabel = document.createElement('label');
        checkboxLabel.classList.add('brainDumpTaskCardCheck');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = true;
        checkboxLabel.appendChild(checkbox);
        header.appendChild(checkboxLabel);

        const rememberOneBtn = document.createElement('button');
        rememberOneBtn.type = 'button';
        rememberOneBtn.classList.add('brainDumpTaskCardAddBtn');
        rememberOneBtn.textContent = 'Remember';
        header.appendChild(rememberOneBtn);

        const fields = document.createElement('div');
        fields.classList.add('brainDumpTaskCardFields');

        const targetLabel = document.createElement('p');
        targetLabel.classList.add('brainDumpTaskCardTarget');
        targetLabel.textContent = 'Remember this about you:';
        fields.appendChild(targetLabel);

        const textInputEl = document.createElement('input');
        textInputEl.type = 'text';
        textInputEl.classList.add('brainDumpTaskCardText');
        textInputEl.value = draft.text || '';
        textInputEl.maxLength = 300;
        fields.appendChild(textInputEl);

        card.appendChild(header);
        card.appendChild(fields);

        const read = () => ({
            included: checkbox.checked,
            text: textInputEl.value
        });

        const markRemembered = () => {
            textInputEl.disabled = true;
            checkbox.disabled = true;
            checkbox.checked = false;
            rememberOneBtn.remove();
            const rememberedLabel = document.createElement('span');
            rememberedLabel.classList.add('brainDumpTaskCardAddedLabel');
            rememberedLabel.textContent = 'Saved';
            header.appendChild(rememberedLabel);
        };

        rememberOneBtn.addEventListener('click', async () => {
            const draftNow = read();
            if (!draftNow.text.trim()) {
                return;
            }
            rememberOneBtn.disabled = true;
            rememberOneBtn.textContent = 'Saving...';
            try {
                await commitMemories([draftNow]);
                markRemembered();
            } catch (error) {
                console.error('Failed to save brain-dump memory:', error);
                rememberOneBtn.disabled = false;
                rememberOneBtn.textContent = 'Try again';
            }
        });

        return { element: card, read };
    }

    function appendMemoryReview(memoryProposals, typeLabel) {
        if (!memoryProposals || memoryProposals.length === 0) {
            return;
        }
        appendReviewSection({
            drafts: memoryProposals,
            buildCard: createMemoryReviewCard,
            commit: commitMemories,
            sectionClass: 'brainDumpMemoryReview',
            addBtnLabel: 'Save checked memories',
            doneLabel: 'Saved',
            typeLabel
        });
    }

    // Writes confirmed memories straight to users/{uid}/dustyMemory - kept
    // self-contained here (unlike commitTasks/commitSuggestions/
    // commitComments, which differ between solo and group and so are
    // supplied by each page) since this write is identical regardless of
    // which page Brain Dump is open from. knownMemoryCount is a best-effort
    // local count refreshed each time gatherDustyMemories runs (see
    // sendMessage) - a soft nudge to stop offering new saves once someone
    // has a lot stored, not a hard security limit (firestore.rules doesn't
    // cap the count, only each memory's own text length).
    let knownMemoryCount = 0;
    async function commitMemories(drafts) {
        const user = window.ToDoAuth?.auth?.currentUser;
        if (!user) {
            throw new Error('Not signed in.');
        }
        const { db, firestore } = window.ToDoAuth;
        const { doc, setDoc, collection, serverTimestamp } = firestore;

        for (const draft of drafts) {
            const trimmedText = (draft.text || '').trim();
            if (!trimmedText) {
                continue;
            }
            if (knownMemoryCount >= BRAIN_DUMP_MEMORY_SOFT_LIMIT) {
                console.error('Brain Dump: memory soft limit reached - skipped saving the rest of this batch. Delete some old ones from Settings first.');
                break;
            }
            await setDoc(doc(collection(db, 'users', user.uid, 'dustyMemory'), generateTaskId()), {
                text: trimmedText.slice(0, 300),
                createdAt: serverTimestamp()
            });
            knownMemoryCount += 1;
        }
    }

    function renderAttachmentChips() {
        attachmentsRowEl.innerHTML = '';
        pendingAttachments.forEach((attachment, index) => {
            const chip = document.createElement('span');
            chip.classList.add('brainDumpAttachmentChip');
            // The filename truncates inside its OWN bounded span - a long
            // name used to overflow the whole chip's max-width and clip
            // the remove button right along with it, making it impossible
            // to click for anything but very short filenames.
            const nameSpan = document.createElement('span');
            nameSpan.classList.add('brainDumpAttachmentChipName');
            nameSpan.textContent = attachment.name;
            chip.appendChild(nameSpan);
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.setAttribute('aria-label', `Remove ${attachment.name}`);
            remove.innerHTML = '<i class="fa-solid fa-xmark"></i>';
            remove.addEventListener('click', () => {
                pendingAttachments.splice(index, 1);
                renderAttachmentChips();
            });
            chip.appendChild(remove);
            attachmentsRowEl.appendChild(chip);
        });
        attachmentsRowEl.classList.toggle('hidden', pendingAttachments.length === 0);
    }

    async function handleFilesSelected(fileList) {
        for (const file of Array.from(fileList)) {
            if (file.size > BRAIN_DUMP_MAX_FILE_BYTES) {
                appendErrorBubble(`"${file.name}" is too large (max 4MB) - skipped.`);
                continue;
            }
            try {
                const data = await readFileAsBase64(file);
                pendingAttachments.push({ mimeType: file.type || 'application/octet-stream', data, name: file.name });
            } catch (error) {
                console.error('Failed to read attachment:', error);
                appendErrorBubble(`Couldn't read "${file.name}" - skipped.`);
            }
        }
        renderAttachmentChips();
    }

    async function sendMessage() {
        const text = textInput.value.trim();
        if (!text && pendingAttachments.length === 0) {
            return;
        }
        if (isSending) {
            return;
        }

        const user = window.ToDoAuth?.auth?.currentUser;
        if (!user) {
            appendErrorBubble('Sign in first.');
            return;
        }

        if (BRAIN_DUMP_WORKER_URL.includes('REPLACE-ME')) {
            appendErrorBubble("Brain Dump isn't set up yet - see worker/README.md.");
            return;
        }

        const attachmentsForThisTurn = pendingAttachments;
        pendingAttachments = [];
        renderAttachmentChips();

        appendUserBubble(text || '(attachment only)', attachmentsForThisTurn.map((a) => a.name));
        textInput.value = '';
        textInput.style.height = 'auto';
        const priorHistory = history.slice(-BRAIN_DUMP_MAX_HISTORY_TURNS);
        history = [...priorHistory, { role: 'user', text }];

        isSending = true;
        sendBtn.disabled = true;
        const typingBubble = appendTypingIndicator();

        try {
            // Fetched together - the token and the workload snapshot are
            // independent reads, no reason to wait on one before starting
            // the other.
            const activeGroupId = typeof getCurrentGroupId === 'function' ? getCurrentGroupId() : null;
            const [idToken, taskContext, memories] = await Promise.all([
                user.getIdToken(),
                gatherTaskContext(user, activeGroupId),
                gatherDustyMemories(user)
            ]);
            // Best-effort refresh of the soft-limit counter (see
            // commitMemories) - a real Firestore read, so more reliable
            // than just incrementing locally forever, but still not load-
            // bearing for anything beyond "stop offering to save more".
            knownMemoryCount = memories.length;
            const response = await fetch(BRAIN_DUMP_WORKER_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
                body: JSON.stringify({
                    context,
                    message: text,
                    history: priorHistory,
                    attachments: attachmentsForThisTurn.map(({ mimeType, data }) => ({ mimeType, data })),
                    clientTime: getClientTimeString(),
                    taskContext,
                    memories,
                    // null on solo (no getCurrentGroupId passed at all) or
                    // when no group is currently selected - either way the
                    // Worker's prompt then has no group it's allowed to
                    // target, so teammateSuggestions/teammateComments come
                    // back empty regardless of what's asked. Same value
                    // already used above to scope gatherTaskContext's
                    // planning-signal reads - reused here rather than
                    // calling getCurrentGroupId() a second time.
                    currentGroupId: activeGroupId
                })
            });

            const data = await response.json().catch(() => null);
            typingBubble.remove();

            updateRateStatus(data?.rateLimit);

            if (!response.ok || !data) {
                appendErrorBubble(describeErrorResponse(response.status, data));
                return;
            }

            appendAssistantBubble(data.reply || "Here's what I found:", data.quickReplies);
            history = [...history, { role: 'assistant', text: data.reply || '' }].slice(-BRAIN_DUMP_MAX_HISTORY_TURNS);

            // Section J: a type-label chip only when this reply actually
            // mixed more than one kind of review card together - four
            // different card types in one undifferentiated scroll is a lot
            // to parse at once (Miller's Law), but a plain single-type
            // reply (the common case) doesn't need a label pointing out
            // what it obviously already is.
            const presentTypeCount = [data.tasks, data.teammateSuggestions, data.teammateComments, data.memoryProposals, data.taskEdits]
                .filter((list) => Array.isArray(list) && list.length > 0).length;
            const labelFor = (label) => (presentTypeCount > 1 ? label : undefined);

            appendTaskReview(data.tasks, labelFor('New tasks'));
            appendTaskEditReview(data.taskEdits, labelFor('Task changes'));
            appendSuggestionReview(data.teammateSuggestions, labelFor('Suggestions for teammates'));
            appendCommentReview(data.teammateComments, labelFor('Comments'));
            appendMemoryReview(data.memoryProposals, labelFor('Remembered facts'));
        } catch (error) {
            console.error('Brain dump request failed:', error);
            typingBubble.remove();
            appendErrorBubble("Couldn't reach the AI - check your connection and try again.");
        } finally {
            isSending = false;
            sendBtn.disabled = false;
        }
    }

    function build() {
        overlay = document.createElement('div');
        overlay.className = 'brainDumpOverlay';
        overlay.innerHTML = `
            <div class="brainDumpCard" role="dialog" aria-modal="true" aria-label="Chat with Dusty">
                <div class="brainDumpHeader">
                    <div class="brainDumpHeaderIdentity">
                        <div class="brainDumpHeaderAvatar">${buildDustyAvatarMarkup(40)}</div>
                        <div class="brainDumpHeaderText">
                            <h2>Dusty</h2>
                            <p class="brainDumpHeaderSubtitle">Brain dump assistant</p>
                        </div>
                    </div>
                    <button type="button" class="brainDumpCloseBtn" aria-label="Close">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
                <div class="brainDumpMessages"></div>
                <div class="brainDumpAttachmentsRow hidden"></div>
                <p class="brainDumpRateStatus hidden" aria-live="polite"></p>
                <form class="brainDumpComposer">
                    <button type="button" class="brainDumpAttachBtn" aria-label="Attach a photo or file" title="Attach a photo or file">
                        <i class="fa-solid fa-paperclip"></i>
                    </button>
                    <input type="file" class="brainDumpFileInput" accept="${BRAIN_DUMP_ACCEPTED_TYPES}" multiple hidden>
                    <textarea class="brainDumpTextInput" rows="1" placeholder="What's going on? Type it all out..." maxlength="4000"></textarea>
                    <button type="submit" class="brainDumpSendBtn" aria-label="Send">
                        <i class="fa-solid fa-paper-plane"></i>
                    </button>
                </form>
            </div>
        `;
        document.body.appendChild(overlay);

        messagesEl = overlay.querySelector('.brainDumpMessages');
        attachmentsRowEl = overlay.querySelector('.brainDumpAttachmentsRow');
        textInput = overlay.querySelector('.brainDumpTextInput');
        sendBtn = overlay.querySelector('.brainDumpSendBtn');
        fileInput = overlay.querySelector('.brainDumpFileInput');
        attachBtn = overlay.querySelector('.brainDumpAttachBtn');
        rateStatusEl = overlay.querySelector('.brainDumpRateStatus');
        const closeBtn = overlay.querySelector('.brainDumpCloseBtn');
        const composer = overlay.querySelector('.brainDumpComposer');

        composer.addEventListener('submit', (event) => {
            event.preventDefault();
            sendMessage();
        });
        textInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
            }
        });
        textInput.addEventListener('input', () => {
            textInput.style.height = 'auto';
            textInput.style.height = `${Math.min(textInput.scrollHeight, 160)}px`;
        });

        attachBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', () => {
            if (fileInput.files.length > 0) {
                handleFilesSelected(fileInput.files);
            }
            fileInput.value = '';
        });

        closeBtn.addEventListener('click', close);
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) {
                close();
            }
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && isOpen()) {
                close();
            }
        });
    }

    function open() {
        if (!overlay) {
            build();
        }
        overlay.classList.add('open');
        textInput.focus();
        // Dusty tucks away into the now-open chat card's own header
        // avatar rather than floating over it.
        fabEl?.classList.add('brainDumpFabHidden');
        maybeShowWelcomeBack();
    }

    // Plain, general greetings - no memory content quoted (tried that,
    // read as a flat, clinical readout no matter how it was phrased, plus
    // duplicated what the static header text already said). Just a warm
    // hello and a reminder of what she can help with, varied each time.
    const WELCOME_BACK_GREETINGS = [
        "Hey! I'm Dusty. Tell me what's going on and I'll help turn it into tasks.",
        "Welcome back! Whenever you're ready, just tell me what's on your mind.",
        "Hi again! Type out whatever's going on, I'll sort it into real tasks for you.",
        "Good to see you! Let me know what's up and I'll help you get it organized.",
        "Hey there! Brain-dump away, I'll help turn it into a plan."
    ];
    const LAST_WELCOME_GREETING_KEY = 'dustyLastWelcomeGreeting';

    // Never repeats the same greeting twice in a row (including across a
    // page reload, via localStorage).
    function pickWelcomeGreetingIndex() {
        let lastIndex = -1;
        try {
            lastIndex = Number(localStorage.getItem(LAST_WELCOME_GREETING_KEY));
        } catch {
            lastIndex = -1;
        }
        let index = Math.floor(Math.random() * WELCOME_BACK_GREETINGS.length);
        if (WELCOME_BACK_GREETINGS.length > 1 && index === lastIndex) {
            index = (index + 1) % WELCOME_BACK_GREETINGS.length;
        }
        try {
            localStorage.setItem(LAST_WELCOME_GREETING_KEY, String(index));
        } catch {
            // Non-fatal - worst case a repeat greeting slips through once.
        }
        return index;
    }

    // Fires once per fresh session (chat history is in-memory only and
    // resets on page reload - this replaces the old static intro line with
    // something that actually varies). Purely client-side - no Firestore
    // read, no Gemini call, shows instantly.
    function maybeShowWelcomeBack() {
        if (messagesEl.children.length > 0) {
            return; // already an ongoing conversation this session
        }
        appendAssistantBubble(WELCOME_BACK_GREETINGS[pickWelcomeGreetingIndex()]);
    }

    function close() {
        overlay?.classList.remove('open');
        fabEl?.classList.remove('brainDumpFabHidden');
        playGreetBurst();
    }

    return { open, close, isOpen };
}
