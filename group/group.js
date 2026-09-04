// Group workspace - plain JS, same style as script.js (no build step, no
// framework). Task rendering below intentionally mirrors createTaskItem()/
// createSubtasksSection()/createSubtaskItem() in script.js: same classes,
// same icons, same DOM shape, so a group task looks and behaves like a solo
// task instead of a re-invention. MATRIX_CONFIG/DIFFICULTY_CONFIG/
// getDeadlineStatus/generateTaskId/generateSubtaskId come from task-shared.js,
// loaded before this file - not redefined here, so they can't drift from
// solo's copy.
//
// Not yet ported from solo (by design, see conversation with the user):
// the schedule field, quick-add NLP, snooze, drag-reorder, task views,
// edit-in-place, and the reward/reel celebration. Matrix, difficulty,
// deadline urgency, and subtasks (auto-complete with manual override) are
// ported and share the exact same logic as solo.

// ---------------------------------------------------------------------
// Firestore data layer
// ---------------------------------------------------------------------
//
// db(), fs(), displayNameFor/loadProfileName/saveProfileName, resolveMemberName,
// createGroup/joinGroup/leaveGroup/deleteGroupCompletely, and subscribeToMyGroups
// now live in groups-data.js, shared with group/browse.js - not redefined here.

function subscribeToGroupTasks(groupId, callback, onError) {
    const { collection, onSnapshot } = fs();
    const tasksRef = collection(db(), 'groups', groupId, 'tasks');
    return onSnapshot(tasksRef, (snapshot) => {
        callback(snapshot.docs.map((taskDoc) => ({ id: taskDoc.id, ...taskDoc.data() })));
    }, onError);
}

// ---------------------------------------------------------------------
// "Recently finished" history - a permanent log, separate from the live
// tasks collection, so a completion still shows here after the task
// itself gets deleted. See firestore.rules' groups/{groupId}/history for
// why this is its own top-level subcollection rather than nested under
// /tasks. Capped at 50 most recent (across the whole group, before any
// per-member scope filtering in renderGroupHistory) so this doesn't grow
// into an ever-larger download as a group racks up history over time.
// ---------------------------------------------------------------------

function subscribeToGroupHistory(groupId, callback, onError) {
    const { collection, query, orderBy, limit, onSnapshot } = fs();
    const historyRef = query(
        collection(db(), 'groups', groupId, 'history'),
        orderBy('completedAt', 'desc'),
        limit(50)
    );
    return onSnapshot(historyRef, (snapshot) => {
        callback(snapshot.docs.map((entryDoc) => ({ id: entryDoc.id, ...entryDoc.data() })));
    }, onError);
}

// Called once, right when a task transitions into completed (not on every
// update) - see the two call sites below. task.ownerId/ownerName are used
// as-is rather than looked up fresh, since only a task's own owner can
// ever complete it (enforced by firestore.rules), so they're already
// correct for whoever triggered this.
async function logGroupTaskCompletion(groupId, task, completedAt) {
    const { doc, setDoc } = fs();
    await setDoc(doc(db(), 'groups', groupId, 'history', generateTaskId()), {
        taskId: task.id,
        taskText: task.text,
        ownerId: task.ownerId,
        ownerName: task.ownerName || 'Teammate',
        completedAt
    });
}

// ---------------------------------------------------------------------
// Comments - a discussion thread per task. Only subscribed while a given
// task's comment section is expanded (see toggleGroupCommentsExpanded),
// not one big always-on listener per task in the list.
// ---------------------------------------------------------------------

function subscribeToTaskComments(groupId, taskId, callback, onError) {
    const { collection, onSnapshot } = fs();
    const commentsRef = collection(db(), 'groups', groupId, 'tasks', taskId, 'comments');
    return onSnapshot(commentsRef, (snapshot) => {
        callback(snapshot.docs.map((commentDoc) => ({ id: commentDoc.id, ...commentDoc.data() })));
    }, onError);
}

// Also bumps commentCount/lastCommentAt on the parent task itself (a small
// denormalized counter, allowed for any group member - not just the task's
// owner - by its own narrow rule) so the unread-comments indicator on the
// task list can read straight off the already-loaded task, instead of
// needing a live listener per task just to know if there's anything new.
async function addComment(groupId, taskId, user, text) {
    const trimmedText = text.trim();
    if (!trimmedText) {
        return;
    }
    const { doc, writeBatch, serverTimestamp, increment } = fs();
    const batch = writeBatch(db());
    batch.set(doc(db(), 'groups', groupId, 'tasks', taskId, 'comments', generateTaskId()), {
        authorId: user.uid,
        authorName: displayNameFor(user),
        text: trimmedText.slice(0, 500),
        createdAt: serverTimestamp()
    });
    batch.update(doc(db(), 'groups', groupId, 'tasks', taskId), {
        commentCount: increment(1),
        lastCommentAt: serverTimestamp()
    });
    await batch.commit();
    // You obviously just saw your own comment - don't flag it unread to yourself.
    setCommentsLastViewedAt(taskId, new Date().toISOString());
}

async function deleteComment(groupId, taskId, commentId) {
    const { doc, writeBatch, increment } = fs();
    const batch = writeBatch(db());
    batch.delete(doc(db(), 'groups', groupId, 'tasks', taskId, 'comments', commentId));
    batch.update(doc(db(), 'groups', groupId, 'tasks', taskId), { commentCount: increment(-1) });
    await batch.commit();
}

// ---------------------------------------------------------------------
// Suggestions - "suggest a task for them": proposes a brand new task for a
// specific teammate, who can accept (creates the real task, owned by them)
// or dismiss it. Not tied to any existing task.
// ---------------------------------------------------------------------

async function suggestTaskForMember(groupId, fromUser, forUserId, { text, matrix, difficulty, dueAt }) {
    const trimmedText = text.trim();
    if (!trimmedText) {
        return;
    }
    const { doc, setDoc, serverTimestamp } = fs();
    await setDoc(doc(db(), 'groups', groupId, 'suggestions', generateTaskId()), {
        fromUserId: fromUser.uid,
        fromUserName: displayNameFor(fromUser),
        forUserId,
        text: trimmedText.slice(0, 240),
        // Suggested starting priority - the assignee can still change all
        // of this after accepting, via the normal task editor. Deliberately
        // no suggested "schedule" or time estimate: those are the
        // assignee's own planning call, not something to set on their
        // behalf.
        matrix: getValidMatrixValue(matrix),
        difficulty: getValidDifficultyLevel(difficulty),
        dueAt: dueAt || null,
        status: 'pending',
        createdAt: serverTimestamp()
    });
}

// Every pending suggestion in the group, not just the current user's - the
// dashboard filters client-side (forUserId === you = "for you", otherwise
// "you suggested"), since a group this small doesn't need two queries.
function subscribeToGroupSuggestions(groupId, callback, onError) {
    const { collection, onSnapshot } = fs();
    const suggestionsRef = collection(db(), 'groups', groupId, 'suggestions');
    return onSnapshot(suggestionsRef, (snapshot) => {
        callback(snapshot.docs.map((suggestionDoc) => ({ id: suggestionDoc.id, ...suggestionDoc.data() })));
    }, onError);
}

async function acceptSuggestion(groupId, suggestion, user) {
    const { doc, updateDoc } = fs();
    await addGroupTask(groupId, user, {
        text: suggestion.text,
        matrix: suggestion.matrix,
        difficulty: suggestion.difficulty,
        dueAt: suggestion.dueAt
    });
    await updateDoc(doc(db(), 'groups', groupId, 'suggestions', suggestion.id), { status: 'accepted' });
}

async function dismissSuggestion(groupId, suggestionId) {
    const { doc, updateDoc } = fs();
    await updateDoc(doc(db(), 'groups', groupId, 'suggestions', suggestionId), { status: 'dismissed' });
}

async function retractSuggestion(groupId, suggestionId) {
    const { doc, deleteDoc } = fs();
    await deleteDoc(doc(db(), 'groups', groupId, 'suggestions', suggestionId));
}

async function addGroupTask(groupId, user, { text, matrix, difficulty, dueAt, recurrence, scheduledAt, taskType, estimateMinutes, subtasks }) {
    const trimmedText = text.trim();
    if (!trimmedText) {
        return;
    }

    const { doc, setDoc } = fs();
    const timestamp = new Date().toISOString();
    const validTaskType = getValidTaskType(taskType);
    // Optional - manual entry never passes this, so it defaults to [] same
    // as before; Brain Dump's commitAiTasksGroup is the only caller that
    // populates it (see brain-dump.js).
    const initialSubtasks = (Array.isArray(subtasks) ? subtasks : [])
        .map((subtaskText) => (subtaskText || '').trim())
        .filter(Boolean)
        .slice(0, 200)
        .map((subtaskText) => ({
            id: generateSubtaskId(),
            text: subtaskText.slice(0, 240),
            completed: false,
            createdAt: timestamp
        }));

    await setDoc(doc(db(), 'groups', groupId, 'tasks', generateTaskId()), {
        ownerId: user.uid,
        ownerName: displayNameFor(user),
        text: trimmedText,
        completed: false,
        matrix: getValidMatrixValue(matrix),
        difficulty: getValidDifficultyLevel(difficulty),
        dueAt: dueAt || null,
        recurrence: dueAt ? getValidRecurrenceValue(recurrence) : null,
        scheduledAt: scheduledAt || null,
        taskType: validTaskType,
        estimateMinutes: validTaskType === 'timeboxed' ? (estimateMinutes || null) : null,
        subtasks: initialSubtasks,
        createdAt: timestamp,
        updatedAt: timestamp
    });
}

// Given a task that just transitioned to completed, returns the extra
// field updates needed if it's recurring - advancing in place (same doc)
// rather than staying completed, same reasoning as solo's
// setTaskCompletedState. Returns null for a non-recurring task (or one
// with no valid next occurrence), meaning "no extra fields, stays
// completed normally." Shared by every completion write path below
// (direct checkbox, subtask-driven auto-complete, Dusty's task edits) so
// recurrence behaves identically no matter how a task got marked done.
function getRecurrenceAdvanceFields(task) {
    if (!task.recurrence) {
        return null;
    }
    const nextDueAt = getNextRecurrenceDueAt(task.dueAt, task.recurrence);
    if (!nextDueAt) {
        return null;
    }
    return {
        completed: false,
        completedAt: null,
        dueAt: nextDueAt,
        snoozeCount: 0,
        subtasks: (Array.isArray(task.subtasks) ? task.subtasks : []).map((subtask) => ({ ...subtask, completed: false }))
    };
}

async function setGroupTaskCompleted(groupId, task, completed) {
    const { doc, updateDoc } = fs();
    const update = {
        completed,
        completedAt: completed ? new Date().toISOString() : null,
        updatedAt: new Date().toISOString()
    };
    if (!task.completed && completed) {
        Object.assign(update, getRecurrenceAdvanceFields(task) || {});
    }
    await updateDoc(doc(db(), 'groups', groupId, 'tasks', task.id), update);
}

async function deleteGroupTask(groupId, taskId) {
    const { doc, deleteDoc } = fs();
    await deleteDoc(doc(db(), 'groups', groupId, 'tasks', taskId));
}

// Same auto-complete-with-manual-override behavior as the solo app: checking
// off the last subtask completes the task, unchecking one reopens it, and
// the task's own checkbox can still be toggled independently at any time.
// Shared by all three subtask mutators below: recomputes the parent task's
// own completed/completedAt from its subtasks (auto-complete with manual
// override, same as solo) - completedAt feeds the history panel.
function subtaskDrivenTaskUpdate(task, subtasks) {
    const completed = subtasks.length > 0 && subtasks.every((subtask) => subtask.completed);
    const justCompleted = !task.completed && completed;
    const update = {
        subtasks,
        completed,
        completedAt: completed ? new Date().toISOString() : null,
        updatedAt: new Date().toISOString()
    };
    // Captured BEFORE the recurrence override below can touch completedAt -
    // real bug caught by actually running this: grabbing it AFTER
    // Object.assign meant the history log would have recorded null instead
    // of the real completion time for every recurring task, since the
    // override sets completedAt back to null in the same object.
    const historyCompletedAt = update.completedAt;
    // Recurring: auto-completing via the last subtask advances the task
    // in place too, same as the direct checkbox path (setGroupTaskCompleted)
    // - checked against the FRESH subtasks array (post-toggle), not the
    // stale task.subtasks, so the reset-to-incomplete below is based on
    // the steps as they actually are right now. justCompleted is captured
    // BEFORE this override and returned separately - the completion credit
    // below still has to fire for a recurring task even though `completed`
    // itself gets flipped straight back to false in the same update.
    if (justCompleted) {
        Object.assign(update, getRecurrenceAdvanceFields({ ...task, subtasks }) || {});
    }
    return { ...update, justCompleted, historyCompletedAt };
}

// Writes the subtask-driven update, then logs a history entry if that
// update is what just auto-completed the task (checking the last subtask)
// - shared by all three subtask mutators below so "log on the completed
// transition" isn't repeated three times.
async function applySubtaskDrivenUpdate(groupId, task, subtasks) {
    const { justCompleted, historyCompletedAt, ...update } = subtaskDrivenTaskUpdate(task, subtasks);
    const { doc, updateDoc } = fs();
    await updateDoc(doc(db(), 'groups', groupId, 'tasks', task.id), update);

    // Real bug found while wiring in recurrence: a recurring task advanced
    // via this path flips `completed` straight back to false in the SAME
    // update, so checking update.completed here (the old code) would have
    // silently skipped the history log for every recurring task completed
    // this way - the occurrence still happened, it just doesn't stay
    // marked done. justCompleted (captured before that override) is the
    // real signal for "did this transition to completed just now".
    if (justCompleted) {
        logGroupTaskCompletion(groupId, task, historyCompletedAt).catch((error) => {
            console.error('Failed to log completion history:', error);
        });
    }
}

async function addGroupSubtask(groupId, task, text) {
    const trimmedText = text.trim();
    if (!trimmedText) {
        return;
    }

    const subtasks = [
        ...(task.subtasks || []),
        { id: generateSubtaskId(), text: trimmedText, completed: false, createdAt: new Date().toISOString(), dueAt: null }
    ];

    await applySubtaskDrivenUpdate(groupId, task, subtasks);
}

async function toggleGroupSubtask(groupId, task, subtaskId) {
    const subtasks = (task.subtasks || []).map((subtask) => (
        subtask.id === subtaskId ? { ...subtask, completed: !subtask.completed } : subtask
    ));

    await applySubtaskDrivenUpdate(groupId, task, subtasks);
}

async function deleteGroupSubtask(groupId, task, subtaskId) {
    const subtasks = (task.subtasks || []).filter((subtask) => subtask.id !== subtaskId);

    await applySubtaskDrivenUpdate(groupId, task, subtasks);
}

// A step's own deadline - reuses the same generic "write this subtasks
// array, recompute completion" pipeline every other subtask mutator does,
// even though this particular change can never itself flip completion.
async function setGroupSubtaskDueAt(groupId, task, subtaskId, dueAtIsoOrNull) {
    const subtasks = (task.subtasks || []).map((subtask) => (
        subtask.id === subtaskId ? { ...subtask, dueAt: dueAtIsoOrNull } : subtask
    ));

    await applySubtaskDrivenUpdate(groupId, task, subtasks);
}

// A step's own text (see createGroupSubtaskItem's click-to-rename handler)
// - same generic subtasks-array pipeline as every other mutator here.
// Empty/whitespace-only is rejected before ever reaching Firestore, same
// reasoning as addGroupSubtask's own guard.
async function renameGroupSubtask(groupId, task, subtaskId, newText) {
    const trimmedText = (newText || '').trim();
    if (!trimmedText) {
        return false;
    }

    const subtasks = (task.subtasks || []).map((subtask) => (
        subtask.id === subtaskId ? { ...subtask, text: trimmedText } : subtask
    ));

    await applySubtaskDrivenUpdate(groupId, task, subtasks);
    return true;
}

// ---------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------

const groupStatusMsg = document.querySelector('.groupStatusMsg');
const groupPageWrap = document.querySelector('.groupPageWrap');
const groupBrowseAllLink = document.querySelector('.groupBrowseAllLink');
const groupSetupSection = document.querySelector('.groupSetupSection');
const groupCreateForm = document.querySelector('.groupCreateForm');
const groupCreateNameInput = document.querySelector('.groupCreateNameInput');
const groupCreatePrivacySelect = document.querySelector('.groupCreatePrivacySelect');
const groupCreateError = document.querySelector('.groupCreateError');
const groupJoinForm = document.querySelector('.groupJoinForm');
const groupJoinCodeInput = document.querySelector('.groupJoinCodeInput');
const groupJoinError = document.querySelector('.groupJoinError');
const groupJoinInfo = document.querySelector('.groupJoinInfo');
const groupDashboard = document.querySelector('.groupDashboard');
const groupViewTabButtons = Array.from(document.querySelectorAll('.viewTab'));
const groupViewPanels = Array.from(document.querySelectorAll('.viewPanel'));

