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
// /tasks. Capped (across the whole group, before any per-member scope
// filtering in renderGroupHistory) so this doesn't grow into an ever-larger
// download as a group racks up history over time. The leaderboard's "week"
// range (see getMemberCompletedEntriesForRange below) relies on this same
// capped list rather than its own query - 200 is a wide enough margin that
// a real group's combined weekly completions shouldn't plausibly exceed it
// (unlike the original 50, which a handful of active members could reach
// in a week and silently undercount).
// ---------------------------------------------------------------------

function subscribeToGroupHistory(groupId, callback, onError) {
    const { collection, query, orderBy, limit, onSnapshot } = fs();
    const historyRef = query(
        collection(db(), 'groups', groupId, 'history'),
        orderBy('completedAt', 'desc'),
        limit(200)
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
    const { doc, updateDoc, serverTimestamp } = fs();
    await addGroupTask(groupId, user, {
        text: suggestion.text,
        matrix: suggestion.matrix,
        difficulty: suggestion.difficulty,
        dueAt: suggestion.dueAt
    });
    // resolvedAt (not just status) is what suggestionOutcomesCount gates
    // on below - see computeAttentionSummary's comment for why a bare
    // status check isn't enough.
    await updateDoc(doc(db(), 'groups', groupId, 'suggestions', suggestion.id), { status: 'accepted', resolvedAt: serverTimestamp() });
}

async function dismissSuggestion(groupId, suggestionId) {
    const { doc, updateDoc, serverTimestamp } = fs();
    await updateDoc(doc(db(), 'groups', groupId, 'suggestions', suggestionId), { status: 'dismissed', resolvedAt: serverTimestamp() });
}

async function retractSuggestion(groupId, suggestionId) {
    const { doc, deleteDoc } = fs();
    await deleteDoc(doc(db(), 'groups', groupId, 'suggestions', suggestionId));
}

// The sender's own "I've seen this outcome" action - the counterpart to
// accept/dismiss above, but only ever touches acknowledgedBySender (see
// firestore.rules' separate update rule for this exact field). Only called
// on an already-resolved suggestion (see jumpToSuggestionOutcomes), so
// there's no risk of a sender using this to pre-clear a still-pending one.
async function acknowledgeSuggestionOutcome(groupId, suggestionId) {
    const { doc, updateDoc } = fs();
    await updateDoc(doc(db(), 'groups', groupId, 'suggestions', suggestionId), { acknowledgedBySender: true });
}

// ---------------------------------------------------------------------
// Task handoff (Feature 10) - reassigning a task's owner without losing its
// subtasks/comments/history. Deliberately NOT a separate subcollection the
// way suggestions are: the pending request lives as a single
// `handoffRequest` field right on the task document itself, so accepting
// it is one atomic document write (ownerId flips + the request clears,
// together) rather than two separate non-transactional writes that could
// race each other - see firestore.rules' tasks/{taskId} update rule, the
// only place ownerId is allowed to change to someone other than its
// current value. Mirrors the suggestion accept/reject trust model: the
// recipient's own action is what commits the change, never the sender
// directly setting the new owner.
// ---------------------------------------------------------------------

async function requestTaskHandoff(groupId, task, toUserId, toUserName, fromUser) {
    const { doc, updateDoc } = fs();
    await updateDoc(doc(db(), 'groups', groupId, 'tasks', task.id), {
        handoffRequest: {
            toUserId,
            toUserName,
            fromUserId: fromUser.uid,
            fromUserName: displayNameFor(fromUser),
            requestedAt: new Date().toISOString()
        }
    });
}

// Used for both "owner cancels their own outgoing request" and "recipient
// declines an incoming one" - the write itself is identical either way
// (just null the field); firestore.rules is what tells the two apart by
// checking who's asking.
async function clearTaskHandoff(groupId, taskId) {
    const { doc, updateDoc } = fs();
    await updateDoc(doc(db(), 'groups', groupId, 'tasks', taskId), { handoffRequest: null });
}

async function acceptTaskHandoff(groupId, task, user) {
    const { doc, writeBatch, serverTimestamp, increment } = fs();
    const batch = writeBatch(db());
    batch.update(doc(db(), 'groups', groupId, 'tasks', task.id), {
        ownerId: user.uid,
        handoffRequest: null,
        commentCount: increment(1),
        lastCommentAt: serverTimestamp()
    });
    // A visible record of the handoff, in the one place it's most useful -
    // right on the task's own comment thread - rather than a whole new
    // collection just to keep a history of who owned what when (see
    // firestore.rules' note on the same tradeoff). Posted by the recipient
    // (accurately - they're the one who just accepted), not the original
    // owner.
    batch.set(doc(db(), 'groups', groupId, 'tasks', task.id, 'comments', generateTaskId()), {
        authorId: user.uid,
        authorName: displayNameFor(user),
        text: `Took over this task from ${task.handoffRequest?.fromUserName || 'a teammate'}.`,
        createdAt: serverTimestamp()
    });
    await batch.commit();
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
    // populates it (see brain-dump.js). Entries are {text, dueAt} objects
    // (see the Worker's SUBTASK_ITEM_SCHEMA) - a bare string is tolerated
    // defensively but shouldn't come from a real AI draft going forward.
    const initialSubtasks = (Array.isArray(subtasks) ? subtasks : [])
        .map((entry) => (typeof entry === 'string' ? { text: entry, dueAt: null } : { text: entry?.text, dueAt: entry?.dueAt }))
        .map((entry) => ({ ...entry, text: (entry.text || '').trim() }))
        .filter((entry) => entry.text)
        .slice(0, 200)
        .map((entry) => ({
            id: generateSubtaskId(),
            text: entry.text.slice(0, 240),
            completed: false,
            createdAt: timestamp,
            dueAt: entry.dueAt && isValidDateValue(entry.dueAt) ? new Date(entry.dueAt).toISOString() : null
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
        // dueAt cleared too, not just completed - a step's own deadline now
        // actually drives Today/Overdue/the calendar (getEffectiveDueAt in
        // task-shared.js), so leaving last cycle's date in place would
        // resurrect the task with permanently-overdue steps every time it
        // recurs. Mirrors the same fix in solo's setTaskCompletedState
        // (script.js).
        subtasks: (Array.isArray(task.subtasks) ? task.subtasks : []).map((subtask) => ({ ...subtask, completed: false, dueAt: null }))
    };
}

// Runs inside a transaction, reading the task fresh, because the recurrence
// path below reads task.subtasks - using the possibly-stale `task` this was
// called with (whatever the last onSnapshot delivered to this client) could
// silently revert a teammate's concurrent edit to a different subtask on
// the same task, the same class of race found and fixed in
// applySubtaskDrivenUpdate below. completed itself still comes from the
// caller (real user intent, not derived from potentially-stale data), only
// the recurrence-advance fields need a fresh read.
async function setGroupTaskCompleted(groupId, task, completed) {
    const { doc, runTransaction } = fs();
    const taskRef = doc(db(), 'groups', groupId, 'tasks', task.id);
    await runTransaction(db(), async (transaction) => {
        const snapshot = await transaction.get(taskRef);
        if (!snapshot.exists()) {
            return;
        }
        const freshTask = { id: snapshot.id, ...snapshot.data() };
        const update = {
            completed,
            completedAt: completed ? new Date().toISOString() : null,
            updatedAt: new Date().toISOString()
        };
        if (!freshTask.completed && completed) {
            Object.assign(update, getRecurrenceAdvanceFields(freshTask) || {});
        }
        transaction.update(taskRef, update);
    });
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

// Writes a subtask-driven update, then logs a history entry if that update
// is what just auto-completed the task (checking the last subtask) - shared
// by every subtask mutator below so "log on the completed transition" isn't
// repeated five times.
//
// Takes a mutateSubtasks(currentSubtasks) function rather than a
// pre-computed array, and runs inside a transaction that reads the task
// fresh before applying it. Real bug found and fixed here: the old version
// took a subtasks array the caller had already computed from whatever
// `task` object it happened to be holding - which, on any client, is only
// as fresh as the last onSnapshot delivery. If a teammate had just changed
// a DIFFERENT subtask on the same task and that update hadn't propagated
// here yet, this client's next subtask edit would overwrite the whole
// subtasks field from its stale copy, silently reverting the teammate's
// change. Reading fresh inside a transaction (which Firestore automatically
// retries if the doc changes between read and write) closes that race
// without needing every call site to worry about staleness itself.
async function applySubtaskDrivenUpdate(groupId, taskId, mutateSubtasks) {
    const { doc, runTransaction } = fs();
    const taskRef = doc(db(), 'groups', groupId, 'tasks', taskId);

    let justCompleted = false;
    let historyCompletedAt = null;
    let freshTaskForHistory = null;

    await runTransaction(db(), async (transaction) => {
        const snapshot = await transaction.get(taskRef);
        if (!snapshot.exists()) {
            return;
        }
        const freshTask = { id: snapshot.id, ...snapshot.data() };
        const subtasks = mutateSubtasks(freshTask.subtasks || []);
        const result = subtaskDrivenTaskUpdate(freshTask, subtasks);
        justCompleted = result.justCompleted;
        historyCompletedAt = result.historyCompletedAt;
        freshTaskForHistory = freshTask;
        const { justCompleted: _jc, historyCompletedAt: _hca, ...update } = result;
        transaction.update(taskRef, update);
    });

    // Real bug found while wiring in recurrence: a recurring task advanced
    // via this path flips `completed` straight back to false in the SAME
    // update, so checking update.completed here (the old code) would have
    // silently skipped the history log for every recurring task completed
    // this way - the occurrence still happened, it just doesn't stay
    // marked done. justCompleted (captured before that override) is the
    // real signal for "did this transition to completed just now".
    if (justCompleted) {
        // Direct bug report: checking off the last step completed the task
        // but played no sound at all - this path (auto-complete via steps)
        // never mirrored the direct-checkbox path's playTaskCompleteSound()/
        // checkGroupMilestone() calls (see the .checkBtn handler above),
        // only its history log.
        playTaskCompleteSound();
        checkGroupMilestone(groupId, taskId);
        logGroupTaskCompletion(groupId, freshTaskForHistory, historyCompletedAt).catch((error) => {
            console.error('Failed to log completion history:', error);
        });
    }
}

async function addGroupSubtask(groupId, task, text) {
    const trimmedText = text.trim();
    if (!trimmedText) {
        return;
    }

    await applySubtaskDrivenUpdate(groupId, task.id, (currentSubtasks) => [
        ...currentSubtasks,
        { id: generateSubtaskId(), text: trimmedText, completed: false, createdAt: new Date().toISOString(), dueAt: null }
    ]);
}

async function toggleGroupSubtask(groupId, task, subtaskId) {
    await applySubtaskDrivenUpdate(groupId, task.id, (currentSubtasks) => currentSubtasks.map((subtask) => (
        subtask.id === subtaskId ? { ...subtask, completed: !subtask.completed } : subtask
    )));
}

async function deleteGroupSubtask(groupId, task, subtaskId) {
    await applySubtaskDrivenUpdate(groupId, task.id, (currentSubtasks) => currentSubtasks.filter((subtask) => subtask.id !== subtaskId));
}

// A step's own deadline - reuses the same generic "write this subtasks
// array, recompute completion" pipeline every other subtask mutator does,
// even though this particular change can never itself flip completion.
async function setGroupSubtaskDueAt(groupId, task, subtaskId, dueAtIsoOrNull) {
    await applySubtaskDrivenUpdate(groupId, task.id, (currentSubtasks) => currentSubtasks.map((subtask) => (
        subtask.id === subtaskId ? { ...subtask, dueAt: dueAtIsoOrNull } : subtask
    )));
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

    await applySubtaskDrivenUpdate(groupId, task.id, (currentSubtasks) => currentSubtasks.map((subtask) => (
        subtask.id === subtaskId ? { ...subtask, text: trimmedText } : subtask
    )));
    return true;
}

// ---------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------

const groupStatusMsg = document.querySelector('.groupStatusMsg');
const joinLinkBanner = document.querySelector('.joinLinkBanner');
const joinLinkBannerText = document.querySelector('.joinLinkBannerText');
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
    // Untouched-grid confirmation (per the feature's own spec): leaving the
    // Availability tab while a start-state has been picked but nothing has
    // actually been painted yet triggers a confirm, since an all-busy or
    // all-free grid is usually a mistake, not a real answer. Checked BEFORE
    // any tab-switching happens below so a "no" leaves the user exactly
    // where they were.
    const currentActiveButton = groupViewTabButtons.find((button) => button.classList.contains('active'));
    // Only when leaving from your OWN grid ('mine') - someone who just
    // opened Team overlap or Best times to look at the group, without ever
    // touching their own grid, shouldn't get nagged about an unpainted one.
    // Also skipped while the guided tour is open: its Availability step
    // lands here and the very next step switches away, which would pop this
    // confirm mid-tour for nearly every new user. Checked via the overlay's
    // DOM state, not groupTourController, which is a const declared much
    // further down this file (TDZ if this ever ran before it).
    const isTourOpen = Boolean(document.querySelector('.tourOverlay:not(.hidden)'));
    if (!isTourOpen && currentActiveButton?.dataset.view === 'availability' && view !== 'availability' && availabilitySubView === 'mine' && availabilityWeekdaySlots && !availabilityHasBeenPainted) {
        const proceed = confirm('You haven\'t marked any availability yet - save this untouched grid anyway?');
        if (!proceed) {
            return;
        }
        // Treated as a deliberate confirmation from here on, so it doesn't
        // ask again every time they glance at another tab - and saved right
        // now since nothing painted means the debounce that normally
        // triggers a save was never going to fire on its own.
        availabilityHasBeenPainted = true;
        saveAvailabilityNow();
    }

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

    // Start/stop the group-wide availability listener depending on whether a
    // view that needs it is now showing (Team overlap / Best times), and
    // render whichever Availability sub-view is current when arriving.
    syncGroupAvailabilitySubscription();
    if (view === 'availability') {
        const availabilityGroup = getSelectedGroup();
        if (availabilityGroup) {
            renderGroupAvailabilityView(availabilityGroup);
        }
    }
}

groupViewTabButtons.forEach((button) => {
    button.addEventListener('click', () => {
        playClickSound();
        switchGroupView(button.dataset.view || 'tasks');
    });
});

// ---------------------------------------------------------------------
// Availability scheduling - see availability-plan.md. Everything for the
// Availability tab lives in this section: your own paintable grid (mouse,
// touch and pen), the team overlap heatmap, and the best-meeting-times
// panel, split across three sub-tabs. Reuses this file's
// db()/fs()/getSelectedGroup()/describeGroupWriteError, and
// groups-data.js's loadProfileTimezone/saveProfileTimezone/
// detectBrowserTimezone. The timezone math lives in availability-timezone.js.
// ---------------------------------------------------------------------

const availabilityTimezoneName = document.querySelector('.availabilityTimezoneName');
const availabilityChangeTimezoneBtn = document.querySelector('.availabilityChangeTimezoneBtn');
const availabilityGridWrap = document.querySelector('.availabilityGridWrap');
const availabilityGridEl = document.querySelector('.availabilityGrid');
const availabilityBrushButtons = Array.from(document.querySelectorAll('.availabilityBrushBtn'));
const availabilitySaveStatus = document.querySelector('.availabilitySaveStatus');

const AVAILABILITY_DEFAULT_HOUR_RANGE = { startHour: 7, endHour: 23 };
const AVAILABILITY_WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const AVAILABILITY_VALUE_TO_STATE = { A: 'free', B: 'busy', I: 'ifNeeded' };
const AVAILABILITY_STATE_TO_VALUE = { free: 'A', busy: 'B', ifNeeded: 'I' };
const AVAILABILITY_SAVE_DEBOUNCE_MS = 1500;

// Sub-views inside the Availability tab: 'mine' (your own paint grid),
// 'team' (everyone's overlap heatmap), 'recommend' (best meeting times).
// Split into sub-tabs after real feedback that stacking all three on one
// long page was cluttered. Only 'team' and 'recommend' need every member's
// data, so that's the only time the group-wide subscription runs (see
// isGroupAvailabilityDataNeeded).
const availabilitySubTabButtons = Array.from(document.querySelectorAll('.availabilitySubTab'));
const availabilitySubPanels = Array.from(document.querySelectorAll('.availabilitySubPanel'));
let availabilitySubView = 'mine';

// Phase 4/5 shared data: every CURRENT member's availability, live-
// subscribed. Keyed by uid so heatmap/recommendation code can filter to
// group.memberIds at render time (see getScorableGroupMembers) - a kicked
// or departed member's doc isn't force-deleted (this app's established
// convention), so filtering here is what actually keeps them out of the
// heatmap/recommendations, not the data layer itself.
let groupAvailabilityByUid = new Map();
let unsubscribeGroupAvailability = null;
let groupAvailabilitySubscriptionKey = null;

let availabilityLoadedForGroupId = null;    // which group's data is currently in memory
let availabilityWeekdaySlots = null;        // {'0'..'6': 96-char string} - null = not painted/loaded yet
let availabilityTimezone = null;
let availabilityHasBeenPainted = false;
// Default brush is Busy, not Free - the grid now starts fully free (see
// fetchMyAvailability's auto-init), so the natural first action is marking
// the exceptions, not re-confirming the default.
let availabilityActiveBrush = 'busy';
let availabilitySaveTimer = null;
let availabilityIsPainting = false;
let availabilityPaintValue = null;
let availabilityLastPaintedCell = null;
let availabilityCurrentHourRange = AVAILABILITY_DEFAULT_HOUR_RANGE;
let availabilityGridBuiltForRangeKey = null; // only rebuild the grid DOM when the hour range actually changes
let availabilityGridEventsAttached = false;

function getAvailabilityHourRange(group) {
    const range = group?.availabilityHourRange;
    if (range && Number.isInteger(range.startHour) && Number.isInteger(range.endHour) && range.startHour < range.endHour) {
        return range;
    }
    return AVAILABILITY_DEFAULT_HOUR_RANGE;
}

function formatAvailabilityHourLabel(hour24) {
    const period = hour24 < 12 ? 'AM' : 'PM';
    const hour12 = ((hour24 + 11) % 12) + 1;
    return `${hour12}${period}`;
}

// Storage is ALWAYS the full 24h (96 quarter-hour slots/day) regardless of
// the group's configured view window - see availability-plan.md's Data
// Model for why (changing the view window later must never need to rewrite
// another member's already-painted data, which self-only write wouldn't
// allow anyway). slotPairIndex (0-based within the CURRENTLY DISPLAYED
// range, one per 30-min UI row) maps to the two 15-min storage indices it
// represents.
function slotPairToStorageIndices(slotPairIndex) {
    const base = availabilityCurrentHourRange.startHour * 4 + slotPairIndex * 2;
    return [base, base + 1];
}

function renderGroupAvailabilityView(group) {
    if (!availabilityTimezoneName || !group) {
        return;
    }

    if (availabilityLoadedForGroupId !== group.id) {
        // Flush any pending debounced save FOR THE OLD GROUP before
        // resetting state - saveAvailabilityNow snapshots
        // availabilityLoadedForGroupId itself (see its own comment), so
        // calling it here, before that id changes below, is what makes the
        // last few strokes in the old group actually land there instead of
        // being silently discarded once availabilityWeekdaySlots is reset.
        if (availabilitySaveTimer) {
            clearTimeout(availabilitySaveTimer);
            availabilitySaveTimer = null;
            saveAvailabilityNow();
        }

        // First time seeing this group (or switched groups) - clear
        // immediately so a stale PREVIOUS group's grid is never shown even
        // briefly, then kick off the real fetch, which re-renders on
        // completion.
        availabilityLoadedForGroupId = group.id;
        availabilityWeekdaySlots = null;
        availabilityHasBeenPainted = false;
        availabilityTimezone = null;
        fetchMyAvailability(group);
    }

    availabilityTimezoneName.textContent = availabilityTimezone || detectBrowserTimezone();

    // The grid now auto-initializes as soon as it's fetched (see
    // fetchMyAvailability) - there's no "haven't started yet" state to
    // show a setup prompt for anymore, `hasGrid` is only false during the
    // brief window before the fetch resolves.
    const hasGrid = Boolean(availabilityWeekdaySlots);
    availabilityGridWrap?.classList.toggle('hidden', !hasGrid);

    // Independent of your own grid having loaded - it's built from every
    // member's live data (see renderAvailabilityHeatmap). Only rendered while
    // its sub-view is the one showing: the group-wide subscription that
    // feeds it isn't even running otherwise (see
    // isGroupAvailabilityDataNeeded), so rendering it from an empty map
    // would just flash a misleading "nobody has set availability" state.
    if (availabilitySubView === 'team') {
        renderAvailabilityHeatmap(group);
    }

    if (hasGrid) {
        availabilityCurrentHourRange = getAvailabilityHourRange(group);
        buildAvailabilityGridDomIfNeeded();
        paintAllAvailabilityCellsFromState();
    }

    // Also independent of your own grid - see the Phase 5 block further down.
    if (availabilitySubView === 'recommend') {
        renderAvailabilityRecommendations(group);
    }
}

// Real feedback after actually using this: it's a "book ahead of time"
// tool, so the leftmost column should always be TODAY, not a fixed
// Sun-Sat calendar layout - column 0 is always whatever day it currently
// is for the viewer, column 6 is six days out. This is display order
// only; storage stays keyed by absolute jsWeekday (0=Sunday..6=Saturday,
// this app's existing convention) regardless of which column it's drawn
// in, so nothing about painting/reading logic below needs to know about
// column position at all - only the header/cell-building loop in
// buildAvailabilityGridDomIfNeeded does.
//
// luxonWeekdayToJs is defined in availability-timezone.js (loaded before
// this file) - reused here rather than redefined.
//
// "Today" and every column date come from the viewer's SAVED zone, not the
// browser's - the paint grid, heatmap and recommendations all go through
// getAvailabilityViewerZone so they agree on which day is column 0 even
// when the two differ (travel, a VPN). Each column's jsWeekday is read from
// its date in that same zone, which is what dataset.weekday stores into.
function getAvailabilityViewerZone() {
    return normalizeTimezoneName(availabilityTimezone) || detectBrowserTimezone();
}

function getAvailabilityColumns() {
    const now = luxon.DateTime.now().setZone(getAvailabilityViewerZone());
    const columns = [];
    for (let i = 0; i <= 6; i += 1) {
        const date = now.plus({ days: i });
        columns.push({ jsWeekday: luxonWeekdayToJs(date.weekday), date });
    }
    return columns;
}

// Includes today's own date, so the rebuild-guard below naturally forces a
// full rebuild (correct new column order, not just a text update) exactly
// once a day rolls over - see the periodic timer at the bottom of
// buildAvailabilityGridDomIfNeeded's caller.
function getAvailabilityGridRangeKey() {
    const todayKey = luxon.DateTime.now().setZone(getAvailabilityViewerZone()).toFormat('yyyy-MM-dd');
    return `${availabilityCurrentHourRange.startHour}-${availabilityCurrentHourRange.endHour}-${todayKey}`;
}

// Belt-and-suspenders for the "tab left open quietly overnight" case -
// renderApp() only fires on actual data changes, which could plausibly not
// happen for hours in a quiet group, so the grid could otherwise stay on
// yesterday's column order until something else triggers a re-render.
// buildAvailabilityGridDomIfNeeded is already a cheap no-op unless its
// range key actually changed, so it's safe to just call it every minute
// rather than separately detecting "did the day change" here.
setInterval(() => {
    if (availabilityWeekdaySlots && !availabilityGridWrap?.classList.contains('hidden')) {
        buildAvailabilityGridDomIfNeeded();
        paintAllAvailabilityCellsFromState();
    }
    // Same day-rollover reason for the heatmap - a no-op unless today's
    // date (part of its render key) has actually changed.
    if (availabilitySubView === 'team' && availabilityHeatmapWrap && !availabilityHeatmapWrap.classList.contains('hidden')) {
        renderAvailabilityHeatmap(getSelectedGroup());
    }
}, 60000);

// A failed first load must NOT fall back to an all-free grid: if the read
// failed for a real permission reason while a saved doc exists, showing a
// blank grid would let the first paint stroke overwrite that saved data
// (saves are whole-doc setDoc). Instead retry a bounded number of times.
// Found live: right after "Create group", the server can briefly deny the
// read (the local cache shows the new group before the write is committed,
// same race as the join-requests listener), and without a retry the paint
// grid never rendered until a full reload.
const AVAILABILITY_FETCH_RETRY_DELAYS_MS = [1500, 4000, 15000];

async function fetchMyAvailability(group, attempt = 0) {
    const { doc, getDoc } = fs();
    try {
        const snapshot = await getDoc(doc(db(), 'groups', group.id, 'availability', currentUser.uid));
        if (getSelectedGroup()?.id !== group.id) {
            return; // switched groups again before this resolved - discard, a newer fetch already owns the state
        }
        if (snapshot.exists()) {
            const data = snapshot.data();
            availabilityWeekdaySlots = data.weekdaySlots;
            availabilityTimezone = data.timezone;
            availabilityHasBeenPainted = Boolean(data.hasBeenPainted);
        } else {
            // Real feedback after actually using this: a separate "pick a
            // starting mode" step before you could even see the grid was
            // just friction - simplified to always start fully free (the
            // common case for most people most of the week) with nothing
            // to choose. Painting is now just "mark your exceptions" -
            // Busy for genuinely unavailable, If needed for a compromise -
            // rather than picking a whole-grid default first.
            const allFree = 'A'.repeat(96);
            availabilityWeekdaySlots = { '0': allFree, '1': allFree, '2': allFree, '3': allFree, '4': allFree, '5': allFree, '6': allFree };
            availabilityTimezone = await loadProfileTimezone(currentUser);
        }
    } catch (error) {
        console.error('Failed to load your availability:', error);
        availabilityTimezone = detectBrowserTimezone();
        if (attempt < AVAILABILITY_FETCH_RETRY_DELAYS_MS.length) {
            setTimeout(() => {
                // Only if this group is still the one wanted and nothing
                // loaded in the meantime (a group switch already started
                // its own fetch, which owns the state now).
                if (availabilityLoadedForGroupId === group.id && getSelectedGroup()?.id === group.id && !availabilityWeekdaySlots) {
                    fetchMyAvailability(group, attempt + 1);
                }
            }, AVAILABILITY_FETCH_RETRY_DELAYS_MS[attempt]);
        }
    }
    renderGroupAvailabilityView(group);
}

// Everyone's availability, live - used by the Phase 4 heatmap and Phase 5
// recommendation panel. Open to every member (unlike joinRequests, which
// is owner/admin-gated) since anyone should be able to see the group's
// overlap. Idempotent against groupAvailabilitySubscriptionKey, same
// pattern as ensureJoinRequestsSubscription right above it, so calling it
// on every renderApp() is a cheap no-op once already subscribed.
// Retry state for a failed listener. The obvious fix for "a terminated
// listener never retries on its own" (clear the key on error so the next
// renderApp() re-subscribes, as ensureJoinRequestsSubscription does) becomes
// an unbounded hot loop here: renderApp() re-subscribes immediately, a
// persistent denial (availability rules not yet republished in the Console,
// or a read rule's get() on a group doc the server hasn't caught up on yet)
// fails again at network round-trip speed, and every cycle also runs a full
// renderApp(). Unlike join requests (owner/admin only), this listener runs
// for every member, so it retries a few times with growing delays and then
// stops until the user leaves and reopens the view.
const GROUP_AVAILABILITY_RETRY_DELAYS_MS = [2000, 5000, 30000];
let groupAvailabilityRetryCount = 0;
let groupAvailabilityRetryTimer = null;
let groupAvailabilityRetryGroupId = null;

function ensureGroupAvailabilitySubscription(group) {
    const desiredKey = group ? group.id : null;
    if (desiredKey === groupAvailabilitySubscriptionKey) {
        return;
    }
    if (unsubscribeGroupAvailability) {
        unsubscribeGroupAvailability();
        unsubscribeGroupAvailability = null;
    }
    // A different group (or none) means any pending retry is for something
    // no longer wanted, and reopening the view later deserves a fresh set
    // of attempts. The retry timer's own re-subscribe below passes the SAME
    // group id, so it deliberately keeps the count and can't loop forever.
    if (desiredKey !== groupAvailabilityRetryGroupId) {
        clearTimeout(groupAvailabilityRetryTimer);
        groupAvailabilityRetryTimer = null;
        groupAvailabilityRetryCount = 0;
        groupAvailabilityRetryGroupId = desiredKey;
    }
    groupAvailabilityByUid = new Map();
    groupAvailabilitySubscriptionKey = desiredKey;
    if (!desiredKey) {
        return;
    }
    const { collection, onSnapshot } = fs();
    unsubscribeGroupAvailability = onSnapshot(collection(db(), 'groups', group.id, 'availability'), (snapshot) => {
        groupAvailabilityRetryCount = 0;
        groupAvailabilityByUid = new Map(snapshot.docs.map((availabilityDoc) => [availabilityDoc.id, availabilityDoc.data()]));
        renderApp();
    }, (error) => {
        console.error('Failed to load group availability:', error);
        groupAvailabilityByUid = new Map();
        // The key stays SET here on purpose, so renderApp() below (and every
        // later one) is a no-op instead of instantly re-subscribing. Only
        // the timer clears it, a bounded number of times.
        if (groupAvailabilityRetryCount < GROUP_AVAILABILITY_RETRY_DELAYS_MS.length) {
            const delay = GROUP_AVAILABILITY_RETRY_DELAYS_MS[groupAvailabilityRetryCount];
            groupAvailabilityRetryCount += 1;
            clearTimeout(groupAvailabilityRetryTimer);
            groupAvailabilityRetryTimer = setTimeout(() => {
                groupAvailabilityRetryTimer = null;
                if (groupAvailabilitySubscriptionKey === desiredKey) {
                    groupAvailabilitySubscriptionKey = null;
                    syncGroupAvailabilitySubscription();
                }
            }, delay);
        }
        renderApp();
    });
}

// Only the Team overlap and Best times sub-views read everyone's docs - your
// own grid reads just your own (fetchMyAvailability), and every other tab in
// the dashboard doesn't touch availability at all. Subscribing whenever a
// group was merely selected meant every open dashboard re-read every
// teammate's doc on each of their paint saves, even for members who never
// open this feature. Gated on both the top-level Availability tab being the
// active one AND a sub-view that actually needs the data, and left running
// while flipping between Team overlap and Best times (same key, so
// ensureGroupAvailabilitySubscription no-ops) instead of tearing down and
// re-reading everything on each switch.
function isGroupAvailabilityDataNeeded() {
    const activeTopLevelTab = groupViewTabButtons.find((button) => button.classList.contains('active'));
    return activeTopLevelTab?.dataset.view === 'availability'
        && (availabilitySubView === 'team' || availabilitySubView === 'recommend');
}

function syncGroupAvailabilitySubscription() {
    ensureGroupAvailabilitySubscription(isGroupAvailabilityDataNeeded() ? getSelectedGroup() : null);
}

function switchAvailabilitySubView(view) {
    availabilitySubView = view;
    availabilitySubTabButtons.forEach((button) => {
        const isActive = button.dataset.availabilityView === view;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    availabilitySubPanels.forEach((panel) => {
        panel.classList.toggle('hidden', panel.dataset.availabilityPanel !== view);
    });

    syncGroupAvailabilitySubscription();

    // Render the newly shown view right away from whatever data is already
    // in memory (empty until the subscription's first snapshot arrives, at
    // which point renderApp() re-renders it) rather than waiting for the
    // next unrelated re-render.
    const group = getSelectedGroup();
    if (group) {
        if (view === 'team') {
            renderAvailabilityHeatmap(group);
        } else if (view === 'recommend') {
            renderAvailabilityRecommendations(group);
        }
    }
}

availabilitySubTabButtons.forEach((button) => {
    button.addEventListener('click', () => {
        playClickSound();
        switchAvailabilitySubView(button.dataset.availabilityView || 'mine');
    });
});

// The shared input both the heatmap and recommendation panel build from:
// every CURRENT member's availability, shaped for availability-timezone.js
// ({uid, name, timezone, weekdaySlots, hasBeenPainted}). Filtering to
// group.memberIds here (not in the subscription itself) is what actually
// keeps a kicked/departed member's still-lingering doc out of both - see
// the comment on groupAvailabilityByUid's declaration.
function getScorableGroupMembers(group) {
    if (!group) {
        return [];
    }
    return group.memberIds
        .map((uid, index) => {
            const data = groupAvailabilityByUid.get(uid);
            if (!data) {
                return null;
            }
            return {
                uid,
                name: resolveMemberName(uid, group.memberNames?.[index], groupTasks),
                timezone: data.timezone,
                weekdaySlots: data.weekdaySlots,
                hasBeenPainted: Boolean(data.hasBeenPainted)
            };
        })
        .filter(Boolean);
}

// ---------------------------------------------------------------------
// Phase 4: the group heatmap. Same today-first columns and hour range as
// the paint grid above it, so the two line up column-for-column.
//
// Deliberately NOT built on buildUtcTimeline: that resolves each weekday to
// the NEAREST date within -3..+3 days of its anchor, so with a today-first
// grid three of the columns would resolve to past dates. Each heatmap cell
// instead starts from its own real date + time in the viewer's zone,
// converts that single instant into every member's own zone, and reads the
// member's stored slot for it - DST and half-hour zones fall out of Luxon
// the same way as everywhere else in this feature.
//
// Members who have never painted are left out of the counts entirely (not
// treated as busy everywhere), same as findBestMeetingTimes, and listed in
// a separate note instead.
const availabilityHeatmapWrap = document.querySelector('.availabilityHeatmapWrap');
// 'O' = outside that member's usual hours (see getMemberValueAtInstant) -
// ranked worst so a cell straddling the edge of someone's hours reads as
// outside them, same as Best times never suggesting it.
const AVAILABILITY_VALUE_RANK = { A: 0, I: 1, B: 2, O: 3 };
let availabilityHeatmapRenderKey = null;
let availabilityHeatmapDataRef = null;
let availabilityHeatmapCellDetails = [];

// One 30-min cell covers two 15-min storage slots - a member only counts as
// free for the cell if free for both halves (the worse value wins).
// getMemberValueAtInstant (availability-timezone.js) reads the member's
// full-24h storage in their own zone - the same lookup the recommendation
// search uses, so the heatmap and the "best times" panel always agree -
// including viewHourRange, so time outside a member's usual hours is 'O'
// here too (not free) instead of whatever their stored grid says.
function getMemberAvailabilityForCell(member, cellStartUtc, viewHourRange) {
    const first = getMemberValueAtInstant(member, cellStartUtc, viewHourRange);
    const second = getMemberValueAtInstant(member, cellStartUtc.plus({ minutes: 15 }), viewHourRange);
    return AVAILABILITY_VALUE_RANK[first] >= AVAILABILITY_VALUE_RANK[second] ? first : second;
}

// Level 4 sits next to the legend's "All free" label, so it's reserved for
// cells where literally everyone is free - plain rounding gave 7 of 8 a 4.
function getAvailabilityHeatLevel(freeCount, totalCount) {
    if (!totalCount || freeCount === 0) {
        return 0;
    }
    if (freeCount === totalCount) {
        return 4;
    }
    return Math.min(3, Math.max(1, Math.round((freeCount / totalCount) * 4)));
}

// Set by each real renderAvailabilityHeatmap pass: the viewer's zone and the
// members whose local times the hover/tap detail line can show. Kept out of
// the per-cell details so the (up to 224) cells don't each carry a copy, and
// the per-member times are only computed for the one cell being looked at.
let availabilityHeatmapZoneContext = { viewerZone: null, members: [] };
const AVAILABILITY_LOCAL_TIMES_MAX_SHOWN = 3;

// "Asia/Kolkata" -> "Kolkata", "America/Argentina/Buenos_Aires" -> "Buenos Aires".
function formatAvailabilityZoneHint(zone) {
    return String(zone).split('/').pop().replace(/_/g, ' ');
}

// The spec's "12:30 am for you, 12:00 pm for Priya in India" line. Members
// whose local clock matches the viewer's are skipped (repeating your own
// time back adds nothing, and it keeps a same-zone group's detail short),
// the rest are capped with "and N more" so a big group doesn't turn this
// into a wall of text. A member whose local DATE differs from the viewer's
// gets the weekday too, since that's usually the surprising part.
function describeAvailabilityLocalTimes(startUtc) {
    const { viewerZone, members } = availabilityHeatmapZoneContext;
    if (!startUtc || !viewerZone) {
        return '';
    }
    const viewerLocal = startUtc.setZone(viewerZone);
    const viewerClock = viewerLocal.toFormat('yyyy-MM-dd HH:mm');
    const others = members
        .filter((member) => member.uid !== currentUser?.uid && member.timezone && luxon.IANAZone.isValidZone(member.timezone))
        .map((member) => ({ member, local: startUtc.setZone(member.timezone) }))
        .filter(({ local }) => local.toFormat('yyyy-MM-dd HH:mm') !== viewerClock);
    if (!others.length) {
        return '';
    }
    const shown = others.slice(0, AVAILABILITY_LOCAL_TIMES_MAX_SHOWN).map(({ member, local }) => {
        const sameDate = local.toISODate() === viewerLocal.toISODate();
        const time = local.toFormat(sameDate ? 'h:mm a' : 'ccc h:mm a');
        return `${time} for ${member.name} (${formatAvailabilityZoneHint(member.timezone)})`;
    });
    const hiddenCount = others.length - shown.length;
    const more = hiddenCount ? `, and ${hiddenCount} more` : '';
    return `${viewerLocal.toFormat('h:mm a')} for you, ${shown.join(', ')}${more}`;
}

function describeAvailabilityHeatmapCell(details) {
    const parts = [details.timeLabel];
    const localTimes = describeAvailabilityLocalTimes(details.startUtc);
    if (localTimes) {
        parts.push(localTimes);
    }
    parts.push(details.free.length ? `Free: ${details.free.join(', ')}` : 'Nobody free');
    if (details.ifNeeded.length) {
        parts.push(`If needed: ${details.ifNeeded.join(', ')}`);
    }
    if (details.busy.length) {
        parts.push(`Busy: ${details.busy.join(', ')}`);
    }
    const outsideHours = details.outsideHours || [];
    if (outsideHours.length) {
        parts.push(`Outside usual hours: ${outsideHours.join(', ')}`);
    }
    return parts.join('. ');
}

function renderAvailabilityHeatmap(group) {
    if (!availabilityHeatmapWrap || !group || typeof luxon === 'undefined') {
        return;
    }

    const viewerZone = getAvailabilityViewerZone();
    const hourRange = getAvailabilityHourRange(group);
    const todayKey = luxon.DateTime.now().setZone(viewerZone).toFormat('yyyy-MM-dd');
    // renderApp() runs on every task/comment/roster change, not just
    // availability ones - skip the (members x 448 conversions) rebuild
    // unless something the heatmap actually shows has changed.
    // groupAvailabilityByUid is replaced with a new Map on every snapshot,
    // so comparing its identity is a cheap "availability data changed" check.
    const renderKey = [
        group.id,
        (group.memberIds || []).join(','),
        (group.memberNames || []).join(','),
        viewerZone,
        hourRange.startHour,
        hourRange.endHour,
        todayKey
    ].join('|');
    if (availabilityHeatmapRenderKey === renderKey && availabilityHeatmapDataRef === groupAvailabilityByUid) {
        return;
    }

    const members = getScorableGroupMembers(group);
    const paintedMembers = members.filter((member) => member.hasBeenPainted);
    const paintedUids = new Set(paintedMembers.map((member) => member.uid));
    const notSetNames = (group.memberIds || [])
        .map((uid, index) => (paintedUids.has(uid) ? null : resolveMemberName(uid, group.memberNames?.[index], groupTasks)))
        .filter(Boolean);

    availabilityHeatmapWrap.innerHTML = '';
    availabilityHeatmapCellDetails = [];
    availabilityHeatmapZoneContext = { viewerZone, members };

    const title = document.createElement('p');
    title.className = 'availabilityHeatmapTitle';
    title.textContent = 'When everyone is free';
    availabilityHeatmapWrap.appendChild(title);

    if (paintedMembers.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'availabilityHeatmapNote';
        empty.textContent = 'Nobody has set their availability yet. Paint your own grid above to get things started.';
        availabilityHeatmapWrap.appendChild(empty);
    } else {
        const legend = document.createElement('div');
        legend.className = 'availabilityHeatmapLegend';
        legend.setAttribute('aria-hidden', 'true');
        const fewer = document.createElement('span');
        fewer.textContent = 'Fewer free';
        legend.appendChild(fewer);
        for (let level = 0; level <= 4; level += 1) {
            const swatch = document.createElement('span');
            swatch.className = `heatCell level-${level} availabilityHeatmapSwatch`;
            legend.appendChild(swatch);
        }
        const more = document.createElement('span');
        more.textContent = 'All free';
        legend.appendChild(more);
        const outsideSwatch = document.createElement('span');
        outsideSwatch.className = 'heatCell level-0 outsideHours availabilityHeatmapSwatch';
        legend.appendChild(outsideSwatch);
        const outsideText = document.createElement('span');
        outsideText.textContent = "Outside someone's usual hours";
        legend.appendChild(outsideText);
        availabilityHeatmapWrap.appendChild(legend);

        const scroll = document.createElement('div');
        scroll.className = 'availabilityGridScroll';
        const grid = document.createElement('div');
        grid.className = 'availabilityHeatmapGrid';
        grid.setAttribute('role', 'group');
        grid.setAttribute('aria-label', 'Group availability heatmap');

        const columns = getAvailabilityColumns();
        const corner = document.createElement('div');
        corner.className = 'availabilityGridCorner';
        grid.appendChild(corner);
        columns.forEach(({ jsWeekday, date }) => {
            const header = document.createElement('div');
            header.className = 'availabilityGridDayHeader';
            const nameSpan = document.createElement('span');
            nameSpan.textContent = AVAILABILITY_WEEKDAY_LABELS[jsWeekday];
            const dateSpan = document.createElement('span');
            dateSpan.className = 'availabilityGridDateLabel';
            dateSpan.textContent = date.toFormat('MMM d');
            header.appendChild(nameSpan);
            header.appendChild(dateSpan);
            grid.appendChild(header);
        });

        const totalHours = hourRange.endHour - hourRange.startHour;
        for (let hourOffset = 0; hourOffset < totalHours; hourOffset += 1) {
            for (let half = 0; half < 2; half += 1) {
                const isHourStart = half === 0;
                const hour = hourRange.startHour + hourOffset;
                const minute = half * 30;
                const label = document.createElement('div');
                label.className = `availabilityGridTimeLabel${isHourStart ? '' : ' halfHour'}`;
                if (isHourStart) {
                    label.textContent = formatAvailabilityHourLabel(hour);
                }
                grid.appendChild(label);

                columns.forEach(({ date }) => {
                    const cellStartLocal = luxon.DateTime.fromObject(
                        { year: date.year, month: date.month, day: date.day, hour, minute, second: 0, millisecond: 0 },
                        { zone: viewerZone }
                    );
                    const cellStartUtc = cellStartLocal.toUTC();
                    const details = {
                        startUtc: cellStartUtc,
                        timeLabel: cellStartLocal.toFormat('ccc MMM d, h:mm a'),
                        free: [],
                        ifNeeded: [],
                        busy: [],
                        outsideHours: []
                    };
                    paintedMembers.forEach((member) => {
                        const value = getMemberAvailabilityForCell(member, cellStartUtc, hourRange);
                        if (value === 'A') {
                            details.free.push(member.name);
                        } else if (value === 'I') {
                            details.ifNeeded.push(member.name);
                        } else if (value === 'O') {
                            details.outsideHours.push(member.name);
                        } else {
                            details.busy.push(member.name);
                        }
                    });

                    // Outside-hours members aren't free, so a cell with any
                    // can never reach level 4 ("All free"); the extra class
                    // mutes it so it doesn't read as a good time either.
                    const cell = document.createElement('button');
                    cell.type = 'button';
                    const level = getAvailabilityHeatLevel(details.free.length, paintedMembers.length);
                    const outsideClass = details.outsideHours.length ? ' outsideHours' : '';
                    cell.className = `heatCell level-${level} availabilityHeatmapCell${isHourStart ? ' hourStart' : ''}${outsideClass}`;
                    cell.dataset.detailIndex = String(availabilityHeatmapCellDetails.length);
                    const outsideAria = details.outsideHours.length ? `, ${details.outsideHours.length} outside usual hours` : '';
                    cell.setAttribute('aria-label', `${details.timeLabel}, ${details.free.length} of ${paintedMembers.length} free${outsideAria}`);
                    availabilityHeatmapCellDetails.push(details);
                    grid.appendChild(cell);
                });
            }
        }

        scroll.appendChild(grid);
        availabilityHeatmapWrap.appendChild(scroll);

        const detail = document.createElement('p');
        detail.className = 'availabilityHeatmapDetail';
        detail.setAttribute('aria-live', 'polite');
        detail.textContent = 'Hover or tap a time to see who is free.';
        availabilityHeatmapWrap.appendChild(detail);

        // Delegated, so a grid rebuild never leaves stale per-cell listeners.
        const showCellDetail = (event) => {
            const cell = event.target.closest('.availabilityHeatmapCell');
            if (!cell) {
                return;
            }
            const details = availabilityHeatmapCellDetails[Number(cell.dataset.detailIndex)];
            if (details) {
                detail.textContent = describeAvailabilityHeatmapCell(details);
            }
        };
        grid.addEventListener('pointerover', showCellDetail);
        grid.addEventListener('focusin', showCellDetail);
        grid.addEventListener('click', showCellDetail);
    }

    if (notSetNames.length && paintedMembers.length) {
        const note = document.createElement('p');
        note.className = 'availabilityHeatmapNote';
        note.textContent = `${notSetNames.length} ${notSetNames.length === 1 ? "hasn't" : "haven't"} set their availability yet: ${notSetNames.join(', ')}. They aren't counted above.`;
        availabilityHeatmapWrap.appendChild(note);
    }

    availabilityHeatmapWrap.classList.remove('hidden');
    availabilityHeatmapRenderKey = renderKey;
    availabilityHeatmapDataRef = groupAvailabilityByUid;
    // The grid element above is brand new, so it has lost .dayMode /
    // data-day-col - re-apply the shared Week | Day layout onto it (and
    // show or hide the heatmap's toggle row depending on whether there is
    // a grid at all this time).
    applyAvailabilityGridLayout();
}

function setAvailabilityBrush(brush) {
    availabilityActiveBrush = brush;
    availabilityBrushButtons.forEach((button) => {
        button.classList.toggle('active', button.dataset.brush === brush);
    });
}

availabilityBrushButtons.forEach((button) => {
    button.addEventListener('click', () => {
        playClickSound();
        setAvailabilityBrush(button.dataset.brush);
    });
});
setAvailabilityBrush(availabilityActiveBrush);

// Week | Day layout, one shared state for both the paint grid (My
// availability) and the heatmap (Team overlap), so switching sub-tabs always
// shows the same mode and day. Each sub-panel has its own copy of the toggle
// + nav markup; every copy is driven from here. Day mode is purely a display
// filter over the same 7-column grids (see the .dayMode rules in style.css):
// the other six columns get display:none, so storage, painting, saving and
// the pointer code are untouched, elementFromPoint can never land on a hidden
// cell, and hidden heatmap cells drop out of hover/tap/focus. The selected
// day is remembered as a DATE, not a column index, so a midnight rollover
// (columns shift left by one) keeps showing the same day while it's still in
// range, and falls back to today once it isn't. An hour-range rebuild keeps
// both mode and day as-is. Re-applied after every paint-grid build and every
// real heatmap re-render, since the heatmap's grid element is recreated.
let availabilityGridLayout = 'week';
let availabilityDaySelectedDateKey = null; // yyyy-MM-dd, in the viewer's zone
const availabilityDayToggleButtons = Array.from(document.querySelectorAll('.availabilityDayToggleBtn'));
const availabilityDayNavs = Array.from(document.querySelectorAll('.availabilityDayNav'));
const availabilityDayNavLabels = Array.from(document.querySelectorAll('.availabilityDayNavLabel'));
const availabilityDayNavButtons = Array.from(document.querySelectorAll('.availabilityDayNavBtn'));
const availabilityHeatmapLayoutRow = document.querySelector('.availabilityHeatmapLayoutRow');

function getAvailabilityDayColumnIndex(columns) {
    const index = columns.findIndex(({ date }) => date.toISODate() === availabilityDaySelectedDateKey);
    return index === -1 ? 0 : index;
}

function applyAvailabilityGridLayout() {
    const isDayMode = availabilityGridLayout === 'day';
    const columns = getAvailabilityColumns();
    const dayIndex = getAvailabilityDayColumnIndex(columns);
    const { date } = columns[dayIndex];
    availabilityDaySelectedDateKey = date.toISODate();

    // The heatmap may have no grid at all (nobody painted yet, or not
    // rendered yet) - its toggle row only shows when there is one to filter.
    const heatmapGridEl = availabilityHeatmapWrap?.querySelector('.availabilityHeatmapGrid');
    [availabilityGridEl, heatmapGridEl].forEach((gridEl) => {
        if (gridEl) {
            gridEl.classList.toggle('dayMode', isDayMode);
            gridEl.dataset.dayCol = String(dayIndex);
        }
    });
    availabilityHeatmapLayoutRow?.classList.toggle('hidden', !heatmapGridEl);

    availabilityDayToggleButtons.forEach((button) => {
        const isActive = button.dataset.gridLayout === availabilityGridLayout;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
    availabilityDayNavs.forEach((nav) => nav.classList.toggle('hidden', !isDayMode));
    const labelText = dayIndex === 0
        ? `Today, ${date.toFormat('ccc MMM d')}`
        : date.toFormat('cccc, MMM d');
    availabilityDayNavLabels.forEach((label) => {
        label.textContent = labelText;
    });
    availabilityDayNavButtons.forEach((button) => {
        const step = Number(button.dataset.dayStep);
        button.disabled = step < 0 ? dayIndex === 0 : dayIndex === columns.length - 1;
    });
}

availabilityDayToggleButtons.forEach((button) => {
    button.addEventListener('click', () => {
        playClickSound();
        availabilityGridLayout = button.dataset.gridLayout === 'day' ? 'day' : 'week';
        applyAvailabilityGridLayout();
    });
});

availabilityDayNavButtons.forEach((button) => {
    button.addEventListener('click', () => {
        playClickSound();
        const columns = getAvailabilityColumns();
        const target = getAvailabilityDayColumnIndex(columns) + Number(button.dataset.dayStep);
        const clamped = Math.max(0, Math.min(columns.length - 1, target));
        availabilityDaySelectedDateKey = columns[clamped].date.toISODate();
        applyAvailabilityGridLayout();
    });
});

function buildAvailabilityGridDomIfNeeded() {
    const rangeKey = getAvailabilityGridRangeKey();
    if (!availabilityGridEl || availabilityGridBuiltForRangeKey === rangeKey) {
        return;
    }
    availabilityGridEl.innerHTML = '';

    // Today-first column order (see getAvailabilityColumns) - columns[0] is
    // always today, regardless of which absolute jsWeekday that is. Cells
    // still carry the ABSOLUTE jsWeekday in dataset.weekday (storage/
    // painting logic is entirely keyed on that, unaware of column
    // position), so nothing below this loop needs to change.
    const columns = getAvailabilityColumns();

    const corner = document.createElement('div');
    corner.className = 'availabilityGridCorner';
    availabilityGridEl.appendChild(corner);

    columns.forEach(({ jsWeekday, date }) => {
        const header = document.createElement('div');
        header.className = 'availabilityGridDayHeader';
        const nameSpan = document.createElement('span');
        nameSpan.textContent = AVAILABILITY_WEEKDAY_LABELS[jsWeekday];
        const dateSpan = document.createElement('span');
        dateSpan.className = 'availabilityGridDateLabel';
        dateSpan.textContent = date.toFormat('MMM d');
        header.appendChild(nameSpan);
        header.appendChild(dateSpan);
        availabilityGridEl.appendChild(header);
    });

    const totalHours = availabilityCurrentHourRange.endHour - availabilityCurrentHourRange.startHour;
    for (let hourOffset = 0; hourOffset < totalHours; hourOffset += 1) {
        for (let half = 0; half < 2; half += 1) {
            const isHourStart = half === 0;
            const label = document.createElement('div');
            label.className = `availabilityGridTimeLabel${isHourStart ? '' : ' halfHour'}`;
            if (isHourStart) {
                label.textContent = formatAvailabilityHourLabel(availabilityCurrentHourRange.startHour + hourOffset);
            }
            availabilityGridEl.appendChild(label);

            const slotPairIndex = hourOffset * 2 + half;
            columns.forEach(({ jsWeekday }) => {
                const cell = document.createElement('div');
                cell.className = `availabilityGridCell${isHourStart ? ' hourStart' : ''}`;
                cell.dataset.weekday = String(jsWeekday);
                cell.dataset.slotPair = String(slotPairIndex);
                availabilityGridEl.appendChild(cell);
            });
        }
    }

    attachAvailabilityGridPointerEvents();
    // Set only once the build actually succeeds - real bug caught live
    // (peer-tested): setting this BEFORE building meant a thrown error
    // partway through (e.g. a stale reference during active development)
    // left the grid with zero cells, permanently, since every later render
    // would see the range key already "built" and skip rebuilding entirely
    // until a full page reload. Setting it last means a failed build stays
    // retriable on the very next render instead.
    availabilityGridBuiltForRangeKey = rangeKey;
    // Re-resolves the Day-mode column against the new column order (a
    // rollover rebuild shifts every date one column left) and refreshes the
    // "Today, ..." label; mode and selected date carry over unchanged.
    applyAvailabilityGridLayout();
}

function getAvailabilitySlotPairValue(jsWeekday, slotPairIndex) {
    const packed = availabilityWeekdaySlots[String(jsWeekday)];
    const [a] = slotPairToStorageIndices(slotPairIndex);
    return packed[a];
}

function applyAvailabilityCellVisual(cell) {
    const jsWeekday = Number(cell.dataset.weekday);
    const slotPairIndex = Number(cell.dataset.slotPair);
    const value = getAvailabilitySlotPairValue(jsWeekday, slotPairIndex);
    const state = AVAILABILITY_VALUE_TO_STATE[value] || 'busy';
    cell.classList.remove('state-free', 'state-busy', 'state-ifNeeded');
    cell.classList.add(`state-${state}`);
}

function paintAllAvailabilityCellsFromState() {
    if (!availabilityGridEl || !availabilityWeekdaySlots) {
        return;
    }
    availabilityGridEl.querySelectorAll('.availabilityGridCell').forEach((cell) => {
        applyAvailabilityCellVisual(cell);
    });
}

// Both UI-row halves (the two underlying 15-min slots a single 30-min row
// represents) are always painted together - the UI never exposes 15-min
// granularity directly, only storage needs it (see availability-plan.md's
// Timezone Strategy for why 15-min storage matters even with 30-min rows).
function paintAvailabilitySlotPair(jsWeekday, slotPairIndex, value) {
    const key = String(jsWeekday);
    const packed = availabilityWeekdaySlots[key];
    const [a, b] = slotPairToStorageIndices(slotPairIndex);
    if (packed[a] === value && packed[b] === value) {
        return false;
    }
    availabilityWeekdaySlots[key] = packed.slice(0, a) + value + value + packed.slice(b + 1);
    availabilityHasBeenPainted = true;
    return true;
}

function paintAvailabilityCellFromDom(cell) {
    availabilityLastPaintedCell = cell;
    const jsWeekday = Number(cell.dataset.weekday);
    const slotPairIndex = Number(cell.dataset.slotPair);
    const changed = paintAvailabilitySlotPair(jsWeekday, slotPairIndex, availabilityPaintValue);
    if (changed) {
        applyAvailabilityCellVisual(cell);
        scheduleAvailabilitySave();
    }
}

// Attached to the GRID CONTAINER, not per-cell - pointer capture (explicit
// for mouse, implicit for touch) redirects every later event in a gesture
// to one element, so per-cell pointerenter/pointerover listeners would
// never fire as the pointer drags across other cells. pointermove on the
// container + elementFromPoint is what actually finds the cell under the
// pointer during a drag. elementFromPoint takes viewport coordinates, same
// as clientX/clientY, so it stays correct however far .availabilityGridScroll
// (or the page) is scrolled; a point over a sticky day header or time label
// resolves to that label, not a cell, so nothing hidden under it paints.
//
// Mouse strokes start on pointerdown. Touch strokes can't: the browser fixes
// touch-action at the START of a touch, so switching it to 'none' from
// pointerdown is already too late and a vertical drag turns into a scroll
// (pointercancel, only one cell painted). Cells therefore keep native
// scrolling (touch-action: pan-x pan-y in style.css) and a touch gesture is
// read by intent instead:
// - a quick tap paints the one cell under the finger,
// - a swipe scrolls the grid/page as normal (the browser takes over and
//   fires pointercancel, and nothing gets painted),
// - press and hold (AVAILABILITY_TOUCH_HOLD_MS) arms a stroke, shown by the
//   grid's .painting outline plus a short vibration where supported, and
//   dragging after that paints. The non-passive touchmove listener below is
//   what stops that armed drag from becoming a scroll: preventDefault on a
//   still-cancelable touchmove works mid-gesture, unlike touch-action.
// A pen that hovers first (most active styluses) gets .penReady, which
// switches cells to touch-action:none BEFORE contact, so it can stroke
// immediately like a mouse. A pen that can't hover falls back to the touch
// rules.
function attachAvailabilityGridPointerEvents() {
    if (!availabilityGridEl || availabilityGridEventsAttached) {
        return;
    }
    availabilityGridEventsAttached = true;

    const AVAILABILITY_TOUCH_HOLD_MS = 300;
    const AVAILABILITY_TOUCH_SLOP_PX = 10;
    const AVAILABILITY_AUTOSCROLL_EDGE_PX = 28;
    const AVAILABILITY_AUTOSCROLL_MAX_STEP_PX = 14;

    let strokePointerId = null;
    let pendingPress = null; // { pointerId, cell, startX, startY, timer } for a touch press not yet armed
    let lastPointerX = 0;
    let lastPointerY = 0;
    let lastPointerType = 'mouse';
    let autoScrollFrame = 0;
    let strokeGroupId = null;

    const paintCellAtPoint = (x, y) => {
        // A group switch mid-stroke (renderGroupAvailabilityView nulls
        // availabilityWeekdaySlots, then refetches) would otherwise throw on
        // the null slots, or, once the new fetch lands, carry the old
        // group's stroke onto the new group's grid.
        if (availabilityLoadedForGroupId !== strokeGroupId || !availabilityWeekdaySlots) {
            endStroke();
            return;
        }
        const cell = document.elementFromPoint(x, y)?.closest('.availabilityGridCell');
        if (cell && availabilityGridEl.contains(cell) && cell !== availabilityLastPaintedCell) {
            paintAvailabilityCellFromDom(cell);
        }
    };

    const startStroke = (cell, pointerId) => {
        // A detached cell means the grid was rebuilt (hour range change,
        // day rollover) while a touch press was pending. Its slotPair index
        // is relative to the OLD start hour (see slotPairToStorageIndices),
        // so painting it would write the wrong time - drop it instead.
        if (!cell.isConnected || !availabilityWeekdaySlots) {
            return;
        }
        strokeGroupId = availabilityLoadedForGroupId;
        strokePointerId = pointerId;
        availabilityIsPainting = true;
        availabilityPaintValue = AVAILABILITY_STATE_TO_VALUE[availabilityActiveBrush];
        availabilityLastPaintedCell = null;
        availabilityGridEl.classList.add('painting');
        paintAvailabilityCellFromDom(cell);
    };

    const endStroke = () => {
        strokePointerId = null;
        if (autoScrollFrame) {
            cancelAnimationFrame(autoScrollFrame);
            autoScrollFrame = 0;
        }
        if (!availabilityIsPainting) {
            return;
        }
        availabilityIsPainting = false;
        availabilityGridEl.classList.remove('painting');
    };

    const cancelPendingPress = () => {
        if (pendingPress) {
            clearTimeout(pendingPress.timer);
            pendingPress = null;
        }
    };

    // While a stroke is active the page and grid can't scroll by touch, so
    // holding the pointer near an edge of the scroll box scrolls it instead
    // (faster the closer to the edge), painting whatever slides underneath.
    // Edges are measured inside the sticky header row / time-label column
    // and clipped to the viewport, since those are where the finger can
    // actually reach a cell.
    const autoScrollStep = () => {
        autoScrollFrame = 0;
        const scrollEl = availabilityGridEl.closest('.availabilityGridScroll');
        if (!availabilityIsPainting || !scrollEl) {
            return;
        }
        const box = scrollEl.getBoundingClientRect();
        const cornerBox = availabilityGridEl.querySelector('.availabilityGridCorner')?.getBoundingClientRect();
        const top = Math.max(cornerBox ? cornerBox.bottom : box.top, 0);
        const left = Math.max(cornerBox ? cornerBox.right : box.left, 0);
        const bottom = Math.min(box.bottom, window.innerHeight);
        const right = Math.min(box.right, window.innerWidth);
        const edge = AVAILABILITY_AUTOSCROLL_EDGE_PX;
        const speed = (distanceIntoEdge) => Math.ceil(AVAILABILITY_AUTOSCROLL_MAX_STEP_PX * Math.min(1, distanceIntoEdge / edge));
        let dx = 0;
        let dy = 0;
        if (lastPointerY < top + edge) {
            dy = -speed(top + edge - lastPointerY);
        } else if (lastPointerY > bottom - edge) {
            dy = speed(lastPointerY - (bottom - edge));
        }
        if (lastPointerX < left + edge) {
            dx = -speed(left + edge - lastPointerX);
        } else if (lastPointerX > right - edge) {
            dx = speed(lastPointerX - (right - edge));
        }
        if (!dx && !dy) {
            return;
        }
        const beforeTop = scrollEl.scrollTop;
        const beforeLeft = scrollEl.scrollLeft;
        scrollEl.scrollTop += dy;
        scrollEl.scrollLeft += dx;
        if (scrollEl.scrollTop === beforeTop && scrollEl.scrollLeft === beforeLeft) {
            return; // already at the end in that direction
        }
        paintCellAtPoint(lastPointerX, lastPointerY);
        autoScrollFrame = requestAnimationFrame(autoScrollStep);
    };

    availabilityGridEl.addEventListener('pointerdown', (event) => {
        lastPointerType = event.pointerType;
        const cell = event.target.closest('.availabilityGridCell');
        if (!cell || strokePointerId !== null || pendingPress) {
            return; // not a cell, or a second finger while one is already busy
        }
        if (event.pointerType === 'mouse' && event.button !== 0) {
            return;
        }
        lastPointerX = event.clientX;
        lastPointerY = event.clientY;

        const strokesImmediately = event.pointerType === 'mouse'
            || (event.pointerType === 'pen' && availabilityGridEl.classList.contains('penReady'));
        if (strokesImmediately) {
            event.preventDefault();
            try {
                availabilityGridEl.setPointerCapture(event.pointerId);
            } catch (error) {
                // Pointer already gone (released between dispatch and here) - the stroke just ends on the next pointerup.
            }
            startStroke(cell, event.pointerId);
            return;
        }

        const pointerId = event.pointerId;
        pendingPress = {
            pointerId,
            cell,
            startX: event.clientX,
            startY: event.clientY,
            timer: setTimeout(() => {
                if (!pendingPress || pendingPress.pointerId !== pointerId) {
                    return;
                }
                const armedCell = pendingPress.cell;
                pendingPress = null;
                startStroke(armedCell, pointerId);
                try {
                    navigator.vibrate?.(12);
                } catch (error) {
                    // Haptics are a nice-to-have; the .painting outline is the real cue.
                }
            }, AVAILABILITY_TOUCH_HOLD_MS)
        };
    });

    availabilityGridEl.addEventListener('pointermove', (event) => {
        if (event.pointerType === 'pen' && event.buttons === 0) {
            availabilityGridEl.classList.add('penReady');
        }
        if (pendingPress && event.pointerId === pendingPress.pointerId) {
            const movedX = event.clientX - pendingPress.startX;
            const movedY = event.clientY - pendingPress.startY;
            if (Math.hypot(movedX, movedY) > AVAILABILITY_TOUCH_SLOP_PX) {
                cancelPendingPress(); // moving before the hold completes means scrolling
            }
            return;
        }
        if (!availabilityIsPainting || event.pointerId !== strokePointerId) {
            return;
        }
        lastPointerX = event.clientX;
        lastPointerY = event.clientY;
        paintCellAtPoint(lastPointerX, lastPointerY);
        if (!autoScrollFrame) {
            autoScrollFrame = requestAnimationFrame(autoScrollStep);
        }
    });

    // Ends are listened for on window, not the grid: if the grid is rebuilt
    // mid-gesture (hour range change) the captured cell is detached and the
    // release no longer bubbles through the grid, which would otherwise
    // leave strokePointerId set and block every later stroke.
    window.addEventListener('pointerup', (event) => {
        if (pendingPress && event.pointerId === pendingPress.pointerId) {
            // Lifted before the hold armed: a tap paints just this one cell.
            const tappedCell = pendingPress.cell;
            cancelPendingPress();
            startStroke(tappedCell, event.pointerId);
            endStroke();
            return;
        }
        if (event.pointerId === strokePointerId) {
            endStroke();
        }
    });

    window.addEventListener('pointercancel', (event) => {
        if (pendingPress && event.pointerId === pendingPress.pointerId) {
            cancelPendingPress(); // the browser started a scroll - nothing to paint
        }
        if (event.pointerId === strokePointerId) {
            endStroke();
        }
    });

    availabilityGridEl.addEventListener('pointerleave', (event) => {
        if (event.pointerType === 'pen' && event.buttons === 0) {
            availabilityGridEl.classList.remove('penReady');
        }
    });

    availabilityGridEl.addEventListener('touchmove', (event) => {
        if (availabilityIsPainting && event.cancelable) {
            event.preventDefault();
        }
    }, { passive: false });

    // A long press would otherwise pop the context menu / iOS callout right
    // as the stroke arms.
    availabilityGridEl.addEventListener('contextmenu', (event) => {
        if (lastPointerType !== 'mouse' && event.target.closest('.availabilityGridCell')) {
            event.preventDefault();
        }
    });
}

function scheduleAvailabilitySave() {
    if (availabilitySaveTimer) {
        clearTimeout(availabilitySaveTimer);
    }
    if (availabilitySaveStatus) {
        availabilitySaveStatus.textContent = 'Saving...';
    }
    // Debounced, not per-cell/per-stroke - a whole painting session
    // coalesces into one write ~1.5s after the last change, given the
    // earlier write-quota incident this session (see
    // single-firebase-project-no-staging memory / availability-plan.md's
    // Risks). The beforeunload flush below covers closing the tab before
    // this fires.
    availabilitySaveTimer = setTimeout(() => {
        availabilitySaveTimer = null;
        // Found live: a slow drag that pauses over 1.5s with the pointer
        // still down fired a write mid-stroke (7 writes for 7 cells with
        // ~3s gaps). Never save while a stroke is in progress - check again
        // one debounce later, so the save lands after the stroke ends.
        if (availabilityIsPainting) {
            scheduleAvailabilitySave();
            return;
        }
        saveAvailabilityNow();
    }, AVAILABILITY_SAVE_DEBOUNCE_MS);
}

async function saveAvailabilityNow() {
    // Real bug caught by peer review: this used to resolve the target via
    // getSelectedGroup() at FIRE time (1.5s after the debounce started),
    // not the group the in-memory grid actually belongs to
    // (availabilityLoadedForGroupId). Painting in group A, then switching
    // to group B within that window, would silently write A's grid into
    // B's availability doc once the timer fired - a real cross-group data
    // corruption path, not a hypothetical. Snapshotting both the target
    // group id and the data itself at call time (rather than re-reading
    // module state after the fact) also means a group-switch reset
    // happening between now and the await below can't retroactively change
    // what gets written.
    const groupId = availabilityLoadedForGroupId;
    // Backstop for the same privacy promise as applyAvailabilityTimezone:
    // never create a group-readable doc for a grid nobody painted. Painting
    // and the "save this untouched grid anyway?" confirm both set the flag
    // before calling here.
    if (!groupId || !currentUser || !availabilityWeekdaySlots || !availabilityHasBeenPainted) {
        return;
    }
    const weekdaySlotsToSave = availabilityWeekdaySlots;
    const timezoneToSave = availabilityTimezone || detectBrowserTimezone();
    const hasBeenPaintedToSave = availabilityHasBeenPainted;
    const { doc, setDoc, serverTimestamp } = fs();
    try {
        await setDoc(doc(db(), 'groups', groupId, 'availability', currentUser.uid), {
            weekdaySlots: weekdaySlotsToSave,
            timezone: timezoneToSave,
            hasBeenPainted: hasBeenPaintedToSave,
            updatedAt: serverTimestamp()
        });
        if (availabilitySaveStatus) {
            availabilitySaveStatus.textContent = 'Saved';
            setTimeout(() => {
                if (availabilitySaveStatus && availabilitySaveStatus.textContent === 'Saved') {
                    availabilitySaveStatus.textContent = '';
                }
            }, 2000);
        }
    } catch (error) {
        console.error('Failed to save availability:', error);
        if (availabilitySaveStatus) {
            availabilitySaveStatus.textContent = describeGroupWriteError(error, 'Could not save.');
        }
    }
}

window.addEventListener('beforeunload', () => {
    if (availabilitySaveTimer) {
        // Can't await inside beforeunload - firing the write is still
        // better than silently losing the last stroke if the debounce
        // hadn't settled yet.
        clearTimeout(availabilitySaveTimer);
        availabilitySaveTimer = null;
        saveAvailabilityNow();
    }
});

// Legacy IANA names some engines (Chromium's ICU, historically) still report
// from both Intl.supportedValuesOf and resolvedOptions() - mapped to the
// modern name so search ("Kolkata"), display, and same-zone comparison all
// work regardless of which spelling a browser hands back. Only swapped to
// the modern name when this engine actually accepts it (Europe/Kyiv is
// newer than some ICU builds).
const LEGACY_TIMEZONE_ALIASES = {
    'Asia/Calcutta': 'Asia/Kolkata',
    'Asia/Katmandu': 'Asia/Kathmandu',
    'Europe/Kiev': 'Europe/Kyiv',
    'Asia/Saigon': 'Asia/Ho_Chi_Minh',
    'Asia/Rangoon': 'Asia/Yangon',
    'America/Godthab': 'America/Nuuk',
    'Atlantic/Faeroe': 'Atlantic/Faroe',
    'Pacific/Truk': 'Pacific/Chuuk',
    'Pacific/Ponape': 'Pacific/Pohnpei',
    'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
    'America/Indianapolis': 'America/Indiana/Indianapolis',
    'America/Louisville': 'America/Kentucky/Louisville'
};
const MODERN_TO_LEGACY_TIMEZONE = Object.fromEntries(
    Object.entries(LEGACY_TIMEZONE_ALIASES).map(([legacy, modern]) => [modern, legacy])
);

// Canonical case (Intl accepts "america/edmonton" and hands back
// "America/Edmonton") plus legacy -> modern name. Returns null for anything
// that isn't a real zone. Every zone comparison in the picker goes through
// this, never raw ===.
function normalizeTimezoneName(zone) {
    if (!zone || !luxon.IANAZone.isValidZone(zone)) {
        return null;
    }
    let canonical = zone;
    try {
        canonical = new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone || zone;
    } catch {
        canonical = zone;
    }
    const modern = LEGACY_TIMEZONE_ALIASES[canonical];
    return modern && luxon.IANAZone.isValidZone(modern) ? modern : canonical;
}

// Profile save first, local state only after it succeeds - so a failed
// write never leaves the label (or the next debounced availability save)
// using a zone that was never actually stored. Then re-stamps the zone
// onto every OTHER group's availability doc this user has painted, so
// teammates there don't keep seeing the grid in the old zone. One write
// per painted group, only on this rare action. updateDoc on a group the
// user never painted fails with not-found - expected, ignored.
async function applyAvailabilityTimezone(zone) {
    if (!currentUser) {
        return;
    }
    const normalized = normalizeTimezoneName(zone);
    const current = normalizeTimezoneName(availabilityTimezone || detectBrowserTimezone());
    if (!normalized || normalized === current) {
        return;
    }

    await saveProfileTimezone(currentUser, normalized);

    availabilityTimezone = normalized;
    if (availabilityTimezoneName) {
        availabilityTimezoneName.textContent = normalized;
    }
    // The paint grid's column order and dates come from the SAVED zone (see
    // getAvailabilityColumns), so rebuild it now. Found live: without this
    // the heatmap and Best times switched days immediately but the paint
    // grid kept the old zone's column order until the 60-second timer fired.
    if (availabilityWeekdaySlots) {
        buildAvailabilityGridDomIfNeeded();
        paintAllAvailabilityCellsFromState();
    }
    // Only a PAINTED grid is saved here. An untouched auto-init grid must
    // not become a group-readable doc just because the zone changed
    // (privacy.html promises teammates only see the zone on a grid you've
    // actually painted); its doc gets the new zone on the first real paint.
    // An unpainted current group falls through to the existence-checked
    // loop below instead, which also covers an older doc that exists with
    // hasBeenPainted false.
    const currentGroupHandledByDebounce = Boolean(availabilityWeekdaySlots && availabilityHasBeenPainted);
    if (currentGroupHandledByDebounce) {
        scheduleAvailabilitySave();
    }

    // getDoc first rather than relying on updateDoc's not-found: rules run
    // before the existence check, and the update rule's diff(resource.data)
    // errors on a missing doc - so an unpainted group comes back as
    // permission-denied, indistinguishable from a real failure. One read
    // per group, only on this rare action.
    const { doc, getDoc, updateDoc, serverTimestamp } = fs();
    const otherGroups = (groups || []).filter((group) => !(currentGroupHandledByDebounce && group.id === availabilityLoadedForGroupId));
    await Promise.all(otherGroups.map(async (group) => {
        const availabilityRef = doc(db(), 'groups', group.id, 'availability', currentUser.uid);
        try {
            const snapshot = await getDoc(availabilityRef);
            if (!snapshot.exists()) {
                return;
            }
            await updateDoc(availabilityRef, { timezone: normalized, updatedAt: serverTimestamp() });
        } catch (error) {
            console.error(`Failed to update timezone on group ${group.id} availability:`, error);
        }
    }));
}

// Timezone picker - same build-fresh-on-open .taskEditorOverlay chrome as
// the handoff picker (see openHandoffPicker), reusing its list/row styling
// and, like it, plain buttons rather than a listbox role (no arrow-key
// navigation to promise). Each row shows the zone's CURRENT local time, so
// someone can recognize "that's evening there" without knowing UTC
// offsets - the real fix for a misconfigured OS zone (e.g. Regina vs
// Edmonton, which share an offset for part of the year) is being able to
// see and pick, not type IANA syntax from memory. Search matches the zone
// name (and its legacy alias); IANA has no entry for every city (no
// "Calgary"), an accepted v1 limitation.
let timezonePickerOverlay = null;
let timezonePickerKeydownHandler = null;
let timezonePickerReturnFocusEl = null;

function getAllTimezoneNames() {
    let zones = [];
    try {
        zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
    } catch {
        zones = [];
    }
    const normalized = new Set();
    zones.forEach((zone) => {
        const name = normalizeTimezoneName(zone);
        if (name) {
            normalized.add(name);
        }
    });
    normalized.add('UTC');
    return Array.from(normalized).sort();
}

function formatTimezoneLabel(zone) {
    return zone.replace(/_/g, ' ');
}

function openTimezonePicker() {
    if (!currentUser) {
        return;
    }
    closeTimezonePicker();
    timezonePickerReturnFocusEl = document.activeElement;

    const detected = normalizeTimezoneName(detectBrowserTimezone()) || 'UTC';
    const current = normalizeTimezoneName(availabilityTimezone) || detected;
    const allZones = getAllTimezoneNames();
    [current, detected].forEach((zone) => {
        if (!allZones.includes(zone)) {
            allZones.push(zone);
        }
    });

    // Formatted once per open, not per keystroke - ~400 Luxon zone
    // conversions on every input event is real jank on a low-end phone.
    const now = luxon.DateTime.now();
    const timeByZone = new Map(allZones.map((zone) => [zone, now.setZone(zone).toFormat('h:mm a, ccc')]));
    const searchTextByZone = new Map(allZones.map((zone) => [
        zone,
        `${zone} ${MODERN_TO_LEGACY_TIMEZONE[zone] || ''}`.toLowerCase()
    ]));

    timezonePickerOverlay = document.createElement('div');
    timezonePickerOverlay.className = 'taskEditorOverlay timezonePickerOverlay open';
    timezonePickerOverlay.innerHTML = `
        <div class="taskEditorCard handoffPickerCard" role="dialog" aria-modal="true" aria-label="Choose your timezone">
            <h2>Your Timezone</h2>
            <p class="handoffPickerHint">Pick the zone you're actually in. The time next to each one is the time there right now. Your painted hours keep their clock times in the new zone, so 9 to 5 stays 9 to 5.</p>
            <input type="text" class="editorTextInput timezonePickerSearch" placeholder="Search, e.g. Edmonton, Kolkata, London" autocomplete="off" spellcheck="false" aria-label="Search timezones">
            <div class="handoffPickerList timezonePickerList" aria-label="Timezones"></div>
            <div class="editorActions">
                <button type="button" class="editorCancelBtn timezonePickerCancelBtn">Cancel</button>
            </div>
        </div>
    `;
    document.body.appendChild(timezonePickerOverlay);

    const card = timezonePickerOverlay.querySelector('.taskEditorCard');
    const searchInput = timezonePickerOverlay.querySelector('.timezonePickerSearch');
    const list = timezonePickerOverlay.querySelector('.timezonePickerList');

    const pick = (zone) => {
        playClickSound();
        closeTimezonePicker();
        applyAvailabilityTimezone(zone).catch((error) => {
            console.error('Failed to save timezone:', error);
            alert(describeGroupWriteError(error, 'Could not save your timezone.'));
        });
    };

    const buildRow = (zone, tag) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.classList.add('handoffPickerRow', 'timezonePickerRow');
        if (zone === current) {
            row.classList.add('selected');
            row.setAttribute('aria-current', 'true');
        }
        const name = document.createElement('span');
        name.classList.add('timezonePickerName');
        name.textContent = formatTimezoneLabel(zone);
        row.appendChild(name);
        if (tag) {
            const tagEl = document.createElement('span');
            tagEl.classList.add('timezonePickerTag');
            tagEl.textContent = tag;
            row.appendChild(tagEl);
        }
        const time = document.createElement('span');
        time.classList.add('timezonePickerTime');
        time.textContent = timeByZone.get(zone) || '';
        row.appendChild(time);
        row.addEventListener('click', () => pick(zone));
        return row;
    };

    let visibleZones = [];
    const renderList = () => {
        const query = searchInput.value.trim().toLowerCase().replace(/\s+/g, '_');
        list.textContent = '';
        visibleZones = [];

        if (!query) {
            // Common case first: the saved zone, and the auto-detected one
            // if it differs, pinned at the top - a correct auto-detect needs
            // zero searching.
            const pinned = current === detected ? [current] : [current, detected];
            pinned.forEach((zone) => {
                let tag = 'Detected';
                if (zone === current) {
                    tag = current === detected ? 'Current, detected' : 'Current';
                }
                list.appendChild(buildRow(zone, tag));
                visibleZones.push(zone);
            });
            allZones.filter((zone) => !pinned.includes(zone)).forEach((zone) => {
                list.appendChild(buildRow(zone));
                visibleZones.push(zone);
            });
            return;
        }

        visibleZones = allZones.filter((zone) => searchTextByZone.get(zone).includes(query));
        // A valid zone the browser's list doesn't include (older browsers
        // without Intl.supportedValuesOf) can still be typed exactly -
        // normalized first, so an oddly-cased entry is saved canonically.
        if (visibleZones.length === 0) {
            const typed = normalizeTimezoneName(searchInput.value.trim());
            if (typed) {
                timeByZone.set(typed, now.setZone(typed).toFormat('h:mm a, ccc'));
                visibleZones = [typed];
            }
        }
        if (visibleZones.length === 0) {
            const empty = document.createElement('p');
            empty.classList.add('handoffPickerHint');
            empty.textContent = 'No matching timezone. Try a nearby major city or your region name.';
            list.appendChild(empty);
            return;
        }
        visibleZones.forEach((zone) => list.appendChild(buildRow(zone)));
    };

    renderList();
    searchInput.addEventListener('input', renderList);
    searchInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && visibleZones.length > 0) {
            event.preventDefault();
            pick(visibleZones[0]);
        }
    });

    // Bound on document (not the overlay) so Esc still works after focus
    // falls to <body>, and Tab is trapped inside the card instead of
    // walking into the page behind the overlay. Removed in closeTimezonePicker.
    timezonePickerKeydownHandler = (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeTimezonePicker();
            return;
        }
        if (event.key !== 'Tab') {
            return;
        }
        const focusables = Array.from(card.querySelectorAll('input, button')).filter((el) => !el.disabled);
        if (focusables.length === 0) {
            return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (!card.contains(document.activeElement)) {
            event.preventDefault();
            first.focus();
        } else if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    };
    document.addEventListener('keydown', timezonePickerKeydownHandler);

    timezonePickerOverlay.querySelector('.timezonePickerCancelBtn').addEventListener('click', () => {
        playClickSound();
        closeTimezonePicker();
    });
    timezonePickerOverlay.addEventListener('click', (event) => {
        if (event.target === timezonePickerOverlay) {
            closeTimezonePicker();
        }
    });

    // Skip autofocus on touch devices - it pops the on-screen keyboard
    // immediately and covers the pinned rows the common case needs.
    if (window.matchMedia('(pointer: coarse)').matches) {
        card.setAttribute('tabindex', '-1');
        card.focus();
    } else {
        searchInput.focus();
    }
}

function closeTimezonePicker() {
    if (timezonePickerKeydownHandler) {
        document.removeEventListener('keydown', timezonePickerKeydownHandler);
        timezonePickerKeydownHandler = null;
    }
    if (!timezonePickerOverlay) {
        return;
    }
    timezonePickerOverlay.remove();
    timezonePickerOverlay = null;
    const returnTo = timezonePickerReturnFocusEl && document.contains(timezonePickerReturnFocusEl)
        ? timezonePickerReturnFocusEl
        : availabilityChangeTimezoneBtn;
    timezonePickerReturnFocusEl = null;
    returnTo?.focus();
}

availabilityChangeTimezoneBtn?.addEventListener('click', () => {
    playClickSound();
    openTimezonePicker();
});

// ---------------------------------------------------------------------
// Availability Phase 5 - "best times to meet" panel. Always live: rebuilt
// from getScorableGroupMembers (the one shared availability listener, see
// ensureGroupAvailabilitySubscription) on every renderApp, memoized so an
// unrelated re-render (a task edit, say) doesn't redo the search.
//
// Three input fixes on top of findBestMeetingTimes, all found by reading
// availability-timezone.js against how the grid actually stores data:
// - hourRange is always the FULL day ({0, 24}), because weekdaySlots is
//   always 96 slots from midnight - passing the group's display range
//   (7-23 by default) would shift every slot by startHour hours.
// - The group's display range is each member's "usual hours" (in their OWN
//   local time). A window outside anyone's usual hours is never suggested
//   (findBestMeetingTimes' rollingWindow.viewHourRange). New members start
//   all-free around the clock, so without this the top pick would be
//   something like "Tuesday 12:00 am, everyone free". This used to mask
//   those hours to BUSY, which let "3:00 am" through as a partial match
//   with the reason "<name> is busy" for a slot they had left free.
// - The search is a ROLLING window: every 15-min instant from the next slot
//   boundary through now + 7 days, each member read at that instant in
//   their own zone (findBestMeetingTimes' rollingWindow option). This used
//   to use the weekAnchor path anchored on the viewer's today + 3, which
//   gave members far apart in zone (Kolkata vs Edmonton) week spans offset
//   by most of a day, so a slot free for everyone right now could score as
//   busy - see cases 8 and 9 in availability-timezone.test.html. Starting
//   at the next slot boundary also means nothing already under way or in
//   the past is ever suggested, with no separate past-masking step.
// ---------------------------------------------------------------------

const availabilityRecommendPanel = document.querySelector('.availabilityRecommendPanel');
const AVAILABILITY_FULL_DAY_RANGE = { startHour: 0, endHour: 24 };
const AVAILABILITY_MEETING_LENGTH_OPTIONS = [
    { minutes: 15, label: '15 min' },
    { minutes: 30, label: '30 min' },
    { minutes: 45, label: '45 min' },
    { minutes: 60, label: '1 hour' },
    { minutes: 90, label: '1.5 hours' }
];

// Client-side only, deliberately never written to Firestore - each viewer
// picks a length for their own exploring, it isn't a group setting.
let availabilityMeetingLengthMinutes = 30;
let availabilityRecommendRenderKey = null;
let availabilityRecommendListEl = null;
let availabilityRecommendNoteEl = null;

function buildAvailabilityRecommendPanelIfNeeded() {
    if (!availabilityRecommendPanel || availabilityRecommendListEl) {
        return;
    }

    const header = document.createElement('div');
    header.className = 'availabilityRecommendHeader';

    const title = document.createElement('p');
    title.className = 'availabilityRecommendTitle';
    title.textContent = 'Best times to meet';

    const lengthLabel = document.createElement('label');
    lengthLabel.className = 'availabilityRecommendLengthLabel';
    lengthLabel.append('Meeting length ');
    const lengthSelect = document.createElement('select');
    lengthSelect.className = 'availabilityRecommendLengthSelect';
    AVAILABILITY_MEETING_LENGTH_OPTIONS.forEach(({ minutes, label }) => {
        const option = document.createElement('option');
        option.value = String(minutes);
        option.textContent = label;
        option.selected = minutes === availabilityMeetingLengthMinutes;
        lengthSelect.appendChild(option);
    });
    lengthSelect.addEventListener('change', () => {
        availabilityMeetingLengthMinutes = Number(lengthSelect.value) || 30;
        availabilityRecommendRenderKey = null;
        renderAvailabilityRecommendations(getSelectedGroup());
    });
    lengthLabel.appendChild(lengthSelect);

    header.appendChild(title);
    header.appendChild(lengthLabel);

    availabilityRecommendListEl = document.createElement('ol');
    availabilityRecommendListEl.className = 'availabilityRecommendList';

    availabilityRecommendNoteEl = document.createElement('p');
    availabilityRecommendNoteEl.className = 'availabilityRecommendNote';

    availabilityRecommendPanel.appendChild(header);
    availabilityRecommendPanel.appendChild(availabilityRecommendListEl);
    availabilityRecommendPanel.appendChild(availabilityRecommendNoteEl);
}

// Appends "Sam", "Sam and Alex", "Sam, Alex and Jo" - each name with its
// member-color dot, same dots the calendar legend uses.
function appendAvailabilityMemberNames(parent, members, group) {
    members.forEach((member, index) => {
        if (index > 0) {
            parent.append(index === members.length - 1 ? ' and ' : ', ');
        }
        const nameEl = document.createElement('span');
        nameEl.className = 'availabilityRecommendMember';
        const dot = document.createElement('span');
        dot.classList.add('calendarChipMemberDot', `calendarMemberColor-${getGroupMemberColorIndex(member.uid, group)}`);
        nameEl.appendChild(dot);
        nameEl.append(member.name);
        parent.appendChild(nameEl);
    });
}

function formatAvailabilityRecommendWhen(start, end, viewerZone) {
    const localStart = start.setZone(viewerZone);
    const localEnd = end.setZone(viewerZone);
    const today = luxon.DateTime.local().setZone(viewerZone).startOf('day');
    const dayOffset = Math.round(localStart.startOf('day').diff(today, 'days').days);
    const dayName = dayOffset === 0 ? 'Today' : dayOffset === 1 ? 'Tomorrow' : localStart.toFormat('cccc');
    const startMeridiem = localStart.toFormat('a').toLowerCase();
    const endMeridiem = localEnd.toFormat('a').toLowerCase();
    const timeRange = startMeridiem === endMeridiem
        ? `${localStart.toFormat('h:mm')} to ${localEnd.toFormat('h:mm')} ${endMeridiem}`
        : `${localStart.toFormat('h:mm')} ${startMeridiem} to ${localEnd.toFormat('h:mm')} ${endMeridiem}`;
    return `${dayName}, ${localStart.toFormat('LLL d')} · ${timeRange}`;
}

function buildAvailabilityRecommendItem(recommendation, rank, scoredCount, hasUnsetMembers, group, viewerZone) {
    const item = document.createElement('li');
    item.className = 'availabilityRecommendItem';
    if (recommendation.missing.length === 0) {
        item.classList.add('isEveryone');
    }

    const rankEl = document.createElement('span');
    rankEl.className = 'availabilityRecommendRank';
    rankEl.textContent = String(rank);

    const body = document.createElement('div');
    body.className = 'availabilityRecommendBody';

    const when = document.createElement('p');
    when.className = 'availabilityRecommendWhen';
    when.textContent = formatAvailabilityRecommendWhen(recommendation.start, recommendation.end, viewerZone);

    const why = document.createElement('p');
    why.className = 'availabilityRecommendWhy';
    const { missing, ifNeeded } = recommendation;
    if (missing.length === 0) {
        why.append(hasUnsetMembers ? 'Everyone who has set their availability is free' : 'Everyone is free');
        if (ifNeeded.length > 0) {
            why.append(', but ');
            appendAvailabilityMemberNames(why, ifNeeded, group);
            why.append(' marked this as if needed.');
        } else {
            why.append('.');
        }
    } else {
        why.append(`${scoredCount - missing.length} of ${scoredCount} can make it. `);
        appendAvailabilityMemberNames(why, missing, group);
        why.append(missing.length === 1 ? ' is busy.' : ' are busy.');
        if (ifNeeded.length > 0) {
            why.append(' ');
            appendAvailabilityMemberNames(why, ifNeeded, group);
            why.append(' marked this as if needed.');
        }
    }

    body.appendChild(when);
    body.appendChild(why);
    item.appendChild(rankEl);
    item.appendChild(body);
    return item;
}

function renderAvailabilityRecommendations(group) {
    if (!availabilityRecommendPanel) {
        return;
    }
    if (!group) {
        availabilityRecommendPanel.classList.add('hidden');
        availabilityRecommendRenderKey = null;
        return;
    }
    buildAvailabilityRecommendPanelIfNeeded();
    availabilityRecommendPanel.classList.remove('hidden');

    const viewerZone = getAvailabilityViewerZone();
    const viewHourRange = getAvailabilityHourRange(group);
    const scoredMembers = getScorableGroupMembers(group)
        .filter((member) => member.hasBeenPainted && luxon.IANAZone.isValidZone(member.timezone));
    const scoredUids = new Set(scoredMembers.map((member) => member.uid));
    const unsetMembers = group.memberIds
        .map((uid, index) => (scoredUids.has(uid) ? null : { uid, name: resolveMemberName(uid, group.memberNames?.[index], groupTasks) }))
        .filter(Boolean);

    // Re-search only when an input actually changed, or a new 15-min slot
    // started (so a window that just began drops off the list).
    const now = luxon.DateTime.local();
    const renderKey = JSON.stringify([
        group.id,
        availabilityMeetingLengthMinutes,
        viewerZone,
        viewHourRange.startHour,
        viewHourRange.endHour,
        Math.floor(now.toMillis() / (15 * 60 * 1000)),
        scoredMembers.map((member) => [member.uid, member.name, member.timezone, member.weekdaySlots]),
        unsetMembers.map((member) => member.name)
    ]);
    if (renderKey === availabilityRecommendRenderKey) {
        return;
    }
    availabilityRecommendRenderKey = renderKey;

    availabilityRecommendListEl.innerHTML = '';
    availabilityRecommendNoteEl.textContent = '';

    const addEmptyMessage = (text) => {
        const empty = document.createElement('li');
        empty.className = 'availabilityRecommendEmpty';
        empty.textContent = text;
        availabilityRecommendListEl.appendChild(empty);
    };

    if (scoredMembers.length < 2) {
        addEmptyMessage('Best times show up here once at least 2 members have set their availability.');
    } else {
        // findBestMeetingTimes drops windows nobody can make, and any window
        // outside ANY scored member's usual hours (viewHourRange, in their
        // own zone) - so everyone it lists as missing really marked busy.
        const recommendations = findBestMeetingTimes(
            scoredMembers,
            availabilityMeetingLengthMinutes,
            AVAILABILITY_FULL_DAY_RANGE,
            null,
            { rollingWindow: { startUtc: now.toUTC(), days: 7, viewHourRange } }
        );

        if (recommendations.length === 0) {
            addEmptyMessage("No time in the next 7 days works for anyone within everyone's usual hours yet.");
        } else {
            recommendations.forEach((recommendation, index) => {
                availabilityRecommendListEl.appendChild(buildAvailabilityRecommendItem(
                    recommendation,
                    index + 1,
                    scoredMembers.length,
                    unsetMembers.length > 0,
                    group,
                    viewerZone
                ));
            });
        }
    }

    const hourText = `${formatAvailabilityHourLabel(viewHourRange.startHour)} and ${formatAvailabilityHourLabel(viewHourRange.endHour % 24)}`;
    availabilityRecommendNoteEl.append(`Only times between ${hourText} in each person's own time zone are suggested.`);
    if (unsetMembers.length > 0) {
        availabilityRecommendNoteEl.append(' ');
        appendAvailabilityMemberNames(availabilityRecommendNoteEl, unsetMembers, group);
        availabilityRecommendNoteEl.append(unsetMembers.length === 1
            ? " hasn't set their availability yet, so they aren't counted."
            : " haven't set their availability yet, so they aren't counted.");
    }
}

// renderApp only runs on data changes, so a quiet group could otherwise
// keep showing a window that already started. Cheap: the render key above
// makes this a no-op unless a new 15-min slot has begun.
setInterval(() => {
    if (availabilitySubView === 'recommend' && availabilityRecommendPanel && !availabilityRecommendPanel.classList.contains('hidden')) {
        renderAvailabilityRecommendations(getSelectedGroup());
    }
}, 60000);

// Group calendar - same .calendarPanel markup/CSS as solo's app.html (see
// renderGroupCalendarView further down); the member-color legend is the one
// piece solo never needed. Declared here, before the nav wiring right below
// that references them (const isn't hoisted like a function declaration -
// this order matters, an earlier version of this block referencing these
// before their declaration threw a ReferenceError that halted the whole
// script, which is what caused the dashboard to hang on the loading spinner).
const groupCalendarGrid = document.querySelector('.calendarGrid');
const groupCalendarLabel = document.querySelector('.calendarLabel');
const groupCalendarPrevBtn = document.querySelector('.calendarPrevBtn');
const groupCalendarNextBtn = document.querySelector('.calendarNextBtn');
const groupCalendarTodayBtn = document.querySelector('.calendarTodayBtn');
const groupCalendarModeButtons = Array.from(document.querySelectorAll('.calendarModeBtn'));
const groupCalendarLegend = document.querySelector('.calendarMemberLegend');

// Calendar nav - direct port of solo script.js's stepCalendar/prev/next/
// Today/mode-toggle wiring, just renamed and pointed at renderGroupCalendarView.
function stepGroupCalendar(direction) {
    const next = new Date(groupCalendarAnchorDate);
    if (groupCalendarViewMode === 'month') {
        next.setDate(1); // avoid month-length overflow while stepping the month itself
        next.setMonth(next.getMonth() + direction);
    } else {
        next.setDate(next.getDate() + (direction * 7));
    }
    groupCalendarAnchorDate = next;
    renderGroupCalendarView();
}

if (groupCalendarPrevBtn) {
    groupCalendarPrevBtn.addEventListener('click', () => {
        playClickSound();
        stepGroupCalendar(-1);
    });
}

if (groupCalendarNextBtn) {
    groupCalendarNextBtn.addEventListener('click', () => {
        playClickSound();
        stepGroupCalendar(1);
    });
}

if (groupCalendarTodayBtn) {
    groupCalendarTodayBtn.addEventListener('click', () => {
        playClickSound();
        groupCalendarAnchorDate = new Date();
        renderGroupCalendarView();
    });
}

groupCalendarModeButtons.forEach((button) => {
    button.addEventListener('click', () => {
        playClickSound();
        groupCalendarViewMode = button.dataset.mode === 'week' ? 'week' : 'month';
        groupCalendarModeButtons.forEach((btn) => {
            const isActive = btn === button;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });
        renderGroupCalendarView();
    });
});

const groupInviteCode = document.querySelector('.groupInviteCode');
const groupCopyInviteBtn = document.querySelector('.groupCopyInviteBtn');
const groupCopyInviteLinkBtn = document.querySelector('.groupCopyInviteLinkBtn');
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
const suggestionOutcomesPanel = document.querySelector('.suggestionOutcomesPanel');
const handoffRequestsForYouPanel = document.querySelector('.handoffRequestsForYouPanel');
const brainDumpToggleBtn = document.querySelector('.brainDumpToggleBtn');
const groupAlertToggleBtn = document.querySelector('.groupAlertToggleBtn');
const helpTourBtn = document.querySelector('.helpTourBtn');
const navAttentionBadge = document.querySelector('.navAttentionBadge');
const navAttentionCount = document.querySelector('.navAttentionCount');
const navAttentionMenu = document.querySelector('.navAttentionMenu');
const groupOnboardingHint = document.querySelector('.groupOnboardingHint');
const groupOnboardingStartTourBtn = document.querySelector('.groupOnboardingStartTourBtn');
const groupOnboardingDismissBtn = document.querySelector('.groupOnboardingDismissBtn');
const groupCatchUpCard = document.querySelector('.groupCatchUpCard');
const groupCatchUpGroupName = document.querySelector('.groupCatchUpGroupName');
const groupCatchUpText = document.querySelector('.groupCatchUpText');
const groupCatchUpDismissBtn = document.querySelector('.groupCatchUpDismissBtn');
const groupWelcomeOverlay = document.querySelector('.groupWelcomeOverlay');
const groupWelcomeNameInput = document.querySelector('.groupWelcomeNameInput');
const groupWelcomeContinueBtn = document.querySelector('.groupWelcomeContinueBtn');
const groupUrgencyAlert = document.querySelector('.urgencyAlert');
const groupUrgencyAlertText = document.querySelector('.urgencyAlertText');
const groupNextTaskPanel = document.querySelector('.nextTaskPanel');
const groupNextTaskLabel = document.querySelector('.nextTaskPanel .nextTaskLabel');
const groupNextTaskTitle = document.querySelector('.nextTaskPanel .nextTaskTitle');
const groupNextTaskReasons = document.querySelector('.nextTaskReasons');
const teamPulseOverlay = document.querySelector('.weeklyRecapOverlay');
const teamPulseTitle = document.querySelector('.weeklyRecapTitle');
const teamPulseThisWeek = document.querySelector('.weeklyRecapThisWeek');
const teamPulseLastWeek = document.querySelector('.weeklyRecapLastWeek');
const teamPulseTopContributor = document.querySelector('.weeklyRecapStreak');
const teamPulseCloseBtn = document.querySelector('.weeklyRecapCloseBtn');
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
const pendingStepsEditorMount = document.querySelector('.pendingStepsEditorMount');
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
// Set only when subscribeToMyGroups's onError fires - see renderApp's use
// of it to avoid showing "create or join a group" when the real reason
// groups.length is 0 is a failed load, not genuinely no groups.
let groupsLoadError = null;
let selectedGroupId = null;
let groupTasks = [];
// False until subscribeToGroupTasks's first callback fires for the
// currently-selected group - lets renderGroupTasks show a loading
// skeleton instead of falsely claiming "No tasks yet" before the first
// snapshot has actually arrived. Reset on every group switch (see
// watchSelectedGroupTasks) since a different group needs its own fresh
// loading state, not whatever the previous group's was.
let hasLoadedGroupTasksOnce = false;
// Set only when the tasks listener's onError fires - lets renderGroupTasks
// tell "genuinely no tasks" apart from "failed to load" (most commonly
// stale/unpublished firestore.rules), same pattern as groupHistoryLoadError.
let groupTasksLoadError = null;
// 'month' | 'week'; groupCalendarAnchorDate is whichever date the currently
// visible month/week is anchored to - same state shape as solo's script.js,
// kept in this file's own module scope (no shared state between the two
// apps anywhere else either).
let groupCalendarViewMode = 'month';
let groupCalendarAnchorDate = new Date();
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
// Which group unsubscribeTasks is actually subscribed to right now - lets
// watchSelectedGroupTasks tell "the user switched groups" apart from
// "something else about the groups list changed" (see the comment there).
let watchedGroupId = null;
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

        // Handoff (Feature 10): only worth offering with someone else in the
        // group to hand off to, and not once the task's already done - a
        // completed task has nothing left to hand off. Two mutually
        // exclusive states, never both buttons at once: an outstanding
        // request replaces the trigger button with a cancelable pending
        // chip, same "state IS the control" pattern the roster's kick
        // button uses elsewhere.
        const groupForHandoff = getSelectedGroup();
        const canHandoff = !task.completed && (groupForHandoff?.memberIds?.length || 0) > 1;
        if (canHandoff) {
            if (task.handoffRequest) {
                const pendingBtn = document.createElement('button');
                pendingBtn.type = 'button';
                pendingBtn.classList.add('handoffPendingBtn');
                const pendingIcon = document.createElement('i');
                pendingIcon.className = 'fa-solid fa-right-left';
                pendingIcon.setAttribute('aria-hidden', 'true');
                pendingBtn.appendChild(pendingIcon);
                const pendingLabel = document.createElement('span');
                pendingLabel.classList.add('taskBtnLabel');
                // task.handoffRequest.toUserName is another member's display
                // name, user-controlled - textContent only, same reasoning
                // as renderSuggestionsForYou/renderHandoffRequestsForYou.
                pendingLabel.textContent = `Pending: ${task.handoffRequest.toUserName || 'teammate'}`;
                pendingBtn.appendChild(pendingLabel);
                pendingBtn.setAttribute('aria-label', `Cancel handoff request to ${task.handoffRequest.toUserName || 'teammate'}`);
                pendingBtn.title = 'Click to cancel this handoff request';
                pendingBtn.addEventListener('click', () => {
                    playClickSound();
                    clearTaskHandoff(groupId, task.id).catch((error) => {
                        console.error('Failed to cancel handoff request:', error);
                        alert(describeGroupWriteError(error, 'Could not cancel the handoff request.'));
                    });
                });
                taskButtons.appendChild(pendingBtn);
            } else {
                const handoffBtn = document.createElement('button');
                handoffBtn.type = 'button';
                handoffBtn.classList.add('handoffBtn');
                handoffBtn.innerHTML = '<i class="fa-solid fa-right-left"></i><span class="taskBtnLabel">Handoff</span>';
                handoffBtn.setAttribute('aria-label', 'Hand this task off to a teammate');
                handoffBtn.title = 'Hand this task off to a teammate';
                handoffBtn.addEventListener('click', () => {
                    playClickSound();
                    openHandoffPicker(groupId, task);
                });
                taskButtons.appendChild(handoffBtn);
            }
        }

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.classList.add('deleteBtn');
        deleteBtn.innerHTML = '<i class="fa-solid fa-trash"></i><span class="taskBtnLabel">Delete</span>';
        deleteBtn.setAttribute('aria-label', 'Delete task');
        deleteBtn.title = 'Delete task';
        deleteBtn.addEventListener('click', () => {
            playClickSound();
            deleteGroupTask(groupId, task.id).catch((error) => {
                console.error('Failed to delete task:', error);
                alert(describeGroupWriteError(error, 'Could not delete the task.'));
            });
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
            alert(describeGroupWriteError(error, 'Could not update the task.'));
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
    }).catch((error) => {
        console.error('Failed to snooze task:', error);
        alert(describeGroupWriteError(error, 'Could not snooze the task.'));
    });
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
        // Tear the listener down on collapse - leaving it running for the
        // rest of the group session (until group switch/sign-out) was an
        // unbounded listener leak for anyone who expands comments on many
        // tasks over time.
        if (commentUnsubscribes[task.id]) {
            commentUnsubscribes[task.id]();
            delete commentUnsubscribes[task.id];
        }
    } else {
        expandedCommentTaskIds.add(task.id);
        setCommentsLastViewedAt(task.id, new Date().toISOString());
        const taskId = task.id;
        commentUnsubscribes[taskId] = subscribeToTaskComments(groupId, taskId, (comments) => {
            taskCommentsById[taskId] = comments;
            taskCommentsErrorById[taskId] = null;
            // Look up the live task rather than trusting the `task` this
            // subscription closed over - it's held for as long as the
            // section stays expanded, so re-using it here would heal
            // against an increasingly stale commentCount snapshot.
            const liveTask = groupTasks.find((candidate) => candidate.id === taskId) || task;
            healCommentCountIfStale(groupId, liveTask, comments.length);
            renderGroupTasks();
        }, (error) => {
            console.error('Failed to load comments:', error);
            taskCommentsErrorById[taskId] = error?.code === 'permission-denied'
                ? 'Comments aren\'t turned on for this project yet (the security rules need to be published).'
                : 'Could not load comments.';
            renderGroupTasks();
        });
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
            deleteComment(groupId, task.id, comment.id).catch((error) => {
                console.error('Failed to delete comment:', error);
                alert(describeGroupWriteError(error, 'Could not delete the comment.'));
            });
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
            setGroupSubtaskDueAt(groupId, task, subtask.id, iso).catch((error) => {
            console.error('Failed to set step deadline:', error);
            alert(describeGroupWriteError(error, 'Could not set the step deadline.'));
        });
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
            deleteGroupSubtask(groupId, task, subtask.id).catch((error) => {
                console.error('Failed to delete step:', error);
                alert(describeGroupWriteError(error, 'Could not delete the step.'));
            });
        });
        row.appendChild(deleteBtn);
    }

    checkBtn.addEventListener('click', () => {
        if (!isOwner) {
            return;
        }
        playClickSound();
        toggleGroupSubtask(groupId, task, subtask.id).catch((error) => {
            console.error('Failed to update step:', error);
            alert(describeGroupWriteError(error, 'Could not update the step.'));
        });
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
        addGroupSubtask(groupId, task, addInput.value).catch((error) => {
            console.error('Failed to add step:', error);
            alert(describeGroupWriteError(error, 'Could not add the step.'));
        });
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
    }).then(() => {
        closeGroupTaskEditor();
    }).catch((error) => {
        console.error('Failed to save task edits:', error);
        alert(describeGroupWriteError(error, 'Could not save your changes.'));
    });
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

    // focus/overdue/today/week below are all subtask-aware (an incomplete
    // step's own deadline counts, same as the task's own) - see
    // getEffectiveDueAt/getTaskUrgencyStatus in task-shared.js, the same
    // helpers compareGroupTasksByPriority's auto-sort already relies on.
    // Mirrors the identical fix in solo's getVisibleTasks (script.js).
    switch (activeView) {
        case 'focus': {
            const in24Hours = now + (24 * 60 * 60 * 1000);
            return scopedTasks
                .filter((task) => {
                    if (task.completed) {
                        return false;
                    }
                    const status = getTaskUrgencyStatus(task);
                    const dueSoon = status.hasDeadline && status.deadlineTimestamp <= in24Hours;
                    const urgentMatrix = getValidMatrixValue(task.matrix) === 'do';
                    return dueSoon || urgentMatrix;
                })
                .sort(compareGroupTasksByPriority)
                .slice(0, 5);
        }
        case 'overdue':
            return scopedTasks.filter((task) => !task.completed && getTaskUrgencyStatus(task).isOverdue);
        case 'today':
            return scopedTasks.filter((task) => {
                if (task.completed) {
                    return false;
                }
                const effectiveDueAt = getEffectiveDueAt(task).dueAt;
                if (!isValidDateValue(effectiveDueAt)) {
                    return false;
                }
                const dueDate = new Date(effectiveDueAt);
                const today = new Date();
                return dueDate.getFullYear() === today.getFullYear()
                    && dueDate.getMonth() === today.getMonth()
                    && dueDate.getDate() === today.getDate();
            });
        case 'week': {
            const weekAhead = now + (7 * 24 * 60 * 60 * 1000);
            return scopedTasks.filter((task) => {
                if (task.completed) {
                    return false;
                }
                const effectiveDueAt = getEffectiveDueAt(task).dueAt;
                if (!isValidDateValue(effectiveDueAt)) {
                    return false;
                }
                const dueTimestamp = new Date(effectiveDueAt).getTime();
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
    updateGroupNextTaskPanel();
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

// The other direction: suggestions YOU sent that the recipient has since
// acted on, which you haven't seen yet. Gated on resolvedAt existing, not
// just status !== 'pending' - a suggestion resolved before this field
// shipped has no resolvedAt at all, so it's correctly excluded forever
// rather than flooding every sender with months-old outcomes the moment
// this goes live (see the plan's C.1 Risks section). Mutually exclusive
// with getPendingSuggestionsForYou by construction: forUserId === you vs.
// fromUserId === you can never both be true for the same doc unless
// someone suggested a task to themselves, which the UI never offers.
function getUnacknowledgedSuggestionOutcomes() {
    if (!currentUser) {
        return [];
    }
    return groupSuggestions.filter((suggestion) => (
        suggestion.fromUserId === currentUser.uid
        && suggestion.status !== 'pending'
        && Boolean(suggestion.resolvedAt)
        && !suggestion.acknowledgedBySender
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
            acceptSuggestion(groupId, suggestion, currentUser).catch((error) => {
                console.error('Failed to accept suggestion:', error);
                alert(describeGroupWriteError(error, 'Could not accept the suggestion.'));
            });
        });
        actions.appendChild(acceptBtn);

        const dismissBtn = document.createElement('button');
        dismissBtn.type = 'button';
        dismissBtn.classList.add('suggestionDismissBtn');
        dismissBtn.textContent = 'Dismiss';
        dismissBtn.addEventListener('click', () => {
            playClickSound();
            dismissSuggestion(groupId, suggestion.id).catch((error) => {
                console.error('Failed to dismiss suggestion:', error);
                alert(describeGroupWriteError(error, 'Could not dismiss the suggestion.'));
            });
        });
        actions.appendChild(dismissBtn);

        row.appendChild(actions);
        suggestionsForYouPanel.appendChild(row);
    });
}

// The other direction from renderSuggestionsForYou above - suggestions YOU
// sent whose outcome you haven't seen yet. Deliberately read-only (no
// accept/dismiss actions, that decision was already made by the
// recipient) - just "here's what happened" plus a way to clear it.
// Clearing happens via jumpToSuggestionOutcomes (acknowledging on view,
// per the plan), not a per-row button, so this stays a plain summary list.
function renderSuggestionOutcomes(groupId) {
    if (!suggestionOutcomesPanel || !currentUser) {
        return;
    }

    const outcomes = getUnacknowledgedSuggestionOutcomes();

    suggestionOutcomesPanel.innerHTML = '';
    suggestionOutcomesPanel.classList.toggle('hidden', outcomes.length === 0);

    outcomes.forEach((suggestion) => {
        const row = document.createElement('div');
        row.classList.add('suggestionRow', 'suggestionOutcomeRow');
        row.dataset.suggestionId = suggestion.id;

        // Same textContent/createElement discipline as renderSuggestionsForYou
        // above - suggestion.text is a user-authored string.
        const text = document.createElement('p');
        text.classList.add('suggestionRowText');
        const fromSpan = document.createElement('span');
        fromSpan.classList.add('suggestionRowFrom');
        fromSpan.textContent = 'Your suggestion:';
        text.appendChild(fromSpan);
        text.appendChild(document.createTextNode(` ${suggestion.text || ''}`));
        row.appendChild(text);

        const badges = document.createElement('div');
        badges.classList.add('suggestionRowBadges');

        const outcomeBadge = document.createElement('span');
        const wasAccepted = suggestion.status === 'accepted';
        outcomeBadge.classList.add('suggestionOutcomeBadge', wasAccepted ? 'suggestionOutcomeAccepted' : 'suggestionOutcomeDismissed');
        outcomeBadge.textContent = wasAccepted ? 'Accepted' : 'Dismissed';
        badges.appendChild(outcomeBadge);
        row.appendChild(badges);

        suggestionOutcomesPanel.appendChild(row);
    });
}

// Handoff requests waiting on you - same "waiting on you" shape as
// renderSuggestionsForYou right above (reuses its .suggestionRow/
// .suggestionRowText/.suggestionRowFrom/.suggestionRowActions/
// .suggestionAcceptBtn/.suggestionDismissBtn classes verbatim so it looks
// identical with zero new row CSS, same precedent as the Steps builder
// reusing .subtaskItem), but sourced from groupTasks itself rather than a
// separate collection - see requestTaskHandoff's comment for why.
function getPendingHandoffsForYou() {
    if (!currentUser) {
        return [];
    }
    return groupTasks.filter((task) => task.handoffRequest && task.handoffRequest.toUserId === currentUser.uid);
}

function renderHandoffRequestsForYou(groupId) {
    if (!handoffRequestsForYouPanel || !currentUser) {
        return;
    }

    const pendingForMe = getPendingHandoffsForYou();

    handoffRequestsForYouPanel.innerHTML = '';
    handoffRequestsForYouPanel.classList.toggle('hidden', pendingForMe.length === 0);

    pendingForMe.forEach((task) => {
        const row = document.createElement('div');
        row.classList.add('suggestionRow');

        // Same reasoning as renderSuggestionsForYou just above - fromUserName
        // and the task's own text are both attacker-controllable strings,
        // built via textContent/createElement, never innerHTML.
        const text = document.createElement('p');
        text.classList.add('suggestionRowText');
        const fromSpan = document.createElement('span');
        fromSpan.classList.add('suggestionRowFrom');
        fromSpan.textContent = `${task.handoffRequest.fromUserName || 'A teammate'} wants to hand off:`;
        text.appendChild(fromSpan);
        text.appendChild(document.createTextNode(` ${task.text || ''}`));
        row.appendChild(text);

        const badges = document.createElement('div');
        badges.classList.add('suggestionRowBadges');
        const matrixValue = getValidMatrixValue(task.matrix);
        const matrixBadge = document.createElement('span');
        matrixBadge.classList.add('matrixBadge', MATRIX_CONFIG[matrixValue].className);
        matrixBadge.textContent = MATRIX_CONFIG[matrixValue].label;
        badges.appendChild(matrixBadge);
        row.appendChild(badges);

        const actions = document.createElement('div');
        actions.classList.add('suggestionRowActions');

        const acceptBtn = document.createElement('button');
        acceptBtn.type = 'button';
        acceptBtn.classList.add('suggestionAcceptBtn');
        acceptBtn.textContent = 'Take it over';
        acceptBtn.addEventListener('click', () => {
            playClickSound();
            acceptTaskHandoff(groupId, task, currentUser).catch((error) => {
                console.error('Failed to accept handoff:', error);
                alert(describeGroupWriteError(error, 'Could not accept the handoff.'));
            });
        });
        actions.appendChild(acceptBtn);

        const declineBtn = document.createElement('button');
        declineBtn.type = 'button';
        declineBtn.classList.add('suggestionDismissBtn');
        declineBtn.textContent = 'Decline';
        declineBtn.addEventListener('click', () => {
            playClickSound();
            clearTaskHandoff(groupId, task.id).catch((error) => {
                console.error('Failed to decline handoff:', error);
                alert(describeGroupWriteError(error, 'Could not decline the handoff.'));
            });
        });
        actions.appendChild(declineBtn);

        row.appendChild(actions);
        handoffRequestsForYouPanel.appendChild(row);
    });
}

// Handoff picker - who to hand a task off to. Reuses the same
// .taskEditorOverlay/.taskEditorCard chrome as the suggest-task modal
// below, but is built fresh each time it opens (rather than created once
// and toggled) since the member list/task it's for changes every time.
let handoffPickerOverlay = null;

function openHandoffPicker(groupId, task) {
    const group = getSelectedGroup();
    if (!group || !currentUser) {
        return;
    }
    const memberIds = group.memberIds || [];
    const memberNames = group.memberNames || [];
    const teammates = memberIds
        .map((memberId, index) => ({ memberId, name: resolveMemberName(memberId, memberNames[index], groupTasks) }))
        .filter((entry) => entry.memberId !== task.ownerId);

    if (teammates.length === 0) {
        return;
    }

    closeHandoffPicker();
    handoffPickerOverlay = document.createElement('div');
    handoffPickerOverlay.className = 'taskEditorOverlay handoffPickerOverlay open';
    handoffPickerOverlay.innerHTML = `
        <div class="taskEditorCard handoffPickerCard" role="dialog" aria-modal="true" aria-label="Hand off task">
            <h2>Hand Off Task</h2>
            <p class="handoffPickerHint"></p>
            <div class="handoffPickerList"></div>
            <div class="editorActions">
                <button type="button" class="editorCancelBtn handoffPickerCancelBtn">Cancel</button>
            </div>
        </div>
    `;
    document.body.appendChild(handoffPickerOverlay);

    // task.text is user-controlled - textContent only, never the innerHTML
    // template above (same reasoning as renderSuggestionsForYou).
    handoffPickerOverlay.querySelector('.handoffPickerHint').textContent = `Who should take over "${task.text}"?`;

    const list = handoffPickerOverlay.querySelector('.handoffPickerList');
    teammates.forEach(({ memberId, name }) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.classList.add('handoffPickerRow');
        const avatar = document.createElement('span');
        avatar.classList.add('scopeTabAvatar');
        avatar.setAttribute('aria-hidden', 'true');
        avatar.textContent = (name || '?').trim().charAt(0).toUpperCase() || '?';
        row.appendChild(avatar);
        const label = document.createElement('span');
        label.textContent = name;
        row.appendChild(label);
        row.addEventListener('click', () => {
            playClickSound();
            requestTaskHandoff(groupId, task, memberId, name, currentUser)
                .catch((error) => {
                    console.error('Failed to request handoff:', error);
                    alert(describeGroupWriteError(error, 'Could not request the handoff.'));
                });
            closeHandoffPicker();
        });
        list.appendChild(row);
    });

    const cancelBtn = handoffPickerOverlay.querySelector('.handoffPickerCancelBtn');
    cancelBtn.addEventListener('click', () => {
        playClickSound();
        closeHandoffPicker();
    });
    handoffPickerOverlay.addEventListener('click', (event) => {
        if (event.target === handoffPickerOverlay) {
            closeHandoffPicker();
        }
    });
}

function closeHandoffPicker() {
    if (!handoffPickerOverlay) {
        return;
    }
    handoffPickerOverlay.remove();
    handoffPickerOverlay = null;
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

// Group settings modal - open to every member (see .groupSettingsBtn wiring
// below). Owner/admin get who-can-join and pending join requests; everyone
// gets the leave/delete danger zone (openGroupSettingsModal gates each
// section by role). Built the same
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
            <section class="settingsSection availabilityHoursSetting hidden">
                <h3>Availability hours</h3>
                <p class="settingsHint">The hours everyone sees on the availability grid. Painted times outside this window are kept, just hidden.</p>
                <p class="availabilityHoursSettingCurrent"></p>
                <div class="availabilityHoursSettingRow">
                    <label class="availabilityHoursSettingLabel">
                        From
                        <select class="availabilityHoursSettingSelect availabilityHoursSettingStart" aria-label="Start hour"></select>
                    </label>
                    <label class="availabilityHoursSettingLabel">
                        To
                        <select class="availabilityHoursSettingSelect availabilityHoursSettingEnd" aria-label="End hour"></select>
                    </label>
                    <button type="button" class="availabilityHoursSettingSaveBtn">Save</button>
                </div>
                <p class="availabilityHoursSettingStatus" aria-live="polite"></p>
            </section>
            <section class="settingsSection groupSettingsRequestsSection">
                <h3>Pending join requests</h3>
                <div class="groupSettingsRequestsList"></div>
            </section>
            <section class="settingsSection settingsDangerSection groupSettingsDangerSection">
                <h3 class="groupSettingsDangerTitle">Leave or delete this group</h3>
                <p class="settingsHint groupSettingsDangerHint">Leaving removes you from this group and deletes your availability grid here. Deleting removes it - and every task in it - for everyone. Neither can be undone.</p>
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

    // Availability hours: start options 0-23, end options 1-24 (24 = the
    // midnight that ends the day), matching the rule's 0 <= start < end <= 24.
    const hoursStartSelect = groupSettingsOverlay.querySelector('.availabilityHoursSettingStart');
    const hoursEndSelect = groupSettingsOverlay.querySelector('.availabilityHoursSettingEnd');
    for (let hour = 0; hour <= 24; hour += 1) {
        if (hour < 24) {
            hoursStartSelect.appendChild(new Option(formatAvailabilityHoursSettingLabel(hour), String(hour)));
        }
        if (hour > 0) {
            hoursEndSelect.appendChild(new Option(formatAvailabilityHoursSettingLabel(hour), String(hour)));
        }
    }
    hoursStartSelect.addEventListener('change', updateAvailabilityHoursSettingValidity);
    hoursEndSelect.addEventListener('change', updateAvailabilityHoursSettingValidity);

    const hoursSaveBtn = groupSettingsOverlay.querySelector('.availabilityHoursSettingSaveBtn');
    const hoursStatus = groupSettingsOverlay.querySelector('.availabilityHoursSettingStatus');
    hoursSaveBtn.addEventListener('click', () => {
        const groupId = groupSettingsGroupId;
        const startHour = Number.parseInt(hoursStartSelect.value, 10);
        const endHour = Number.parseInt(hoursEndSelect.value, 10);
        if (!groupId || !updateAvailabilityHoursSettingValidity()) {
            return;
        }
        playClickSound();
        hoursSaveBtn.disabled = true;
        hoursStatus.classList.remove('isError');
        hoursStatus.textContent = 'Saving...';
        setGroupAvailabilityHourRange(groupId, startHour, endHour)
            .then(() => {
                hoursStatus.textContent = 'Saved.';
            })
            .catch((error) => {
                console.error('Failed to update availability hours:', error);
                hoursStatus.classList.add('isError');
                hoursStatus.textContent = describeGroupWriteError(error, 'Could not save the availability hours.');
            })
            .finally(() => {
                updateAvailabilityHoursSettingValidity();
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

// 0 and 24 are both midnight (start of day vs end of day) - "Midnight"
// reads clearer than formatAvailabilityHourLabel's "12AM"/"12PM" for them.
function formatAvailabilityHoursSettingLabel(hour24) {
    return (hour24 === 0 || hour24 === 24) ? 'Midnight' : formatAvailabilityHourLabel(hour24);
}

// Enables Save only for a valid range that differs from what's saved.
// Returns whether the picked range is valid.
function updateAvailabilityHoursSettingValidity() {
    if (!groupSettingsOverlay) {
        return false;
    }
    const startHour = Number.parseInt(groupSettingsOverlay.querySelector('.availabilityHoursSettingStart').value, 10);
    const endHour = Number.parseInt(groupSettingsOverlay.querySelector('.availabilityHoursSettingEnd').value, 10);
    const isValid = Number.isInteger(startHour) && Number.isInteger(endHour)
        && startHour >= 0 && endHour <= 24 && startHour < endHour;
    const group = (groups || []).find((item) => item.id === groupSettingsGroupId);
    const saved = getAvailabilityHourRange(group);
    const isUnchanged = startHour === saved.startHour && endHour === saved.endHour;

    const status = groupSettingsOverlay.querySelector('.availabilityHoursSettingStatus');
    if (!isValid) {
        status.classList.add('isError');
        status.textContent = 'The start time has to be before the end time.';
    } else if (status.classList.contains('isError') && status.textContent.startsWith('The start time')) {
        status.classList.remove('isError');
        status.textContent = '';
    }
    groupSettingsOverlay.querySelector('.availabilityHoursSettingSaveBtn').disabled = !isValid || isUnchanged;
    return isValid;
}

// Owner-only section (the rule only lets the owner write this field, so
// admins don't see it at all rather than seeing a control that always fails).
function renderAvailabilityHoursSetting(group, { resetSelects }) {
    if (!groupSettingsOverlay) {
        return;
    }
    const section = groupSettingsOverlay.querySelector('.availabilityHoursSetting');
    const { isOwner } = getMyRoleInGroup(group);
    section.classList.toggle('hidden', !isOwner);
    if (!isOwner) {
        return;
    }
    const range = getAvailabilityHourRange(group);
    groupSettingsOverlay.querySelector('.availabilityHoursSettingCurrent').textContent =
        `Currently ${formatAvailabilityHoursSettingLabel(range.startHour)} to ${formatAvailabilityHoursSettingLabel(range.endHour)}.`;
    if (resetSelects) {
        groupSettingsOverlay.querySelector('.availabilityHoursSettingStart').value = String(range.startHour);
        groupSettingsOverlay.querySelector('.availabilityHoursSettingEnd').value = String(range.endHour);
        const status = groupSettingsOverlay.querySelector('.availabilityHoursSettingStatus');
        status.classList.remove('isError');
        status.textContent = '';
    }
    updateAvailabilityHoursSettingValidity();
}

function openGroupSettingsModal(group) {
    if (!currentUser) {
        return;
    }
    initializeGroupSettingsModal();

    groupSettingsGroupId = group.id;
    const { isOwner, isAdmin } = getMyRoleInGroup(group);

    // Plain members only get the danger zone (their way to leave); join
    // requests are owner/admin business, and the rules deny members reading
    // them anyway.
    groupSettingsOverlay.querySelector('.groupSettingsRequestsSection').classList.toggle('hidden', !(isOwner || isAdmin));
    groupSettingsOverlay.querySelector('.groupSettingsDangerTitle').textContent = isOwner ? 'Leave or delete this group' : 'Leave this group';
    groupSettingsOverlay.querySelector('.groupSettingsDangerHint').textContent = isOwner
        ? 'Leaving removes you from this group and deletes your availability grid here. Deleting removes it - and every task in it - for everyone. Neither can be undone.'
        : 'Leaving removes you from this group and deletes your availability grid here. You\'ll need the invite code to rejoin.';

    const privacySelect = groupSettingsOverlay.querySelector('.groupSettingsPrivacySelect');
    privacySelect.value = group.privacy || 'open';
    privacySelect.disabled = !isOwner;
    groupSettingsOverlay.querySelector('.groupSettingsPrivacyNote').classList.toggle('hidden', isOwner);

    renderAvailabilityHoursSetting(group, { resetSelects: true });

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
    // isMarkup: true only for the one static icon string ('Everyone') -
    // the per-member case passes a name-derived initial, which is user-
    // controlled data and must never go through innerHTML, even truncated
    // to one character (security audit flagged this as fragile-but-not-
    // currently-exploitable; hardening it now rather than leaving the one
    // remaining innerHTML site that touches user data at all).
    const makeTab = (scope, label, avatarContent, isMarkup = false) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.classList.add('taskViewBtn', 'groupScopeTabBtn');
        if (activeMemberScope === scope) {
            btn.classList.add('active');
        }

        const avatar = document.createElement('span');
        avatar.classList.add('scopeTabAvatar');
        avatar.setAttribute('aria-hidden', 'true');
        if (isMarkup) {
            avatar.innerHTML = avatarContent;
        } else {
            avatar.textContent = avatarContent;
        }
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

    makeTab('all', 'Everyone', '<i class="fa-solid fa-people-group"></i>', true);

    memberIds.forEach((memberId, index) => {
        const isYou = memberId === currentUser?.uid;
        const label = isYou ? 'Me' : resolveMemberName(memberId, memberNames[index], groupTasks);
        const initial = (label || '?').trim().charAt(0).toUpperCase() || '?';
        makeTab(memberId, label, initial);
    });
}

// ---------------------------------------------------------------------
// Group calendar - direct port of solo script.js's calendar (month/week
// grid, due/planned/projected-recurrence chips, click-to-edit, click-
// empty-day-to-quick-add), plus the one genuinely new piece group needs:
// color-coding each chip by which member owns it. See the plan file's
// "Group calendar (Phase 2)" section for the reasoning behind each
// decision below.
// ---------------------------------------------------------------------

const GROUP_CALENDAR_MAX_VISIBLE_CHIPS = 3;
const GROUP_CALENDAR_MAX_VISIBLE_CHIPS_WEEK = 6;

// The 7-day equivalent of task-shared.js's buildCalendarMonthMatrix - kept
// local, same reasoning as solo's buildCalendarWeekRow (script.js): week
// view has no "in/out of range" concept worth sharing, it's just 7
// consecutive days.
function buildGroupCalendarWeekRow(anchorDate) {
    const start = new Date(anchorDate);
    start.setDate(anchorDate.getDate() - anchorDate.getDay());

    const cells = [];
    for (let i = 0; i < 7; i += 1) {
        const date = new Date(start);
        date.setDate(start.getDate() + i);
        cells.push({ date, inMonth: true });
    }
    return cells;
}

function updateGroupCalendarLabel(cells) {
    if (!groupCalendarLabel) {
        return;
    }
    if (groupCalendarViewMode === 'month') {
        groupCalendarLabel.textContent = groupCalendarAnchorDate.toLocaleDateString([], { month: 'long', year: 'numeric' });
        return;
    }

    const start = cells[0].date;
    const end = cells[cells.length - 1].date;
    const sameMonth = start.getMonth() === end.getMonth();
    const startLabel = start.toLocaleDateString([], { month: 'short', day: 'numeric' });
    const endLabel = end.toLocaleDateString([], sameMonth ? { day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
    groupCalendarLabel.textContent = `${startLabel} – ${endLabel}`;
}

// Same bucketing as solo's buildCalendarEntriesByDay, over groupTasks
// instead of tasks - entries keep task.ownerId along for the ride so chips
// can be colored by member.
function buildGroupCalendarEntriesByDay(cells) {
    const byDay = {};
    const rangeStart = cells[0].date;
    const rangeEnd = cells[cells.length - 1].date;

    function addEntry(dateKey, entry) {
        if (!byDay[dateKey]) {
            byDay[dateKey] = [];
        }
        byDay[dateKey].push(entry);
    }

    groupTasks.forEach((task) => {
        if (task.dueAt && isValidDateValue(task.dueAt)) {
            addEntry(getDateKey(new Date(task.dueAt)), { type: 'due', task });
        }
        if (task.scheduledAt && isValidDateValue(task.scheduledAt)) {
            addEntry(getDateKey(new Date(task.scheduledAt)), { type: 'planned', task });
        }

        if (task.recurrence && task.dueAt && isValidDateValue(task.dueAt)) {
            let cursor = task.dueAt;
            for (let i = 0; i < 60; i += 1) {
                const next = getNextRecurrenceDueAt(cursor, task.recurrence);
                if (!next) {
                    break;
                }
                const nextDate = new Date(next);
                if (nextDate > rangeEnd) {
                    break;
                }
                if (nextDate >= rangeStart) {
                    addEntry(getDateKey(nextDate), { type: 'projected', task });
                }
                cursor = next;
            }
        }

        // A step's own deadline, on its own day - mirrors solo's identical
        // addition in buildCalendarEntriesByDay (script.js). Only an
        // incomplete step on an active task, same as solo.
        if (!task.completed && Array.isArray(task.subtasks)) {
            task.subtasks.forEach((subtask) => {
                if (!subtask.completed && subtask.dueAt && isValidDateValue(subtask.dueAt)) {
                    addEntry(getDateKey(new Date(subtask.dueAt)), { type: 'step', task, subtask });
                }
            });
        }
    });

    return byDay;
}

// Real bug, reported live: hashing each ownerId independently (the original
// approach here) can - and did - land two different members on the same or
// a visually adjacent color purely by chance, with nothing keeping them
// apart. A member's fixed POSITION in the group's own memberIds array has
// no such risk: every member already has a distinct index, so keying off
// that instead guarantees no two members in a group of up to 8 ever share
// a color. Only degrades (repeats) past 8 members, which the legend still
// spells out by name regardless.
function getGroupMemberColorIndex(ownerId, group) {
    const memberIds = group?.memberIds || [];
    const index = memberIds.indexOf(ownerId);
    return index >= 0 ? index % 8 : 0;
}

function renderGroupCalendarMemberLegend(group) {
    if (!groupCalendarLegend) {
        return;
    }
    const memberIds = group.memberIds || [];
    const memberNames = group.memberNames || [];
    groupCalendarLegend.innerHTML = '';

    memberIds.forEach((memberId, index) => {
        const item = document.createElement('span');
        item.classList.add('calendarMemberLegendItem');

        const dot = document.createElement('span');
        dot.classList.add('calendarChipMemberDot', `calendarMemberColor-${getGroupMemberColorIndex(memberId, group)}`);
        item.appendChild(dot);

        const name = document.createElement('span');
        const isYou = memberId === currentUser?.uid;
        name.textContent = isYou ? 'You' : resolveMemberName(memberId, memberNames[index], groupTasks);
        item.appendChild(name);

        groupCalendarLegend.appendChild(item);
    });
}

// Sets the deadline field (and opens Prioritize) to that day, then hands
// off to group's own quick-add task input - direct port of solo's
// openCalendarQuickAdd (script.js), same one-motion-flow reasoning. The
// task this creates is owned by whoever adds it (same as every other
// quick-add path in this file), same as clicking a day with no one's
// tasks on it yet.
function openGroupCalendarQuickAdd(date) {
    switchGroupView('tasks');
    taskDetailsPanel?.classList.add('open');
    detailsToggleBtn?.setAttribute('aria-expanded', 'true');
    const prefilled = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 9, 0, 0, 0);
    if (deadlineInput) {
        deadlineInput.value = toDatetimeLocalValue(prefilled.toISOString());
    }
    taskInput?.focus();
}

function renderGroupCalendarDayChips(chipListEl, moreBtnEl, orderedEntries, expanded, maxVisible, group) {
    chipListEl.innerHTML = '';
    const visibleCount = expanded ? orderedEntries.length : Math.min(maxVisible, orderedEntries.length);
    orderedEntries.slice(0, visibleCount).forEach((entry) => {
        chipListEl.appendChild(createGroupCalendarChip(entry, group));
    });

    if (orderedEntries.length > maxVisible) {
        moreBtnEl.textContent = expanded ? 'Show less' : `+${orderedEntries.length - maxVisible} more`;
        moreBtnEl.classList.remove('hidden');
    } else {
        moreBtnEl.classList.add('hidden');
    }
}

// Port of solo's createCalendarChip, plus a leading member-color dot and
// ownership-gated click behavior: a chip for a task you own opens the real
// editor (same as the Tasks tab's Edit button, which is itself only ever
// shown for your own tasks - see createGroupTaskItem above); a teammate's
// chip stays inert, since no edit permission exists for it anywhere else
// in the app either.
function createGroupCalendarChip(entry, group) {
    const { type, task, subtask } = entry;
    const isMine = task.ownerId === currentUser?.uid;

    const chip = document.createElement('button');
    chip.type = 'button';
    chip.classList.add('calendarChip', `calendarChip-${type}`);
    if (!isMine) {
        chip.classList.add('notEditable');
    }
    if (task.completed) {
        chip.classList.add('completed');
    }
    // A step's own urgency color comes from its own deadline, not the
    // task's - same reasoning as solo's createCalendarChip (script.js).
    if (type === 'step') {
        chip.classList.add(getDeadlineStatus(subtask.dueAt).deadlineClassName);
    } else {
        chip.classList.add(type === 'projected' ? 'deadline-none' : getTaskDisplayDeadlineStatus(task).deadlineClassName);
    }

    const dot = document.createElement('span');
    dot.classList.add('calendarChipMemberDot', `calendarMemberColor-${getGroupMemberColorIndex(task.ownerId, group)}`);
    chip.appendChild(dot);

    const icon = document.createElement('i');
    icon.classList.add('fa-solid', type === 'step' ? 'fa-list-check' : type === 'planned' ? 'fa-clock' : type === 'projected' ? 'fa-repeat' : 'fa-calendar');
    chip.appendChild(icon);

    const label = document.createElement('span');
    label.textContent = type === 'step' ? `${task.text}: ${subtask.text}` : task.text;
    chip.appendChild(label);

    // task.ownerName is re-stamped on every write by its owner (see
    // groups-data.js's resolveMemberName comment) - reading it straight off
    // this task is simpler and just as fresh as looking it up again.
    const ownerName = isMine ? 'You' : (task.ownerName || 'Teammate');
    const kindLabel = type === 'step' ? 'Step due' : type === 'planned' ? 'Planned' : type === 'projected' ? 'Repeats' : 'Due';
    chip.setAttribute('aria-label', `${kindLabel}: ${task.text} (${ownerName})`);
    chip.title = type === 'step' ? `${ownerName} · ${kindLabel}: ${subtask.text}` : `${ownerName} · ${kindLabel}`;

    if (isMine) {
        chip.addEventListener('click', (event) => {
            event.stopPropagation();
            playClickSound();
            openGroupTaskEditor(group.id, task);
        });
    } else {
        chip.disabled = true;
    }

    return chip;
}

function createGroupCalendarDayCell(cell, entriesByDay, group) {
    const dateKey = getDateKey(cell.date);
    const entries = entriesByDay[dateKey] || [];
    const isToday = dateKey === getDateKey(new Date());

    const cellEl = document.createElement('div');
    cellEl.classList.add('calendarDayCell');
    if (!cell.inMonth) {
        cellEl.classList.add('outOfMonth');
    }
    if (isToday) {
        cellEl.classList.add('today');
    }
    cellEl.dataset.dateKey = dateKey;

    const dateLabel = document.createElement('span');
    dateLabel.classList.add('calendarDayNumber');
    dateLabel.textContent = String(cell.date.getDate());
    cellEl.appendChild(dateLabel);

    const fullLabel = document.createElement('span');
    fullLabel.classList.add('calendarDayFullLabel');
    fullLabel.textContent = cell.date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    cellEl.appendChild(fullLabel);

    const chipList = document.createElement('div');
    chipList.classList.add('calendarChipList');
    cellEl.appendChild(chipList);

    // Real bug caught by testing on the solo side (script.js) and fixed
    // here too before it ever shipped: this whitelist silently drops any
    // entry type not listed - 'step' needs to be here explicitly, same tier
    // as 'due' (real, current pressure), or the entries buildGroup
    // CalendarEntriesByDay/createGroupCalendarChip both correctly produce
    // never actually reach the renderer.
    const ordered = [
        ...entries.filter((entry) => entry.type === 'due'),
        ...entries.filter((entry) => entry.type === 'step'),
        ...entries.filter((entry) => entry.type === 'planned'),
        ...entries.filter((entry) => entry.type === 'projected')
    ];

    const maxVisible = groupCalendarViewMode === 'week' ? GROUP_CALENDAR_MAX_VISIBLE_CHIPS_WEEK : GROUP_CALENDAR_MAX_VISIBLE_CHIPS;

    const moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.classList.add('calendarMoreBtn', 'hidden');
    moreBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        playClickSound();
        const isExpanded = cellEl.classList.toggle('expanded');
        renderGroupCalendarDayChips(chipList, moreBtn, ordered, isExpanded, maxVisible, group);
    });
    cellEl.appendChild(moreBtn);

    renderGroupCalendarDayChips(chipList, moreBtn, ordered, false, maxVisible, group);

    if (entries.length === 0) {
        cellEl.classList.add('empty');
        cellEl.addEventListener('click', () => openGroupCalendarQuickAdd(cell.date));
    }

    return cellEl;
}

function renderGroupCalendarView() {
    if (!groupCalendarGrid) {
        return;
    }
    const group = getSelectedGroup();
    if (!group) {
        return;
    }

    renderGroupCalendarMemberLegend(group);

    const cells = groupCalendarViewMode === 'month'
        ? buildCalendarMonthMatrix(groupCalendarAnchorDate.getFullYear(), groupCalendarAnchorDate.getMonth())
        : buildGroupCalendarWeekRow(groupCalendarAnchorDate);

    updateGroupCalendarLabel(cells);
    groupCalendarGrid.classList.toggle('calendarGridWeek', groupCalendarViewMode === 'week');

    const entriesByDay = buildGroupCalendarEntriesByDay(cells);
    groupCalendarGrid.innerHTML = '';
    cells.forEach((cell) => {
        groupCalendarGrid.appendChild(createGroupCalendarDayCell(cell, entriesByDay, group));
    });
}

function renderGroupTasks() {
    if (!groupTasksList) {
        return;
    }

    const group = getSelectedGroup();
    groupTasksList.innerHTML = '';

    // A group is selected but its first task snapshot hasn't arrived yet -
    // show loading skeleton rows (same shimmering .taskSkeletonRow markup/
    // CSS as solo's script.js) instead of falsely claiming "No tasks yet"
    // while data is still in flight. See hasLoadedGroupTasksOnce.
    if (group && !hasLoadedGroupTasksOnce) {
        for (let i = 0; i < 3; i++) {
            const row = document.createElement('li');
            row.className = 'taskSkeletonRow';
            row.innerHTML = `
                <span class="taskSkeletonCheck"></span>
                <span class="taskSkeletonLines">
                    <span class="taskSkeletonBar taskSkeletonBar--text"></span>
                    <span class="taskSkeletonBar taskSkeletonBar--meta"></span>
                </span>
            `;
            groupTasksList.appendChild(row);
        }
        return;
    }

    if (!group || groupTasks.length === 0) {
        const emptyMsg = document.createElement('li');
        emptyMsg.classList.add('emptyTasksMsg');
        emptyMsg.textContent = (group && groupTasksLoadError)
            ? groupTasksLoadError
            : 'No tasks yet. Add one above to get the team started.';
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

// A small per-session cache of other members' streak/badge summaries (the
// same users/{uid} fields solo writes - see script.js's
// applySoloCompletionDelta). renderMemberRoster can re-render on every
// group task change, so fetching every member's profile doc on every call
// would be wasteful - cached instead, with a modest TTL, refreshed lazily
// in the background rather than blocking the render. This is the one place
// streaks touch group at all - see the plan's reasoning on why this
// replaces a general friend/profile system rather than sitting alongside
// one.
const memberStreakCache = new Map(); // uid -> { current, badges, fetchedAt }
const MEMBER_STREAK_CACHE_TTL_MS = 5 * 60 * 1000;
let memberStreakRefreshInFlight = false;

function getCachedMemberStreak(uid) {
    return memberStreakCache.get(uid) || null;
}

async function refreshStaleMemberStreaks(memberIds, group) {
    if (!window.ToDoAuth?.auth?.currentUser || memberStreakRefreshInFlight) {
        return;
    }
    const now = Date.now();
    const staleIds = memberIds.filter((uid) => {
        const entry = memberStreakCache.get(uid);
        return !entry || (now - entry.fetchedAt) > MEMBER_STREAK_CACHE_TTL_MS;
    });
    if (staleIds.length === 0) {
        return;
    }

    memberStreakRefreshInFlight = true;
    try {
        const { doc, getDoc } = window.ToDoAuth.firestore;
        const db = window.ToDoAuth.db;
        await Promise.all(staleIds.map(async (uid) => {
            try {
                // Reads the narrow users/{uid}/public/streakSummary mirror,
                // NOT the real users/{uid} profile doc - that one's rule is
                // owner-only (it also carries email/displayName), see
                // firestore.rules' comment on why this is a separate doc.
                const snapshot = await getDoc(doc(db, 'users', uid, 'public', 'streakSummary'));
                const data = snapshot.exists() ? snapshot.data() : {};
                memberStreakCache.set(uid, {
                    current: Number(data.current) || 0,
                    badges: Array.isArray(data.badges) ? data.badges : [],
                    fetchedAt: Date.now()
                });
            } catch (error) {
                console.error("Failed to load a member's streak:", error);
                memberStreakCache.set(uid, { current: 0, badges: [], fetchedAt: Date.now() });
            }
        }));
    } finally {
        memberStreakRefreshInFlight = false;
    }

    // One backfill re-render now that the cache actually has data - the
    // membership/role args below match what setActiveMemberScope/the group
    // listener already pass in, so this reflects the same state, just
    // slightly later than the initial (streak-less) render.
    const currentGroup = getSelectedGroup();
    if (currentGroup && currentGroup.id === group.id) {
        renderMemberRoster(currentGroup, getMyRoleInGroup(currentGroup));
    }
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

    // Fire-and-forget - cards below render immediately with whatever's
    // already cached (nothing, on a cold start), and refreshStaleMemberStreaks
    // triggers one backfill re-render once real data comes back. See its
    // own comment for why this isn't just fetched inline here.
    refreshStaleMemberStreaks(memberIds, group);

    const cards = memberIds.map((memberId, index) => {
        const memberTasks = groupTasks.filter((task) => task.ownerId === memberId);
        const doneCount = memberTasks.filter((task) => task.completed).length;
        const total = memberTasks.length;
        const percent = total > 0 ? Math.round((doneCount / total) * 100) : 0;

        const activeTasks = memberTasks.filter((task) => !task.completed);
        const focusTask = activeTasks.length > 0
            ? [...activeTasks].sort(compareGroupTasksByPriority)[0]
            : null;
        // Same (subtask-aware) overdue check updateGroupUrgencyAlert() uses
        // for the team-wide banner - here it's per-member, so a teammate
        // who's fallen behind (whether on the task's own deadline or one of
        // its steps) is visible right from the roster, not just once you're
        // already looking at their tasks.
        const hasOverdue = activeTasks.some((task) => getTaskUrgencyStatus(task).urgencyLevel === 'overdue');

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
        // Same no-clutter threshold as solo's own streak pill (script.js's
        // refreshSoloStreakPill) - nothing shown below a 2-day streak, and
        // nothing at all until this member's cached summary actually
        // arrives (see refreshStaleMemberStreaks above).
        const memberStreak = getCachedMemberStreak(card.memberId);
        if (memberStreak && memberStreak.current >= 2) {
            const streakFlag = document.createElement('span');
            streakFlag.classList.add('memberCardStreakFlame');
            streakFlag.textContent = `🔥 ${memberStreak.current}`;
            streakFlag.title = `${memberStreak.current}-day streak`;
            name.appendChild(streakFlag);
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
//     permanent history log, capped at 200 most-recent across the whole
//     group) for week, since 200 is a wide margin for a week's worth of
//     completions in practice; "This month" instead counts from currently-
//     completed groupTasks (like "All time" below) since a month's worth
//     could realistically blow past that cap and silently undercount.
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
        // Real, verified race: right after createGroup, the local cache
        // reflects the new group before the server has actually committed
        // it - renderApp fires from that cache, opens this listener, and
        // the server-side get(groups/{id}) inside the joinRequests rule
        // evaluates against a doc that doesn't exist yet, denying it.
        // Firestore terminates an errored listener permanently, and
        // leaving joinRequestsSubscriptionKey set would mean this never
        // retries on its own - only a reload or group switch would recover
        // it, silently hiding the join-request badge/list for a brand-new
        // group's owner until then. Clearing it here lets the very next
        // renderApp() (which fires again momentarily once the server
        // catches up) re-subscribe and succeed normally.
        console.error('Failed to load join requests:', error);
        groupJoinRequests = [];
        joinRequestsSubscriptionKey = null;
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

    // A load error with nothing already fetched: show the error instead of
    // either an infinite "Loading..." or the "create or join a group" setup
    // screen, which would risk the user creating a duplicate group thinking
    // their real ones vanished.
    if (groupsLoadError && groups.length === 0) {
        if (groupStatusMsg) {
            groupStatusMsg.textContent = groupsLoadError;
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
        // Every member, not just owner/admin: it's also where plain members
        // find "Leave group". openGroupSettingsModal hides the owner/admin
        // sections for them.
        groupSettingsBtn?.classList.remove('hidden');
        // Re-evaluated every render (not just on group switch) so a role
        // change alone - e.g. you just got promoted to admin - starts the
        // subscription without needing a reload; the idempotency check
        // inside makes this a no-op once nothing's actually changed.
        ensureJoinRequestsSubscription(group, isOwner || isAdmin);
        // Gated on the Availability tab's Team overlap / Best times views
        // actually being open - see isGroupAvailabilityDataNeeded.
        syncGroupAvailabilitySubscription();
        updateGroupSettingsBadge();
        if (groupSettingsOverlay?.classList.contains('open') && groupSettingsGroupId === group.id) {
            // Keep an already-open Settings modal live too, not just the
            // badge - e.g. approving one request updates the remaining list
            // immediately instead of only on next open.
            renderPendingJoinRequests(groupJoinRequests);
            renderAvailabilityHoursSetting(group, { resetSelects: false });
        }
        renderGroupMemberScopeTabs(group);
        renderMemberRoster(group, { isOwner, isAdmin });
        renderGroupLeaderboard(group);
        renderGroupHistory(group);
        renderNewMemberCatchUp(group);
        renderSuggestForMemberBanner(group);
        renderSuggestionsForYou(group.id);
        renderSuggestionOutcomes(group.id);
        renderHandoffRequestsForYou(group.id);
        renderGroupTasks();
        renderGroupCalendarView();
        renderGroupAvailabilityView(group);
        // The 6-button deadline-filter row isn't worth much with barely any
        // tasks to filter - condense it down to just All/Overdue (Overdue
        // stays regardless of count, since it's meaningful even at 1 task
        // and updateGroupUrgencyAlert already surfaces it independently)
        // until there's enough to actually filter through.
        deadlineViewTabs?.classList.toggle('condensed', groupTasks.length < 3);
        updateGroupMotivator();
        updateGroupUrgencyAlert();
        updateGroupNextTaskPanel();
        updateNavAttentionBadge(group);
        renderGroupOnboardingHint();
        maybeAutoStartGroupTour();
        maybeShowGroupTeamPulse(group);
    } else {
        ensureJoinRequestsSubscription(null, false);
        ensureGroupAvailabilitySubscription(null);
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
    // suggestions you sent that got accepted/dismissed, not yet seen by
    // you - see getUnacknowledgedSuggestionOutcomes for the resolvedAt
    // gate that keeps this from flooding every sender with pre-existing
    // resolved suggestions the moment this ships. Can never overlap with
    // suggestionsCount above (forUserId === you vs. fromUserId === you),
    // so total below never double-counts one suggestion.
    const suggestionOutcomesCount = getUnacknowledgedSuggestionOutcomes().length;
    // Task handoff requests waiting on you - same "waiting on you" shape as
    // suggestionsCount, never overlaps with it (a task's handoffRequest and
    // a suggestion are different documents/fields entirely).
    const handoffRequestsCount = getPendingHandoffsForYou().length;
    return {
        unreadCommentsCount,
        joinRequestsCount,
        suggestionsCount,
        suggestionOutcomesCount,
        handoffRequestsCount,
        total: unreadCommentsCount + joinRequestsCount + suggestionsCount + suggestionOutcomesCount + handoffRequestsCount
    };
}

function closeNavAttentionMenu() {
    navAttentionMenu?.classList.add('hidden');
    navAttentionBadge?.setAttribute('aria-expanded', 'false');
}

// Brief "look here" pulse on whatever a notification row actually jumped
// you to - removed afterward purely so it can play again on a later jump
// without needing a forced-reflow restart trick.
function flashAttentionTarget(el) {
    if (!el) {
        return;
    }
    el.classList.remove('attentionFlash');
    // Force a reflow so re-adding the class restarts the animation even if
    // it's still mid-flash from a moment ago (e.g. jumping to the same
    // task twice in a row).
    void el.offsetWidth;
    el.classList.add('attentionFlash');
    setTimeout(() => el.classList.remove('attentionFlash'), 1600);
}

// Each of these resets whatever filter/scope might otherwise be hiding the
// target first - landing on a notification should never mean an empty
// list because a filter from three actions ago is still active.
function jumpToUnreadComments() {
    const target = groupTasks.filter(hasUnreadComments)[0];
    if (!target) {
        return;
    }
    switchGroupView('tasks');
    setActiveView('all');
    setActiveMemberScope('all');
    setTimeout(() => {
        const row = groupTasksList?.querySelector(`li[data-task-id="${CSS.escape(target.id)}"]`);
        if (!row) {
            return;
        }
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        flashAttentionTarget(row);
        const commentsBtn = row.querySelector('.commentsToggleBtn');
        if (commentsBtn?.getAttribute('aria-expanded') === 'false') {
            commentsBtn.click();
        }
    }, 30);
}

function jumpToSuggestionsForYou() {
    switchGroupView('tasks');
    setTimeout(() => {
        suggestionsForYouPanel?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        flashAttentionTarget(suggestionsForYouPanel);
    }, 30);
}

function jumpToHandoffRequests() {
    switchGroupView('tasks');
    setTimeout(() => {
        handoffRequestsForYouPanel?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        flashAttentionTarget(handoffRequestsForYouPanel);
    }, 30);
}

function jumpToJoinRequests() {
    const group = getSelectedGroup();
    if (!group) {
        return;
    }
    openGroupSettingsModal(group);
    setTimeout(() => {
        flashAttentionTarget(groupSettingsOverlay?.querySelector('.groupSettingsRequestsList'));
    }, 30);
}

// Unlike the other three jump functions, this one also acknowledges what
// it jumped to (per the plan: "flipped true when the sender views it via
// a new jump function") - opening this from the nav menu IS the read
// receipt, there's no separate per-row dismiss action in
// renderSuggestionOutcomes. Fire-and-forget like every other Firestore
// write triggered from a click in this file (acceptSuggestion,
// dismissSuggestion above); a failed ack just means it resurfaces next
// time the badge is opened, not a broken state.
function jumpToSuggestionOutcomes() {
    const group = getSelectedGroup();
    if (!group) {
        return;
    }
    const outcomes = getUnacknowledgedSuggestionOutcomes();
    switchGroupView('tasks');
    setTimeout(() => {
        suggestionOutcomesPanel?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        flashAttentionTarget(suggestionOutcomesPanel);
    }, 30);
    outcomes.forEach((suggestion) => {
        acknowledgeSuggestionOutcome(group.id, suggestion.id).catch((error) => console.error('Failed to acknowledge suggestion outcome:', error));
    });
}

function renderNavAttentionMenu(summary) {
    if (!navAttentionMenu) {
        return;
    }
    navAttentionMenu.innerHTML = '';

    const rows = [
        summary.suggestionsCount > 0 && {
            icon: 'fa-solid fa-lightbulb',
            label: `${summary.suggestionsCount} suggestion${summary.suggestionsCount === 1 ? '' : 's'} for you`,
            onClick: jumpToSuggestionsForYou
        },
        summary.unreadCommentsCount > 0 && {
            icon: 'fa-regular fa-comment',
            label: `${summary.unreadCommentsCount} unread comment${summary.unreadCommentsCount === 1 ? '' : 's'}`,
            onClick: jumpToUnreadComments
        },
        summary.joinRequestsCount > 0 && {
            icon: 'fa-solid fa-user-plus',
            label: `${summary.joinRequestsCount} pending join request${summary.joinRequestsCount === 1 ? '' : 's'}`,
            onClick: jumpToJoinRequests
        },
        summary.suggestionOutcomesCount > 0 && {
            icon: 'fa-solid fa-circle-check',
            label: `${summary.suggestionOutcomesCount} suggestion outcome${summary.suggestionOutcomesCount === 1 ? '' : 's'}`,
            onClick: jumpToSuggestionOutcomes
        },
        summary.handoffRequestsCount > 0 && {
            icon: 'fa-solid fa-right-left',
            label: `${summary.handoffRequestsCount} handoff request${summary.handoffRequestsCount === 1 ? '' : 's'}`,
            onClick: jumpToHandoffRequests
        }
    ].filter(Boolean);

    rows.forEach((row) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.classList.add('navAttentionMenuRow');
        btn.setAttribute('role', 'menuitem');
        btn.innerHTML = `<i class="${row.icon}"></i><span>${row.label}</span>`;
        btn.addEventListener('click', () => {
            playClickSound();
            closeNavAttentionMenu();
            row.onClick();
        });
        navAttentionMenu.appendChild(btn);
    });
}

function updateNavAttentionBadge(group) {
    if (!navAttentionBadge || !navAttentionCount) {
        return;
    }
    if (!group) {
        navAttentionBadge.classList.remove('visible');
        closeNavAttentionMenu();
        return;
    }
    const summary = computeAttentionSummary();
    navAttentionCount.textContent = summary.total > 9 ? '9+' : String(summary.total);
    navAttentionBadge.classList.toggle('visible', summary.total > 0);
    navAttentionBadge.title = summary.total === 0 ? '' : [
        summary.unreadCommentsCount && `${summary.unreadCommentsCount} unread comment${summary.unreadCommentsCount === 1 ? '' : 's'}`,
        summary.joinRequestsCount && `${summary.joinRequestsCount} pending join request${summary.joinRequestsCount === 1 ? '' : 's'}`,
        summary.suggestionsCount && `${summary.suggestionsCount} suggestion${summary.suggestionsCount === 1 ? '' : 's'} for you`,
        summary.suggestionOutcomesCount && `${summary.suggestionOutcomesCount} suggestion outcome${summary.suggestionOutcomesCount === 1 ? '' : 's'}`,
        summary.handoffRequestsCount && `${summary.handoffRequestsCount} handoff request${summary.handoffRequestsCount === 1 ? '' : 's'}`
    ].filter(Boolean).join(', ');
    renderNavAttentionMenu(summary);
    if (summary.total === 0) {
        closeNavAttentionMenu();
    }
}

navAttentionBadge?.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!navAttentionBadge.classList.contains('visible')) {
        return;
    }
    playClickSound();
    const willOpen = navAttentionMenu?.classList.contains('hidden');
    navAttentionMenu?.classList.toggle('hidden', !willOpen);
    navAttentionBadge.setAttribute('aria-expanded', String(Boolean(willOpen)));
});

document.addEventListener('click', (event) => {
    if (!navAttentionMenu || navAttentionMenu.classList.contains('hidden')) {
        return;
    }
    if (!navAttentionMenu.contains(event.target) && !navAttentionBadge?.contains(event.target)) {
        closeNavAttentionMenu();
    }
});

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        closeNavAttentionMenu();
        closeGroupTeamPulse();
    }
});

// Team-wide version of solo's updateUrgencyAlert() - scoped to every
// member's tasks in the group (not just yours), since the point is
// visibility into the whole team's deadline pressure, not just your own.
function updateGroupUrgencyAlert() {
    if (!groupUrgencyAlert || !groupUrgencyAlertText) {
        return;
    }

    const activeTasks = groupTasks.filter((task) => !task.completed);
    // Subtask-aware (getTaskUrgencyStatus, not getDeadlineStatus(task.dueAt)) -
    // mirrors the identical fix in solo's updateUrgencyAlert (script.js), so
    // a teammate's task with an overdue or soon-due step shows up in this
    // team-wide banner and the overdue count badge too.
    const rankedByUrgency = activeTasks
        .map((task) => ({ task, status: getTaskUrgencyStatus(task) }))
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

// Same subtask-aware urgency check updateGroupUrgencyAlert already uses,
// factored out here rather than reading a shared variable, so this stays
// correct independent of whatever order the two happen to run in during a
// render (renderApp calls the urgency update separately from this card).
function countGroupOverdueTasks() {
    return groupTasks
        .filter((task) => !task.completed)
        .map((task) => getTaskUrgencyStatus(task))
        .filter((status) => status.hasDeadline && status.urgencyLevel === 'overdue')
        .length;
}

// New-member catch-up (C.4): a compact "here's what you've missed" summary,
// built entirely from data already loaded for the dashboard itself (recent
// completions, the all-time leader, the overdue count) - no new Firestore
// reads. Capped at 3 short lines so it stays a glance, not a report; each
// omitted when it wouldn't say anything real (e.g. no leader yet in a group
// with only one completion logged).
function buildCatchUpSummaryLines(group) {
    const lines = [];

    if (groupHistoryEntries.length > 0) {
        const latest = groupHistoryEntries[0];
        const who = latest.ownerId === currentUser?.uid ? 'You' : (latest.ownerName || 'A teammate');
        lines.push(`${who} last finished "${latest.taskText}" ${formatFriendlyDateTime(new Date(latest.completedAt))}.`);
    }

    const memberIds = group.memberIds || [];
    const memberNames = group.memberNames || [];
    if (memberIds.length > 1 && groupHistoryEntries.length > 0) {
        const counts = memberIds.map((memberId, index) => ({
            memberId,
            name: resolveMemberName(memberId, memberNames[index], groupTasks),
            count: groupHistoryEntries.filter((entry) => entry.ownerId === memberId).length
        })).sort((a, b) => b.count - a.count);
        const leader = counts[0];
        // Skip only the exact redundant case - the same person is both the
        // most-recent completer (line above) AND the sole leader in a
        // two-person group, where a second line would just restate the
        // first. In a bigger group, "also leads the team" is still new
        // information even about the same person, so it stays.
        const wouldRestateFirstLine = memberIds.length === 2 && groupHistoryEntries[0]?.ownerId === leader?.memberId;
        if (leader && leader.count > 0 && !wouldRestateFirstLine) {
            const leaderLabel = leader.memberId === currentUser?.uid ? 'You' : leader.name;
            const verb = leader.memberId === currentUser?.uid ? 'lead' : 'leads';
            lines.push(`${leaderLabel} ${verb} the leaderboard with ${leader.count} task${leader.count === 1 ? '' : 's'} finished.`);
        }
    }

    const overdueCount = countGroupOverdueTasks();
    if (overdueCount > 0) {
        lines.push(overdueCount === 1
            ? '1 task across the group is currently overdue.'
            : `${overdueCount} tasks across the group are currently overdue.`);
    }

    return lines.slice(0, 3);
}

// Eligible only for a member who (a) didn't create this group - nothing to
// catch up on in a group you just made yourself, (b) has a real recorded
// join time - memberJoinedAt is only ever set going forward from when this
// feature shipped (see joinGroup/approveJoinRequest in groups-data.js), so
// an existing member from before that never gets this retroactively, the
// same "don't dump stale notifications on everyone at once" discipline this
// plan's own C.1 section calls out for a different feature, (c) hasn't
// already dismissed it for this group specifically, persisted server-side
// (catchUpDismissed) rather than a local flag, so it can't refire on a
// different device or after clearing site data, and (d) there's actually
// something to report - a brand-new group a member is invited into within
// seconds of its creation has nothing worth catching up on yet.
function shouldShowNewMemberCatchUp(group) {
    if (!currentUser || !group || group.ownerId === currentUser.uid) {
        return false;
    }
    const joinedAt = group.memberJoinedAt && group.memberJoinedAt[currentUser.uid];
    if (!joinedAt) {
        return false;
    }
    if (group.catchUpDismissed && group.catchUpDismissed[currentUser.uid]) {
        return false;
    }
    return groupHistoryEntries.length > 0 || countGroupOverdueTasks() > 0;
}

function renderNewMemberCatchUp(group) {
    if (!groupCatchUpCard) {
        return;
    }
    if (!shouldShowNewMemberCatchUp(group)) {
        groupCatchUpCard.classList.add('hidden');
        return;
    }
    if (groupCatchUpGroupName) {
        groupCatchUpGroupName.textContent = group.name;
    }
    if (groupCatchUpText) {
        groupCatchUpText.textContent = buildCatchUpSummaryLines(group).join('\n');
    }
    groupCatchUpCard.classList.remove('hidden');
}

if (groupCatchUpDismissBtn) {
    groupCatchUpDismissBtn.addEventListener('click', () => {
        playClickSound();
        // Hide right away rather than waiting on the round-trip - the
        // dismiss is a one-way, never-undone action (see
        // dismissNewMemberCatchUp), so there's nothing the eventual
        // snapshot update could disagree with once this write lands.
        groupCatchUpCard?.classList.add('hidden');
        const group = getSelectedGroup();
        if (group && currentUser) {
            dismissNewMemberCatchUp(group.id, currentUser.uid).catch((error) => {
                console.error('Failed to dismiss the catch-up card:', error);
            });
        }
    });
}

// Solo's equivalent (getRecommendedTask/getPriorityReasons/updateNextTaskPanel
// in script.js) had no group counterpart at all - group could sort by
// priority (compareGroupTasksByPriority) but never told anyone what to
// actually work on next or why. Scoped to whichever member-scope tab is
// currently active (activeMemberScope), same tabs the Tasks view already
// uses - "Everyone" recommends across the whole team, a specific teammate
// recommends from just their tasks, matching what the panel's label ends
// up saying.
function getGroupRecommendedTask() {
    const scopedTasks = activeMemberScope === 'all'
        ? groupTasks
        : groupTasks.filter((task) => task.ownerId === activeMemberScope);
    const activeTasks = scopedTasks.filter((task) => !task.completed);
    if (activeTasks.length === 0) {
        return null;
    }

    return [...activeTasks].sort(compareGroupTasksByPriority)[0];
}

// Mirrors getPriorityReasons() in script.js (the subtask-aware "why this is
// first" fix from f0c6430 - names the actual driving STEP, not the task,
// when a step's own deadline is what's urgent) applied to group's own
// scoring inputs. Deliberately does not cite task type/time estimate/
// scheduledAt as reasons - getGroupPriorityScore doesn't weight those, so
// listing them here would misrepresent why this task was actually picked.
function getGroupPriorityReasons(task) {
    const reasons = [];
    const status = getTaskUrgencyStatus(task);
    const matrix = getValidMatrixValue(task.matrix);
    const difficulty = getValidDifficultyLevel(task.difficulty);
    const drivingSubtask = status.fromStep
        ? (task.subtasks || []).find((subtask) => subtask.id === status.fromStep)
        : null;

    if (status.isOverdue) {
        reasons.push(drivingSubtask ? `A step ("${drivingSubtask.text}") is overdue right now.` : 'This task is overdue right now.');
    } else if (status.hasDeadline) {
        if (status.timeUntilMs <= 7200000) {
            reasons.push(drivingSubtask ? `A step ("${drivingSubtask.text}") is due very soon (within 2 hours).` : 'Deadline is very close (within 2 hours).');
        } else if (status.timeUntilMs <= 86400000) {
            reasons.push(drivingSubtask ? `A step ("${drivingSubtask.text}") is due today.` : 'Deadline is due today.');
        }
    }

    const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];
    if (subtasks.length > 0) {
        const doneCount = subtasks.filter((subtask) => subtask.completed).length;
        if (doneCount > 0 && doneCount < subtasks.length) {
            reasons.push(`Almost done: ${doneCount}/${subtasks.length} steps complete.`);
        }
    }

    if (matrix === 'do') {
        reasons.push('Marked as Important and Urgent.');
    } else if (matrix === 'schedule') {
        reasons.push('Marked as Important in the matrix.');
    } else if (matrix === 'delegate') {
        reasons.push('Marked as Urgent in the matrix.');
    }

    if (difficulty >= 4) {
        reasons.push('High difficulty tasks are moved up to avoid delay.');
    }

    if (reasons.length === 0) {
        reasons.push('Best overall priority score across the group right now.');
    }

    return reasons.slice(0, 3);
}

function updateGroupNextTaskPanel() {
    if (!groupNextTaskPanel || !groupNextTaskTitle || !groupNextTaskReasons) {
        return;
    }

    const recommended = getGroupRecommendedTask();
    if (!recommended) {
        groupNextTaskPanel.classList.add('hidden');
        return;
    }

    groupNextTaskPanel.classList.remove('hidden');

    // Label reflects the same scope the recommendation was actually drawn
    // from, so switching the whose-tasks tab never leaves a stale "is this
    // my task or theirs" implication sitting on screen.
    if (groupNextTaskLabel) {
        if (activeMemberScope === 'all') {
            groupNextTaskLabel.textContent = 'Do This Next';
        } else if (activeMemberScope === currentUser?.uid) {
            groupNextTaskLabel.textContent = 'Do This Next (you)';
        } else {
            groupNextTaskLabel.textContent = `Do This Next for ${recommended.ownerName || 'this teammate'}`;
        }
    }

    groupNextTaskTitle.textContent = recommended.text;
    groupNextTaskReasons.innerHTML = '';

    getGroupPriorityReasons(recommended).forEach((reason) => {
        const reasonItem = document.createElement('li');
        reasonItem.textContent = reason;
        groupNextTaskReasons.appendChild(reasonItem);
    });
}

// ---------------------------------------------------------------------
// Team pulse - group's own version of solo's weekly recap (script.js's
// maybeShowWeeklyRecap/showWeeklyRecap). Every existing group recognition
// mechanic (leaderboard, the roster streak flame) is about ONE person;
// this is the one moment that's about the team together. Same one-shot
// weekly-trigger mechanism and calm-card visual language, just pointed at
// groups/{groupId}/history instead of the personal one - see the plan's
// C.3 section.
// ---------------------------------------------------------------------

const GROUP_TEAM_PULSE_SHOWN_PREFIX = 'todoGroupTeamPulseShownAtV1_';
// In-memory only, per group id - a real "have we shown it" decision is a
// localStorage + Firestore round trip, not something to redo every time
// renderApp() re-runs off an unrelated snapshot update (a teammate ticking
// one checkbox shouldn't re-trigger this check).
const teamPulseCheckedGroupIds = new Set();

async function maybeShowGroupTeamPulse(group) {
    if (!group || !currentUser || teamPulseCheckedGroupIds.has(group.id)) {
        return;
    }
    teamPulseCheckedGroupIds.add(group.id);

    let lastShownAt = 0;
    try {
        lastShownAt = Number(localStorage.getItem(GROUP_TEAM_PULSE_SHOWN_PREFIX + group.id)) || 0;
    } catch {
        lastShownAt = 0;
    }
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    if (Date.now() - lastShownAt < sevenDaysMs) {
        return;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const currentWeekStart = new Date(today);
    currentWeekStart.setDate(today.getDate() - today.getDay());
    const lastWeekStart = new Date(currentWeekStart);
    lastWeekStart.setDate(currentWeekStart.getDate() - 7);

    let thisWeekCount = 0;
    let lastWeekCount = 0;
    // Tallied by ownerName (already denormalized on every history entry,
    // see logGroupTaskCompletion) so "top contributor" needs no extra
    // lookups - just counting this-week entries by whoever completed them.
    const thisWeekCountsByOwner = new Map();
    try {
        const { collection, query, where, getDocs } = fs();
        // One bounded 14-day range query, split into this-week/last-week
        // client-side - mirrors solo's maybeShowWeeklyRecap exactly, rather
        // than relying on the already-subscribed groupHistoryEntries (that
        // one's capped at 50 most recent across the WHOLE group and isn't
        // date-bounded, so an active group could blow past a week's worth
        // within that cap and undercount).
        const historyQuery = query(
            collection(db(), 'groups', group.id, 'history'),
            where('completedAt', '>=', lastWeekStart.toISOString())
        );
        const snapshot = await getDocs(historyQuery);
        const currentWeekStartIso = currentWeekStart.toISOString();
        snapshot.docs.forEach((entryDoc) => {
            const entry = entryDoc.data();
            if (typeof entry.completedAt !== 'string') {
                return;
            }
            if (entry.completedAt >= currentWeekStartIso) {
                thisWeekCount += 1;
                const ownerName = entry.ownerName || 'Teammate';
                thisWeekCountsByOwner.set(ownerName, (thisWeekCountsByOwner.get(ownerName) || 0) + 1);
            } else {
                lastWeekCount += 1;
            }
        });
    } catch (error) {
        console.error('Failed to load team pulse data:', error);
        return;
    }

    // Nothing happened yet this group's whole history AND nothing last
    // week either - too early for a "your week in review" to mean
    // anything (mirrors solo's totalCompletions === 0 guard).
    if (thisWeekCount === 0 && lastWeekCount === 0) {
        try {
            localStorage.setItem(GROUP_TEAM_PULSE_SHOWN_PREFIX + group.id, String(Date.now()));
        } catch {
        }
        return;
    }

    let topContributorName = null;
    let topContributorCount = 0;
    thisWeekCountsByOwner.forEach((count, ownerName) => {
        if (count > topContributorCount) {
            topContributorCount = count;
            topContributorName = ownerName;
        }
    });

    showGroupTeamPulse(thisWeekCount, lastWeekCount, topContributorName);

    try {
        localStorage.setItem(GROUP_TEAM_PULSE_SHOWN_PREFIX + group.id, String(Date.now()));
    } catch {
    }
}

function showGroupTeamPulse(thisWeekCount, lastWeekCount, topContributorName) {
    if (!teamPulseOverlay || !teamPulseTitle) {
        return;
    }

    let titleText;
    if (thisWeekCount > lastWeekCount) {
        titleText = 'The team picked up the pace';
    } else if (thisWeekCount > 0 && thisWeekCount === lastWeekCount) {
        titleText = 'Steady as ever';
    } else if (thisWeekCount > 0) {
        titleText = 'Still moving forward';
    } else {
        titleText = 'A quieter week';
    }
    teamPulseTitle.textContent = titleText;
    teamPulseThisWeek.textContent = String(thisWeekCount);
    teamPulseLastWeek.textContent = String(lastWeekCount);
    if (teamPulseTopContributor) {
        teamPulseTopContributor.textContent = topContributorName || '—';
    }

    teamPulseOverlay.classList.remove('hidden');
    teamPulseOverlay.setAttribute('aria-hidden', 'false');
}

function closeGroupTeamPulse() {
    if (!teamPulseOverlay) {
        return;
    }
    teamPulseOverlay.classList.add('hidden');
    teamPulseOverlay.setAttribute('aria-hidden', 'true');
}

if (teamPulseCloseBtn) {
    teamPulseCloseBtn.addEventListener('click', () => {
        playClickSound();
        closeGroupTeamPulse();
    });
}

if (teamPulseOverlay) {
    teamPulseOverlay.addEventListener('click', (event) => {
        if (event.target === teamPulseOverlay) {
            closeGroupTeamPulse();
        }
    });
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
    // Keyed on the effective deadline timestamp, not the task's own literal
    // dueAt - same fix as solo's maybeNotifyTaskUrgency (script.js), so a
    // step-driven reminder can't get silently suppressed by an unrelated
    // cooldown keyed to the task's own (different, non-firing) deadline.
    const notifyKey = `${task.id}|${status.deadlineTimestamp}|${stage}`;
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
        const trimmedGroupName = groupCreateNameInput.value.trim();
        try {
            const groupId = await createGroup(groupCreateNameInput.value, currentUser, groupCreatePrivacySelect?.value);
            groupCreateNameInput.value = '';
            selectGroup(groupId);
            // Reuses the same banner the ?join= deep link already shows on a
            // successful join (see showJoinLinkBanner below) - the group was
            // silent about "did that actually work?" before this, and
            // selectGroup() switching the setup screen for the real
            // dashboard isn't obvious enough on its own to read as
            // confirmation, especially the first time.
            showJoinLinkBanner(`"${trimmedGroupName}" created - you're in!`, 'success');
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
            // Same reuse as the create-group handler above - see its comment.
            showJoinLinkBanner('Joined the group - you\'re in!', 'success');
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

// The link is a UI convenience for the exact same joinGroup() call the
// manual-entry form above already makes - see maybeHandleJoinLink below,
// which reads this same ?join= param and hands it to the identical
// function. Nothing about how the code arrives changes what it's allowed
// to do; firestore.rules' group-membership write rule is what actually
// decides whether the join succeeds, same as it always has.
function buildGroupJoinLink(code) {
    // location.pathname already ends in "index.html" (or the bare "/group/"
    // directory) depending on how this page was reached - either way,
    // replacing everything after the last "/" with "index.html" gives a
    // real, working relative URL without hardcoding a leading-slash path
    // (see this project's own deploy-subpath convention).
    const basePath = location.pathname.replace(/[^/]*$/, 'index.html');
    return `${location.origin}${basePath}?join=${encodeURIComponent(code)}`;
}

if (groupCopyInviteLinkBtn) {
    groupCopyInviteLinkBtn.addEventListener('click', async () => {
        playClickSound();
        const group = getSelectedGroup();
        if (!group) {
            return;
        }
        try {
            await navigator.clipboard.writeText(buildGroupJoinLink(group.inviteCode || group.id));
            groupCopyInviteLinkBtn.title = 'Copied!';
        } catch {
            // Same clipboard-unavailable fallback as the bare-code button -
            // the code itself is still visible on screen to share by hand.
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
            // The button lives in the Group Settings modal, which would
            // otherwise stay open over whichever group renders next.
            closeGroupSettingsModal();
            selectedGroupId = null;
            activeMemberScope = 'all';
            renderApp();
        } catch (error) {
            console.error('Failed to leave group:', error);
            alert(describeGroupWriteError(error, 'Could not leave the group.'));
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
            closeGroupSettingsModal();
            selectedGroupId = null;
            activeMemberScope = 'all';
            renderApp();
        } catch (error) {
            console.error('Failed to delete group:', error);
            alert(describeGroupWriteError(error, 'Could not delete the group.'));
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

// Steps added before a task even exists yet - uses the same
// createSubtaskRowsEditor (task-shared.js) Dusty's review cards and solo's
// own creation flow (script.js) use, so a drafted step can carry its own
// deadline instead of plain text only. Rebuilt fresh (not just cleared)
// after each task add/on first load - simpler than tracking a "reset"
// concept inside the editor itself, and guarantees no leftover event
// listeners from a previous instance. Mirrors script.js's identical
// pattern exactly (previously this was its own plain-string
// pendingNewTaskSteps implementation, replaced here to match solo).
let pendingStepsEditor = null;

function mountPendingStepsEditor() {
    if (!pendingStepsEditorMount) {
        return;
    }
    pendingStepsEditorMount.innerHTML = '';
    pendingStepsEditor = createSubtaskRowsEditor([]);
    pendingStepsEditorMount.appendChild(pendingStepsEditor.element);
}

mountPendingStepsEditor();

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

    // Form only clears/resets once the write actually succeeds - clearing
    // it unconditionally beforehand made a failed add (e.g. stale security
    // rules) look identical to a successful one, with the typed task
    // vanishing from the input and never appearing in the list either.
    addGroupTask(group.id, currentUser, {
        text: taskText,
        matrix: matrixSelect?.value,
        difficulty: difficultySelect?.value,
        dueAt,
        recurrence,
        scheduledAt,
        taskType,
        estimateMinutes,
        subtasks: pendingStepsEditor ? pendingStepsEditor.read() : []
    }).then(() => {
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
        mountPendingStepsEditor();
        setTaskTypePillState('open');
        updateDurationInputVisibility();
        quickAddHint?.classList.add('hidden');
        taskInput.focus();
    }).catch((error) => {
        console.error('Failed to add task:', error);
        alert(describeGroupWriteError(error, 'Could not add the task.'));
    });
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
            // A real bug this closes: this was passed through completely
            // uncapped, relying only on firestore.rules' 2000-char doc-size
            // limit (which would just reject an oversized write, not what's
            // happening here) - nowhere near "a short, clear title" per the
            // Worker's own prompt. See task-shared.js's
            // AI_TASK_TITLE_MAX_LENGTH comment for the observed failure this
            // guards against (a degenerate Gemini repetition loop).
            text: trimmedText.slice(0, AI_TASK_TITLE_MAX_LENGTH),
            matrix: draft.matrix,
            difficulty: draft.difficulty,
            dueAt: isValidDateValue(draft.dueAt) ? new Date(draft.dueAt).toISOString() : null,
            scheduledAt: isValidDateValue(draft.scheduledAt) ? new Date(draft.scheduledAt).toISOString() : null,
            // addGroupTask already null-guards this against a missing dueAt
            // (see its own "recurrence: dueAt ? ... : null" line) - Dusty
            // just needed a way to populate it at all, which it never had.
            recurrence: draft.recurrence,
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
        if (Object.prototype.hasOwnProperty.call(draft, 'text') && draft.text && draft.text.trim()) {
            fieldUpdates.text = draft.text.trim().slice(0, AI_TASK_TITLE_MAX_LENGTH);
        }
        if (Object.prototype.hasOwnProperty.call(draft, 'subtasks') && Array.isArray(draft.subtasks)) {
            // applyEditedSubtasks (task-shared.js) - full replace, preserving
            // id/completed for any step whose text still matches.
            fieldUpdates.subtasks = applyEditedSubtasks(realTask.subtasks, draft.subtasks);
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
    // Tasks, suggestions AND history (history used to be missed here, so it
    // stayed attached to the previous account's group after sign-out).
    stopWatchingSelectedGroup();
    watchedGroupId = null;
    groupHistoryEntries = [];
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

function stopWatchingSelectedGroup() {
    if (unsubscribeTasks) {
        unsubscribeTasks();
        unsubscribeTasks = null;
    }
    if (unsubscribeSuggestions) {
        unsubscribeSuggestions();
        unsubscribeSuggestions = null;
    }
    if (unsubscribeHistory) {
        unsubscribeHistory();
        unsubscribeHistory = null;
    }
}

// Leaving, being removed, or the group being deleted all make the server
// revoke these listeners, and that revocation arrives as permission-denied -
// often a moment BEFORE the groups snapshot that drops the group does (for
// the other members of a deleted group, it's a straight race). Waiting
// briefly and then only surfacing the error if you're still watching that
// group AND still have it in your list keeps that expected noise out of the
// console and the UI, without hiding a genuine error for a group you still
// belong to (unpublished rules, etc. - those still show, ~1.5s later).
const GROUP_LISTENER_ERROR_GRACE_MS = 1500;
function handleSelectedGroupListenerError(groupId, error, surface) {
    if (error?.code !== 'permission-denied') {
        surface();
        return;
    }
    setTimeout(() => {
        const stillRelevant = watchedGroupId === groupId && (groups || []).some((group) => group.id === groupId);
        if (stillRelevant) {
            surface();
        }
    }, GROUP_LISTENER_ERROR_GRACE_MS);
}

// Called on every groups-list snapshot and on selectGroup(). Real read-quota
// bug (measured live): this used to tear down and re-open tasks, suggestions
// and history on EVERY call, so each rename, privacy change, member join or
// approval re-opened all three queries for every member (twice for the
// owner on an approve: local, then server snapshot). Now:
// - an actual switch (another group, or none) tears all three down and
//   resets the loaded flag - including suggestions/history, which the old
//   early "no group" return used to leave attached to a group you'd just
//   left or deleted, until the server revoked them;
// - the same group again only (re)opens a listener that isn't live - e.g.
//   one that errored, which marks itself dead below so it's re-openable on
//   the next call instead of staying dead until a reload.
// Group-doc fields the UI derives from (memberIds, names, roles) don't need
// a re-query - the groups snapshot already updated `groups` and called
// renderApp().
function watchSelectedGroupTasks() {
    const group = getSelectedGroup();
    const groupId = group?.id || null;
    // Real bug found in review: this function doesn't only run when the
    // user switches groups - subscribeToMyGroups's own onSnapshot callback
    // calls it too, on any change to the groups list (a rename, a member
    // joining, etc.) with the same group still selected. Unconditionally
    // resetting the flag there discarded the real, already-loaded task
    // list and flashed the skeleton rows for no reason. Only an actual
    // switch to a different group (or to no group) should reset it.
    const isActualGroupSwitch = groupId !== watchedGroupId;
    if (isActualGroupSwitch) {
        stopWatchingSelectedGroup();
        watchedGroupId = groupId;
        hasLoadedGroupTasksOnce = false;
    }
    if (!group) {
        groupTasks = [];
        groupSuggestions = [];
        groupHistoryEntries = [];
        groupHistoryLoadError = null;
        renderApp();
        return;
    }

    if (!unsubscribeTasks) {
        const tasksUnsubscribe = subscribeToGroupTasks(groupId, (tasks) => {
            groupTasks = tasks;
            groupTasksLoadError = null;
            hasLoadedGroupTasksOnce = true;
            renderApp();
        }, (error) => {
            if (unsubscribeTasks !== tasksUnsubscribe) {
                return; // already torn down (group switch / sign-out)
            }
            unsubscribeTasks = null; // Firestore ended it; re-openable on the next call
            handleSelectedGroupListenerError(groupId, error, () => {
                console.error('Failed to load group tasks:', error);
                groupTasks = [];
                groupTasksLoadError = error?.code === 'permission-denied'
                    ? 'Tasks couldn\'t load (the security rules need to be published).'
                    : 'Could not load tasks.';
                hasLoadedGroupTasksOnce = true;
                renderApp();
            });
        });
        unsubscribeTasks = tasksUnsubscribe;
    }

    if (!unsubscribeSuggestions) {
        const suggestionsUnsubscribe = subscribeToGroupSuggestions(groupId, (suggestions) => {
            groupSuggestions = suggestions;
            renderApp();
        }, (error) => {
            if (unsubscribeSuggestions !== suggestionsUnsubscribe) {
                return;
            }
            unsubscribeSuggestions = null;
            handleSelectedGroupListenerError(groupId, error, () => {
                console.error('Failed to load suggestions:', error);
                groupSuggestions = [];
                renderApp();
            });
        });
        unsubscribeSuggestions = suggestionsUnsubscribe;
    }

    if (!unsubscribeHistory) {
        const historyUnsubscribe = subscribeToGroupHistory(groupId, (entries) => {
            groupHistoryEntries = entries;
            groupHistoryLoadError = null;
            renderApp();
        }, (error) => {
            if (unsubscribeHistory !== historyUnsubscribe) {
                return;
            }
            unsubscribeHistory = null;
            handleSelectedGroupListenerError(groupId, error, () => {
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
        });
        unsubscribeHistory = historyUnsubscribe;
    }
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
            alert(describeGroupWriteError(error, 'Could not save your name.'));
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

// Same purpose as solo's getMostRecentlyCreatedTask (script.js), scoped to
// groupTasks instead - used by GROUP_TOUR_STEPS' subtask-sequence steps
// below to find the task the tour itself just created, not whichever task
// happens to render first. createdAt on a group task is an ISO string (see
// addTaskToGroup), compared the same way this file already compares it
// elsewhere (localeCompare), not solo's plain > (which only works because
// solo's are also strings, but this file already has its own convention).
function getMostRecentlyCreatedGroupTask() {
    return groupTasks.reduce((newest, task) => {
        if (!task.createdAt) {
            return newest;
        }
        return (!newest || task.createdAt.localeCompare(newest.createdAt) > 0) ? task : newest;
    }, null);
}

// Hosted by Dusty now, speaking to you directly in first and second person
// throughout, same reasoning and same action-gating rules as solo's
// TOUR_STEPS (script.js) - he introduces himself up front, nearly every
// step is action-gated so you actually try the real thing rather than just
// reading about it, the whole run culminates in a real task you build and
// add along the way, and it ends with you meeting Dusty for real. Commas
// only, never a hyphen as punctuation.
const GROUP_TOUR_STEPS = [
    {
        selector: '.brainDumpToggleBtn',
        title: 'Hi, I\'m Dusty',
        text: 'Hey, I\'m Dusty, nice to meet you. I\'ll be your guide to this group, and this won\'t just be me talking at you, you\'ll actually try everything yourself as we go. By the time we\'re done, you\'ll already have a real task on the list, built by you, and you\'ll have met me for real too. Ready? Let\'s go.'
    },
    {
        selector: '.inputContainer',
        title: 'Let\'s add your first task',
        text: 'Go ahead, type something you or the team needs done, right here. Don\'t worry about the details yet, I\'ll help you with those next, matrix, difficulty, deadline, and repeat all carry over from solo.',
        action: { event: 'input', validate: (target) => (target.querySelector('.taskInput')?.value.trim() || '') !== '' },
        beforeShow: () => switchGroupView('tasks')
    },
    {
        selector: '.detailsStepsGroup',
        title: 'Steps',
        text: 'If you already know how you\'ll break this one down, add steps right here, each one can even get its own deadline. Totally optional, skip it if you don\'t need it for this task.',
        beforeShow: () => switchGroupView('tasks')
    },
    {
        selector: '.detailsToggleBtn',
        title: 'Let\'s open Prioritize',
        text: 'Now tap Prioritize, and I\'ll show you everything that helps me figure out what matters most for a new task.',
        action: { event: 'click' },
        beforeShow: () => switchGroupView('tasks')
    },
    {
        selector: '.matrixSelect',
        title: 'Matrix',
        text: 'This is matrix, how urgent something is and how important it is. It\'s the biggest single thing I weigh when deciding what should come first. Go ahead, pick whichever fits your task.',
        action: { event: 'change' },
        beforeShow: () => { switchGroupView('tasks'); taskDetailsPanel?.classList.add('open'); }
    },
    {
        selector: '.difficultySelect',
        title: 'Difficulty',
        text: 'Difficulty is just your own honest guess, from very easy to very hard. It helps me tell the difference between something quick and something that actually needs real effort. Try picking one now.',
        action: { event: 'change' },
        beforeShow: () => { switchGroupView('tasks'); taskDetailsPanel?.classList.add('open'); }
    },
    {
        selector: '.deadlineContainer',
        title: 'Deadline',
        text: 'Deadline is simply when something is due. Tap here, and I\'ll factor whatever you set into everything, sorting, alerts, all of it.',
        action: { event: 'click' },
        beforeShow: () => { switchGroupView('tasks'); taskDetailsPanel?.classList.add('open'); }
    },
    {
        selector: '.recurrenceSelect',
        title: 'Repeat',
        text: 'If something happens again and again, taking out the trash weekly, rent every month, set it to repeat here. I\'ll bring it back automatically once it\'s done. Give it a try.',
        action: { event: 'change' },
        beforeShow: () => { switchGroupView('tasks'); taskDetailsPanel?.classList.add('open'); }
    },
    {
        selector: '.detailsMoreToggleBtn',
        title: 'More options',
        text: 'Tap here for a couple more things: a rough time estimate, and a schedule for when you actually plan to sit down and do it.',
        action: { event: 'click' },
        beforeShow: () => { switchGroupView('tasks'); taskDetailsPanel?.classList.add('open'); }
    },
    {
        selector: '.effortContainer',
        title: 'Estimate',
        text: 'Give me a rough time estimate if you have one, tap one of the quick options here. It helps me tell you honestly whether the team\'s day is actually realistic, not just busy.',
        action: { event: 'click' },
        beforeShow: () => { switchGroupView('tasks'); taskDetailsPanel?.classList.add('open'); detailsMoreOptions?.classList.add('open'); }
    },
    {
        selector: '.scheduleContainer',
        title: 'Schedule',
        text: 'Schedule is different from deadline, it\'s when you actually plan to sit down and work on it, not when it\'s due. Both are optional, and they don\'t have to match. Tap here to set one.',
        action: { event: 'click' },
        beforeShow: () => { switchGroupView('tasks'); taskDetailsPanel?.classList.add('open'); detailsMoreOptions?.classList.add('open'); }
    },
    {
        selector: '.addBtn',
        title: 'Now, add it for real',
        text: 'You\'ve set it up exactly how you want it. Go ahead, tap + and let\'s actually put this task on the list.',
        action: { event: 'click' },
        beforeShow: () => switchGroupView('tasks')
    },
    {
        // Placeholder selector - every step below rewrites its own
        // step.selector inside beforeShow(step), scoped to whichever task
        // getMostRecentlyCreatedGroupTask() finds, same reasoning as
        // solo's own equivalent steps (script.js's TOUR_STEPS): a tour
        // RESTART (the always-available .helpTourBtn) can run on a group
        // that already has tasks, so a bare document.querySelector would
        // grab whichever task happens to render first, not necessarily the
        // one this tour just created.
        selector: '.subtasksToggleBtn',
        title: 'Break it into steps',
        text: 'Big tasks go down easier in pieces. Tap here to open up steps for what you just added.',
        action: { event: 'click' },
        beforeShow: (step) => {
            switchGroupView('tasks');
            const latest = getMostRecentlyCreatedGroupTask();
            if (latest) {
                step.selector = `[data-task-id="${latest.id}"] .subtasksToggleBtn`;
            }
        }
    },
    {
        selector: '.subtaskInput',
        title: 'Add a step',
        text: 'Type one real thing this task involves, right here.',
        action: { event: 'input', validate: (target) => (target.value || '').trim() !== '' },
        beforeShow: (step) => {
            const latest = getMostRecentlyCreatedGroupTask();
            if (latest) {
                step.selector = `[data-task-id="${latest.id}"] .subtaskInput`;
            }
        }
    },
    {
        selector: '.subtaskAddBtn',
        title: 'Add it',
        text: 'Tap + to actually add that step. Anyone on the task can check steps off one at a time, separately from the task itself.',
        action: { event: 'click' },
        beforeShow: (step) => {
            const latest = getMostRecentlyCreatedGroupTask();
            if (latest) {
                step.selector = `[data-task-id="${latest.id}"] .subtaskAddBtn`;
            }
        }
    },
    {
        selector: '.subtaskDeadlineBtn',
        title: 'Give that step its own deadline',
        text: 'A step can have its own deadline, separate from the task\'s overall one. Tap the clock, and it\'ll show up in Today, Overdue, and the Calendar the moment that step\'s own date gets close, even if the whole task isn\'t due for weeks. That\'s how you spread a big project across several days instead of leaving it all for one deadline at the end.',
        action: { event: 'click' },
        beforeShow: (step) => {
            const latest = getMostRecentlyCreatedGroupTask();
            const newestSubtask = latest?.subtasks?.[latest.subtasks.length - 1];
            if (latest && newestSubtask) {
                step.selector = `[data-task-id="${latest.id}"] [data-subtask-id="${newestSubtask.id}"] .subtaskDeadlineBtn`;
            }
        }
    },
    {
        // Same "most recently created task" targeting as the steps sequence
        // above - the Handoff button only exists once a group has more than
        // one member (see canHandoff in createGroupTaskItem), guarded below
        // the same way the member-scope-tabs step already guards for a
        // solo group.
        selector: '.handoffBtn',
        title: 'Hand off a task',
        text: 'Got too much on your plate? Offer one of your own tasks to a specific teammate right from its buttons here. They\'ll see it waiting on them and can accept or decline, nothing changes until they do.',
        isRelevant: () => (getSelectedGroup()?.memberIds || []).length > 1,
        beforeShow: (step) => {
            switchGroupView('tasks');
            const latest = getMostRecentlyCreatedGroupTask();
            if (latest) {
                step.selector = `[data-task-id="${latest.id}"] .handoffBtn`;
            }
        }
    },
    {
        selector: '.nextTaskPanel',
        title: 'Do This Next',
        text: 'This is Do This Next, the one task I think whoever\'s selected above should tackle first, and why, so nobody\'s stuck wondering where to start.',
        // Guarded on there actually being a live recommendation right now,
        // not just "does a task exist" - an earlier tour step above lets
        // you switch member scope or filter the view, either of which can
        // leave nothing recommendable in the CURRENT scope even though
        // tasks exist elsewhere.
        isRelevant: () => Boolean(getGroupRecommendedTask()),
        beforeShow: () => switchGroupView('tasks')
    },
    {
        selector: '.groupMemberScopeTabs',
        title: 'Whose tasks',
        text: 'See everyone\'s tasks together, just your own, or drill into one teammate\'s. Go ahead and try one, you should even see the task you just added, and a Suggest a task button appears right here for whoever you pick.',
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
        selector: '.viewTabs',
        title: 'One place for each job',
        text: 'Tasks is where you\'ve been working. Go ahead, tap through the others: Team, Calendar, Leaderboard, Availability, and Activity. Everyone\'s roles, schedule, rankings, meeting times, and finished work all live there whenever you want them.',
        action: { event: 'click' },
        beforeShow: () => switchGroupView('tasks')
    },
    {
        selector: '.memberRoster',
        title: 'Team',
        text: 'Everyone in the group, their role, and their current progress. Keep an eye out for a little flame next to a name, that\'s a real streak, the same one solo tracks, just visible here too. Go ahead, click a card, that switches Tasks over to just their work, same as picking them above.',
        action: { event: 'click' },
        beforeShow: () => switchGroupView('team')
    },
    {
        selector: '.groupLeaderboardPanel',
        title: 'Leaderboard',
        text: 'Ranked by completions. Go ahead, try switching between this week, this month, and all time.',
        action: { event: 'click' },
        beforeShow: () => switchGroupView('leaderboard')
    },
    {
        selector: '.groupHistoryPanel',
        title: 'Activity',
        text: 'A running log of what the team has been finishing, newest first.',
        beforeShow: () => switchGroupView('activity')
    },
    {
        selector: '.calendarPanel',
        title: 'Calendar',
        text: 'Everyone\'s due dates and planned work, laid out by day, each teammate gets their own color so whose task is on what day reads at a glance. Only your own tasks are clickable to edit.',
        beforeShow: () => switchGroupView('calendar')
    },
    {
        // The sub-tab bar, not the grid: it's static HTML, so it exists even
        // for a group whose availability hasn't loaded yet (the grid stays
        // hidden until the fetch lands). Leaves whichever sub-view is current
        // alone rather than forcing one, so the tour never opens the
        // group-wide listener on its own.
        selector: '.availabilitySubTabs',
        title: 'Availability',
        text: 'Find a time the whole team can meet. Under My availability everything starts out free, so just paint the times you\'re busy (or If needed). Then check Team overlap to see when everyone\'s around, and Best times for the slots that work for the most people. Times show in your own timezone (tap Change if it\'s wrong), Week or Day switches the layout, and teammates only ever see free, busy, or if needed, never why.',
        beforeShow: () => switchGroupView('availability')
    },
    {
        selector: '.groupBrowseAllLink',
        title: 'Managing multiple groups',
        text: 'See every group you\'re in, with each one\'s members, right from here.',
        beforeShow: () => switchGroupView('tasks')
    },
    {
        selector: '.groupCopyInviteLinkBtn',
        title: 'Bring your team in',
        text: 'See the invite code and Copy link up top? Share either one to bring someone into this group, the code if you\'d rather they type it in themselves, or Copy link for a one-tap join with the code already filled in.',
        beforeShow: () => switchGroupView('tasks')
    },
    {
        selector: '.groupAlertToggleBtn',
        title: 'Popup alerts',
        text: 'Turn this on any time you want a desktop notification when one of your own tasks in this group is due soon or overdue.',
        beforeShow: () => switchGroupView('tasks')
    },
    {
        // Open to every member since Leave moved in here (see
        // openGroupSettingsModal), so no role guard is needed.
        selector: '.groupSettingsBtn',
        title: 'Group settings',
        text: 'Anyone can open Group settings. It\'s where you leave this group, and where the owner can delete it. Owners and admins also handle who can join and pending join requests there, and the owner sets the group\'s usual hours for Availability.',
        beforeShow: () => switchGroupView('tasks')
    },
    {
        selector: '.navAttentionBadge',
        title: 'Notifications',
        text: 'This bell shows up whenever something needs you: unread comments, join requests if you own or admin the group, tasks suggested to you, and when a suggestion you sent gets accepted or dismissed. Tap it to jump straight to whatever needs you.',
        // The bell is display:none while nothing is pending (see
        // .navAttentionBadge in style.css), and there's no other always-
        // visible bell to point at, so skip the step rather than highlight
        // an invisible element. Checked via getClientRects, not offsetParent.
        isRelevant: () => Boolean(navAttentionBadge) && navAttentionBadge.getClientRects().length > 0,
        beforeShow: () => switchGroupView('tasks')
    },
    {
        selector: '.brainDumpToggleBtn',
        title: 'Now, come say hi',
        text: 'That\'s everything, and now it\'s your turn to actually meet me. Tap me, and let\'s talk for real. I can suggest a task to a teammate, comment on one of their tasks, or edit one of your own, always showing you exactly what I\'d send before anything goes out. I also think ahead, ask who\'s overloaded or where deadlines collide across the team, and I\'ll answer with real numbers, not a guess.',
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
                alert(describeGroupWriteError(error, 'Could not save your name - you can set it later in the dashboard.'));
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

// Despite the name (kept as-is to avoid a churny rename of the .joinLinkBanner
// element/CSS it drives), this is also now the shared success/error banner
// for the plain create-group and join-by-code forms above - same element,
// same visual language, one banner instead of three near-identical ones.
function showJoinLinkBanner(message, kind) {
    if (!joinLinkBanner || !joinLinkBannerText) {
        return;
    }
    joinLinkBannerText.textContent = message;
    joinLinkBanner.classList.remove('hidden', 'joinLinkBannerSuccess', 'joinLinkBannerError');
    if (kind === 'success') {
        joinLinkBanner.classList.add('joinLinkBannerSuccess');
    } else if (kind === 'error') {
        joinLinkBanner.classList.add('joinLinkBannerError');
    }
}

function getJoinCodeFromUrl() {
    const code = new URLSearchParams(location.search).get('join');
    return code ? code.trim() : '';
}

// Clears the ?join= param once handled (success, failure, or already-
// resolved) so a page refresh never re-attempts the same join, and the
// code doesn't linger indefinitely in the visible URL bar. replaceState
// keeps this off the back-button history rather than adding an extra step.
function stripJoinParamFromUrl() {
    const url = new URL(location.href);
    url.searchParams.delete('join');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
}

// One-shot per page load, guarded separately from hasCheckedGroupWelcome
// above since either can legitimately fire without the other. Hooked into
// onSignedIn rather than a page-load check specifically so this works
// whether the user was ALREADY signed in (fires immediately) or just
// completed sign-in through the auth gate on this same page (fires right
// after) - the ?join= param survives that whole flow untouched since
// nothing strips or redirects it before this runs.
let hasHandledJoinLink = false;

async function maybeHandleJoinLink(user) {
    if (hasHandledJoinLink) {
        return;
    }
    const code = getJoinCodeFromUrl();
    if (!code) {
        return;
    }
    hasHandledJoinLink = true;

    try {
        // Same joinGroup() the manual-entry form calls - a link is exactly
        // as safe as typing the code, since the same firestore.rules write
        // decides whether it succeeds either way (see buildGroupJoinLink's
        // comment above).
        const { groupId, status } = await joinGroup(code, user);
        if (status === 'requested') {
            showJoinLinkBanner('Join request sent via invite link - you\'ll get in once the group\'s owner or an admin approves it.', 'info');
        } else {
            selectGroup(groupId);
            showJoinLinkBanner('Joined the group via invite link!', 'success');
        }
    } catch (error) {
        // Same combined message the manual form already shows for this
        // exact error (invalid code, closed group, or already a member -
        // the client genuinely can't tell which, see joinGroup's own
        // comment) - an already-a-member visitor sees this instead of a
        // silent no-op, which is an acceptable, pre-existing limitation
        // shared with manual entry, not something new this link adds.
        showJoinLinkBanner(error.message || 'Could not join - the invite link may be invalid or expired.', 'error');
    } finally {
        stripJoinParamFromUrl();
    }
}

AuthGate.init({
    onSignedIn: (user, profileReady) => {
        currentUser = user;
        groups = undefined;
        renderApp();
        loadGroupSettings();
        startGroupRealtimeUpdates();
        maybeHandleJoinLink(user).catch((error) => console.error('Failed to handle join link:', error));
        // First time THIS app has ever been opened on this account - see
        // shouldAutoPlayGroupTour above. Fire-and-forget (not awaited) so
        // this one extra Firestore read never delays the group list itself
        // loading below - maybeAutoStartGroupTour() still gates on the
        // dashboard actually being visible, so calling it here is just a
        // safety net; the render calls elsewhere are what actually catch
        // it once a group's data has loaded.
        //
        // profileReady (see firebase-init.js's onAuthChange) is the
        // users/{uid} profile-doc write settling - waited on here before
        // checkAndMarkTourSeen reads that same doc's createdAt field, so
        // this never mistakes a brand-new account (doc not written yet)
        // for a legacy one and skips the tour. Without this wait, a
        // Google sign-up - slower to reach this point than an
        // email/password one, since the popup flow's extra cross-origin
        // handshake delays Firestore getting a healthy authenticated
        // connection - could run this read before ensureUserProfile's
        // write landed.
        profileReady
            .then(() => window.ToDoAuth.checkAndMarkTourSeen(user, 'group'))
            .then(({ shouldAutoPlay, isLegacyAccount }) => {
                shouldAutoPlayGroupTour = shouldAutoPlay;
                isLegacyTourAccount = isLegacyAccount;
                renderGroupOnboardingHint();
                maybeAutoStartGroupTour();
            })
            .catch((error) => console.error('Failed to check group tour auto-play eligibility:', error));
        loadProfileName(user, (name) => {
            if (yourNameInput) {
                yourNameInput.value = name;
            }
            maybeShowGroupWelcome(user, name);
        });

        unsubscribeGroups = subscribeToMyGroups(user.uid, (nextGroups) => {
            groups = nextGroups;
            groupsLoadError = null;
            if (!groups.some((group) => group.id === selectedGroupId)) {
                selectedGroupId = groups[0]?.id || null;
            }
            renderApp();
            watchSelectedGroupTasks();
        }, (error) => {
            console.error('Failed to load your groups:', error);
            // Never wipe an already-loaded groups list on a listener error -
            // that would make real groups look like they vanished. Only
            // default to [] if nothing had loaded yet.
            if (groups === undefined) {
                groups = [];
            }
            groupsLoadError = error?.code === 'permission-denied'
                ? 'Your groups couldn\'t load (the security rules need to be published).'
                : 'Could not load your groups.';
            renderApp();
        });
    },
    onSignedOut: () => {
        resetGroupState();
    }
});
