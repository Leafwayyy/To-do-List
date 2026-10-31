// Notification center: a permanent bell in the header (solo AND groups) that lists what is
// going on - tasks assigned to you, declines, comments, @mentions, and reminders for tasks
// that are due soon or overdue - with an unread count, filters and "mark all as read".
//
// Two kinds of item:
//  - STORED notifications live at users/{uid}/notifications/{id}. Other people write them
//    (see NotificationCenter.notify) when something happens that concerns you; only YOU can
//    read, mark read or delete them (firestore.rules). Their `actorId` must be the real
//    sender, so nobody can pose as a teammate, and a stranger who shares no group with you
//    can't send you any.
//  - REMINDERS are computed from your own tasks every time the panel opens (the page gives us
//    a source with setReminderSource), so they are never stored and never pile up.
//
// Also here: TodoAlerts, the one place that knows whether desktop ("popup") alerts are wanted.
// They are ON by default for everybody and only off if the person turns them off. A browser
// won't let a site switch notifications on by itself, so we ask once, politely, with a button.
//
// Classic script, loaded on both the solo page and the group dashboard (before script.js /
// group.js, which call into it at run time). All text is rendered with textContent.

const TodoAlerts = (() => {
    const OFF_KEY = 'todoAlertsOff';
    const ASKED_KEY = 'todoAlertsAskedAt';
    const ASK_AGAIN_MS = 7 * 24 * 60 * 60 * 1000;

    const supported = () => typeof Notification !== 'undefined';
    const granted = () => supported() && Notification.permission === 'granted';

    function wanted() {
        try {
            return localStorage.getItem(OFF_KEY) !== '1';
        } catch {
            return true;
        }
    }

    function setWanted(on) {
        try {
            if (on) {
                localStorage.removeItem(OFF_KEY);
            } else {
                localStorage.setItem(OFF_KEY, '1');
            }
        } catch {
            // Non-fatal: the choice just won't be remembered.
        }
    }

    // Alerts will actually pop up right now.
    const active = () => wanted() && granted();

    function snoozedAsking() {
        try {
            const asked = Number(localStorage.getItem(ASKED_KEY)) || 0;
            return Date.now() - asked < ASK_AGAIN_MS;
        } catch {
            return false;
        }
    }

    function markAsked() {
        try {
            localStorage.setItem(ASKED_KEY, String(Date.now()));
        } catch {
            // Non-fatal.
        }
    }

    function shouldAsk() {
        return supported() && wanted() && Notification.permission === 'default' && !snoozedAsking();
    }

    // Must be called from a click (browsers ignore it otherwise).
    async function askPermission() {
        if (!supported()) {
            return false;
        }
        const result = await Notification.requestPermission();
        if (result === 'granted') {
            setWanted(true);
            window.dispatchEvent(new CustomEvent('todo-alerts-changed'));
        }
        return result === 'granted';
    }

    return { supported, granted, wanted, setWanted, active, shouldAsk, markAsked, askPermission };
})();

