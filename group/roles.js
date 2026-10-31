// Group roles (organization-plan.md section 5.2). A role is a job title like
// "Designer" that people are grouped under. It carries NO permissions - owner,
// admin and member are unchanged. Stored on the group doc as
//   roles:       [{ id, name, color }]   (at most 20)
//   memberRoles: { uid: roleId }         (one role per member)
// A task never stores its role: it's derived from the assignee's current role
// at render time, so changing or deleting a role never needs to touch tasks.
// A member whose role was deleted (or who has none) just shows no role.
//
// Classic script, loaded after folders.js (shares its color palette).

const GroupRoles = (() => {
    const MAX_ROLES = 20;
    const NAME_MAX = 30;
    let overlay = null;

    const newId = () => makeShortId('r_');

    function sanitizeRoles(list) {
        if (!Array.isArray(list)) {
            return [];
        }
        const seen = new Set();
        const clean = [];
        list.forEach((entry) => {
            if (!entry || typeof entry.id !== 'string' || typeof entry.name !== 'string') {
                return;
            }
            const id = entry.id.slice(0, 40);
            const name = entry.name.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
            if (!id || !name || seen.has(id) || clean.length >= MAX_ROLES) {
                return;
            }
            seen.add(id);
            clean.push({ id, name, color: TodoFolders.COLORS.includes(entry.color) ? entry.color : TodoFolders.COLORS[0] });
        });
        return clean;
    }

    // Per-person access: { uid: { assign: 'all' | 'role', folders: true } }.
    // Only the exact known values survive; owners/admins are left out (they
    // already can do everything, so a grant on them would only be noise).
    //
    // Each kept grant is stamped with `since` = that member's CURRENT
    // memberJoinedAt (see grantIsCurrent in firestore.rules), so a grant given
    // before someone left and came back stops counting. `joinedAt` is
    // group.memberJoinedAt.
    function sanitizeMemberPerms(map, memberIds, fullAccessIds, joinedAt) {
        const clean = {};
        if (!map || typeof map !== 'object') {
            return clean;
        }
        (memberIds || []).forEach((uid) => {
            const entry = map[uid];
            if (!entry || typeof entry !== 'object' || (fullAccessIds || []).includes(uid)) {
                return;
            }
            const perms = {};
            if (entry.assign === 'all' || entry.assign === 'role') {
                perms.assign = entry.assign;
            }
            if (entry.folders === true) {
                perms.folders = true;
            }
            if (Object.keys(perms).length > 0) {
                if (joinedAt && joinedAt[uid]) {
                    perms.since = joinedAt[uid];
                }
                clean[uid] = perms;
            }
        });
        return clean;
    }

    // True when a stored grant still matches the member's current membership:
    // both stamps equal, or neither exists (a member from before join times
    // were recorded). Mirrors grantIsCurrent in firestore.rules exactly.
    function grantIsCurrent(grant, joinedAt) {
        const stamp = (value) => (value && typeof value.toMillis === 'function' ? value.toMillis() : null);
        const since = stamp(grant && grant.since);
        const joined = stamp(joinedAt);
        if (joined === null) {
            return since === null;
        }
        return since === joined;
    }

    // Keeps only current members pointing at a role that still exists. Run on
    // every save, which also prunes entries left behind by people who left.
    function sanitizeMemberRoles(map, memberIds, roles) {
        const clean = {};
        const roleIds = new Set(roles.map((role) => role.id));
        if (map && typeof map === 'object') {
            (memberIds || []).forEach((uid) => {
                if (typeof map[uid] === 'string' && roleIds.has(map[uid])) {
                    clean[uid] = map[uid];
                }
            });
        }
        return clean;
    }

    function getAll(group) {
        return sanitizeRoles(group?.roles);
    }

    // The role object for one member, or null.
    function getRole(group, uid) {
        const id = group?.memberRoles && typeof group.memberRoles === 'object' ? group.memberRoles[uid] : null;
        return getAll(group).find((role) => role.id === id) || null;
    }

    function createTag(role) {
        if (!role) {
            return null;
        }
        const tag = document.createElement('span');
        tag.className = 'jobRoleTag';
        tag.style.setProperty('--folder-color', role.color);
        const dot = document.createElement('span');
        dot.className = 'folderDot';
        dot.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span');
        label.textContent = role.name;
        tag.append(dot, label);
        tag.title = `Role: ${role.name}`;
        return tag;
    }

    function close() {
        overlay?.remove();
        overlay = null;
    }

    // onSave({ roles, memberRoles }) -> Promise<string|null> (error message).
    // Edits are a draft until Save, so roles and assignments land in one
    // atomic write and a half-edited state is never visible to the group.
    function openManager({ group, onSave }) {
        if (overlay || !group) {
            return;
        }
        let draftRoles = getAll(group).map((role) => ({ ...role }));
        const memberIds = group.memberIds || [];
        const memberNames = group.memberNames || [];
        let draftMemberRoles = sanitizeMemberRoles(group.memberRoles, memberIds, draftRoles);
        const fullAccessIds = [group.ownerId, ...(group.adminIds || [])];
        // Stale grants (given before the person left and rejoined) are NOT
        // shown or kept: saving this dialog must never quietly bring one back.
        const currentPerms = {};
        Object.keys(group.memberPerms || {}).forEach((uid) => {
            if (grantIsCurrent(group.memberPerms[uid], (group.memberJoinedAt || {})[uid])) {
                currentPerms[uid] = group.memberPerms[uid];
            }
        });
        const draftMemberPerms = sanitizeMemberPerms(currentPerms, memberIds, fullAccessIds, null);

        overlay = document.createElement('div');
        overlay.className = 'folderManagerOverlay';
        overlay.innerHTML = `
            <div class="folderManagerCard rolesManagerCard" role="dialog" aria-modal="true" aria-label="Manage roles and access">
                <div class="folderManagerHeader">
                    <h2>Roles &amp; access</h2>
                    <button type="button" class="folderManagerCloseBtn rolesCancelBtn">Cancel</button>
                </div>
                <p class="rolesHelp">A role is a job title, like Designer or Cashier. It only labels and groups people, it doesn't change what anyone is allowed to do.</p>
                <ul class="folderManagerList rolesList"></ul>
                <div class="folderManagerAddRow">
                    <input type="text" class="folderManagerAddInput rolesAddInput" maxlength="${NAME_MAX}" placeholder="New role name" aria-label="New role name">
                    <button type="button" class="folderManagerAddBtn rolesAddBtn">Add</button>
                </div>
                <p class="rolesSubheading">Who has which role</p>
                <ul class="folderManagerList rolesMembers"></ul>
                <p class="rolesSubheading">Extra access for specific people</p>
                <p class="rolesHelp">Owners and admins can always do everything. Here you can let one person do a bit more, without making them an admin. "Within their role" only lets them assign to people who share their role.</p>
                <ul class="folderManagerList rolesAccess"></ul>
                <div class="folderManagerAddRow">
                    <button type="button" class="folderManagerAddBtn rolesSaveBtn">Save</button>
                </div>
                <p class="folderManagerError rolesError" role="alert"></p>
            </div>
        `;
        document.body.appendChild(overlay);

        const rolesList = overlay.querySelector('.rolesList');
        const membersList = overlay.querySelector('.rolesMembers');
        const accessList = overlay.querySelector('.rolesAccess');
        const addInput = overlay.querySelector('.rolesAddInput');
        const errorEl = overlay.querySelector('.rolesError');
        const saveBtn = overlay.querySelector('.rolesSaveBtn');

        const fillRoleSelect = (select, selectedId) => {
            select.innerHTML = '';
            const none = document.createElement('option');
            none.value = '';
            none.textContent = 'No role';
            select.appendChild(none);
            draftRoles.forEach((role) => {
                const option = document.createElement('option');
                option.value = role.id;
                option.textContent = role.name;
                select.appendChild(option);
            });
            select.value = draftRoles.some((role) => role.id === selectedId) ? selectedId : '';
        };

        const renderMembers = () => {
            membersList.innerHTML = '';
            memberIds.forEach((uid, index) => {
                const row = document.createElement('li');
                row.className = 'folderSorterRow';
                const name = document.createElement('span');
                name.className = 'folderSorterText';
                name.textContent = typeof memberNames[index] === 'string' && memberNames[index] ? memberNames[index] : 'Member';
                const select = document.createElement('select');
                select.className = 'folderSorterSelect';
                select.setAttribute('aria-label', `Role for ${name.textContent}`);
                fillRoleSelect(select, draftMemberRoles[uid]);
                select.addEventListener('change', () => {
                    if (select.value) {
                        draftMemberRoles[uid] = select.value;
                    } else {
                        delete draftMemberRoles[uid];
                    }
                });
                row.append(name, select);
                membersList.appendChild(row);
            });
        };

        const renderAccess = () => {
            accessList.innerHTML = '';
            memberIds.forEach((uid, index) => {
                const row = document.createElement('li');
                row.className = 'folderSorterRow rolesAccessRow';
                const name = document.createElement('span');
                name.className = 'folderSorterText';
                name.textContent = typeof memberNames[index] === 'string' && memberNames[index] ? memberNames[index] : 'Member';
                row.appendChild(name);
                if (fullAccessIds.includes(uid)) {
                    const full = document.createElement('span');
                    full.className = 'rolesFullAccess';
                    full.textContent = uid === group.ownerId ? 'Owner: full access' : 'Admin: full access';
                    row.appendChild(full);
                    accessList.appendChild(row);
                    return;
                }
                const perms = draftMemberPerms[uid] || {};
                const assignSelect = document.createElement('select');
                assignSelect.className = 'folderSorterSelect';
                assignSelect.setAttribute('aria-label', `Assigning rights for ${name.textContent}`);
                [['', 'Cannot assign'], ['role', 'Assign within their role'], ['all', 'Assign to anyone']].forEach(([value, label]) => {
                    const option = document.createElement('option');
                    option.value = value;
                    option.textContent = label;
                    assignSelect.appendChild(option);
                });
                assignSelect.value = perms.assign || '';
                const foldersLabel = document.createElement('label');
                foldersLabel.className = 'rolesFoldersToggle';
                const foldersCheck = document.createElement('input');
                foldersCheck.type = 'checkbox';
                foldersCheck.checked = perms.folders === true;
                foldersLabel.append(foldersCheck, document.createTextNode(' Manage folders'));
                const save = () => {
                    const next = {};
                    if (assignSelect.value) {
                        next.assign = assignSelect.value;
                    }
                    if (foldersCheck.checked) {
                        next.folders = true;
                    }
                    if (Object.keys(next).length > 0) {
                        draftMemberPerms[uid] = next;
                    } else {
                        delete draftMemberPerms[uid];
                    }
                };
                assignSelect.addEventListener('change', save);
                foldersCheck.addEventListener('change', save);
                row.append(assignSelect, foldersLabel);
                accessList.appendChild(row);
            });
        };

        const renderRoles = () => {
            rolesList.innerHTML = '';
            if (draftRoles.length === 0) {
                const empty = document.createElement('li');
                empty.className = 'folderManagerEmpty';
                empty.textContent = 'No roles yet. Add one below, like Designer or Manager.';
                rolesList.appendChild(empty);
            }
            draftRoles.forEach((role) => {
                const row = document.createElement('li');
                row.className = 'folderManagerRow';

                const colorBtn = document.createElement('button');
                colorBtn.type = 'button';
                colorBtn.className = 'folderColorBtn';
                colorBtn.style.setProperty('--folder-color', role.color);
                colorBtn.setAttribute('aria-label', `Change color of ${role.name}`);
                colorBtn.title = 'Click to change color';
                colorBtn.addEventListener('click', () => {
                    const colors = TodoFolders.COLORS;
                    role.color = colors[(colors.indexOf(role.color) + 1) % colors.length];
                    renderRoles();
                });

                const nameInput = document.createElement('input');
                nameInput.type = 'text';
                nameInput.className = 'folderNameInput';
                nameInput.maxLength = NAME_MAX;
                nameInput.value = role.name;
                nameInput.setAttribute('aria-label', 'Role name');
                nameInput.addEventListener('change', () => {
                    const trimmed = nameInput.value.trim();
                    const clash = draftRoles.some((other) => other.id !== role.id && other.name.toLowerCase() === trimmed.toLowerCase());
                    if (!trimmed || clash) {
                        errorEl.textContent = clash ? 'You already have a role with that name.' : 'Role name cannot be empty.';
                        nameInput.value = role.name;
                        return;
                    }
                    errorEl.textContent = '';
                    role.name = trimmed.slice(0, NAME_MAX);
                    renderMembers();
                });

                const deleteBtn = document.createElement('button');
                deleteBtn.type = 'button';
                deleteBtn.className = 'folderDeleteBtn';
                deleteBtn.setAttribute('aria-label', `Delete role ${role.name}`);
                deleteBtn.innerHTML = '<i class="fa-solid fa-trash" aria-hidden="true"></i>';
                deleteBtn.addEventListener('click', () => {
                    draftRoles = draftRoles.filter((other) => other.id !== role.id);
                    draftMemberRoles = sanitizeMemberRoles(draftMemberRoles, memberIds, draftRoles);
                    renderRoles();
                    renderMembers();
                });

                row.append(colorBtn, nameInput, deleteBtn);
                rolesList.appendChild(row);
            });
            addInput.disabled = draftRoles.length >= MAX_ROLES;
        };

        const doAdd = () => {
            const trimmed = addInput.value.trim().slice(0, NAME_MAX);
            if (!trimmed) {
                errorEl.textContent = 'Give the role a name.';
                return;
            }
            if (draftRoles.length >= MAX_ROLES) {
                errorEl.textContent = `You can have up to ${MAX_ROLES} roles.`;
                return;
            }
            if (draftRoles.some((role) => role.name.toLowerCase() === trimmed.toLowerCase())) {
                errorEl.textContent = 'You already have a role with that name.';
                return;
            }
            const used = new Set(draftRoles.map((role) => role.color));
            const color = TodoFolders.COLORS.find((c) => !used.has(c)) || TodoFolders.COLORS[0];
            draftRoles.push({ id: newId(), name: trimmed, color });
            errorEl.textContent = '';
            addInput.value = '';
            renderRoles();
            renderMembers();
            addInput.focus();
        };

        overlay.querySelector('.rolesAddBtn').addEventListener('click', doAdd);
        addInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                doAdd();
            }
        });
        overlay.querySelector('.rolesCancelBtn').addEventListener('click', close);
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) {
                close();
            }
        });
        overlay.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                close();
            }
        });
        saveBtn.addEventListener('click', async () => {
            saveBtn.disabled = true;
            const roles = sanitizeRoles(draftRoles);
            const message = await onSave({
                roles,
                memberRoles: sanitizeMemberRoles(draftMemberRoles, memberIds, roles),
                memberPerms: sanitizeMemberPerms(draftMemberPerms, memberIds, fullAccessIds, group.memberJoinedAt || {})
            });
            if (message) {
                errorEl.textContent = message;
                saveBtn.disabled = false;
                return;
            }
            close();
        });

        renderRoles();
        renderMembers();
        renderAccess();
        addInput.focus();
    }

    return { MAX_ROLES, getAll, getRole, createTag, openManager, sanitizeRoles, sanitizeMemberRoles, sanitizeMemberPerms, grantIsCurrent };
})();
