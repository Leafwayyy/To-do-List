// Quick-add helpers for the solo task input (organization-plan.md section 5.3).
// Nothing here asks anyone to memorize symbols:
//   1. Chips under the input show what's set for the new task so far (tap x to
//      remove) and offer suggestions the app noticed in the text you typed.
//      Suggestions are never applied silently - you tap them.
//   2. A "/" menu (type "/" or tap the / button) picks Due date, Folder,
//      Priority, Difficulty, Repeat or Steps from plain-word lists.
//   3. Shortcuts: N focuses the input, Ctrl/Cmd+K focuses it from anywhere.
// It only drives the existing form controls (folderSelect, matrixSelect,
// deadlineInput, ...), so addTaskFromInputs in script.js is unchanged and the
// Prioritize panel stays in sync with whatever is chosen here.
//
// Classic script, loaded after script.js (solo) or group.js (groups): both
// define the same top-level elements. Anything only one page has is guarded
// below, and the group page additionally gets Assign / Suggest to.

const quickChipsEl = document.querySelector('.quickChips');
const slashBtn = document.querySelector('.slashBtn');

const QUICK_MATRIX_LABELS = {
    do: 'Important & urgent',
    schedule: 'Important',
    delegate: 'Urgent',
    eliminate: 'Not important'
};
const QUICK_URGENT_WORDS = /\b(urgent|asap|immediately|emergency)\b/i;
const QUICK_REPEAT_PATTERN = /\b(every\s+(day|week|month|sunday|monday|tuesday|wednesday|thursday|friday|saturday)|daily|weekly|monthly)\b/i;

// ---- Page differences --------------------------------------------------------

// The selected group when this is the group page (it alone has an assign
// field), else null.
function quickGroup() {
    if (typeof assignSelect === 'undefined' || !assignSelect || typeof getSelectedGroup !== 'function') {
        return null;
    }
    return getSelectedGroup() || null;
}

function quickAssignVerb() {
    const group = quickGroup();
    if (!group) {
        return 'Assign';
    }
    return getMyAccess(group).canAssign ? 'Assign' : 'Suggest';
}

function quickApplyDue(preset) {
    if (preset === 'clear') {
        deadlineInput.value = '';
        return;
    }
    const date = computePresetDate(preset);
    if (date) {
        deadlineInput.value = toDatetimeLocalValue(date.toISOString());
    }
}

function quickOpenDetails() {
    if (typeof setDetailsPanelOpen === 'function') {
        setDetailsPanelOpen(true);
    } else {
        taskDetailsPanel?.classList.add('open');
        document.querySelector('.detailsToggleBtn')?.setAttribute('aria-expanded', 'true');
    }
}

function quickFormChanged() {
    renderQuickChips();
    updateQuickAddHint();
}

// ---- Chips ----------------------------------------------------------------

function quickFindFolderInText(text) {
    const matches = TodoFolders.getAll().filter((folder) => wholeWordRegex(folder.name).test(text));
    // Two folders named in one task is ambiguous - suggest nothing.
    return matches.length === 1 ? matches[0] : null;
}

// A teammate named by first name in the text (whole word, unambiguous, never
// you). Only suggested - nothing is assigned until the chip is tapped.
function quickFindTeammateInText(text) {
    const group = quickGroup();
    if (!group || (group.memberIds || []).length < 2) {
        return null;
    }
    const firstNames = (group.memberIds || []).map((uid, index) => ({
        uid,
        name: String((group.memberNames || [])[index] || '').trim().split(/\s+/)[0]
    })).filter((member) => member.uid !== currentUser?.uid && member.name.length >= 3);
    const matches = firstNames.filter((member) => {
        const sameFirstName = firstNames.filter((other) => other.name.toLowerCase() === member.name.toLowerCase());
        return sameFirstName.length === 1 && wholeWordRegex(member.name).test(text);
    });
    return matches.length === 1 ? matches[0] : null;
}

