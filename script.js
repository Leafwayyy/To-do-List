const taskInput = document.querySelector('.taskInput');
const quickAddHint = document.querySelector('.quickAddHint');
const matrixSelect = document.querySelector('.matrixSelect');
const detailsToggleBtn = document.querySelector('.detailsToggleBtn');
const taskDetailsPanel = document.querySelector('.taskDetailsPanel');
const detailsMoreToggleBtn = document.querySelector('.detailsMoreToggleBtn');
const detailsMoreOptions = document.querySelector('.detailsMoreOptions');
const typePills = Array.from(document.querySelectorAll('.typePill'));
const durationChips = Array.from(document.querySelectorAll('.durationChip'));
const durationInput = document.querySelector('.durationInput');
const difficultySelect = document.querySelector('.difficultySelect');
const deadlineInput = document.querySelector('.deadlineInput');
const deadlineContainer = document.querySelector('.deadlineContainer');
const calendarBtn = document.querySelector('.calendarBtn');
const addBtn = document.querySelector('.addBtn');
const priorityToggle = document.querySelector('.priorityToggle');
const priorityModeHint = document.querySelector('.priorityModeHint');
const sortOnceBtn = document.querySelector('.sortOnceBtn');
const alertToggleBtn = document.querySelector('.alertToggleBtn');
const difficultyVisibilityToggle = document.querySelector('.difficultyVisibilityToggle');
const urgencyAlert = document.querySelector('.urgencyAlert');
const urgencyAlertText = document.querySelector('.urgencyAlertText');
const onboardingHint = document.querySelector('.onboardingHint');
const onboardingStartTourBtn = document.querySelector('.onboardingStartTourBtn');
const onboardingDismissBtn = document.querySelector('.onboardingDismissBtn');
const nextTaskPanel = document.querySelector('.nextTaskPanel');
const nextTaskTitle = document.querySelector('.nextTaskTitle');
const nextTaskReasons = document.querySelector('.nextTaskReasons');
const mainColumn = document.querySelector('.mainColumn');
const viewTabButtons = Array.from(document.querySelectorAll('.viewTab'));
const viewPanels = Array.from(document.querySelectorAll('.viewPanel'));
const activityMonthRow = document.querySelector('.activityMonthRow');
const activityDayLabels = document.querySelector('.activityDayLabels');
const activityGrid = document.querySelector('.activityGrid');
const activitySummary = document.querySelector('.activitySummary');
const activityPanel = document.querySelector('.activityPanel');
// .schedulePresetBtn also carries .deadlinePresetBtn (shared pill styling
// only, not the deadline click handler), so it's excluded here.
const deadlinePresetButtons = Array.from(document.querySelectorAll('.deadlinePresetBtn:not(.schedulePresetBtn)'));
const schedulePresetButtons = Array.from(document.querySelectorAll('.schedulePresetBtn'));
const scheduleInput = document.querySelector('.scheduleInput');
const scheduleContainer = document.querySelector('.scheduleContainer');
const taskViewButtons = Array.from(document.querySelectorAll('.taskViewBtn'));
const overdueViewButton = document.querySelector('.taskViewBtn[data-view="overdue"]');
const overdueCountBadge = overdueViewButton?.querySelector('.overdueCountBadge');
const tasksList = document.querySelector('.tasks');
const progressBar = document.querySelector('.progressBar');
const motivatorText = document.querySelector('.motivatorText');
const taskAmountText = document.querySelector('.taskAmount');
const activityDetailsOverlay = document.querySelector('.activityDetailsOverlay');
const activityDetailsTitle = document.querySelector('.activityDetailsTitle');
const activityDetailsMeta = document.querySelector('.activityDetailsMeta');
const activityDetailsList = document.querySelector('.activityDetailsList');
const activityDetailsCloseBtn = document.querySelector('.activityDetailsCloseBtn');
const undoToast = document.querySelector('.undoToast');
const undoToastText = document.querySelector('.undoToastText');
const undoDeleteBtn = document.querySelector('.undoDeleteBtn');
// .tour* element lookups now live inside createTourController (task-shared.js).
// All .auth*/.userBadge* element lookups now live in auth-gate.js (shared
// with the group app), not here.

const rewardOverlay = document.querySelector('.rewardOverlay');
const rewardCard = document.querySelector('.rewardCard');
const confettiField = document.querySelector('.confettiField');
const rewardTitle = document.querySelector('.rewardTitle');
const rewardReelViewport = document.querySelector('.rewardReelViewport');
const rewardReelTrack = document.querySelector('.rewardReelTrack');
const rewardSuggestionText = document.querySelector('.rewardSuggestionText');
const rewardCloseBtn = document.querySelector('.rewardCloseBtn');

const STORAGE_KEY = 'todoTasksV3';
const PREV_STORAGE_KEY = 'todoTasksV2';
const LEGACY_STORAGE_KEY = 'todoTasks';
const SETTINGS_KEY = 'todoSettingsV1';
const ACTIVITY_KEY = 'todoActivityV1';
const ACTIVITY_HISTORY_KEY = 'todoActivityHistoryV1';
const CELEBRATED_DAILY_CLEAR_KEY = 'todoCelebratedDailyClearDate';
const COACH_KEY = 'todoCoachV1';
// Set once at sign-in (see AuthGate.init below) - whether THIS account
// predates account-level tour tracking, so renderOnboardingHint() can hide
// its "Start tutorial" prompt for it entirely, not just via its usual
// per-browser dismiss state (which a legacy account in a fresh browser
// would never have set).
let isLegacyTourAccount = false;

// MATRIX_CONFIG and DIFFICULTY_CONFIG now live in task-shared.js (loaded
// before this file - see index.html), shared with the group app.

// TASK_TYPE_CONFIG now lives in task-shared.js.

// REWARD_SUGGESTIONS now lives in task-shared.js, shared with the group app.

// REEL_TILE_WIDTH/REEL_TILE_GAP/REEL_TILE_STEP/REEL_FILLER_COUNT/
// REEL_LANDING_INDEX now live in task-shared.js.

const VIEW_CONFIG = {
    all: { emptyMessage: 'No tasks yet. Add one to get started.' },
    focus: { emptyMessage: 'No focus tasks right now.' },
    overdue: { emptyMessage: 'No overdue tasks. Nice work.' },
    today: { emptyMessage: 'No tasks due today.' },
    week: { emptyMessage: 'No tasks due this week.' },
    completed: { emptyMessage: 'No completed tasks yet.' }
};

let tasks = [];
let isAutoPrioritize = false;
let activeView = 'all';
let dragSourceTaskId = null;
let realtimeIntervalId = null;
let lastRealtimeBucket = -1;
let lastActivityRenderDateKey = '';
let taskEditorOverlay = null;
let activeEditorTaskId = null;
const stageReminderTimestamps = new Map();
let lastGlobalReminderAt = 0;
let popupAlertsEnabled = false;
let showDifficultyBadgesOnMobile = true;
let activityCountsByDate = {};
let activityHistoryByDate = {};
let activityTooltip = null;
let pendingDeletedTask = null;
let undoDeleteTimeoutId = null;
let pendingSubtaskFocusTaskId = null;
let quickAddHintTimeoutId = null;
const expandedSnoozeTaskIds = new Set();
let sessionCompletionCount = 0;
let unsubscribeCloudTasks = null;
let knownCloudTaskIds = new Set();
let hasLoadedCloudTasksOnce = false;

const REMINDER_COOLDOWN_MS = {
    soon: 45 * 60 * 1000,
    critical: 20 * 60 * 1000,
    overdue: 30 * 60 * 1000
};

const GLOBAL_REMINDER_GAP_MS = 8 * 60 * 1000;
const MOBILE_LAYOUT_QUERY = window.matchMedia('(max-width: 900px)');
const UNDO_DELETE_TIMEOUT_MS = 6000;

const TOUR_STEPS = [
    {
        selector: '.inputContainer',
        title: 'Add a task quickly',
        text: 'Type your task here, then press + or Enter to add it. Try typing a time too, like "tomorrow 3pm" - it\'s picked up automatically.',
        beforeShow: () => switchSoloView('tasks')
    },
    {
        selector: '.viewTabs',
        title: 'Tasks and Activity',
        text: 'Everything you\'re working on lives under Tasks. Switch to Activity any time to see your completion history.',
        beforeShow: () => switchSoloView('tasks')
    },
    {
        selector: '.detailsToggleBtn',
        title: 'Open smart options',
        text: 'Use Prioritize to set matrix and difficulty - the two that matter most for sort order. More options underneath adds estimate, deadline, and schedule.',
        beforeShow: () => { switchSoloView('tasks'); setDetailsPanelOpen(true); }
    },
    {
        selector: '.deadlineContainer',
        title: 'Deadline vs. schedule',
        text: 'Deadline is when it\'s due. Schedule is when you actually plan to work on it - two different things, both optional.',
        // Both fields live behind "More options" now (Hick's Law, section
        // C) - open that too, not just the outer panel, or this step would
        // highlight a display:none element with nothing visible to point at.
        beforeShow: () => { switchSoloView('tasks'); setDetailsPanelOpen(true); setDetailsMoreOptionsOpen(true); }
    },
    {
        selector: '.priorityControls',
        title: 'Choose sorting mode',
        text: 'Auto-sort keeps tasks ranked. Sort once now gives a one-time smart order.',
        beforeShow: () => switchSoloView('tasks')
    },
    {
        selector: '.taskViews',
        title: 'Switch views',
        text: 'Jump straight to what\'s overdue, due today, this week, or already done.',
        beforeShow: () => switchSoloView('tasks')
    },
    {
        selector: '.activityPanel',
        title: 'Track completed work',
        text: 'Tap any day in Daily Activity to see completion history details.',
        beforeShow: () => switchSoloView('activity')
    },
    {
        selector: '.groupNavLink',
        title: 'Working with a team?',
        text: 'Click Group up here to create a shared workspace - everyone\'s tasks, progress, and deadlines in one place.',
        beforeShow: () => switchSoloView('tasks')
    },
    {
        selector: '.brainDumpToggleBtn',
        title: 'Meet Dusty',
        text: 'Tap Dusty any time to brain-dump what\'s on your mind - type it all out, attach a photo or file if that\'s easier, and she\'ll turn it into real tasks for you to review before anything gets added.',
        beforeShow: () => switchSoloView('tasks')
    }
];

// clickAudio/taskCompleteAudio now live in task-shared.js.

addBtn.addEventListener('click', addTaskFromInputs);
if (calendarBtn) {
    calendarBtn.addEventListener('click', openCalendar);
}
priorityToggle.addEventListener('change', onToggleAutoPriority);
sortOnceBtn.addEventListener('click', onSuggestOrderOnce);
alertToggleBtn.addEventListener('click', onTogglePopupAlerts);
if (difficultyVisibilityToggle) {
    difficultyVisibilityToggle.addEventListener('change', onToggleDifficultyVisibility);
}
detailsToggleBtn.addEventListener('click', () => {
    playClickSound();
    setDetailsPanelOpen(!taskDetailsPanel.classList.contains('open'));
});
if (onboardingDismissBtn) {
    onboardingDismissBtn.addEventListener('click', dismissOnboardingHint);
}
if (onboardingStartTourBtn) {
    onboardingStartTourBtn.addEventListener('click', startOnboardingTutorial);
}

// Always-available restart, regardless of whether the first-run hint has
// already been dismissed or completed - that's exactly the gap that made
// the tutorial seem to "not show" once someone had been through it before.
const helpTourBtn = document.querySelector('.helpTourBtn');
if (helpTourBtn) {
    helpTourBtn.addEventListener('click', startOnboardingTutorial);
}

matrixSelect.addEventListener('change', playClickSound);
if (difficultySelect) {
    difficultySelect.addEventListener('change', playClickSound);
}

if (detailsMoreToggleBtn) {
    detailsMoreToggleBtn.addEventListener('click', () => {
        playClickSound();
        setDetailsMoreOptionsOpen(!detailsMoreOptions?.classList.contains('open'));
    });
}

deadlineContainer.addEventListener('click', (event) => {
    setDetailsPanelOpen(true);
    setDetailsMoreOptionsOpen(true);
    showDeadlinePresets();
    openCalendar();
});

deadlineInput.addEventListener('focus', () => {
    setDetailsPanelOpen(true);
    setDetailsMoreOptionsOpen(true);
    showDeadlinePresets();
});

deadlineInput.addEventListener('blur', () => {
    setTimeout(hideDeadlinePresets, 120);
});

if (scheduleContainer) {
    scheduleContainer.addEventListener('click', () => {
        setDetailsPanelOpen(true);
        setDetailsMoreOptionsOpen(true);
        showSchedulePresets();
        openSchedulePicker();
    });
}

if (scheduleInput) {
    scheduleInput.addEventListener('focus', () => {
        setDetailsPanelOpen(true);
        setDetailsMoreOptionsOpen(true);
        showSchedulePresets();
    });

    scheduleInput.addEventListener('blur', () => {
        setTimeout(hideSchedulePresets, 120);
    });
}

schedulePresetButtons.forEach((button) => {
    button.addEventListener('click', () => {
        playClickSound();
        applySchedulePreset(button.dataset.preset || 'clear');
    });
});

typePills.forEach((pill) => {
    pill.addEventListener('click', () => {
        playClickSound();
        setTaskTypePillState(pill.dataset.type || 'open');
        updateDurationInputVisibility();
    });
});

durationChips.forEach((chip) => {
    chip.addEventListener('click', () => {
        playClickSound();
        setTaskTypePillState('timeboxed');
        updateDurationInputVisibility();
        durationInput.value = chip.dataset.minutes || '';
        syncDurationChipState();
    });
});

durationInput.addEventListener('input', syncDurationChipState);
sanitizeNumberInputAsPositiveInteger(durationInput);

deadlinePresetButtons.forEach((button) => {
    button.addEventListener('click', () => {
        playClickSound();
        applyDeadlinePreset(button.dataset.preset || 'clear');
    });
});