// Navigation (section A of the UI/UX rework): Tasks vs. Team, same pattern as
// solo's switchSoloView. GROUP_TOUR_STEPS' beforeShow hooks call this to
// self-correct onto the right view regardless of step order or a manual tab
// click mid-tour.
function switchGroupView(view) {
    groupViewTabButtons.forEach((button) => {
        const isActive = button.dataset.view === view;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    groupViewPanels.forEach((panel) => {
        panel.classList.toggle('hidden', panel.dataset.viewPanel !== view);
    });

    // Activity used to be a modal, marked "viewed" on open (openGroupHistoryModal,
    // now removed) - it's a plain tab now, so switching to it is the
    // equivalent moment to mark the group's history as seen and clear the
    // unread dot immediately, rather than waiting on the next renderApp().
    if (view === 'activity') {
        const group = getSelectedGroup();
        if (group) {
            setHistoryLastViewedAt(group.id, new Date().toISOString());
            groupHistoryUnreadDot?.classList.add('hidden');
        }
    }
}

groupViewTabButtons.forEach((button) => {
    button.addEventListener('click', () => {
        playClickSound();
        switchGroupView(button.dataset.view || 'tasks');
    });
});
const groupInviteCode = document.querySelector('.groupInviteCode');
const groupCopyInviteBtn = document.querySelector('.groupCopyInviteBtn');
const groupRenameBtn = document.querySelector('.groupRenameBtn');
const groupSettingsBtn = document.querySelector('.groupSettingsBtn');
const groupSettingsCountBadge = groupSettingsBtn?.querySelector('.groupSettingsCountBadge');
const groupLeaveBtn = document.querySelector('.groupLeaveBtn');
const groupDeleteBtn = document.querySelector('.groupDeleteBtn');
// Built (and groupLeaveBtn/groupDeleteBtn reparented into it) right away,
// not lazily on first "Group settings" click - both buttons can go from
// hidden to visible as soon as a group loads (see the isOwner-driven
// classList calls in renderApp()), which can happen well before the user
// ever opens Settings, so the move has to be done before that, not after.
// initializeGroupSettingsModal (defined further down) is function-hoisted,
// so calling it here is safe - BUT it reads/writes groupSettingsOverlay and
// groupSettingsGroupId, which are let (not function-hoisted the same way:
// a let is only accessible after its own declaration line actually runs,
// throwing a ReferenceError if read/written any earlier - the "temporal
// dead zone"). Both need to be declared here, ahead of this call, not down
// near the rest of the group-settings-modal code where they used to sit -
// that gap is exactly what broke every group.js top-level statement after
// this point (a thrown, uncaught ReferenceError halts the whole script)
// the first time this eager-init fix shipped.
let groupSettingsOverlay = null;
let groupSettingsGroupId = null;
initializeGroupSettingsModal();
const memberRoster = document.querySelector('.memberRoster');
const leaderboardList = document.querySelector('.leaderboardList');
const leaderboardTabBtns = Array.from(document.querySelectorAll('.leaderboardTabBtn'));
const leaderboardTabsEl = document.querySelector('.leaderboardTabs');
const leaderboardTeaser = document.querySelector('.leaderboardTeaser');
const memberRosterInviteHint = document.querySelector('.memberRosterInviteHint');
const leaderboardMemberOverlay = document.querySelector('.leaderboardMemberOverlay');
const leaderboardMemberModalTitle = document.querySelector('.leaderboardMemberModalTitle');
const leaderboardMemberCloseBtn = document.querySelector('.leaderboardMemberCloseBtn');
const leaderboardMemberList = document.querySelector('.leaderboardMemberList');
const groupHistoryList = document.querySelector('.groupHistoryList');
// Activity is now its own always-visible tab (see the viewTabs restructure),
// not a modal opened from a trigger button - the unread dot lives on the
// tab itself now (still .historyUnreadDot, just relocated in index.html).
const groupHistoryUnreadDot = document.querySelector('.historyUnreadDot');
const suggestionsForYouPanel = document.querySelector('.suggestionsForYouPanel');
const brainDumpToggleBtn = document.querySelector('.brainDumpToggleBtn');
const groupAlertToggleBtn = document.querySelector('.groupAlertToggleBtn');
const helpTourBtn = document.querySelector('.helpTourBtn');
const navAttentionBadge = document.querySelector('.navAttentionBadge');
const navAttentionCount = document.querySelector('.navAttentionCount');
const groupOnboardingHint = document.querySelector('.groupOnboardingHint');
const groupOnboardingStartTourBtn = document.querySelector('.groupOnboardingStartTourBtn');
const groupOnboardingDismissBtn = document.querySelector('.groupOnboardingDismissBtn');
const groupWelcomeOverlay = document.querySelector('.groupWelcomeOverlay');
const groupWelcomeNameInput = document.querySelector('.groupWelcomeNameInput');
const groupWelcomeContinueBtn = document.querySelector('.groupWelcomeContinueBtn');
const groupUrgencyAlert = document.querySelector('.urgencyAlert');
const groupUrgencyAlertText = document.querySelector('.urgencyAlertText');
const overdueViewButton = document.querySelector('.taskViewBtn[data-view="overdue"]');
const overdueCountBadge = document.querySelector('.overdueCountBadge');
const taskInput = document.querySelector('.taskInput');
const detailsToggleBtn = document.querySelector('.detailsToggleBtn');
const addBtn = document.querySelector('.addBtn');
const taskDetailsPanel = document.querySelector('.taskDetailsPanel');
const detailsMoreToggleBtn = document.querySelector('.detailsMoreToggleBtn');
const detailsMoreOptions = document.querySelector('.detailsMoreOptions');
const matrixSelect = document.querySelector('.matrixSelect');
const difficultySelect = document.querySelector('.difficultySelect');
const deadlineContainer = document.querySelector('.deadlineContainer:not(.scheduleContainer)');
const deadlineInput = document.querySelector('.deadlineInput:not(.scheduleInput)');
const recurrenceSelect = document.querySelector('.recurrenceSelect');
const scheduleContainer = document.querySelector('.scheduleContainer');
const scheduleInput = document.querySelector('.scheduleInput');
const typePills = Array.from(document.querySelectorAll('.typePill'));
const durationInput = document.querySelector('.durationInput');
const durationWrap = document.querySelector('.durationWrap');
const durationChips = Array.from(document.querySelectorAll('.durationChip'));
const groupTasksList = document.querySelector('.groupTasksList');
const taskViewBtns = document.querySelectorAll('.taskViewBtn');
const deadlineViewTabs = document.querySelector('.deadlineViewTabs');
const groupMemberScopeTabs = document.querySelector('.groupMemberScopeTabs');
const whoseTasksLabel = document.querySelector('.whoseTasksLabel');
const yourNameInput = document.querySelector('.yourNameInput');
const yourNameSaveBtn = document.querySelector('.yourNameSaveBtn');
const yourNameSavedMsg = document.querySelector('.yourNameSavedMsg');
const pageTitleEl = document.querySelector('h1.title');
const motivatorText = document.querySelector('.motivatorText');
const progressBar = document.querySelector('.progressBar');
const taskAmountText = document.querySelector('.taskAmount');

// Reward/celebration reel - personal to whoever is signed in, not shared
// with the rest of the group (see checkGroupMilestone below). Same overlay
// markup/CSS as solo's (.rewardOverlay etc.), same reel mechanics from
// task-shared.js (REWARD_SUGGESTIONS, createRewardTile, reel geometry).
const rewardOverlay = document.querySelector('.rewardOverlay');
const rewardCard = document.querySelector('.rewardCard');
const confettiField = document.querySelector('.confettiField');
const rewardTitle = document.querySelector('.rewardTitle');
const rewardReelViewport = document.querySelector('.rewardReelViewport');
const rewardReelTrack = document.querySelector('.rewardReelTrack');
const rewardSuggestionText = document.querySelector('.rewardSuggestionText');
const rewardCloseBtn = document.querySelector('.rewardCloseBtn');

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------

const SELECTED_GROUP_KEY = 'todolist-selected-group';

let currentUser = null;
let groups = undefined; // undefined = loading, [] = none yet
let selectedGroupId = null;
let groupTasks = [];
let groupSuggestions = [];
let groupHistoryEntries = [];
let groupHistoryLoadError = null; // set on a failed history load (e.g. rules not published yet) - see watchSelectedGroupTasks
// Pending join requests for the selected group - only ever populated while
// you're owner/admin there (see ensureJoinRequestsSubscription; a plain
// member can't read this collection at all per firestore.rules).
let groupJoinRequests = [];
// Which groupId (if any) groupJoinRequests is currently subscribed for -
// lets ensureJoinRequestsSubscription, called every renderApp(), no-op
// cheaply instead of re-subscribing on every unrelated re-render.
let joinRequestsSubscriptionKey = null;
let showSetup = new URLSearchParams(window.location.search).get('new') === '1';
let expandedSubtaskTaskIds = new Set();
let expandedSnoozeTaskIds = new Set();
let expandedCommentTaskIds = new Set();
let taskCommentsById = {}; // taskId -> comments array, filled in lazily
let taskCommentsErrorById = {}; // taskId -> error message, so a failed load/post is visible, not silent
const commentUnsubscribes = {}; // taskId -> unsubscribe fn, only while expanded
let activeView = 'all';
// 'all' = everyone's tasks together; a uid = just that one person's.
let activeMemberScope = 'all';
// Leaderboard range: 'week' (calendar week, from the history log), 'month'
// (calendar month, from currently-completed tasks), or 'all' (all-time,
// also from currently-completed tasks) - see renderGroupLeaderboard.
let leaderboardRange = 'week';
// Last calendar day the leaderboard/history were computed for - lets
// startGroupRealtimeUpdates notice a week/month boundary passing (or just
// a completion aging out of "today") and re-render on its own, even with
// nobody completing a task to otherwise trigger it.
let lastGroupRealtimeDayKey = null;

let unsubscribeGroups = null;
let unsubscribeTasks = null;
let unsubscribeSuggestions = null;
let unsubscribeHistory = null;
let unsubscribeJoinRequests = null;
let groupRealtimeIntervalId = null;

// Desktop popup alerts for your own urgent/overdue tasks in the currently
// selected group - a port of solo's system (script.js's popupAlertsEnabled/
// maybeNotifyTaskUrgency), scoped to YOUR tasks only (not the whole team's -
// that would mean a notification storm in any group with more than one
// active person) and to whichever group is currently selected, since that's
// the only group this page keeps live task data for.
const GROUP_SETTINGS_KEY = 'todoGroupSettingsV1';
const GROUP_REMINDER_COOLDOWN_MS = {
    soon: 45 * 60 * 1000,
    critical: 20 * 60 * 1000,
    overdue: 30 * 60 * 1000
};
const GROUP_GLOBAL_REMINDER_GAP_MS = 8 * 60 * 1000;
const groupStageReminderTimestamps = new Map();
let groupLastGlobalReminderAt = 0;
let groupPopupAlertsEnabled = false;

// A link from the "all my groups" browse page (?g=<id>) always wins over
// whatever was last selected here.
const deepLinkGroupId = new URLSearchParams(window.location.search).get('g');

try {
    selectedGroupId = deepLinkGroupId || localStorage.getItem(SELECTED_GROUP_KEY);
} catch {
    // localStorage can be unavailable (private browsing, quota) - the
    // switcher just won't remember the choice across reloads.
}

function clearExpandedCommentSubscriptions() {
    Object.values(commentUnsubscribes).forEach((unsubscribe) => unsubscribe());
    Object.keys(commentUnsubscribes).forEach((key) => delete commentUnsubscribes[key]);
    expandedCommentTaskIds = new Set();
    taskCommentsById = {};
}

function selectGroup(groupId) {
    selectedGroupId = groupId;
    showSetup = false;
    activeMemberScope = 'all';
    clearExpandedCommentSubscriptions();
    closeGroupSettingsModal();
    try {
        localStorage.setItem(SELECTED_GROUP_KEY, groupId);
    } catch {
        // Same as above - non-fatal.
    }
    renderApp();
    watchSelectedGroupTasks();
}

function getSelectedGroup() {
    if (!groups || groups.length === 0) {
        return null;
    }
    return groups.find((group) => group.id === selectedGroupId) || groups[0];
}

// ---------------------------------------------------------------------
// Task rendering - mirrors createTaskItem()/createSubtasksSection()/
// createSubtaskItem() in script.js as closely as this feature set allows.
// ---------------------------------------------------------------------

function createGroupTaskItem(groupId, task, isOwner) {
    const taskItem = document.createElement('li');
    taskItem.dataset.taskId = task.id;

    if (task.completed) {
        taskItem.classList.add('completed');
    }

    const taskMain = document.createElement('div');
    taskMain.classList.add('taskMain');

    const checkBtn = document.createElement('button');
    checkBtn.type = 'button';
    checkBtn.classList.add('checkBtn');
    checkBtn.innerHTML = '<i class="fa-solid fa-check"></i>';
    checkBtn.setAttribute('aria-label', task.completed ? 'Mark as incomplete' : 'Mark as complete');
    checkBtn.title = task.completed ? 'Mark as incomplete' : 'Mark as complete';
    if (!isOwner) {
        checkBtn.disabled = true;
        checkBtn.title = `Only ${task.ownerName || 'the owner'} can update this task`;
    }

    const taskContent = document.createElement('div');
    taskContent.classList.add('taskContent');

    const taskTextSpan = document.createElement('span');
    taskTextSpan.classList.add('taskText');
    taskTextSpan.textContent = task.text;

    const taskMeta = document.createElement('div');
    taskMeta.classList.add('taskMeta');

    if (!isOwner) {
        const ownerBadge = document.createElement('span');
        ownerBadge.classList.add('ownerBadge');
        ownerBadge.textContent = task.ownerName || 'Teammate';
        taskMeta.appendChild(ownerBadge);
    }

    // Deadline/countdown go first when a deadline exists (Serial Position
    // Effect, section D): the most decision-relevant badge gets the primacy
    // slot instead of being buried after matrix/difficulty/effort.
    // .deadlineBadge stays on the task's own literal due date; the
    // countdown badge and the row's status-* class use urgency, which also
    // factors in an incomplete step's own nearer deadline (see
    // getTaskUrgencyStatus in task-shared.js).
    const deadlineStatus = getTaskDisplayDeadlineStatus(task);
    const urgencyStatus = getTaskUrgencyStatus(task);
    taskItem.classList.add(`status-${urgencyStatus.urgencyLevel}`);

    const deadlineBadge = document.createElement('span');
    deadlineBadge.classList.add('deadlineBadge', deadlineStatus.deadlineClassName);
    deadlineBadge.textContent = deadlineStatus.deadlineLabel;

    const countdownBadge = document.createElement('span');
    countdownBadge.classList.add('countdownBadge', urgencyStatus.countdownClassName);
    countdownBadge.textContent = urgencyStatus.countdownLabel;

    if (deadlineStatus.hasDeadline) {
        taskMeta.appendChild(deadlineBadge);
        taskMeta.appendChild(countdownBadge);
    }

    if (task.recurrence) {
        const recurrenceBadge = document.createElement('span');
        recurrenceBadge.classList.add('recurrenceBadge');
        recurrenceBadge.innerHTML = `<i class="fa-solid fa-repeat"></i> ${getRecurrenceLabel(task.recurrence)}`;
        taskMeta.appendChild(recurrenceBadge);
    }

    const matrixValue = getValidMatrixValue(task.matrix);
    const matrixData = MATRIX_CONFIG[matrixValue];
    const matrixBadge = document.createElement('span');
    matrixBadge.classList.add('matrixBadge', matrixData.className);
    matrixBadge.textContent = matrixData.label;
    taskMeta.appendChild(matrixBadge);

    const difficultyLevel = getValidDifficultyLevel(task.difficulty);
    const difficultyBadge = document.createElement('span');
    difficultyBadge.classList.add('difficultyBadge', `difficulty-${difficultyLevel}`);
    difficultyBadge.textContent = getDifficultyLabel(difficultyLevel);
    taskMeta.appendChild(difficultyBadge);

    if (task.scheduledAt && !task.completed) {
        const scheduleBadge = document.createElement('span');
        scheduleBadge.classList.add('scheduleBadge');
        scheduleBadge.innerHTML = `<i class="fa-solid fa-clock"></i> ${getScheduleLabel(task.scheduledAt)}`;
        taskMeta.appendChild(scheduleBadge);
    }

    const effortLabel = getEffortLabel(task);
    if (effortLabel !== 'No estimate') {
        const effortBadge = document.createElement('span');
        effortBadge.classList.add('effortBadge');
        effortBadge.textContent = effortLabel;
        taskMeta.appendChild(effortBadge);
    }

    const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];
    const subtaskDoneCount = subtasks.filter((subtask) => subtask.completed).length;
    if (subtasks.length > 0) {
        const subtaskProgressBadge = document.createElement('span');
        subtaskProgressBadge.classList.add('subtaskProgressBadge');
        subtaskProgressBadge.textContent = `${subtaskDoneCount}/${subtasks.length} steps`;
        taskMeta.appendChild(subtaskProgressBadge);
    }

    if (!deadlineStatus.hasDeadline) {
        taskMeta.appendChild(deadlineBadge);
        taskMeta.appendChild(countdownBadge);
    }

    taskContent.appendChild(taskTextSpan);
    taskContent.appendChild(taskMeta);

    taskMain.appendChild(checkBtn);
    taskMain.appendChild(taskContent);

    const taskButtons = document.createElement('div');
    taskButtons.classList.add('taskButtons');

    const canSnooze = isOwner && Boolean(task.dueAt) && !task.completed;

    if (isOwner) {
        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.classList.add('editBtn');
        editBtn.innerHTML = '<i class="fa-solid fa-pen"></i><span class="taskBtnLabel">Edit</span>';
        editBtn.setAttribute('aria-label', 'Edit task');
        editBtn.title = 'Edit task';
        editBtn.addEventListener('click', () => {
            playClickSound();
            openGroupTaskEditor(groupId, task);
        });
        taskButtons.appendChild(editBtn);

        if (canSnooze) {
            const snoozeBtn = document.createElement('button');
            snoozeBtn.type = 'button';
            snoozeBtn.classList.add('snoozeBtn');
            snoozeBtn.innerHTML = '<i class="fa-solid fa-clock"></i><span class="taskBtnLabel">Snooze</span>';
            snoozeBtn.setAttribute('aria-label', 'Snooze / reschedule deadline');
            snoozeBtn.title = 'Snooze / reschedule deadline';
            snoozeBtn.addEventListener('click', () => {
                playClickSound();
                toggleGroupSnoozeExpanded(task.id);
            });
            taskButtons.appendChild(snoozeBtn);
        }

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.classList.add('deleteBtn');
        deleteBtn.innerHTML = '<i class="fa-solid fa-trash"></i><span class="taskBtnLabel">Delete</span>';
        deleteBtn.setAttribute('aria-label', 'Delete task');
        deleteBtn.title = 'Delete task';
        deleteBtn.addEventListener('click', () => {
            playClickSound();
            deleteGroupTask(groupId, task.id).catch((error) => console.error('Failed to delete task:', error));
        });
        taskButtons.appendChild(deleteBtn);
    }

    const taskTopRow = document.createElement('div');
    taskTopRow.classList.add('taskTopRow');
    taskTopRow.appendChild(taskMain);
    taskTopRow.appendChild(taskButtons);

    taskItem.appendChild(taskTopRow);
    if (canSnooze) {
        taskItem.appendChild(createGroupSnoozeSection(groupId, task));
    }
    taskItem.appendChild(createGroupSubtasksSection(groupId, task, subtasks, isOwner));
    taskItem.appendChild(createGroupCommentsSection(groupId, task));

    checkBtn.addEventListener('click', () => {
        if (!isOwner) {
            return;
        }
        playClickSound();
        const willBeCompleted = !task.completed;
        const completedAt = new Date().toISOString();
        setGroupTaskCompleted(groupId, task, willBeCompleted).catch((error) => {
            console.error('Failed to update task:', error);
        });
        if (willBeCompleted) {
            playTaskCompleteSound();
            checkGroupMilestone(groupId, task.id);
            logGroupTaskCompletion(groupId, task, completedAt).catch((error) => {
                console.error('Failed to log completion history:', error);
            });
        }
    });

    return taskItem;
}

// Same quick-reschedule presets as solo's snooze section - reuses the same
// .deadlinePresetBtn/.snoozeOptionBtn classes and computePresetDate presets
// from task-shared.js.
function createGroupSnoozeSection(groupId, task) {
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
            applyGroupSnoozeToTask(groupId, task.id, preset);
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
        openGroupTaskEditor(groupId, task);
    });
    section.appendChild(pickDateBtn);

    return section;
}

function toggleGroupSnoozeExpanded(taskId) {
    if (expandedSnoozeTaskIds.has(taskId)) {
        expandedSnoozeTaskIds.delete(taskId);
    } else {
        expandedSnoozeTaskIds.add(taskId);
    }
    renderGroupTasks();
}

function applyGroupSnoozeToTask(groupId, taskId, preset) {
    const presetDate = computePresetDate(preset);
    if (!presetDate) {
        return;
    }

    expandedSnoozeTaskIds.delete(taskId);

    // snoozeCount: same reasoning as solo's applySnoozeToTask - Dusty's
    // planning signals use this to flag a task that keeps getting pushed
    // rather than done, not shown anywhere in the group UI itself.
    // increment() is atomic (no read needed first), same pattern already
    // used for commentCount above.
    const { doc, updateDoc, increment } = fs();
    updateDoc(doc(db(), 'groups', groupId, 'tasks', taskId), {
        dueAt: presetDate.toISOString(),
        updatedAt: new Date().toISOString(),
        snoozeCount: increment(1)
    }).catch((error) => console.error('Failed to snooze task:', error));
}

// ---------------------------------------------------------------------
// Reward / celebration reel - personal only. Triggered directly from your
// own checkbox click (see createGroupTaskItem), never from the live
// listener picking up a teammate's completion, so it can only ever fire
// for tasks you completed yourself.
// ---------------------------------------------------------------------

let groupSessionCompletionCount = 0;
let rewardSpinToken = 0;
let stopRewardReelTicking = null;

// justCompletedTaskId is passed explicitly rather than relying on groupTasks
// already reflecting the completion - the live listener's snapshot for this
// change hasn't come back yet at the moment this runs, so the task being
// completed right now would otherwise still read as incomplete.
function checkGroupMilestone(groupId, justCompletedTaskId) {
    groupSessionCompletionCount += 1;

    const isDueToday = (task) => {
        if (!isValidDateValue(task.dueAt)) {
            return false;
        }
        const dueDate = new Date(task.dueAt);
        const today = new Date();
        return dueDate.getFullYear() === today.getFullYear()
            && dueDate.getMonth() === today.getMonth()
            && dueDate.getDate() === today.getDate();
    };

    const myTasksHere = groupTasks.filter((task) => task.ownerId === currentUser?.uid);
    const dueTodayTasks = myTasksHere.filter(isDueToday);
    const stillIncomplete = dueTodayTasks.filter((task) => !task.completed && task.id !== justCompletedTaskId);

    const celebratedKey = `todoGroupCelebratedDailyClearDate:${groupId}`;
    const todayKey = getDateKey(new Date());
    const alreadyCelebratedToday = localStorage.getItem(celebratedKey) === todayKey;
    const dailyClearReady = dueTodayTasks.length > 0 && stillIncomplete.length === 0 && !alreadyCelebratedToday;

    if (dailyClearReady) {
        try {
            localStorage.setItem(celebratedKey, todayKey);
        } catch {
            // Non-fatal - just means it might celebrate again later today.
        }
        triggerGroupRewardCelebration('Today’s tasks in this group are all done');
        return;
    }

    if (groupSessionCompletionCount % 5 === 0) {
        triggerGroupRewardCelebration(`${groupSessionCompletionCount} tasks completed this session`);
    }
}

function triggerGroupRewardCelebration(titleText) {
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

    spinGroupRewardReel(winningReward, currentSpinToken);
}

