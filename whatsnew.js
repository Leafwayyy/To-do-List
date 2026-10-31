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
        id: '2026-11-04',
        date: 'October 31, 2026',
        title: 'Change a deadline you assigned, and keep copies in step',
        intro: 'When you assign a task, each person gets their own copy. That was fine until plans changed: the deadline moved on your side, but theirs stayed put, and all you could do was leave a comment.',
        sections: [
            {
                icon: 'fa-pen-to-square',
                heading: 'Edit what you assigned',
                paragraphs: [
                    'On a task you assigned to someone, you now get an Edit button. You can change the deadline, the wording and the priority without waiting for them. They get a notification saying what changed.',
                    'Finishing the task, ticking its steps and approvals stay theirs. You can\'t edit a task once it\'s done.'
                ]
            },
            {
                icon: 'fa-arrows-rotate',
                heading: 'Update their copy',
                paragraphs: [
                    'If your own copy of a shared task has moved on (a new deadline, steps you added later), an Update copies button appears on it. One click sends your changes to the copies you assigned. Steps they already ticked stay ticked, and steps they added themselves are kept.'
                ]
            }
        ],
        tip: 'Try it: assign a task to a teammate, change the deadline on your copy, and press Update copies.',
        signoff: 'Needs the new database rules published.'
    },
    {
        id: '2026-11-03',
        date: 'October 31, 2026',
        title: 'Tasks that wait for other tasks, and verified email',
        intro: 'Two things teams kept running into: work that can\'t start until somebody else finishes something, and email notifications that only reach people whose address has been confirmed.',
        sections: [
            {
                icon: 'fa-link',
                heading: 'Waits for...',
                paragraphs: [
                    'In a group, any task you own now has a "Waits for..." button. Pick up to five other open tasks, yours or a teammate\'s, that need to be finished first. The card shows what it\'s waiting for and looks a little dimmer, and Today stops telling you to start it.',
                    'Nothing is locked. You can still finish it if you really need to, you\'ll just be asked to confirm. When the last task it was waiting for gets finished, you get a notification that it\'s free to start.'
                ],
                points: [
                    'We stop you creating a loop, like two tasks waiting for each other.',
                    'If a task it waited for is deleted or finished, the wait just ends.',
                    'Ask Dusty: "make the invoice wait for the contract".'
                ]
            },
            {
                icon: 'fa-envelope-circle-check',
                heading: 'Verify your email',
                paragraphs: [
                    'If you signed up with an email and a password, Firebase now sends you a link to confirm your address, and Settings has a button to resend it. We only email notification summaries to confirmed addresses, so nobody can sign up with someone else\'s address and have us email them. Signing in with Google counts as confirmed already.'
                ]
            }
        ],
        tip: 'Try it: open a group, click "Waits for..." on one of your tasks, then finish the task it waits for from another account.',
        signoff: 'Email itself switches on once the sending address is set up.'
    },
    {
        id: '2026-11-02',
        date: 'October 31, 2026',
        title: 'Dusty now speaks team workflow',
        intro: 'Dusty already knew your tasks, folders and groups. Now he understands how a team actually works day to day: what\'s blocked, what\'s waiting for a sign-off, and what you should be doing right now. As always, he only proposes. Nothing happens until you tick it.',
        sections: [
            {
                icon: 'fa-comments',
                heading: 'Ask about your day',
                paragraphs: [
                    'Ask "what should I do today?" or "what\'s stuck?" and Dusty answers from your real list: overdue first, then what\'s due today, with blocked and in-review tasks kept apart, because there\'s nothing you can do about those yet.'
                ]
            },
            {
                icon: 'fa-list-check',
                heading: 'Status and approval by chat',
                paragraphs: [
                    'In a group, you can tell Dusty what is going on and he will draft the update for you to confirm.'
                ],
                points: [
                    '"Mark the invoice as blocked, we\'re waiting on the client\'s logo." He asks for a reason if you don\'t give one.',
                    '"Send the report for review." Only works if whoever assigned it asked to approve it.',
                    '"Approve Sam\'s report" or "send it back, the totals are off." Only for tasks that are waiting for you.',
                    '"Give this to Lee, and I want to approve it before it counts."'
                ]
            },
            {
                icon: 'fa-at',
                heading: 'Get someone\'s attention',
                paragraphs: [
                    'Ask Dusty to comment on a teammate\'s task and to ask them something, and he can @mention them so it lands in their bell.'
                ]
            },
            {
                icon: 'fa-lock',
                heading: 'Still limited to what you can do',
                paragraphs: [
                    'Dusty is only told what your role lets you do. He can only mark your own tasks, only answer reviews that are yours, and only ask for approval when you can assign directly. The app checks again when you confirm, and the database checks a third time.'
                ]
            }
        ],
        tip: 'Try it: open Dusty in a group and say "what is blocked right now?"',
        signoff: 'The more you tell Dusty how your team works, the better his suggestions get.'
    },
    {
        id: '2026-11-01',
        date: 'October 31, 2026',
        title: 'Notifications, a Today view, and a smoother team workflow',
        intro: 'We looked at what a small team actually needs from a to-do list: knowing what to do today, knowing when something is stuck, and finding out when something concerns you without having to keep checking. This update is built around those three things.',
        sections: [
            {
                icon: 'fa-bell',
                heading: 'A notification bell, always there',
                paragraphs: [
                    'The bell in the corner of every page, personal and group, shows what has happened for you, with a dot on anything new and a count on the bell itself. It isn\'t just a flash when something arrives any more.',
                    'Desktop alerts are now on by default. We ask once, with a button, because your browser requires you to click Allow yourself, and you can turn them off any time in Settings.'
                ],
                points: [
                    'A task is assigned or suggested to you, or someone declines one you assigned.',
                    'Someone comments on your task or @mentions you.',
                    'A task is sent for your review, approved or sent back.',
                    'Tasks that are due soon or overdue sit at the top under "Needs your attention".',
                    'Filter by All, Tasks, Comments or Reminders. Old notifications clear themselves after 30 days.'
                ]
            },
            {
                icon: 'fa-sun',
                heading: 'Today: what should I do now?',
                paragraphs: [
                    'At the top of your task page, personal and group, there is now a short briefing in plain words: how much is overdue or due today, roughly how long it will take, and the few things to start with, in order. Click one to jump to it.',
                    'It refreshes by itself, so a tab left open all day rolls over to the new day. Fold it away if you don\'t want it, and it will stay folded.'
                ]
            },
            {
                icon: 'fa-list-check',
                heading: 'Status and sign-off in groups',
                paragraphs: [
                    'A task can now be more than done or not done. Mark it In progress, or Blocked with a short reason, and the person who assigned it, plus the group\'s owner and admins, are told straight away.',
                    'Approval is optional and up to whoever assigns the task. Tick "Needs my approval before it\'s done" when you assign it, and checking it off sends it to you for review instead. You approve it or send it back with a note. Tasks without that tick are simply done when they\'re done.'
                ]
            },
            {
                icon: 'fa-at',
                heading: 'Mention people in comments',
                paragraphs: [
                    'Type @ in a comment and pick someone from the list. They get a notification that goes straight to the task. If two people share a first name, use the full name so we don\'t guess wrong.'
                ]
            },
            {
                icon: 'fa-chart-line',
                heading: 'A weekly team report',
                paragraphs: [
                    'Group owners and admins get a report in the Team tab: what the team finished compared with the week before, what is overdue, blocked or waiting for review, and how loaded each person is. A note lands in your bell once a week, and "Copy as text" lets you paste it into a chat or an email.'
                ]
            }
        ],
        tip: 'Try it: open a group, mark one of your assigned tasks as Blocked, then check the bell on the account that assigned it.',
        signoff: 'Email notifications are next, once the app has an address to send them from.'
    },
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