taskViewButtons.forEach((button) => {
    button.addEventListener('click', () => {
        playClickSound();
        setActiveView(button.dataset.view || 'all');
    });
});

taskInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        addTaskFromInputs();
    }
});

taskInput.addEventListener('input', () => {
    if (quickAddHintTimeoutId) {
        clearTimeout(quickAddHintTimeoutId);
    }
    quickAddHintTimeoutId = setTimeout(updateQuickAddHint, 150);
    updateAddBtnState();
});

// Section B: a real disabled state instead of a silent no-op/alert() when
// the input is empty - previously the only feedback for clicking + with
// nothing typed was a jarring alert() from inside addTaskFromInputs, which
// read as broken rather than "nothing to submit yet." Pressing Enter on an
// empty input still falls through to that alert() as a rare-case fallback,
// since keydown submission bypasses a disabled button entirely - this only
// closes the "the button looked clickable but visibly did nothing" gap.
function updateAddBtnState() {
    addBtn.disabled = taskInput.value.trim() === '';
}

deadlineInput.addEventListener('input', updateQuickAddHint);

if (undoDeleteBtn) {
    undoDeleteBtn.addEventListener('click', undoLastDelete);
}

if (activityDetailsCloseBtn) {
    activityDetailsCloseBtn.addEventListener('click', () => {
        playClickSound();
        closeActivityDetails();
    });
}

if (rewardCloseBtn) {
    rewardCloseBtn.addEventListener('click', () => {
        playClickSound();
        closeRewardCelebration();
    });
}

if (rewardOverlay) {
    rewardOverlay.addEventListener('click', (event) => {
        if (event.target === rewardOverlay) {
            closeRewardCelebration();
        }
    });
}

if (activityDetailsOverlay) {
    activityDetailsOverlay.addEventListener('click', (event) => {
        if (event.target === activityDetailsOverlay) {
            closeActivityDetails();
        }
    });
}

// Skip/Next wiring and resize/scroll repositioning are handled inside
// createTourController itself now.
document.addEventListener('keydown', onGlobalKeyDown);

if (typeof MOBILE_LAYOUT_QUERY.addEventListener === 'function') {
    MOBILE_LAYOUT_QUERY.addEventListener('change', () => {
        renderTasks();
    });
} else if (typeof MOBILE_LAYOUT_QUERY.addListener === 'function') {
    MOBILE_LAYOUT_QUERY.addListener(() => {
        renderTasks();
    });
}

let appStarted = false;

// Everything that used to run unconditionally at load now waits behind the
// auth gate (see the AuthGate.init() call below). Signing in calls this once;
// task loading itself happens in subscribeToCloudTasks() since it's now an
// async Firestore listener instead of a synchronous localStorage read.
function startApp() {
    if (appStarted) {
        return;
    }
    appStarted = true;

    loadSettings();
    loadActivityCounts();
    loadActivityHistory();
    setTaskTypePillState('open');
    updateDurationInputVisibility();
    setDetailsPanelOpen(false);
    updateAddBtnState();
    renderOnboardingHint();
    updateAlertToggleButton();
    renderActivityHeatmap();
    startRealtimeUpdates();
    initializeTaskEditor();

    subscribeToCloudTasks();
}

// All sign-in gate wiring (Google/email/password, mode toggle, forgot
// password, error mapping, the .userBadge/.authGateActive plumbing) now
// lives in auth-gate.js, shared with the group app - see AuthGate.init below.
AuthGate.init({
    onSignedIn: async (user) => {
        startApp();
        // First time THIS app has ever been opened on this account (not
        // just "brand-new account overall" - see checkAndMarkTourSeen) -
        // launch the tour unprompted rather than leaving it to a passive
        // hint card someone might not notice. Account-level, so it never
        // replays again after this, on any device, whether finished or
        // abandoned.
        const { shouldAutoPlay, isLegacyAccount } = await window.ToDoAuth.checkAndMarkTourSeen(user, 'solo');
        isLegacyTourAccount = isLegacyAccount;
        renderOnboardingHint();
        if (shouldAutoPlay) {
            setTimeout(() => tourController.start(), 400);
        }
    },
    onSignedOut: () => {
        appStarted = false;
        if (unsubscribeCloudTasks) {
            unsubscribeCloudTasks();
            unsubscribeCloudTasks = null;
        }
        knownCloudTaskIds = new Set();
        hasLoadedCloudTasksOnce = false;
        tasks = [];
        isLegacyTourAccount = false;
    }
});

