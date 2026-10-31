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

    // --- Folder filter chips (capped) -----------------------------------
    //
    // The filter row must never grow with the number of folders. It shows "All folders",
    // the folder being viewed, and the busiest few; the rest live in a floating "More
    // folders" panel (overlay, so it never pushes the page down). Narrow screens swap the
    // chips for one "Folder: X" button that opens the same panel. Both pages use this.

    const VISIBLE_FOLDER_CHIPS = 6;
    let pickerPanel = null;
    let pickerAnchor = null;
    let pickerCleanup = null;

    function closePicker(returnFocus) {
        pickerCleanup?.();
        pickerCleanup = null;
        pickerPanel?.remove();
        pickerPanel = null;
        if (pickerAnchor) {
            pickerAnchor.setAttribute('aria-expanded', 'false');
            if (returnFocus && pickerAnchor.isConnected) {
                pickerAnchor.focus();
            }
        }
        pickerAnchor = null;
    }

    function pickVisibleFolders(list, active, countFor) {
        if (list.length <= VISIBLE_FOLDER_CHIPS + 1) {
            return new Set(list.map((folder) => folder.id));
        }
        const ranked = list
            .map((folder, index) => ({ folder, index, count: countFor(folder.id) }))
            .sort((a, b) => b.count - a.count || a.index - b.index)
            .slice(0, VISIBLE_FOLDER_CHIPS)
            .map((entry) => entry.folder.id);
        const keep = new Set(ranked);
        // The folder you're looking at is always on the bar so you can see where you are.
        if (resolve(active) && !keep.has(active)) {
            keep.delete(ranked[ranked.length - 1]);
            keep.add(active);
        }
        return keep;
    }

    function openPicker(anchor, { active, countFor, noFolderCount, onSelect }) {
        if (pickerPanel && pickerAnchor === anchor) {
            closePicker(true);
            return;
        }
        closePicker(false);
        pickerAnchor = anchor;
        anchor.setAttribute('aria-expanded', 'true');

        const panel = document.createElement('div');
        panel.className = 'folderPickerPanel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'Choose a folder');

        const search = document.createElement('input');
        search.type = 'search';
        search.className = 'folderPickerSearch';
        search.placeholder = 'Find a folder';
        search.maxLength = NAME_MAX;
        search.setAttribute('aria-label', 'Find a folder');
        search.autocomplete = 'off';

        const list = document.createElement('div');
        list.className = 'folderPickerList';

        const choose = (value) => {
            closePicker(true);
            onSelect(value);
        };

        const addItem = (label, value, color, count) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'folderPickerItem' + (active === value ? ' active' : '');
            if (active === value) {
                item.setAttribute('aria-current', 'true');
            }
            if (color) {
                item.style.setProperty('--folder-color', color);
                const dot = document.createElement('span');
                dot.className = 'folderDot';
                dot.setAttribute('aria-hidden', 'true');
                item.appendChild(dot);
            }
            const text = document.createElement('span');
            text.className = 'folderPickerName';
            text.textContent = label;
            item.appendChild(text);
            if (count > 0) {
                const badge = document.createElement('span');
                badge.className = 'folderChipCount';
                badge.textContent = String(count);
                item.appendChild(badge);
            }
            item.addEventListener('click', () => choose(value));
            list.appendChild(item);
        };

        const renderList = () => {
            list.textContent = '';
            const needle = search.value.trim().toLowerCase();
            if (!needle) {
                addItem('All folders', 'all', null, 0);
            }
            const matches = folders.filter((folder) => !needle || folder.name.toLowerCase().includes(needle));
            matches.forEach((folder) => addItem(folder.name, folder.id, folder.color, countFor(folder.id)));
            if (!needle || 'no folder'.includes(needle)) {
                addItem('No folder', 'none', null, noFolderCount());
            }
            if (needle && matches.length === 0 && !'no folder'.includes(needle)) {
                const empty = document.createElement('p');
                empty.className = 'folderPickerEmpty';
                empty.textContent = 'No folder matches that.';
                list.appendChild(empty);
            }
        };
        renderList();
        search.addEventListener('input', renderList);
        search.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                list.querySelector('.folderPickerItem')?.click();
            }
        });

        panel.append(search, list);
        document.body.appendChild(panel);
        pickerPanel = panel;

        // Fixed to the viewport under the button, kept on screen. It overlays the page, so
        // opening it never moves anything.
        const place = () => {
            if (!anchor.isConnected) {
                closePicker(false);
                return;
            }
            const rect = anchor.getBoundingClientRect();
            const width = Math.min(320, window.innerWidth - 16);
            const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
            panel.style.width = width + 'px';
            panel.style.left = left + 'px';
            const below = window.innerHeight - rect.bottom - 14;
            if (below >= 220 || below >= rect.top) {
                panel.style.top = rect.bottom + 6 + 'px';
                panel.style.bottom = 'auto';
                panel.style.maxHeight = Math.max(160, Math.min(window.innerHeight * 0.5, below)) + 'px';
            } else {
                panel.style.top = 'auto';
                panel.style.bottom = window.innerHeight - rect.top + 6 + 'px';
                panel.style.maxHeight = Math.max(160, Math.min(window.innerHeight * 0.5, rect.top - 14)) + 'px';
            }
        };
        place();

        const onPointerDown = (event) => {
            if (!panel.contains(event.target) && !anchor.contains(event.target)) {
                closePicker(false);
            }
        };
        const onKeyDown = (event) => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                closePicker(true);
            }
        };
        // A scroll inside the list is fine; the page moving under the panel is not.
        const onScroll = (event) => {
            if (!panel.contains(event.target)) {
                closePicker(false);
            }
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', place);
        pickerCleanup = () => {
            document.removeEventListener('pointerdown', onPointerDown, true);
            document.removeEventListener('keydown', onKeyDown, true);
            window.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('resize', place);
        };
        search.focus({ preventScroll: true });
    }

    // Appends the filter controls to `container`. The caller owns the rest of the bar
    // (Sort / Manage / Roles / Group by). `countFor(id)` and `noFolderCount()` give open-task
    // counts for whichever tasks the page is showing; `onSelect(value)` gets 'all', 'none'
    // or a folder id and is responsible for re-rendering.
    function renderFilterChips(container, { active, countFor, noFolderCount, onSelect }) {
        if (!container || folders.length === 0) {
            closePicker(false);
            return;
        }
        const opts = { active, countFor, noFolderCount, onSelect };

        const addChip = (label, value, color, count) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'folderChip folderFilterChip' + (active === value ? ' active' : '');
            button.setAttribute('aria-pressed', String(active === value));
            if (color) {
                button.style.setProperty('--folder-color', color);
                const dot = document.createElement('span');
                dot.className = 'folderDot';
                dot.setAttribute('aria-hidden', 'true');
                button.appendChild(dot);
            }
            const text = document.createElement('span');
            text.textContent = label;
            button.appendChild(text);
            if (count > 0) {
                const badge = document.createElement('span');
                badge.className = 'folderChipCount';
                badge.textContent = String(count);
                button.appendChild(badge);
            }
            button.addEventListener('click', () => onSelect(value));
            container.appendChild(button);
        };

        // Narrow screens: one compact button instead of a wrapping row of chips.
        const current = active === 'none' ? { name: 'No folder', color: null } : (resolve(active) || { name: 'All folders', color: null });
        const picker = document.createElement('button');
        picker.type = 'button';
        picker.className = 'folderChip folderPickerChip' + (active !== 'all' ? ' active' : '');
        picker.setAttribute('aria-haspopup', 'dialog');
        picker.setAttribute('aria-expanded', 'false');
        const pickerLabel = document.createElement('span');
        pickerLabel.textContent = 'Folder: ' + current.name;
        const pickerIcon = document.createElement('i');
        pickerIcon.className = 'fa-solid fa-chevron-down';
        pickerIcon.setAttribute('aria-hidden', 'true');
        picker.append(pickerLabel, pickerIcon);
        picker.addEventListener('click', () => openPicker(picker, opts));
        container.appendChild(picker);

        addChip('All folders', 'all', null, 0);
        const visible = pickVisibleFolders(folders, active, countFor);
        folders.filter((folder) => visible.has(folder.id)).forEach((folder) => {
            addChip(folder.name, folder.id, folder.color, countFor(folder.id));
        });
        const hidden = folders.length - visible.size;
        if (hidden > 0) {
            const more = document.createElement('button');
            more.type = 'button';
            more.className = 'folderChip folderFilterChip folderMoreChip';
            more.setAttribute('aria-haspopup', 'dialog');
            more.setAttribute('aria-expanded', 'false');
            const moreLabel = document.createElement('span');
            moreLabel.textContent = `More folders (${hidden})`;
            const moreIcon = document.createElement('i');
            moreIcon.className = 'fa-solid fa-chevron-down';
            moreIcon.setAttribute('aria-hidden', 'true');
            more.append(moreLabel, moreIcon);
            more.addEventListener('click', () => openPicker(more, opts));
            container.appendChild(more);
        }
        addChip('No folder', 'none', null, noFolderCount());
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

    return { COLORS, MAX_FOLDERS, init, getAll, resolve, onChange, add, update, remove, fillSelect, createBadge, openManager, closeManager, openSorter, soloAdapter, sanitize, attach, isEditable, renderFilterChips, closePicker };
})();