const NotificationCenter = (() => {
    const MAX_LOADED = 50;
    const KEEP_DAYS = 30;
    const MAX_REMINDERS = 20;

    // type -> icon + which filter it belongs under
    const TYPES = {
        assigned: { icon: 'fa-user-check', cat: 'tasks' },
        declined: { icon: 'fa-ban', cat: 'tasks' },
        suggestion: { icon: 'fa-lightbulb', cat: 'tasks' },
        review: { icon: 'fa-clipboard-check', cat: 'tasks' },
        status: { icon: 'fa-flag', cat: 'tasks' },
        comment: { icon: 'fa-comment', cat: 'comments' },
        mention: { icon: 'fa-at', cat: 'comments' },
        report: { icon: 'fa-chart-line', cat: 'team' },
        info: { icon: 'fa-circle-info', cat: 'team' }
    };
    const FILTERS = [
        ['all', 'All'],
        ['tasks', 'Tasks'],
        ['comments', 'Comments'],
        ['reminders', 'Reminders']
    ];
    const LEVEL_ICON = { overdue: 'fa-triangle-exclamation', critical: 'fa-fire', soon: 'fa-clock' };
    const LEVEL_RANK = { overdue: 0, critical: 1, soon: 2 };

    let items = [];
    let unsubscribe = null;
    let subscribedUid = null;
    let firstSnapshot = true;
    let button = null;
    let badge = null;
    let panel = null;
    let panelTimer = null;
    let activeFilter = 'all';
    let reminderSource = null;
    let scopeIdSource = null;
    // Your open tasks everywhere (personal list + every group), so the bell is the same on
    // every page. The page you are on is read live; the rest comes from here.
    const MAX_GROUPS_SCANNED = 15;
    const SCOPE_REFRESH_MS = 5 * 60 * 1000;
    let otherScopes = [];
    let scopesFetchedAt = 0;
    let scopesFetching = false;
    let scopesUid = null;
    let lastUid = null;
    let signedInSince = 0;
    let askToast = null;

    const currentUser = () => window.ToDoAuth?.auth?.currentUser || null;
    const fsx = () => window.ToDoAuth?.firestore || null;
    const database = () => window.ToDoAuth?.db || null;

    const clip = (value, max) => String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim().slice(0, max);

    // ---- sending -----------------------------------------------------------

    // Tells another person something happened. Never to yourself, never throws: a failed
    // notification must not break the action that caused it.
    async function send({ toUid, type, title, body, detail, groupId, groupName, taskId, actorName }, allowSelf) {
        const user = currentUser();
        const f = fsx();
        const db = database();
        if (!user || !f || !db || !toUid || (toUid === user.uid && !allowSelf) || !TYPES[type]) {
            return false;
        }
        const cleanTitle = clip(title, 140);
        if (!cleanTitle) {
            return false;
        }
        const data = {
            type,
            title: cleanTitle,
            actorId: user.uid,
            actorName: clip(actorName || user.displayName || (user.email || '').split('@')[0] || 'Someone', 80),
            createdAt: f.serverTimestamp(),
            readAt: null
        };
        if (body) {
            data.body = clip(body, 400);
        }
        // Longer, multi-line text that only the email shows (the weekly report's full table).
        if (detail) {
            data.detail = String(detail).slice(0, 1500);
        }
        if (groupId) {
            data.groupId = clip(groupId, 100);
        }
        if (groupName) {
            data.groupName = clip(groupName, 80);
        }
        if (taskId) {
            data.taskId = clip(taskId, 100);
        }
        try {
            await f.setDoc(f.doc(f.collection(db, 'users', toUid, 'notifications')), data);
            return true;
        } catch (error) {
            console.warn('Could not send a notification:', error);
            return false;
        }
    }

    const notify = (details) => send(details, false);

    // A note to yourself (the weekly report is one). Only ever lands in your own inbox.
    function notifySelf(details) {
        const user = currentUser();
        return user ? send({ ...details, toUid: user.uid }, true) : Promise.resolve(false);
    }

    function notifyMany(toUids, details) {
        const unique = Array.from(new Set(toUids || []));
        return Promise.all(unique.map((toUid) => notify({ ...details, toUid })));
    }

    // ---- listening ---------------------------------------------------------

    function normalize(snap) {
        const data = snap.data();
        const created = data.createdAt && typeof data.createdAt.toMillis === 'function' ? data.createdAt.toMillis() : Date.now();
        return {
            id: snap.id,
            type: TYPES[data.type] ? data.type : 'info',
            title: clip(data.title, 140),
            body: clip(data.body, 400),
            actorName: clip(data.actorName, 80),
            groupId: typeof data.groupId === 'string' ? data.groupId : '',
            groupName: clip(data.groupName, 80),
            taskId: typeof data.taskId === 'string' ? data.taskId : '',
            createdAt: created,
            read: Boolean(data.readAt)
        };
    }

    function stopListening() {
        unsubscribe?.();
        unsubscribe = null;
        subscribedUid = null;
        items = [];
        refreshBadge();
    }

    function startListening(user) {
        const f = fsx();
        const db = database();
        if (!f || !db) {
            return false;
        }
        stopListening();
        subscribedUid = user.uid;
        firstSnapshot = true;
        const q = f.query(
            f.collection(db, 'users', user.uid, 'notifications'),
            f.orderBy('createdAt', 'desc'),
            f.limit(MAX_LOADED)
        );
        unsubscribe = f.onSnapshot(q, (snapshot) => {
            items = snapshot.docs.map(normalize);
            if (!firstSnapshot) {
                snapshot.docChanges().forEach((change) => {
                    if (change.type === 'added' && !change.doc.metadata.hasPendingWrites) {
                        popup(normalize(change.doc));
                    }
                });
            }
            firstSnapshot = false;
            refreshBadge();
            if (panel) {
                renderPanel();
            }
            pruneOld();
        }, (error) => {
            console.warn('Notifications unavailable:', error);
        });
        return true;
    }

    // A desktop popup for something new, only while you're not looking at the page (a bell
    // badge is enough when you are).
    function popup(item) {
        if (item.read || !TodoAlerts.active() || !document.hidden) {
            return;
        }
        try {
            const popupNote = new Notification(item.title, { body: item.body || undefined, tag: 'todo-' + item.id });
            popupNote.onclick = () => {
                window.focus();
                popupNote.close();
            };
        } catch {
            // Some browsers only allow notifications from a service worker - the bell still works.
        }
    }

    // Old ones tidy themselves away so the list never grows without limit.
    function pruneOld() {
        const f = fsx();
        const db = database();
        const user = currentUser();
        if (!f || !db || !user) {
            return;
        }
        const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
        const old = items.filter((item) => item.createdAt < cutoff);
        if (old.length === 0) {
            return;
        }
        const batch = f.writeBatch(db);
        old.forEach((item) => batch.delete(f.doc(db, 'users', user.uid, 'notifications', item.id)));
        batch.commit().catch(() => {});
    }

    // ---- marking read --------------------------------------------------------

    function unreadItems() {
        return items.filter((item) => !item.read);
    }

    async function markRead(item) {
        const f = fsx();
        const db = database();
        const user = currentUser();
        if (!f || !db || !user || item.read) {
            return;
        }
        item.read = true;
        refreshBadge();
        try {
            await f.updateDoc(f.doc(db, 'users', user.uid, 'notifications', item.id), { readAt: f.serverTimestamp() });
        } catch (error) {
            console.warn('Could not mark a notification as read:', error);
        }
    }

    async function markAllRead() {
        const f = fsx();
        const db = database();
        const user = currentUser();
        const unread = unreadItems();
        if (!f || !db || !user || unread.length === 0) {
            return;
        }
        unread.forEach((item) => { item.read = true; });
        refreshBadge();
        renderPanel();
        try {
            const batch = f.writeBatch(db);
            unread.forEach((item) => batch.update(f.doc(db, 'users', user.uid, 'notifications', item.id), { readAt: f.serverTimestamp() }));
            await batch.commit();
        } catch (error) {
            console.warn('Could not mark notifications as read:', error);
        }
    }

    // ---- the bell ----------------------------------------------------------

    function ensureButton() {
        if (button && document.body.contains(button)) {
            return;
        }
        const anchor = document.querySelector('.userBadge .groupNavLink') || document.querySelector('.userBadge .helpTourBtn');
        if (!anchor || !anchor.parentElement) {
            return;
        }
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'notifBtn';
        button.title = 'Notifications';
        button.setAttribute('aria-haspopup', 'dialog');
        button.setAttribute('aria-expanded', 'false');
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-bell';
        icon.setAttribute('aria-hidden', 'true');
        badge = document.createElement('span');
        badge.className = 'notifBadge';
        badge.setAttribute('aria-hidden', 'true');
        button.append(icon, badge);
        button.addEventListener('click', () => (panel ? closePanel(true) : openPanel()));
        anchor.before(button);
        refreshBadge();
    }

    function refreshBadge() {
        if (!button || !badge) {
            return;
        }
        const count = unreadItems().length;
        badge.textContent = count > 99 ? '99+' : String(count);
        button.classList.toggle('hasUnread', count > 0);
        button.setAttribute('aria-label', count > 0 ? `Notifications (${count} unread)` : 'Notifications');
    }

    // ---- the panel ---------------------------------------------------------

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) {
            node.className = className;
        }
        if (text !== undefined) {
            node.textContent = text;
        }
        return node;
    }

    function timeAgo(ms) {
        const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
        if (seconds < 60) {
            return 'just now';
        }
        const minutes = Math.round(seconds / 60);
        if (minutes < 60) {
            return minutes + 'm';
        }
        const hours = Math.round(minutes / 60);
        if (hours < 24) {
            return hours + 'h';
        }
        const days = Math.round(hours / 24);
        return days < 30 ? days + 'd' : Math.round(days / 30) + 'mo';
    }

    // Which list this page is showing: 'solo', or a group's id.
    function currentScopeId() {
        try {
            const id = typeof scopeIdSource === 'function' ? scopeIdSource() : null;
            return id || (/\/group\//.test(window.location.pathname) ? new URLSearchParams(window.location.search).get('g') : 'solo');
        } catch {
            return 'solo';
        }
    }

    // Turns one scope's tasks (read from the database) into reminder entries. Urgency is worked
    // out now, from the task's dates, so a cached task never shows an old countdown.
    function remindersFromScope(scope) {
        if (typeof getTaskUrgencyStatus !== 'function') {
            return [];
        }
        const out = [];
        scope.tasks.forEach((task) => {
            if (!task || !task.id || task.completed || task.status === 'blocked' || task.status === 'review') {
                return;
            }
            let status;
            try {
                status = getTaskUrgencyStatus(task);
            } catch {
                return;
            }
            if (!status || !status.hasDeadline || LEVEL_RANK[status.urgencyLevel] === undefined) {
                return;
            }
            out.push({
                key: scope.scope + ':' + task.id,
                text: task.text,
                level: status.urgencyLevel,
                label: status.countdownLabel,
                where: scope.where,
                timestamp: status.deadlineTimestamp,
                scope: scope.scope,
                groupId: scope.groupId,
                taskId: task.id
            });
        });
        return out;
    }

    function getReminders() {
        const mine = currentScopeId();
        let live = [];
        if (typeof reminderSource === 'function') {
            try {
                live = (reminderSource() || []).map((entry) => (entry ? { scope: mine, ...entry } : entry));
            } catch (error) {
                console.warn('Could not build reminders:', error);
            }
        }
        const elsewhere = otherScopes.filter((scope) => scope.scope !== mine).flatMap(remindersFromScope);
        return live.concat(elsewhere)
            .filter((entry) => entry && LEVEL_RANK[entry.level] !== undefined)
            .sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || (a.timestamp || 0) - (b.timestamp || 0))
            .slice(0, MAX_REMINDERS);
    }

    // Reads your personal tasks and your own tasks in each group you belong to. Cheap (a handful
    // of small reads), cached for five minutes, and failures are quiet: the bell still works.
    async function refreshScopes(force) {
        const user = currentUser();
        const f = fsx();
        const db = database();
        if (!user || !f || !db || scopesFetching) {
            return;
        }
        if (scopesUid !== user.uid) {
            scopesUid = user.uid;
            otherScopes = [];
            scopesFetchedAt = 0;
        }
        if (!force && Date.now() - scopesFetchedAt < SCOPE_REFRESH_MS) {
            return;
        }
        scopesFetching = true;
        try {
            const found = [];
            const soloSnap = await f.getDocs(f.collection(db, 'users', user.uid, 'tasks'));
            found.push({ scope: 'solo', groupId: null, where: 'Personal', tasks: soloSnap.docs.map((d) => ({ ...d.data(), id: d.id })) });
            const groupsSnap = await f.getDocs(f.query(f.collection(db, 'groups'), f.where('memberIds', 'array-contains', user.uid)));
            for (const groupDoc of groupsSnap.docs.slice(0, MAX_GROUPS_SCANNED)) {
                try {
                    const taskSnap = await f.getDocs(f.query(f.collection(db, 'groups', groupDoc.id, 'tasks'), f.where('ownerId', '==', user.uid)));
                    found.push({ scope: groupDoc.id, groupId: groupDoc.id, where: clip(groupDoc.data().name, 60) || 'Group', tasks: taskSnap.docs.map((d) => ({ ...d.data(), id: d.id })) });
                } catch (error) {
                    console.warn('Could not read tasks for a group reminder:', error?.code || error);
                }
            }
            if (currentUser() && currentUser().uid === user.uid) {
                otherScopes = found;
                scopesFetchedAt = Date.now();
                if (panel) {
                    renderPanel();
                }
            }
        } catch (error) {
            console.warn('Could not load reminders from your other lists:', error?.code || error);
            scopesFetchedAt = Date.now() - SCOPE_REFRESH_MS + 60000;
        } finally {
            scopesFetching = false;
        }
    }

    // A small "where is this from" label: Personal, or the group's name.
    function sourceChip(where, isGroup) {
        const chip = el('span', 'notifSource' + (isGroup ? ' isGroup' : ' isPersonal'));
        chip.appendChild(el('i', 'fa-solid ' + (isGroup ? 'fa-people-group' : 'fa-user')));
        chip.appendChild(document.createTextNode(' ' + where));
        return chip;
    }

    // Scrolls to a task on this page and flashes it. False if it isn't on screen (yet).
    function focusTask(taskId) {
        const target = Array.from(document.querySelectorAll('[data-task-id]')).find((node) => node.dataset.taskId === taskId);
        if (!target) {
            return false;
        }
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('todayFlash');
        setTimeout(() => target.classList.remove('todayFlash'), 1800);
        return true;
    }

    // The address of the place something is about: a group's page (or your personal list) with
    // the task named. Null when you are already there.
    function targetUrl(groupId, taskId) {
        const onGroupPage = /\/group\//.test(window.location.pathname);
        const target = groupId || 'solo';
        if (currentScopeId() === target && (groupId ? onGroupPage : !onGroupPage)) {
            return null;
        }
        const taskPart = taskId ? (groupId ? '&' : '?') + 'task=' + encodeURIComponent(taskId) : '';
        if (groupId) {
            return (onGroupPage ? 'index.html' : 'group/index.html') + '?g=' + encodeURIComponent(groupId) + taskPart;
        }
        return (onGroupPage ? '../app.html' : 'app.html') + taskPart;
    }

    // Takes you there. Same page: it just scrolls to the task.
    function goTo(groupId, taskId) {
        const url = targetUrl(groupId, taskId);
        if (url === null) {
            if (taskId) {
                focusTask(taskId);
            }
            return;
        }
        window.location.href = url;
    }

    // Arriving from a bell click: wait for the list to draw (it loads from the database), then
    // jump to the task named in the address.
    function focusFromUrl() {
        const params = new URLSearchParams(window.location.search);
        const taskId = params.get('task');
        if (!taskId) {
            return;
        }
        let tries = 0;
        const timer = setInterval(() => {
            tries += 1;
            if (focusTask(taskId) || tries > 40) {
                clearInterval(timer);
                params.delete('task');
                const rest = params.toString();
                try {
                    window.history.replaceState(null, '', window.location.pathname + (rest ? '?' + rest : '') + window.location.hash);
                } catch {
                    // Non-fatal.
                }
            }
        }, 400);
    }

    function reminderRow(entry) {
        const row = el('button', 'notifItem notifReminder level-' + entry.level);
        row.type = 'button';
        const icon = el('span', 'notifIcon');
        icon.setAttribute('aria-hidden', 'true');
        const glyph = el('i', 'fa-solid ' + LEVEL_ICON[entry.level]);
        icon.appendChild(glyph);
        const body = el('div', 'notifBody');
        body.appendChild(el('p', 'notifTitle', entry.text));
        body.appendChild(el('p', 'notifText', entry.label));
        const isGroup = Boolean(entry.groupId);
        body.appendChild(sourceChip(entry.where || (isGroup ? 'Group' : 'Personal'), isGroup));
        row.append(icon, body);
        row.addEventListener('click', () => {
            closePanel(false);
            goTo(entry.groupId || null, entry.taskId);
        });
        return row;
    }

    function itemRow(item) {
        const row = el('button', 'notifItem' + (item.read ? '' : ' unread'));
        row.type = 'button';
        const icon = el('span', 'notifIcon');
        icon.setAttribute('aria-hidden', 'true');
        icon.appendChild(el('i', 'fa-solid ' + TYPES[item.type].icon));
        const body = el('div', 'notifBody');
        body.appendChild(el('p', 'notifTitle', item.title));
        if (item.body) {
            body.appendChild(el('p', 'notifText', item.body));
        }
        const metaLine = el('p', 'notifMeta', timeAgo(item.createdAt));
        if (item.groupName) {
            metaLine.appendChild(document.createTextNode(' · '));
            metaLine.appendChild(sourceChip(item.groupName, true));
        }
        body.appendChild(metaLine);
        row.append(icon, body);
        if (!item.read) {
            const dot = el('span', 'notifDot');
            dot.setAttribute('aria-label', 'Unread');
            row.appendChild(dot);
        }
        row.addEventListener('click', () => openItem(item));
        return row;
    }

    function openItem(item) {
        markRead(item);
        closePanel(false);
        if (!item.groupId) {
            return;
        }
        goTo(item.groupId, item.taskId || null);
    }

    function renderPanel() {
        if (!panel) {
            return;
        }
        const scrollTop = panel.querySelector('.notifList')?.scrollTop || 0;
        panel.textContent = '';

        const head = el('div', 'notifHead');
        head.appendChild(el('h2', 'notifHeading', 'Notifications'));
        const markAll = el('button', 'notifMarkAll', 'Mark all as read');
        markAll.type = 'button';
        markAll.disabled = unreadItems().length === 0;
        markAll.addEventListener('click', markAllRead);
        head.appendChild(markAll);
        panel.appendChild(head);

        const tabs = el('div', 'notifTabs');
        tabs.setAttribute('role', 'tablist');
        FILTERS.forEach(([value, label]) => {
            const tab = el('button', 'notifTab' + (value === activeFilter ? ' active' : ''), label);
            tab.type = 'button';
            tab.setAttribute('role', 'tab');
            tab.setAttribute('aria-selected', String(value === activeFilter));
            tab.addEventListener('click', () => {
                activeFilter = value;
                renderPanel();
            });
            tabs.appendChild(tab);
        });
        panel.appendChild(tabs);

        if (TodoAlerts.supported() && TodoAlerts.wanted() && Notification.permission === 'default') {
            const ask = el('div', 'notifAsk');
            ask.appendChild(el('span', null, 'Get a desktop alert when something is assigned to you or due.'));
            const allow = el('button', 'notifAskBtn', 'Turn on');
            allow.type = 'button';
            allow.addEventListener('click', () => {
                TodoAlerts.markAsked();
                TodoAlerts.askPermission().then(renderPanel);
            });
            ask.appendChild(allow);
            panel.appendChild(ask);
        }

        const list = el('div', 'notifList');
        const showReminders = activeFilter === 'all' || activeFilter === 'reminders';
        const reminders = showReminders ? getReminders() : [];
        const stored = activeFilter === 'reminders' ? [] : items.filter((item) => activeFilter === 'all' || TYPES[item.type].cat === activeFilter);

        if (reminders.length > 0) {
            list.appendChild(el('p', 'notifSection', 'Needs your attention'));
            reminders.forEach((entry) => list.appendChild(reminderRow(entry)));
        }
        if (stored.length > 0) {
            if (reminders.length > 0) {
                list.appendChild(el('p', 'notifSection', 'Recent'));
            }
            stored.forEach((item) => list.appendChild(itemRow(item)));
        }
        if (reminders.length === 0 && stored.length === 0) {
            list.appendChild(el('p', 'notifEmpty', activeFilter === 'reminders'
                ? 'Nothing is due soon. Nice.'
                : 'You\'re all caught up. Assignments, comments and reminders will show up here.'));
        }
        panel.appendChild(list);
        list.scrollTop = scrollTop;
    }

    function placePanel() {
        if (!panel || !button) {
            return;
        }
        const rect = button.getBoundingClientRect();
        const width = Math.min(420, window.innerWidth - 16);
        panel.style.width = width + 'px';
        panel.style.top = rect.bottom + 8 + 'px';
        panel.style.left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)) + 'px';
        panel.style.maxHeight = Math.max(240, window.innerHeight - rect.bottom - 20) + 'px';
    }

    function onOutside(event) {
        if (panel && !panel.contains(event.target) && !button.contains(event.target)) {
            closePanel(false);
        }
    }

    function onKey(event) {
        if (event.key === 'Escape') {
            event.stopPropagation();
            closePanel(true);
        }
    }

    function openPanel() {
        if (panel || !button) {
            return;
        }
        panel = el('div', 'notifPanel');
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'Notifications');
        document.body.appendChild(panel);
        button.setAttribute('aria-expanded', 'true');
        renderPanel();
        placePanel();
        refreshScopes(false);
        document.addEventListener('pointerdown', onOutside, true);
        document.addEventListener('keydown', onKey, true);
        window.addEventListener('resize', placePanel);
        // Reminders and "5m ago" go stale while it sits open.
        panelTimer = setInterval(renderPanel, 30000);
    }

    function closePanel(returnFocus) {
        if (!panel) {
            return;
        }
        panel.remove();
        panel = null;
        clearInterval(panelTimer);
        panelTimer = null;
        document.removeEventListener('pointerdown', onOutside, true);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('resize', placePanel);
        button?.setAttribute('aria-expanded', 'false');
        if (returnFocus) {
            button?.focus();
        }
    }

    // ---- asking for desktop alerts -------------------------------------------

    function anotherDialogIsOpen() {
        return Boolean(document.querySelector(
            '.tourOverlay:not(.hidden), .groupWelcomeOverlay:not(.hidden), .weeklyRecapOverlay:not(.hidden), '
            + '.rewardOverlay:not(.hidden), .taskEditorOverlay.open, .folderManagerOverlay, .whatsNewOverlay'
        ));
    }

    function closeAskToast() {
        askToast?.remove();
        askToast = null;
    }

    // One polite, dismissible ask (never a blocking dialog). "Not now" is remembered for a week.
    function maybeAsk() {
        if (askToast || !TodoAlerts.shouldAsk() || !signedInSince || Date.now() - signedInSince < 8000 || anotherDialogIsOpen()) {
            return;
        }
        askToast = el('div', 'alertsAskToast');
        askToast.setAttribute('role', 'status');
        const text = el('div', 'alertsAskText');
        text.appendChild(el('strong', null, 'Turn on alerts?'));
        text.appendChild(el('span', null, 'We\'ll nudge you when a task is assigned to you or about to be due, even if this tab is in the background.'));
        const actions = el('div', 'alertsAskActions');
        const yes = el('button', 'alertsAskYes', 'Turn on');
        yes.type = 'button';
        yes.addEventListener('click', () => {
            TodoAlerts.markAsked();
            closeAskToast();
            TodoAlerts.askPermission();
        });
        const no = el('button', 'alertsAskNo', 'Not now');
        no.type = 'button';
        no.addEventListener('click', () => {
            TodoAlerts.markAsked();
            closeAskToast();
        });
        actions.append(yes, no);
        askToast.append(text, actions);
        document.body.appendChild(askToast);
    }

    // ---- wiring ------------------------------------------------------------

    function watch() {
        ensureButton();
        const user = currentUser();
        const uid = user ? user.uid : null;
        if (uid && !document.body.classList.contains('authGateActive')) {
            if (uid !== lastUid) {
                lastUid = uid;
                signedInSince = Date.now();
            }
            if (subscribedUid !== uid) {
                startListening(user);
                setTimeout(() => refreshScopes(true), 2500);
            }
            maybeAsk();
        } else if (!uid) {
            if (lastUid) {
                closePanel(false);
                closeAskToast();
                stopListening();
            }
            lastUid = null;
            signedInSince = 0;
        }
    }

    // `fn()` returns [{ key, text, level: 'overdue'|'critical'|'soon', label, where?, timestamp }].
    // `scopeFn()` says which list this page is showing ('solo' or a group's id) so those tasks
    // are read live, and every other list comes from the database.
    function setReminderSource(fn, scopeFn) {
        reminderSource = typeof fn === 'function' ? fn : null;
        scopeIdSource = typeof scopeFn === 'function' ? scopeFn : null;
    }

    setInterval(watch, 1500);
    setInterval(() => {
        if (currentUser() && !document.hidden) {
            refreshScopes(false);
        }
    }, 60000);
    watch();
    focusFromUrl();

    return { notify, notifySelf, notifyMany, setReminderSource, targetUrl, refreshScopes, open: openPanel, close: closePanel, unreadCount: () => unreadItems().length, markAllRead, items: () => items.slice() };
})();

// Also reachable as window.* for callers that prefer optional chaining.
window.TodoAlerts = TodoAlerts;
window.NotificationCenter = NotificationCenter;