// Navigation (section A of the UI/UX rework): Tasks vs. Activity. The tour's
// beforeShow hooks call this directly to self-correct onto whichever view a
// step's target lives in, regardless of step order or a manual tab click
// mid-tour - see TOUR_STEPS below.
function switchSoloView(view) {
    viewTabButtons.forEach((button) => {
        const isActive = button.dataset.view === view;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    viewPanels.forEach((panel) => {
        panel.classList.toggle('hidden', panel.dataset.viewPanel !== view);
    });

    if (view === 'activity') {
        renderActivityHeatmap();
    }
}

viewTabButtons.forEach((button) => {
    button.addEventListener('click', () => {
        playClickSound();
        switchSoloView(button.dataset.view || 'tasks');
    });
});

function updateQuickAddHint() {
    if (!quickAddHint) {
        return;
    }

    // An explicit manual deadline always wins over an auto-detected one, so
    // don't show a preview that wouldn't actually be used.
    if (deadlineInput.value.trim() !== '') {
        quickAddHint.classList.add('hidden');
        return;
    }

    const parsed = parseQuickAddPhrase(taskInput.value);
    if (!parsed.dueAt) {
        quickAddHint.classList.add('hidden');
        return;
    }

    quickAddHint.textContent = `📅 ${formatFriendlyDateTime(parsed.dueAt)} detected. Press Enter to add.`;
    quickAddHint.classList.remove('hidden');
}

function hideQuickAddHint() {
    if (quickAddHintTimeoutId) {
        clearTimeout(quickAddHintTimeoutId);
        quickAddHintTimeoutId = null;
    }
    quickAddHint?.classList.add('hidden');
}

function addTaskFromInputs() {
    playClickSound();

    const rawTaskText = taskInput.value.trim();
    if (rawTaskText === '') {
        alert('Please enter a task!');
        return;
    }

    const taskType = getSelectedTaskType();
    const estimateMinutes = taskType === 'timeboxed' ? parseDurationMinutes(durationInput.value) : null;
    const matrix = getValidMatrixValue(matrixSelect.value);
    const difficulty = getValidDifficultyLevel(difficultySelect?.value);

    let taskText = rawTaskText;
    let dueAt = parseDeadlineInput(deadlineInput.value);

    if (!dueAt) {
        const quickAddParse = parseQuickAddPhrase(rawTaskText);
        if (quickAddParse.dueAt) {
            taskText = quickAddParse.cleanedText || rawTaskText;
            dueAt = quickAddParse.dueAt.toISOString();
        }
    }

    const timestamp = new Date().toISOString();

    const nextManualOrder = tasks.length === 0
        ? 1
        : Math.max(...tasks.map((task) => task.manualOrder || 0)) + 1;

    const newTask = {
        id: generateTaskId(),
        text: taskText,
        completed: false,
        matrix,
        difficulty,
        taskType,
        estimateMinutes,
        dueAt,
        scheduledAt: parseDeadlineInput(scheduleInput?.value),
        createdAt: timestamp,
        updatedAt: timestamp,
        manualOrder: nextManualOrder,
        subtasks: [],
        subtasksExpanded: false
    };

    tasks.push(newTask);

    taskInput.value = '';
    updateAddBtnState();
    matrixSelect.value = 'schedule';
    setTaskTypePillState('open');
    durationInput.value = '';
    if (difficultySelect) {
        difficultySelect.value = '3';
    }
    deadlineInput.value = '';
    if (scheduleInput) {
        scheduleInput.value = '';
    }
    hideDeadlinePresets();
    hideQuickAddHint();
    updateDurationInputVisibility();

    applyOrdering();
    renderTasks();
    updateTaskSummary();
    updateUrgencyAlert();
    saveTasks();
}

// Brain Dump's commitTasks callback (see brain-dump.js). draftTasks come
// from the AI (or the user's own edit of its proposal) and are NOT
// trusted - every field is sanitized through the same validators manual
// entry relies on before becoming a real task. saveTasks() is already a
// whole-array diff+batch (see syncTasksToCloud), so pushing N tasks then
// calling it once covers however many were confirmed in a single write.
function commitAiTasksSolo(draftTasks) {
    const timestamp = new Date().toISOString();
    let nextManualOrder = tasks.length === 0
        ? 1
        : Math.max(...tasks.map((task) => task.manualOrder || 0)) + 1;

    draftTasks.forEach((draft) => {
        const trimmedText = (draft.text || '').trim();
        if (!trimmedText) {
            return;
        }

        const matrix = getValidMatrixValue(draft.matrix);
        const taskType = getValidTaskType(draft.taskType);
        const difficulty = getValidDifficultyLevel(draft.difficulty);
        const estimateMinutes = taskType === 'timeboxed' ? parseDurationMinutes(draft.estimateMinutes) : null;
        const dueAt = isValidDateValue(draft.dueAt) ? new Date(draft.dueAt).toISOString() : null;
        const scheduledAt = isValidDateValue(draft.scheduledAt) ? new Date(draft.scheduledAt).toISOString() : null;
        const subtasks = (Array.isArray(draft.subtasks) ? draft.subtasks : [])
            .map((subtaskText) => (subtaskText || '').trim())
            .filter(Boolean)
            .slice(0, 200)
            .map((subtaskText) => ({
                id: generateSubtaskId(),
                text: subtaskText.slice(0, 240),
                completed: false,
                createdAt: timestamp
            }));

        tasks.push({
            id: generateTaskId(),
            text: trimmedText.slice(0, 2000),
            completed: false,
            matrix,
            difficulty,
            taskType,
            estimateMinutes,
            dueAt,
            scheduledAt,
            createdAt: timestamp,
            updatedAt: timestamp,
            manualOrder: nextManualOrder,
            subtasks,
            subtasksExpanded: subtasks.length > 0
        });
        nextManualOrder += 1;
    });

    applyOrdering();
    renderTasks();
    updateTaskSummary();
    updateUrgencyAlert();
    saveTasks();
}

function openCalendar() {
    playClickSound();
    setDetailsPanelOpen(true);
    showDeadlinePresets();

    if (typeof deadlineInput.showPicker === 'function') {
        deadlineInput.showPicker();
    } else {
        deadlineInput.focus();
    }
}

function onToggleAutoPriority() {
    playClickSound();
    isAutoPrioritize = priorityToggle.checked;
    applyOrdering();
    renderTasks();
    updateTaskSummary();
    updateUrgencyAlert();
    saveSettings();
}

function onTogglePopupAlerts() {
    playClickSound();

    if (!('Notification' in window)) {
        urgencyAlertText.textContent = 'Popup alerts are not supported in this browser.';
        popupAlertsEnabled = false;
        updateAlertToggleButton();
        saveSettings();
        return;
    }

    if (!popupAlertsEnabled) {
        if (Notification.permission === 'granted') {
            popupAlertsEnabled = true;
            updateAlertToggleButton();
            saveSettings();
            return;
        }

        Notification.requestPermission().then((permission) => {
            popupAlertsEnabled = permission === 'granted';
            if (!popupAlertsEnabled) {
                urgencyAlertText.textContent = 'Popup alerts blocked. Enable permission in browser settings if needed.';
            }
            updateAlertToggleButton();
            saveSettings();
        });
        return;
    }

    popupAlertsEnabled = false;
    updateAlertToggleButton();
    saveSettings();
}

function dismissOnboardingHint() {
    playClickSound();
    localStorage.setItem(COACH_KEY, 'dismissed');
    renderOnboardingHint();
}

function renderOnboardingHint() {
    if (!onboardingHint) {
        return;
    }

    const coachState = localStorage.getItem(COACH_KEY);
    // Hidden for the tour's whole run, not just once it's done - it sits
    // right behind the modal and is redundant with it while open. Also
    // hidden outright for a legacy account (see isLegacyTourAccount) - this
    // prompt is part of the new-account onboarding flow, not something to
    // push on an existing user just because this browser never dismissed it.
    const shouldHide = coachState === 'dismissed' || coachState === 'tour-completed' || tourController.isOpen() || isLegacyTourAccount;
    onboardingHint.classList.toggle('hidden', shouldHide);
}

// The step-through/highlight/reposition engine itself now lives in
// task-shared.js (createTourController), shared with the group app's own
// tutorial - this just wires it up with solo's steps and storage key.
const tourController = createTourController({
    steps: TOUR_STEPS,
    storageKey: COACH_KEY,
    onStart: () => renderOnboardingHint(),
    onEnd: () => renderOnboardingHint()
});

// Brain Dump - always available in solo (no "nothing to add to" gate the
// way the group page needs, since your own task list always exists).
const brainDumpController = createBrainDumpController({
    context: 'solo',
    commitTasks: commitAiTasksSolo
});
const brainDumpToggleBtn = document.querySelector('.brainDumpToggleBtn');
if (brainDumpToggleBtn) {
    brainDumpToggleBtn.addEventListener('click', () => {
        playClickSound();
        brainDumpController.open();
    });
}

function startOnboardingTutorial() {
    playClickSound();
    setDetailsPanelOpen(false);
    tourController.start();
}

function onGlobalKeyDown(event) {
    if (event.key === 'Escape') {
        if (rewardOverlay && !rewardOverlay.classList.contains('hidden')) {
            closeRewardCelebration();
            return;
        }

        if (activityDetailsOverlay && !activityDetailsOverlay.classList.contains('hidden')) {
            closeActivityDetails();
            return;
        }

        if (tourController.isOpen()) {
            tourController.end(true);
        }
    }
}

function applyRankNowOrder() {
    tasks.sort(compareByPriority);
    tasks.forEach((task, index) => {
        task.manualOrder = index + 1;
        task.updatedAt = new Date().toISOString();
    });
}

function updateAlertToggleButton() {
    if (!alertToggleBtn) {
        return;
    }

    if (!('Notification' in window)) {
        alertToggleBtn.textContent = 'Popup alerts: Unsupported';
        alertToggleBtn.classList.remove('enabled');
        alertToggleBtn.disabled = true;
        return;
    }

    alertToggleBtn.disabled = false;
    alertToggleBtn.classList.toggle('enabled', popupAlertsEnabled);
    alertToggleBtn.textContent = popupAlertsEnabled ? 'Popup alerts: On' : 'Popup alerts: Off';
}

function onSuggestOrderOnce() {
    if (isAutoPrioritize || activeView !== 'all') {
        return;
    }

    playClickSound();

    applyRankNowOrder();

    renderTasks();
    updateTaskSummary();
    updateUrgencyAlert();
    saveTasks();
    priorityModeHint.textContent = 'One-time smart sort applied. You are still in manual mode, so drag-and-drop remains available.';
}

function updateDurationInputVisibility() {
    const isTimeboxed = getSelectedTaskType() === 'timeboxed';
    durationInput.classList.toggle('hidden', !isTimeboxed);
    document.querySelector('.durationWrap')?.classList.toggle('hidden', !isTimeboxed);

    if (!isTimeboxed) {
        durationInput.value = '';
    }

    syncDurationChipState();
}

function applyDeadlinePreset(preset) {
    if (preset === 'clear') {
        deadlineInput.value = '';
        return;
    }

    const presetDate = computePresetDate(preset);
    if (!presetDate) {
        return;
    }

    deadlineInput.value = toDatetimeLocalValue(presetDate.toISOString());
}

// computePresetDate, parseQuickAddPhrase (+ its helpers), formatFriendlyDateTime,
// and getScheduleLabel now live in task-shared.js, shared with the group app.

function setActiveView(view) {
    if (!Object.prototype.hasOwnProperty.call(VIEW_CONFIG, view)) {
        view = 'all';
    }

    activeView = view;

    taskViewButtons.forEach((button) => {
        button.classList.toggle('active', button.dataset.view === activeView);
    });

    renderTasks();
}

function setDetailsPanelOpen(isOpen) {
    taskDetailsPanel.classList.toggle('open', isOpen);
    detailsToggleBtn.setAttribute('aria-expanded', String(isOpen));
    if (!isOpen) {
        hideDeadlinePresets();
        hideSchedulePresets();
        // Collapsed again next time Prioritize opens, same reasoning as the
        // preset rows above - starts back at just the two fields that
        // matter most (Hick's Law) rather than remembering an expanded
        // state from a previous, unrelated task.
        setDetailsMoreOptionsOpen(false);
    }
}

// Two-tier disclosure (section C): estimate/deadline/schedule stay collapsed
// behind "More options" until asked for, so opening Prioritize only ever
// surfaces the two fields (matrix, difficulty) that actually drive auto-sort
// order. deadlineContainer/scheduleContainer's own click/focus handlers
// (below) need the fields visible to focus them, so they call this too, not
// just setDetailsPanelOpen.
function setDetailsMoreOptionsOpen(isOpen) {
    if (!detailsMoreOptions || !detailsMoreToggleBtn) {
        return;
    }
    detailsMoreOptions.classList.toggle('open', isOpen);
    detailsMoreToggleBtn.setAttribute('aria-expanded', String(isOpen));
}

function showDeadlinePresets() {
    taskDetailsPanel.classList.add('show-presets');
}

function hideDeadlinePresets() {
    taskDetailsPanel.classList.remove('show-presets');
}

function openSchedulePicker() {
    if (!scheduleInput) {
        return;
    }

    playClickSound();
    setDetailsPanelOpen(true);
    showSchedulePresets();

    if (typeof scheduleInput.showPicker === 'function') {
        scheduleInput.showPicker();
    } else {
        scheduleInput.focus();
    }
}

function showSchedulePresets() {
    taskDetailsPanel.classList.add('show-schedule-presets');
}

function hideSchedulePresets() {
    taskDetailsPanel.classList.remove('show-schedule-presets');
}

function applySchedulePreset(preset) {
    if (!scheduleInput) {
        return;
    }

    if (preset === 'clear') {
        scheduleInput.value = '';
        return;
    }

    const presetDate = computePresetDate(preset);
    if (!presetDate) {
        return;
    }

    scheduleInput.value = toDatetimeLocalValue(presetDate.toISOString());
}

function getSelectedTaskType() {
    const activePill = typePills.find((pill) => pill.classList.contains('active'));
    return getValidTaskType(activePill?.dataset.type || 'open');
}

function setTaskTypePillState(taskType) {
    const normalizedTaskType = getValidTaskType(taskType);
    typePills.forEach((pill) => {
        pill.classList.toggle('active', pill.dataset.type === normalizedTaskType);
    });
}

function syncDurationChipState() {
    const selectedMinutes = String(parseDurationMinutes(durationInput.value) || '');
    durationChips.forEach((chip) => {
        chip.classList.toggle('active', chip.dataset.minutes === selectedMinutes);
    });
}

function renderTasks() {
    tasksList.innerHTML = '';
    const visibleTasks = getVisibleTasks();

    if (visibleTasks.length === 0) {
        const emptyMessage = document.createElement('li');
        emptyMessage.className = 'emptyTasksMsg';
        emptyMessage.textContent = VIEW_CONFIG[activeView].emptyMessage;
        tasksList.appendChild(emptyMessage);
    } else {
        visibleTasks.forEach((task) => {
            tasksList.appendChild(createTaskItem(task));
        });
    }

    tasksList.classList.toggle('priority-on', isAutoPrioritize);
    updatePriorityModeHint();
    updateNextTaskPanel();
    updateUrgencyAlert();
    restorePendingSubtaskFocus();
}

function restorePendingSubtaskFocus() {
    if (!pendingSubtaskFocusTaskId) {
        return;
    }

    const taskId = pendingSubtaskFocusTaskId;
    pendingSubtaskFocusTaskId = null;

    const taskItem = tasksList.querySelector(`[data-task-id="${CSS.escape(taskId)}"]`);
    const input = taskItem?.querySelector('.subtaskInput');
    input?.focus();
}

function getVisibleTasks() {
    switch (activeView) {
        case 'focus': {
            const now = Date.now();
            const in24Hours = now + (24 * 60 * 60 * 1000);

            return [...tasks]
                .filter((task) => {
                    if (task.completed) {
                        return false;
                    }

                    const status = getDeadlineStatus(task.dueAt);
                    const dueSoon = status.hasDeadline && status.deadlineTimestamp <= in24Hours;
                    const urgentMatrix = getValidMatrixValue(task.matrix) === 'do';
                    const shortTimeboxed = getValidTaskType(task.taskType) === 'timeboxed' && (task.estimateMinutes || 0) > 0 && (task.estimateMinutes || 0) <= 60;
                    const scheduledSoon = task.scheduledAt && isValidDateValue(task.scheduledAt)
                        && Math.abs(new Date(task.scheduledAt).getTime() - now) <= (4 * 60 * 60 * 1000);

                    return status.isOverdue || dueSoon || urgentMatrix || shortTimeboxed || scheduledSoon;
                })
                .sort(compareByPriority)
                .slice(0, 3);
        }
        case 'overdue':
            return tasks.filter((task) => !task.completed && getDeadlineStatus(task.dueAt).isOverdue);
        case 'today':
            return tasks.filter((task) => {
                if (task.completed || !task.dueAt || !isValidDateValue(task.dueAt)) {
                    return false;
                }

                const dueDate = new Date(task.dueAt);
                const now = new Date();
                return dueDate.getFullYear() === now.getFullYear()
                    && dueDate.getMonth() === now.getMonth()
                    && dueDate.getDate() === now.getDate();
            });
        case 'week': {
            const now = Date.now();
            const weekAhead = now + (7 * 24 * 60 * 60 * 1000);

            return tasks.filter((task) => {
                if (task.completed || !task.dueAt || !isValidDateValue(task.dueAt)) {
                    return false;
                }
                const dueTimestamp = new Date(task.dueAt).getTime();
                return dueTimestamp >= now && dueTimestamp <= weekAhead;
            });
        }
        case 'completed':
            return tasks.filter((task) => task.completed);
        case 'all':
        default:
            return tasks;
    }
}

function createTaskItem(task) {
    const taskItem = document.createElement('li');
    taskItem.dataset.taskId = task.id;

    if (task.completed) {
        taskItem.classList.add('completed');
    }

    const taskMain = document.createElement('div');
    taskMain.classList.add('taskMain');

    const checkBtn = document.createElement('button');
    checkBtn.classList.add('checkBtn');
    checkBtn.innerHTML = '<i class="fa-solid fa-check"></i>';
    checkBtn.setAttribute('aria-label', task.completed ? 'Mark as incomplete' : 'Mark as complete');
    checkBtn.title = task.completed ? 'Mark as incomplete' : 'Mark as complete';

    const taskContent = document.createElement('div');
    taskContent.classList.add('taskContent');

    const taskTextSpan = document.createElement('span');
    taskTextSpan.classList.add('taskText');
    taskTextSpan.textContent = task.text;

    const taskMeta = document.createElement('div');
    taskMeta.classList.add('taskMeta');

    const isMobile = MOBILE_LAYOUT_QUERY.matches;
    const matrixValue = getValidMatrixValue(task.matrix);
    const taskType = getValidTaskType(task.taskType);

    const matrixBadge = document.createElement('span');
    const matrixData = MATRIX_CONFIG[matrixValue];
    matrixBadge.classList.add('matrixBadge', matrixData.className);
    matrixBadge.textContent = matrixData.label;

    const difficultyBadge = document.createElement('span');
    const difficultyLevel = getValidDifficultyLevel(task.difficulty);
    difficultyBadge.classList.add('difficultyBadge', `difficulty-${difficultyLevel}`);
    difficultyBadge.textContent = getDifficultyLabel(difficultyLevel);

    const effortLabel = getEffortLabel(task);
    const effortBadge = document.createElement('span');
    effortBadge.classList.add('effortBadge');
    effortBadge.textContent = effortLabel;

    const deadlineBadge = document.createElement('span');
    deadlineBadge.classList.add('deadlineBadge');

    const countdownBadge = document.createElement('span');
    countdownBadge.classList.add('countdownBadge');

    const deadlineStatus = getTaskDisplayDeadlineStatus(task);
    taskItem.classList.add(`status-${deadlineStatus.urgencyLevel}`);
    deadlineBadge.classList.add(deadlineStatus.deadlineClassName);
    deadlineBadge.textContent = deadlineStatus.deadlineLabel;

    countdownBadge.classList.add(deadlineStatus.countdownClassName);
    countdownBadge.textContent = deadlineStatus.countdownLabel;

    const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];
    const subtaskDoneCount = subtasks.filter((subtask) => subtask.completed).length;

    if (subtasks.length > 0) {
        const subtaskProgressBadge = document.createElement('span');
        subtaskProgressBadge.classList.add('subtaskProgressBadge');
        subtaskProgressBadge.textContent = `${subtaskDoneCount}/${subtasks.length} steps`;
        taskMeta.appendChild(subtaskProgressBadge);
    }

    if (task.scheduledAt && !task.completed) {
        const scheduleBadge = document.createElement('span');
        scheduleBadge.classList.add('scheduleBadge');
        scheduleBadge.innerHTML = `<i class="fa-solid fa-clock"></i> ${getScheduleLabel(task.scheduledAt)}`;
        taskMeta.appendChild(scheduleBadge);
    }

    // Deadline/countdown go first when a deadline exists (Serial Position
    // Effect, section D): the most decision-relevant badge gets the primacy
    // slot instead of being buried after matrix/difficulty/effort.
    const hasDeadline = deadlineStatus.hasDeadline;
    if (hasDeadline) {
        taskMeta.appendChild(deadlineBadge);
        taskMeta.appendChild(countdownBadge);
    }

    if (!(isMobile && matrixValue === 'schedule')) {
        taskMeta.appendChild(matrixBadge);
    }

    if (!isMobile || showDifficultyBadgesOnMobile) {
        taskMeta.appendChild(difficultyBadge);
    }

    const showCompactMobileEffort = isMobile && taskType === 'timeboxed' && Boolean(task.estimateMinutes);
    const showDesktopEffort = !isMobile && effortLabel !== 'No estimate';
    if (showDesktopEffort || showCompactMobileEffort) {
        taskMeta.appendChild(effortBadge);
    }

    if (!hasDeadline) {
        taskMeta.appendChild(deadlineBadge);
        taskMeta.appendChild(countdownBadge);
    }

    taskContent.appendChild(taskTextSpan);
    taskContent.appendChild(taskMeta);

    taskMain.appendChild(checkBtn);
    taskMain.appendChild(taskContent);

    const taskButtons = document.createElement('div');
    taskButtons.classList.add('taskButtons');

    const editBtn = document.createElement('button');
    editBtn.classList.add('editBtn');
    editBtn.innerHTML = '<i class="fa-solid fa-pen"></i><span class="taskBtnLabel">Edit</span>';
    editBtn.setAttribute('aria-label', 'Edit task');
    editBtn.title = 'Edit task';

    const deleteBtn = document.createElement('button');
    deleteBtn.classList.add('deleteBtn');
    deleteBtn.innerHTML = '<i class="fa-solid fa-trash"></i><span class="taskBtnLabel">Delete</span>';
    deleteBtn.setAttribute('aria-label', 'Delete task');
    deleteBtn.title = 'Delete task';

    // Icon changed from fa-clock-rotate-left (a clock with a counter-
    // clockwise arrow, which most simply reads as "undo"/"history", not
    // "snooze" - Law of Prägnanz) to a plain fa-clock, plus this is the one
    // task-row action that keeps a visible text label at every viewport
    // width, not just ≤900px like Edit/Delete - the least universally-
    // recognized of the three (section D/M finding).
    const canSnooze = Boolean(task.dueAt) && !task.completed;
    const snoozeBtn = document.createElement('button');
    snoozeBtn.classList.add('snoozeBtn');
    snoozeBtn.innerHTML = '<i class="fa-solid fa-clock"></i><span class="taskBtnLabel">Snooze</span>';
    snoozeBtn.setAttribute('aria-label', 'Snooze / reschedule deadline');
    snoozeBtn.title = 'Snooze / reschedule deadline';

    taskButtons.appendChild(editBtn);
    if (canSnooze) {
        taskButtons.appendChild(snoozeBtn);
    }
    taskButtons.appendChild(deleteBtn);

    const taskTopRow = document.createElement('div');
    taskTopRow.classList.add('taskTopRow');
    taskTopRow.appendChild(taskMain);
    taskTopRow.appendChild(taskButtons);

    taskItem.appendChild(taskTopRow);
    if (canSnooze) {
        taskItem.appendChild(createSnoozeSection(task));
    }
    taskItem.appendChild(createSubtasksSection(task, subtasks));

    checkBtn.addEventListener('click', () => {
        playClickSound();
        toggleTaskCompletion(task.id);
        playTaskCompleteSound();
    });

    editBtn.addEventListener('click', () => {
        playClickSound();
        editTask(task.id);
    });

    deleteBtn.addEventListener('click', () => {
        playClickSound();
        deleteTask(task.id);
    });

    snoozeBtn.addEventListener('click', () => {
        playClickSound();
        toggleSnoozeExpanded(task.id);
    });

    attachDragEvents(taskItem);
    return taskItem;
}

function createSnoozeSection(task) {
    const section = document.createElement('div');
    section.classList.add('snoozeSection');
    if (!expandedSnoozeTaskIds.has(task.id)) {
        section.classList.add('hidden');
    }

    const label = document.createElement('span');
    label.classList.add('snoozeLabel');
    label.textContent = 'Push deadline to:';
    section.appendChild(label);

    const presetOptions = [
        { preset: 'tomorrow', label: 'Tomorrow' },
        { preset: 'plus3days', label: 'In 3 days' },
        { preset: 'nextweek', label: 'Next week' }
    ];

    presetOptions.forEach(({ preset, label: optionLabel }) => {
        const optionBtn = document.createElement('button');
        optionBtn.type = 'button';
        optionBtn.classList.add('deadlinePresetBtn', 'snoozeOptionBtn');
        optionBtn.textContent = optionLabel;
        optionBtn.addEventListener('click', () => {
            playClickSound();
            applySnoozeToTask(task.id, preset);
        });
        section.appendChild(optionBtn);
    });

    const pickDateBtn = document.createElement('button');
    pickDateBtn.type = 'button';
    pickDateBtn.classList.add('deadlinePresetBtn', 'snoozeOptionBtn');
    pickDateBtn.textContent = 'Pick a date...';
    pickDateBtn.addEventListener('click', () => {
        playClickSound();
        expandedSnoozeTaskIds.delete(task.id);
        editTask(task.id);
    });
    section.appendChild(pickDateBtn);

    return section;
}

function toggleSnoozeExpanded(taskId) {
    if (expandedSnoozeTaskIds.has(taskId)) {
        expandedSnoozeTaskIds.delete(taskId);
    } else {
        expandedSnoozeTaskIds.add(taskId);
    }
    renderTasks();
}

function applySnoozeToTask(taskId, preset) {
    const task = findTaskById(taskId);
    if (!task) {
        return;
    }

    const presetDate = computePresetDate(preset);
    if (!presetDate) {
        return;
    }

    task.dueAt = presetDate.toISOString();
    task.updatedAt = new Date().toISOString();
    expandedSnoozeTaskIds.delete(taskId);

    applyOrdering();
    renderTasks();
    updateTaskSummary();
    updateUrgencyAlert();
    saveTasks();
}

function createSubtasksSection(task, subtasks) {
    const section = document.createElement('div');
    section.classList.add('subtasksSection');

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.classList.add('subtasksToggleBtn');
    toggleBtn.setAttribute('aria-expanded', String(Boolean(task.subtasksExpanded)));

    const chevron = document.createElement('i');
    chevron.classList.add('fa-solid', task.subtasksExpanded ? 'fa-chevron-down' : 'fa-chevron-right');
    toggleBtn.appendChild(chevron);

    const toggleLabel = document.createElement('span');
    toggleLabel.classList.add('subtasksToggleLabel');
    const doneCount = subtasks.filter((subtask) => subtask.completed).length;
    toggleLabel.textContent = subtasks.length > 0 ? `${doneCount}/${subtasks.length} steps` : 'Add steps';
    toggleBtn.appendChild(toggleLabel);

    toggleBtn.addEventListener('click', () => {
        playClickSound();
        toggleSubtasksExpanded(task.id);
    });

    section.appendChild(toggleBtn);

    const body = document.createElement('div');
    body.classList.add('subtasksBody');
    if (!task.subtasksExpanded) {
        body.classList.add('hidden');
    }

    if (subtasks.length > 0) {
        // Deliberately not a <ul>/<li>: those tag names collide with the many
        // ".tasks li" selectors used for the top-level task rows (drag states,
        // status borders, the "Auto sorted" badge, etc.), since this list is
        // nested inside one of those <li> elements. role="list" preserves the
        // list semantics for assistive tech without the tag-name collision.
        const list = document.createElement('div');
        list.classList.add('subtasksList');
        list.setAttribute('role', 'list');
        subtasks.forEach((subtask) => {
            list.appendChild(createSubtaskItem(task.id, subtask));
        });
        body.appendChild(list);
    }

    body.appendChild(createSubtaskAddRow(task.id));
    section.appendChild(body);
    return section;
}

function createSubtaskAddRow(taskId) {
    const addRow = document.createElement('div');
    addRow.classList.add('subtaskAddRow');

    const addInput = document.createElement('input');
    addInput.type = 'text';
    addInput.classList.add('subtaskInput');
    addInput.placeholder = 'Add a step...';
    addInput.setAttribute('aria-label', 'Add a step');
    // Prevent the draggable task item from swallowing text-selection drags inside this input.
    addInput.addEventListener('mousedown', (event) => event.stopPropagation());

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.classList.add('subtaskAddBtn');
    addBtn.setAttribute('aria-label', 'Add step');
    addBtn.innerHTML = '<i class="fa-solid fa-plus"></i>';

    const submitNewSubtask = () => {
        if (addInput.value.trim() === '') {
            return;
        }
        playClickSound();
        pendingSubtaskFocusTaskId = taskId;
        addSubtaskToTask(taskId, addInput.value);
    };

    addBtn.addEventListener('click', submitNewSubtask);
    addInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            submitNewSubtask();
        }
    });

    addRow.appendChild(addInput);
    addRow.appendChild(addBtn);
    return addRow;
}

