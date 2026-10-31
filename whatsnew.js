// "What's new" - patch notes. A post pops up the first time someone opens the app after an
// update, and a button in the header opens the whole archive (a list of updates on the
// left, the selected post on the right).
//
// TO ANNOUNCE AN UPDATE: add ONE entry at the TOP of WHATS_NEW_RELEASES below (newest
// first) with a new unique `id`, then bump the ?v= on the whatsnew.js script tags so
// browsers fetch the new list. That's all - the popup shows once per person per new id.
//
// Write each entry like a short blog post, in a human voice:
//  - `intro`: a sentence or two on why this update exists, as if talking to a friend.
//  - `sections`: one per topic, each with an icon, a heading, and either `paragraphs`
//    (plain prose), `points` (a short list), or both. Say what you can DO now, and why.
//  - `tip` (optional): one "try it" line, shown as a callout.
//  - `signoff` (optional): a closing line.
// Keep a post to ~2-5 sections; anything bigger should be two updates.
//
// Rules this follows:
//  - Shown once per update per account (remembered on this device only).
//  - Never shown to a brand-new account: they're getting the tutorial instead, so the
//    current update is quietly marked as seen for them.
//  - Never opens on top of the tutorial, the weekly recap, or another dialog; it waits (a
//    few tries) and then gives up until next visit.
//  - All text here is static, written by us, and rendered with textContent (never HTML).
//
// Classic script, loaded on both the solo page and the group dashboard.