function spinGroupRewardReel(winningReward, spinToken) {
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
    // transition is applied below - otherwise the browser can coalesce both
    // style changes into one and skip the animation entirely.
    void rewardReelTrack.offsetWidth;

    const viewportWidth = rewardReelViewport.clientWidth;
    const jitter = (Math.random() * 30) - 15;
    const targetOffset = (REEL_LANDING_INDEX * REEL_TILE_STEP) + (REEL_TILE_WIDTH / 2) - (viewportWidth / 2) + jitter;

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

function revealRewardResult() {
    rewardCard?.classList.add('revealed');
}

function closeGroupRewardCelebration() {
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

if (rewardCloseBtn) {
    rewardCloseBtn.addEventListener('click', () => {
        playClickSound();
        closeGroupRewardCelebration();
    });
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

// ---------------------------------------------------------------------
// Comments - unlike subtasks, any group member can post here (not just
// the task's owner), since the whole point is teammates weighing in on
// each other's tasks.
// ---------------------------------------------------------------------

const COMMENTS_LAST_VIEWED_KEY = 'todolist-comments-last-viewed';

function getCommentsLastViewedAt(taskId) {
    try {
        const stored = JSON.parse(localStorage.getItem(COMMENTS_LAST_VIEWED_KEY) || '{}');
        return stored[taskId] || null;
    } catch {
        return null;
    }
}

function setCommentsLastViewedAt(taskId, isoString) {
    try {
        const stored = JSON.parse(localStorage.getItem(COMMENTS_LAST_VIEWED_KEY) || '{}');
        stored[taskId] = isoString;
        localStorage.setItem(COMMENTS_LAST_VIEWED_KEY, JSON.stringify(stored));
    } catch {
        // localStorage can be unavailable - the indicator just won't
        // remember what you've already seen across reloads.
    }
}

function hasUnreadComments(task) {
    if (!task.lastCommentAt?.seconds) {
        return false;
    }
    const lastViewed = getCommentsLastViewedAt(task.id);
    if (!lastViewed) {
        return true;
    }
    return (task.lastCommentAt.seconds * 1000) > new Date(lastViewed).getTime();
}

// Comments created before commentCount existed never bumped it, so a task
// with old comments can show a stored count lower than its real one. Once
// the real list has actually been loaded, quietly correct the stored field
// to match - any group member is allowed to (see the task update rule),
// and it means this only ever needs fixing once per task.
function healCommentCountIfStale(groupId, task, actualCount) {
    const storedCount = task.commentCount || 0;
    if (storedCount === actualCount) {
        return;
    }
    const { doc, updateDoc } = fs();
    updateDoc(doc(db(), 'groups', groupId, 'tasks', task.id), { commentCount: actualCount })
        .catch((error) => console.error('Failed to correct comment count:', error));
}

function toggleGroupCommentsExpanded(groupId, task) {
    if (expandedCommentTaskIds.has(task.id)) {
        expandedCommentTaskIds.delete(task.id);
    } else {
        expandedCommentTaskIds.add(task.id);
        setCommentsLastViewedAt(task.id, new Date().toISOString());
        if (!commentUnsubscribes[task.id]) {
            commentUnsubscribes[task.id] = subscribeToTaskComments(groupId, task.id, (comments) => {
                taskCommentsById[task.id] = comments;
                taskCommentsErrorById[task.id] = null;
                healCommentCountIfStale(groupId, task, comments.length);
                renderGroupTasks();
            }, (error) => {
                console.error('Failed to load comments:', error);
                taskCommentsErrorById[task.id] = error?.code === 'permission-denied'
                    ? 'Comments aren\'t turned on for this project yet (the security rules need to be published).'
                    : 'Could not load comments.';
                renderGroupTasks();
            });
        }
    }
    renderGroupTasks();
}

function createGroupCommentsSection(groupId, task) {
    const section = document.createElement('div');
    section.classList.add('commentsSection');

    const expanded = expandedCommentTaskIds.has(task.id);
    const comments = taskCommentsById[task.id] || [];

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.classList.add('commentsToggleBtn');
    toggleBtn.setAttribute('aria-expanded', String(expanded));

    const chevron = document.createElement('i');
    chevron.classList.add('fa-solid', expanded ? 'fa-chevron-down' : 'fa-chevron-right');
    toggleBtn.appendChild(chevron);

    // The count badge uses the denormalized commentCount off the task
    // itself (always available, even before expanding) rather than
    // comments.length (only populated once loaded).
    // Once actually loaded, the real list is the ground truth (comments
    // created before commentCount existed never bumped it, so the stored
    // number can undercount) - only fall back to the stored estimate while
    // still collapsed and nothing's been fetched yet.
    const knownCount = taskCommentsById[task.id] ? comments.length : (task.commentCount || 0);
    const toggleLabel = document.createElement('span');
    toggleLabel.classList.add('commentsToggleLabel');
    toggleLabel.innerHTML = '<i class="fa-regular fa-comment"></i> ' + (
        knownCount === 0 ? 'Comments' : `${knownCount} comment${knownCount === 1 ? '' : 's'}`
    );
    toggleBtn.appendChild(toggleLabel);

    if (!expanded && hasUnreadComments(task)) {
        const unreadDot = document.createElement('span');
        unreadDot.classList.add('commentsUnreadDot');
        unreadDot.setAttribute('aria-label', 'Unread comments');
        toggleBtn.appendChild(unreadDot);
    }

    toggleBtn.addEventListener('click', () => {
        playClickSound();
        toggleGroupCommentsExpanded(groupId, task);
    });
    section.appendChild(toggleBtn);

    const body = document.createElement('div');
    body.classList.add('commentsBody');
    if (!expanded) {
        body.classList.add('hidden');
    }

    if (expanded) {
        const loadError = taskCommentsErrorById[task.id];
        if (loadError) {
            const errorMsg = document.createElement('p');
            errorMsg.classList.add('commentsEmpty', 'commentsError');
            errorMsg.textContent = loadError;
            body.appendChild(errorMsg);
        } else if (comments.length === 0) {
            const empty = document.createElement('p');
            empty.classList.add('commentsEmpty');
            empty.textContent = 'No comments yet - say something helpful.';
            body.appendChild(empty);
        } else {
            const list = document.createElement('div');
            list.classList.add('commentsList');
            list.setAttribute('role', 'list');
            [...comments]
                .sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0))
                .forEach((comment) => list.appendChild(createGroupCommentItem(groupId, task, comment)));
            body.appendChild(list);
        }

        body.appendChild(createGroupCommentAddRow(groupId, task));
    }

    section.appendChild(body);
    return section;
}

function createGroupCommentItem(groupId, task, comment) {
    const item = document.createElement('div');
    item.classList.add('commentItem');
    item.setAttribute('role', 'listitem');

    const meta = document.createElement('p');
    meta.classList.add('commentItemMeta');
    const authorLabel = comment.authorId === currentUser?.uid ? 'You' : (comment.authorName || 'Teammate');
    const timeLabel = comment.createdAt?.seconds
        ? formatFriendlyDateTime(new Date(comment.createdAt.seconds * 1000))
        : 'just now';
    meta.textContent = `${authorLabel} - ${timeLabel}`;
    item.appendChild(meta);

    const text = document.createElement('p');
    text.classList.add('commentItemText');
    text.textContent = comment.text;
    item.appendChild(text);

    if (comment.authorId === currentUser?.uid) {
        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.classList.add('commentDeleteBtn');
        deleteBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        deleteBtn.setAttribute('aria-label', 'Delete comment');
        deleteBtn.addEventListener('click', () => {
            playClickSound();
            deleteComment(groupId, task.id, comment.id).catch((error) => console.error('Failed to delete comment:', error));
        });
        item.appendChild(deleteBtn);
    }

    return item;
}

function createGroupCommentAddRow(groupId, task) {
    const addRow = document.createElement('div');
    addRow.classList.add('commentAddRow');

    const addInput = document.createElement('input');
    addInput.type = 'text';
    addInput.classList.add('commentInput');
    addInput.placeholder = 'Add a comment...';
    addInput.setAttribute('aria-label', 'Add a comment');
    addInput.maxLength = 500;
    addInput.addEventListener('mousedown', (event) => event.stopPropagation());

    const addBtnEl = document.createElement('button');
    addBtnEl.type = 'button';
    addBtnEl.classList.add('commentAddBtn');
    addBtnEl.setAttribute('aria-label', 'Post comment');
    addBtnEl.innerHTML = '<i class="fa-solid fa-paper-plane"></i>';

    const submitComment = () => {
        if (addInput.value.trim() === '' || !currentUser) {
            return;
        }
        playClickSound();
        const textToPost = addInput.value;
        addInput.value = '';
        addComment(groupId, task.id, currentUser, textToPost).catch((error) => {
            console.error('Failed to post comment:', error);
            alert(error?.code === 'permission-denied'
                ? 'Comments aren\'t turned on for this project yet (the security rules need to be published).'
                : 'Could not post that comment.');
            addInput.value = textToPost;
        });
    };

    addBtnEl.addEventListener('click', submitComment);
    addInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            submitComment();
        }
    });

    addRow.appendChild(addInput);
    addRow.appendChild(addBtnEl);
    return addRow;
}

function createGroupSubtasksSection(groupId, task, subtasks, isOwner) {
    const section = document.createElement('div');
    section.classList.add('subtasksSection');

    const expanded = expandedSubtaskTaskIds.has(task.id);

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.classList.add('subtasksToggleBtn');
    toggleBtn.setAttribute('aria-expanded', String(expanded));

    const chevron = document.createElement('i');
    chevron.classList.add('fa-solid', expanded ? 'fa-chevron-down' : 'fa-chevron-right');
    toggleBtn.appendChild(chevron);

    const toggleLabel = document.createElement('span');
    toggleLabel.classList.add('subtasksToggleLabel');
    const doneCount = subtasks.filter((subtask) => subtask.completed).length;
    if (subtasks.length > 0) {
        toggleLabel.textContent = `${doneCount}/${subtasks.length} steps`;
    } else {
        toggleLabel.textContent = isOwner ? 'Add steps' : 'No steps yet';
    }
    toggleBtn.appendChild(toggleLabel);

    toggleBtn.addEventListener('click', () => {
        playClickSound();
        if (expandedSubtaskTaskIds.has(task.id)) {
            expandedSubtaskTaskIds.delete(task.id);
        } else {
            expandedSubtaskTaskIds.add(task.id);
        }
        renderGroupTasks();
    });

    section.appendChild(toggleBtn);

    const body = document.createElement('div');
    body.classList.add('subtasksBody');
    if (!expanded) {
        body.classList.add('hidden');
    }

    if (subtasks.length > 0) {
        // Deliberately not a <ul>/<li>: those tag names collide with the
        // ".tasks li" selectors used for the top-level task rows, since
        // this list is nested inside one of those <li> elements. role="list"
        // preserves the list semantics for assistive tech without the
        // tag-name collision. (Same reasoning as script.js.)
        const list = document.createElement('div');
        list.classList.add('subtasksList');
        list.setAttribute('role', 'list');
        subtasks.forEach((subtask) => {
            list.appendChild(createGroupSubtaskItem(groupId, task, subtask, isOwner));
        });
        body.appendChild(list);
    }

    if (isOwner) {
        body.appendChild(createGroupSubtaskAddRow(groupId, task));
    }

    section.appendChild(body);
    return section;
}

function createGroupSubtaskItem(groupId, task, subtask, isOwner) {
    const item = document.createElement('div');
    item.classList.add('subtaskItem');
    item.setAttribute('role', 'listitem');
    item.dataset.subtaskId = subtask.id;
    if (subtask.completed) {
        item.classList.add('completed');
    }

    const row = document.createElement('div');
    row.classList.add('subtaskRow');

    const checkBtn = document.createElement('button');
    checkBtn.type = 'button';
    checkBtn.classList.add('subtaskCheckBtn');
    checkBtn.innerHTML = '<i class="fa-solid fa-check"></i>';
    checkBtn.setAttribute('aria-label', subtask.completed ? 'Mark step incomplete' : 'Mark step complete');
    if (!isOwner) {
        checkBtn.disabled = true;
    }

    const text = document.createElement('span');
    text.classList.add('subtaskText');
    text.textContent = subtask.text;

    // Rename - owner-only, same permission gate as delete/deadline below.
    // Not built at all for non-owners, same pattern those already use,
    // rather than building it disabled.
    let renameInput = null;
    let renameBtn = null;
    if (isOwner) {
        renameInput = document.createElement('input');
        renameInput.type = 'text';
        renameInput.classList.add('subtaskRenameInput', 'hidden');
        renameInput.maxLength = 300;
        renameInput.setAttribute('aria-label', 'Step text');
        renameInput.addEventListener('mousedown', (event) => event.stopPropagation());

        renameBtn = document.createElement('button');
        renameBtn.type = 'button';
        renameBtn.classList.add('subtaskRenameBtn');
        renameBtn.innerHTML = '<i class="fa-solid fa-pen"></i>';
        renameBtn.setAttribute('aria-label', 'Rename step');
        renameBtn.title = 'Rename step';

        const enterRenameMode = () => {
            renameInput.value = subtask.text;
            text.classList.add('hidden');
            renameInput.classList.remove('hidden');
            renameInput.focus();
            renameInput.select();
        };
        const exitRenameMode = () => {
            renameInput.classList.add('hidden');
            text.classList.remove('hidden');
        };
        const commitRename = () => {
            const newText = renameInput.value;
            if (newText.trim() === '' || newText.trim() === subtask.text) {
                exitRenameMode();
                return;
            }
            // renameGroupSubtask's own write triggers the live group-tasks
            // listener, which re-renders this row from Firestore - no need
            // to manually sync text.textContent on success.
            renameGroupSubtask(groupId, task, subtask.id, newText)
                .then((saved) => { if (!saved) exitRenameMode(); })
                .catch((error) => { console.error('Failed to rename step:', error); exitRenameMode(); });
        };

        renameBtn.addEventListener('click', () => {
            playClickSound();
            enterRenameMode();
        });
        renameInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                renameInput.blur();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                exitRenameMode();
            }
        });
        renameInput.addEventListener('blur', commitRename);
    }

    // A step's own optional deadline - same badge/urgency-color language as
    // the task-level deadline badge. Non-owners see the badge (if set) but
    // can't open the editor, same permission gate as delete/check above.
    const deadlineBadge = document.createElement('span');
    deadlineBadge.classList.add('subtaskDeadlineBadge', 'hidden');

    function refreshDeadlineDisplay() {
        if (!subtask.dueAt) {
            deadlineBadge.classList.add('hidden');
            deadlineBadge.textContent = '';
            return;
        }
        const status = getDeadlineStatus(subtask.dueAt);
        deadlineBadge.classList.remove('hidden', 'deadline-none', 'deadline-normal', 'deadline-soon', 'deadline-critical', 'deadline-overdue');
        deadlineBadge.classList.add(status.deadlineClassName);
        deadlineBadge.textContent = status.deadlineLabel.replace(/^Due /, '');
        deadlineBadge.title = status.countdownLabel;
    }
    refreshDeadlineDisplay();

    row.appendChild(checkBtn);
    row.appendChild(text);
    if (renameInput) {
        row.appendChild(renameInput);
    }
    row.appendChild(deadlineBadge);

    let inputWrap = null;
    if (isOwner) {
        row.appendChild(renameBtn);

        const deadlineBtn = document.createElement('button');
        deadlineBtn.type = 'button';
        deadlineBtn.classList.add('subtaskDeadlineBtn');
        deadlineBtn.innerHTML = '<i class="fa-solid fa-clock"></i>';
        deadlineBtn.setAttribute('aria-label', subtask.dueAt ? 'Change step deadline' : 'Set step deadline');

        inputWrap = document.createElement('div');
        inputWrap.classList.add('subtaskDeadlineInputWrap', 'hidden');
        const deadlineInput = document.createElement('input');
        deadlineInput.type = 'datetime-local';
        deadlineInput.classList.add('subtaskDeadlineInput');
        deadlineInput.setAttribute('aria-label', 'Step deadline');
        deadlineInput.addEventListener('mousedown', (event) => event.stopPropagation());
        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.classList.add('subtaskDeadlineClearBtn');
        clearBtn.textContent = 'Clear';
        inputWrap.appendChild(deadlineInput);
        inputWrap.appendChild(clearBtn);

        deadlineBtn.addEventListener('click', () => {
            playClickSound();
            deadlineInput.value = subtask.dueAt ? toDatetimeLocalValue(subtask.dueAt) : '';
            inputWrap.classList.toggle('hidden');
            if (!inputWrap.classList.contains('hidden')) {
                deadlineInput.focus();
            }
        });

        deadlineInput.addEventListener('change', () => {
            playClickSound();
            const iso = deadlineInput.value ? new Date(deadlineInput.value).toISOString() : null;
            subtask.dueAt = iso;
            deadlineBtn.setAttribute('aria-label', iso ? 'Change step deadline' : 'Set step deadline');
            refreshDeadlineDisplay();
            inputWrap.classList.add('hidden');
            setGroupSubtaskDueAt(groupId, task, subtask.id, iso).catch((error) => console.error('Failed to set step deadline:', error));
        });

        clearBtn.addEventListener('click', () => {
            playClickSound();
            subtask.dueAt = null;
            deadlineInput.value = '';
            deadlineBtn.setAttribute('aria-label', 'Set step deadline');
            refreshDeadlineDisplay();
            inputWrap.classList.add('hidden');
            setGroupSubtaskDueAt(groupId, task, subtask.id, null).catch((error) => console.error('Failed to clear step deadline:', error));
        });

        row.appendChild(deadlineBtn);

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.classList.add('subtaskDeleteBtn');
        deleteBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        deleteBtn.setAttribute('aria-label', 'Delete step');
        deleteBtn.addEventListener('click', () => {
            playClickSound();
            deleteGroupSubtask(groupId, task, subtask.id).catch((error) => console.error('Failed to delete step:', error));
        });
        row.appendChild(deleteBtn);
    }

    checkBtn.addEventListener('click', () => {
        if (!isOwner) {
            return;
        }
        playClickSound();
        toggleGroupSubtask(groupId, task, subtask.id).catch((error) => console.error('Failed to update step:', error));
    });

    item.appendChild(row);
    if (inputWrap) {
        item.appendChild(inputWrap);
    }
    return item;
}

function createGroupSubtaskAddRow(groupId, task) {
    const addRow = document.createElement('div');
    addRow.classList.add('subtaskAddRow');

    const addInput = document.createElement('input');
    addInput.type = 'text';
    addInput.classList.add('subtaskInput');
    addInput.placeholder = 'Add a step...';
    addInput.setAttribute('aria-label', 'Add a step');
    addInput.addEventListener('mousedown', (event) => event.stopPropagation());

    const addBtnEl = document.createElement('button');
    addBtnEl.type = 'button';
    addBtnEl.classList.add('subtaskAddBtn');
    addBtnEl.setAttribute('aria-label', 'Add step');
    addBtnEl.innerHTML = '<i class="fa-solid fa-plus"></i>';

    const submitNewSubtask = () => {
        if (addInput.value.trim() === '') {
            return;
        }
        playClickSound();
        expandedSubtaskTaskIds.add(task.id);
        addGroupSubtask(groupId, task, addInput.value).catch((error) => console.error('Failed to add step:', error));
        addInput.value = '';
    };

    addBtnEl.addEventListener('click', submitNewSubtask);
    addInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            submitNewSubtask();
        }
    });

    addRow.appendChild(addInput);
    addRow.appendChild(addBtnEl);
    return addRow;
}

// ---------------------------------------------------------------------
// Task editor - reuses the exact overlay classes from script.js's
// initializeTaskEditor()/editTask() (.taskEditorOverlay/.taskEditorCard/
// .editorActions etc.) so it looks identical to solo's, just with a
// leaner field set (no task type/time estimate/schedule - not part of
// group tasks yet).
// ---------------------------------------------------------------------

let taskEditorOverlay = null;
let activeEditorGroupId = null;
let activeEditorTaskId = null;

function initializeGroupTaskEditor() {
    if (taskEditorOverlay) {
        return;
    }

    taskEditorOverlay = document.createElement('div');
    taskEditorOverlay.className = 'taskEditorOverlay';
    taskEditorOverlay.innerHTML = `
        <div class="taskEditorCard" role="dialog" aria-modal="true" aria-label="Edit task">
            <h2>Edit Task</h2>
            <label>
                Task
                <input type="text" class="editorTextInput" maxlength="240">
            </label>
            <div class="detailsGridPrimary editorPrimaryGrid">
                <label class="detailsFieldGroup">
                    Task Matrix
                    <select class="editorMatrixSelect">
                        <option value="do">Task Matrix: Important &amp; Urgent</option>
                        <option value="schedule">Task Matrix: Important</option>
                        <option value="delegate">Task Matrix: Urgent</option>
                        <option value="eliminate">Task Matrix: None</option>
                    </select>
                    <p class="detailsFieldSubtitle">How urgent, how important</p>
                </label>
                <label class="detailsFieldGroup">
                    Difficulty
                    <select class="editorDifficultySelect">
                        <option value="1">1 (Very Easy)</option>
                        <option value="2">2 (Easy)</option>
                        <option value="3" selected>3 (Medium)</option>
                        <option value="4">4 (Hard)</option>
                        <option value="5">5 (Very Hard)</option>
                    </select>
                    <p class="detailsFieldSubtitle">How hard this will be</p>
                </label>
            </div>

            <!-- Deadline is a third primary field, not behind More options -
                 same reasoning as the inline Prioritize panel. -->
            <label class="detailsFieldGroup detailsDeadlinePrimary">
                Deadline
                <div class="editorDeadlineWrap">
                    <input type="datetime-local" class="editorDeadlineInput">
                    <button type="button" class="editorCalendarBtn" aria-label="Open edit deadline calendar">
                        <i class="fa-solid fa-calendar"></i>
                    </button>
                </div>
            </label>

            <label class="detailsFieldGroup detailsRecurrencePrimary">
                Repeat
                <select class="editorRecurrenceSelect">
                    <option value="">Does not repeat</option>
                    <option value="daily">Repeats daily</option>
                    <option value="weekly">Repeats weekly</option>
                    <option value="monthly">Repeats monthly</option>
                </select>
            </label>

            <button type="button" class="detailsMoreToggleBtn editorMoreToggleBtn" aria-expanded="false" aria-controls="groupEditorMoreOptions">
                <span>More options: estimate, schedule</span>
                <i class="fa-solid fa-chevron-down" aria-hidden="true"></i>
            </button>

            <div class="detailsMoreOptions editorMoreOptions" id="groupEditorMoreOptions">
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
                    Schedule (when you'll actually do it)
                    <div class="editorDeadlineWrap editorScheduleWrap">
                        <input type="datetime-local" class="editorDeadlineInput editorScheduleInput">
                        <button type="button" class="editorCalendarBtn editorScheduleCalendarBtn" aria-label="Open edit schedule calendar">
                            <i class="fa-solid fa-clock"></i>
                        </button>
                    </div>
                </label>
            </div>

            <div class="editorActions">
                <button type="button" class="editorCancelBtn">Cancel</button>
                <button type="button" class="editorSaveBtn">Save</button>
            </div>
        </div>
    `;

    document.body.appendChild(taskEditorOverlay);

    const editorTextInput = taskEditorOverlay.querySelector('.editorTextInput');
    const editorTaskTypeSelect = taskEditorOverlay.querySelector('.editorTaskTypeSelect');
    const editorDurationInput = taskEditorOverlay.querySelector('.editorDurationInput');
    const editorDeadlineInput = taskEditorOverlay.querySelector('.editorDeadlineInput:not(.editorScheduleInput)');
    const editorDeadlineWrap = taskEditorOverlay.querySelector('.editorDeadlineWrap:not(.editorScheduleWrap)');
    const editorScheduleInput = taskEditorOverlay.querySelector('.editorScheduleInput');
    const editorScheduleWrap = taskEditorOverlay.querySelector('.editorScheduleWrap');
    const editorCancelBtn = taskEditorOverlay.querySelector('.editorCancelBtn');
    const editorSaveBtn = taskEditorOverlay.querySelector('.editorSaveBtn');
    const editorMoreToggleBtn = taskEditorOverlay.querySelector('.editorMoreToggleBtn');
    const editorMoreOptions = taskEditorOverlay.querySelector('.editorMoreOptions');

    sanitizeNumberInputAsPositiveInteger(editorDurationInput);

    editorSaveBtn.addEventListener('click', saveGroupTaskEditorChanges);
    editorCancelBtn.addEventListener('click', closeGroupTaskEditor);

    // Same two-tier disclosure as the inline Prioritize panel (section V).
    if (editorMoreToggleBtn && editorMoreOptions) {
        editorMoreToggleBtn.addEventListener('click', () => {
            playClickSound();
            const isOpen = !editorMoreOptions.classList.contains('open');
            editorMoreOptions.classList.toggle('open', isOpen);
            editorMoreToggleBtn.setAttribute('aria-expanded', String(isOpen));
        });
    }

    editorTaskTypeSelect.addEventListener('change', () => {
        updateEditorDurationInputVisibility();
    });

    editorTextInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            saveGroupTaskEditorChanges();
        }
    });

    if (editorDeadlineWrap) {
        editorDeadlineWrap.addEventListener('click', () => {
            if (typeof editorDeadlineInput.showPicker === 'function') {
                editorDeadlineInput.showPicker();
            } else {
                editorDeadlineInput.focus();
            }
        });
    }

    if (editorScheduleWrap && editorScheduleInput) {
        editorScheduleWrap.addEventListener('click', () => {
            if (typeof editorScheduleInput.showPicker === 'function') {
                editorScheduleInput.showPicker();
            } else {
                editorScheduleInput.focus();
            }
        });
    }

    taskEditorOverlay.addEventListener('click', (event) => {
        if (event.target === taskEditorOverlay) {
            closeGroupTaskEditor();
        }
    });
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