function createSubtaskItem(taskId, subtask) {
    const item = document.createElement('div');
    item.classList.add('subtaskItem');
    item.setAttribute('role', 'listitem');
    if (subtask.completed) {
        item.classList.add('completed');
    }

    const checkBtn = document.createElement('button');
    checkBtn.type = 'button';
    checkBtn.classList.add('subtaskCheckBtn');
    checkBtn.innerHTML = '<i class="fa-solid fa-check"></i>';
    checkBtn.setAttribute('aria-label', subtask.completed ? 'Mark step incomplete' : 'Mark step complete');

    const text = document.createElement('span');
    text.classList.add('subtaskText');
    text.textContent = subtask.text;

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.classList.add('subtaskDeleteBtn');
    deleteBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    deleteBtn.setAttribute('aria-label', 'Delete step');

    checkBtn.addEventListener('click', () => {
        playClickSound();
        toggleSubtaskCompletion(taskId, subtask.id);
    });

    deleteBtn.addEventListener('click', () => {
        playClickSound();
        deleteSubtaskFromTask(taskId, subtask.id);
    });

    item.appendChild(checkBtn);
    item.appendChild(text);
    item.appendChild(deleteBtn);
    return item;
}

// getEffortLabel now lives in task-shared.js.

function onToggleDifficultyVisibility() {
    if (!difficultyVisibilityToggle) {
        return;
    }

    playClickSound();
    showDifficultyBadgesOnMobile = difficultyVisibilityToggle.checked;
    saveSettings();
    renderTasks();
}

// getDifficultyLabel now lives in task-shared.js.

function getRecommendedTask() {
    const activeTasks = tasks.filter((task) => !task.completed);
    if (activeTasks.length === 0) {
        return null;
    }

    return [...activeTasks].sort(compareByPriority)[0];
}

function getPriorityReasons(task) {
    const reasons = [];
    const status = getDeadlineStatus(task.dueAt);
    const matrix = getValidMatrixValue(task.matrix);
    const difficulty = getValidDifficultyLevel(task.difficulty);

    if (status.isOverdue) {
        reasons.push('This task is overdue right now.');
    } else if (status.hasDeadline) {
        if (status.timeUntilMs <= 7200000) {
            reasons.push('Deadline is very close (within 2 hours).');
        } else if (status.timeUntilMs <= 86400000) {
            reasons.push('Deadline is due today.');
        }
    }

    const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];
    if (subtasks.length > 0) {
        const doneCount = subtasks.filter((subtask) => subtask.completed).length;
        if (doneCount > 0 && doneCount < subtasks.length) {
            reasons.push(`Almost done: ${doneCount}/${subtasks.length} steps complete.`);
        }
    }

    if (task.scheduledAt && isValidDateValue(task.scheduledAt)) {
        const hoursFromNow = Math.abs(new Date(task.scheduledAt).getTime() - Date.now()) / 3600000;
        if (hoursFromNow <= 12) {
            reasons.push(`Scheduled for ${getScheduleLabel(task.scheduledAt)}.`);
        }
    }

    if (matrix === 'do') {
        reasons.push('Marked as Important and Urgent.');
    } else if (matrix === 'schedule') {
        reasons.push('Marked as Important in your matrix.');
    } else if (matrix === 'delegate') {
        reasons.push('Marked as Urgent in your matrix.');
    }

    if (difficulty >= 4) {
        reasons.push('High difficulty tasks are moved up to avoid delay.');
    }

    if (task.taskType === 'timeboxed' && task.estimateMinutes) {
        reasons.push(`Estimated time is ${task.estimateMinutes} minutes.`);
    }

    if (reasons.length === 0) {
        reasons.push('Best overall priority score from your current inputs.');
    }

    return reasons.slice(0, 3);
}

function updateNextTaskPanel() {
    if (!nextTaskPanel || !nextTaskTitle || !nextTaskReasons) {
        return;
    }

    const recommended = getRecommendedTask();
    if (!recommended) {
        nextTaskPanel.classList.add('hidden');
        return;
    }

    nextTaskPanel.classList.remove('hidden');
    nextTaskTitle.textContent = recommended.text;
    nextTaskReasons.innerHTML = '';

    getPriorityReasons(recommended).forEach((reason) => {
        const reasonItem = document.createElement('li');
        reasonItem.textContent = reason;
        nextTaskReasons.appendChild(reasonItem);
    });
}

function canUseManualDrag() {
    return !isAutoPrioritize && activeView === 'all';
}

function attachDragEvents(taskItem) {
    taskItem.draggable = canUseManualDrag();
    taskItem.dataset.dragDepth = '0';

    taskItem.addEventListener('dragstart', (event) => {
        if (!canUseManualDrag()) {
            event.preventDefault();
            return;
        }

        dragSourceTaskId = taskItem.dataset.taskId;
        taskItem.classList.add('dragging');
        tasksList.classList.add('drag-active');

        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', dragSourceTaskId || '');
        }
    });

    taskItem.addEventListener('dragover', (event) => {
        if (!canUseManualDrag() || !dragSourceTaskId || dragSourceTaskId === taskItem.dataset.taskId) {
            return;
        }

        event.preventDefault();
        taskItem.classList.add('drag-over-slot');
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = 'move';
        }
    });

    taskItem.addEventListener('dragenter', (event) => {
        if (!canUseManualDrag() || !dragSourceTaskId || dragSourceTaskId === taskItem.dataset.taskId) {
            return;
        }

        event.preventDefault();
        const nextDepth = Number(taskItem.dataset.dragDepth || '0') + 1;
        taskItem.dataset.dragDepth = String(nextDepth);
        taskItem.classList.add('drag-over-slot');
    });

    taskItem.addEventListener('dragleave', () => {
        const nextDepth = Math.max(0, Number(taskItem.dataset.dragDepth || '0') - 1);
        taskItem.dataset.dragDepth = String(nextDepth);
        if (nextDepth === 0) {
            taskItem.classList.remove('drag-over-slot');
        }
    });

    taskItem.addEventListener('drop', (event) => {
        event.preventDefault();

        if (!canUseManualDrag() || !dragSourceTaskId) {
            clearDragStates();
            return;
        }

        const targetTaskId = taskItem.dataset.taskId;
        if (!targetTaskId || dragSourceTaskId === targetTaskId) {
            clearDragStates();
            return;
        }

        const sourceItem = tasksList.querySelector(`[data-task-id="${CSS.escape(dragSourceTaskId)}"]`);
        const targetItem = tasksList.querySelector(`[data-task-id="${CSS.escape(targetTaskId)}"]`);

        if (!sourceItem || !targetItem) {
            clearDragStates();
            return;
        }

        swapTaskSlotsWithAnimation(sourceItem, targetItem);
        syncManualOrderFromDom();
        saveTasks();
        taskItem.dataset.dragDepth = '0';
        clearDragStates();
    });

    taskItem.addEventListener('dragend', () => {
        taskItem.dataset.dragDepth = '0';
        clearDragStates();
    });
}

function clearDragStates() {
    dragSourceTaskId = null;
    tasksList.classList.remove('drag-active');

    tasksList.querySelectorAll('li').forEach((taskItem) => {
        taskItem.dataset.dragDepth = '0';
        taskItem.classList.remove('dragging', 'drag-over-slot');
    });
}