function quickRepeatFromMatch(match) {
    const word = match[1].toLowerCase().replace(/\s+/g, ' ');
    if (word === 'daily' || word.endsWith('day')) {
        // "every day" and "daily"; weekday names also end in "day", so check
        // the weekday list first.
        const weekday = word.replace(/^every\s+/, '');
        if (QUICK_ADD_WEEKDAYS.includes(weekday)) {
            return { recurrence: 'weekly', weekday };
        }
        return { recurrence: 'daily', weekday: null };
    }
    if (word === 'weekly' || word === 'every week') {
        return { recurrence: 'weekly', weekday: null };
    }
    return { recurrence: 'monthly', weekday: null };
}

function acceptRepeatSuggestion(match) {
    const { recurrence, weekday } = quickRepeatFromMatch(match);
    taskInput.value = taskInput.value.replace(match[0], '').replace(/\s{2,}/g, ' ').trim();
    recurrenceSelect.value = recurrence;
    // A repeat needs a date to repeat from. Keep any date already typed in
    // the text or chosen; otherwise pick the weekday named, else tomorrow 9 AM.
    if (deadlineInput.value.trim() === '' && !parseQuickAddPhrase(taskInput.value).dueAt) {
        if (weekday) {
            const next = getNextQuickAddWeekday(new Date(), weekday);
            next.setHours(9, 0, 0, 0);
            deadlineInput.value = toDatetimeLocalValue(next.toISOString());
        } else {
            quickApplyDue('tomorrow');
        }
    }
    updateAddBtnState();
    quickFormChanged();
}

function renderQuickChips() {
    if (!quickChipsEl) {
        return;
    }
    quickChipsEl.innerHTML = '';

    const addApplied = (label, colorVar, onRemove, removeLabel) => {
        const chip = document.createElement('span');
        chip.className = 'quickChip applied';
        if (colorVar) {
            chip.style.setProperty('--folder-color', colorVar);
            const dot = document.createElement('span');
            dot.className = 'folderDot';
            dot.setAttribute('aria-hidden', 'true');
            chip.appendChild(dot);
        }
        const text = document.createElement('span');
        text.textContent = label;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'quickChipRemove';
        remove.setAttribute('aria-label', removeLabel);
        remove.textContent = '×';
        remove.addEventListener('click', () => {
            onRemove();
            quickFormChanged();
        });
        chip.append(text, remove);
        quickChipsEl.appendChild(chip);
    };

    const addSuggestion = (label, onAccept) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'quickChip suggest';
        chip.textContent = label;
        chip.addEventListener('click', () => {
            onAccept();
            quickFormChanged();
            taskInput.focus();
        });
        quickChipsEl.appendChild(chip);
    };

    // What is set so far.
    const folder = TodoFolders.resolve(folderSelect?.value);
    if (folder) {
        addApplied(folder.name, folder.color, () => { folderSelect.value = ''; }, `Remove folder ${folder.name}`);
    }
    if (matrixSelect.value !== 'schedule') {
        addApplied(QUICK_MATRIX_LABELS[matrixSelect.value] || matrixSelect.value, null, () => { matrixSelect.value = 'schedule'; }, 'Reset priority');
    }
    if (difficultySelect && difficultySelect.value !== '3') {
        addApplied(`Difficulty: ${getDifficultyLabel(getValidDifficultyLevel(difficultySelect.value))}`, null, () => { difficultySelect.value = '3'; }, 'Reset difficulty');
    }
    if (deadlineInput.value.trim() !== '') {
        const due = new Date(deadlineInput.value);
        if (!Number.isNaN(due.getTime())) {
            addApplied(`Due ${formatFriendlyDateTime(due)}`, null, () => { deadlineInput.value = ''; }, 'Clear due date');
        }
    }
    if (typeof assignSelect !== 'undefined' && assignSelect && assignSelect.value) {
        const picked = assignSelect.selectedOptions[0]?.textContent || 'someone';
        addApplied(`${quickAssignVerb()}: ${picked.replace(/^(Assign|Suggest) to: /, '')}`, null, () => { assignSelect.value = ''; }, 'Clear assignment');
    }
    if (recurrenceSelect.value) {
        addApplied(getRecurrenceLabel(recurrenceSelect.value), null, () => { recurrenceSelect.value = ''; }, 'Clear repeat');
    }

    // What the app noticed in the text (tap to accept).
    const text = taskInput.value;
    if (text.trim() !== '') {
        const suggestedFolder = quickFindFolderInText(text);
        if (suggestedFolder && folderSelect?.value !== suggestedFolder.id) {
            addSuggestion(`File under ${suggestedFolder.name}?`, () => { folderSelect.value = suggestedFolder.id; });
        }
        if (matrixSelect.value === 'schedule' && QUICK_URGENT_WORDS.test(text)) {
            addSuggestion('Mark important & urgent?', () => { matrixSelect.value = 'do'; });
        }
        const teammate = (typeof assignSelect !== 'undefined' && assignSelect && assignSelect.value === '') ? quickFindTeammateInText(text) : null;
        if (teammate) {
            addSuggestion(`${quickAssignVerb()} to ${teammate.name}?`, () => { assignSelect.value = `u:${teammate.uid}`; });
        }
        const repeatMatch = recurrenceSelect.value === '' ? text.match(QUICK_REPEAT_PATTERN) : null;
        if (repeatMatch) {
            const { recurrence } = quickRepeatFromMatch(repeatMatch);
            addSuggestion(`Repeat ${getRecurrenceLabel(recurrence).toLowerCase().replace(/^repeats\s*/, '')}?`, () => acceptRepeatSuggestion(repeatMatch));
        }
    }

    quickChipsEl.classList.toggle('empty', quickChipsEl.childElementCount === 0);
}

