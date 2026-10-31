// Assigning tasks to people (organization-plan.md sections 5.4 and 5.5).
//
// The model, in one paragraph: a shared task is NOT one document with a
// participants list. It is one ordinary task per person (so every existing
// rule still holds: you edit, complete and delete only your own copy), tied
// together by a shared id. "Everyone" collapses copies with the same sharedId
// into one card. An owner/admin assigning to others creates those copies
// directly (the recipient gets an "Assigned by" badge and can Decline); anyone
// else can only SUGGEST, which the recipient still has to accept.
//
// Classic script, loaded before group.js; uses its globals (db, fs,
// buildGroupTaskData, suggestTaskForMember, ...) lazily, at call time.

const GroupAssign = (() => {
    // A batched write may only make ~20 document lookups in its security rules
    // in total, and each assigned task costs 2 (the membership check plus
    // canCreateAssigned). 8 per chunk = 16, under the cap even if repeated
    // lookups of the same document are not de-duplicated.
    const FAN_OUT_CHUNK = 8;

    // How long Decline stays available after a task is assigned. Short on
    // purpose: the task should feel settled quickly. After this the person
    // can still delete it, and the assigner is told either way.
    const DECLINE_WINDOW_MS = 15 * 60 * 1000;

    function isWithinDeclineWindow(task) {
        const assignedAt = task && task.assignedAt ? new Date(task.assignedAt).getTime() : NaN;
        return Number.isFinite(assignedAt) && (Date.now() - assignedAt) <= DECLINE_WINDOW_MS;
    }

    const newSharedId = () => makeShortId('sh_', 8, 12);

    function nameAt(group, index) {
        const name = (group.memberNames || [])[index];
        return typeof name === 'string' && name ? name.slice(0, 80) : 'Teammate';
    }

    // Options for the "Assign to" / "Suggest to" dropdown. scope 'role' (a
    // member the owner/admin limited to their own role) only offers people
    // who share YOUR role, and that role as a whole - never Everyone.
    function getChoiceOptions(group, myUid, scope = 'all') {
        const memberIds = group.memberIds || [];
        const options = [{ value: '', label: 'Just me' }];
        const myRole = GroupRoles.getRole(group, myUid);
        if (scope === 'role') {
            if (!myRole) {
                return options;
            }
            memberIds.forEach((uid, index) => {
                if (uid !== myUid && GroupRoles.getRole(group, uid)?.id === myRole.id) {
                    options.push({ value: `u:${uid}`, label: nameAt(group, index) });
                }
            });
            const count = memberIds.filter((uid) => GroupRoles.getRole(group, uid)?.id === myRole.id).length;
            if (count > 1) {
                options.push({ value: `r:${myRole.id}`, label: `Role: ${myRole.name} (${count})` });
            }
            return options;
        }
        memberIds.forEach((uid, index) => {
            if (uid !== myUid) {
                options.push({ value: `u:${uid}`, label: nameAt(group, index) });
            }
        });
        if (memberIds.length > 1) {
            options.push({ value: 'everyone', label: `Everyone (${memberIds.length})` });
        }
        GroupRoles.getAll(group).forEach((role) => {
            const count = memberIds.filter((uid) => GroupRoles.getRole(group, uid)?.id === role.id).length;
            if (count > 0) {
                options.push({ value: `r:${role.id}`, label: `Role: ${role.name} (${count})` });
            }
        });
        return options;
    }

    // [{ uid, name }] for a dropdown choice. Roles and Everyone include you if
    // you qualify - your own copy is created like any normal task.
    function resolveTargets(group, choice, myUid, scope = 'all') {
        const memberIds = group.memberIds || [];
        const all = memberIds.map((uid, index) => ({ uid, name: nameAt(group, index) }));
        // "me": your own copy. Always allowed (it is your own task), whatever your
        // assign scope - this is what lets "me and Philip" be ONE shared assignment.
        if (choice === 'me') {
            return all.filter((target) => target.uid === myUid);
        }
        if (scope === 'role') {
            // Defense in depth (the rules enforce this too): same-role only.
            const myRole = GroupRoles.getRole(group, myUid);
            if (!myRole || choice === 'everyone') {
                return [];
            }
            return resolveTargets(group, choice, myUid, 'all')
                .filter((target) => GroupRoles.getRole(group, target.uid)?.id === myRole.id);
        }
        if (choice === 'everyone') {
            return all;
        }
        if (typeof choice === 'string' && choice.startsWith('u:')) {
            const uid = choice.slice(2);
            return all.filter((target) => target.uid === uid && uid !== myUid);
        }
        if (typeof choice === 'string' && choice.startsWith('r:')) {
            const roleId = choice.slice(2);
            return all.filter((target) => GroupRoles.getRole(group, target.uid)?.id === roleId);
        }
        return [];
    }

    // Several choices at once ("me" + "Philip" + a role), as one de-duplicated list of
    // people in the order they were named. Each choice is judged on its own by
    // resolveTargets, so a role-limited assigner can't smuggle someone in via a list.
    function resolveTargetList(group, choices, myUid, scope = 'all') {
        const seen = new Set();
        const people = [];
        (Array.isArray(choices) ? choices : [choices]).forEach((choice) => {
            resolveTargets(group, choice, myUid, scope).forEach((person) => {
                if (!seen.has(person.uid)) {
                    seen.add(person.uid);
                    people.push(person);
                }
            });
        });
        return people;
    }

    async function commitChunk(batchWriter, chunk) {
        const batch = batchWriter();
        chunk.forEach(({ ref, data }) => batch.set(ref, data));
        await batch.commit();
    }

    // Entries from `chunk` whose task doc does NOT exist yet (see the retry note in assign()).
    async function filterMissing(chunk) {
        const { getDoc } = fs();
        const snapshots = await Promise.all(chunk.map((entry) => getDoc(entry.ref).catch(() => null)));
        return chunk.filter((_, index) => !(snapshots[index] && snapshots[index].exists()));
    }

    // Returns { mode, created, total, failedNames }. Never throws for a
    // partial result: the caller decides how to tell the user.
    async function assign({ group, user, canAssign, assignScope = 'all', choice, fields }) {
        const effectiveScope = canAssign ? assignScope : 'all';
        const targets = Array.isArray(choice)
            ? resolveTargetList(group, choice, user.uid, effectiveScope)
            : resolveTargets(group, choice, user.uid, effectiveScope);
        if (targets.length === 0) {
            return { mode: 'none', created: 0, total: 0, failedNames: [] };
        }
        const text = (fields.text || '').trim();
        if (!text) {
            return { mode: 'none', created: 0, total: 0, failedNames: [] };
        }
        const others = targets.filter((target) => target.uid !== user.uid);
        const includesSelf = others.length !== targets.length;

        // A plain member can only suggest: each person still accepts.
        if (!canAssign) {
            const results = await Promise.allSettled(others.map((target) => suggestTaskForMember(group.id, user, target.uid, fields)));
            let created = results.filter((result) => result.status === 'fulfilled').length;
            const failedNames = others.filter((_, index) => results[index].status === 'rejected').map((target) => target.name);
            if (includesSelf) {
                try {
                    await addGroupTask(group.id, user, fields);
                    created += 1;
                } catch (error) {
                    console.error('Failed to add your own copy:', error);
                    failedNames.push('you');
                }
            }
            return { mode: 'suggested', created, total: targets.length, failedNames };
        }

        const { doc, setDoc, writeBatch, serverTimestamp } = fs();
        const sharedId = newSharedId();

        const entries = targets.map((target) => {
            const extra = { ownerId: target.uid, ownerName: target.name, sharedId, sharedBy: user.uid };
            if (target.uid !== user.uid) {
                // assignedAt is the SERVER's clock (the rules require exactly that), because
                // the 15-minute decline window runs from it.
                Object.assign(extra, { assignedBy: user.uid, assignedByName: displayNameFor(user), assignedAt: serverTimestamp() });
            }
            return {
                target,
                // Deterministic id: re-sending a chunk can never create a
                // second copy for the same person.
                ref: doc(db(), 'groups', group.id, 'tasks', `${sharedId}_${target.uid}`),
                data: buildGroupTaskData(user, fields, extra)
            };
        });

        let created = 0;
        const failedNames = [];
        const createdTargets = [];
        for (let i = 0; i < entries.length; i += FAN_OUT_CHUNK) {
            const chunk = entries.slice(i, i + FAN_OUT_CHUNK);
            let remaining = chunk;
            let done = false;
            for (let attempt = 0; attempt < 2 && !done; attempt += 1) {
                try {
                    await commitChunk(() => writeBatch(db()), remaining);
                    done = true;
                } catch (error) {
                    console.error('Failed to assign a batch of tasks:', error);
                    if (attempt === 0) {
                        // An error doesn't prove nothing was written (a dropped
                        // acknowledgement looks the same). Re-sending onto a
                        // copy that landed would be an UPDATE of someone else's
                        // task, which the rules rightly deny, so look first and
                        // only resend what's genuinely missing.
                        remaining = await filterMissing(remaining);
                        done = remaining.length === 0;
                    }
                }
            }
            const landed = done ? chunk : chunk.filter((entry) => !remaining.includes(entry));
            landed.forEach((entry) => createdTargets.push(entry.target));
            created += landed.length;
            if (!done) {
                remaining.forEach((entry) => failedNames.push(entry.target.name));
            }
        }

        // The record is written AFTER the copies and lists only the people who
        // actually got one, so it can never name someone who never received the
        // task. If this write fails the tasks still exist and work normally; the
        // only loss is the assigner's "declined" notification for this one.
        if (created > 0) {
            try {
                await setDoc(doc(db(), 'groups', group.id, 'assignments', sharedId), {
                    createdBy: user.uid,
                    createdByName: displayNameFor(user),
                    text: text.slice(0, 2000),
                    participantIds: createdTargets.map((target) => target.uid),
                    participantNames: createdTargets.map((target) => target.name),
                    createdAt: serverTimestamp(),
                    declined: {}
                });
            } catch (error) {
                console.warn('Tasks were assigned, but the assignment record could not be saved:', error);
            }
        }
        return { mode: 'assigned', created, total: targets.length, failedNames, sharedId };
    }

    // Declining removes your copy and tells the assigner. The bundle update is
    // best-effort and goes first (it needs your task's sharedId only); losing
    // the notification must never stop you from declining.
    async function decline(groupId, task, user) {
        const { doc, updateDoc, serverTimestamp } = fs();
        if (task.sharedId) {
            try {
                await updateDoc(doc(db(), 'groups', groupId, 'assignments', task.sharedId), {
                    [`declined.${user.uid}`]: serverTimestamp()
                });
            } catch (error) {
                console.warn('Could not record the decline for the assigner:', error);
            }
        }
        await deleteGroupTask(groupId, task.id);
    }

    function subscribe(groupId, callback, onError) {
        const { collection, query, orderBy, limit, onSnapshot } = fs();
        const assignmentsQuery = query(
            collection(db(), 'groups', groupId, 'assignments'),
            orderBy('createdAt', 'desc'),
            limit(100)
        );
        return onSnapshot(assignmentsQuery, (snapshot) => {
            callback(snapshot.docs.map((assignmentDoc) => ({ id: assignmentDoc.id, ...assignmentDoc.data() })));
        }, onError);
    }

    // Declines the assigner hasn't dismissed yet. Dismissal is remembered on
    // this device only (no rules surface for it), keyed per group + account.
    function dismissKey(groupId, uid) {
        return `groupAssignDismissed:${uid}:${groupId}`;
    }

    function readDismissed(groupId, uid) {
        try {
            const parsed = JSON.parse(localStorage.getItem(dismissKey(groupId, uid)) || '[]');
            return new Set(Array.isArray(parsed) ? parsed : []);
        } catch {
            return new Set();
        }
    }

    function dismiss(groupId, uid, entryKey) {
        const dismissed = readDismissed(groupId, uid);
        dismissed.add(entryKey);
        try {
            localStorage.setItem(dismissKey(groupId, uid), JSON.stringify(Array.from(dismissed).slice(-300)));
        } catch {
            // Non-fatal: the notice just reappears next visit.
        }
    }

    // [{ key, text, name }] - one per person who declined something I assigned.
    function getUnseenDeclines(assignments, groupId, uid) {
        const dismissed = readDismissed(groupId, uid);
        const result = [];
        (assignments || []).forEach((assignment) => {
            if (assignment.createdBy !== uid || !assignment.declined || typeof assignment.declined !== 'object') {
                return;
            }
            Object.keys(assignment.declined).forEach((declinerUid) => {
                const key = `${assignment.id}:${declinerUid}`;
                if (dismissed.has(key)) {
                    return;
                }
                const index = (assignment.participantIds || []).indexOf(declinerUid);
                const name = index === -1 ? 'Someone' : ((assignment.participantNames || [])[index] || 'Someone');
                result.push({ key, text: assignment.text || '', name });
            });
        });
        return result;
    }

    return { getChoiceOptions, resolveTargets, resolveTargetList, assign, decline, subscribe, getUnseenDeclines, dismiss, isWithinDeclineWindow, DECLINE_WINDOW_MS };
})();