function swapTaskSlotsWithAnimation(sourceItem, targetItem) {
    const allItemsBeforeSwap = Array.from(tasksList.querySelectorAll('li'));
    const firstRects = new Map(allItemsBeforeSwap.map((item) => [item, item.getBoundingClientRect()]));

    const sourceNextSibling = sourceItem.nextSibling;
    const targetNextSibling = targetItem.nextSibling;

    if (sourceNextSibling === targetItem) {
        tasksList.insertBefore(targetItem, sourceItem);
    } else if (targetNextSibling === sourceItem) {
        tasksList.insertBefore(sourceItem, targetItem);
    } else {
        tasksList.insertBefore(targetItem, sourceNextSibling);
        tasksList.insertBefore(sourceItem, targetNextSibling);
    }

    Array.from(tasksList.querySelectorAll('li')).forEach((item) => {
        const firstRect = firstRects.get(item);
        if (!firstRect) {
            return;
        }

        const lastRect = item.getBoundingClientRect();
        const deltaX = firstRect.left - lastRect.left;
        const deltaY = firstRect.top - lastRect.top;

        if (deltaX === 0 && deltaY === 0) {
            return;
        }

        item.style.transition = 'none';
        item.style.transform = `translate(${deltaX}px, ${deltaY}px)`;

        requestAnimationFrame(() => {
            item.style.transition = 'transform 280ms cubic-bezier(0.22, 1, 0.36, 1)';
            item.style.transform = '';

            const cleanTransition = () => {
                item.style.transition = '';
                item.removeEventListener('transitionend', cleanTransition);
            };

            item.addEventListener('transitionend', cleanTransition);
        });
    });
}

function syncManualOrderFromDom() {
    const orderedIds = Array.from(tasksList.querySelectorAll('li'))
        .map((item) => item.dataset.taskId)
        .filter(Boolean);

    orderedIds.forEach((taskId, index) => {
        const task = findTaskById(taskId);
        if (!task) {
            return;
        }

        task.manualOrder = index + 1;
        task.updatedAt = new Date().toISOString();
    });

    tasks.sort((a, b) => orderedIds.indexOf(a.id) - orderedIds.indexOf(b.id));
}

function toggleTaskCompletion(taskId) {
    const task = findTaskById(taskId);
    if (!task) {
        return;
    }

    setTaskCompletedState(task, !task.completed);

    applyOrdering();
    renderTasks();
    updateTaskSummary();
    updateUrgencyAlert();
    renderActivityHeatmap();
    saveTasks();
}

function setTaskCompletedState(task, completed) {
    const wasCompleted = task.completed;
    if (wasCompleted === completed) {
        return;
    }

    task.completed = completed;
    task.updatedAt = new Date().toISOString();

    if (!wasCompleted && completed) {
        addActivityCount(1);
        addActivityHistoryEntry(task);
        checkForMilestone();
    } else if (wasCompleted && !completed) {
        addActivityCount(-1);
        removeLatestActivityHistoryEntry(task);
    }
}

function getTasksDueToday(now = new Date()) {
    return tasks.filter((task) => {
        if (!task.dueAt || !isValidDateValue(task.dueAt)) {
            return false;
        }

        const dueDate = new Date(task.dueAt);
        return dueDate.getFullYear() === now.getFullYear()
            && dueDate.getMonth() === now.getMonth()
            && dueDate.getDate() === now.getDate();
    });
}

// Two independent triggers: clearing everything due today (once per day), and
// a running session streak every 5 completions. If both are true at once, the
// daily-clear message wins so it doesn't get buried by the streak popup.
function checkForMilestone() {
    sessionCompletionCount += 1;

    const todayKey = getDateKey(new Date());
    const dueToday = getTasksDueToday();
    const alreadyCelebratedToday = localStorage.getItem(CELEBRATED_DAILY_CLEAR_KEY) === todayKey;
    const dailyClearReady = dueToday.length > 0 && dueToday.every((task) => task.completed) && !alreadyCelebratedToday;

    if (dailyClearReady) {
        localStorage.setItem(CELEBRATED_DAILY_CLEAR_KEY, todayKey);
        triggerRewardCelebration('Today’s tasks are all done');
        return;
    }

    if (sessionCompletionCount % 5 === 0) {
        triggerRewardCelebration(`${sessionCompletionCount} tasks completed this session`);
    }
}

let rewardSpinToken = 0;
let stopRewardReelTicking = null;

function triggerRewardCelebration(titleText) {
    if (!rewardOverlay || !rewardTitle || !rewardSuggestionText) {
        return;
    }

    rewardSpinToken += 1;
    const currentSpinToken = rewardSpinToken;

    rewardTitle.textContent = titleText;
    const winningReward = REWARD_SUGGESTIONS[Math.floor(Math.random() * REWARD_SUGGESTIONS.length)];
    rewardSuggestionText.textContent = winningReward.text;

    rewardCard?.classList.remove('revealed');
    rewardOverlay.classList.remove('hidden');
    rewardOverlay.setAttribute('aria-hidden', 'false');

    const prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion || !rewardReelTrack || !rewardReelViewport) {
        revealRewardResult();
        spawnConfetti();
        return;
    }

    spinRewardReel(winningReward, currentSpinToken);
}

function spinRewardReel(winningReward, spinToken) {
    rewardReelTrack.innerHTML = '';
    rewardReelTrack.style.transition = 'none';
    rewardReelTrack.style.transform = 'translateX(0)';

    for (let i = 0; i < REEL_FILLER_COUNT; i += 1) {
        const tileReward = i === REEL_LANDING_INDEX
            ? winningReward
            : REWARD_SUGGESTIONS[Math.floor(Math.random() * REWARD_SUGGESTIONS.length)];
        rewardReelTrack.appendChild(createRewardTile(tileReward));
    }

    // Force a layout flush so the reset above is committed before the
    // transition is applied below — otherwise the browser can coalesce both
    // style changes into one and skip the animation entirely.
    void rewardReelTrack.offsetWidth;

    const viewportWidth = rewardReelViewport.clientWidth;
    const jitter = (Math.random() * 30) - 15;
    const targetOffset = (REEL_LANDING_INDEX * REEL_TILE_STEP) + (REEL_TILE_WIDTH / 2) - (viewportWidth / 2) + jitter;

    // "expo-out": very fast start, then a long, gradually-slowing crawl into
    // the landing tile rather than an abrupt stop.
    rewardReelTrack.style.transition = 'transform 6.5s cubic-bezier(0.16, 1, 0.3, 1)';
    rewardReelTrack.style.transform = `translateX(-${targetOffset}px)`;

    stopRewardReelTicking?.();
    stopRewardReelTicking = startRewardReelTicking(rewardReelTrack, REEL_TILE_STEP);

    rewardReelTrack.addEventListener('transitionend', function onSpinEnd(event) {
        if (event.propertyName !== 'transform') {
            return;
        }
        rewardReelTrack.removeEventListener('transitionend', onSpinEnd);
        stopRewardReelTicking?.();
        stopRewardReelTicking = null;
        if (spinToken !== rewardSpinToken) {
            return;
        }

        const landedTile = rewardReelTrack.children[REEL_LANDING_INDEX];
        landedTile?.classList.add('landed');

        setTimeout(() => {
            if (spinToken !== rewardSpinToken) {
                return;
            }
            revealRewardResult();
            spawnConfetti();
        }, 400);
    });
}

// createRewardTile now lives in task-shared.js.

function revealRewardResult() {
    rewardCard?.classList.add('revealed');
}

function closeRewardCelebration() {
    if (!rewardOverlay) {
        return;
    }

    rewardSpinToken += 1;
    stopRewardReelTicking?.();
    stopRewardReelTicking = null;
    rewardOverlay.classList.add('hidden');
    rewardOverlay.setAttribute('aria-hidden', 'true');
    rewardCard?.classList.remove('revealed');

    if (rewardReelTrack) {
        rewardReelTrack.style.transition = 'none';
        rewardReelTrack.innerHTML = '';
    }
    if (confettiField) {
        confettiField.innerHTML = '';
    }
}

function spawnConfetti() {
    playTaskCompleteSound();

    if (!confettiField) {
        return;
    }

    confettiField.innerHTML = '';

    const prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) {
        return;
    }

    const colors = ['#b58bff', '#7f86ff', '#8bdaff', '#f6f2ea', '#d7d0ff'];
    const pieceCount = 28;

    for (let i = 0; i < pieceCount; i += 1) {
        const piece = document.createElement('span');
        piece.className = 'confettiPiece';
        piece.style.left = `${Math.random() * 100}%`;
        piece.style.backgroundColor = colors[i % colors.length];
        piece.style.animationDelay = `${Math.random() * 0.4}s`;
        piece.style.animationDuration = `${1.6 + Math.random() * 1.2}s`;
        piece.style.transform = `rotate(${Math.random() * 360}deg)`;
        confettiField.appendChild(piece);
    }
}

function recomputeParentCompletionFromSubtasks(task) {
    const subtasks = task.subtasks || [];
    if (subtasks.length === 0) {
        return;
    }

    const allDone = subtasks.every((subtask) => subtask.completed);
    if (task.completed !== allDone) {
        setTaskCompletedState(task, allDone);
    }
}

function toggleSubtaskCompletion(taskId, subtaskId) {
    const task = findTaskById(taskId);
    if (!task) {
        return;
    }

    const subtask = (task.subtasks || []).find((item) => item.id === subtaskId);
    if (!subtask) {
        return;
    }

    subtask.completed = !subtask.completed;
    task.updatedAt = new Date().toISOString();
    recomputeParentCompletionFromSubtasks(task);

    applyOrdering();
    renderTasks();
    updateTaskSummary();
    updateUrgencyAlert();
    renderActivityHeatmap();
    saveTasks();
}

function addSubtaskToTask(taskId, text) {
    const trimmedText = (text || '').trim();
    if (trimmedText === '') {
        return;
    }

    const task = findTaskById(taskId);
    if (!task) {
        return;
    }

    if (!Array.isArray(task.subtasks)) {
        task.subtasks = [];
    }

    task.subtasks.push({
        id: generateSubtaskId(),
        text: trimmedText,
        completed: false,
        createdAt: new Date().toISOString()
    });
    task.subtasksExpanded = true;
    task.updatedAt = new Date().toISOString();
    recomputeParentCompletionFromSubtasks(task);

    applyOrdering();
    renderTasks();
    updateTaskSummary();
    updateUrgencyAlert();
    renderActivityHeatmap();
    saveTasks();
}

function deleteSubtaskFromTask(taskId, subtaskId) {
    const task = findTaskById(taskId);
    if (!task || !Array.isArray(task.subtasks)) {
        return;
    }

    const subtaskIndex = task.subtasks.findIndex((item) => item.id === subtaskId);
    if (subtaskIndex < 0) {
        return;
    }

    task.subtasks.splice(subtaskIndex, 1);
    task.updatedAt = new Date().toISOString();
    recomputeParentCompletionFromSubtasks(task);

    applyOrdering();
    renderTasks();
    updateTaskSummary();
    updateUrgencyAlert();
    renderActivityHeatmap();
    saveTasks();
}

function toggleSubtasksExpanded(taskId) {
    const task = findTaskById(taskId);
    if (!task) {
        return;
    }

    task.subtasksExpanded = !task.subtasksExpanded;
    renderTasks();
    saveTasks();
}

function deleteTask(taskId) {
    const deleteIndex = tasks.findIndex((task) => task.id === taskId);
    if (deleteIndex < 0) {
        return;
    }

    const [deletedTask] = tasks.splice(deleteIndex, 1);
    showUndoDeleteToast(deletedTask, deleteIndex);

    normalizeManualOrder();
    applyOrdering();
    renderTasks();
    updateTaskSummary();
    updateUrgencyAlert();
    saveTasks();
}

function showUndoDeleteToast(task, deletedIndex) {
    if (!undoToast || !undoToastText || !task) {
        return;
    }

    pendingDeletedTask = { task: { ...task }, deletedIndex };
    undoToastText.textContent = `Deleted: ${task.text}`;
    undoToast.classList.remove('hidden');

    if (undoDeleteTimeoutId) {
        clearTimeout(undoDeleteTimeoutId);
    }

    undoDeleteTimeoutId = setTimeout(() => {
        clearPendingDeleteState();
    }, UNDO_DELETE_TIMEOUT_MS);
}

function undoLastDelete() {
    if (!pendingDeletedTask) {
        return;
    }

    playClickSound();

    const insertIndex = Math.max(0, Math.min(tasks.length, pendingDeletedTask.deletedIndex));
    tasks.splice(insertIndex, 0, pendingDeletedTask.task);
    normalizeManualOrder();
    applyOrdering();
    renderTasks();
    updateTaskSummary();
    updateUrgencyAlert();
    saveTasks();
    clearPendingDeleteState();
}

function clearPendingDeleteState() {
    pendingDeletedTask = null;

    if (undoDeleteTimeoutId) {
        clearTimeout(undoDeleteTimeoutId);
        undoDeleteTimeoutId = null;
    }

    if (undoToast) {
        undoToast.classList.add('hidden');
    }
}

function editTask(taskId) {
    const task = findTaskById(taskId);
    if (!task || !taskEditorOverlay) {
        return;
    }

    const editorTextInput = taskEditorOverlay.querySelector('.editorTextInput');
    const editorMatrixSelect = taskEditorOverlay.querySelector('.editorMatrixSelect');
    const editorTaskTypeSelect = taskEditorOverlay.querySelector('.editorTaskTypeSelect');
    const editorDurationInput = taskEditorOverlay.querySelector('.editorDurationInput');
    const editorDifficultySelect = taskEditorOverlay.querySelector('.editorDifficultySelect');
    const editorDeadlineInput = taskEditorOverlay.querySelector('.editorDeadlineInput');
    const editorScheduleInput = taskEditorOverlay.querySelector('.editorScheduleInput');

    if (!editorTextInput || !editorMatrixSelect || !editorTaskTypeSelect || !editorDurationInput || !editorDifficultySelect || !editorDeadlineInput) {
        return;
    }

    activeEditorTaskId = taskId;
    editorTextInput.value = task.text;
    editorMatrixSelect.value = getValidMatrixValue(task.matrix);
    editorTaskTypeSelect.value = getValidTaskType(task.taskType);
    editorDurationInput.value = task.estimateMinutes ? String(task.estimateMinutes) : '';
    editorDifficultySelect.value = String(getValidDifficultyLevel(task.difficulty));
    editorDeadlineInput.value = task.dueAt ? toDatetimeLocalValue(task.dueAt) : '';
    if (editorScheduleInput) {
        editorScheduleInput.value = task.scheduledAt ? toDatetimeLocalValue(task.scheduledAt) : '';
    }

    updateEditorDurationInputVisibility();

    taskEditorOverlay.classList.add('open');
    editorTextInput.focus();
    editorTextInput.select();
}

