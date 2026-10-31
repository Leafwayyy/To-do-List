// Task folders - one folder per task, with a color. See organization-plan.md
// section 5.1. A folder is just { id, name, color }; a task points at one with
// an optional folderId. Deleting a folder never rewrites tasks: a task whose
// folderId no longer exists simply renders as Unfiled (resolve() returns null),
// which is what lets a group admin delete a folder without editing tasks
// they don't own (group phase) and keeps delete trivially safe.
//
// Storage is behind a small adapter so the solo app (users/{uid}.folders) and,
// later, the group dashboard (groups/{id}.folders) share this one file.
// Classic script, loaded before script.js.

// Small helpers shared by folders.js, roles.js, assign.js and quickadd.js (all
// load after this file on both pages).
function makeShortId(prefix, byteCount = 6, length = 8) {
    const bytes = new Uint8Array(byteCount);
    crypto.getRandomValues(bytes);
    return prefix + Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, length);
}

// A case-insensitive whole-word matcher for a user-typed name. The name is
// escaped first, so it can only ever match literally (no regex injection).
function wholeWordRegex(name) {
    const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'iu');
}

const TodoFolders = (() => {
    const MAX_FOLDERS = 30;
    const NAME_MAX = 30;
    // Fixed palette (organization-plan.md Q7): consistent with the violet
    // theme and avoids free-picker contrast problems.
    const COLORS = ['#b58bff', '#7f86ff', '#4dc4ff', '#4dd699', '#a3e635', '#ffb84d', '#ff8a5c', '#ff6b6b', '#ff8fd0', '#94a3b8'];

    let folders = [];
    let adapter = null;
    let canEdit = true;
    const listeners = new Set();
    let managerOverlay = null;

    const newId = () => makeShortId('f_');

    // Never trust stored data: cap, de-dupe by id, force a palette color.
    function sanitize(list) {
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
            if (!id || !name || seen.has(id) || clean.length >= MAX_FOLDERS) {
                return;
            }
            seen.add(id);
            clean.push({ id, name, color: COLORS.includes(entry.color) ? entry.color : COLORS[0] });
        });
        return clean;
    }

    function notify() {
        listeners.forEach((fn) => fn(folders));
    }

    function getAll() {
        return folders;
    }

    // null for no folder or a folder that was deleted -> caller shows Unfiled.
    function resolve(folderId) {
        return folders.find((folder) => folder.id === folderId) || null;
    }

    function onChange(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
    }

    async function init(newAdapter) {
        adapter = newAdapter;
        canEdit = adapter.canEdit !== false;
        try {
            folders = sanitize(await adapter.read());
        } catch (error) {
            console.error('Failed to load folders:', error);
            folders = [];
        }
        notify();
    }

    // Group pages get their folders from the already-subscribed group doc
    // rather than a one-off read, so they push each snapshot in here instead
    // of calling init(). Only members with canEdit (owner/admin) can change
    // the list; everyone else just reads it. Notifies only on a real change,
    // so calling this from every render can't loop.
    function attach({ folders: list, canEdit: editable, write }) {
        const clean = sanitize(list);
        const nextCanEdit = editable !== false;
        const changed = JSON.stringify(clean) !== JSON.stringify(folders) || nextCanEdit !== canEdit;
        folders = clean;
        canEdit = nextCanEdit;
        adapter = { canEdit, read: async () => folders, write };
        if (changed) {
            notify();
        }
    }

    function isEditable() {
        return canEdit;
    }

    // Optimistic update with revert: a failed write (e.g. rules not yet
    // published) puts the list back instead of showing folders that don't
    // exist on the server.
    async function commit(nextFolders) {
        const previous = folders;
        folders = sanitize(nextFolders);
        notify();
        try {
            await adapter.write(folders);
            return null;
        } catch (error) {
            console.error('Failed to save folders:', error);
            folders = previous;
            notify();
            return error?.code === 'permission-denied'
                ? 'Could not save: the latest security rules need to be published first.'
                : 'Could not save your folders. Check your connection and try again.';
        }
    }

    function add(name, color) {
        const trimmed = String(name || '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
        if (!trimmed) {
            return Promise.resolve('Give the folder a name.');
        }
        if (folders.length >= MAX_FOLDERS) {
            return Promise.resolve(`You can have up to ${MAX_FOLDERS} folders.`);
        }
        if (folders.some((folder) => folder.name.toLowerCase() === trimmed.toLowerCase())) {
            return Promise.resolve('You already have a folder with that name.');
        }
        const usedColors = new Set(folders.map((folder) => folder.color));
        const chosen = COLORS.includes(color) ? color : (COLORS.find((c) => !usedColors.has(c)) || COLORS[0]);
        return commit([...folders, { id: newId(), name: trimmed, color: chosen }]);
    }

    function update(id, changes) {
        const trimmedName = changes.name === undefined ? undefined : String(changes.name).replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
        if (trimmedName === '') {
            return Promise.resolve('Folder name cannot be empty.');
        }
        if (trimmedName !== undefined && folders.some((f) => f.id !== id && f.name.toLowerCase() === trimmedName.toLowerCase())) {
            return Promise.resolve('You already have a folder with that name.');
        }
        return commit(folders.map((folder) => (folder.id === id
            ? { ...folder, ...(trimmedName !== undefined ? { name: trimmedName } : {}), ...(changes.color ? { color: changes.color } : {}) }
            : folder)));
    }

    function remove(id) {
        return commit(folders.filter((folder) => folder.id !== id));
    }

    // Fills a <select> with Unfiled + every folder. Hides the select's
    // wrapper (data-folder-field) when there are no folders so people who
    // never use folders see no extra field.
    function fillSelect(selectEl, selectedId) {
        if (!selectEl) {
            return;
        }
        // Rebuilding an open <select> snaps its list shut, and this is called
        // on every render, so only rebuild when the options actually changed.
        const signature = folders.map((folder) => folder.id + '\u0000' + folder.name).join('\u0001');
        if (selectEl.dataset.optionsSig !== signature) {
            selectEl.innerHTML = '';
            const none = document.createElement('option');
            none.value = '';
            none.textContent = 'No folder';
            selectEl.appendChild(none);
            folders.forEach((folder) => {
                const option = document.createElement('option');
                option.value = folder.id;
                option.textContent = folder.name;
                selectEl.appendChild(option);
            });
            selectEl.dataset.optionsSig = signature;
        }
        selectEl.value = resolve(selectedId) ? selectedId : '';
        const wrapper = selectEl.closest('[data-folder-field]');
        wrapper?.classList.toggle('hidden', folders.length === 0);
    }

    function createBadge(folderId) {
        const folder = resolve(folderId);
        if (!folder) {
            return null;
        }
        const badge = document.createElement('span');
        badge.className = 'folderBadge';
        badge.style.setProperty('--folder-color', folder.color);
        const dot = document.createElement('span');
        dot.className = 'folderDot';
        dot.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span');
        label.textContent = folder.name;
        badge.append(dot, label);
        badge.title = `Folder: ${folder.name}`;
        return badge;
    }

    // --- Manager dialog -------------------------------------------------

    function closeManager() {
        managerOverlay?.remove();
        managerOverlay = null;
    }

    function renderManager() {
        if (!managerOverlay) {
            return;
        }
        const list = managerOverlay.querySelector('.folderManagerList');
        const errorEl = managerOverlay.querySelector('.folderManagerError');
        const addInput = managerOverlay.querySelector('.folderManagerAddInput');
        list.innerHTML = '';

        if (folders.length === 0) {
            const empty = document.createElement('li');
            empty.className = 'folderManagerEmpty';
            empty.textContent = 'No folders yet. Add one below, like School or Work.';
            list.appendChild(empty);
        }

        const showError = (message) => {
            errorEl.textContent = message || '';
        };

        folders.forEach((folder) => {
            const row = document.createElement('li');
            row.className = 'folderManagerRow';

            const colorBtn = document.createElement('button');
            colorBtn.type = 'button';
            colorBtn.className = 'folderColorBtn';
            colorBtn.style.setProperty('--folder-color', folder.color);
            colorBtn.setAttribute('aria-label', `Change color of ${folder.name}`);
            colorBtn.title = 'Click to change color';
            colorBtn.addEventListener('click', async () => {
                const next = COLORS[(COLORS.indexOf(folder.color) + 1) % COLORS.length];
                showError(await update(folder.id, { color: next }));
            });

            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.className = 'folderNameInput';
            nameInput.maxLength = NAME_MAX;
            nameInput.value = folder.name;
            nameInput.setAttribute('aria-label', 'Folder name');
            const saveName = async () => {
                if (nameInput.value.trim() === folder.name) {
                    return;
                }
                const message = await update(folder.id, { name: nameInput.value });
                showError(message);
                if (message) {
                    nameInput.value = folder.name;
                }
            };
            nameInput.addEventListener('change', saveName);
            nameInput.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    nameInput.blur();
                }
            });

            const deleteBtn = document.createElement('button');
            deleteBtn.type = 'button';
            deleteBtn.className = 'folderDeleteBtn';
            deleteBtn.setAttribute('aria-label', `Delete folder ${folder.name}`);
            deleteBtn.innerHTML = '<i class="fa-solid fa-trash" aria-hidden="true"></i>';
            deleteBtn.addEventListener('click', async () => {
                if (!confirm(`Delete the folder "${folder.name}"? Its tasks are kept and move to No folder.`)) {
                    return;
                }
                showError(await remove(folder.id));
            });

            row.append(colorBtn, nameInput, deleteBtn);
            list.appendChild(row);
        });

        addInput.disabled = folders.length >= MAX_FOLDERS;
        // Re-render clears typed-but-unsaved add text only on success (below).
    }

    function openManager() {
        if (managerOverlay || !canEdit) {
            return;
        }
        managerOverlay = document.createElement('div');
        managerOverlay.className = 'folderManagerOverlay';
        managerOverlay.innerHTML = `
            <div class="folderManagerCard" role="dialog" aria-modal="true" aria-label="Manage folders">
                <div class="folderManagerHeader">
                    <h2>Folders</h2>
                    <button type="button" class="folderManagerCloseBtn" aria-label="Close">Done</button>
                </div>
                <ul class="folderManagerList"></ul>
                <div class="folderManagerAddRow">
                    <input type="text" class="folderManagerAddInput" maxlength="${NAME_MAX}" placeholder="New folder name" aria-label="New folder name">
                    <button type="button" class="folderManagerAddBtn">Add</button>
                </div>
                <p class="folderManagerError" role="alert"></p>
            </div>
        `;
        document.body.appendChild(managerOverlay);

        const addInput = managerOverlay.querySelector('.folderManagerAddInput');
        const errorEl = managerOverlay.querySelector('.folderManagerError');
        const doAdd = async () => {
            const message = await add(addInput.value);
            errorEl.textContent = message || '';
            if (!message) {
                addInput.value = '';
                addInput.focus();
            }
        };
        managerOverlay.querySelector('.folderManagerAddBtn').addEventListener('click', doAdd);
        addInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                doAdd();
            }
        });
        managerOverlay.querySelector('.folderManagerCloseBtn').addEventListener('click', closeManager);
        managerOverlay.addEventListener('click', (event) => {
            if (event.target === managerOverlay) {
                closeManager();
            }
        });
        managerOverlay.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                closeManager();
            }
        });

        renderManager();
        addInput.focus();
    }

    // --- Bulk sorter ----------------------------------------------------
    // For people with an existing pile of unfiled tasks: one dialog, every
    // unfiled task with a folder dropdown, plus "put everything left in X".
    // A folder whose whole name appears as a word in the task text is
    // preselected (and marked), nothing else is guessed.
    // getTasks() -> [{ id, text }]; apply({ taskId: folderId }) does the write.
    let sorterOverlay = null;

    function closeSorter() {
        sorterOverlay?.remove();
        sorterOverlay = null;
    }

    function guessFolderId(text) {
        const matches = folders.filter((folder) => wholeWordRegex(folder.name).test(text));
        return matches.length === 1 ? matches[0].id : '';
    }

    function openSorter({ getTasks, apply }) {
        if (sorterOverlay || folders.length === 0) {
            return;
        }
        const pending = getTasks();
        if (pending.length === 0) {
            return;
        }
        sorterOverlay = document.createElement('div');
        sorterOverlay.className = 'folderManagerOverlay';
        sorterOverlay.innerHTML = `
            <div class="folderManagerCard folderSorterCard" role="dialog" aria-modal="true" aria-label="Sort tasks into folders">
                <div class="folderManagerHeader">
                    <h2>Sort into folders</h2>
                    <button type="button" class="folderManagerCloseBtn folderSorterCancelBtn">Cancel</button>
                </div>
                <div class="folderSorterBulk">
                    <label>Put every task still unsorted into
                        <select class="folderSorterBulkSelect"></select>
                    </label>
                </div>
                <ul class="folderSorterList"></ul>
                <div class="folderManagerAddRow">
                    <button type="button" class="folderManagerAddBtn folderSorterApplyBtn">Move tasks</button>
                    <span class="folderSorterCount"></span>
                </div>
            </div>
        `;
        document.body.appendChild(sorterOverlay);

        const list = sorterOverlay.querySelector('.folderSorterList');
        const bulkSelect = sorterOverlay.querySelector('.folderSorterBulkSelect');
        const applyBtn = sorterOverlay.querySelector('.folderSorterApplyBtn');
        const countEl = sorterOverlay.querySelector('.folderSorterCount');
        const rowSelects = new Map();

        const fillFolderOptions = (select, skipLabel) => {
            select.innerHTML = '';
            const skip = document.createElement('option');
            skip.value = '';
            skip.textContent = skipLabel;
            select.appendChild(skip);
            folders.forEach((folder) => {
                const option = document.createElement('option');
                option.value = folder.id;
                option.textContent = folder.name;
                select.appendChild(option);
            });
        };

        const updateCount = () => {
            const moving = Array.from(rowSelects.values()).filter((select) => select.value !== '').length;
            countEl.textContent = moving === 0 ? 'Nothing selected yet' : `${moving} of ${pending.length} will move`;
            applyBtn.disabled = moving === 0;
        };

        pending.forEach((task) => {
            const row = document.createElement('li');
            row.className = 'folderSorterRow';
            const label = document.createElement('span');
            label.className = 'folderSorterText';
            label.textContent = task.text;
            const select = document.createElement('select');
            select.className = 'folderSorterSelect';
            select.setAttribute('aria-label', `Folder for ${task.text}`);
            fillFolderOptions(select, 'Skip');
            const guess = guessFolderId(task.text);
            if (guess) {
                select.value = guess;
                row.classList.add('guessed');
            }
            select.addEventListener('change', () => {
                row.classList.remove('guessed');
                updateCount();
            });
            rowSelects.set(task.id, select);
            row.append(label, select);
            list.appendChild(row);
        });

        fillFolderOptions(bulkSelect, 'Choose a folder...');
        bulkSelect.addEventListener('change', () => {
            if (!bulkSelect.value) {
                return;
            }
            rowSelects.forEach((select) => {
                if (select.value === '') {
                    select.value = bulkSelect.value;
                }
            });
            bulkSelect.value = '';
            updateCount();
        });

        applyBtn.addEventListener('click', () => {
            const assignments = {};
            rowSelects.forEach((select, taskId) => {
                if (select.value) {
                    assignments[taskId] = select.value;
                }
            });
            closeSorter();
            apply(assignments);
        });
        sorterOverlay.querySelector('.folderSorterCancelBtn').addEventListener('click', closeSorter);
        sorterOverlay.addEventListener('click', (event) => {
            if (event.target === sorterOverlay) {
                closeSorter();
            }
        });
        sorterOverlay.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                closeSorter();
            }
        });
        updateCount();
    }

    onChange(renderManager);

    // Solo storage: users/{uid}.folders on the profile doc, merged so it
    // never disturbs the streak/badge fields stored alongside it.
    function soloAdapter() {
        const ctx = () => {
            const auth = window.ToDoAuth;
            const user = auth?.auth?.currentUser;
            if (!user) {
                throw new Error('Not signed in');
            }
            return { ref: auth.firestore.doc(auth.db, 'users', user.uid), firestore: auth.firestore };
        };
        return {
            canEdit: true,
            async read() {
                const { ref, firestore } = ctx();
                const snapshot = await firestore.getDoc(ref);
                return snapshot.exists() ? snapshot.data().folders : [];
            },
            async write(list) {
                const { ref, firestore } = ctx();
                await firestore.setDoc(ref, { folders: list }, { merge: true });
            }
        };
    }

    return { COLORS, MAX_FOLDERS, init, getAll, resolve, onChange, add, update, remove, fillSelect, createBadge, openManager, closeManager, openSorter, soloAdapter, sanitize, attach, isEditable };
})();
