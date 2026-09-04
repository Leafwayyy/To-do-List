// Settings panel - Account, Sound, Data export, Groups, Privacy/legal, and
// account deletion. Deliberately self-contained: it injects its own trigger
// button, overlay markup, and styling at runtime instead of depending on
// markup already declared in index.html/style.css, so it can be added to a
// page with a single <script> tag and won't drift out of sync with either
// file. Talks to Firebase directly through window.ToDoAuth (see
// firebase-init.js) rather than through script.js's internal state.
//
// Sound muting is read by task-shared.js's playClickSound/playTaskCompleteSound
// via the same localStorage key (SOUND_MUTED_KEY below) - keep the two in sync
// if either changes.

(function () {
    const SOUND_MUTED_KEY = 'todoSoundMutedV1';
    // Matches BRAIN_DUMP_MEMORY_SOFT_LIMIT in brain-dump.js - kept as its
    // own constant here rather than shared, same independent-per-file
    // convention this app already uses for other small cross-file numbers.
    const MEMORY_SOFT_LIMIT = 60;

    // settings.js is always the same physical file at the repo root
    // regardless of whether it's loaded from index.html (root) or the
    // group pages (one directory down), so links to other root-level pages
    // are resolved relative to *this script's own* URL, not the page's -
    // same reasoning as the sound files in task-shared.js.
    const SETTINGS_SCRIPT_URL = document.currentScript?.src || window.location.href;
    const PRIVACY_URL = new URL('privacy.html', SETTINGS_SCRIPT_URL).href;
    const TERMS_URL = new URL('terms.html', SETTINGS_SCRIPT_URL).href;
    const MANAGE_GROUPS_URL = new URL('group/browse.html', SETTINGS_SCRIPT_URL).href;
    const APP_ROOT_URL = new URL('.', SETTINGS_SCRIPT_URL).href;

    let currentUser = null;
    let overlay = null;
    let nameInput = null;
    let emailText = null;
    let saveNameStatus = null;
    let muteToggle = null;
    let exportStatus = null;
    let deleteBtn = null;
    let deleteStatus = null;
    let deleteArmed = false;
    let memoryOverlay = null;
    let memoryList = null;
    let memoryEmpty = null;
    let memoryCount = null;
    let memoryManageCount = null;
    let memoryAddInput = null;
    let memoryAddBtn = null;
    let memoryAddStatus = null;
    let currentMemoryTotal = 0;

    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = `
            .settingsTriggerBtn {
                background: transparent;
                border: none;
                color: inherit;
                font: inherit;
                cursor: pointer;
                padding: 6px 8px;
                border-radius: 8px;
                opacity: 0.85;
            }
            .settingsTriggerBtn:hover { opacity: 1; }
            .settingsOverlay {
                position: fixed;
                inset: 0;
                z-index: 900;
                display: flex;
                align-items: center;
                justify-content: center;
                background: rgba(4, 6, 10, 0.68);
                padding: 20px;
            }
            .settingsOverlay.hidden { display: none; }
            .settingsCard {
                width: 100%;
                max-width: 480px;
                max-height: 86vh;
                overflow-y: auto;
                background: linear-gradient(150deg, #050225, #0a0537, #140a46);
                border: 1px solid rgba(170, 152, 255, 0.36);
                border-radius: 16px;
                color: #f6f4ff;
                font-family: 'Inter', system-ui, sans-serif;
                padding: 22px 24px 26px;
            }
            .settingsHeader {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 6px;
            }
            .settingsHeader h2 { margin: 0; font-size: 1.3rem; }
            .settingsCloseBtn {
                background: transparent;
                border: none;
                color: #f6f4ff;
                font-size: 1.4rem;
                cursor: pointer;
                line-height: 1;
                padding: 4px 8px;
            }
            .settingsSection {
                border-top: 1px solid rgba(170, 152, 255, 0.2);
                padding: 16px 0;
            }
            .settingsSection:first-of-type { border-top: none; }
            .settingsSection h3 {
                margin: 0 0 8px;
                font-size: 0.95rem;
                color: #b58bff;
                text-transform: uppercase;
                letter-spacing: 0.04em;
            }
            .settingsHint { margin: 0 0 10px; font-size: 0.88rem; color: #d7d0ff; }
            .settingsEmail { margin: 0 0 12px; font-size: 0.9rem; color: #d7d0ff; }
            .settingsFieldLabel { display: block; font-size: 0.82rem; margin-bottom: 6px; color: #d7d0ff; }
            .settingsInlineRow { display: flex; gap: 8px; }
            .settingsNameInput {
                flex: 1;
                background: rgba(255, 255, 255, 0.06);
                border: 1px solid rgba(170, 152, 255, 0.3);
                border-radius: 8px;
                color: #f6f4ff;
                padding: 8px 10px;
                font: inherit;
            }
            .settingsSaveNameBtn, .settingsSignOutBtn, .settingsExportBtn, .settingsLinkBtn, .settingsDeleteBtn, .settingsMemoryManageBtn, .settingsMemoryAddBtn {
                background: rgba(181, 139, 255, 0.16);
                border: 1px solid rgba(170, 152, 255, 0.44);
                color: #f6f4ff;
                border-radius: 8px;
                padding: 8px 14px;
                font: inherit;
                font-size: 0.88rem;
                cursor: pointer;
                text-decoration: none;
                display: inline-block;
            }
            .settingsSignOutBtn { margin-top: 12px; }
            .settingsSaveNameStatus, .settingsDeleteStatus { min-height: 1.1em; font-size: 0.82rem; color: #7f86ff; margin: 8px 0 0; }
            .settingsToggleRow { display: flex; align-items: center; gap: 10px; font-size: 0.92rem; cursor: pointer; }
            .settingsDangerSection h3 { color: #e08a8a; }
            .settingsDeleteBtn { background: rgba(224, 90, 90, 0.14); border-color: rgba(224, 90, 90, 0.5); }
            .settingsDeleteBtn.isArmed { background: rgba(224, 90, 90, 0.32); }
            .settingsCard a { color: #b58bff; }
            .settingsMemoryManageCount { opacity: 0.8; }
            /* A nested panel (opened from the "Manage memories" button, see
               openMemoryOverlay) rather than an inline list in the main
               Settings card - a long memory list (up to
               BRAIN_DUMP_MEMORY_SOFT_LIMIT of 60 in brain-dump.js) was
               pushing Groups/Privacy/Delete-account further and further
               down the main modal otherwise. Higher z-index than
               .settingsOverlay so it stacks on top of it. */
            .settingsMemoryOverlay {
                position: fixed;
                inset: 0;
                z-index: 950;
                display: flex;
                align-items: center;
                justify-content: center;
                background: rgba(4, 6, 10, 0.72);
                padding: 20px;
            }
            .settingsMemoryOverlay.hidden { display: none; }
            .settingsMemoryCard {
                width: 100%;
                max-width: 420px;
                max-height: 80vh;
                overflow-y: auto;
                background: linear-gradient(150deg, #050225, #0a0537, #140a46);
                border: 1px solid rgba(170, 152, 255, 0.36);
                border-radius: 16px;
                color: #f6f4ff;
                font-family: 'Inter', system-ui, sans-serif;
                padding: 22px 24px 26px;
            }
            /* These two toggle "hidden" via JS (refreshMemoryList) - each
               needs its own rule since .hidden alone was never generically
               styled in this file (only .settingsOverlay.hidden was),
               which is why the empty-state message used to stay visible
               even with saved memories showing above it. */
            .settingsMemoryEmpty.hidden { display: none; }
            .settingsMemoryCount.hidden { display: none; }
            .settingsMemoryAddStatus.hidden { display: none; }
            /* Same per-class reasoning as above - stays hidden on the group
               pages, where there's nothing to move into it (see buildOverlay's
               alertToggleBtn/difficultyVisibilityRow reparenting). */
            .settingsAlertsSection.hidden { display: none; }
            .settingsExportStatus.hidden { display: none; }
            .settingsExportStatus { margin: 8px 0 0; }
            .settingsMemoryAddRow { display: flex; gap: 8px; margin-bottom: 4px; }
            .settingsMemoryAddInput {
                flex: 1;
                min-width: 0;
                background: rgba(255, 255, 255, 0.06);
                border: 1px solid rgba(170, 152, 255, 0.3);
                border-radius: 8px;
                color: #f6f4ff;
                padding: 8px 10px;
                font: inherit;
                font-size: 0.86rem;
            }
            .settingsMemoryAddBtn { padding: 8px 16px; }
            .settingsMemoryAddStatus { color: #e08a8a; margin: 6px 0 12px; }
            .settingsMemoryList {
                list-style: none;
                margin: 0;
                padding: 0 2px 0 0;
                display: flex;
                flex-direction: column;
                gap: 6px;
            }
            .settingsMemoryItem {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 10px;
                background: rgba(255, 255, 255, 0.05);
                border: 1px solid rgba(170, 152, 255, 0.24);
                border-radius: 8px;
                padding: 8px 10px;
                font-size: 0.86rem;
            }
            .settingsMemoryItemText { flex: 1; min-width: 0; word-break: break-word; }
            /* An expired "context" memory (see refreshMemoryList) - Dusty
               already stopped using it, this just makes that visible here
               too instead of it looking identical to an active memory. */
            .settingsMemoryItemExpired { opacity: 0.55; }
            .settingsMemoryItemExpired .settingsMemoryItemText { text-decoration: line-through; text-decoration-color: rgba(215, 208, 255, 0.4); }
            .settingsMemoryExpiredBadge {
                flex: 0 0 auto;
                font-size: 0.68rem;
                font-weight: 700;
                color: #d7d0ff;
                background: rgba(255, 255, 255, 0.08);
                border: 1px solid rgba(170, 152, 255, 0.3);
                border-radius: 999px;
                padding: 2px 8px;
                white-space: nowrap;
                cursor: help;
            }
            .settingsMemoryForgetBtn {
                flex: 0 0 auto;
                background: transparent;
                border: none;
                color: #d7d0ff;
                cursor: pointer;
                font-size: 1rem;
                line-height: 1;
                padding: 2px 4px;
            }
            .settingsMemoryForgetBtn:hover { color: #e08a8a; }
        `;
        document.head.appendChild(style);
    }

    function injectTrigger() {
        const badge = document.querySelector('.userBadge');
        if (!badge || badge.querySelector('.settingsTriggerBtn')) {
            return;
        }
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'settingsTriggerBtn';
        btn.title = 'Settings';
        btn.setAttribute('aria-label', 'Settings');
        btn.innerHTML = '<i class="fa-solid fa-gear"></i>';
        btn.addEventListener('click', openOverlay);
        const signOutBtn = badge.querySelector('.userSignOutBtn');
        if (signOutBtn) {
            badge.insertBefore(btn, signOutBtn);
        } else {
            badge.appendChild(btn);
        }
    }

    function buildOverlay() {
        const node = document.createElement('div');
        node.className = 'settingsOverlay hidden';
        node.setAttribute('aria-hidden', 'true');
        node.innerHTML = `
            <div class="settingsCard" role="dialog" aria-modal="true" aria-label="Settings">
                <div class="settingsHeader">
                    <h2>Settings</h2>
                    <button type="button" class="settingsCloseBtn" aria-label="Close settings">&times;</button>
                </div>

                <section class="settingsSection">
                    <h3>Account</h3>
                    <p class="settingsEmail"></p>
                    <label class="settingsFieldLabel" for="settingsNameInput">Display name (shown to teammates)</label>
                    <div class="settingsInlineRow">
                        <input type="text" id="settingsNameInput" class="settingsNameInput" maxlength="60" placeholder="Your name">
                        <button type="button" class="settingsSaveNameBtn">Save</button>
                    </div>
                    <p class="settingsSaveNameStatus" aria-live="polite"></p>
                    <button type="button" class="settingsSignOutBtn">Sign out</button>
                </section>

                <section class="settingsSection">
                    <h3>Sound</h3>
                    <label class="settingsToggleRow" for="settingsMuteToggle">
                        <input type="checkbox" id="settingsMuteToggle" class="settingsMuteToggle">
                        <span>Mute click and completion sounds</span>
                    </label>
                </section>

                <section class="settingsSection settingsAlertsSection hidden"></section>

                <section class="settingsSection">
                    <h3>Your data</h3>
                    <p class="settingsHint">Download everything you've added as a JSON file.</p>
                    <button type="button" class="settingsExportBtn">Export my tasks</button>
                    <p class="settingsExportStatus settingsHint hidden" aria-live="polite"></p>
                </section>

                <section class="settingsSection">
                    <h3>Dusty's memory</h3>
                    <p class="settingsHint">Facts Dusty has saved about you, with your OK, to help future chats - nothing here unless you confirmed it first.</p>
                    <button type="button" class="settingsMemoryManageBtn">Manage memories<span class="settingsMemoryManageCount"></span></button>
                </section>

                <section class="settingsSection">
                    <h3>Groups</h3>
                    <p class="settingsHint">Manage, leave, or delete groups you belong to.</p>
                    <a class="settingsLinkBtn" href="${MANAGE_GROUPS_URL}">Manage my groups</a>
                </section>

                <section class="settingsSection">
                    <h3>Privacy &amp; legal</h3>
                    <p class="settingsHint"><a href="${PRIVACY_URL}">Privacy Policy</a> &middot; <a href="${TERMS_URL}">Terms of Service</a></p>
                </section>

                <section class="settingsSection settingsDangerSection">
                    <h3>Delete account</h3>
                    <p class="settingsHint">Permanently deletes your profile, your tasks, and removes you from every group. This can't be undone.</p>
                    <button type="button" class="settingsDeleteBtn">Delete my account &amp; data</button>
                    <p class="settingsDeleteStatus" aria-live="polite"></p>
                </section>
            </div>
        `;
        document.body.appendChild(node);

        node.addEventListener('click', (event) => {
            if (event.target === node) {
                closeOverlay();
            }
        });
        node.querySelector('.settingsCloseBtn').addEventListener('click', closeOverlay);
        node.querySelector('.settingsSaveNameBtn').addEventListener('click', saveDisplayName);
        node.querySelector('.settingsSignOutBtn').addEventListener('click', () => {
            window.ToDoAuth?.signOutUser?.();
            closeOverlay();
        });
        node.querySelector('.settingsExportBtn').addEventListener('click', exportTasks);
        node.querySelector('.settingsDeleteBtn').addEventListener('click', onDeleteClick);
        node.querySelector('.settingsMemoryManageBtn').addEventListener('click', openMemoryOverlay);

        emailText = node.querySelector('.settingsEmail');
        nameInput = node.querySelector('.settingsNameInput');
        saveNameStatus = node.querySelector('.settingsSaveNameStatus');
        muteToggle = node.querySelector('.settingsMuteToggle');
        exportStatus = node.querySelector('.settingsExportStatus');
        deleteBtn = node.querySelector('.settingsDeleteBtn');
        deleteStatus = node.querySelector('.settingsDeleteStatus');
        memoryManageCount = node.querySelector('.settingsMemoryManageCount');

        muteToggle.addEventListener('change', () => {
            try {
                localStorage.setItem(SOUND_MUTED_KEY, muteToggle.checked ? 'true' : 'false');
            } catch (error) {
                console.error('Could not save sound setting:', error);
            }
        });

        // Section A of the UI/UX rework: popup alerts and the difficulty-chip
        // toggle move out of solo's old sideColumn and into Settings, since
        // they're standing preferences, not controls that change what's on
        // screen right now. Solo-only (both null on the group pages, which
        // have their own separate .groupAlertToggleBtn and no difficulty
        // toggle at all) - real static markup, reparented via appendChild
        // (which moves rather than clones, so script.js's own click/change
        // listeners on them survive intact) rather than recreated here.
        const alertToggleBtn = document.querySelector('.alertToggleBtn');
        const difficultyVisibilityRow = document.querySelector('.metaVisibilityRow');
        if (alertToggleBtn || difficultyVisibilityRow) {
            const alertsSection = node.querySelector('.settingsAlertsSection');
            alertsSection.classList.remove('hidden');
            alertsSection.insertAdjacentHTML('afterbegin', '<h3>Alerts &amp; display</h3>');
            if (alertToggleBtn) {
                alertsSection.appendChild(alertToggleBtn);
            }
            if (difficultyVisibilityRow) {
                alertsSection.appendChild(difficultyVisibilityRow);
            }
        }

        return node;
    }

    function openOverlay() {
        if (!overlay) {
            overlay = buildOverlay();
        }
        refreshAccountFields();
        overlay.classList.remove('hidden');
        overlay.setAttribute('aria-hidden', 'false');
        document.addEventListener('keydown', onKeyDown);
    }

    function closeOverlay() {
        if (!overlay) {
            return;
        }
        overlay.classList.add('hidden');
        overlay.setAttribute('aria-hidden', 'true');
        document.removeEventListener('keydown', onKeyDown);
        resetDeleteArm();
    }

    function onKeyDown(event) {
        if (event.key !== 'Escape') {
            return;
        }
        // The memory panel sits on top of the main Settings panel (see
        // openMemoryOverlay) - Escape should close whichever is actually on
        // top first, not both at once.
        if (memoryOverlay && !memoryOverlay.classList.contains('hidden')) {
            closeMemoryOverlay();
            return;
        }
        closeOverlay();
    }

    function buildMemoryOverlay() {
        const node = document.createElement('div');
        node.className = 'settingsMemoryOverlay hidden';
        node.setAttribute('aria-hidden', 'true');
        node.innerHTML = `
            <div class="settingsMemoryCard" role="dialog" aria-modal="true" aria-label="Dusty's memory">
                <div class="settingsHeader">
                    <h2>Dusty's memory</h2>
                    <button type="button" class="settingsCloseBtn" aria-label="Close">&times;</button>
                </div>
                <p class="settingsHint">Facts Dusty has saved about you, with your OK, to help future chats - nothing here unless you confirmed it first.</p>

                <div class="settingsMemoryAddRow">
                    <input type="text" class="settingsMemoryAddInput" maxlength="300" placeholder="Tell Dusty something to remember...">
                    <button type="button" class="settingsMemoryAddBtn">Add</button>
                </div>
                <p class="settingsMemoryAddStatus settingsHint hidden" aria-live="polite"></p>

                <p class="settingsMemoryCount settingsHint hidden"></p>
                <ul class="settingsMemoryList"></ul>
                <p class="settingsMemoryEmpty settingsHint hidden">Nothing remembered yet.</p>
            </div>
        `;
        document.body.appendChild(node);

        node.addEventListener('click', (event) => {
            if (event.target === node) {
                closeMemoryOverlay();
            }
        });
        node.querySelector('.settingsCloseBtn').addEventListener('click', closeMemoryOverlay);
        node.querySelector('.settingsMemoryAddBtn').addEventListener('click', addMemoryManually);

        memoryList = node.querySelector('.settingsMemoryList');
        memoryEmpty = node.querySelector('.settingsMemoryEmpty');
        memoryCount = node.querySelector('.settingsMemoryCount');
        memoryAddInput = node.querySelector('.settingsMemoryAddInput');
        memoryAddBtn = node.querySelector('.settingsMemoryAddBtn');
        memoryAddStatus = node.querySelector('.settingsMemoryAddStatus');

        memoryAddInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                addMemoryManually();
            }
        });

        return node;
    }

    // Lets you tell Dusty something directly, without needing to phrase it
    // in a chat message and hope he offers to save it - the only OTHER
    // way a memory gets created (see brain-dump.js's commitMemories).
    // Writes to the exact same users/{uid}/dustyMemory collection, so both
    // paths are indistinguishable once saved.
    async function addMemoryManually() {
        if (!currentUser || !memoryAddInput) {
            return;
        }
        const trimmed = memoryAddInput.value.trim();
        if (!trimmed) {
            return;
        }
        if (currentMemoryTotal >= MEMORY_SOFT_LIMIT) {
            if (memoryAddStatus) {
                memoryAddStatus.textContent = `You're at the ${MEMORY_SOFT_LIMIT}-memory soft limit - delete something below first.`;
                memoryAddStatus.classList.remove('hidden');
            }
            return;
        }

        memoryAddBtn.disabled = true;
        if (memoryAddStatus) {
            memoryAddStatus.classList.add('hidden');
        }
        try {
            const { doc, setDoc, collection, serverTimestamp } = window.ToDoAuth.firestore;
            // doc(collectionRef) with no id segment auto-generates one -
            // this file stays dependency-free from task-shared.js's
            // generateTaskId() on purpose (see the file-level comment
            // about staying self-contained).
            await setDoc(doc(collection(window.ToDoAuth.db, 'users', currentUser.uid, 'dustyMemory')), {
                text: trimmed.slice(0, 300),
                createdAt: serverTimestamp()
            });
            memoryAddInput.value = '';
            refreshMemoryList();
        } catch (error) {
            console.error('Failed to add memory manually:', error);
            if (memoryAddStatus) {
                memoryAddStatus.textContent = 'Could not save. Try again.';
                memoryAddStatus.classList.remove('hidden');
            }
        } finally {
            memoryAddBtn.disabled = false;
        }
    }

    function openMemoryOverlay() {
        playClickSoundSafely();
        if (!memoryOverlay) {
            memoryOverlay = buildMemoryOverlay();
        }
        refreshMemoryList();
        memoryOverlay.classList.remove('hidden');
        memoryOverlay.setAttribute('aria-hidden', 'false');
    }

    function closeMemoryOverlay() {
        if (!memoryOverlay) {
            return;
        }
        memoryOverlay.classList.add('hidden');
        memoryOverlay.setAttribute('aria-hidden', 'true');
    }

    // This file has no shared click-sound helper of its own (unlike
    // script.js/group.js's playClickSound) - task-shared.js's version is
    // usually already on the page, but settings.js is deliberately usable
    // standalone, so this stays optional rather than a hard dependency.
    function playClickSoundSafely() {
        try {
            window.playClickSound?.();
        } catch {
            // Non-fatal - the button still works without the sound.
        }
    }

    function refreshAccountFields() {
        if (!currentUser) {
            return;
        }
        if (emailText) {
            emailText.textContent = currentUser.email || '';
        }
        try {
            muteToggle.checked = localStorage.getItem(SOUND_MUTED_KEY) === 'true';
        } catch (error) {
            muteToggle.checked = false;
        }

        const { doc, getDoc } = window.ToDoAuth.firestore;
        getDoc(doc(window.ToDoAuth.db, 'users', currentUser.uid)).then((snapshot) => {
            const data = snapshot.exists() ? snapshot.data() : null;
            nameInput.value = (data && data.displayName) || currentUser.displayName || '';
        }).catch((error) => {
            console.error('Failed to load profile name:', error);
        });

        refreshMemoryList();
    }

    // Re-fetched fresh both when the main Settings panel opens (updates
    // just the compact "Manage memories (N)" count) and again when the
    // memory panel itself opens (fills in the actual list) - no live
    // subscription, these are modals you glance at, not something that
    // needs to update while sitting open. Built with createElement/
    // textContent throughout, not innerHTML, since a saved memory's text
    // is whatever the user (or Dusty, before they confirmed it) typed -
    // the same reasoning that mattered for the group suggestions panel.
    function refreshMemoryList() {
        if (!currentUser) {
            return;
        }
        const { collection, getDocs } = window.ToDoAuth.firestore;
        getDocs(collection(window.ToDoAuth.db, 'users', currentUser.uid, 'dustyMemory')).then((snapshot) => {
            const total = snapshot.docs.length;
            setMemoryCounts(total);

            // The memory panel is built lazily (see openMemoryOverlay) -
            // nothing further to render until it exists.
            if (!memoryList) {
                return;
            }

            memoryList.innerHTML = '';
            snapshot.docs.forEach((memoryDoc) => {
                const memory = memoryDoc.data();
                const item = document.createElement('li');
                item.className = 'settingsMemoryItem';

                const textSpan = document.createElement('span');
                textSpan.className = 'settingsMemoryItemText';
                textSpan.textContent = memory.text || '';
                item.appendChild(textSpan);

                // Expired 'context' memories (see brain-dump.js's
                // isMemoryExpired) already stopped being sent to Dusty -
                // this is just so it's visible HERE too, rather than
                // silently sitting in the list looking identical to an
                // active one. Still has to be deleted manually - Dusty
                // stops using it, but nothing here auto-deletes anything.
                const isExpired = memory.type === 'context' && typeof memory.expiresAt === 'string' && new Date(memory.expiresAt) <= new Date();
                if (isExpired) {
                    item.classList.add('settingsMemoryItemExpired');
                    const expiredBadge = document.createElement('span');
                    expiredBadge.className = 'settingsMemoryExpiredBadge';
                    expiredBadge.textContent = 'No longer used';
                    expiredBadge.title = 'This was a temporary "current situation" memory - Dusty has stopped using it since it\'s likely stale now. Delete it whenever you like.';
                    item.appendChild(expiredBadge);
                }

                const forgetBtn = document.createElement('button');
                forgetBtn.type = 'button';
                forgetBtn.className = 'settingsMemoryForgetBtn';
                forgetBtn.setAttribute('aria-label', 'Forget this');
                forgetBtn.title = 'Forget this';
                forgetBtn.textContent = '×';
                forgetBtn.addEventListener('click', async () => {
                    forgetBtn.disabled = true;
                    try {
                        const { doc, deleteDoc } = window.ToDoAuth.firestore;
                        await deleteDoc(doc(window.ToDoAuth.db, 'users', currentUser.uid, 'dustyMemory', memoryDoc.id));
                        item.remove();
                        setMemoryCounts(memoryList.children.length);
                    } catch (error) {
                        console.error('Failed to delete saved memory:', error);
                        forgetBtn.disabled = false;
                    }
                });
                item.appendChild(forgetBtn);

                memoryList.appendChild(item);
            });
        }).catch((error) => {
            console.error('Failed to load saved memories:', error);
        });
    }

    // Updates every place a memory count is shown - the compact button in
    // the main Settings panel, and (if built) the count line and
    // empty-state inside the memory panel itself. 60 matches
    // BRAIN_DUMP_MEMORY_SOFT_LIMIT in brain-dump.js (kept as a plain
    // number here, not a shared constant - same independent-per-file
    // convention this app already uses for other small cross-file numbers).
    function setMemoryCounts(total) {
        currentMemoryTotal = total;
        if (memoryManageCount) {
            memoryManageCount.textContent = total > 0 ? ` (${total})` : '';
        }
        if (memoryEmpty) {
            memoryEmpty.classList.toggle('hidden', total > 0);
        }
        if (memoryCount) {
            memoryCount.textContent = total > 0 ? `${total} saved (up to ${MEMORY_SOFT_LIMIT})` : '';
            memoryCount.classList.toggle('hidden', total === 0);
        }
    }

    async function saveDisplayName() {
        const trimmed = nameInput.value.trim();
        if (!trimmed || !currentUser) {
            return;
        }
        saveNameStatus.textContent = 'Saving...';
        try {
            const { doc, setDoc } = window.ToDoAuth.firestore;
            await setDoc(doc(window.ToDoAuth.db, 'users', currentUser.uid), { displayName: trimmed }, { merge: true });
            saveNameStatus.textContent = 'Saved.';
        } catch (error) {
            console.error('Failed to save display name:', error);
            saveNameStatus.textContent = 'Could not save. Try again.';
        }
    }

    async function exportTasks() {
        if (!currentUser) {
            return;
        }
        // Section F: every action gets a confirmed visible response, not
        // just a disabled-during-request state - this one had neither
        // before (no success message, and its error handler was clearing
        // .settingsDeleteStatus, an unrelated element from a different
        // section entirely, instead of showing anything here at all).
        const exportBtn = document.querySelector('.settingsExportBtn');
        if (exportBtn) {
            exportBtn.disabled = true;
        }
        if (exportStatus) {
            exportStatus.textContent = 'Exporting...';
            exportStatus.classList.remove('hidden');
        }
        try {
            const { collection, getDocs } = window.ToDoAuth.firestore;
            const [tasksSnapshot, memorySnapshot] = await Promise.all([
                getDocs(collection(window.ToDoAuth.db, 'users', currentUser.uid, 'tasks')),
                getDocs(collection(window.ToDoAuth.db, 'users', currentUser.uid, 'dustyMemory'))
            ]);
            const exportedTasks = tasksSnapshot.docs.map((taskDoc) => ({ id: taskDoc.id, ...taskDoc.data() }));
            const exportedMemories = memorySnapshot.docs.map((memoryDoc) => ({ id: memoryDoc.id, ...memoryDoc.data() }));
            const payload = {
                exportedAt: new Date().toISOString(),
                account: currentUser.email || currentUser.uid,
                taskCount: exportedTasks.length,
                tasks: exportedTasks,
                dustyMemory: exportedMemories
            };
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `todo-list-export-${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
            if (exportStatus) {
                exportStatus.textContent = `Downloaded (${exportedTasks.length} task${exportedTasks.length === 1 ? '' : 's'}).`;
            }
        } catch (error) {
            console.error('Failed to export tasks:', error);
            if (exportStatus) {
                exportStatus.textContent = 'Could not export. Try again.';
                exportStatus.classList.remove('hidden');
            }
        } finally {
            if (exportBtn) {
                exportBtn.disabled = false;
            }
        }
    }

    function resetDeleteArm() {
        deleteArmed = false;
        if (deleteBtn) {
            deleteBtn.textContent = 'Delete my account & data';
            deleteBtn.classList.remove('isArmed');
        }
        if (deleteStatus) {
            deleteStatus.textContent = '';
        }
    }

    function onDeleteClick() {
        if (!deleteArmed) {
            deleteArmed = true;
            deleteBtn.textContent = 'Click again to confirm - this can\'t be undone';
            deleteBtn.classList.add('isArmed');
            return;
        }
        deleteAccountAndData();
    }

    // Removes every group membership this account has (deletes groups it
    // owns entirely, since owners can't just leave - mirrors
    // deleteGroupCompletely/leaveGroup in group/groups-data.js), then the
    // account's own tasks and profile doc, then the Firebase Auth account
    // itself.
    async function deleteAccountAndData() {
        if (!currentUser) {
            return;
        }
        const uid = currentUser.uid;
        deleteBtn.disabled = true;
        deleteStatus.textContent = 'Deleting your data...';

        const { doc, getDoc, getDocs, collection, query, where, updateDoc, deleteDoc } = window.ToDoAuth.firestore;
        const db = window.ToDoAuth.db;

        try {
            const groupsSnapshot = await getDocs(query(collection(db, 'groups'), where('memberIds', 'array-contains', uid)));
            for (const groupDoc of groupsSnapshot.docs) {
                const group = groupDoc.data();
                if (group.ownerId === uid) {
                    const tasksSnapshot = await getDocs(collection(db, 'groups', groupDoc.id, 'tasks'));
                    await Promise.all(tasksSnapshot.docs.map((taskDoc) => deleteDoc(taskDoc.ref)));
                    const historySnapshot = await getDocs(collection(db, 'groups', groupDoc.id, 'history'));
                    await Promise.all(historySnapshot.docs.map((entryDoc) => deleteDoc(entryDoc.ref)));
                    await deleteDoc(groupDoc.ref);
                } else {
                    const memberIds = group.memberIds || [];
                    const memberNames = group.memberNames || [];
                    const myIndex = memberIds.indexOf(uid);
                    if (myIndex !== -1) {
                        await updateDoc(groupDoc.ref, {
                            memberIds: memberIds.filter((_, index) => index !== myIndex),
                            memberNames: memberNames.filter((_, index) => index !== myIndex)
                        });
                    }
                    // Own history entries in a group left behind - the rule
                    // lets each person delete only their own, matching what
                    // leaving normally leaves alone, but account deletion
                    // should still take a leaver's name/task text with it.
                    const ownHistorySnapshot = await getDocs(query(
                        collection(db, 'groups', groupDoc.id, 'history'),
                        where('ownerId', '==', uid)
                    ));
                    await Promise.all(ownHistorySnapshot.docs.map((entryDoc) => deleteDoc(entryDoc.ref)));
                }
            }

            const tasksSnapshot = await getDocs(collection(db, 'users', uid, 'tasks'));
            await Promise.all(tasksSnapshot.docs.map((taskDoc) => deleteDoc(taskDoc.ref)));

            // Firestore doesn't cascade-delete subcollections when the
            // parent doc goes - dustyMemory needs its own explicit pass,
            // same as tasks just above.
            const memorySnapshot = await getDocs(collection(db, 'users', uid, 'dustyMemory'));
            await Promise.all(memorySnapshot.docs.map((memoryDoc) => deleteDoc(memoryDoc.ref)));

            const profileRef = doc(db, 'users', uid);
            const profileSnapshot = await getDoc(profileRef);
            if (profileSnapshot.exists()) {
                await deleteDoc(profileRef);
            }
        } catch (error) {
            console.error('Failed to delete account data:', error);
            deleteStatus.textContent = 'Something went wrong deleting your data. Please try again.';
            deleteBtn.disabled = false;
            return;
        }

        try {
            await window.ToDoAuth.deleteAccountAuth();
            window.ToDoAuth.signOutUser?.();
            window.location.href = APP_ROOT_URL;
        } catch (error) {
            console.error('Failed to delete auth account:', error);
            if (error?.code === 'auth/requires-recent-login') {
                deleteStatus.textContent = 'Your data is deleted. For security, please sign out, sign back in, then click Delete once more to remove your login.';
                deleteBtn.disabled = false;
                resetDeleteArm();
            } else {
                deleteStatus.textContent = 'Your data is deleted, but signing out your login failed. Please sign out manually.';
                window.ToDoAuth.signOutUser?.();
                window.location.href = APP_ROOT_URL;
            }
        }
    }

    function init() {
        injectStyles();
        injectTrigger();
        // Built eagerly, not lazily on first open, since .alertToggleBtn/
        // .difficultyVisibilityToggle (solo only - both null on group pages)
        // get reparented into it below and neither starts hidden in its old
        // sideColumn spot - waiting for a lazy first-open would leave them
        // visible in the old location the whole time until Settings was
        // opened once. Same fix as group.js's initializeGroupSettingsModal.
        overlay = buildOverlay();

        window.ToDoAuth.onAuthChange((user) => {
            currentUser = user;
            if (!user) {
                closeOverlay();
            }
        });
    }

    if (window.ToDoAuth) {
        init();
    } else {
        window.addEventListener('todoauth:ready', init, { once: true });
    }
})();