function openGroupTaskEditor(groupId, task) {
    initializeGroupTaskEditor();

    activeEditorGroupId = groupId;
    activeEditorTaskId = task.id;

    const editorTextInput = taskEditorOverlay.querySelector('.editorTextInput');
    const editorMatrixSelect = taskEditorOverlay.querySelector('.editorMatrixSelect');
    const editorTaskTypeSelect = taskEditorOverlay.querySelector('.editorTaskTypeSelect');
    const editorDurationInput = taskEditorOverlay.querySelector('.editorDurationInput');
    const editorDifficultySelect = taskEditorOverlay.querySelector('.editorDifficultySelect');
    const editorDeadlineInput = taskEditorOverlay.querySelector('.editorDeadlineInput:not(.editorScheduleInput)');
    const editorScheduleInput = taskEditorOverlay.querySelector('.editorScheduleInput');
    const editorRecurrenceSelect = taskEditorOverlay.querySelector('.editorRecurrenceSelect');

    editorTextInput.value = task.text;
    editorMatrixSelect.value = getValidMatrixValue(task.matrix);
    editorTaskTypeSelect.value = getValidTaskType(task.taskType);
    editorDurationInput.value = task.estimateMinutes ? String(task.estimateMinutes) : '';
    editorDifficultySelect.value = String(getValidDifficultyLevel(task.difficulty));
    editorDeadlineInput.value = task.dueAt && isValidDateValue(task.dueAt) ? toDatetimeLocalValue(task.dueAt) : '';
    if (editorScheduleInput) {
        editorScheduleInput.value = task.scheduledAt && isValidDateValue(task.scheduledAt) ? toDatetimeLocalValue(task.scheduledAt) : '';
    }
    if (editorRecurrenceSelect) {
        editorRecurrenceSelect.value = getValidRecurrenceValue(task.recurrence) || '';
    }
    updateEditorDurationInputVisibility();

    // More options starts expanded when the task already has an estimate
    // or a schedule set, so editing never hides already-configured data
    // behind a collapsed toggle - same reasoning as solo's editTask
    // (script.js). dueAt deliberately excluded - Deadline is the always-
    // visible primary tier now, not inside More options, so a deadline-only
    // task has nothing in that section worth auto-expanding for. Real bug
    // caught by code review.
    const editorMoreToggleBtn = taskEditorOverlay.querySelector('.editorMoreToggleBtn');
    const editorMoreOptions = taskEditorOverlay.querySelector('.editorMoreOptions');
    const hasExtraDetails = Boolean(task.estimateMinutes) || Boolean(task.scheduledAt);
    if (editorMoreOptions && editorMoreToggleBtn) {
        editorMoreOptions.classList.toggle('open', hasExtraDetails);
        editorMoreToggleBtn.setAttribute('aria-expanded', String(hasExtraDetails));
    }

    taskEditorOverlay.classList.add('open');
    editorTextInput.focus();
    editorTextInput.select();
}

function closeGroupTaskEditor() {
    if (!taskEditorOverlay) {
        return;
    }
    taskEditorOverlay.classList.remove('open');
    activeEditorGroupId = null;
    activeEditorTaskId = null;
}

function saveGroupTaskEditorChanges() {
    if (!taskEditorOverlay || !activeEditorGroupId || !activeEditorTaskId) {
        return;
    }

    const editorTextInput = taskEditorOverlay.querySelector('.editorTextInput');
    const editorMatrixSelect = taskEditorOverlay.querySelector('.editorMatrixSelect');
    const editorTaskTypeSelect = taskEditorOverlay.querySelector('.editorTaskTypeSelect');
    const editorDurationInput = taskEditorOverlay.querySelector('.editorDurationInput');
    const editorDifficultySelect = taskEditorOverlay.querySelector('.editorDifficultySelect');
    const editorDeadlineInput = taskEditorOverlay.querySelector('.editorDeadlineInput:not(.editorScheduleInput)');
    const editorScheduleInput = taskEditorOverlay.querySelector('.editorScheduleInput');
    const editorRecurrenceSelect = taskEditorOverlay.querySelector('.editorRecurrenceSelect');

    const updatedText = editorTextInput.value.trim();
    if (updatedText === '') {
        alert('Task text cannot be empty.');
        editorTextInput.focus();
        return;
    }

    const updatedTaskType = getValidTaskType(editorTaskTypeSelect.value);
    const updatedDueAt = editorDeadlineInput.value ? new Date(editorDeadlineInput.value).toISOString() : null;

    const { doc, updateDoc } = fs();
    updateDoc(doc(db(), 'groups', activeEditorGroupId, 'tasks', activeEditorTaskId), {
        text: updatedText,
        matrix: getValidMatrixValue(editorMatrixSelect.value),
        taskType: updatedTaskType,
        estimateMinutes: updatedTaskType === 'timeboxed' ? parseDurationMinutes(editorDurationInput.value) : null,
        difficulty: getValidDifficultyLevel(editorDifficultySelect.value),
        dueAt: updatedDueAt,
        // Same "needs a deadline to repeat from" rule as creating a task -
        // clearing the deadline also clears the repeat.
        recurrence: updatedDueAt && editorRecurrenceSelect ? getValidRecurrenceValue(editorRecurrenceSelect.value) : null,
        scheduledAt: editorScheduleInput && editorScheduleInput.value ? new Date(editorScheduleInput.value).toISOString() : null,
        updatedAt: new Date().toISOString()
    }).catch((error) => console.error('Failed to save task edits:', error));

    closeGroupTaskEditor();
}

// datetime-local inputs need "YYYY-MM-DDTHH:mm" in local time, not an ISO
// string with a Z suffix - same conversion script.js uses.
function toDatetimeLocalValue(isoValue) {
    const date = new Date(isoValue);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}`;
}

// Priority scoring for group tasks - same core idea as compareByPriority()/
// getPriorityScore() in script.js (deadline pressure, matrix weight,
// difficulty weight, subtask completion), minus the solo-only inputs group
// tasks don't have (task type/time estimate, scheduledAt). Group tasks are
// always auto-sorted by this - there's no manual toggle, since with several
// people's tasks mixed together "what matters most right now" is the whole
// point of the shared view.
function getGroupPriorityScore(task) {
    // Urgency, not the task's own literal dueAt alone - an incomplete
    // step's own deadline counts too, whichever is sooner (see
    // getTaskUrgencyStatus/getEffectiveDueAt in task-shared.js).
    const status = getTaskUrgencyStatus(task);
    const matrixRank = MATRIX_CONFIG[getValidMatrixValue(task.matrix)].rank;
    const difficultyRank = DIFFICULTY_CONFIG[getValidDifficultyLevel(task.difficulty)].rank;

    let score = 0;

    if (status.isOverdue) {
        score += 1000;
        score += Math.min(320, Math.abs(status.timeUntilMs) / 3600000);
    } else if (status.hasDeadline) {
        const hoursLeft = Math.max(1, status.timeUntilMs / 3600000);
        score += Math.max(0, 260 - Math.min(260, hoursLeft));

        // Slack (how much runway is left versus how long this will
        // actually take), not difficulty in isolation - see script.js's
        // getPriorityScore for the full reasoning (identical logic, mirrored
        // here). Comfortable slack contributes nothing; tight/negative
        // slack ramps up fast.
        const slackHours = hoursLeft - getEstimatedEffortHours(task);
        score += Math.max(0, Math.min(200, (12 - slackHours) * 15));
    }

    score += matrixRank * 45;

    // Small, deliberate nudge toward EASIER tasks when nothing's actually
    // urgent yet - not the deadline-driven slack pressure above, which
    // already overrides this the moment a hard task's own runway gets
    // tight.
    score += (6 - difficultyRank) * 3;

    const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];
    if (subtasks.length > 0) {
        const doneFraction = subtasks.filter((subtask) => subtask.completed).length / subtasks.length;
        if (status.isOverdue || status.hasDeadline) {
            score += doneFraction * 80;
        }
        score += doneFraction * 10;
    }

    return score;
}

function compareGroupTasksByPriority(taskA, taskB) {
    if (taskA.completed !== taskB.completed) {
        return taskA.completed ? 1 : -1;
    }

    const scoreDiff = getGroupPriorityScore(taskB) - getGroupPriorityScore(taskA);
    if (scoreDiff !== 0) {
        return scoreDiff;
    }

    const statusA = getDeadlineStatus(taskA.dueAt);
    const statusB = getDeadlineStatus(taskB.dueAt);
    if (statusA.deadlineTimestamp !== statusB.deadlineTimestamp) {
        return statusA.deadlineTimestamp - statusB.deadlineTimestamp;
    }

    return (taskA.createdAt || '').localeCompare(taskB.createdAt || '');
}

// Mirrors getVisibleTasks()'s view semantics in script.js, applied to
// whichever slice of the group's tasks the member-scope tabs currently
// select (everyone together, just you, or just one teammate).
function getVisibleGroupTasks() {
    const now = Date.now();
    const scopedTasks = activeMemberScope === 'all'
        ? groupTasks
        : groupTasks.filter((task) => task.ownerId === activeMemberScope);

    switch (activeView) {
        case 'focus': {
            const in24Hours = now + (24 * 60 * 60 * 1000);
            return scopedTasks
                .filter((task) => {
                    if (task.completed) {
                        return false;
                    }
                    const status = getDeadlineStatus(task.dueAt);
                    const dueSoon = status.hasDeadline && status.deadlineTimestamp <= in24Hours;
                    const urgentMatrix = getValidMatrixValue(task.matrix) === 'do';
                    return dueSoon || urgentMatrix;
                })
                .sort(compareGroupTasksByPriority)
                .slice(0, 5);
        }
        case 'overdue':
            return scopedTasks.filter((task) => !task.completed && getDeadlineStatus(task.dueAt).isOverdue);
        case 'today':
            return scopedTasks.filter((task) => {
                if (task.completed || !isValidDateValue(task.dueAt)) {
                    return false;
                }
                const dueDate = new Date(task.dueAt);
                const today = new Date();
                return dueDate.getFullYear() === today.getFullYear()
                    && dueDate.getMonth() === today.getMonth()
                    && dueDate.getDate() === today.getDate();
            });
        case 'week': {
            const weekAhead = now + (7 * 24 * 60 * 60 * 1000);
            return scopedTasks.filter((task) => {
                if (task.completed || !isValidDateValue(task.dueAt)) {
                    return false;
                }
                const dueTimestamp = new Date(task.dueAt).getTime();
                return dueTimestamp >= now && dueTimestamp <= weekAhead;
            });
        }
        case 'completed':
            return scopedTasks.filter((task) => task.completed);
        case 'all':
        default:
            return scopedTasks;
    }
}

function setActiveView(view) {
    activeView = view;
    taskViewBtns.forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.view === view);
    });
    renderGroupTasks();
}

taskViewBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
        playClickSound();
        setActiveView(btn.dataset.view);
    });
});

// "Whose tasks" tabs: Everyone (the combined view), Me, then one tab per
// teammate - separate from the deadline-based views above, and also
// settable by clicking a roster card in the side column (both control the
// same activeMemberScope state).
// Owner is always implicit via group.ownerId, never duplicated into
// adminIds - so "isAdmin" only ever means "promoted, and not already the
// owner" (the owner's own capabilities are a superset of admin's anyway).
function getMyRoleInGroup(group) {
    const isOwner = group.ownerId === currentUser?.uid;
    const isAdmin = !isOwner && (group.adminIds || []).includes(currentUser?.uid);
    return { isOwner, isAdmin };
}

function setActiveMemberScope(scope) {
    activeMemberScope = scope;
    const group = getSelectedGroup();
    if (group) {
        renderGroupMemberScopeTabs(group);
        renderMemberRoster(group, getMyRoleInGroup(group));
        renderGroupHistory(group);
        renderSuggestForMemberBanner(group);
    }
    renderGroupTasks();
}

// Suggesting a task is contextual to the Tasks tab now (not a button on
// every roster card in Team) - only rendered once whose-tasks actually has
// a specific teammate selected, matching how the user described wanting
// this: "switch between whose tasks and if you go on a specific person's
// you can suggest task there."
const suggestForMemberBanner = document.querySelector('.suggestForMemberBanner');

function renderSuggestForMemberBanner(group) {
    if (!suggestForMemberBanner) {
        return;
    }
    suggestForMemberBanner.innerHTML = '';

    const isSpecificMember = activeMemberScope !== 'all' && activeMemberScope !== currentUser?.uid;
    if (!group || !isSpecificMember) {
        suggestForMemberBanner.classList.add('hidden');
        return;
    }

    const memberIds = group.memberIds || [];
    const memberNames = group.memberNames || [];
    const index = memberIds.indexOf(activeMemberScope);
    const name = resolveMemberName(activeMemberScope, memberNames[index], groupTasks);

    const text = document.createElement('span');
    text.textContent = `Viewing ${name}'s tasks.`;
    suggestForMemberBanner.appendChild(text);

    const suggestBtn = document.createElement('button');
    suggestBtn.type = 'button';
    suggestBtn.classList.add('suggestForMemberBtn');
    suggestBtn.innerHTML = '<i class="fa-solid fa-lightbulb"></i> Suggest a task';
    suggestBtn.addEventListener('click', () => {
        playClickSound();
        openSuggestTaskModal(group.id, activeMemberScope, name);
    });
    suggestForMemberBanner.appendChild(suggestBtn);

    suggestForMemberBanner.classList.remove('hidden');
}

// Same "last viewed vs. server timestamp" shape as the comments unread dot
// above (COMMENTS_LAST_VIEWED_KEY), but keyed by groupId rather than taskId
// - history is a group-level feed, not a per-task thing. Deliberately
// compares against the whole group's feed regardless of which "whose
// tasks" scope is currently selected, matching the comments dot's own
// per-task (not per-view) granularity.
const HISTORY_LAST_VIEWED_KEY = 'todolist-history-last-viewed';

function getHistoryLastViewedAt(groupId) {
    try {
        const stored = JSON.parse(localStorage.getItem(HISTORY_LAST_VIEWED_KEY) || '{}');
        return stored[groupId] || null;
    } catch {
        return null;
    }
}

function setHistoryLastViewedAt(groupId, isoString) {
    try {
        const stored = JSON.parse(localStorage.getItem(HISTORY_LAST_VIEWED_KEY) || '{}');
        stored[groupId] = isoString;
        localStorage.setItem(HISTORY_LAST_VIEWED_KEY, JSON.stringify(stored));
    } catch {
        // localStorage can be unavailable - the indicator just won't
        // remember what you've already seen across reloads.
    }
}

function hasUnreadHistory(groupId) {
    if (!groupId || groupHistoryEntries.length === 0) {
        return false;
    }
    // Newest-first already, per subscribeToGroupHistory's own
    // orderBy('completedAt', 'desc') - no re-sort needed here.
    const newest = groupHistoryEntries[0]?.completedAt;
    if (!newest) {
        return false;
    }
    const lastViewed = getHistoryLastViewedAt(groupId);
    if (!lastViewed) {
        return true;
    }
    return new Date(newest).getTime() > new Date(lastViewed).getTime();
}

// "Recently finished" - a lighter, non-calendar take on solo's activity
// heatmap: the last several completions across the group (or just the
// selected member-scope), each showing who finished it and when, so it
// doubles as both a per-member history and an overall group history.
// Reads from the permanent groupHistoryEntries log (see
// subscribeToGroupHistory) rather than filtering the live groupTasks list,
// so a completion stays here even after its task is later deleted.
function renderGroupHistory(group) {
    groupHistoryUnreadDot?.classList.toggle('hidden', !hasUnreadHistory(group?.id));

    if (!groupHistoryList) {
        return;
    }
    groupHistoryList.innerHTML = '';

    if (groupHistoryLoadError) {
        const errorMsg = document.createElement('p');
        errorMsg.classList.add('groupHistoryEmpty', 'groupHistoryError');
        errorMsg.textContent = groupHistoryLoadError;
        groupHistoryList.appendChild(errorMsg);
        return;
    }

    const scopedEntries = activeMemberScope === 'all'
        ? groupHistoryEntries
        : groupHistoryEntries.filter((entry) => entry.ownerId === activeMemberScope);

    // Lives inline in the Activity tab now (see index.html) rather than a
    // modal - showing the full 50-entry log it's already subscribed to
    // (rather than an older, shorter slice) doesn't grow the dashboard
    // itself, since .groupHistoryPanel/.groupHistoryList are height-capped
    // and scroll internally instead (style.css).
    const finished = scopedEntries;

    if (finished.length === 0) {
        const empty = document.createElement('p');
        empty.classList.add('groupHistoryEmpty');
        empty.textContent = 'Nothing finished here yet - completed tasks show up here as soon as anyone checks one off.';
        groupHistoryList.appendChild(empty);
        return;
    }

    finished.forEach((entry) => {
        const item = document.createElement('div');
        item.classList.add('groupHistoryItem');

        const text = document.createElement('p');
        text.classList.add('groupHistoryItemText');
        text.textContent = entry.taskText;
        item.appendChild(text);

        const ownerName = entry.ownerId === currentUser?.uid ? 'You' : (entry.ownerName || 'Teammate');

        const meta = document.createElement('p');
        meta.classList.add('groupHistoryItemMeta');
        meta.textContent = `${ownerName} - ${formatFriendlyDateTime(new Date(entry.completedAt))}`;
        item.appendChild(meta);

        groupHistoryList.appendChild(item);
    });
}

// Activity is a plain always-rendered tab now (see switchGroupView's
// 'activity' branch above, which handles marking history as viewed) - the
// modal open/close functions and their overlay/button wiring that used to
// live here are gone along with .groupHistoryOverlay itself.

// Pending suggestions a teammate made for YOU specifically (see the
// "Suggest a task" button on each roster card) - accept to create the real
// task in your own list, or dismiss it.
// Shared with computeAttentionSummary() below, so the nav badge's count and
// this panel's own contents can never drift apart.
function getPendingSuggestionsForYou() {
    if (!currentUser) {
        return [];
    }
    return groupSuggestions.filter((suggestion) => (
        suggestion.forUserId === currentUser.uid && suggestion.status === 'pending'
    ));
}

function renderSuggestionsForYou(groupId) {
    if (!suggestionsForYouPanel || !currentUser) {
        return;
    }

    const pendingForMe = getPendingSuggestionsForYou();

    suggestionsForYouPanel.innerHTML = '';
    suggestionsForYouPanel.classList.toggle('hidden', pendingForMe.length === 0);

    pendingForMe.forEach((suggestion) => {
        const row = document.createElement('div');
        row.classList.add('suggestionRow');

        // Built with textContent/createElement, not innerHTML - both
        // fromUserName (a teammate's own account display name) and text
        // (suggestion content, potentially AI-drafted then user-edited via
        // Brain Dump) are attacker-controllable strings. Interpolating
        // either into innerHTML would let a crafted display name or
        // suggestion body execute arbitrary script in the recipient's
        // browser the moment this panel renders.
        const text = document.createElement('p');
        text.classList.add('suggestionRowText');
        const fromSpan = document.createElement('span');
        fromSpan.classList.add('suggestionRowFrom');
        fromSpan.textContent = `${suggestion.fromUserName || 'A teammate'} suggests:`;
        text.appendChild(fromSpan);
        text.appendChild(document.createTextNode(` ${suggestion.text || ''}`));
        row.appendChild(text);

        const badges = document.createElement('div');
        badges.classList.add('suggestionRowBadges');

        const matrixValue = getValidMatrixValue(suggestion.matrix);
        const matrixBadge = document.createElement('span');
        matrixBadge.classList.add('matrixBadge', MATRIX_CONFIG[matrixValue].className);
        matrixBadge.textContent = MATRIX_CONFIG[matrixValue].label;
        badges.appendChild(matrixBadge);

        const difficultyLevel = getValidDifficultyLevel(suggestion.difficulty);
        const difficultyBadge = document.createElement('span');
        difficultyBadge.classList.add('difficultyBadge', `difficulty-${difficultyLevel}`);
        difficultyBadge.textContent = getDifficultyLabel(difficultyLevel);
        badges.appendChild(difficultyBadge);

        if (suggestion.dueAt) {
            const deadlineBadge = document.createElement('span');
            deadlineBadge.classList.add('deadlineBadge', 'deadline-normal');
            deadlineBadge.textContent = getDeadlineStatus(suggestion.dueAt).deadlineLabel;
            badges.appendChild(deadlineBadge);
        }

        row.appendChild(badges);

        const actions = document.createElement('div');
        actions.classList.add('suggestionRowActions');

        const acceptBtn = document.createElement('button');
        acceptBtn.type = 'button';
        acceptBtn.classList.add('suggestionAcceptBtn');
        acceptBtn.textContent = 'Add it';
        acceptBtn.addEventListener('click', () => {
            playClickSound();
            acceptSuggestion(groupId, suggestion, currentUser).catch((error) => console.error('Failed to accept suggestion:', error));
        });
        actions.appendChild(acceptBtn);

        const dismissBtn = document.createElement('button');
        dismissBtn.type = 'button';
        dismissBtn.classList.add('suggestionDismissBtn');
        dismissBtn.textContent = 'Dismiss';
        dismissBtn.addEventListener('click', () => {
            playClickSound();
            dismissSuggestion(groupId, suggestion.id).catch((error) => console.error('Failed to dismiss suggestion:', error));
        });
        actions.appendChild(dismissBtn);

        row.appendChild(actions);
        suggestionsForYouPanel.appendChild(row);
    });
}

// "Suggest a task" modal - reuses the exact .taskEditorOverlay/.taskEditorCard
// styling from the task editor (see initializeGroupTaskEditor) so it looks
// consistent, but is its own overlay since the fields and purpose differ
// (proposing a brand new task for someone else, not editing an existing one).
let suggestOverlay = null;
let suggestGroupId = null;
let suggestForUserId = null;

