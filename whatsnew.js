// "What's new" - a short patch-notes popup the first time someone opens the app
// after an update, plus a button in the header to read every past update.
//
// TO ANNOUNCE AN UPDATE: add ONE entry at the TOP of WHATS_NEW_RELEASES below
// (newest first) with a new unique `id`, then bump the ?v= on the whatsnew.js
// script tags so browsers fetch the new list. That's all - the popup shows once
// per person per new id.
//
// Write entries like patch notes in a game: plain words, what you can DO now,
// one short line each. Keep an update to ~3-6 items; anything bigger is a
// sign it should be two updates.
//
// Rules this follows:
//  - Shown once per update per account (remembered on this device only).
//  - Never shown to a brand-new account: they're getting the tutorial instead,
//    so the current update is quietly marked as seen for them.
//  - Never opens on top of the tutorial, the weekly recap, or another dialog;
//    it waits (a few tries) and then gives up until next visit.
//  - All text here is static, written by us, and rendered with textContent.
//
// Classic script, loaded on both the solo page and the group dashboard.

const WHATS_NEW_RELEASES = [
    {
        id: '2026-10-30',
        date: 'October 30, 2026',
        title: 'Folders, faster adding, and teamwork tools',
        items: [
            {
                icon: 'fa-folder',
                title: 'Folders',
                text: 'Sort your tasks into colored folders like School or Work. Got a big pile? Tap "Sort into folders" to file a whole bunch at once.'
            },
            {
                icon: 'fa-bolt',
                title: 'Add tasks faster',
                text: 'Tap the / button (or type /) to set a due date, folder or priority. Press N to jump to the task box from anywhere.'
            },
            {
                icon: 'fa-wand-magic-sparkles',
                title: 'Smart suggestions',
                text: 'Type something like "every friday" or a folder name and a chip pops up. Nothing changes until you tap it.'
            },
            {
                icon: 'fa-id-badge',
                title: 'Teams: roles and folders',
                text: 'Group owners and admins can make folders and job roles, and group the list by person, role or folder.'
            },
            {
                icon: 'fa-user-check',
                title: 'Assign tasks to people',
                text: 'In a group, owners and admins can put a task straight onto someone\'s list, or everyone\'s. You get 15 minutes to decline one you don\'t want.'
            },
            {
                icon: 'fa-people-group',
                title: 'One card for shared tasks',
                text: 'When a task goes to several people it shows up once, with who has finished it, instead of piling up copies.'
            },
            {
                icon: 'fa-shield-halved',
                title: 'Safer Dusty',
                text: 'Dusty now asks "Remember this?" before saving anything you didn\'t say yourself.'
            }
        ]
    }
];