function initializeTaskEditor() {
    taskEditorOverlay = document.createElement('div');
    taskEditorOverlay.className = 'taskEditorOverlay';
    taskEditorOverlay.innerHTML = `
        <div class="taskEditorCard" role="dialog" aria-modal="true" aria-label="Edit task">
            <h2>Edit Task</h2>
            <label>
                Task
                <input type="text" class="editorTextInput" maxlength="240">
            </label>
            <label>
                Task Matrix
                <select class="editorMatrixSelect">
                    <option value="do">Task Matrix: Important & Urgent</option>
                    <option value="schedule">Task Matrix: Important</option>
                    <option value="delegate">Task Matrix: Urgent</option>
                    <option value="eliminate">Task Matrix: None</option>
                </select>
            </label>
            <label>
                Task Type
                <div class="editorEffortRow">
                    <select class="editorTaskTypeSelect">
                        <option value="timeboxed">Estimate time</option>
                        <option value="open">No time estimate</option>
                    </select>
                    <input type="number" class="editorDurationInput" min="5" step="5" placeholder="Minutes">
                </div>
            </label>
            <label>
                Difficulty
                <select class="editorDifficultySelect">
                    <option value="1">1 (Very Easy)</option>
                    <option value="2">2 (Easy)</option>
                    <option value="3" selected>3 (Medium)</option>
                    <option value="4">4 (Hard)</option>
                    <option value="5">5 (Very Hard)</option>
                </select>
            </label>
            <label>
                Deadline
                <div class="editorDeadlineWrap">
                    <input type="datetime-local" class="editorDeadlineInput">
                    <button type="button" class="editorCalendarBtn" aria-label="Open edit deadline calendar">
                        <i class="fa-regular fa-calendar"></i>
                    </button>
                </div>
            </label>
            <label>
                Schedule (when you'll actually do it)
                <div class="editorDeadlineWrap editorScheduleWrap">
                    <input type="datetime-local" class="editorDeadlineInput editorScheduleInput">
                    <button type="button" class="editorCalendarBtn editorScheduleCalendarBtn" aria-label="Open edit schedule calendar">
                        <i class="fa-solid fa-clock"></i>
                    </button>
                </div>
            </label>
            <div class="editorActions">
                <button type="button" class="editorCancelBtn">Cancel</button>
                <button type="button" class="editorSaveBtn">Save</button>
            </div>
        </div>
    `;

    document.body.appendChild(taskEditorOverlay);

    const editorTextInput = taskEditorOverlay.querySelector('.editorTextInput');
    const editorMatrixSelect = taskEditorOverlay.querySelector('.editorMatrixSelect');
    const editorTaskTypeSelect = taskEditorOverlay.querySelector('.editorTaskTypeSelect');
    const editorDifficultySelect = taskEditorOverlay.querySelector('.editorDifficultySelect');
    const editorDurationInput = taskEditorOverlay.querySelector('.editorDurationInput');
    const editorDeadlineInput = taskEditorOverlay.querySelector('.editorDeadlineInput');
    const editorDeadlineWrap = taskEditorOverlay.querySelector('.editorDeadlineWrap');
    const editorCalendarBtn = taskEditorOverlay.querySelector('.editorCalendarBtn');
    const editorScheduleInput = taskEditorOverlay.querySelector('.editorScheduleInput');
    const editorScheduleWrap = taskEditorOverlay.querySelector('.editorScheduleWrap');
    const editorScheduleCalendarBtn = taskEditorOverlay.querySelector('.editorScheduleCalendarBtn');
    const editorCancelBtn = taskEditorOverlay.querySelector('.editorCancelBtn');
    sanitizeNumberInputAsPositiveInteger(editorDurationInput);
    const editorSaveBtn = taskEditorOverlay.querySelector('.editorSaveBtn');

    if (editorTaskTypeSelect) {
        editorTaskTypeSelect.addEventListener('change', () => {
            playClickSound();
            updateEditorDurationInputVisibility();
        });
    }

    if (editorMatrixSelect) {
        editorMatrixSelect.addEventListener('change', playClickSound);
    }

    if (editorDifficultySelect) {
        editorDifficultySelect.addEventListener('change', playClickSound);
    }

    if (editorCalendarBtn && editorDeadlineInput) {
        editorCalendarBtn.addEventListener('click', () => {
            if (typeof editorDeadlineInput.showPicker === 'function') {
                editorDeadlineInput.showPicker();
            } else {
                editorDeadlineInput.focus();
            }
        });
    }

    if (editorDeadlineWrap && editorDeadlineInput) {
        editorDeadlineWrap.addEventListener('click', (event) => {
            if (event.target.closest('.editorCalendarBtn')) {
                return;
            }
            if (typeof editorDeadlineInput.showPicker === 'function') {
                editorDeadlineInput.showPicker();
            } else {
                editorDeadlineInput.focus();
            }
        });
    }

    if (editorScheduleCalendarBtn && editorScheduleInput) {
        editorScheduleCalendarBtn.addEventListener('click', () => {
            if (typeof editorScheduleInput.showPicker === 'function') {
                editorScheduleInput.showPicker();
            } else {
                editorScheduleInput.focus();
            }
        });
    }

    if (editorScheduleWrap && editorScheduleInput) {
        editorScheduleWrap.addEventListener('click', (event) => {
            if (event.target.closest('.editorScheduleCalendarBtn')) {
                return;
            }
            if (typeof editorScheduleInput.showPicker === 'function') {
                editorScheduleInput.showPicker();
            } else {
                editorScheduleInput.focus();
            }
        });
    }

    if (editorCancelBtn) {
        editorCancelBtn.addEventListener('click', closeTaskEditor);
    }

    if (editorSaveBtn) {
        editorSaveBtn.addEventListener('click', saveTaskEditorChanges);
    }

    if (editorTextInput) {
        editorTextInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                saveTaskEditorChanges();
            }
        });
    }

    taskEditorOverlay.addEventListener('click', (event) => {
        if (event.target === taskEditorOverlay) {
            closeTaskEditor();
        }
    });

    if (editorDurationInput) {
        editorDurationInput.classList.add('hidden');
    }
}

function updateEditorDurationInputVisibility() {
    if (!taskEditorOverlay) {
        return;
    }

    const editorTaskTypeSelect = taskEditorOverlay.querySelector('.editorTaskTypeSelect');
    const editorDurationInput = taskEditorOverlay.querySelector('.editorDurationInput');

    if (!editorTaskTypeSelect || !editorDurationInput) {
        return;
    }

    const isTimeboxed = getValidTaskType(editorTaskTypeSelect.value) === 'timeboxed';
    editorDurationInput.classList.toggle('hidden', !isTimeboxed);

    if (!isTimeboxed) {
        editorDurationInput.value = '';
    }
}

function closeTaskEditor() {
    if (!taskEditorOverlay) {
        return;
    }

    taskEditorOverlay.classList.remove('open');
    activeEditorTaskId = null;
}

function saveTaskEditorChanges() {
    if (!taskEditorOverlay || !activeEditorTaskId) {
        return;
    }

    const task = findTaskById(activeEditorTaskId);
    if (!task) {
        closeTaskEditor();
        return;
    }

    const editorTextInput = taskEditorOverlay.querySelector('.editorTextInput');
    const editorMatrixSelect = taskEditorOverlay.querySelector('.editorMatrixSelect');
    const editorTaskTypeSelect = taskEditorOverlay.querySelector('.editorTaskTypeSelect');
    const editorDurationInput = taskEditorOverlay.querySelector('.editorDurationInput');
    const editorDifficultySelect = taskEditorOverlay.querySelector('.editorDifficultySelect');
    const editorDeadlineInput = taskEditorOverlay.querySelector('.editorDeadlineInput');
    const editorScheduleInput = taskEditorOverlay.querySelector('.editorScheduleInput');

    if (!editorTextInput || !editorMatrixSelect || !editorTaskTypeSelect || !editorDurationInput || !editorDifficultySelect || !editorDeadlineInput) {
        closeTaskEditor();
        return;
    }

    const updatedText = editorTextInput.value.trim();
    if (updatedText === '') {
        alert('Task text cannot be empty.');
        editorTextInput.focus();
        return;
    }

    const updatedTaskType = getValidTaskType(editorTaskTypeSelect.value);

    task.text = updatedText;
    task.matrix = getValidMatrixValue(editorMatrixSelect.value);
    task.taskType = updatedTaskType;
    task.estimateMinutes = updatedTaskType === 'timeboxed' ? parseDurationMinutes(editorDurationInput.value) : null;
    task.difficulty = getValidDifficultyLevel(editorDifficultySelect.value);
    task.dueAt = parseDeadlineInput(editorDeadlineInput.value);
    task.scheduledAt = editorScheduleInput ? parseDeadlineInput(editorScheduleInput.value) : task.scheduledAt;
    task.updatedAt = new Date().toISOString();

    applyOrdering();
    renderTasks();
    updateTaskSummary();
    updateUrgencyAlert();
    saveTasks();
    closeTaskEditor();
}

function applyOrdering() {
    if (isAutoPrioritize) {
        tasks.sort(compareByPriority);
        return;
    }

    tasks.sort((a, b) => {
        const orderDiff = (a.manualOrder || 0) - (b.manualOrder || 0);
        if (orderDiff !== 0) {
            return orderDiff;
        }
        return compareByCreatedTime(a, b);
    });
}

function compareByPriority(taskA, taskB) {
    if (taskA.completed !== taskB.completed) {
        return taskA.completed ? 1 : -1;
    }

    const scoreA = getPriorityScore(taskA);
    const scoreB = getPriorityScore(taskB);
    if (scoreA !== scoreB) {
        return scoreB - scoreA;
    }

    const statusA = getDeadlineStatus(taskA.dueAt);
    const statusB = getDeadlineStatus(taskB.dueAt);
    if (statusA.deadlineTimestamp !== statusB.deadlineTimestamp) {
        return statusA.deadlineTimestamp - statusB.deadlineTimestamp;
    }

    return compareByCreatedTime(taskA, taskB);
}

function getPriorityScore(task) {
    const status = getDeadlineStatus(task.dueAt);
    const matrixRank = MATRIX_CONFIG[getValidMatrixValue(task.matrix)].rank;
    const typeRank = TASK_TYPE_CONFIG[getValidTaskType(task.taskType)].rank;
    const difficultyRank = DIFFICULTY_CONFIG[getValidDifficultyLevel(task.difficulty)].rank;

    let score = 0;

    if (status.isOverdue) {
        score += 1000;
        score += Math.min(320, Math.abs(status.timeUntilMs) / 3600000);
    } else if (status.hasDeadline) {
        const hoursLeft = Math.max(1, status.timeUntilMs / 3600000);
        score += Math.max(0, 260 - Math.min(260, hoursLeft));

        // Heavy tasks with less time left should move up sooner.
        const effortPressure = difficultyRank / hoursLeft;
        score += Math.min(180, effortPressure * 140);
    }

    score += matrixRank * 45;
    score += difficultyRank * 20;
    score += typeRank * 6;

    if (getValidTaskType(task.taskType) === 'timeboxed' && task.estimateMinutes) {
        score += Math.min(30, task.estimateMinutes / 10);
    }

    const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];
    if (subtasks.length > 0) {
        const doneFraction = subtasks.filter((subtask) => subtask.completed).length / subtasks.length;

        // A nearly-finished task under deadline pressure should outrank a
        // barely-started one with the same deadline/matrix/difficulty.
        if (status.isOverdue || status.hasDeadline) {
            score += doneFraction * 80;
        }
        score += doneFraction * 10;
    }

    if (task.scheduledAt && isValidDateValue(task.scheduledAt)) {
        // Smaller than deadline urgency: a soft nudge so a task rises toward
        // the top around the time the user actually planned to do it,
        // without overriding a real deadline's urgency.
        const hoursFromNow = Math.abs(new Date(task.scheduledAt).getTime() - Date.now()) / 3600000;
        if (hoursFromNow <= 12) {
            score += Math.max(0, 60 - (hoursFromNow * 5));
        }
    }

    return Math.round(score * 1000);
}

function compareByCreatedTime(taskA, taskB) {
    const createdA = new Date(taskA.createdAt).getTime() || 0;
    const createdB = new Date(taskB.createdAt).getTime() || 0;

    if (createdA !== createdB) {
        return createdA - createdB;
    }

    return taskA.id.localeCompare(taskB.id);
}

function updateTaskSummary() {
    const totalTasks = tasks.length;
    const completedTasks = tasks.filter((task) => task.completed).length;

    taskAmountText.textContent = `${completedTasks}/${totalTasks}`;

    const progressPercent = totalTasks === 0 ? 0 : (completedTasks / totalTasks) * 100;
    progressBar.style.width = `${progressPercent}%`;

    if (progressPercent === 100 && totalTasks > 0) {
        motivatorText.textContent = 'Great job!';
    } else if (progressPercent >= 50) {
        motivatorText.textContent = 'Doing well!';
    } else if (progressPercent > 0) {
        motivatorText.textContent = 'Keep it up!';
    } else {
        motivatorText.textContent = "Let's start!";
    }
}