function initializeSuggestModal() {
    if (suggestOverlay) {
        return;
    }

    suggestOverlay = document.createElement('div');
    suggestOverlay.className = 'taskEditorOverlay suggestTaskOverlay';
    suggestOverlay.innerHTML = `
        <div class="taskEditorCard" role="dialog" aria-modal="true" aria-label="Suggest a task">
            <h2>Suggest a Task</h2>
            <p class="suggestForLabel"></p>
            <label>
                Task
                <input type="text" class="editorTextInput" maxlength="240">
            </label>
            <div class="detailsGridPrimary editorPrimaryGrid">
                <label class="detailsFieldGroup">
                    Task Matrix
                    <select class="editorMatrixSelect">
                        <option value="do">Task Matrix: Important &amp; Urgent</option>
                        <option value="schedule" selected>Task Matrix: Important</option>
                        <option value="delegate">Task Matrix: Urgent</option>
                        <option value="eliminate">Task Matrix: None</option>
                    </select>
                    <p class="detailsFieldSubtitle">How urgent, how important</p>
                </label>
                <label class="detailsFieldGroup">
                    Difficulty
                    <select class="editorDifficultySelect">
                        <option value="1">1 (Very Easy)</option>
                        <option value="2">2 (Easy)</option>
                        <option value="3" selected>3 (Medium)</option>
                        <option value="4">4 (Hard)</option>
                        <option value="5">5 (Very Hard)</option>
                    </select>
                    <p class="detailsFieldSubtitle">How hard this will be</p>
                </label>
            </div>

            <!-- No More options toggle here (unlike the task editor/inline
                 panel) - deadline was the ONLY thing behind it, and deadline
                 is a primary field now (same reasoning as everywhere else in
                 this rework), so there is nothing left this modal would ever
                 need to hide. Matrix, Difficulty, and Deadline together are
                 still well within Hick's Law's comfortable range as three
                 always-visible fields. -->
            <label class="detailsFieldGroup detailsDeadlinePrimary">
                Deadline (optional)
                <div class="editorDeadlineWrap">
                    <input type="datetime-local" class="editorDeadlineInput">
                    <button type="button" class="editorCalendarBtn" aria-label="Open deadline calendar">
                        <i class="fa-solid fa-calendar"></i>
                    </button>
                </div>
            </label>

            <div class="editorActions">
                <button type="button" class="editorCancelBtn">Cancel</button>
                <button type="button" class="editorSaveBtn">Send suggestion</button>
            </div>
        </div>
    `;

    document.body.appendChild(suggestOverlay);

    const suggestTextInput = suggestOverlay.querySelector('.editorTextInput');
    const suggestDeadlineInput = suggestOverlay.querySelector('.editorDeadlineInput');
    const deadlineWrap = suggestOverlay.querySelector('.editorDeadlineWrap');
    const cancelBtn = suggestOverlay.querySelector('.editorCancelBtn');
    const sendBtn = suggestOverlay.querySelector('.editorSaveBtn');
    // No More options toggle in this modal anymore (see the markup above) -
    // deadline was the only thing behind it, and it's a primary field now.

    sendBtn.addEventListener('click', submitSuggestTaskModal);
    cancelBtn.addEventListener('click', closeSuggestModal);

    suggestTextInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            submitSuggestTaskModal();
        }
    });

    if (deadlineWrap) {
        deadlineWrap.addEventListener('click', () => {
            if (typeof suggestDeadlineInput.showPicker === 'function') {
                suggestDeadlineInput.showPicker();
            } else {
                suggestDeadlineInput.focus();
            }
        });
    }

    suggestOverlay.addEventListener('click', (event) => {
        if (event.target === suggestOverlay) {
            closeSuggestModal();
        }
    });
}

function openSuggestTaskModal(groupId, forUserId, forUserName) {
    if (!currentUser) {
        return;
    }
    initializeSuggestModal();

    suggestGroupId = groupId;
    suggestForUserId = forUserId;

    // Built via createElement/textContent, not innerHTML template
    // interpolation - forUserName is another member's display name, real
    // user-controlled data (same reasoning as the renderSuggestionsForYou
    // XSS fix earlier this session).
    const suggestForLabelEl = suggestOverlay.querySelector('.suggestForLabel');
    suggestForLabelEl.innerHTML = '';
    const suggestForIcon = document.createElement('i');
    suggestForIcon.className = 'fa-solid fa-user';
    suggestForIcon.setAttribute('aria-hidden', 'true');
    suggestForLabelEl.appendChild(suggestForIcon);
    suggestForLabelEl.appendChild(document.createTextNode(` For ${forUserName}`));
    suggestOverlay.querySelector('.editorTextInput').value = '';
    suggestOverlay.querySelector('.editorMatrixSelect').value = 'schedule';
    suggestOverlay.querySelector('.editorDifficultySelect').value = '3';
    suggestOverlay.querySelector('.editorDeadlineInput').value = '';

    suggestOverlay.classList.add('open');
    suggestOverlay.querySelector('.editorTextInput').focus();
}

function closeSuggestModal() {
    if (!suggestOverlay) {
        return;
    }
    suggestOverlay.classList.remove('open');
    suggestGroupId = null;
    suggestForUserId = null;
}

function submitSuggestTaskModal() {
    if (!suggestOverlay || !suggestGroupId || !suggestForUserId || !currentUser) {
        return;
    }

    const text = suggestOverlay.querySelector('.editorTextInput').value;
    if (!text.trim()) {
        alert('Suggest something first.');
        return;
    }
    const matrix = suggestOverlay.querySelector('.editorMatrixSelect').value;
    const difficulty = suggestOverlay.querySelector('.editorDifficultySelect').value;
    const deadlineValue = suggestOverlay.querySelector('.editorDeadlineInput').value;
    const dueAt = deadlineValue ? new Date(deadlineValue).toISOString() : null;

    suggestTaskForMember(suggestGroupId, currentUser, suggestForUserId, { text, matrix, difficulty, dueAt })
        .catch((error) => {
            console.error('Failed to send suggestion:', error);
            alert('Could not send that suggestion.');
        });

    closeSuggestModal();
}

// Group settings modal - owner/admin only entry point (see .groupSettingsBtn
// wiring below) for who-can-join and pending join requests. Built the same
// dynamic way as the suggest-task modal above: reuses .taskEditorOverlay/
// .taskEditorCard styling, toggled via the .open class. No member/role list
// duplicated in here - kick/promote controls already live on the roster
// cards, which are the one place members are listed.
// (groupSettingsOverlay/groupSettingsGroupId themselves are declared much
// earlier now, right before the eager initializeGroupSettingsModal() call -
// see the comment there for why.)

function initializeGroupSettingsModal() {
    if (groupSettingsOverlay) {
        return;
    }

    groupSettingsOverlay = document.createElement('div');
    groupSettingsOverlay.className = 'taskEditorOverlay groupSettingsOverlay';
    groupSettingsOverlay.innerHTML = `
        <div class="taskEditorCard groupSettingsCard" role="dialog" aria-modal="true" aria-label="Group settings">
            <h2>Group Settings</h2>
            <section class="settingsSection groupSettingsPrivacySection">
                <h3>Who can join</h3>
                <label class="groupSettingsPrivacyLabel">
                    <select class="groupSettingsPrivacySelect">
                        <option value="open">Open - anyone with the code joins instantly</option>
                        <option value="invite-only">Invite-only - code holders must be approved</option>
                        <option value="closed">Closed - no new members for now</option>
                    </select>
                </label>
                <p class="groupSettingsPrivacyNote hidden">Only the group's owner can change this.</p>
            </section>
            <section class="settingsSection groupSettingsRequestsSection">
                <h3>Pending join requests</h3>
                <div class="groupSettingsRequestsList"></div>
            </section>
            <section class="settingsSection settingsDangerSection groupSettingsDangerSection">
                <h3>Leave or delete this group</h3>
                <p class="settingsHint">Leaving removes you from this group. Deleting removes it - and every task in it - for everyone. Neither can be undone.</p>
                <div class="groupSettingsDangerActions"></div>
            </section>
            <div class="editorActions">
                <button type="button" class="editorCancelBtn">Close</button>
            </div>
        </div>
    `;

    document.body.appendChild(groupSettingsOverlay);

    // .groupLeaveBtn/.groupDeleteBtn are real static markup (their click
    // wiring below runs at page load, same as every other top-level element
    // lookup here) - moved into the danger-zone section above via
    // appendChild, which reparents rather than clones, so the listeners
    // already attached to them survive intact. Section A of the UI/UX
    // rework: these move out of the permanent header into Group Settings,
    // reusing solo Settings' .settingsDangerSection pattern exactly.
    const dangerActions = groupSettingsOverlay.querySelector('.groupSettingsDangerActions');
    if (dangerActions && groupLeaveBtn) {
        dangerActions.appendChild(groupLeaveBtn);
    }
    if (dangerActions && groupDeleteBtn) {
        dangerActions.appendChild(groupDeleteBtn);
    }

    const privacySelect = groupSettingsOverlay.querySelector('.groupSettingsPrivacySelect');
    privacySelect.addEventListener('change', () => {
        if (!groupSettingsGroupId || privacySelect.disabled) {
            return;
        }
        setGroupPrivacy(groupSettingsGroupId, privacySelect.value).catch((error) => {
            console.error('Failed to update privacy:', error);
            alert(error.message || 'Could not update who can join.');
        });
    });

    groupSettingsOverlay.querySelector('.editorCancelBtn').addEventListener('click', closeGroupSettingsModal);
    groupSettingsOverlay.addEventListener('click', (event) => {
        if (event.target === groupSettingsOverlay) {
            closeGroupSettingsModal();
        }
    });
}

function renderPendingJoinRequests(requests) {
    if (!groupSettingsOverlay) {
        return;
    }
    const list = groupSettingsOverlay.querySelector('.groupSettingsRequestsList');
    list.innerHTML = '';

    if (requests.length === 0) {
        const empty = document.createElement('p');
        empty.classList.add('groupSettingsRequestsEmpty');
        empty.textContent = 'No pending requests.';
        list.appendChild(empty);
        return;
    }

    requests.forEach((request) => {
        const row = document.createElement('div');
        row.classList.add('groupSettingsRequestRow');

        const name = document.createElement('span');
        name.classList.add('groupSettingsRequestName');
        name.textContent = request.name || 'Someone';
        row.appendChild(name);

        const actions = document.createElement('div');
        actions.classList.add('groupSettingsRequestActions');

        const approveBtn = document.createElement('button');
        approveBtn.type = 'button';
        approveBtn.classList.add('groupSettingsApproveBtn');
        approveBtn.textContent = 'Approve';
        approveBtn.addEventListener('click', () => {
            playClickSound();
            approveJoinRequest(groupSettingsGroupId, request.uid, request.name || 'Teammate').catch((error) => {
                console.error('Failed to approve join request:', error);
                alert('Could not approve that request.');
            });
        });
        actions.appendChild(approveBtn);

        const denyBtn = document.createElement('button');
        denyBtn.type = 'button';
        denyBtn.classList.add('groupSettingsDenyBtn');
        denyBtn.textContent = 'Deny';
        denyBtn.addEventListener('click', () => {
            playClickSound();
            denyJoinRequest(groupSettingsGroupId, request.uid).catch((error) => {
                console.error('Failed to deny join request:', error);
                alert('Could not deny that request.');
            });
        });
        actions.appendChild(denyBtn);

        row.appendChild(actions);
        list.appendChild(row);
    });
}

function openGroupSettingsModal(group) {
    if (!currentUser) {
        return;
    }
    initializeGroupSettingsModal();

    groupSettingsGroupId = group.id;
    const { isOwner } = getMyRoleInGroup(group);

    const privacySelect = groupSettingsOverlay.querySelector('.groupSettingsPrivacySelect');
    privacySelect.value = group.privacy || 'open';
    privacySelect.disabled = !isOwner;
    groupSettingsOverlay.querySelector('.groupSettingsPrivacyNote').classList.toggle('hidden', isOwner);

    // Join requests are already loaded live by ensureJoinRequestsSubscription
    // (started whenever an owner/admin has a group selected, not just while
    // this modal happens to be open) - just render whatever's already there
    // instead of opening a second, redundant subscription.
    renderPendingJoinRequests(groupJoinRequests);

    groupSettingsOverlay.classList.add('open');
}

function closeGroupSettingsModal() {
    if (!groupSettingsOverlay) {
        return;
    }
    groupSettingsOverlay.classList.remove('open');
    groupSettingsGroupId = null;
}

groupSettingsBtn?.addEventListener('click', () => {
    const group = getSelectedGroup();
    if (group) {
        playClickSound();
        openGroupSettingsModal(group);
    }
});

function renderGroupMemberScopeTabs(group) {
    if (!groupMemberScopeTabs) {
        return;
    }

    const memberIds = group.memberIds || [];
    // With only yourself in the group, this row is just "Everyone"/"Me" -
    // two ways of saying the same thing. Hidden until a 2nd member makes
    // the choice meaningful; reappears on its own the moment they join,
    // since renderApp() re-runs on every membership change already.
    const soloGroup = memberIds.length <= 1;
    whoseTasksLabel?.classList.toggle('hidden', soloGroup);
    groupMemberScopeTabs.classList.toggle('hidden', soloGroup);

    if (soloGroup) {
        groupMemberScopeTabs.innerHTML = '';
        // Correct the state directly rather than calling setActiveMemberScope()
        // (which would call back into this function and re-render the roster/
        // history/tasks a second time) - every caller of renderGroupMemberScopeTabs
        // already re-renders those right after, so this just needs the shared
        // state fixed up before that happens.
        activeMemberScope = 'all';
        return;
    }

    groupMemberScopeTabs.innerHTML = '';
    const memberNames = group.memberNames || [];

    // Avatar chips (section E): a small circular initial avatar plus name,
    // instead of plain text pills identical in shape to the deadline-filter
    // row right below it (Law of Similarity - two visually-identical rows
    // currently read as one longer list). "Everyone" gets a person-group
    // icon in the same avatar slot rather than a single-letter initial,
    // since it represents a set of members, not one.
    const makeTab = (scope, label, avatarContent) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.classList.add('taskViewBtn', 'groupScopeTabBtn');
        if (activeMemberScope === scope) {
            btn.classList.add('active');
        }

        const avatar = document.createElement('span');
        avatar.classList.add('scopeTabAvatar');
        avatar.setAttribute('aria-hidden', 'true');
        avatar.innerHTML = avatarContent;
        btn.appendChild(avatar);

        const text = document.createElement('span');
        text.textContent = label;
        btn.appendChild(text);

        btn.addEventListener('click', () => {
            playClickSound();
            setActiveMemberScope(scope);
        });
        groupMemberScopeTabs.appendChild(btn);
    };

    makeTab('all', 'Everyone', '<i class="fa-solid fa-people-group"></i>');

    memberIds.forEach((memberId, index) => {
        const isYou = memberId === currentUser?.uid;
        const label = isYou ? 'Me' : resolveMemberName(memberId, memberNames[index], groupTasks);
        const initial = (label || '?').trim().charAt(0).toUpperCase() || '?';
        makeTab(memberId, label, initial);
    });
}

function renderGroupTasks() {
    if (!groupTasksList) {
        return;
    }

    const group = getSelectedGroup();
    groupTasksList.innerHTML = '';

    if (!group || groupTasks.length === 0) {
        const emptyMsg = document.createElement('li');
        emptyMsg.classList.add('emptyTasksMsg');
        emptyMsg.textContent = 'No tasks yet. Add one above to get the team started.';
        groupTasksList.appendChild(emptyMsg);
        return;
    }

    const visible = getVisibleGroupTasks();
    if (visible.length === 0) {
        const emptyMsg = document.createElement('li');
        emptyMsg.classList.add('emptyTasksMsg');
        emptyMsg.textContent = 'Nothing in this view right now.';
        groupTasksList.appendChild(emptyMsg);
        return;
    }

    const sorted = [...visible].sort(compareGroupTasksByPriority);

    sorted.forEach((task) => {
        const isOwner = currentUser && task.ownerId === currentUser.uid;
        groupTasksList.appendChild(createGroupTaskItem(group.id, task, isOwner));
    });
}

// ---------------------------------------------------------------------
// Member roster
// ---------------------------------------------------------------------

// A denied moderation write (promote/demote, kick) is almost always this
// project's firestore.rules having the right logic locally but not yet
// being *published* to the Firebase console - the same class of gap that
// bit "Recently finished" and comments early on. Naming that directly
// beats the raw Firestore "Missing or insufficient permissions." message,
// which reads like the person just isn't allowed to do this at all.
function describeGroupWriteError(error, fallback) {
    return error?.code === 'permission-denied'
        ? 'That action needs the latest security rules published to the Firebase console first.'
        : (error.message || fallback);
}

function renderMemberRoster(group, { isOwner = false, isAdmin = false } = {}) {
    if (!memberRoster) {
        return;
    }
    memberRoster.innerHTML = '';

    const memberIds = group.memberIds || [];
    const memberNames = group.memberNames || [];
    const adminIds = group.adminIds || [];

    // A lone "You" card with nothing to compare against doesn't say WHY -
    // point at the invite code already on the page rather than just
    // leaving it as an unexplained roster of one.
    memberRosterInviteHint?.classList.toggle('hidden', memberIds.length > 1);

    const cards = memberIds.map((memberId, index) => {
        const memberTasks = groupTasks.filter((task) => task.ownerId === memberId);
        const doneCount = memberTasks.filter((task) => task.completed).length;
        const total = memberTasks.length;
        const percent = total > 0 ? Math.round((doneCount / total) * 100) : 0;

        const activeTasks = memberTasks.filter((task) => !task.completed);
        const focusTask = activeTasks.length > 0
            ? [...activeTasks].sort(compareGroupTasksByPriority)[0]
            : null;
        // Same overdue check updateGroupUrgencyAlert() already uses for the
        // team-wide banner - here it's per-member, so a teammate who's
        // fallen behind is visible right from the roster, not just once
        // you're already looking at their tasks.
        const hasOverdue = activeTasks.some((task) => getDeadlineStatus(task.dueAt).urgencyLevel === 'overdue');

        const role = memberId === group.ownerId ? 'owner' : (adminIds.includes(memberId) ? 'admin' : 'member');

        return {
            memberId,
            name: resolveMemberName(memberId, memberNames[index], groupTasks),
            total,
            doneCount,
            percent,
            focusText: focusTask ? focusTask.text : null,
            hasOverdue,
            role
        };
    });

    cards.sort((a, b) => b.percent - a.percent);

    cards.forEach((card) => {
        // A <div> (not <button>) since it needs to hold a real nested
        // "Suggest a task" button for teammates - buttons can't nest.
        const memberCard = document.createElement('div');
        memberCard.setAttribute('role', 'button');
        memberCard.tabIndex = 0;
        memberCard.classList.add('memberCard');
        if (card.memberId === currentUser?.uid) {
            memberCard.classList.add('isYou');
        }
        if (activeMemberScope === card.memberId) {
            memberCard.classList.add('active');
        }
        memberCard.title = `Show only ${card.memberId === currentUser?.uid ? 'your' : card.name + '’s'} tasks`;
        memberCard.addEventListener('click', () => {
            playClickSound();
            setActiveMemberScope(card.memberId);
        });
        memberCard.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                playClickSound();
                setActiveMemberScope(card.memberId);
            }
        });

        const name = document.createElement('p');
        name.classList.add('memberCardName');
        name.textContent = card.memberId === currentUser?.uid ? `${card.name} (You)` : card.name;
        if (card.role !== 'member') {
            const roleBadge = document.createElement('span');
            roleBadge.classList.add('memberCardRoleBadge', `role-${card.role}`);
            roleBadge.textContent = card.role === 'owner' ? 'Owner' : 'Admin';
            name.appendChild(roleBadge);
        }
        if (card.hasOverdue) {
            const overdueFlag = document.createElement('i');
            overdueFlag.classList.add('fa-solid', 'fa-triangle-exclamation', 'memberCardOverdueFlag');
            overdueFlag.title = 'Has an overdue task';
            overdueFlag.setAttribute('aria-label', 'Has an overdue task');
            name.appendChild(overdueFlag);
        }
        memberCard.appendChild(name);

        const progressText = document.createElement('p');
        progressText.classList.add('memberCardProgress');
        progressText.textContent = card.total > 0 ? `${card.doneCount}/${card.total} done` : 'No tasks yet';
        memberCard.appendChild(progressText);

        const progressBarOuter = document.createElement('div');
        progressBarOuter.classList.add('memberProgressBarOuter');
        const progressBarInner = document.createElement('div');
        progressBarInner.classList.add('memberProgressBarInner');
        progressBarInner.style.width = `${card.percent}%`;
        progressBarOuter.appendChild(progressBarInner);
        memberCard.appendChild(progressBarOuter);

        if (card.focusText) {
            const focusLine = document.createElement('p');
            focusLine.classList.add('memberCardFocus');
            const focusLabel = document.createElement('span');
            focusLabel.classList.add('memberCardFocusLabel');
            focusLabel.textContent = 'Focus:';
            focusLine.appendChild(focusLabel);
            focusLine.appendChild(document.createTextNode(` ${card.focusText}`));
            memberCard.appendChild(focusLine);
        }

        // Suggest a task no longer lives here - Team is roster-only now
        // (progress, role, kick/promote). Suggesting for someone is
        // contextual to the Tasks tab instead, shown once their "whose
        // tasks" scope is actually selected there (see
        // renderSuggestForMemberBanner) - clicking this card still switches
        // that scope (below), it just doesn't also carry its own action.

        // Moderation controls - never on your own card or the owner's.
        // Kick: owner can remove anyone; an admin can only remove a plain
        // member (never another admin). Promote/demote: owner-only, per the
        // co-leader-style hierarchy (admins can't create more admins).
        const canManage = (isOwner || isAdmin) && card.memberId !== currentUser?.uid && card.role !== 'owner';
        const canKick = canManage && (isOwner || card.role !== 'admin');
        const canChangeRole = isOwner && card.memberId !== currentUser?.uid && card.role !== 'owner';

        if (canKick || canChangeRole) {
            const actions = document.createElement('div');
            actions.classList.add('memberCardModActions');

            if (canChangeRole) {
                const roleBtn = document.createElement('button');
                roleBtn.type = 'button';
                roleBtn.classList.add('memberCardRoleBtn');
                roleBtn.textContent = card.role === 'admin' ? 'Remove admin' : 'Make admin';
                roleBtn.addEventListener('click', async (event) => {
                    event.stopPropagation();
                    playClickSound();
                    try {
                        await setMemberRole(group.id, card.memberId, card.role !== 'admin');
                    } catch (error) {
                        alert(describeGroupWriteError(error, 'Could not update their role.'));
                    }
                });
                actions.appendChild(roleBtn);
            }

            if (canKick) {
                const kickBtn = document.createElement('button');
                kickBtn.type = 'button';
                kickBtn.classList.add('memberCardKickBtn');
                kickBtn.innerHTML = '<i class="fa-solid fa-user-slash"></i> Kick';
                kickBtn.addEventListener('click', async (event) => {
                    event.stopPropagation();
                    playClickSound();
                    if (!confirm(`Remove ${card.name} from the group?`)) {
                        return;
                    }
                    try {
                        await kickMember(group.id, currentUser, card.memberId);
                    } catch (error) {
                        alert(describeGroupWriteError(error, 'Could not remove them.'));
                    }
                });
                actions.appendChild(kickBtn);
            }

            memberCard.appendChild(actions);
        }

        memberRoster.appendChild(memberCard);
    });
}