const WhatsNew = (() => {
    const SEEN_PREFIX = 'whatsNewSeen:';
    const NEW_ACCOUNT_MS = 24 * 60 * 60 * 1000;
    const MAX_RETRIES = 8;
    let overlay = null;
    let returnFocusTo = null;
    let lastUid = null;
    let button = null;

    const currentUser = () => window.ToDoAuth?.auth?.currentUser || null;
    const latest = () => WHATS_NEW_RELEASES[0];

    function seenKey() {
        const user = currentUser();
        return user ? SEEN_PREFIX + user.uid : null;
    }

    function getSeen() {
        const key = seenKey();
        if (!key) {
            return null;
        }
        try {
            return localStorage.getItem(key);
        } catch {
            return null;
        }
    }

    function markSeen() {
        const key = seenKey();
        if (key) {
            try {
                localStorage.setItem(key, latest().id);
            } catch {
                // Non-fatal: the popup may show once more next visit.
            }
        }
        refreshButton();
    }

    function hasUnseen() {
        return Boolean(seenKey()) && getSeen() !== latest().id;
    }

    // ---- the header button -------------------------------------------------

    function ensureButton() {
        if (button && document.body.contains(button)) {
            return;
        }
        const anchor = document.querySelector('.helpTourBtn');
        if (!anchor || !anchor.parentElement) {
            return;
        }
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'whatsNewBtn';
        button.title = 'See what\'s new';
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-gift';
        icon.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span');
        label.textContent = 'What\'s new';
        const dot = document.createElement('span');
        dot.className = 'whatsNewDot';
        dot.setAttribute('aria-hidden', 'true');
        button.append(icon, label, dot);
        button.addEventListener('click', () => open('all'));
        anchor.before(button);
        refreshButton();
    }

    function refreshButton() {
        if (!button) {
            return;
        }
        button.classList.toggle('hasNew', hasUnseen());
        button.setAttribute('aria-label', hasUnseen() ? 'What\'s new (new update)' : 'What\'s new');
    }

    // ---- the popup ---------------------------------------------------------

    function releaseNode(release, { compact }) {
        const section = document.createElement('section');
        section.className = 'whatsNewRelease' + (compact ? ' compact' : '');

        const head = document.createElement('div');
        head.className = 'whatsNewReleaseHead';
        const title = document.createElement('h3');
        title.textContent = release.title;
        const date = document.createElement('span');
        date.className = 'whatsNewDate';
        date.textContent = release.date;
        head.append(title, date);
        section.appendChild(head);

        const list = document.createElement('ul');
        list.className = 'whatsNewList';
        release.items.forEach((item) => {
            const li = document.createElement('li');
            li.className = 'whatsNewItem';
            const iconWrap = document.createElement('span');
            iconWrap.className = 'whatsNewIcon';
            iconWrap.setAttribute('aria-hidden', 'true');
            const icon = document.createElement('i');
            icon.className = 'fa-solid ' + item.icon;
            iconWrap.appendChild(icon);
            const body = document.createElement('div');
            const itemTitle = document.createElement('strong');
            itemTitle.textContent = item.title;
            const itemText = document.createElement('p');
            itemText.textContent = item.text;
            body.append(itemTitle, itemText);
            li.append(iconWrap, body);
            list.appendChild(li);
        });
        section.appendChild(list);
        return section;
    }

    function render(mode) {
        const card = overlay.querySelector('.whatsNewCard');
        card.querySelectorAll('.whatsNewBody, .whatsNewActions').forEach((node) => node.remove());

        const body = document.createElement('div');
        body.className = 'whatsNewBody';
        const heading = overlay.querySelector('.whatsNewKicker');
        if (mode === 'latest') {
            heading.textContent = 'What\'s new';
            body.appendChild(releaseNode(latest(), { compact: false }));
        } else {
            heading.textContent = 'All updates';
            WHATS_NEW_RELEASES.forEach((release, index) => {
                body.appendChild(releaseNode(release, { compact: index > 0 }));
            });
        }
        card.appendChild(body);

        const actions = document.createElement('div');
        actions.className = 'whatsNewActions';
        if (mode === 'latest' && WHATS_NEW_RELEASES.length > 1) {
            const allBtn = document.createElement('button');
            allBtn.type = 'button';
            allBtn.className = 'whatsNewSecondaryBtn';
            allBtn.textContent = 'All updates';
            allBtn.addEventListener('click', () => render('all'));
            actions.appendChild(allBtn);
        }
        const doneBtn = document.createElement('button');
        doneBtn.type = 'button';
        doneBtn.className = 'whatsNewDoneBtn';
        doneBtn.textContent = mode === 'latest' ? 'Got it' : 'Close';
        doneBtn.addEventListener('click', close);
        actions.appendChild(doneBtn);
        card.appendChild(actions);
        doneBtn.focus();
    }

    function open(mode) {
        if (overlay) {
            return;
        }
        returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        overlay = document.createElement('div');
        overlay.className = 'whatsNewOverlay';
        overlay.innerHTML = `
            <div class="whatsNewCard" role="dialog" aria-modal="true" aria-labelledby="whatsNewKicker">
                <div class="whatsNewHeader">
                    <p class="whatsNewKicker" id="whatsNewKicker"></p>
                    <button type="button" class="whatsNewCloseBtn" aria-label="Close">&times;</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        overlay.querySelector('.whatsNewCloseBtn').addEventListener('click', close);
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) {
                close();
            }
        });
        overlay.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                close();
                return;
            }
            // Keep Tab inside the dialog.
            if (event.key === 'Tab') {
                const focusable = Array.from(overlay.querySelectorAll('button'));
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first.focus();
                }
            }
        });
        render(mode);
        // Opening it (either way) counts as seeing it.
        markSeen();
    }

    function close() {
        overlay?.remove();
        overlay = null;
        if (returnFocusTo && document.body.contains(returnFocusTo)) {
            returnFocusTo.focus();
        }
        returnFocusTo = null;
    }

    // ---- when to show it on its own -----------------------------------------

    function isNewAccount() {
        const created = Date.parse(currentUser()?.metadata?.creationTime || '');
        return Number.isFinite(created) && (Date.now() - created) < NEW_ACCOUNT_MS;
    }

    function anotherDialogIsOpen() {
        return Boolean(document.querySelector(
            '.tourOverlay:not(.hidden), .groupWelcomeOverlay:not(.hidden), .weeklyRecapOverlay:not(.hidden), '
            + '.rewardOverlay:not(.hidden), .taskEditorOverlay.open, .folderManagerOverlay, .whatsNewOverlay'
        ));
    }

    // A brand-new account is about to be (or is being) walked through the
    // tutorial, which already covers everything in the current update.
    function tutorialIsShowing() {
        return Boolean(document.querySelector('.tourOverlay:not(.hidden), .groupWelcomeOverlay:not(.hidden)'));
    }

    function attempt(retriesLeft = MAX_RETRIES) {
        if (!hasUnseen() || overlay) {
            return;
        }
        if (isNewAccount() || tutorialIsShowing()) {
            markSeen();
            return;
        }
        if (anotherDialogIsOpen()) {
            if (retriesLeft > 0) {
                setTimeout(() => attempt(retriesLeft - 1), 3000);
            }
            return;
        }
        open('latest');
    }

    // Cheap watcher: adds the header button once the header exists, and starts a
    // check whenever a different account becomes signed in.
    function watch() {
        ensureButton();
        const user = currentUser();
        const uid = user ? user.uid : null;
        if (uid && uid !== lastUid && !document.body.classList.contains('authGateActive')) {
            lastUid = uid;
            refreshButton();
            // A short pause so the app (and, for a new account, the tutorial)
            // has settled before we decide.
            setTimeout(() => attempt(), 2500);
        } else if (!uid) {
            lastUid = null;
        }
    }

    setInterval(watch, 1500);
    watch();

    return { open, close, attempt, hasUnseen, markSeen, releases: WHATS_NEW_RELEASES };
})();