function updatePriorityModeHint() {
    sortOnceBtn.disabled = isAutoPrioritize || activeView !== 'all';

    if (isAutoPrioritize) {
        priorityModeHint.textContent = 'Auto-sort is on: tasks reorder continuously so your best next task stays at the top.';
        return;
    }

    if (activeView !== 'all') {
        priorityModeHint.textContent = 'Manual mode with filtered view: drag and drop is disabled. Switch to All to reorder.';
        return;
    }

    priorityModeHint.textContent = 'Manual mode: drag to reorder anytime. Use Sort once now for a one-time smart order.';
}

// Solo tasks now live in Firestore (see subscribeToCloudTasks/syncTasksToCloud
// below). This only reads localStorage, purely to offer a one-time import of
// whatever was there from before cloud sync existed — it never touches the
// live `tasks` array or writes anything itself.
function getLocalTasksForMigration() {
    const v3 = localStorage.getItem(STORAGE_KEY);
    if (v3) {
        try {
            const parsed = JSON.parse(v3);
            if (Array.isArray(parsed) && parsed.length > 0) {
                return parsed.map((task, index) => normalizeTask(task, index + 1));
            }
        } catch {
            // fall through to older formats
        }
    }

    const v2 = localStorage.getItem(PREV_STORAGE_KEY);
    if (v2) {
        try {
            const parsed = JSON.parse(v2);
            if (Array.isArray(parsed) && parsed.length > 0) {
                return parsed.map((task, index) => normalizeTask(task, index + 1));
            }
        } catch {
            // fall through to legacy format
        }
    }

    const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacyRaw) {
        try {
            const parsed = JSON.parse(legacyRaw);
            if (Array.isArray(parsed)) {
                const now = Date.now();
                const legacyTasks = parsed
                    .filter((task) => typeof task.text === 'string' && task.text.trim() !== '')
                    .map((task, index) => normalizeTask({
                        text: task.text.trim(),
                        completed: Boolean(task.completed),
                        matrix: 'schedule',
                        difficulty: 3,
                        taskType: 'open',
                        createdAt: new Date(now + index).toISOString()
                    }, index + 1));

                if (legacyTasks.length > 0) {
                    return legacyTasks;
                }
            }
        } catch {
            // no usable legacy data
        }
    }

    return [];
}

function loadSettings() {
    const saved = localStorage.getItem(SETTINGS_KEY);
    if (!saved) {
        isAutoPrioritize = false;
        priorityToggle.checked = false;
        popupAlertsEnabled = false;
        showDifficultyBadgesOnMobile = true;
        updateDifficultyVisibilityControl();
        return;
    }

    try {
        const parsed = JSON.parse(saved);
        isAutoPrioritize = Boolean(parsed.autoPrioritize);
        priorityToggle.checked = isAutoPrioritize;
        popupAlertsEnabled = Boolean(parsed.popupAlertsEnabled);
        showDifficultyBadgesOnMobile = parsed.showDifficultyBadgesOnMobile !== false;

        if (!('Notification' in window) || Notification.permission !== 'granted') {
            popupAlertsEnabled = false;
        }

        updateDifficultyVisibilityControl();
    } catch {
        isAutoPrioritize = false;
        priorityToggle.checked = false;
        popupAlertsEnabled = false;
        showDifficultyBadgesOnMobile = true;
        updateDifficultyVisibilityControl();
    }
}

function updateDifficultyVisibilityControl() {
    if (!difficultyVisibilityToggle) {
        return;
    }

    difficultyVisibilityToggle.checked = showDifficultyBadgesOnMobile;
}

function saveTasks() {
    syncTasksToCloud();
}

// Upserts every current task and deletes any task Firestore still has that
// isn't in the local array anymore (covers deleteTask() and undo-restore
// generically, without a separate cloud-delete call at each site).
async function syncTasksToCloud() {
    if (!window.ToDoAuth?.auth?.currentUser) {
        return;
    }

    const uid = window.ToDoAuth.auth.currentUser.uid;
    const { db, firestore } = window.ToDoAuth;
    const { doc, writeBatch } = firestore;

    const currentIds = new Set(tasks.map((task) => task.id));
    const idsToDelete = Array.from(knownCloudTaskIds).filter((id) => !currentIds.has(id));

    try {
        const batch = writeBatch(db);
        tasks.forEach((task) => {
            batch.set(doc(db, 'users', uid, 'tasks', task.id), task);
        });
        idsToDelete.forEach((id) => {
            batch.delete(doc(db, 'users', uid, 'tasks', id));
        });
        await batch.commit();

        idsToDelete.forEach((id) => knownCloudTaskIds.delete(id));
        currentIds.forEach((id) => knownCloudTaskIds.add(id));
    } catch (error) {
        console.error('Failed to save tasks to the cloud:', error);
    }
}

function subscribeToCloudTasks() {
    if (!window.ToDoAuth?.auth?.currentUser) {
        return;
    }

    const uid = window.ToDoAuth.auth.currentUser.uid;
    const { db, firestore } = window.ToDoAuth;
    const { collection, onSnapshot } = firestore;
    const tasksRef = collection(db, 'users', uid, 'tasks');

    if (unsubscribeCloudTasks) {
        unsubscribeCloudTasks();
    }

    unsubscribeCloudTasks = onSnapshot(tasksRef, (snapshot) => {
        const rawTasks = snapshot.docs.map((docSnapshot) => ({ id: docSnapshot.id, ...docSnapshot.data() }));
        knownCloudTaskIds = new Set(rawTasks.map((task) => task.id));
        tasks = rawTasks.map((task, index) => normalizeTask(task, index + 1));
        normalizeManualOrder();

        if (!hasLoadedCloudTasksOnce) {
            hasLoadedCloudTasksOnce = true;
            maybeOfferLocalImport();
        }

        applyOrdering();
        renderTasks();
        updateTaskSummary();
        updateUrgencyAlert();
        renderActivityHeatmap();
    }, (error) => {
        console.error('Failed to sync tasks from the cloud:', error);
    });
}

function maybeOfferLocalImport() {
    if (tasks.length > 0) {
        return;
    }

    const localTasks = getLocalTasksForMigration();
    if (localTasks.length === 0) {
        return;
    }

    const shouldImport = confirm(`Found ${localTasks.length} task(s) saved on this device from before sign-in. Import them into your account?`);
    if (!shouldImport) {
        return;
    }

    tasks = localTasks;
    normalizeManualOrder();
    applyOrdering();
    renderTasks();
    updateTaskSummary();
    updateUrgencyAlert();
    saveTasks();
}

function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        autoPrioritize: isAutoPrioritize,
        popupAlertsEnabled,
        showDifficultyBadgesOnMobile
    }));
}

function loadActivityCounts() {
    const raw = localStorage.getItem(ACTIVITY_KEY);
    if (!raw) {
        activityCountsByDate = {};
        return;
    }

    try {
        const parsed = JSON.parse(raw);
        activityCountsByDate = parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        activityCountsByDate = {};
    }

    pruneActivityCounts();
}

function loadActivityHistory() {
    const raw = localStorage.getItem(ACTIVITY_HISTORY_KEY);
    if (!raw) {
        activityHistoryByDate = {};
        return;
    }

    try {
        const parsed = JSON.parse(raw);
        activityHistoryByDate = parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        activityHistoryByDate = {};
    }

    pruneActivityHistory();
}

function saveActivityCounts() {
    localStorage.setItem(ACTIVITY_KEY, JSON.stringify(activityCountsByDate));
}

function saveActivityHistory() {
    localStorage.setItem(ACTIVITY_HISTORY_KEY, JSON.stringify(activityHistoryByDate));
}

function addActivityCount(delta) {
    const todayKey = getDateKey(new Date());
    const current = Number(activityCountsByDate[todayKey]) || 0;
    const next = Math.max(0, current + delta);

    if (next === 0) {
        delete activityCountsByDate[todayKey];
    } else {
        activityCountsByDate[todayKey] = next;
    }

    pruneActivityCounts();
    saveActivityCounts();
}

function addActivityHistoryEntry(task) {
    const todayKey = getDateKey(new Date());
    if (!Array.isArray(activityHistoryByDate[todayKey])) {
        activityHistoryByDate[todayKey] = [];
    }

    activityHistoryByDate[todayKey].push({
        taskId: task.id,
        taskText: task.text,
        completedAt: new Date().toISOString()
    });

    pruneActivityHistory();
    saveActivityHistory();
}

function removeLatestActivityHistoryEntry(task) {
    const todayKey = getDateKey(new Date());
    const entries = activityHistoryByDate[todayKey];
    if (!Array.isArray(entries) || entries.length === 0) {
        return;
    }

    const entryIndex = [...entries].reverse().findIndex((entry) => entry.taskId === task.id);
    if (entryIndex < 0) {
        return;
    }

    const actualIndex = entries.length - 1 - entryIndex;
    entries.splice(actualIndex, 1);

    if (entries.length === 0) {
        delete activityHistoryByDate[todayKey];
    }

    saveActivityHistory();
}

function pruneActivityCounts() {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 220);

    Object.keys(activityCountsByDate).forEach((dateKey) => {
        const date = new Date(`${dateKey}T00:00:00`);
        if (Number.isNaN(date.getTime()) || date < cutoff) {
            delete activityCountsByDate[dateKey];
        }
    });
}

function pruneActivityHistory() {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 220);

    Object.keys(activityHistoryByDate).forEach((dateKey) => {
        const date = new Date(`${dateKey}T00:00:00`);
        if (Number.isNaN(date.getTime()) || date < cutoff) {
            delete activityHistoryByDate[dateKey];
            return;
        }

        const entries = Array.isArray(activityHistoryByDate[dateKey]) ? activityHistoryByDate[dateKey] : [];
        activityHistoryByDate[dateKey] = entries.filter((entry) => typeof entry?.taskText === 'string' && entry.taskText.trim() !== '');

        if (activityHistoryByDate[dateKey].length === 0) {
            delete activityHistoryByDate[dateKey];
        }
    });
}

function renderActivityHeatmap() {
    if (!activityGrid || !activitySummary || !activityMonthRow || !activityDayLabels) {
        return;
    }

    const totalWeeks = 26;
    const totalDays = totalWeeks * 7;
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const activityStart = new Date(today);
    activityStart.setDate(today.getDate() - (182 - 1));

    const currentWeekStart = new Date(today);
    currentWeekStart.setDate(today.getDate() - today.getDay());

    // Anchor the grid to the current week so "this week" is always visible.
    const calendarEnd = new Date(currentWeekStart);
    calendarEnd.setDate(currentWeekStart.getDate() + 6);

    const calendarStart = new Date(calendarEnd);
    calendarStart.setDate(calendarEnd.getDate() - (totalDays - 1));

    activityGrid.style.gridTemplateColumns = `repeat(${totalWeeks}, minmax(0, 1fr))`;
    activityMonthRow.style.gridTemplateColumns = `repeat(${totalWeeks}, minmax(0, 1fr))`;

    activityMonthRow.innerHTML = '';
    activityDayLabels.innerHTML = '';
    activityGrid.innerHTML = '';

    let activeDays = 0;
    let todayCompletions = 0;
    let thisWeekCompletions = 0;
    let lastMonth = null;
    let lastLabeledWeek = -10;

    dayNames.forEach((name) => {
        const label = document.createElement('span');
        label.className = 'activityDayLabel';
        label.textContent = name;
        activityDayLabels.appendChild(label);
    });

    for (let week = 0; week < totalWeeks; week += 1) {
        const weekDate = new Date(calendarStart);
        weekDate.setDate(calendarStart.getDate() + (week * 7));
        const currentMonth = weekDate.getMonth();

        const monthCell = document.createElement('span');
        monthCell.className = 'activityMonthLabel';
        const isMonthStart = currentMonth !== lastMonth;
        const hasEnoughSpacing = week - lastLabeledWeek >= 3;
        monthCell.textContent = isMonthStart && hasEnoughSpacing ? monthNames[currentMonth] : '';
        if (monthCell.textContent) {
            lastLabeledWeek = week;
        }
        activityMonthRow.appendChild(monthCell);
        lastMonth = currentMonth;
    }

    for (let i = 0; i < totalDays; i += 1) {
        const date = new Date(calendarStart);
        date.setDate(calendarStart.getDate() + i);
        const dateKey = getDateKey(date);
        const inWindow = date >= activityStart && date <= today;
        const count = Number(activityCountsByDate[dateKey]) || 0;
        if (inWindow && count > 0) {
            activeDays += 1;
        }

        if (inWindow && dateKey === getDateKey(today)) {
            todayCompletions = count;
        }

        if (inWindow && date >= currentWeekStart && date <= today) {
            thisWeekCompletions += count;
        }

        const cell = document.createElement('span');
        cell.className = `heatCell level-${getHeatLevel(count)}`;
        if (!inWindow) {
            cell.classList.add('outside-window');
        }

        const dayLabel = date.toLocaleDateString([], {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            year: 'numeric'
        });
        const tooltipText = `${dayLabel}: ${count} completed task${count === 1 ? '' : 's'}`;
        cell.setAttribute('aria-label', tooltipText);
        cell.dataset.dateKey = dateKey;
        cell.dataset.dayLabel = dayLabel;
        cell.addEventListener('mouseenter', (event) => showActivityTooltip(tooltipText, event));
        cell.addEventListener('mousemove', moveActivityTooltip);
        cell.addEventListener('mouseleave', hideActivityTooltip);
        cell.addEventListener('click', (event) => {
            event.stopPropagation();
            playClickSound();
            openActivityDetails(dateKey, dayLabel, count);
        });
        activityGrid.appendChild(cell);
    }

    activitySummary.textContent = `Today: ${todayCompletions} | This week: ${thisWeekCompletions} | ${activeDays} active day${activeDays === 1 ? '' : 's'} in last 6 months`;
    activityGrid.setAttribute('aria-label', `Activity heatmap for the last 6 months ending ${getDateKey(today)}`);
    lastActivityRenderDateKey = getDateKey(today);
}