// ---------------------------------------------------------------------
// Leaderboard - a ranked "who's gotten the most done" view, Clash-of-Clans-
// style (crown for #1, medal colors for #2/#3, plain numbered badge from
// #4 on). Three ranges, from two different sources chosen so neither
// silently under- or over-counts:
//   - "This week"/"This month": counted from groupHistoryEntries (the
//     permanent history log, capped at 50 most-recent across the whole
//     group) for week, since 50 is plenty for a week's worth of completions
//     in practice; "This month" instead counts from currently-completed
//     groupTasks (like "All time" below) since a month's worth could
//     realistically blow past that 50-entry cap and silently undercount.
//   - "All time": counted from currently-completed groupTasks. Not capped,
//     but only reflects tasks that still exist - one that's since been
//     deleted no longer counts.
// Both "week" and "month" are calendar-based (the week starting Monday, the
// month starting on the 1st) rather than a rolling 7/30-day window, so the
// board actually resets at the start of a new week/month instead of just
// slowly sliding - see the day-boundary check in startGroupRealtimeUpdates,
// which re-renders this once the calendar day itself changes even with no
// new completions to otherwise trigger a render.
function getStartOfCalendarWeek(date) {
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const day = start.getDay(); // 0 = Sunday, 1 = Monday, ... 6 = Saturday
    const daysSinceMonday = day === 0 ? 6 : day - 1;
    start.setDate(start.getDate() - daysSinceMonday);
    return start;
}

function getStartOfCalendarMonth(date) {
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    start.setDate(1);
    return start;
}

const LEADERBOARD_RANGE_LABELS = { week: 'this week', month: 'this month', all: 'all time' };
const LEADERBOARD_ORDINALS = { 1: '1st', 2: '2nd', 3: '3rd' };

// Same {memberId -> completed task list} lookup the leaderboard's own
// counts are built from, reused by the click-through member modal below so
// the list it shows always matches the number next to that member's name.
function getMemberCompletedEntriesForRange(memberId, range) {
    if (range === 'week') {
        const weekStart = getStartOfCalendarWeek(new Date()).getTime();
        return groupHistoryEntries
            .filter((entry) => entry.ownerId === memberId)
            .map((entry) => ({ text: entry.taskText, completedAt: entry.completedAt }))
            .filter((entry) => {
                const completedAtMs = new Date(entry.completedAt).getTime();
                return !Number.isNaN(completedAtMs) && completedAtMs >= weekStart;
            });
    }

    const monthStart = range === 'month' ? getStartOfCalendarMonth(new Date()).getTime() : null;
    return groupTasks
        .filter((task) => task.ownerId === memberId && task.completed && task.completedAt)
        .map((task) => ({ text: task.text, completedAt: task.completedAt }))
        .filter((entry) => {
            if (monthStart === null) {
                return true;
            }
            const completedAtMs = new Date(entry.completedAt).getTime();
            return !Number.isNaN(completedAtMs) && completedAtMs >= monthStart;
        })
        .sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime());
}

function renderGroupLeaderboard(group) {
    if (!leaderboardList) {
        return;
    }

    const memberIds = group.memberIds || [];
    const memberNames = group.memberNames || [];

    // A solo group with no history yet has nothing a leaderboard can show -
    // the full title/tabs/list chrome around an empty ranking just reads as
    // broken. Collapse to one muted line (keeping the title, so the panel
    // doesn't look outright empty) until either a teammate joins or a first
    // completion is logged - whichever happens first flips this back to the
    // real panel, live, next render.
    const soloNoHistory = memberIds.length <= 1 && groupHistoryEntries.length === 0;
    leaderboardTabsEl?.classList.toggle('hidden', soloNoHistory);
    leaderboardList.classList.toggle('hidden', soloNoHistory);
    leaderboardTeaser?.classList.toggle('hidden', !soloNoHistory);
    if (soloNoHistory) {
        return;
    }

    const counts = new Map(memberIds.map((memberId) => [memberId, 0]));

    memberIds.forEach((memberId) => {
        counts.set(memberId, getMemberCompletedEntriesForRange(memberId, leaderboardRange).length);
    });

    const rows = memberIds.map((memberId, index) => ({
        memberId,
        name: resolveMemberName(memberId, memberNames[index], groupTasks),
        count: counts.get(memberId) || 0
    }));

    rows.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    leaderboardList.innerHTML = '';

    if (rows.length === 0 || rows.every((row) => row.count === 0)) {
        const empty = document.createElement('li');
        empty.classList.add('leaderboardEmpty');
        empty.textContent = leaderboardRange === 'all'
            ? 'Nobody has finished a task yet.'
            : `Finish a task to put your name here - or switch to "All time" to see further back.`;
        leaderboardList.appendChild(empty);
        return;
    }

    rows.forEach((row, index) => {
        const rank = index + 1;

        const item = document.createElement('li');
        item.classList.add('leaderboardRow');
        if (row.memberId === currentUser?.uid) {
            item.classList.add('isYou');
        }
        item.setAttribute('role', 'button');
        item.tabIndex = 0;
        item.title = `See ${row.memberId === currentUser?.uid ? 'your' : row.name + '’s'} completed tasks (${LEADERBOARD_RANGE_LABELS[leaderboardRange]})`;

        const rankBadge = document.createElement('span');
        rankBadge.classList.add('leaderboardRank');
        if (rank <= 3) {
            // Top 3 get a gold/silver/bronze pill with an icon AND the
            // ordinal itself ("1st"/"2nd"/"3rd") - the icon alone read as
            // an unlabeled decoration rather than an actual rank.
            rankBadge.classList.add(`rank-${rank}`);
            const icon = document.createElement('i');
            icon.classList.add('fa-solid', rank === 1 ? 'fa-crown' : 'fa-medal');
            rankBadge.appendChild(icon);
            rankBadge.appendChild(document.createTextNode(LEADERBOARD_ORDINALS[rank]));
        } else {
            rankBadge.textContent = String(rank);
        }
        item.appendChild(rankBadge);

        const name = document.createElement('span');
        name.classList.add('leaderboardName');
        name.textContent = row.memberId === currentUser?.uid ? `${row.name} (You)` : row.name;
        item.appendChild(name);

        const count = document.createElement('span');
        count.classList.add('leaderboardCount');
        count.textContent = row.count === 1 ? '1 task' : `${row.count} tasks`;
        item.appendChild(count);

        const openMember = () => {
            playClickSound();
            openLeaderboardMemberModal(row.memberId, row.name);
        };
        item.addEventListener('click', openMember);
        item.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openMember();
            }
        });

        leaderboardList.appendChild(item);
    });
}

leaderboardTabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
        if (btn.dataset.range === leaderboardRange) {
            return;
        }
        playClickSound();
        leaderboardRange = btn.dataset.range;
        leaderboardTabBtns.forEach((tabBtn) => tabBtn.classList.toggle('active', tabBtn === btn));
        const group = getSelectedGroup();
        if (group) {
            renderGroupLeaderboard(group);
        }
    });
});

// ---------------------------------------------------------------------
// Leaderboard member modal - clicking a row shows that member's own
// completed-task list for whichever range is currently selected above.
// ---------------------------------------------------------------------

function openLeaderboardMemberModal(memberId, memberName) {
    if (!leaderboardMemberOverlay) {
        return;
    }

    if (leaderboardMemberModalTitle) {
        const whose = memberId === currentUser?.uid ? 'Your' : `${memberName}'s`;
        leaderboardMemberModalTitle.textContent = `${whose} completed tasks (${LEADERBOARD_RANGE_LABELS[leaderboardRange]})`;
    }

    renderLeaderboardMemberList(memberId);

    leaderboardMemberOverlay.classList.remove('hidden');
    leaderboardMemberOverlay.setAttribute('aria-hidden', 'false');
}

function closeLeaderboardMemberModal() {
    if (!leaderboardMemberOverlay) {
        return;
    }
    leaderboardMemberOverlay.classList.add('hidden');
    leaderboardMemberOverlay.setAttribute('aria-hidden', 'true');
}

function renderLeaderboardMemberList(memberId) {
    if (!leaderboardMemberList) {
        return;
    }
    leaderboardMemberList.innerHTML = '';

    const entries = getMemberCompletedEntriesForRange(memberId, leaderboardRange);

    if (entries.length === 0) {
        const empty = document.createElement('p');
        empty.classList.add('leaderboardMemberEmpty');
        empty.textContent = `Nothing completed ${LEADERBOARD_RANGE_LABELS[leaderboardRange]} yet.`;
        leaderboardMemberList.appendChild(empty);
        return;
    }

    entries.forEach((entry) => {
        const item = document.createElement('div');
        item.classList.add('leaderboardMemberItem');

        const text = document.createElement('p');
        text.classList.add('leaderboardMemberItemText');
        text.textContent = entry.text;
        item.appendChild(text);

        const meta = document.createElement('p');
        meta.classList.add('leaderboardMemberItemMeta');
        meta.textContent = formatFriendlyDateTime(new Date(entry.completedAt));
        item.appendChild(meta);

        leaderboardMemberList.appendChild(item);
    });
}

leaderboardMemberCloseBtn?.addEventListener('click', () => {
    playClickSound();
    closeLeaderboardMemberModal();
});

leaderboardMemberOverlay?.addEventListener('click', (event) => {
    if (event.target === leaderboardMemberOverlay) {
        closeLeaderboardMemberModal();
    }
});

// Always-on (not modal-scoped) subscription to pending join requests, so
// the Group Settings button can carry a live count badge instead of only
// revealing what's pending once you open it - see groupSettingsCountBadge
// below. Only an owner/admin can actually run this query per
// firestore.rules, so it's gated on that; idempotent against
// joinRequestsSubscriptionKey so calling it every renderApp() (needed since
// a role change - e.g. just got promoted - doesn't necessarily come with a
// group switch) is a cheap no-op once already subscribed to the right
// group.
function ensureJoinRequestsSubscription(group, canSeeJoinRequests) {
    const desiredKey = (group && canSeeJoinRequests) ? group.id : null;
    if (desiredKey === joinRequestsSubscriptionKey) {
        return;
    }
    if (unsubscribeJoinRequests) {
        unsubscribeJoinRequests();
        unsubscribeJoinRequests = null;
    }
    groupJoinRequests = [];
    joinRequestsSubscriptionKey = desiredKey;
    if (!desiredKey) {
        return;
    }
    unsubscribeJoinRequests = subscribeToJoinRequests(group.id, (requests) => {
        groupJoinRequests = requests;
        renderApp();
    }, (error) => {
        console.error('Failed to load join requests:', error);
        groupJoinRequests = [];
        renderApp();
    });
}

function updateGroupSettingsBadge() {
    if (!groupSettingsCountBadge) {
        return;
    }
    const count = groupJoinRequests.length;
    groupSettingsCountBadge.textContent = count > 9 ? '9+' : String(count);
    groupSettingsCountBadge.classList.toggle('visible', count > 0);
}

// ---------------------------------------------------------------------
// Top-level render orchestration
// ---------------------------------------------------------------------

function renderApp() {
    if (!currentUser) {
        groupStatusMsg?.classList.add('hidden');
        groupPageWrap?.classList.add('hidden');
        return;
    }

    if (groups === undefined) {
        if (groupStatusMsg) {
            groupStatusMsg.textContent = 'Loading your groups...';
            groupStatusMsg.classList.remove('hidden');
        }
        groupPageWrap?.classList.add('hidden');
        return;
    }

    groupStatusMsg?.classList.add('hidden');
    groupPageWrap?.classList.remove('hidden');

    const shouldShowSetup = showSetup || groups.length === 0;
    groupSetupSection?.classList.toggle('hidden', !shouldShowSetup);
    groupBrowseAllLink?.classList.toggle('hidden', groups.length === 0);

    const group = getSelectedGroup();
    const shouldShowDashboard = !shouldShowSetup && Boolean(group);
    groupDashboard?.classList.toggle('hidden', !shouldShowDashboard);
    // Nothing for the group tour to point at (roster, whose-tasks tabs,
    // etc. all live inside the dashboard) until a group is actually
    // selected - hide the restart button rather than leaving it to open a
    // tour with no valid targets.
    helpTourBtn?.classList.toggle('hidden', !shouldShowDashboard);
    // Same reasoning - nothing for Brain Dump to add tasks to without a
    // selected group.
    brainDumpToggleBtn?.classList.toggle('hidden', !shouldShowDashboard);
    // Same reasoning - alerts are scoped to the currently selected group's
    // tasks, so there's nothing to toggle without one selected.
    groupAlertToggleBtn?.classList.toggle('hidden', !shouldShowDashboard);
    if (shouldShowDashboard) {
        updateGroupAlertToggleButton();
    }

    // The big page title shows the selected group's name once you're
    // looking at one, and falls back to "Group" anywhere else (switcher,
    // create/join screen) so it's never blank.
    if (pageTitleEl) {
        pageTitleEl.textContent = (shouldShowDashboard && group) ? group.name : 'Group';
    }

    if (shouldShowDashboard && group) {
        if (groupInviteCode) {
            groupInviteCode.textContent = group.inviteCode || group.id;
        }
        const { isOwner, isAdmin } = getMyRoleInGroup(group);
        // The owner can leave too now (ownership transfers to a remaining
        // member - see leaveGroup) - only actually blocked, client-side in
        // the click handler below, when they're the group's only member.
        groupLeaveBtn?.classList.remove('hidden');
        groupDeleteBtn?.classList.toggle('hidden', !isOwner);
        groupRenameBtn?.classList.toggle('hidden', !isOwner);
        groupSettingsBtn?.classList.toggle('hidden', !(isOwner || isAdmin));
        // Re-evaluated every render (not just on group switch) so a role
        // change alone - e.g. you just got promoted to admin - starts the
        // subscription without needing a reload; the idempotency check
        // inside makes this a no-op once nothing's actually changed.
        ensureJoinRequestsSubscription(group, isOwner || isAdmin);
        updateGroupSettingsBadge();
        if (groupSettingsOverlay?.classList.contains('open') && groupSettingsGroupId === group.id) {
            // Keep an already-open Settings modal live too, not just the
            // badge - e.g. approving one request updates the remaining list
            // immediately instead of only on next open.
            renderPendingJoinRequests(groupJoinRequests);
        }
        renderGroupMemberScopeTabs(group);
        renderMemberRoster(group, { isOwner, isAdmin });
        renderGroupLeaderboard(group);
        renderGroupHistory(group);
        renderSuggestForMemberBanner(group);
        renderSuggestionsForYou(group.id);
        renderGroupTasks();
        // The 6-button deadline-filter row isn't worth much with barely any
        // tasks to filter - condense it down to just All/Overdue (Overdue
        // stays regardless of count, since it's meaningful even at 1 task
        // and updateGroupUrgencyAlert already surfaces it independently)
        // until there's enough to actually filter through.
        deadlineViewTabs?.classList.toggle('condensed', groupTasks.length < 3);
        updateGroupMotivator();
        updateGroupUrgencyAlert();
        updateNavAttentionBadge(group);
        renderGroupOnboardingHint();
        maybeAutoStartGroupTour();
    } else {
        ensureJoinRequestsSubscription(null, false);
        updateNavAttentionBadge(null);
    }
}