// ---- Slash menu -------------------------------------------------------------

const slashMenu = document.createElement('ul');
slashMenu.id = 'slashMenu';
slashMenu.className = 'slashMenu';
slashMenu.setAttribute('role', 'listbox');
slashMenu.setAttribute('aria-label', 'Quick options');
slashMenu.hidden = true;
document.querySelector('.inputContainer')?.appendChild(slashMenu);

let slashLevel = null;      // null = closed, 'root' or a category key
let slashItems = [];
let slashActive = 0;

function stripSlashToken() {
    taskInput.value = taskInput.value.replace(/(^|\s)\/[a-z]*$/i, '$1');
    updateAddBtnState();
}

function setFormValue(control, value) {
    control.value = value;
}

function slashItemsFor(level, filterText) {
    const filter = (filterText || '').toLowerCase();
    if (level === 'root') {
        const group = quickGroup();
        const assignItem = group && (group.memberIds || []).length > 1
            ? [{ label: `${quickAssignVerb()} to`, hint: 'a teammate, a role or everyone', open: 'assign' }]
            : [];
        return [
            { label: 'Due date', hint: 'when it is due', open: 'due' },
            { label: 'Folder', hint: 'where it lives', open: 'folder' },
            { label: 'Priority', hint: 'how important or urgent', open: 'priority' },
            { label: 'Difficulty', hint: 'how hard it is', open: 'difficulty' },
            { label: 'Repeat', hint: 'daily, weekly, monthly', open: 'repeat' },
            { label: 'Steps', hint: 'break it into steps', run: () => {
                const addStep = pendingStepsEditorMount?.querySelector('.stepDraftAddRowBtn');
                addStep?.click();
                setTimeout(() => pendingStepsEditorMount?.querySelector('input')?.focus(), 0);
            }, keepFocus: true },
            ...assignItem
        ].filter((item) => item.label.toLowerCase().startsWith(filter));
    }
    if (level === 'due') {
        return [
            { label: 'In 2 hours', run: () => quickApplyDue('hour2') },
            { label: 'End of day', run: () => quickApplyDue('eod') },
            { label: 'Tomorrow 9 AM', run: () => quickApplyDue('tomorrow') },
            { label: 'Pick a date...', run: () => { quickOpenDetails(); deadlineInput.focus(); }, keepFocus: true },
            { label: 'No due date', run: () => quickApplyDue('clear') }
        ];
    }
    if (level === 'assign') {
        const group = quickGroup();
        if (!group) {
            return [];
        }
        // Same scope the dropdown uses: a role-limited assigner is only offered
        // their own role's people, never Everyone.
        const access = getMyAccess(group);
        return GroupAssign.getChoiceOptions(group, currentUser?.uid, access.canAssign ? access.assignScope : 'all').map((option) => ({
            label: option.value === '' ? 'Just me' : option.label,
            run: () => setFormValue(assignSelect, option.value)
        }));
    }
    if (level === 'folder') {
        const folders = TodoFolders.getAll();
        if (folders.length === 0 && !TodoFolders.isEditable()) {
            return [];
        }
        if (folders.length === 0) {
            return [{ label: 'Create a folder...', run: () => TodoFolders.openManager(), keepFocus: true }];
        }
        return [
            ...folders.map((folder) => ({ label: folder.name, color: folder.color, run: () => setFormValue(folderSelect, folder.id) })),
            { label: 'No folder', run: () => setFormValue(folderSelect, '') }
        ];
    }
    if (level === 'priority') {
        return Object.keys(QUICK_MATRIX_LABELS).map((value) => ({
            label: QUICK_MATRIX_LABELS[value],
            run: () => setFormValue(matrixSelect, value)
        }));
    }
    if (level === 'difficulty') {
        return [1, 2, 3, 4, 5].map((level5) => ({
            label: getDifficultyLabel(level5),
            run: () => setFormValue(difficultySelect, String(level5))
        }));
    }
    if (level === 'repeat') {
        return [
            { label: 'Every day', run: () => chooseRepeat('daily') },
            { label: 'Every week', run: () => chooseRepeat('weekly') },
            { label: 'Every month', run: () => chooseRepeat('monthly') },
            { label: 'Does not repeat', run: () => chooseRepeat('') }
        ];
    }
    return [];
}

