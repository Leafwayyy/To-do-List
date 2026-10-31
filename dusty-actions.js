// What Dusty can DO for the user, limited to what that user is allowed to do.
//
// The model only ever PROPOSES. Each proposal becomes a review card; nothing runs
// until the user ticks it and confirms. Permissions are NOT decided by the model
// or the prompt - three independent layers enforce them:
//   1. capabilities() tells the model what this user may do, so it proposes only
//      those things (this just keeps the chat sensible),
//   2. describe() and commit() below re-check every action against LIVE data and
//      the user's real permissions (getMyAccess) at the moment of the click, and
//      resolve every name to a real person/role/folder themselves (the model
//      never supplies an id for a person, a role or a folder),
//   3. firestore.rules refuse anything the signed-in user isn't allowed to do,
//      no matter how it was asked.
//
// Actions: createFolder, fileTasks (solo + group); assign, createRole, setRole,
// grantAccess (group only). Roles and access are owner/admin only, exactly as in
// the rest of the app.
//
// Classic script, loaded on both pages BEFORE the page script (which hands this
// to the Brain Dump controller). Everything page-specific is read lazily, at call
// time, from that page's globals.

const DustyActions = (() => {
    const MAX_FOLDER_NAME = 30;

    const isGroupPage = () => typeof getSelectedGroup === 'function';
    const norm = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().toLowerCase();
    const clean = (value, max) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);

    function groupContext() {
        if (!isGroupPage() || typeof currentUser === 'undefined' || !currentUser) {
            return null;
        }
        const group = getSelectedGroup();
        return group ? { group, access: getMyAccess(group), uid: currentUser.uid } : null;
    }

    // ---- what the model is told this user may do --------------------------------
    function capabilities() {
        const folders = TodoFolders.getAll().map((folder) => folder.name);
        if (!isGroupPage()) {
            return { page: 'solo', folders, canManageFolders: true };
        }
        const ctx = groupContext();
        if (!ctx) {
            return null;
        }
        const { group, access } = ctx;
        return {
            page: 'group',
            role: access.isOwner ? 'owner' : (access.isAdmin ? 'admin' : 'member'),
            canAssign: access.canAssign,
            assignScope: access.assignScope,
            canManageFolders: access.canManageFolders,
            canManageRoles: access.isOwner || access.isAdmin,
            folders,
            roles: GroupRoles.getAll(group).map((role) => role.name),
            members: (group.memberIds || []).map((uid, index) => ({
                name: (group.memberNames || [])[index] || 'Teammate',
                role: GroupRoles.getRole(group, uid)?.name || null
            }))
        };
    }

    // ---- name resolution (the model never gives us an id for these) -------------
    function findFolder(name) {
        const wanted = norm(name);
        return wanted ? (TodoFolders.getAll().find((folder) => norm(folder.name) === wanted) || null) : null;
    }

    // { uid, index, name } | 'ambiguous' | null
    function findMember(group, name) {
        const wanted = norm(name);
        if (!wanted) {
            return null;
        }
        const matches = (group.memberIds || [])
            .map((uid, index) => ({ uid, index, name: (group.memberNames || [])[index] || '' }))
            .filter((member) => norm(member.name) === wanted);
        if (matches.length === 0) {
            return null;
        }
        return matches.length === 1 ? matches[0] : 'ambiguous';
    }

    function findRole(group, name) {
        const wanted = norm(name);
        return wanted ? (GroupRoles.getAll(group).find((role) => norm(role.name) === wanted) || null) : null;
    }

    // The tasks of mine that a fileTasks action may touch, by exact id.
    function myTasksByIds(ids) {
        const wanted = new Set((Array.isArray(ids) ? ids : []).map((id) => String(id)));
        if (!isGroupPage()) {
            return tasks.filter((task) => wanted.has(task.id));
        }
        const uid = currentUser && currentUser.uid;
        return groupTasks.filter((task) => wanted.has(task.id) && task.ownerId === uid);
    }

    const ME_WORDS = ['me', 'myself', 'self', 'i'];
    const isMeToken = (name) => ME_WORDS.includes(norm(name));

    // assignTo may be one name or a list. Always a clean array of names.
    function assignNames(draft) {
        const raw = draft && draft.assignTo;
        const list = Array.isArray(raw) ? raw : (raw == null || raw === '' ? [] : [raw]);
        return list.map((name) => clean(name, 60)).filter(Boolean).slice(0, 12);
    }

    // The choices for a whole list of names: { choices: ['me','u:..','r:..','everyone'], error }.
    // "me" (or the user's own name) is the user's own copy, not an error.
    function resolveAssignChoices(group, names) {
        const choices = [];
        for (const name of names) {
            if (isMeToken(name)) {
                choices.push('me');
                continue;
            }
            const asMember = findMember(group, name);
            if (asMember && asMember !== 'ambiguous' && asMember.uid === currentUser.uid) {
                choices.push('me');
                continue;
            }
            const choice = resolveAssignTarget(group, name);
            if (typeof choice === 'object') {
                return { choices: [], error: choice.error };
            }
            choices.push(choice);
        }
        return { choices: [...new Set(choices)], error: choices.length === 0 ? 'No one was named.' : null };
    }

    // 'everyone' | 'u:<uid>' | 'r:<roleId>' | { error }
    function resolveAssignTarget(group, name) {
        const wanted = norm(name);
        if (!wanted) {
            return { error: 'No one was named.' };
        }
        if (wanted === 'everyone' || wanted === 'everybody' || wanted === 'the whole group' || wanted === 'all') {
            return 'everyone';
        }
        const member = findMember(group, name);
        const role = findRole(group, name);
        if (member === 'ambiguous') {
            return { error: `More than one person is called "${clean(name, 40)}".` };
        }
        if (member && role) {
            return { error: `"${clean(name, 40)}" is both a person and a role, so it's unclear which you mean.` };
        }
        if (member) {
            return member.uid === currentUser.uid ? { error: 'That is you.' } : `u:${member.uid}`;
        }
        if (role) {
            return `r:${role.id}`;
        }
        return { error: `Nobody or no role called "${clean(name, 40)}" in this group.` };
    }

    const blocked = (reason) => ({ allowed: false, text: '', reason });

    // The actions in the reply currently on screen. A reply like "make a School folder and
    // put my essays in it" is two actions, and the second only makes sense because of the
    // first, so cards are judged with the whole batch in view (see describe).
    let pendingBatch = [];
    function prepare(actions) {
        pendingBatch = Array.isArray(actions) ? actions : [];
    }

    // Is a folder with this name going to exist by the time a fileTasks action runs,
    // because a (permitted) createFolder in the same batch makes it?
    function batchCreatesFolder(name, batch) {
        return (batch || []).some((other) => other && other.action === 'createFolder'
            && norm(other.folder) === norm(name) && norm(name) !== ''
            && (!isGroupPage() || (groupContext() && groupContext().access.canManageFolders)));
    }

    // ---- describe: what the card says, and whether it may run -------------------
    // Returns { allowed, text, reason }. Pure reading, no writes.
    function describe(draft, batch = pendingBatch) {
        const action = draft && draft.action;
        const group = isGroupPage();
        const ctx = group ? groupContext() : null;
        if (group && !ctx) {
            return blocked('Open a group first.');
        }

        if (action === 'createFolder') {
            const name = clean(draft.folder, MAX_FOLDER_NAME);
            if (!name) {
                return blocked('No folder name was given.');
            }
            if (group && !ctx.access.canManageFolders) {
                return blocked('You need folder rights in this group to create folders. Ask an owner or admin.');
            }
            if (findFolder(name)) {
                return blocked(`There is already a folder called "${name}".`);
            }
            if (TodoFolders.getAll().length >= TodoFolders.MAX_FOLDERS) {
                return blocked(`You can have up to ${TodoFolders.MAX_FOLDERS} folders.`);
            }
            return { allowed: true, text: `Create the folder "${name}"` };
        }

        if (action === 'fileTasks') {
            const name = clean(draft.folder, MAX_FOLDER_NAME);
            const folderExists = Boolean(findFolder(name));
            if (!name) {
                return blocked('No folder was named.');
            }
            if (!folderExists && !batchCreatesFolder(name, batch)) {
                return blocked(`There is no folder called "${name}" yet. Create it first.`);
            }
            const mine = myTasksByIds(draft.taskIds);
            if (mine.length === 0) {
                return blocked('None of those tasks are yours to file.');
            }
            const preview = mine.slice(0, 3).map((task) => `"${clean(task.text, 40)}"`).join(', ') + (mine.length > 3 ? ` and ${mine.length - 3} more` : '');
            const shownName = folderExists ? findFolder(name).name : name;
            return { allowed: true, text: `Put ${mine.length} of your task${mine.length === 1 ? '' : 's'} in "${shownName}": ${preview}` };
        }

        // Everything below is group-only.
        if (['assign', 'createRole', 'setRole', 'grantAccess'].includes(action) && !group) {
            return blocked('That only works inside a group.');
        }

        if (action === 'assign') {
            const text = clean(draft.text, AI_TASK_TITLE_MAX_LENGTH);
            if (!text) {
                return blocked('The task has no text.');
            }
            const { choices, error } = resolveAssignChoices(ctx.group, assignNames(draft));
            if (error) {
                return blocked(error);
            }
            const scope = ctx.access.canAssign ? ctx.access.assignScope : 'all';
            // Each named person/role/group must itself be reachable. A role-limited assigner
            // asking for "me and Kim" (Kim is in another role) is refused, not quietly trimmed.
            const unreachable = choices.find((choice) => GroupAssign.resolveTargets(ctx.group, choice, ctx.uid, scope).length === 0);
            if (unreachable) {
                return blocked(ctx.access.canAssign && scope === 'role'
                    ? 'You can only assign to people who share your role.'
                    : 'Nobody to send that to.');
            }
            const people = GroupAssign.resolveTargetList(ctx.group, choices, ctx.uid, scope);
            const others = people.filter((person) => person.uid !== ctx.uid);
            const includesMe = people.length !== others.length;
            // Name each choice the way the user said it, so the card shows exactly who is
            // included: "you", a person, "everyone", or "everyone with the role X".
            const parts = choices.map((choice) => {
                if (choice === 'me') {
                    return 'you';
                }
                if (choice === 'everyone') {
                    return `everyone (${people.length} people)`;
                }
                if (choice.startsWith('r:')) {
                    const role = GroupRoles.getAll(ctx.group).find((candidate) => candidate.id === choice.slice(2));
                    const count = GroupAssign.resolveTargets(ctx.group, choice, ctx.uid, scope).length;
                    return `everyone with the role "${role ? role.name : 'that role'}" (${count})`;
                }
                const person = people.find((candidate) => `u:${candidate.uid}` === choice);
                return person ? person.name : 'someone';
            });
            const who = parts.length > 4
                ? `${parts.slice(0, 3).join(', ')} and ${parts.length - 3} more`
                : (parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);
            const stepCount = Array.isArray(draft.subtasks) ? draft.subtasks.filter((step) => step && clean(step.text, 240)).length : 0;
            const withSteps = stepCount > 0 ? `, with ${stepCount} step${stepCount === 1 ? '' : 's'}` : '';
            if (others.length === 0) {
                return { allowed: true, text: `Add "${text}" to your own list${withSteps}.` };
            }
            return ctx.access.canAssign
                ? { allowed: true, text: `Give "${text}" to ${who}${withSteps}. It is one shared task: ${includesMe ? 'you and ' : ''}everyone named gets the same copy, and they can decline theirs for a few minutes.` }
                : { allowed: true, text: `Suggest "${text}" to ${others.map((person) => person.name).join(', ')}${includesMe ? ', and add it to your own list' : ''}${withSteps}. You can't assign directly in this group, so each person gets to accept it.` };
        }

        if (['createRole', 'setRole', 'grantAccess'].includes(action)) {
            if (!(ctx.access.isOwner || ctx.access.isAdmin)) {
                return blocked('Only the group owner or an admin can change roles and access.');
            }
        }

        if (action === 'createRole') {
            const name = clean(draft.roleName, 30);
            if (!name) {
                return blocked('No role name was given.');
            }
            if (findRole(ctx.group, name)) {
                return blocked(`There is already a role called "${name}".`);
            }
            if (GroupRoles.getAll(ctx.group).length >= GroupRoles.MAX_ROLES) {
                return blocked(`A group can have up to ${GroupRoles.MAX_ROLES} roles.`);
            }
            return { allowed: true, text: `Create the role "${name}"` };
        }

        if (action === 'setRole') {
            const member = findMember(ctx.group, draft.memberName);
            if (!member || member === 'ambiguous') {
                return blocked(member === 'ambiguous' ? `More than one person is called "${clean(draft.memberName, 40)}".` : `Nobody called "${clean(draft.memberName, 40)}" in this group.`);
            }
            const roleName = clean(draft.roleName, 30);
            if (!roleName || ['none', 'no role'].includes(norm(roleName))) {
                return { allowed: true, text: `Remove ${member.name}'s role` };
            }
            // The role may be one Dusty is also creating in this same batch, so a role
            // that doesn't exist yet is allowed here and checked again when applied.
            return { allowed: true, text: `Give ${member.name} the role "${roleName}"` };
        }

        if (action === 'grantAccess') {
            const member = findMember(ctx.group, draft.memberName);
            if (!member || member === 'ambiguous') {
                return blocked(member === 'ambiguous' ? `More than one person is called "${clean(draft.memberName, 40)}".` : `Nobody called "${clean(draft.memberName, 40)}" in this group.`);
            }
            if (member.uid === ctx.group.ownerId || (ctx.group.adminIds || []).includes(member.uid)) {
                return blocked(`${member.name} is an owner or admin, so they already have full access.`);
            }
            const rights = [];
            if (draft.assignRights === 'all') {
                rights.push('assign tasks to anyone');
            } else if (draft.assignRights === 'role') {
                rights.push('assign tasks to people in their own role');
            }
            if (draft.folderRights === true) {
                rights.push('manage folders');
            }
            return rights.length > 0
                ? { allowed: true, text: `Let ${member.name} ${rights.join(' and ')}` }
                : { allowed: true, text: `Remove ${member.name}'s extra access` };
        }

        return blocked('Dusty asked for something this app does not support.');
    }

    // ---- commit: apply the checked actions, one result per action ---------------
    async function commit(confirmed) {
        // Creations first (a folder or role other confirmed actions depend on), then the rest,
        // each keeping the order Dusty gave. Only what the user actually ticked counts as
        // "the batch", so unticking the createFolder card correctly fails the fileTasks one.
        const drafts = [...confirmed].sort((a, b) => Number(['createFolder', 'createRole'].includes(b.action)) - Number(['createFolder', 'createRole'].includes(a.action)));
        const results = [];
        const state = { access: null, accessIndexes: [], batch: drafts };

        for (const draft of drafts) {
            try {
                results.push(await applyOne(draft, state, results.length));
            } catch (error) {
                console.error('Dusty action failed:', draft && draft.action, error);
                const message = typeof describeGroupWriteError === 'function' && error && error.code === 'permission-denied'
                    ? describeGroupWriteError(error, '')
                    : (error && error.message) || 'it could not be applied';
                results.push({ applied: false, reason: message });
            }
        }

        // Roles/access changes are collected and written ONCE, so a batch like
        // "create a Designer role, make Sam a Designer" is a single atomic write.
        if (state.access && state.access.dirty) {
            try {
                await flushAccess(state.access);
            } catch (error) {
                console.error('Dusty could not save role/access changes:', error);
                const reason = typeof describeGroupWriteError === 'function'
                    ? describeGroupWriteError(error, 'The role/access change could not be saved.')
                    : 'The role/access change could not be saved.';
                state.accessIndexes.forEach((index) => {
                    results[index] = { applied: false, reason };
                });
            }
        }
        return results;
    }

    async function applyOne(draft, state, index) {
        // Re-checked at click time against live data, not trusted from the card.
        const verdict = describe(draft, state.batch);
        if (!verdict.allowed) {
            return { applied: false, reason: verdict.reason };
        }
        const action = draft.action;

        if (action === 'createFolder') {
            const message = await TodoFolders.add(clean(draft.folder, MAX_FOLDER_NAME));
            return message ? { applied: false, reason: message } : { applied: true };
        }

        if (action === 'fileTasks') {
            const folder = findFolder(draft.folder);
            if (!folder) {
                // Only reachable when the createFolder this depended on didn't succeed.
                return { applied: false, reason: `The folder "${clean(draft.folder, MAX_FOLDER_NAME)}" doesn't exist, so nothing was filed.` };
            }
            const assignments = {};
            myTasksByIds(draft.taskIds).forEach((task) => { assignments[task.id] = folder.id; });
            if (isGroupPage()) {
                await applyGroupFolderAssignments(getSelectedGroup().id, assignments);
            } else {
                applyFolderAssignments(assignments);
            }
            return { applied: true };
        }

        if (action === 'assign') {
            const { group } = groupContext();
            const { choices } = resolveAssignChoices(group, assignNames(draft));
            const isoOrNull = (value) => (value && isValidDateValue(value) ? new Date(value).toISOString() : null);
            const taskType = draft.taskType === 'timeboxed' ? 'timeboxed' : 'open';
            // The SAME full task goes to everyone named (steps, estimate, schedule, repeat and
            // all), as ONE shared assignment - not a bare title with the details left behind.
            const subtasks = (Array.isArray(draft.subtasks) ? draft.subtasks : [])
                .slice(0, 200)
                .map((step) => ({ text: clean(step && step.text, 240), dueAt: isoOrNull(step && step.dueAt) }))
                .filter((step) => step.text);
            // runGroupAssignment assigns for owners/admins/granted members and falls back to
            // suggestions for everyone else, and throws if nobody received it.
            await runGroupAssignment(group, choices, {
                text: clean(draft.text, AI_TASK_TITLE_MAX_LENGTH),
                matrix: draft.matrix,
                difficulty: draft.difficulty,
                dueAt: isoOrNull(draft.dueAt),
                scheduledAt: isoOrNull(draft.scheduledAt),
                recurrence: draft.recurrence,
                taskType,
                estimateMinutes: taskType === 'timeboxed' ? parseDurationMinutes(draft.estimateMinutes) : null,
                subtasks
            });
            return { applied: true };
        }

        // roles / access: work on a copy of the live group, written once afterwards
        const { group, uid } = groupContext();
        if (!state.access) {
            state.access = loadAccessWorkingCopy(group);
        }
        const work = state.access;
        let reason = null;

        if (action === 'createRole') {
            const name = clean(draft.roleName, 30);
            if (work.roles.some((role) => norm(role.name) === norm(name))) {
                reason = `There is already a role called "${name}".`;
            } else if (work.roles.length >= GroupRoles.MAX_ROLES) {
                reason = `A group can have up to ${GroupRoles.MAX_ROLES} roles.`;
            } else {
                const used = new Set(work.roles.map((role) => role.color));
                work.roles.push({
                    id: makeShortId('r_'),
                    name,
                    color: TodoFolders.COLORS.find((color) => !used.has(color)) || TodoFolders.COLORS[0]
                });
                work.dirty = true;
            }
        } else if (action === 'setRole') {
            const member = findMember(group, draft.memberName);
            const roleName = clean(draft.roleName, 30);
            if (!roleName || ['none', 'no role'].includes(norm(roleName))) {
                delete work.memberRoles[member.uid];
                work.dirty = true;
            } else {
                const role = work.roles.find((candidate) => norm(candidate.name) === norm(roleName));
                if (!role) {
                    reason = `There is no role called "${roleName}". Create it first.`;
                } else {
                    work.memberRoles[member.uid] = role.id;
                    work.dirty = true;
                }
            }
        } else if (action === 'grantAccess') {
            const member = findMember(group, draft.memberName);
            const next = {};
            if (draft.assignRights === 'all' || draft.assignRights === 'role') {
                next.assign = draft.assignRights;
            }
            if (draft.folderRights === true) {
                next.folders = true;
            }
            if (Object.keys(next).length > 0) {
                work.memberPerms[member.uid] = next;
            } else {
                delete work.memberPerms[member.uid];
            }
            work.dirty = true;
        }

        if (reason) {
            return { applied: false, reason };
        }
        state.accessIndexes.push(index);
        return { applied: true };
    }

    // A private copy of the LIVE roles/roles-of-members/grants. Grants from before a
    // person last left and rejoined are dropped (never quietly revived).
    function loadAccessWorkingCopy(group) {
        const memberPerms = {};
        Object.keys(group.memberPerms || {}).forEach((uid) => {
            if (GroupRoles.grantIsCurrent(group.memberPerms[uid], (group.memberJoinedAt || {})[uid])) {
                memberPerms[uid] = { ...group.memberPerms[uid] };
            }
        });
        return {
            groupId: group.id,
            roles: GroupRoles.getAll(group).map((role) => ({ ...role })),
            memberRoles: { ...GroupRoles.sanitizeMemberRoles(group.memberRoles, group.memberIds, GroupRoles.getAll(group)) },
            memberPerms,
            dirty: false
        };
    }

    async function flushAccess(work) {
        // Re-read the live group at write time and re-check permission once more.
        const group = getSelectedGroup();
        if (!group || group.id !== work.groupId || !(getMyAccess(group).isOwner || getMyAccess(group).isAdmin)) {
            throw new Error('You no longer have permission to change roles and access here.');
        }
        const roles = GroupRoles.sanitizeRoles(work.roles);
        const fullAccess = [group.ownerId, ...(group.adminIds || [])];
        const { doc, updateDoc } = fs();
        await updateDoc(doc(db(), 'groups', group.id), {
            roles,
            memberRoles: GroupRoles.sanitizeMemberRoles(work.memberRoles, group.memberIds, roles),
            memberPerms: GroupRoles.sanitizeMemberPerms(work.memberPerms, group.memberIds, fullAccess, group.memberJoinedAt || {})
        });
    }

    // ---- tidy Dusty's reply BEFORE the cards are drawn ----------------------------
    // "Me and Philip should both have this" has to be ONE shared assignment that includes
    // the user. The prompt says so, but the model can still slip and send the task for the
    // user plus a separate assignment for Philip (two unlinked copies, and the second one
    // without the steps). This repairs that in code so it never reaches the cards:
    //  - a task in "tasks" that matches an assign action's title is folded INTO that action
    //    (the user is added, and any steps/fields the action lacked are carried over);
    //  - an assign action aimed only at the user is just a normal task, so it moves to "tasks".
    // Mutates and returns the reply. Only touches group replies that contain assign actions.
    const FIELD_KEYS = ['matrix', 'taskType', 'difficulty', 'estimateMinutes', 'dueAt', 'scheduledAt', 'recurrence'];
    const titleKey = (text) => norm(text).replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();

    function normalizeReply(data) {
        if (!data || !isGroupPage() || !Array.isArray(data.actions) || !data.actions.some((a) => a && a.action === 'assign')) {
            return data;
        }
        const taskList = Array.isArray(data.tasks) ? data.tasks : [];

        data.actions.forEach((action) => {
            if (!action || action.action !== 'assign' || !titleKey(action.text)) {
                return;
            }
            const index = taskList.findIndex((task) => task && titleKey(task.text) === titleKey(action.text));
            if (index === -1) {
                return;
            }
            const task = taskList.splice(index, 1)[0];
            FIELD_KEYS.forEach((key) => {
                if ((action[key] === null || action[key] === undefined || action[key] === '') && task[key] !== null && task[key] !== undefined) {
                    action[key] = task[key];
                }
            });
            if ((!Array.isArray(action.subtasks) || action.subtasks.length === 0) && Array.isArray(task.subtasks)) {
                action.subtasks = task.subtasks;
            }
            const names = assignNames(action);
            if (!names.some(isMeToken)) {
                names.unshift('me');
            }
            action.assignTo = names;
        });

        data.actions = data.actions.filter((action) => {
            if (!action || action.action !== 'assign') {
                return true;
            }
            const names = assignNames(action);
            if (names.length > 0 && names.every(isMeToken)) {
                taskList.push({
                    text: action.text,
                    matrix: action.matrix,
                    taskType: action.taskType || 'open',
                    difficulty: action.difficulty,
                    estimateMinutes: action.estimateMinutes,
                    dueAt: action.dueAt,
                    scheduledAt: action.scheduledAt,
                    recurrence: action.recurrence,
                    subtasks: Array.isArray(action.subtasks) ? action.subtasks : []
                });
                return false;
            }
            return true;
        });
        data.tasks = taskList;
        return data;
    }

    return { capabilities, describe, commit, prepare, normalizeReply };
})();