// Your own progress in this group specifically - pairs with the personal
// reward celebration above (both scoped to "you", not the whole team; the
// roster below already shows everyone's comparative progress).
function updateGroupMotivator() {
    if (!currentUser || !motivatorText || !progressBar || !taskAmountText) {
        return;
    }

    const myTasksHere = groupTasks.filter((task) => task.ownerId === currentUser.uid);
    const totalTasks = myTasksHere.length;
    const completedTasks = myTasksHere.filter((task) => task.completed).length;

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

// A single glanceable "does anything need me" number, aggregating the
// group's other notification surfaces (unread comments, pending join
// requests, suggestions waiting on you) into one place - all three are
// already-computed/cheap over already-loaded data, no new subscriptions.
// Deliberately scoped to the CURRENTLY SELECTED group only, not a total
// across every group you're in - that would mean subscribing to every
// group's data at once, out of scope here.
function computeAttentionSummary() {
    const unreadCommentsCount = groupTasks.filter(hasUnreadComments).length;
    const joinRequestsCount = groupJoinRequests.length; // already role-gated by ensureJoinRequestsSubscription
    const suggestionsCount = getPendingSuggestionsForYou().length;
    return {
        unreadCommentsCount,
        joinRequestsCount,
        suggestionsCount,
        total: unreadCommentsCount + joinRequestsCount + suggestionsCount
    };
}

function updateNavAttentionBadge(group) {
    if (!navAttentionBadge || !navAttentionCount) {
        return;
    }
    if (!group) {
        navAttentionBadge.classList.remove('visible');
        return;
    }
    const summary = computeAttentionSummary();
    navAttentionCount.textContent = summary.total > 9 ? '9+' : String(summary.total);
    navAttentionBadge.classList.toggle('visible', summary.total > 0);
    navAttentionBadge.title = summary.total === 0 ? '' : [
        summary.unreadCommentsCount && `${summary.unreadCommentsCount} unread comment${summary.unreadCommentsCount === 1 ? '' : 's'}`,
        summary.joinRequestsCount && `${summary.joinRequestsCount} pending join request${summary.joinRequestsCount === 1 ? '' : 's'}`,
        summary.suggestionsCount && `${summary.suggestionsCount} suggestion${summary.suggestionsCount === 1 ? '' : 's'} for you`
    ].filter(Boolean).join(', ');
}

// Team-wide version of solo's updateUrgencyAlert() - scoped to every
// member's tasks in the group (not just yours), since the point is
// visibility into the whole team's deadline pressure, not just your own.
function updateGroupUrgencyAlert() {
    if (!groupUrgencyAlert || !groupUrgencyAlertText) {
        return;
    }

    const activeTasks = groupTasks.filter((task) => !task.completed);
    const rankedByUrgency = activeTasks
        .map((task) => ({ task, status: getDeadlineStatus(task.dueAt) }))
        .filter((entry) => entry.status.hasDeadline)
        .sort((entryA, entryB) => entryA.status.deadlineTimestamp - entryB.status.deadlineTimestamp);
    const overdueCount = rankedByUrgency.filter((entry) => entry.status.urgencyLevel === 'overdue').length;

    if (overdueViewButton && overdueCountBadge) {
        overdueCountBadge.textContent = String(overdueCount);
        overdueCountBadge.classList.toggle('visible', overdueCount > 0);
        overdueViewButton.classList.toggle('has-overdue', overdueCount > 0);
    }

    groupUrgencyAlert.classList.remove('hidden', 'urgency-soon', 'urgency-critical', 'urgency-overdue');

    if (rankedByUrgency.length === 0 || rankedByUrgency[0].status.urgencyLevel === 'normal') {
        groupUrgencyAlert.classList.add('hidden');
        return;
    }

    const top = rankedByUrgency[0];
    groupUrgencyAlert.classList.add(`urgency-${top.status.urgencyLevel}`);

    if (top.status.urgencyLevel === 'overdue') {
        groupUrgencyAlertText.textContent = overdueCount === 1
            ? '1 task across the group is overdue.'
            : `${overdueCount} tasks across the group are overdue.`;
    } else {
        const ownerLabel = top.task.ownerId === currentUser?.uid ? 'you' : (top.task.ownerName || 'a teammate');
        const soonLabel = top.status.urgencyLevel === 'critical' ? 'Due very soon' : 'Due soon';
        groupUrgencyAlertText.textContent = `${soonLabel}: ${top.task.text} (${ownerLabel}, ${top.status.countdownLabel}).`;
    }
}

function loadGroupSettings() {
    try {
        const saved = localStorage.getItem(GROUP_SETTINGS_KEY);
        const parsed = saved ? JSON.parse(saved) : null;
        groupPopupAlertsEnabled = Boolean(parsed?.popupAlertsEnabled);
    } catch {
        groupPopupAlertsEnabled = false;
    }
    if (!('Notification' in window) || Notification.permission !== 'granted') {
        groupPopupAlertsEnabled = false;
    }
    updateGroupAlertToggleButton();
}

function saveGroupSettings() {
    try {
        localStorage.setItem(GROUP_SETTINGS_KEY, JSON.stringify({ popupAlertsEnabled: groupPopupAlertsEnabled }));
    } catch {
        // localStorage unavailable - non-fatal, just won't persist across reloads.
    }
}

function updateGroupAlertToggleButton() {
    if (!groupAlertToggleBtn) {
        return;
    }
    if (!('Notification' in window)) {
        groupAlertToggleBtn.textContent = 'Popup alerts: Unsupported';
        groupAlertToggleBtn.classList.remove('enabled');
        groupAlertToggleBtn.disabled = true;
        return;
    }
    groupAlertToggleBtn.disabled = false;
    groupAlertToggleBtn.classList.toggle('enabled', groupPopupAlertsEnabled);
    groupAlertToggleBtn.textContent = groupPopupAlertsEnabled ? 'Popup alerts: On' : 'Popup alerts: Off';
}

function onToggleGroupPopupAlerts() {
    playClickSound();

    if (!('Notification' in window)) {
        groupPopupAlertsEnabled = false;
        updateGroupAlertToggleButton();
        saveGroupSettings();
        return;
    }

    if (!groupPopupAlertsEnabled) {
        if (Notification.permission === 'granted') {
            groupPopupAlertsEnabled = true;
            updateGroupAlertToggleButton();
            saveGroupSettings();
            return;
        }

        Notification.requestPermission().then((permission) => {
            groupPopupAlertsEnabled = permission === 'granted';
            updateGroupAlertToggleButton();
            saveGroupSettings();
        });
        return;
    }

    groupPopupAlertsEnabled = false;
    updateGroupAlertToggleButton();
    saveGroupSettings();
}

if (groupAlertToggleBtn) {
    groupAlertToggleBtn.addEventListener('click', onToggleGroupPopupAlerts);
}

function getGroupUrgencyRank(urgencyLevel) {
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

function isNotifiableGroupUrgency(task, status) {
    return Boolean(status.hasDeadline && !task.completed && getGroupUrgencyRank(status.urgencyLevel) > 0);
}

function pruneGroupStageReminderTimestamps(now = Date.now()) {
    const maxAgeMs = 3 * 24 * 60 * 60 * 1000;
    for (const [key, timestamp] of groupStageReminderTimestamps.entries()) {
        if (now - timestamp > maxAgeMs) {
            groupStageReminderTimestamps.delete(key);
        }
    }
}

// Scans YOUR OWN tasks in the currently selected group (not the whole
// team's - see the state block near the top of this file) for the single
// most urgent one and fires at most one desktop notification per tick, per
// the same stage/global cooldown rules solo uses. Only ever covers the
// selected group, since that's the only one this page keeps live task data
// for - switching groups naturally starts covering the new one instead.
function maybeNotifyGroupTaskUrgency() {
    if (!groupPopupAlertsEnabled || !('Notification' in window) || Notification.permission !== 'granted' || !currentUser) {
        return;
    }

    let notificationCandidate = null;
    groupTasks.forEach((task) => {
        if (task.ownerId !== currentUser.uid) {
            return;
        }
        const status = getTaskUrgencyStatus(task);
        if (!isNotifiableGroupUrgency(task, status)) {
            return;
        }
        if (!notificationCandidate) {
            notificationCandidate = { task, status };
            return;
        }
        const currentRank = getGroupUrgencyRank(status.urgencyLevel);
        const candidateRank = getGroupUrgencyRank(notificationCandidate.status.urgencyLevel);
        if (currentRank > candidateRank
            || (currentRank === candidateRank && status.deadlineTimestamp < notificationCandidate.status.deadlineTimestamp)) {
            notificationCandidate = { task, status };
        }
    });

    if (!notificationCandidate) {
        return;
    }

    const { task, status } = notificationCandidate;
    const stage = status.urgencyLevel;
    const now = Date.now();
    const stageCooldown = GROUP_REMINDER_COOLDOWN_MS[stage] || GROUP_REMINDER_COOLDOWN_MS.soon;
    const notifyKey = `${task.id}|${task.dueAt || ''}|${stage}`;
    const lastStageReminderAt = groupStageReminderTimestamps.get(notifyKey) || 0;

    if (lastStageReminderAt > 0 && now - lastStageReminderAt < stageCooldown) {
        return;
    }
    if (now - groupLastGlobalReminderAt < GROUP_GLOBAL_REMINDER_GAP_MS) {
        return;
    }

    groupStageReminderTimestamps.set(notifyKey, now);
    groupLastGlobalReminderAt = now;
    pruneGroupStageReminderTimestamps(now);

    const group = getSelectedGroup();
    const title = stage === 'overdue'
        ? 'Reminder: group task overdue'
        : stage === 'critical'
            ? 'Reminder: group task due very soon'
            : 'Reminder: group task due soon';
    const groupLabel = group ? ` in ${group.name}` : '';
    const body = `${task.text}${groupLabel} • ${status.countdownLabel}`;
    new Notification(title, { body, silent: false });
}

// Keeps the per-task countdown badges and the urgency banner above ticking
// together. Unlike solo (script.js's refreshDeadlineBadges + a 1s interval),
// group.js only ever redrew badges as a side effect of renderGroupTasks() -
// called from plenty of places (expanding subtasks/comments, switching a
// view or member-scope tab) that have nothing to do with deadlines. Each of
// those happened to refresh individual badges but never updateGroupUrgencyAlert(),
// so the banner could sit on a stale "12m" while a task's own badge had
// already ticked down to "3m". This interval refreshes both together, every
// second, regardless of what else triggers a render.
// Live-ticks each visible step's own deadline badge the same way the
// task-level ones already tick - matched by data-subtask-id rather than
// DOM position, so it stays correct even if a subtask row's order in the
// array has shifted since the last full render. Mirrors solo's identical
// helper in script.js.
function refreshSubtaskDeadlineBadges(taskItem, task) {
    const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];
    taskItem.querySelectorAll('.subtaskItem').forEach((row) => {
        const subtask = subtasks.find((item) => item.id === row.dataset.subtaskId);
        const badge = row.querySelector('.subtaskDeadlineBadge');
        if (!subtask || !badge) {
            return;
        }
        if (!subtask.dueAt) {
            badge.classList.add('hidden');
            return;
        }
        const status = getDeadlineStatus(subtask.dueAt);
        badge.classList.remove('hidden', 'deadline-none', 'deadline-normal', 'deadline-soon', 'deadline-critical', 'deadline-overdue');
        badge.classList.add(status.deadlineClassName);
        badge.textContent = status.deadlineLabel.replace(/^Due /, '');
        badge.title = status.countdownLabel;
    });
}

function refreshGroupDeadlineBadges() {
    if (!groupTasksList) {
        return;
    }

    groupTasksList.querySelectorAll('li[data-task-id]').forEach((taskItem) => {
        const task = groupTasks.find((candidate) => candidate.id === taskItem.dataset.taskId);
        if (!task) {
            return;
        }

        const deadlineBadge = taskItem.querySelector('.deadlineBadge');
        const countdownBadge = taskItem.querySelector('.countdownBadge');
        if (!deadlineBadge || !countdownBadge) {
            return;
        }

        // .deadlineBadge stays on the task's own literal due date; the
        // countdown badge and the row's status-* class use urgency, which
        // also factors in an incomplete step's own nearer deadline (see
        // getTaskUrgencyStatus in task-shared.js).
        const deadlineStatus = getTaskDisplayDeadlineStatus(task);
        const urgencyStatus = getTaskUrgencyStatus(task);

        deadlineBadge.classList.remove('deadline-none', 'deadline-normal', 'deadline-soon', 'deadline-critical', 'deadline-overdue');
        deadlineBadge.classList.add(deadlineStatus.deadlineClassName);
        deadlineBadge.textContent = deadlineStatus.deadlineLabel;

        countdownBadge.classList.remove('countdown-none', 'countdown-normal', 'countdown-soon', 'countdown-critical', 'countdown-overdue');
        countdownBadge.classList.add(urgencyStatus.countdownClassName);
        countdownBadge.textContent = urgencyStatus.countdownLabel;

        taskItem.classList.remove('status-normal', 'status-soon', 'status-critical', 'status-overdue');
        taskItem.classList.add(`status-${urgencyStatus.urgencyLevel}`);

        refreshSubtaskDeadlineBadges(taskItem, task);
    });
}

function startGroupRealtimeUpdates() {
    if (groupRealtimeIntervalId) {
        clearInterval(groupRealtimeIntervalId);
    }

    groupRealtimeIntervalId = setInterval(() => {
        refreshGroupDeadlineBadges();
        updateGroupUrgencyAlert();
        maybeNotifyGroupTaskUrgency();

        // Cheap once-a-second check, only acts on the rare tick where the
        // calendar day has actually changed - that's the only thing that
        // can move the "this week"/"this month" leaderboard windows without
        // a task completion happening to trigger a render on its own.
        const todayKey = getDateKey(new Date());
        if (todayKey !== lastGroupRealtimeDayKey) {
            lastGroupRealtimeDayKey = todayKey;
            const group = getSelectedGroup();
            if (group) {
                renderGroupLeaderboard(group);
            }
        }
    }, 1000);
}

// ---------------------------------------------------------------------
// Group create/join forms
// ---------------------------------------------------------------------

if (groupCreateForm) {
    groupCreateForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        groupCreateError?.classList.add('hidden');

        playClickSound();
        try {
            const groupId = await createGroup(groupCreateNameInput.value, currentUser, groupCreatePrivacySelect?.value);
            groupCreateNameInput.value = '';
            selectGroup(groupId);
        } catch (error) {
            if (groupCreateError) {
                groupCreateError.textContent = error.message || 'Could not create the group.';
                groupCreateError.classList.remove('hidden');
            }
        }
    });
}

if (groupJoinForm) {
    groupJoinForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        groupJoinError?.classList.add('hidden');
        groupJoinInfo?.classList.add('hidden');

        playClickSound();
        try {
            const { groupId, status } = await joinGroup(groupJoinCodeInput.value, currentUser);
            groupJoinCodeInput.value = '';
            if (status === 'requested') {
                if (groupJoinInfo) {
                    groupJoinInfo.textContent = 'Request sent - you\'ll get in once the group\'s owner or an admin approves it.';
                    groupJoinInfo.classList.remove('hidden');
                }
                return;
            }
            selectGroup(groupId);
        } catch (error) {
            if (groupJoinError) {
                groupJoinError.textContent = error.message || 'Could not join - check the invite code and try again.';
                groupJoinError.classList.remove('hidden');
            }
        }
    });
}

if (groupCopyInviteBtn) {
    groupCopyInviteBtn.addEventListener('click', async () => {
        playClickSound();
        const group = getSelectedGroup();
        if (!group) {
            return;
        }
        try {
            await navigator.clipboard.writeText(group.inviteCode || group.id);
            groupCopyInviteBtn.title = 'Copied!';
        } catch {
            // Clipboard API can be unavailable (permissions, insecure
            // context) - the code is still shown on screen to copy by hand.
        }
    });
}

if (groupRenameBtn) {
    groupRenameBtn.addEventListener('click', async () => {
        playClickSound();
        const group = getSelectedGroup();
        if (!group || !currentUser) {
            return;
        }
        const newName = prompt('Rename this group:', group.name);
        if (!newName || !newName.trim() || newName.trim() === group.name) {
            return;
        }
        try {
            await renameGroup(group.id, newName);
        } catch (error) {
            console.error('Failed to rename group:', error);
            alert('Could not rename the group.');
        }
    });
}

if (groupLeaveBtn) {
    groupLeaveBtn.addEventListener('click', async () => {
        playClickSound();
        const group = getSelectedGroup();
        if (!group || !currentUser) {
            return;
        }

        const isOwner = group.ownerId === currentUser.uid;
        const otherMemberCount = (group.memberIds || []).length - 1;
        if (isOwner && otherMemberCount === 0) {
            alert('You\'re the only member of this group - delete it instead of leaving it.');
            return;
        }

        const confirmText = isOwner
            ? `Leave "${group.name}"? Ownership will be handed to a random remaining member. You'll need the invite code to rejoin.`
            : `Leave "${group.name}"? You'll need the invite code to rejoin.`;
        if (!confirm(confirmText)) {
            return;
        }
        try {
            await leaveGroup(group.id, currentUser);
            selectedGroupId = null;
            activeMemberScope = 'all';
            renderApp();
        } catch (error) {
            console.error('Failed to leave group:', error);
            alert(error.message || 'Could not leave the group.');
        }
    });
}

if (groupDeleteBtn) {
    groupDeleteBtn.addEventListener('click', async () => {
        playClickSound();
        const group = getSelectedGroup();
        if (!group || !currentUser) {
            return;
        }
        if (!confirm(`Delete "${group.name}" for everyone? This removes all of its tasks too. This can't be undone.`)) {
            return;
        }
        try {
            await deleteGroupCompletely(group.id, currentUser);
            selectedGroupId = null;
            activeMemberScope = 'all';
            renderApp();
        } catch (error) {
            console.error('Failed to delete group:', error);
            alert(error.message || 'Could not delete the group.');
        }
    });
}

// ---------------------------------------------------------------------
// Add-task form (mirrors the solo app's .inputContainer/.taskDetailsPanel)
// ---------------------------------------------------------------------

if (detailsToggleBtn && taskDetailsPanel) {
    detailsToggleBtn.addEventListener('click', () => {
        playClickSound();
        const isOpen = !taskDetailsPanel.classList.contains('open');
        taskDetailsPanel.classList.toggle('open', isOpen);
        detailsToggleBtn.setAttribute('aria-expanded', String(isOpen));
        if (!isOpen) {
            // Collapsed again next time Prioritize opens - same two-tier
            // disclosure reasoning as solo's setDetailsPanelOpen (section C,
            // Hick's Law): starts back at just matrix/difficulty rather than
            // remembering an expanded state from a previous task.
            setDetailsMoreOptionsOpen(false);
        }
    });
}

// Two-tier disclosure (section C): estimate/deadline/schedule stay collapsed
// behind "More options" until asked for - same pattern as solo's
// setDetailsMoreOptionsOpen (script.js), duplicated here rather than shared
// since the two files don't share any other UI-state functions either.
function setDetailsMoreOptionsOpen(isOpen) {
    if (!detailsMoreOptions || !detailsMoreToggleBtn) {
        return;
    }
    detailsMoreOptions.classList.toggle('open', isOpen);
    detailsMoreToggleBtn.setAttribute('aria-expanded', String(isOpen));
}

if (detailsMoreToggleBtn) {
    detailsMoreToggleBtn.addEventListener('click', () => {
        playClickSound();
        setDetailsMoreOptionsOpen(!detailsMoreOptions?.classList.contains('open'));
    });
}

// Clicking anywhere in the deadline/schedule row opens its date picker, not
// just the small icon (native datetime-local inputs otherwise only respond
// to clicks on their own tiny icon).
// No setDetailsMoreOptionsOpen(true) here - Deadline is a primary, always-
// visible field now (unlike Schedule below, which still genuinely lives in
// More options), so interacting with it should never force Estimate/
// Schedule open too. Real bug caught by code review: leftover from when
// Deadline itself lived inside More options.
if (deadlineContainer && deadlineInput) {
    deadlineContainer.addEventListener('click', () => {
        playClickSound();
        taskDetailsPanel?.classList.add('open');
        if (typeof deadlineInput.showPicker === 'function') {
            deadlineInput.showPicker();
        } else {
            deadlineInput.focus();
        }
    });
}

if (scheduleContainer && scheduleInput) {
    scheduleContainer.addEventListener('click', () => {
        playClickSound();
        taskDetailsPanel?.classList.add('open');
        setDetailsMoreOptionsOpen(true);
        if (typeof scheduleInput.showPicker === 'function') {
            scheduleInput.showPicker();
        } else {
            scheduleInput.focus();
        }
    });
}

// Quick-add: typing a recognizable date/time phrase ("tomorrow 3pm", "in 2
// hours", "friday") sets the deadline automatically on submit, same fixed
// vocabulary as solo's quick-add (parseQuickAddPhrase, from task-shared.js).
// An explicit deadline already set in the picker always wins.
const quickAddHint = document.querySelector('.quickAddHint');

function updateQuickAddHint() {
    if (!quickAddHint || !taskInput) {
        return;
    }
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

taskInput?.addEventListener('input', updateQuickAddHint);
deadlineInput?.addEventListener('input', updateQuickAddHint);

// Section B: a real disabled state instead of a silent no-op when the input
// is empty - same reasoning as solo's updateAddBtnState (script.js).
function updateAddBtnState() {
    if (!addBtn || !taskInput) {
        return;
    }
    addBtn.disabled = taskInput.value.trim() === '';
}
taskInput?.addEventListener('input', updateAddBtnState);
updateAddBtnState();

// Time-estimate pills (mirrors solo's typePill/durationChip wiring exactly).
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
    const selectedMinutes = String(parseDurationMinutes(durationInput?.value) || '');
    durationChips.forEach((chip) => {
        chip.classList.toggle('active', chip.dataset.minutes === selectedMinutes);
    });
}

function updateDurationInputVisibility() {
    const isTimeboxed = getSelectedTaskType() === 'timeboxed';
    durationInput?.classList.toggle('hidden', !isTimeboxed);
    durationWrap?.classList.toggle('hidden', !isTimeboxed);
    if (!isTimeboxed && durationInput) {
        durationInput.value = '';
    }
    syncDurationChipState();
}

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

matrixSelect?.addEventListener('change', playClickSound);
difficultySelect?.addEventListener('change', playClickSound);

durationInput?.addEventListener('input', syncDurationChipState);
sanitizeNumberInputAsPositiveInteger(durationInput);

function addTaskFromInputs() {
    playClickSound();
    const group = getSelectedGroup();
    if (!group || !currentUser || !taskInput || taskInput.value.trim() === '') {
        return;
    }

    // An explicit manual deadline always wins over a quick-add guess.
    let taskText = taskInput.value;
    let dueAt = deadlineInput.value ? new Date(deadlineInput.value).toISOString() : null;

    if (!dueAt) {
        const parsed = parseQuickAddPhrase(taskInput.value);
        if (parsed.dueAt) {
            taskText = parsed.cleanedText;
            dueAt = parsed.dueAt.toISOString();
        }
    }

    const scheduledAt = scheduleInput?.value ? new Date(scheduleInput.value).toISOString() : null;
    const taskType = getSelectedTaskType();
    const estimateMinutes = taskType === 'timeboxed' ? parseDurationMinutes(durationInput?.value) : null;
    // Same "needs a deadline to repeat from" rule as solo.
    const recurrence = dueAt ? getValidRecurrenceValue(recurrenceSelect?.value) : null;

    addGroupTask(group.id, currentUser, {
        text: taskText,
        matrix: matrixSelect?.value,
        difficulty: difficultySelect?.value,
        dueAt,
        recurrence,
        scheduledAt,
        taskType,
        estimateMinutes
    }).catch((error) => console.error('Failed to add task:', error));

    if (recurrenceSelect) {
        recurrenceSelect.value = '';
    }

    taskInput.value = '';
    updateAddBtnState();
    if (deadlineInput) {
        deadlineInput.value = '';
    }
    if (scheduleInput) {
        scheduleInput.value = '';
    }
    setTaskTypePillState('open');
    updateDurationInputVisibility();
    quickAddHint?.classList.add('hidden');
    taskInput.focus();
}

// Brain Dump's commitTasks callback (see brain-dump.js). draftTasks come
// from the AI (or the user's own edit of its proposal) and are NOT
// trusted. Unlike solo, group tasks are written one at a time -
// addGroupTask() already sanitizes matrix/difficulty/taskType itself
// (see group.js's addGroupTask), so this only needs to validate the dates
// before handing off, same as manual entry does above.
async function commitAiTasksGroup(draftTasks) {
    const group = getSelectedGroup();
    if (!group || !currentUser) {
        throw new Error('No group selected.');
    }

    for (const draft of draftTasks) {
        const trimmedText = (draft.text || '').trim();
        if (!trimmedText) {
            continue;
        }

        const taskType = getValidTaskType(draft.taskType);
        await addGroupTask(group.id, currentUser, {
            text: trimmedText,
            matrix: draft.matrix,
            difficulty: draft.difficulty,
            dueAt: isValidDateValue(draft.dueAt) ? new Date(draft.dueAt).toISOString() : null,
            scheduledAt: isValidDateValue(draft.scheduledAt) ? new Date(draft.scheduledAt).toISOString() : null,
            taskType,
            estimateMinutes: taskType === 'timeboxed' ? parseDurationMinutes(draft.estimateMinutes) : null,
            subtasks: draft.subtasks
        });
    }
}

// Dusty suggesting a task for a teammate - only ever rendered/callable
// when Dusty was explicitly asked to suggest something to a named group
// member (see the Worker's system prompt's hard rule). forMemberName is
// resolved against the CURRENT group's own live roster right here - never
// trusted as a ready-made uid from the AI. suggestTaskForMember() (this
// file, above) is the exact same function a manual "suggest a task for
// them" click already uses, so the teammate still has to accept it
// themselves from their own Suggestions for You panel before it becomes a
// real task - nothing here bypasses that.
async function commitAiSuggestionsGroup(drafts) {
    const group = getSelectedGroup();
    if (!group || !currentUser) {
        throw new Error('No group selected.');
    }

    const memberNames = group.memberNames || [];
    const memberIds = group.memberIds || [];

    for (const draft of drafts) {
        const trimmedText = (draft.text || '').trim();
        const wantedName = (draft.forMemberName || '').trim().toLowerCase();
        if (!trimmedText || !wantedName) {
            continue;
        }

        const matchingIndexes = memberNames
            .map((name, index) => ((name || '').trim().toLowerCase() === wantedName ? index : -1))
            .filter((index) => index !== -1);
        if (matchingIndexes.length !== 1) {
            // No match, or more than one teammate shares that name - either
            // way, guessing would risk suggesting to the wrong person, so
            // this draft is skipped rather than silently misdirected.
            console.error(`Brain Dump: could not uniquely resolve teammate "${draft.forMemberName}" for a suggestion.`);
            continue;
        }

        await suggestTaskForMember(group.id, currentUser, memberIds[matchingIndexes[0]], {
            text: trimmedText,
            matrix: draft.matrix,
            difficulty: draft.difficulty,
            dueAt: isValidDateValue(draft.dueAt) ? new Date(draft.dueAt).toISOString() : null
        });
    }
}

// Dusty commenting on a teammate's task - same explicit-ask-only gating.
// taskId comes from Gemini, but is independently re-checked against this
// group's own live, already-loaded groupTasks before ever calling
// addComment() (this file, above) - a stale or hallucinated id is skipped,
// never trusted blind.
async function commitAiCommentsGroup(drafts) {
    const group = getSelectedGroup();
    if (!group || !currentUser) {
        throw new Error('No group selected.');
    }

    for (const draft of drafts) {
        const trimmedText = (draft.text || '').trim();
        if (!trimmedText || !draft.taskId) {
            continue;
        }
        const realTask = groupTasks.find((task) => task.id === draft.taskId);
        if (!realTask) {
            console.error(`Brain Dump: could not find task "${draft.taskId}" for a comment - skipped.`);
            continue;
        }
        await addComment(group.id, realTask.id, currentUser, trimmedText);
    }
}