// A repeat needs a date to repeat from; give it tomorrow 9 AM if none is set
// (the chip row then shows that date, so it's visible, not hidden magic).
function chooseRepeat(value) {
    recurrenceSelect.value = value;
    if (value && deadlineInput.value.trim() === '' && !parseQuickAddPhrase(taskInput.value).dueAt) {
        quickApplyDue('tomorrow');
    }
}

function renderSlashMenu() {
    slashMenu.innerHTML = '';
    slashItems.forEach((item, index) => {
        const li = document.createElement('li');
        li.id = `slashItem${index}`;
        li.className = 'slashItem' + (index === slashActive ? ' active' : '');
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(index === slashActive));
        if (item.color) {
            li.style.setProperty('--folder-color', item.color);
            const dot = document.createElement('span');
            dot.className = 'folderDot';
            dot.setAttribute('aria-hidden', 'true');
            li.appendChild(dot);
        }
        const label = document.createElement('span');
        label.textContent = item.label;
        li.appendChild(label);
        if (item.hint) {
            const hint = document.createElement('span');
            hint.className = 'slashHint';
            hint.textContent = item.hint;
            li.appendChild(hint);
        }
        // mousedown (not click) + preventDefault keeps focus in the input.
        li.addEventListener('mousedown', (event) => {
            event.preventDefault();
            chooseSlashItem(index);
        });
        slashMenu.appendChild(li);
    });
    taskInput.setAttribute('aria-activedescendant', slashItems.length ? `slashItem${slashActive}` : '');
}

function openSlashMenu(level, filterText) {
    slashLevel = level;
    slashItems = slashItemsFor(level, filterText);
    slashActive = 0;
    if (slashItems.length === 0) {
        closeSlashMenu();
        return;
    }
    slashMenu.hidden = false;
    taskInput.setAttribute('aria-expanded', 'true');
    renderSlashMenu();
}