const WHATS_NEW_RELEASES = [
    {
        id: '2026-10-31b',
        date: 'October 31, 2026',
        title: 'A tidier folder bar, and sections you can fold',
        intro: 'Once you start using folders, it\'s easy to end up with a lot of them, and the row of folder buttons turned into a wall that pushed your tasks down the page. This update keeps things neat however many folders you have, and does the same for long lists in groups.',
        sections: [
            {
                icon: 'fa-folder-tree',
                heading: 'Folders that stay in one row',
                paragraphs: [
                    'The folder bar now shows just the folders that matter right now: the one you\'re looking at, plus the ones with the most open tasks. Everything else lives behind a "More folders" button.'
                ],
                points: [
                    'The More folders panel floats over the page, so opening it never shoves your tasks around.',
                    'It has a search box. Type a few letters and press Enter to jump straight to a folder.',
                    'If you have seven folders or fewer, nothing changes. You still see them all.',
                    'On a phone, the whole row becomes one button, "Folder: Legal", that opens the same panel.'
                ]
            },
            {
                icon: 'fa-layer-group',
                heading: 'Fold sections shut in groups',
                paragraphs: [
                    'When a group list is split by person, role or folder, you can now click any heading to fold that section away. The number next to the name stays put, so you always know what\'s tucked inside.',
                    'Your folds are remembered on this device, separately for each group, and they only affect your own screen. Folding a section never changes what your teammates see.'
                ]
            },
            {
                icon: 'fa-palette',
                heading: 'Sections you can tell apart',
                paragraphs: [
                    'Each section heading is now a colored banner, and the tasks under it are indented with a stripe in the same color. Every person gets their own color, and folders and roles keep theirs, so it\'s clear where one group ends and the next begins.'
                ]
            },
            {
                icon: 'fa-id-badge',
                heading: 'Roles moved to the Team tab',
                paragraphs: [
                    'Roles are about people, so the Roles & access button now lives in the Team tab, right above the roster. It used to sit among the task filters, where it didn\'t really belong. Only owners and admins see it.'
                ]
            }
        ],
        tip: 'Try it: open a group, set "Group by" to Person, then click a name. Owners and admins can find Roles & access in the Team tab.',
        signoff: 'More tidying-up is on the way. Tell us what still feels cluttered.'
    },
    {
        id: '2026-10-31',
        date: 'October 31, 2026',
        title: 'Dusty can do more for you',
        intro: 'Until now, Dusty could turn a ramble into tasks and that was about it. We wanted him to actually help you run your lists and your groups, without ever doing something behind your back. So he can do more, but only what you\'re allowed to do, and always with a card for you to look over first.',
        sections: [
            {
                icon: 'fa-folder-plus',
                heading: 'Folders, by chat',
                paragraphs: [
                    'Ask Dusty to make a folder, or to sort your tasks into the folders you already have. He lays out what he\'s about to do, and nothing happens until you tick it.'
                ]
            },
            {
                icon: 'fa-user-check',
                heading: 'Assigning, by asking',
                paragraphs: [
                    'In a group, you can say "give this to Sam" or "me and Philip need to finish the slides by Friday" and Dusty drafts it for you. A task for several people is one shared task, with the steps and due date included for everyone, not a stack of copies.'
                ],
                points: [
                    'Say "me" to include yourself, or "everyone" for the whole group.',
                    'If a teammate can\'t be found, Dusty tells you instead of guessing.'
                ]
            },
            {
                icon: 'fa-id-badge',
                heading: 'Roles and access, for owners and admins',
                paragraphs: [
                    'Owners and admins can ask Dusty to create a role, give someone a role, or change who is allowed to assign tasks. Because these change who can do what, they start unticked. You have to tick them on purpose.'
                ]
            },
            {
                icon: 'fa-lock',
                heading: 'Only what you\'re allowed to do',
                paragraphs: [
                    'Dusty only offers what your role lets you do. If you ask for something you can\'t do, he says so, and suggests the closest thing you can. The app checks your permissions again when you confirm, and the database checks them a third time.'
                ]
            },
            {
                icon: 'fa-wrench',
                heading: 'Fixes',
                points: [
                    'Changing your name now updates it in every group you\'re in.',
                    'A task shared with several people shows up once in every view, including Group by Person.'
                ]
            }
        ],
        tip: 'Try it: open Dusty and type "make a folder called School and put my homework tasks in it".',
        signoff: 'Dusty is still learning your way of talking. If he gets something wrong, just fix the card and carry on.'
    },
    {
        id: '2026-10-30',
        date: 'October 30, 2026',
        title: 'Folders, faster adding, and teamwork tools',
        intro: 'This is our biggest update so far. It\'s about getting a growing pile of tasks under control, and about making groups work like a real team, with jobs, folders and tasks you can hand to each other.',
        sections: [
            {
                icon: 'fa-folder',
                heading: 'Folders',
                paragraphs: [
                    'Sort your tasks into colored folders like School or Work. Each task lives in one folder, and you can filter the whole list by it.',
                    'Got a big pile already? Tap "Sort into folders" and file a whole bunch at once, instead of one by one.'
                ]
            },
            {
                icon: 'fa-bolt',
                heading: 'Adding tasks, faster',
                paragraphs: [
                    'You no longer need to remember any symbols. Just write the task in plain words.'
                ],
                points: [
                    'Type something like "every Friday" or a folder name, and a small suggestion pops up. Nothing changes until you tap it.',
                    'Tap the / button (or type /) to set a due date, folder or priority.',
                    'Press N from anywhere to jump to the task box.'
                ]
            },
            {
                icon: 'fa-people-group',
                heading: 'Teams: roles, folders and assigning',
                paragraphs: [
                    'Group owners and admins can now give people job roles (like Designer or Cashier) and make folders for the whole group. Roles are just labels on their own. They don\'t give anyone extra powers.',
                    'Owners and admins can also put a task straight onto someone\'s list, or everyone\'s. The person gets 15 minutes to decline it if it\'s not right, and you\'re told if they do.'
                ],
                points: [
                    'Group the list by person, role or folder.',
                    'Owners and admins can let a specific person assign tasks or manage folders too.',
                    'When a task goes to several people it shows up once, with who has finished it.'
                ]
            },
            {
                icon: 'fa-shield-halved',
                heading: 'A safer Dusty',
                paragraphs: [
                    'Dusty now asks "Remember this?" before saving anything to his memory that you didn\'t say yourself.'
                ]
            }
        ],
        signoff: 'Thanks for building up your lists with us.'
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
    let selectedId = null;
    let newIdAtOpen = null;

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
        button.addEventListener('click', () => open());
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

    function iconNode(name, className) {
        const icon = el('i', 'fa-solid ' + name + (className ? ' ' + className : ''));
        icon.setAttribute('aria-hidden', 'true');
        return icon;
    }

    function postNode(release) {
        const post = el('article', 'whatsNewPost');
        post.appendChild(el('h2', 'whatsNewPostTitle', release.title));
        post.appendChild(el('p', 'whatsNewPostDate', release.date));
        if (release.intro) {
            post.appendChild(el('p', 'whatsNewIntro', release.intro));
        }
        (release.sections || []).forEach((section) => {
            const block = el('section', 'whatsNewSection');
            const head = el('h3', 'whatsNewSectionHead');
            const iconWrap = el('span', 'whatsNewIcon');
            iconWrap.setAttribute('aria-hidden', 'true');
            iconWrap.appendChild(iconNode(section.icon || 'fa-star'));
            head.append(iconWrap, el('span', null, section.heading));
            block.appendChild(head);
            (section.paragraphs || []).forEach((text) => block.appendChild(el('p', 'whatsNewText', text)));
            if (section.points && section.points.length > 0) {
                const list = el('ul', 'whatsNewPoints');
                section.points.forEach((text) => list.appendChild(el('li', null, text)));
                block.appendChild(list);
            }
            post.appendChild(block);
        });
        if (release.tip) {
            const tip = el('p', 'whatsNewTip');
            tip.appendChild(iconNode('fa-lightbulb'));
            tip.appendChild(el('span', null, release.tip));
            post.appendChild(tip);
        }
        if (release.signoff) {
            post.appendChild(el('p', 'whatsNewSignoff', release.signoff));
        }
        return post;
    }

    function renderNav() {
        const nav = overlay.querySelector('.whatsNewNav');
        nav.textContent = '';
        WHATS_NEW_RELEASES.forEach((release) => {
            const item = el('button', 'whatsNewNavItem' + (release.id === selectedId ? ' active' : ''));
            item.type = 'button';
            item.dataset.releaseId = release.id;
            if (release.id === selectedId) {
                item.setAttribute('aria-current', 'true');
            }
            const top = el('span', 'whatsNewNavTop');
            top.appendChild(el('span', 'whatsNewNavDate', release.date));
            if (release.id === newIdAtOpen) {
                top.appendChild(el('span', 'whatsNewNewTag', 'New'));
            }
            item.append(top, el('span', 'whatsNewNavTitle', release.title));
            item.addEventListener('click', () => select(release.id));
            nav.appendChild(item);
        });
    }

    function select(releaseId) {
        const release = WHATS_NEW_RELEASES.find((entry) => entry.id === releaseId) || latest();
        selectedId = release.id;
        renderNav();
        const scroller = overlay.querySelector('.whatsNewMain');
        scroller.textContent = '';
        scroller.appendChild(postNode(release));
        scroller.scrollTop = 0;
    }

    function open() {
        if (overlay) {
            return;
        }
        returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        newIdAtOpen = hasUnseen() ? latest().id : null;
        overlay = el('div', 'whatsNewOverlay');
        overlay.innerHTML = `
            <div class="whatsNewCard" role="dialog" aria-modal="true" aria-labelledby="whatsNewKicker">
                <div class="whatsNewHeader">
                    <p class="whatsNewKicker" id="whatsNewKicker">Patch notes</p>
                    <button type="button" class="whatsNewCloseBtn" aria-label="Close">&times;</button>
                </div>
                <div class="whatsNewLayout">
                    <nav class="whatsNewNav" aria-label="Updates"></nav>
                    <div class="whatsNewMain" tabindex="0"></div>
                </div>
                <div class="whatsNewActions">
                    <button type="button" class="whatsNewDoneBtn">Got it</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        overlay.querySelector('.whatsNewCloseBtn').addEventListener('click', close);
        overlay.querySelector('.whatsNewDoneBtn').addEventListener('click', close);
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
                const focusable = Array.from(overlay.querySelectorAll('button, [tabindex="0"]'));
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
        select(latest().id);
        overlay.querySelector('.whatsNewDoneBtn').focus();
        // Opening it counts as seeing it.
        markSeen();
    }

    function close() {
        overlay?.remove();
        overlay = null;
        selectedId = null;
        newIdAtOpen = null;
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
        open();
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
