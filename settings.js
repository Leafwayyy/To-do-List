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

    let currentUser = null;
    let overlay = null;
    let nameInput = null;
    let emailText = null;
    let saveNameStatus = null;
    let muteToggle = null;
    let deleteBtn = null;
    let deleteStatus = null;
    let deleteArmed = false;

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
                background: #10141f;
                border: 1px solid rgba(216, 183, 120, 0.32);
                border-radius: 16px;
                color: #f3f0ea;
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
                color: #f3f0ea;
                font-size: 1.4rem;
                cursor: pointer;
                line-height: 1;
                padding: 4px 8px;
            }
            .settingsSection {
                border-top: 1px solid rgba(216, 183, 120, 0.18);
                padding: 16px 0;
            }
            .settingsSection:first-of-type { border-top: none; }
            .settingsSection h3 {
                margin: 0 0 8px;
                font-size: 0.95rem;
                color: #d7b778;
                text-transform: uppercase;
                letter-spacing: 0.04em;
            }
            .settingsHint { margin: 0 0 10px; font-size: 0.88rem; color: rgba(243, 240, 234, 0.65); }
            .settingsEmail { margin: 0 0 12px; font-size: 0.9rem; color: rgba(243, 240, 234, 0.75); }
            .settingsFieldLabel { display: block; font-size: 0.82rem; margin-bottom: 6px; color: rgba(243, 240, 234, 0.7); }
            .settingsInlineRow { display: flex; gap: 8px; }
            .settingsNameInput {
                flex: 1;
                background: rgba(255, 255, 255, 0.06);
                border: 1px solid rgba(216, 183, 120, 0.28);
                border-radius: 8px;
                color: #f3f0ea;
                padding: 8px 10px;
                font: inherit;
            }
            .settingsSaveNameBtn, .settingsSignOutBtn, .settingsExportBtn, .settingsLinkBtn, .settingsDeleteBtn {
                background: rgba(216, 183, 120, 0.14);
                border: 1px solid rgba(216, 183, 120, 0.4);
                color: #f3f0ea;
                border-radius: 8px;
                padding: 8px 14px;
                font: inherit;
                font-size: 0.88rem;
                cursor: pointer;
                text-decoration: none;
                display: inline-block;
            }
            .settingsSignOutBtn { margin-top: 12px; }
            .settingsSaveNameStatus, .settingsDeleteStatus { min-height: 1.1em; font-size: 0.82rem; color: #8ec5ff; margin: 8px 0 0; }
            .settingsToggleRow { display: flex; align-items: center; gap: 10px; font-size: 0.92rem; cursor: pointer; }
            .settingsDangerSection h3 { color: #e08a8a; }
            .settingsDeleteBtn { background: rgba(224, 90, 90, 0.14); border-color: rgba(224, 90, 90, 0.5); }
            .settingsDeleteBtn.isArmed { background: rgba(224, 90, 90, 0.32); }
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

                <section class="settingsSection">
                    <h3>Your data</h3>
                    <p class="settingsHint">Download everything you've added as a JSON file.</p>
                    <button type="button" class="settingsExportBtn">Export my tasks</button>
                </section>

                <section class="settingsSection">
                    <h3>Groups</h3>
                    <p class="settingsHint">Manage, leave, or delete groups you belong to.</p>
                    <a class="settingsLinkBtn" href="/group/browse.html">Manage my groups</a>
                </section>

                <section class="settingsSection">
                    <h3>Privacy &amp; legal</h3>
                    <p class="settingsHint"><a href="/privacy.html">Privacy Policy</a> &middot; <a href="/terms.html">Terms of Service</a></p>
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

        emailText = node.querySelector('.settingsEmail');
        nameInput = node.querySelector('.settingsNameInput');
        saveNameStatus = node.querySelector('.settingsSaveNameStatus');
        muteToggle = node.querySelector('.settingsMuteToggle');
        deleteBtn = node.querySelector('.settingsDeleteBtn');
        deleteStatus = node.querySelector('.settingsDeleteStatus');

        muteToggle.addEventListener('change', () => {
            try {
                localStorage.setItem(SOUND_MUTED_KEY, muteToggle.checked ? 'true' : 'false');
            } catch (error) {
                console.error('Could not save sound setting:', error);
            }
        });

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
        if (event.key === 'Escape') {
            closeOverlay();
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
        try {
            const { collection, getDocs } = window.ToDoAuth.firestore;
            const snapshot = await getDocs(collection(window.ToDoAuth.db, 'users', currentUser.uid, 'tasks'));
            const exportedTasks = snapshot.docs.map((taskDoc) => ({ id: taskDoc.id, ...taskDoc.data() }));
            const payload = {
                exportedAt: new Date().toISOString(),
                account: currentUser.email || currentUser.uid,
                taskCount: exportedTasks.length,
                tasks: exportedTasks
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
        } catch (error) {
            console.error('Failed to export tasks:', error);
            deleteStatus.textContent = '';
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
                }
            }

            const tasksSnapshot = await getDocs(collection(db, 'users', uid, 'tasks'));
            await Promise.all(tasksSnapshot.docs.map((taskDoc) => deleteDoc(taskDoc.ref)));

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
            window.location.href = '/';
        } catch (error) {
            console.error('Failed to delete auth account:', error);
            if (error?.code === 'auth/requires-recent-login') {
                deleteStatus.textContent = 'Your data is deleted. For security, please sign out, sign back in, then click Delete once more to remove your login.';
                deleteBtn.disabled = false;
                resetDeleteArm();
            } else {
                deleteStatus.textContent = 'Your data is deleted, but signing out your login failed. Please sign out manually.';
                window.ToDoAuth.signOutUser?.();
                window.location.href = '/';
            }
        }
    }

    function init() {
        injectStyles();
        injectTrigger();

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