function closeSlashMenu() {
    slashLevel = null;
    slashItems = [];
    slashMenu.hidden = true;
    taskInput.setAttribute('aria-expanded', 'false');
    taskInput.removeAttribute('aria-activedescendant');
}

function chooseSlashItem(index) {
    const item = slashItems[index];
    if (!item) {
        return;
    }
    stripSlashToken();
    if (item.open) {
        openSlashMenu(item.open, '');
        taskInput.focus();
        return;
    }
    closeSlashMenu();
    item.run();
    quickFormChanged();
    if (!item.keepFocus) {
        taskInput.focus();
    }
}

taskInput.addEventListener('input', () => {
    const match = taskInput.value.match(/(^|\s)\/([a-z]*)$/i);
    if (match) {
        openSlashMenu('root', match[2]);
    } else if (slashLevel) {
        closeSlashMenu();
    }
    renderQuickChips();
});

// Capture + stopImmediatePropagation so Enter picks a menu item instead of
// also adding the task (script.js's own Enter handler is registered earlier).
taskInput.addEventListener('keydown', (event) => {
    if (!slashLevel) {
        return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        slashActive = (slashActive + step + slashItems.length) % slashItems.length;
        renderSlashMenu();
    } else if (event.key === 'Enter') {
        event.preventDefault();
        event.stopImmediatePropagation();
        chooseSlashItem(slashActive);
    } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeSlashMenu();
    } else if (event.key === 'ArrowLeft' && slashLevel !== 'root') {
        event.preventDefault();
        openSlashMenu('root', '');
    } else if (event.key === 'Tab') {
        closeSlashMenu();
    }
}, true);

taskInput.addEventListener('blur', () => setTimeout(closeSlashMenu, 120));

if (slashBtn) {
    slashBtn.addEventListener('mousedown', (event) => event.preventDefault());
    slashBtn.addEventListener('click', () => {
        if (slashLevel) {
            closeSlashMenu();
            return;
        }
        taskInput.focus();
        openSlashMenu('root', '');
    });
}

// ---- Keep chips in step with the form --------------------------------------

[matrixSelect, difficultySelect, deadlineInput, recurrenceSelect, folderSelect, typeof assignSelect !== 'undefined' ? assignSelect : null].forEach((control) => {
    control?.addEventListener('change', quickFormChanged);
    control?.addEventListener('input', renderQuickChips);
});
// Presets and the calendar picker set values without firing events.
taskDetailsPanel?.addEventListener('click', () => setTimeout(quickFormChanged, 0));
// After a task is added the form resets itself silently.
addBtn.addEventListener('click', () => setTimeout(quickFormChanged, 0));
taskInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        setTimeout(quickFormChanged, 0);
    }
});

// ---- Shortcuts --------------------------------------------------------------

function quickAddShortcutsBlocked() {
    return Boolean(
        (typeof taskEditorOverlay !== 'undefined' && taskEditorOverlay?.classList.contains('open'))
        || document.querySelector('.folderManagerOverlay')
        || (typeof tourController !== 'undefined' && tourController.isOpen())
        || (typeof groupTourController !== 'undefined' && groupTourController.isOpen())
    );
}

function focusQuickAdd() {
    if (typeof switchGroupView === 'function') {
        switchGroupView('tasks');
    } else if (typeof currentTopView !== 'undefined' && currentTopView !== 'tasks') {
        switchSoloView('tasks');
    }
    taskInput.focus();
    taskInput.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

document.addEventListener('keydown', (event) => {
    if (quickAddShortcutsBlocked()) {
        return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        focusQuickAdd();
        return;
    }
    const target = event.target;
    const typing = target instanceof HTMLElement
        && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
    if (!typing && !event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        focusQuickAdd();
    }
});

renderQuickChips();