// Applies Dusty-proposed edits to the user's OWN existing tasks in the
// currently-open group only (matrix/difficulty/dueAt/scheduledAt/completed
// - never text/subtasks, never a delete - see the EDITING EXISTING TASKS
// rule in the Worker's system instruction). taskId is never trusted blind:
// re-checked against groupTasks (the live, already-loaded list), same
// discipline as commitAiCommentsGroup/commitAiSuggestionsGroup above - and
// ownerId is re-checked here too, so even a misbehaving or confused
// proposal can never edit a teammate's task, regardless of what the model
// output actually said.
// Same real bug as solo's commitAiTaskEditsSolo, verified the same way:
// a not-found or not-your-task draft used to just console.error + continue
// with no way for the caller to tell - commitTaskEdits still resolved
// normally, so the review card showed "Applied" even though nothing was
// written. Now returns a per-draft outcome so brain-dump.js's UI can show
// what actually happened instead of assuming success from "didn't throw".
async function commitAiTaskEditsGroup(drafts) {
    const group = getSelectedGroup();
    if (!group || !currentUser) {
        throw new Error('No group selected.');
    }

    const { doc, updateDoc } = fs();
    const results = [];

    for (const draft of drafts) {
        if (!draft.taskId) {
            continue;
        }
        const realTask = groupTasks.find((task) => task.id === draft.taskId);
        if (!realTask) {
            console.error(`Brain Dump: could not find task "${draft.taskId}" for an edit - skipped.`);
            results.push({ taskId: draft.taskId, applied: false, reason: "Couldn't find that task - it may have been deleted or already changed." });
            continue;
        }
        if (realTask.ownerId !== currentUser.uid) {
            console.error(`Brain Dump: task "${draft.taskId}" does not belong to the current user - skipped.`);
            results.push({ taskId: draft.taskId, applied: false, reason: "That task belongs to a teammate - you can only edit your own tasks." });
            continue;
        }

        // One combined updateDoc below instead of two sequential ones - a
        // draft that both completes a task and changes another field used
        // to cost two full round-trips to the same document. completed/
        // completedAt are folded straight into fieldUpdates (the same two
        // fields setGroupTaskCompleted itself would have written) rather
        // than calling that function for the write; its side effects
        // (sound/milestone/history-log, not Firestore writes) still run
        // separately below, same as before.
        const fieldUpdates = {};

        // realTask.completed !== willBeCompleted guard: without it, a
        // draft redundantly marking an already-completed task complete
        // (Gemini including completed:true alongside another field change
        // on a done task, say) would re-log a duplicate history entry and
        // re-fire the milestone check every time, inflating the This week/
        // This month leaderboard counts - solo's commitAiTaskEditsSolo
        // avoids this for free via setTaskCompletedState's own
        // wasCompleted===completed no-op. Real bug caught by code review.
        let justCompleted = false;
        if (Object.prototype.hasOwnProperty.call(draft, 'completed')) {
            const willBeCompleted = Boolean(draft.completed);
            if (realTask.completed !== willBeCompleted) {
                fieldUpdates.completed = willBeCompleted;
                fieldUpdates.completedAt = willBeCompleted ? new Date().toISOString() : null;
                justCompleted = willBeCompleted;
                // Recurring: same advance-in-place behavior as every other
                // completion path - justCompleted (used for the sound/
                // milestone/history side effects below) is already captured
                // above, so overriding fieldUpdates.completed back to false
                // here doesn't affect whether this occurrence gets credit.
                if (justCompleted) {
                    Object.assign(fieldUpdates, getRecurrenceAdvanceFields(realTask) || {});
                }
            }
        }

        if (Object.prototype.hasOwnProperty.call(draft, 'matrix') && draft.matrix) {
            fieldUpdates.matrix = getValidMatrixValue(draft.matrix);
        }
        if (Object.prototype.hasOwnProperty.call(draft, 'difficulty') && draft.difficulty) {
            fieldUpdates.difficulty = getValidDifficultyLevel(draft.difficulty);
        }
        if (Object.prototype.hasOwnProperty.call(draft, 'dueAt')) {
            fieldUpdates.dueAt = isValidDateValue(draft.dueAt) ? new Date(draft.dueAt).toISOString() : null;
        }
        if (Object.prototype.hasOwnProperty.call(draft, 'scheduledAt')) {
            fieldUpdates.scheduledAt = isValidDateValue(draft.scheduledAt) ? new Date(draft.scheduledAt).toISOString() : null;
        }
        if (Object.keys(fieldUpdates).length > 0) {
            fieldUpdates.updatedAt = new Date().toISOString();
            await updateDoc(doc(db(), 'groups', group.id, 'tasks', realTask.id), fieldUpdates);
        }

        // Same side effects the checkbox itself triggers on completing a
        // task (see the .checkBtn click handler above) - history log and
        // milestone check, not just the Firestore write above.
        if (justCompleted) {
            playTaskCompleteSound();
            checkGroupMilestone(group.id, realTask.id);
            logGroupTaskCompletion(group.id, realTask, new Date().toISOString()).catch((error) => {
                console.error('Failed to log completion history:', error);
            });
        }

        results.push({ taskId: draft.taskId, applied: true });
    }

    return results;
}

const brainDumpController = createBrainDumpController({
    context: 'group',
    commitTasks: commitAiTasksGroup,
    commitSuggestions: commitAiSuggestionsGroup,
    commitComments: commitAiCommentsGroup,
    commitTaskEdits: commitAiTaskEditsGroup,
    getCurrentGroupId: () => getSelectedGroup()?.id || null
});
if (brainDumpToggleBtn) {
    brainDumpToggleBtn.addEventListener('click', () => {
        playClickSound();
        brainDumpController.open();
    });
}

addBtn?.addEventListener('click', addTaskFromInputs);
taskInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        addTaskFromInputs();
    }
});

// ---------------------------------------------------------------------
// Auth wiring
// ---------------------------------------------------------------------

function resetGroupState() {
    if (groupRealtimeIntervalId) {
        clearInterval(groupRealtimeIntervalId);
        groupRealtimeIntervalId = null;
    }
    if (unsubscribeGroups) {
        unsubscribeGroups();
        unsubscribeGroups = null;
    }
    if (unsubscribeTasks) {
        unsubscribeTasks();
        unsubscribeTasks = null;
    }
    if (unsubscribeSuggestions) {
        unsubscribeSuggestions();
        unsubscribeSuggestions = null;
    }
    // renderApp() below bails out at its very first check once currentUser
    // is null, so it never reaches the else-branch cleanup that would
    // normally tear this down - has to happen explicitly here instead.
    if (unsubscribeJoinRequests) {
        unsubscribeJoinRequests();
        unsubscribeJoinRequests = null;
    }
    groupJoinRequests = [];
    joinRequestsSubscriptionKey = null;
    navAttentionBadge?.classList.remove('visible');
    closeGroupSettingsModal();
    // So a different account signing in during the same page load doesn't
    // inherit the previous account's reminder cooldown history.
    groupStageReminderTimestamps.clear();
    groupLastGlobalReminderAt = 0;
    groupPopupAlertsEnabled = false;
    currentUser = null;
    groups = undefined;
    groupTasks = [];
    groupSuggestions = [];
    showSetup = false;
    expandedSubtaskTaskIds = new Set();
    clearExpandedCommentSubscriptions();
    profileDisplayName = null;
    if (yourNameInput) {
        yourNameInput.value = '';
    }
    // So a different account signing in during the same page load (sign out,
    // then sign in as someone else) gets its own welcome/tour check, not
    // whatever the previous account already resolved this session.
    hasCheckedGroupWelcome = false;
    hasAutoStartedGroupTour = false;
    shouldAutoPlayGroupTour = false;
    isLegacyTourAccount = false;
    if (groupWelcomeOverlay) {
        groupWelcomeOverlay.classList.add('hidden');
        groupWelcomeOverlay.setAttribute('aria-hidden', 'true');
    }
    renderApp();
}

function watchSelectedGroupTasks() {
    if (unsubscribeTasks) {
        unsubscribeTasks();
        unsubscribeTasks = null;
    }

    const group = getSelectedGroup();
    if (!group) {
        groupTasks = [];
        groupHistoryEntries = [];
        groupHistoryLoadError = null;
        renderApp();
        return;
    }

    unsubscribeTasks = subscribeToGroupTasks(group.id, (tasks) => {
        groupTasks = tasks;
        renderApp();
    }, (error) => {
        console.error('Failed to load group tasks:', error);
        groupTasks = [];
        renderApp();
    });

    if (unsubscribeSuggestions) {
        unsubscribeSuggestions();
        unsubscribeSuggestions = null;
    }
    unsubscribeSuggestions = subscribeToGroupSuggestions(group.id, (suggestions) => {
        groupSuggestions = suggestions;
        renderApp();
    }, (error) => {
        console.error('Failed to load suggestions:', error);
        groupSuggestions = [];
        renderApp();
    });

    if (unsubscribeHistory) {
        unsubscribeHistory();
        unsubscribeHistory = null;
    }
    unsubscribeHistory = subscribeToGroupHistory(group.id, (entries) => {
        groupHistoryEntries = entries;
        groupHistoryLoadError = null;
        renderApp();
    }, (error) => {
        console.error('Failed to load group history:', error);
        groupHistoryEntries = [];
        // Same permission-denied message as comments (see toggleGroupCommentsExpanded)
        // - the most common cause is the firestore.rules history/{entryId}
        // rules existing locally but not yet published to the Firebase
        // console, which otherwise fails silently and just looks like an
        // empty "Nothing finished here yet." forever.
        groupHistoryLoadError = error?.code === 'permission-denied'
            ? 'Recently finished isn\'t turned on for this project yet (the security rules need to be published).'
            : 'Could not load recently finished tasks.';
        renderApp();
    });
}

if (yourNameSaveBtn && yourNameInput) {
    yourNameSaveBtn.addEventListener('click', async () => {
        playClickSound();
        if (!currentUser || yourNameInput.value.trim() === '') {
            return;
        }
        try {
            await saveProfileName(currentUser, yourNameInput.value);
            if (yourNameSavedMsg) {
                yourNameSavedMsg.classList.remove('hidden');
                setTimeout(() => yourNameSavedMsg.classList.add('hidden'), 2000);
            }
        } catch (error) {
            console.error('Failed to save your name:', error);
        }
    });
}

// ---------------------------------------------------------------------
// Welcome modal (first time only - "name yourself" as an actual first-run
// step, not just a form someone might scroll past) and the group tour
// (auto-launched the first time the dashboard itself is actually visible,
// since most of what it points at only exists once a group is selected).
// ---------------------------------------------------------------------

const GROUP_WELCOME_KEY = 'todoGroupWelcomeSeenV1';
const GROUP_COACH_KEY = 'todoGroupCoachV1';

// Hosted by Dusty now, first person throughout, walked field by field
// through Prioritize instead of one summary line, same reasoning and same
// action-gating rules as solo's TOUR_STEPS (script.js) - commas only,
// never a hyphen as punctuation.
const GROUP_TOUR_STEPS = [
    {
        selector: '.inputContainer',
        title: 'Add a task',
        text: 'Add your own tasks here, same as solo, matrix, difficulty, deadline, and repeat all carry over.',
        beforeShow: () => switchGroupView('tasks')
    },
    {
        selector: '.viewTabs',
        title: 'Four places, one job each',
        text: 'Tasks is where you work. Team shows everyone and their roles. Leaderboard ranks completions. Activity is a running log of what just got finished.',
        beforeShow: () => switchGroupView('tasks')
    },
    {
        selector: '.detailsToggleBtn',
        title: 'Let\'s open Prioritize',
        text: 'Tap Prioritize, and I\'ll show you everything that helps me figure out what matters most for a new task.',
        action: { event: 'click' },
        beforeShow: () => switchGroupView('tasks')
    },
    {
        selector: '.matrixSelect',
        title: 'Matrix',
        text: 'This is matrix, how urgent something is and how important it is. It\'s the biggest single thing I weigh when deciding what should come first.',
        beforeShow: () => { switchGroupView('tasks'); taskDetailsPanel?.classList.add('open'); }
    },
    {
        selector: '.difficultySelect',
        title: 'Difficulty',
        text: 'Difficulty is just your own honest guess, from very easy to very hard. It helps me tell the difference between something quick and something that actually needs real effort.',
        beforeShow: () => { switchGroupView('tasks'); taskDetailsPanel?.classList.add('open'); }
    },
    {
        selector: '.deadlineContainer',
        title: 'Deadline',
        text: 'Deadline is simply when something is due. Set it here, and I\'ll factor it into everything, sorting, alerts, all of it.',
        beforeShow: () => { switchGroupView('tasks'); taskDetailsPanel?.classList.add('open'); }
    },
    {
        selector: '.recurrenceSelect',
        title: 'Repeat',
        text: 'If something happens again and again, taking out the trash weekly, rent every month, set it to repeat here. I\'ll bring it back automatically once it\'s done.',
        action: { event: 'change' },
        beforeShow: () => { switchGroupView('tasks'); taskDetailsPanel?.classList.add('open'); }
    },
    {
        selector: '.detailsMoreToggleBtn',
        title: 'More options',
        text: 'Tap here for two more things, a rough time estimate, and a schedule for when you actually plan to sit down and do it.',
        action: { event: 'click' },
        beforeShow: () => { switchGroupView('tasks'); taskDetailsPanel?.classList.add('open'); }
    },
    {
        selector: '.effortContainer',
        title: 'Estimate',
        text: 'Give me a rough time estimate if you have one. It helps me tell you honestly whether the team\'s day is actually realistic, not just busy.',
        beforeShow: () => { switchGroupView('tasks'); taskDetailsPanel?.classList.add('open'); detailsMoreOptions?.classList.add('open'); }
    },
    {
        selector: '.scheduleContainer',
        title: 'Schedule',
        text: 'Schedule is different from deadline, it\'s when you actually plan to sit down and work on it, not when it\'s due. Both are optional, and they don\'t have to match.',
        beforeShow: () => { switchGroupView('tasks'); taskDetailsPanel?.classList.add('open'); detailsMoreOptions?.classList.add('open'); }
    },
    {
        selector: '.groupMemberScopeTabs',
        title: 'Whose tasks',
        text: 'See everyone\'s tasks together, just your own, or drill into one teammate\'s. Go ahead and try one, a Suggest a task button appears right here for whoever you pick.',
        action: { event: 'click' },
        // Hidden for a solo group (see renderGroupMemberScopeTabs), skip
        // this step rather than highlighting a hidden, zero-size element.
        isRelevant: () => (getSelectedGroup()?.memberIds || []).length > 1,
        beforeShow: () => switchGroupView('tasks')
    },
    {
        selector: '.deadlineViewTabs',
        title: 'Filter by deadline',
        text: 'Jump to what\'s overdue, due today, this week, or already done, across whoever\'s selected above. Try tapping one, I\'ll filter the list for you.',
        action: { event: 'click' },
        beforeShow: () => switchGroupView('tasks')
    },
    {
        selector: '.memberRoster',
        title: 'Team',
        text: 'Everyone in the group, their role, and their current progress. Click a card any time to switch Tasks over to just their work.',
        beforeShow: () => switchGroupView('team')
    },
    {
        selector: '.groupLeaderboardPanel',
        title: 'Leaderboard',
        text: 'Ranked by completions, switch between this week, this month, and all time.',
        beforeShow: () => switchGroupView('leaderboard')
    },
    {
        selector: '.groupHistoryPanel',
        title: 'Activity',
        text: 'A running log of what the team has been finishing, newest first.',
        beforeShow: () => switchGroupView('activity')
    },
    {
        selector: '.groupBrowseAllLink',
        title: 'Managing multiple groups',
        text: 'See every group you\'re in, with each one\'s members, right from here.',
        beforeShow: () => switchGroupView('tasks')
    },
    {
        selector: '.groupAlertToggleBtn',
        title: 'Popup alerts',
        text: 'Turn this on any time you want a desktop notification when one of your own tasks in this group is due soon or overdue.',
        beforeShow: () => switchGroupView('tasks')
    },
    {
        selector: '.brainDumpToggleBtn',
        title: 'And that\'s me',
        text: 'I\'m Dusty. Tell me what\'s going on and I\'ll turn it into real tasks. I can suggest a task to a teammate, comment on one of their tasks, or edit one of your own, always showing you exactly what I\'d send before anything goes out. I also think ahead, ask who\'s overloaded or where deadlines collide across the team, and I\'ll answer with real numbers, not a guess. Go ahead, tap me, let\'s try it.',
        action: { event: 'click' },
        beforeShow: () => switchGroupView('tasks')
    }
];

// Persistent, dismissible reminder mirroring solo's own .onboardingHint
// (script.js's renderOnboardingHint/dismissOnboardingHint) - group had only
// the one-shot welcome modal + auto-tour, with nothing left lingering on
// the page for anyone who skips or closes the tour before finishing it.
// Reuses GROUP_COACH_KEY rather than a separate key, so "tour completed"
// and "hint dismissed" are the same one-way state solo already treats them
// as.
function dismissGroupOnboardingHint() {
    playClickSound();
    try {
        localStorage.setItem(GROUP_COACH_KEY, 'dismissed');
    } catch {
        // Non-fatal - worst case the hint just reappears next visit.
    }
    renderGroupOnboardingHint();
}

function renderGroupOnboardingHint() {
    if (!groupOnboardingHint) {
        return;
    }
    let coachState = null;
    try {
        coachState = localStorage.getItem(GROUP_COACH_KEY);
    } catch {
        // localStorage unavailable - treat as not-yet-seen, same as solo.
    }
    // Hidden for the tour's whole run, not just once it's done - it sits
    // right behind the modal and is redundant with it while open. Also
    // hidden outright for a legacy account (see isLegacyTourAccount) - this
    // prompt is part of the new-account onboarding flow, not something to
    // push on an existing user just because this browser never dismissed it.
    const shouldHide = coachState === 'dismissed' || coachState === 'tour-completed' || groupTourController.isOpen() || isLegacyTourAccount;
    groupOnboardingHint.classList.toggle('hidden', shouldHide);
}

const groupTourController = createTourController({
    steps: GROUP_TOUR_STEPS,
    storageKey: GROUP_COACH_KEY,
    onStart: () => renderGroupOnboardingHint(),
    onEnd: () => renderGroupOnboardingHint()
});

if (groupOnboardingDismissBtn) {
    groupOnboardingDismissBtn.addEventListener('click', dismissGroupOnboardingHint);
}

if (groupOnboardingStartTourBtn) {
    groupOnboardingStartTourBtn.addEventListener('click', () => {
        playClickSound();
        groupTourController.start();
    });
}

let hasAutoStartedGroupTour = false;
// Whether THIS app (group) has ever auto-played its tour on this account -
// resolved once at sign-in via window.ToDoAuth.checkAndMarkTourSeen (see
// AuthGate.init below), account-level rather than the old localStorage-only
// groupTourController.hasBeenSeen() check, so it never replays on a new
// device/browser either. Manual restarts (helpTourBtn, the onboarding
// hint's "Start tutorial") are untouched by this - they always work.
let shouldAutoPlayGroupTour = false;
// Set once at sign-in alongside shouldAutoPlayGroupTour above - whether
// THIS account predates account-level tour tracking, so
// renderGroupOnboardingHint() can hide its "Start tutorial" prompt for it
// entirely, not just via its usual per-browser dismiss state (which a
// legacy account in a fresh browser would never have set).
let isLegacyTourAccount = false;

// Most of what the group tour points at (whose-tasks tabs, roster, etc.)
// only exists once a real dashboard is showing - so this both fires right
// after the welcome modal closes (if a group's already selected) AND gets
// re-checked on every render, so a first-time user with zero groups yet
// still gets the tour the moment they create or join their first one.
function maybeAutoStartGroupTour() {
    if (hasAutoStartedGroupTour || !shouldAutoPlayGroupTour || groupTourController.isOpen()) {
        return;
    }
    if (groupWelcomeOverlay && !groupWelcomeOverlay.classList.contains('hidden')) {
        return;
    }
    if (!groupDashboard || groupDashboard.classList.contains('hidden')) {
        return;
    }
    hasAutoStartedGroupTour = true;
    setTimeout(() => groupTourController.start(), 400);
}

if (helpTourBtn) {
    helpTourBtn.addEventListener('click', () => {
        playClickSound();
        groupTourController.start();
    });
}

function openGroupWelcomeModal(user, resolvedName) {
    if (!groupWelcomeOverlay) {
        return;
    }
    if (groupWelcomeNameInput) {
        groupWelcomeNameInput.value = resolvedName || '';
    }
    groupWelcomeOverlay.classList.remove('hidden');
    groupWelcomeOverlay.setAttribute('aria-hidden', 'false');
    groupWelcomeNameInput?.focus();
}

function closeGroupWelcomeModal() {
    if (!groupWelcomeOverlay) {
        return;
    }
    groupWelcomeOverlay.classList.add('hidden');
    groupWelcomeOverlay.setAttribute('aria-hidden', 'true');
    try {
        localStorage.setItem(GROUP_WELCOME_KEY, 'yes');
    } catch {
        // Non-fatal - worst case the welcome modal shows again next visit.
    }
    maybeAutoStartGroupTour();
}

if (groupWelcomeContinueBtn) {
    groupWelcomeContinueBtn.addEventListener('click', async () => {
        playClickSound();
        const name = groupWelcomeNameInput?.value.trim();
        if (name && currentUser) {
            try {
                await saveProfileName(currentUser, name);
                if (yourNameInput) {
                    yourNameInput.value = name;
                }
            } catch (error) {
                console.error('Failed to save your name:', error);
            }
        }
        closeGroupWelcomeModal();
    });
}

if (groupWelcomeNameInput) {
    groupWelcomeNameInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            groupWelcomeContinueBtn?.click();
        }
    });
}

let hasCheckedGroupWelcome = false;

function maybeShowGroupWelcome(user, resolvedName) {
    if (hasCheckedGroupWelcome) {
        return;
    }
    hasCheckedGroupWelcome = true;

    let alreadySeen = false;
    try {
        alreadySeen = localStorage.getItem(GROUP_WELCOME_KEY) === 'yes';
    } catch {
        // Treat as not-seen if localStorage is unavailable.
    }

    if (alreadySeen) {
        maybeAutoStartGroupTour();
        return;
    }

    openGroupWelcomeModal(user, resolvedName);
}

AuthGate.init({
    onSignedIn: (user) => {
        currentUser = user;
        groups = undefined;
        renderApp();
        loadGroupSettings();
        startGroupRealtimeUpdates();
        // First time THIS app has ever been opened on this account - see
        // shouldAutoPlayGroupTour above. Fire-and-forget (not awaited) so
        // this one extra Firestore read never delays the group list itself
        // loading below - maybeAutoStartGroupTour() still gates on the
        // dashboard actually being visible, so calling it here is just a
        // safety net; the render calls elsewhere are what actually catch
        // it once a group's data has loaded.
        window.ToDoAuth.checkAndMarkTourSeen(user, 'group').then(({ shouldAutoPlay, isLegacyAccount }) => {
            shouldAutoPlayGroupTour = shouldAutoPlay;
            isLegacyTourAccount = isLegacyAccount;
            renderGroupOnboardingHint();
            maybeAutoStartGroupTour();
        });
        loadProfileName(user, (name) => {
            if (yourNameInput) {
                yourNameInput.value = name;
            }
            maybeShowGroupWelcome(user, name);
        });

        unsubscribeGroups = subscribeToMyGroups(user.uid, (nextGroups) => {
            groups = nextGroups;
            if (!groups.some((group) => group.id === selectedGroupId)) {
                selectedGroupId = groups[0]?.id || null;
            }
            renderApp();
            watchSelectedGroupTasks();
        }, (error) => {
            console.error('Failed to load your groups:', error);
            groups = [];
            renderApp();
        });
    },
    onSignedOut: () => {
        resetGroupState();
    }
});
