// Group workflow: task STATUS (To do / In progress / Blocked / In review), SIGN-OFF (the person
// who assigned a task approves it or sends it back), and @MENTIONS in comments.
//
//  - status lives on the task itself (status, blockedReason, reviewNote, ...). Only the task's
//    owner sets it, except that the person who ASSIGNED a task may answer a review (approve or
//    send back) - firestore.rules allows exactly that and nothing else.
//  - "Approved" does not complete the task by itself: the owner's own page finishes it the
//    normal way, so streaks, history and the leaderboard still credit the right person.
//  - Every change tells the right people through the notification bell (notifications.js).
//
// Also here: DEPENDENCIES. A task can wait for up to 5 other open tasks in the group (its own
// owner chooses; ids only are stored, in `dependsOn`). Nothing is blocked by force - the card
// just shows what it is waiting for, and its owner is told when the last one is finished.
//
// Wired up by group.js through GroupWorkflow.configure(). All names/text are rendered with
// textContent. Classic script, loaded before group.js.

const GroupWorkflow = (() => {
    const STATUS_INFO = {
        inprogress: { label: 'In progress', icon: 'fa-play' },
        blocked: { label: 'Blocked', icon: 'fa-hand' },
        review: { label: 'In review', icon: 'fa-clipboard-check' },
        approved: { label: 'Approved', icon: 'fa-circle-check' }
    };
    const REASON_MAX = 200;
    const NOTE_MAX = 300;

    let ctx = null;

    // ctx: { fs(), db(), getGroup(), getUser(), getTasks(), nameFor(uid, storedName), playClick() }
    function configure(context) {
        ctx = context;
    }

    const clip = (value, max) => String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim().slice(0, max);
    const notify = (details) => window.NotificationCenter?.notify(details);

    function myName() {
        const user = ctx.getUser();
        return clip(typeof displayNameFor === 'function' ? displayNameFor(user) : (user.displayName || 'Someone'), 80);
    }

    // ---- a tiny "type something" dialog ---------------------------------------

    function askForText({ title, message, placeholder, confirmLabel = 'Save', maxLength = 200, required = false, initial = '' }) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'folderManagerOverlay askTextOverlay';
            const card = document.createElement('div');
            card.className = 'folderManagerCard askTextCard';
            card.setAttribute('role', 'dialog');
            card.setAttribute('aria-modal', 'true');
            card.setAttribute('aria-label', title);
            const heading = document.createElement('h2');
            heading.textContent = title;
            card.appendChild(heading);
            if (message) {
                const help = document.createElement('p');
                help.className = 'rolesHelp';
                help.textContent = message;
                card.appendChild(help);
            }
            const input = document.createElement('textarea');
            input.className = 'askTextInput';
            input.rows = 3;
            input.maxLength = maxLength;
            input.placeholder = placeholder || '';
            input.value = initial;
            input.setAttribute('aria-label', title);
            card.appendChild(input);
            const error = document.createElement('p');
            error.className = 'folderManagerError';
            error.setAttribute('role', 'alert');
            card.appendChild(error);
            const actions = document.createElement('div');
            actions.className = 'askTextActions';
            const cancel = document.createElement('button');
            cancel.type = 'button';
            cancel.className = 'whatsNewSecondaryBtn';
            cancel.textContent = 'Cancel';
            const ok = document.createElement('button');
            ok.type = 'button';
            ok.className = 'whatsNewDoneBtn';
            ok.textContent = confirmLabel;
            actions.append(cancel, ok);
            card.appendChild(actions);
            overlay.appendChild(card);
            document.body.appendChild(overlay);

            const finish = (value) => {
                overlay.remove();
                resolve(value);
            };
            const submit = () => {
                const value = clip(input.value, maxLength);
                if (required && !value) {
                    error.textContent = 'Please write a short reason.';
                    input.focus();
                    return;
                }
                finish(value);
            };
            cancel.addEventListener('click', () => finish(null));
            ok.addEventListener('click', submit);
            overlay.addEventListener('click', (event) => {
                if (event.target === overlay) {
                    finish(null);
                }
            });
            overlay.addEventListener('keydown', (event) => {
                if (event.key === 'Escape') {
                    event.stopPropagation();
                    finish(null);
                } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault();
                    submit();
                }
            });
            input.focus();
        });
    }

    // ---- status ---------------------------------------------------------------

    // Who needs to hear that someone is stuck: whoever assigned it, plus the group's owner/admins.
    function managersFor(task, group) {
        const ids = new Set();
        if (task.assignedBy) {
            ids.add(task.assignedBy);
        }
        if (group.ownerId) {
            ids.add(group.ownerId);
        }
        (group.adminIds || []).forEach((uid) => ids.add(uid));
        const me = ctx.getUser().uid;
        ids.delete(me);
        ids.delete(task.ownerId);
        return Array.from(ids).filter((uid) => (group.memberIds || []).includes(uid));
    }

    async function setStatus(groupId, task, status, { reason } = {}) {
        const { doc, updateDoc } = ctx.fs();
        const now = new Date().toISOString();
        const update = {
            status: status || null,
            blockedReason: status === 'blocked' ? clip(reason, REASON_MAX) : null,
            statusUpdatedAt: now,
            updatedAt: now
        };
        if (status === 'review') {
            update.reviewRequestedAt = now;
            update.reviewNote = null;
        }
        await updateDoc(doc(ctx.db(), 'groups', groupId, 'tasks', task.id), update);

        const group = ctx.getGroup();
        const me = myName();
        if (status === 'blocked' && group) {
            const who = managersFor(task, group);
            window.NotificationCenter?.notifyMany(who, {
                type: 'status',
                title: `${me} is blocked on a task`,
                body: clip(task.text, 120) + (update.blockedReason ? ' - ' + update.blockedReason : ''),
                groupId,
                groupName: group.name,
                taskId: task.id,
                actorName: me
            });
        } else if (status === 'review' && task.assignedBy && task.assignedBy !== ctx.getUser().uid) {
            notify({
                toUid: task.assignedBy,
                type: 'review',
                title: `${me} sent a task for your review`,
                body: task.text,
                groupId,
                groupName: group?.name,
                taskId: task.id,
                actorName: me
            });
        }
    }

    // The person who assigned a task answers a review: 'approved' or 'inprogress' (send back).
    async function reviewTask(groupId, task, decision, note) {
        const { doc, updateDoc } = ctx.fs();
        const now = new Date().toISOString();
        await updateDoc(doc(ctx.db(), 'groups', groupId, 'tasks', task.id), {
            status: decision,
            reviewNote: note ? clip(note, NOTE_MAX) : null,
            reviewedAt: now,
            statusUpdatedAt: now,
            updatedAt: now
        });
        const group = ctx.getGroup();
        const me = myName();
        notify({
            toUid: task.ownerId,
            type: 'review',
            title: decision === 'approved' ? `${me} approved your task` : `${me} sent a task back to you`,
            body: clip(task.text, 120) + (note ? ' - ' + clip(note, NOTE_MAX) : ''),
            groupId,
            groupName: group?.name,
            taskId: task.id,
            actorName: me
        });
    }

    // The assigner asked to approve this task and hasn't yet: it can't just be ticked off.
    const needsSignOff = (task) => task.needsApproval === true && task.status !== 'approved' && !task.completed;

    // Asks the owner to confirm, then sends the task to whoever assigned it.
    function requestReview(groupId, task) {
        const who = ctx.nameFor(task.assignedBy, task.assignedByName) || 'the person who assigned it';
        if (task.status === 'review') {
            alert(`This is already waiting for ${who} to approve it.`);
            return Promise.resolve();
        }
        if (!confirm(`${who} needs to approve "${task.text}" before it counts as done. Send it for review now?`)) {
            return Promise.resolve();
        }
        return setStatus(groupId, task, 'review').catch((error) => fail(error, 'Could not send it for review.'));
    }

    // ---- dependencies -----------------------------------------------------------

    const MAX_DEPENDENCIES = 5;
    const tasksNow = () => (ctx && typeof ctx.getTasks === 'function' ? ctx.getTasks() : []);

    // Never trust the stored list: only short strings, at most 5.
    function dependencyIds(task) {
        return (Array.isArray(task && task.dependsOn) ? task.dependsOn : [])
            .filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 100)
            .slice(0, MAX_DEPENDENCIES);
    }

    // The tasks this one is still waiting for. A task that was deleted or finished no longer counts.
    function unmetDependencies(task) {
        const all = tasksNow();
        return dependencyIds(task).map((id) => all.find((candidate) => candidate.id === id)).filter((dep) => dep && !dep.completed);
    }

    // Would making `taskId` wait for `candidateId` create a loop (A waits for B waits for A)?
    function wouldCycle(taskId, candidateId) {
        const all = tasksNow();
        const seen = new Set();
        const stack = [candidateId];
        while (stack.length > 0) {
            const id = stack.pop();
            if (id === taskId) {
                return true;
            }
            if (seen.has(id)) {
                continue;
            }
            seen.add(id);
            const found = all.find((candidate) => candidate.id === id);
            if (found) {
                dependencyIds(found).forEach((dep) => stack.push(dep));
            }
        }
        return false;
    }

    // Open tasks that `task` may be made to wait for.
    function dependencyCandidates(task) {
        return tasksNow().filter((candidate) => !candidate.completed && candidate.id !== task.id && !wouldCycle(task.id, candidate.id));
    }

    async function setDependencies(groupId, task, ids) {
        const { doc, updateDoc } = ctx.fs();
        const cleaned = Array.from(new Set((ids || []).filter((id) => typeof id === 'string' && id && id !== task.id))).slice(0, MAX_DEPENDENCIES);
        await updateDoc(doc(ctx.db(), 'groups', groupId, 'tasks', task.id), { dependsOn: cleaned, updatedAt: new Date().toISOString() });
    }

    // Called right after YOU finish a task: whoever was waiting for it (and for nothing else) is told.
    function notifyDependents(groupId, finished) {
        const me = ctx.getUser();
        const group = ctx.getGroup();
        const all = tasksNow();
        all.forEach((waiter) => {
            if (waiter.completed || !waiter.ownerId || waiter.ownerId === me.uid || !dependencyIds(waiter).includes(finished.id)) {
                return;
            }
            const stillWaiting = dependencyIds(waiter).some((id) => id !== finished.id && all.some((candidate) => candidate.id === id && !candidate.completed));
            if (stillWaiting) {
                return;
            }
            notify({
                toUid: waiter.ownerId,
                type: 'status',
                title: `${myName()} finished a task you were waiting on`,
                body: clip(waiter.text, 120),
                groupId,
                groupName: group?.name,
                taskId: waiter.id,
                actorName: myName()
            });
        });
    }

    function describeWaiting(task) {
        const unmet = unmetDependencies(task);
        if (unmet.length === 0) {
            return '';
        }
        const label = (dep) => `${clip(dep.text, 40)}${dep.ownerId && dep.ownerId !== ctx.getUser()?.uid ? ` (${ctx.nameFor(dep.ownerId, dep.ownerName) || 'a teammate'})` : ''}`;
        return `Waiting for ${label(unmet[0])}${unmet.length > 1 ? ` and ${unmet.length - 1} more` : ''}`;
    }

    function openDependencyPicker(groupId, task) {
        const selected = new Set(dependencyIds(task));
        const me = ctx.getUser()?.uid;
        const candidates = dependencyCandidates(task)
            .sort((a, b) => Number(b.ownerId === me) - Number(a.ownerId === me) || String(a.text).localeCompare(String(b.text)));

        const overlay = document.createElement('div');
        overlay.className = 'folderManagerOverlay askTextOverlay';
        const card = document.createElement('div');
        card.className = 'folderManagerCard askTextCard';
        card.setAttribute('role', 'dialog');
        card.setAttribute('aria-modal', 'true');
        card.setAttribute('aria-label', 'What does this task wait for?');
        const heading = document.createElement('h2');
        heading.textContent = 'What does this wait for?';
        const help = document.createElement('p');
        help.className = 'rolesHelp';
        help.textContent = `Pick up to ${MAX_DEPENDENCIES} tasks that need to be finished first. The card shows what it is waiting for, and you are told when they are done. Nothing is locked.`;
        const search = document.createElement('input');
        search.type = 'search';
        search.className = 'folderPickerSearch';
        search.placeholder = 'Find a task';
        search.maxLength = 60;
        search.setAttribute('aria-label', 'Find a task');
        const list = document.createElement('div');
        list.className = 'dependencyList';
        const error = document.createElement('p');
        error.className = 'folderManagerError';
        error.setAttribute('role', 'alert');
        const actions = document.createElement('div');
        actions.className = 'askTextActions';
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'whatsNewSecondaryBtn';
        cancel.textContent = 'Cancel';
        const save = document.createElement('button');
        save.type = 'button';
        save.className = 'whatsNewDoneBtn';
        save.textContent = 'Save';
        actions.append(cancel, save);
        card.append(heading, help, search, list, error, actions);
        overlay.appendChild(card);
        document.body.appendChild(overlay);

        const draw = () => {
            list.textContent = '';
            const needle = search.value.trim().toLowerCase();
            const shown = candidates.filter((candidate) => !needle || String(candidate.text).toLowerCase().includes(needle));
            if (shown.length === 0) {
                const empty = document.createElement('p');
                empty.className = 'folderPickerEmpty';
                empty.textContent = candidates.length === 0 ? 'There are no other open tasks to wait for.' : 'No task matches that.';
                list.appendChild(empty);
            }
            shown.forEach((candidate) => {
                const row = document.createElement('label');
                row.className = 'dependencyRow';
                const box = document.createElement('input');
                box.type = 'checkbox';
                box.checked = selected.has(candidate.id);
                box.addEventListener('change', () => {
                    if (box.checked && selected.size >= MAX_DEPENDENCIES) {
                        box.checked = false;
                        error.textContent = `A task can wait for at most ${MAX_DEPENDENCIES} others.`;
                        return;
                    }
                    error.textContent = '';
                    if (box.checked) {
                        selected.add(candidate.id);
                    } else {
                        selected.delete(candidate.id);
                    }
                });
                const text = document.createElement('span');
                text.className = 'dependencyText';
                text.textContent = clip(candidate.text, 90);
                const who = document.createElement('span');
                who.className = 'dependencyWho';
                who.textContent = candidate.ownerId === me ? 'yours' : (ctx.nameFor(candidate.ownerId, candidate.ownerName) || 'teammate');
                row.append(box, text, who);
                list.appendChild(row);
            });
        };
        draw();
        search.addEventListener('input', draw);

        const close = () => overlay.remove();
        cancel.addEventListener('click', close);
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) {
                close();
            }
        });
        overlay.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                close();
            }
        });
        save.addEventListener('click', async () => {
            save.disabled = true;
            try {
                await setDependencies(groupId, task, Array.from(selected));
                close();
            } catch (err) {
                save.disabled = false;
                console.error('Could not save what the task waits for:', err);
                error.textContent = 'Could not save that. Check your connection and try again.';
            }
        });
        search.focus();
    }

    // ---- the row on a task card ---------------------------------------------

    function button(label, icon, className, onClick) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'statusBtn ' + (className || '');
        if (icon) {
            const i = document.createElement('i');
            i.className = 'fa-solid ' + icon;
            i.setAttribute('aria-hidden', 'true');
            btn.appendChild(i);
        }
        btn.appendChild(document.createTextNode(' ' + label));
        btn.addEventListener('click', (event) => {
            event.stopPropagation();
            ctx.playClick?.();
            onClick(btn);
        });
        return btn;
    }

    function fail(error, fallback) {
        console.error(fallback, error);
        alert(typeof describeGroupWriteError === 'function' ? describeGroupWriteError(error, fallback) : fallback);
    }

    // Returns the status row for a task, or null when there is nothing to show or do.
    function createStatusRow(groupId, task, isOwner) {
        if (task.completed || !ctx) {
            return null;
        }
        const me = ctx.getUser()?.uid;
        const status = STATUS_INFO[task.status] ? task.status : '';
        const assignedByOther = Boolean(task.assignedBy) && task.assignedBy !== task.ownerId;
        const isReviewer = assignedByOther && task.assignedBy === me && !isOwner;

        const row = document.createElement('div');
        row.className = 'taskStatusRow';
        let hasContent = false;

        if (!status && task.needsApproval && assignedByOther) {
            const needs = document.createElement('span');
            needs.className = 'statusChip status-needs';
            needs.textContent = `Needs ${ctx.nameFor(task.assignedBy, task.assignedByName) || 'their'} approval`;
            needs.title = 'Checking this off sends it for review. It counts as done once it is approved.';
            row.appendChild(needs);
            hasContent = true;
        }
        if (status) {
            const info = STATUS_INFO[status];
            const chip = document.createElement('span');
            chip.className = 'statusChip status-' + status;
            const icon = document.createElement('i');
            icon.className = 'fa-solid ' + info.icon;
            icon.setAttribute('aria-hidden', 'true');
            chip.append(icon, document.createTextNode(' ' + info.label));
            row.appendChild(chip);
            hasContent = true;
            if (status === 'blocked' && task.blockedReason) {
                const reason = document.createElement('span');
                reason.className = 'statusReason';
                reason.textContent = task.blockedReason;
                row.appendChild(reason);
            }
            if (status === 'review' && !isReviewer) {
                const waiting = document.createElement('span');
                waiting.className = 'statusReason';
                waiting.textContent = `Waiting for ${ctx.nameFor(task.assignedBy, task.assignedByName) || 'the person who assigned it'}`;
                row.appendChild(waiting);
            }
            if (status === 'approved') {
                const approved = document.createElement('span');
                approved.className = 'statusReason';
                approved.textContent = task.reviewNote ? task.reviewNote : 'Signed off. It will be checked off for you.';
                row.appendChild(approved);
            }
            if (status === 'inprogress' && task.reviewNote && task.reviewedAt) {
                const back = document.createElement('span');
                back.className = 'statusReason';
                back.textContent = `Sent back: ${task.reviewNote}`;
                row.appendChild(back);
            }
        }

        const waitingText = describeWaiting(task);
        if (waitingText) {
            const waiting = document.createElement('span');
            waiting.className = 'statusChip status-waiting';
            waiting.textContent = waitingText;
            waiting.title = unmetDependencies(task).map((dep) => clip(dep.text, 80)).join('\n');
            row.appendChild(waiting);
            hasContent = true;
        }

        if (isOwner && status !== 'approved') {
            const controls = document.createElement('span');
            controls.className = 'statusControls';
            controls.appendChild(button(dependencyIds(task).length > 0 ? 'Change what it waits for' : 'Waits for...', 'fa-link', '', () => openDependencyPicker(groupId, task)));
            const set = (next, options) => setStatus(groupId, task, next, options).catch((error) => fail(error, 'Could not update the status.'));
            if (status === '') {
                controls.appendChild(button('Start', 'fa-play', '', () => set('inprogress')));
            }
            if (status !== 'blocked') {
                controls.appendChild(button('Blocked', 'fa-hand', 'isBlockedBtn', async () => {
                    const reason = await askForText({
                        title: 'What is blocking you?',
                        message: 'This tells the person who assigned the task, and the group\'s owner and admins.',
                        placeholder: 'Waiting on the client\'s logo files',
                        confirmLabel: 'Mark as blocked',
                        maxLength: REASON_MAX,
                        required: true
                    });
                    if (reason) {
                        set('blocked', { reason });
                    }
                }));
            } else {
                controls.appendChild(button('Unblocked', 'fa-play', '', () => set('inprogress')));
            }
            // Only on tasks the assigner asked to approve: everything else is simply done when it's done.
            if (assignedByOther && task.needsApproval && (status === '' || status === 'inprogress')) {
                controls.appendChild(button('Ready for review', 'fa-clipboard-check', 'isReviewBtn', () => requestReview(groupId, task)));
            }
            if (status === 'review') {
                controls.appendChild(button('Take back', 'fa-rotate-left', '', () => set('inprogress')));
            }
            if (status === 'inprogress') {
                controls.appendChild(button('Not started', 'fa-rotate-left', '', () => set(null)));
            }
            row.appendChild(controls);
            hasContent = true;
        }

        if (isReviewer && status === 'review') {
            row.appendChild(reviewerControls(groupId, task));
            hasContent = true;
        }
        return hasContent ? row : null;
    }

    function reviewerControls(groupId, task) {
        const controls = document.createElement('span');
        controls.className = 'statusControls reviewerControls';
        controls.appendChild(button('Approve', 'fa-check', 'isApproveBtn', () => {
            reviewTask(groupId, task, 'approved', '').catch((error) => fail(error, 'Could not approve it.'));
        }));
        controls.appendChild(button('Send back', 'fa-rotate-left', 'isBackBtn', async () => {
            const note = await askForText({
                title: 'Send it back',
                message: 'Say what still needs doing. They will be notified.',
                placeholder: 'The totals on page 2 don\'t match yet',
                confirmLabel: 'Send back',
                maxLength: NOTE_MAX
            });
            if (note !== null) {
                reviewTask(groupId, task, 'inprogress', note).catch((error) => fail(error, 'Could not send it back.'));
            }
        }));
        return controls;
    }

    // For a shared task's card: one line per person whose copy awaits MY sign-off.
    function createReviewRows(groupId, copies) {
        const me = ctx?.getUser()?.uid;
        const rows = [];
        copies.forEach((copy) => {
            if (copy.completed || copy.status !== 'review' || !copy.assignedBy || copy.assignedBy !== me || copy.ownerId === me) {
                return;
            }
            const row = document.createElement('div');
            row.className = 'taskStatusRow sharedReviewRow';
            const chip = document.createElement('span');
            chip.className = 'statusChip status-review';
            chip.textContent = `${ctx.nameFor(copy.ownerId, copy.ownerName) || 'Teammate'} is waiting for your review`;
            row.append(chip, reviewerControls(groupId, copy));
            rows.push(row);
        });
        return rows;
    }

    // ---- mentions -------------------------------------------------------------

    const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Where in `text` someone is @mentioned. members: [{ uid, name }]. A full name always
    // matches; a first name also matches when nobody else in the group shares it.
    function mentionRanges(text, members) {
        const value = String(text || '');
        const firstNameCount = new Map();
        members.forEach((member) => {
            const first = (member.name || '').split(/\s+/)[0].toLowerCase();
            firstNameCount.set(first, (firstNameCount.get(first) || 0) + 1);
        });
        const candidates = [];
        members.forEach((member) => {
            const name = (member.name || '').trim();
            if (!name) {
                return;
            }
            candidates.push({ uid: member.uid, label: name });
            const first = name.split(/\s+/)[0];
            if (first.toLowerCase() !== name.toLowerCase() && firstNameCount.get(first.toLowerCase()) === 1) {
                candidates.push({ uid: member.uid, label: first });
            }
        });
        candidates.sort((a, b) => b.label.length - a.label.length);
        const taken = [];
        const found = [];
        candidates.forEach((candidate) => {
            const pattern = new RegExp(`(^|[^\\w@])@${escapeRegex(candidate.label)}(?![\\w])`, 'gi');
            let match;
            while ((match = pattern.exec(value)) !== null) {
                const start = match.index + match[1].length;
                const end = start + candidate.label.length + 1;
                if (!taken.some(([s, e]) => start < e && end > s)) {
                    taken.push([start, end]);
                    found.push({ start, end, uid: candidate.uid });
                }
            }
        });
        return found.sort((a, b) => a.start - b.start);
    }

    function mentionedUids(text, members) {
        return Array.from(new Set(mentionRanges(text, members).map((range) => range.uid)));
    }

    // Writes `text` into `node`, with each mention in its own highlighted span.
    function renderWithMentions(node, text, members) {
        node.textContent = '';
        const value = String(text || '');
        let cursor = 0;
        mentionRanges(value, members).forEach((range) => {
            if (range.start > cursor) {
                node.appendChild(document.createTextNode(value.slice(cursor, range.start)));
            }
            const span = document.createElement('span');
            span.className = 'mention';
            span.textContent = value.slice(range.start, range.end);
            node.appendChild(span);
            cursor = range.end;
        });
        if (cursor < value.length) {
            node.appendChild(document.createTextNode(value.slice(cursor)));
        }
    }

    // Typing "@" in `input` offers the group's people; Enter/Tab/click inserts the full name.
    function attachMentionPicker(input, getMembers) {
        let menu = null;
        let options = [];
        let active = 0;

        const close = () => {
            menu?.remove();
            menu = null;
            options = [];
        };
        const currentQuery = () => {
            const upto = input.value.slice(0, input.selectionStart ?? input.value.length);
            const match = /(?:^|\s)@([^\s@]*)$/.exec(upto);
            return match ? { text: match[1], start: upto.length - match[1].length - 1 } : null;
        };
        const choose = (member) => {
            const query = currentQuery();
            if (!query) {
                return;
            }
            const caret = input.selectionStart ?? input.value.length;
            input.value = input.value.slice(0, query.start) + '@' + member.name + ' ' + input.value.slice(caret);
            const pos = query.start + member.name.length + 2;
            input.setSelectionRange(pos, pos);
            close();
            input.focus();
        };
        const draw = () => {
            menu.textContent = '';
            options.forEach((member, index) => {
                const item = document.createElement('button');
                item.type = 'button';
                item.className = 'mentionOption' + (index === active ? ' active' : '');
                item.textContent = member.name;
                item.addEventListener('mousedown', (event) => {
                    event.preventDefault();
                    choose(member);
                });
                menu.appendChild(item);
            });
        };
        const update = () => {
            const query = currentQuery();
            if (!query) {
                close();
                return;
            }
            const needle = query.text.toLowerCase();
            options = getMembers()
                .filter((member) => member.name && (member.name.toLowerCase().startsWith(needle) || member.name.split(/\s+/).some((part) => part.toLowerCase().startsWith(needle))))
                .slice(0, 6);
            if (options.length === 0) {
                close();
                return;
            }
            active = Math.min(active, options.length - 1);
            if (!menu) {
                menu = document.createElement('div');
                menu.className = 'mentionMenu';
                menu.setAttribute('role', 'listbox');
                input.parentElement.appendChild(menu);
            }
            draw();
        };

        input.addEventListener('input', () => {
            active = 0;
            update();
        });
        input.addEventListener('blur', () => setTimeout(close, 120));
        // Capture phase: the comment box also submits on Enter, and while the menu is open
        // Enter must pick a person instead of posting.
        input.addEventListener('keydown', (event) => {
            if (!menu || options.length === 0) {
                return;
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                active = (active + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length;
                draw();
            } else if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault();
                event.stopImmediatePropagation();
                choose(options[active]);
            } else if (event.key === 'Escape') {
                event.stopPropagation();
                close();
            }
        }, true);
    }

    // ---- keeping the copies you assigned in step with yours ------------------------
    // Assigning makes one copy per person. After that, changes to your own copy (a new deadline,
    // steps you added later) don't reach theirs on their own, so this lists the copies you assigned
    // and pushes what differs.

    const SYNC_FIELDS = ['text', 'matrix', 'taskType', 'estimateMinutes', 'difficulty', 'dueAt', 'scheduledAt'];

    // Their open copies of a task you own and assigned to others.
    function copiesIAssigned(task) {
        const me = ctx.getUser();
        if (!me || !task || !task.sharedId || task.ownerId !== me.uid || task.sharedBy !== me.uid) {
            return [];
        }
        return (ctx.getTasks() || []).filter((other) => other.id !== task.id && other.sharedId === task.sharedId
            && other.assignedBy === me.uid && other.ownerId !== me.uid && !other.completed);
    }

    // My steps, kept in order. A step they already have (same words) keeps its tick; new ones
    // are added unticked; anything they added themselves is kept, never deleted.
    function mergeSteps(mine, theirs, makeId, now = new Date().toISOString()) {
        const theirList = Array.isArray(theirs) ? theirs : [];
        const used = new Set();
        const out = (Array.isArray(mine) ? mine : []).map((step) => {
            const index = theirList.findIndex((candidate, i) => !used.has(i) && candidate && candidate.text === step.text);
            if (index >= 0) {
                used.add(index);
                return { ...theirList[index], dueAt: step.dueAt || null };
            }
            return { id: makeId(), text: String(step.text || '').slice(0, 240), completed: false, createdAt: now, dueAt: step.dueAt || null };
        });
        theirList.forEach((step, i) => {
            if (!used.has(i)) {
                out.push(step);
            }
        });
        return out.slice(0, 200);
    }

    const sameTime = (a, b) => (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null);

    // What would change on `theirs` to match `mine`: { fields, changes: [words] } or null.
    function copyPatch(mine, theirs, makeId) {
        const fields = {};
        const changes = [];
        SYNC_FIELDS.forEach((key) => {
            const a = mine[key] == null ? null : mine[key];
            const b = theirs[key] == null ? null : theirs[key];
            const different = key === 'dueAt' || key === 'scheduledAt' ? !sameTime(a, b) : a !== b;
            if (different) {
                fields[key] = a;
                changes.push(key === 'dueAt' ? 'the deadline' : key === 'scheduledAt' ? 'the scheduled time' : key === 'text' ? 'the title' : 'the details');
            }
        });
        const merged = mergeSteps(mine.subtasks, theirs.subtasks, makeId);
        const strip = (list) => JSON.stringify((list || []).map((s) => [s.id, s.text, s.completed, s.dueAt || null]));
        const mineSteps = (mine.subtasks || []).length;
        if (mineSteps > 0 && strip(merged) !== strip(theirs.subtasks)) {
            fields.subtasks = merged;
            changes.push('the steps');
        }
        return Object.keys(fields).length > 0 ? { fields, changes } : null;
    }

    // How many of your assigned copies differ from yours (to decide whether to offer the button).
    function copiesOutOfStep(task, makeId) {
        return copiesIAssigned(task).filter((copy) => copyPatch(task, copy, makeId));
    }

    async function pushToCopies(groupId, task, makeId) {
        const { doc, writeBatch } = ctx.fs();
        const group = ctx.getGroup();
        const me = myName();
        const plans = copiesIAssigned(task).map((copy) => ({ copy, patch: copyPatch(task, copy, makeId) })).filter((plan) => plan.patch);
        if (plans.length === 0) {
            return 0;
        }
        const batch = writeBatch(ctx.db());
        const now = new Date().toISOString();
        plans.forEach(({ copy, patch }) => {
            batch.update(doc(ctx.db(), 'groups', groupId, 'tasks', copy.id), { ...patch.fields, updatedAt: now });
        });
        await batch.commit();
        plans.forEach(({ copy, patch }) => {
            notify({
                toUid: copy.ownerId,
                type: 'status',
                title: `${me} updated a task for you`,
                body: clip(task.text, 120) + ' - changed ' + patch.changes.join(', '),
                groupId,
                groupName: group?.name,
                taskId: copy.id,
                actorName: me
            });
        });
        return plans.length;
    }

    // Tell the owner you changed their task (used when you edit a task you assigned them).
    function tellOwnerOfEdit(groupId, task, changes) {
        const group = ctx.getGroup();
        const me = myName();
        notify({
            toUid: task.ownerId,
            type: 'status',
            title: `${me} updated a task for you`,
            body: clip(task.text, 120) + (changes.length ? ' - changed ' + changes.join(', ') : ''),
            groupId,
            groupName: group?.name,
            taskId: task.id,
            actorName: me
        });
    }

    // The group's people as [{ uid, name }], for mentions.
    function memberList(group) {
        return (group?.memberIds || []).map((uid, index) => ({
            uid,
            name: clip(ctx?.nameFor(uid, (group.memberNames || [])[index]) || (group.memberNames || [])[index] || '', 80)
        })).filter((member) => member.name);
    }

    return {
        STATUS_INFO, configure, askForText, setStatus, reviewTask, requestReview, needsSignOff, createStatusRow, createReviewRows,
        dependencyIds, unmetDependencies, dependencyCandidates, wouldCycle, setDependencies, notifyDependents, openDependencyPicker,
        mentionRanges, mentionedUids, renderWithMentions, attachMentionPicker, memberList, managersFor,
        copiesIAssigned, copiesOutOfStep, copyPatch, mergeSteps, pushToCopies, tellOwnerOfEdit
    };
})();

window.GroupWorkflow = GroupWorkflow;