function openActivityDetails(dateKey, dayLabel, count) {
    if (!activityDetailsOverlay || !activityDetailsTitle || !activityDetailsMeta || !activityDetailsList) {
        return;
    }

    const entries = Array.isArray(activityHistoryByDate[dateKey])
        ? [...activityHistoryByDate[dateKey]].sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime())
        : [];

    activityDetailsTitle.textContent = dayLabel;
    activityDetailsMeta.textContent = `${count} completed task${count === 1 ? '' : 's'}`;
    activityDetailsList.innerHTML = '';

    if (entries.length === 0) {
        const noEntry = document.createElement('li');
        noEntry.className = 'activityDetailsEmpty';
        noEntry.textContent = count > 0
            ? 'Task-level details were not recorded for this date yet.'
            : 'No completed tasks on this day.';
        activityDetailsList.appendChild(noEntry);
    } else {
        entries.forEach((entry) => {
            const item = document.createElement('li');
            item.className = 'activityDetailsItem';

            const taskText = document.createElement('p');
            taskText.className = 'activityDetailsTaskText';
            taskText.textContent = entry.taskText;

            const completedAt = document.createElement('p');
            completedAt.className = 'activityDetailsTaskTime';
            completedAt.textContent = isValidDateValue(entry.completedAt)
                ? `Completed at ${new Date(entry.completedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
                : 'Completed';

            item.appendChild(taskText);
            item.appendChild(completedAt);
            activityDetailsList.appendChild(item);
        });
    }

    activityDetailsOverlay.classList.remove('hidden');
    activityDetailsOverlay.setAttribute('aria-hidden', 'false');
}

function closeActivityDetails() {
    if (!activityDetailsOverlay) {
        return;
    }

    activityDetailsOverlay.classList.add('hidden');
    activityDetailsOverlay.setAttribute('aria-hidden', 'true');
}

function ensureActivityTooltip() {
    if (activityTooltip || !activityPanel) {
        return;
    }

    activityTooltip = document.createElement('div');
    activityTooltip.className = 'activityTooltip hidden';
    document.body.appendChild(activityTooltip);
}

function showActivityTooltip(text, event) {
    ensureActivityTooltip();
    if (!activityTooltip) {
        return;
    }

    activityTooltip.textContent = text;
    activityTooltip.classList.remove('hidden');
    moveActivityTooltip(event);
}

function moveActivityTooltip(event) {
    if (!activityTooltip || activityTooltip.classList.contains('hidden')) {
        return;
    }

    const offset = 14;
    const tooltipRect = activityTooltip.getBoundingClientRect();
    const maxLeft = window.innerWidth - tooltipRect.width - 8;
    const maxTop = window.innerHeight - tooltipRect.height - 8;
    const pointerX = typeof event?.clientX === 'number' ? event.clientX : (window.innerWidth / 2);
    const pointerY = typeof event?.clientY === 'number' ? event.clientY : (window.innerHeight / 2);

    const left = Math.max(8, Math.min(maxLeft, pointerX + offset));
    const top = Math.max(8, Math.min(maxTop, pointerY + offset));

    activityTooltip.style.left = `${left}px`;
    activityTooltip.style.top = `${top}px`;
}

function hideActivityTooltip() {
    if (!activityTooltip) {
        return;
    }
    activityTooltip.classList.add('hidden');
}

function getHeatLevel(count) {
    if (count <= 0) {
        return 0;
    }
    if (count === 1) {
        return 1;
    }
    if (count <= 3) {
        return 2;
    }
    if (count <= 5) {
        return 3;
    }
    return 4;
}

// getDateKey now lives in task-shared.js.

function normalizeTask(task, fallbackManualOrder) {
    const createdAt = isValidDateValue(task.createdAt)
        ? new Date(task.createdAt).toISOString()
        : new Date().toISOString();

    const dueAt = task.dueAt && isValidDateValue(task.dueAt)
        ? new Date(task.dueAt).toISOString()
        : null;

    const scheduledAt = task.scheduledAt && isValidDateValue(task.scheduledAt)
        ? new Date(task.scheduledAt).toISOString()
        : null;

    return {
        id: typeof task.id === 'string' && task.id.trim() !== '' ? task.id : generateTaskId(),
        text: typeof task.text === 'string' ? task.text.trim() : '',
        completed: Boolean(task.completed),
        matrix: getValidMatrixValue(task.matrix),
        difficulty: getValidDifficultyLevel(task.difficulty),
        taskType: getValidTaskType(task.taskType),
        estimateMinutes: parseDurationMinutes(task.estimateMinutes),
        dueAt,
        scheduledAt,
        createdAt,
        updatedAt: isValidDateValue(task.updatedAt) ? new Date(task.updatedAt).toISOString() : createdAt,
        manualOrder: Number.isFinite(task.manualOrder) ? Number(task.manualOrder) : fallbackManualOrder,
        subtasks: normalizeSubtasks(task.subtasks),
        subtasksExpanded: Boolean(task.subtasksExpanded)
    };
}

function normalizeSubtasks(subtasks) {
    if (!Array.isArray(subtasks)) {
        return [];
    }

    return subtasks
        .map((subtask) => normalizeSubtask(subtask))
        .filter((subtask) => subtask !== null);
}

function normalizeSubtask(subtask) {
    if (!subtask || typeof subtask.text !== 'string' || subtask.text.trim() === '') {
        return null;
    }

    const createdAt = isValidDateValue(subtask.createdAt)
        ? new Date(subtask.createdAt).toISOString()
        : new Date().toISOString();

    return {
        id: typeof subtask.id === 'string' && subtask.id.trim() !== '' ? subtask.id : generateSubtaskId(),
        text: subtask.text.trim(),
        completed: Boolean(subtask.completed),
        createdAt
    };
}

function normalizeManualOrder() {
    tasks.sort((a, b) => (a.manualOrder || 0) - (b.manualOrder || 0));
    tasks.forEach((task, index) => {
        task.manualOrder = index + 1;
    });
}

// getValidMatrixValue, getValidDifficultyLevel, TASK_TYPE_CONFIG,
// getValidTaskType, and parseDurationMinutes now live in task-shared.js.

function parseDeadlineInput(value) {
    if (!value) {
        return null;
    }

    const parsedDate = new Date(value);
    if (Number.isNaN(parsedDate.getTime())) {
        return null;
    }

    return parsedDate.toISOString();
}

function toDatetimeLocalValue(isoValue) {
    if (!isoValue || !isValidDateValue(isoValue)) {
        return '';
    }

    const date = new Date(isoValue);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');

    return `${year}-${month}-${day}T${hours}:${minutes}`;
}

// getDeadlineStatus now lives in task-shared.js.

// getTaskDisplayDeadlineStatus now lives in task-shared.js.

function refreshDeadlineBadges() {
    let notificationCandidate = null;

    tasksList.querySelectorAll('li').forEach((taskItem) => {
        const taskId = taskItem.dataset.taskId;
        if (!taskId) {
            return;
        }

        const task = findTaskById(taskId);
        if (!task) {
            return;
        }

        const deadlineBadge = taskItem.querySelector('.deadlineBadge');
        const countdownBadge = taskItem.querySelector('.countdownBadge');
        const effortBadge = taskItem.querySelector('.effortBadge');
        if (!deadlineBadge || !countdownBadge || !effortBadge) {
            return;
        }

        const deadlineStatus = getTaskDisplayDeadlineStatus(task);

        deadlineBadge.classList.remove('deadline-none', 'deadline-normal', 'deadline-soon', 'deadline-critical', 'deadline-overdue');
        deadlineBadge.classList.add(deadlineStatus.deadlineClassName);
        deadlineBadge.textContent = deadlineStatus.deadlineLabel;

        countdownBadge.classList.remove('countdown-none', 'countdown-normal', 'countdown-soon', 'countdown-critical', 'countdown-overdue');
        countdownBadge.classList.add(deadlineStatus.countdownClassName);
        countdownBadge.textContent = deadlineStatus.countdownLabel;

        taskItem.classList.remove('status-normal', 'status-soon', 'status-critical', 'status-overdue');
        taskItem.classList.add(`status-${deadlineStatus.urgencyLevel}`);

        effortBadge.textContent = getEffortLabel(task);

        if (!isNotifiableUrgency(task, deadlineStatus)) {
            return;
        }

        if (!notificationCandidate) {
            notificationCandidate = { task, status: deadlineStatus };
            return;
        }

        const currentRank = getUrgencyRank(deadlineStatus.urgencyLevel);
        const candidateRank = getUrgencyRank(notificationCandidate.status.urgencyLevel);

        if (currentRank > candidateRank) {
            notificationCandidate = { task, status: deadlineStatus };
            return;
        }

        if (currentRank === candidateRank && deadlineStatus.deadlineTimestamp < notificationCandidate.status.deadlineTimestamp) {
            notificationCandidate = { task, status: deadlineStatus };
        }
    });

    if (notificationCandidate) {
        maybeNotifyTaskUrgency(notificationCandidate.task, notificationCandidate.status);
    }
}

function getUrgencyRank(urgencyLevel) {
    if (urgencyLevel === 'overdue') {
        return 3;
    }
    if (urgencyLevel === 'critical') {
        return 2;
    }
    if (urgencyLevel === 'soon') {
        return 1;
    }
    return 0;
}

function isNotifiableUrgency(task, status) {
    return Boolean(status.hasDeadline && !task.completed && getUrgencyRank(status.urgencyLevel) > 0);
}

function maybeNotifyTaskUrgency(task, status) {
    if (!popupAlertsEnabled || !('Notification' in window) || Notification.permission !== 'granted') {
        return;
    }

    if (!status.hasDeadline || task.completed || status.urgencyLevel === 'normal') {
        return;
    }

    const stage = status.urgencyLevel;

    const now = Date.now();
    const stageCooldown = REMINDER_COOLDOWN_MS[stage] || REMINDER_COOLDOWN_MS.soon;
    const notifyKey = `${task.id}|${task.dueAt || ''}|${stage}`;
    const lastStageReminderAt = stageReminderTimestamps.get(notifyKey) || 0;

    if (lastStageReminderAt > 0 && now - lastStageReminderAt < stageCooldown) {
        return;
    }

    if (now - lastGlobalReminderAt < GLOBAL_REMINDER_GAP_MS) {
        return;
    }

    stageReminderTimestamps.set(notifyKey, now);
    lastGlobalReminderAt = now;
    pruneStageReminderTimestamps(now);

    const title = stage === 'overdue'
        ? 'Reminder: task overdue'
        : stage === 'critical'
            ? 'Reminder: task due very soon'
            : 'Reminder: task due soon';

    const body = `${task.text} • ${status.countdownLabel}`;
    new Notification(title, { body, silent: false });
}

function pruneStageReminderTimestamps(now = Date.now()) {
    const maxAgeMs = 3 * 24 * 60 * 60 * 1000;
    for (const [key, timestamp] of stageReminderTimestamps.entries()) {
        if (now - timestamp > maxAgeMs) {
            stageReminderTimestamps.delete(key);
        }
    }
}

function updateOverdueCountBadge(overdueCount) {
    if (!overdueViewButton || !overdueCountBadge) {
        return;
    }

    overdueCountBadge.textContent = String(overdueCount);
    overdueCountBadge.classList.toggle('visible', overdueCount > 0);
    overdueViewButton.classList.toggle('has-overdue', overdueCount > 0);

    const ariaLabel = overdueCount > 0
        ? `Overdue notifications: ${overdueCount}`
        : 'Overdue';
    overdueViewButton.setAttribute('aria-label', ariaLabel);
}

function updateUrgencyAlert() {
    if (!urgencyAlert || !urgencyAlertText) {
        return;
    }

    const activeTasks = tasks.filter((task) => !task.completed);
    const rankedByUrgency = activeTasks
        .map((task) => ({ task, status: getDeadlineStatus(task.dueAt) }))
        .filter((entry) => entry.status.hasDeadline)
        .sort((entryA, entryB) => entryA.status.deadlineTimestamp - entryB.status.deadlineTimestamp);
    const overdueCount = rankedByUrgency.filter((entry) => entry.status.urgencyLevel === 'overdue').length;

    updateOverdueCountBadge(overdueCount);

    urgencyAlert.classList.remove('hidden', 'urgency-soon', 'urgency-critical', 'urgency-overdue');

    if (rankedByUrgency.length === 0) {
        urgencyAlert.classList.add('hidden');
        return;
    }

    const top = rankedByUrgency[0];
    if (top.status.urgencyLevel === 'normal') {
        urgencyAlert.classList.add('hidden');
        return;
    }

    urgencyAlert.classList.add(`urgency-${top.status.urgencyLevel}`);

    if (top.status.urgencyLevel === 'overdue') {
        urgencyAlertText.textContent = overdueCount === 1
            ? '1 overdue task.'
            : `${overdueCount} overdue tasks.`;
    } else if (top.status.urgencyLevel === 'critical') {
        urgencyAlertText.textContent = `Due very soon: ${top.task.text} (${top.status.countdownLabel}).`;
    } else {
        urgencyAlertText.textContent = `Due soon: ${top.task.text} (${top.status.countdownLabel}).`;
    }
}

function startRealtimeUpdates() {
    if (realtimeIntervalId) {
        clearInterval(realtimeIntervalId);
    }

    realtimeIntervalId = setInterval(() => {
        refreshDeadlineBadges();
        updateUrgencyAlert();

        const todayKey = getDateKey(new Date());
        if (todayKey !== lastActivityRenderDateKey) {
            renderActivityHeatmap();
        }

        const currentBucket = Math.floor(Date.now() / 30000);
        if (currentBucket === lastRealtimeBucket) {
            return;
        }

        lastRealtimeBucket = currentBucket;

        if (isAutoPrioritize) {
            applyOrdering();
            renderTasks();
            updateTaskSummary();
            updateUrgencyAlert();
            saveTasks();
            return;
        }

        if (activeView !== 'all') {
            renderTasks();
        }
    }, 1000);
}

// isValidDateValue, generateTaskId, and generateSubtaskId now live in
// task-shared.js.

function findTaskById(taskId) {
    return tasks.find((task) => task.id === taskId);
}

// playClickSound/playTaskCompleteSound and the audio elements behind them
// now live in task-shared.js, shared with the group app.
