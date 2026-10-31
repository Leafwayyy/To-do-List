// "Today": the card at the top of the task page (solo AND groups) that answers "what should I
// do now?" - a one-line summary in plain words, a few counts, and the handful of tasks to
// start with, in a sensible order. It is the daily briefing: nothing is stored, it is worked
// out from your own open tasks each time, and it quietly refreshes every minute and when you
// switch back to the tab, so a page left open all day rolls over to the new day by itself.
//
// TodayPlan.build(tasks, options) is a pure function (so it can be tested); TodayPlan.mount()
// draws it. The group page also passes `reviews` (tasks waiting for YOUR sign-off) and a
// `where` label. All text is rendered with textContent.
//
// Classic script, loaded before script.js / group.js on both pages.

const TodayPlan = (() => {
    const MAX_ITEMS = 5;
    const COLLAPSED_KEY = 'todoTodayCollapsed';
    const REFRESH_MS = 60 * 1000;
    const MATRIX_ORDER = { do: 0, schedule: 1, delegate: 2, eliminate: 3 };

    let container = null;
    let getModel = null;
    let lastSignature = '';
    let timer = null;

    const startOfDay = (ms) => {
        const date = new Date(ms);
        date.setHours(0, 0, 0, 0);
        return date.getTime();
    };

    function hoursLabel(hours) {
        if (hours < 1) {
            return `${Math.max(1, Math.round(hours * 60))} min`;
        }
        const rounded = Math.round(hours * 2) / 2;
        return `${rounded % 1 === 0 ? rounded : rounded.toFixed(1)}h`;
    }

    function greeting(now) {
        const hour = new Date(now).getHours();
        if (hour < 12) {
            return 'Good morning';
        }
        return hour < 18 ? 'Good afternoon' : 'Good evening';
    }

    // statusOf / effortOf default to the shared helpers in task-shared.js; tests pass their own.
    function build(tasks, { now = Date.now(), reviews = [], waitingIds = [], statusOf, effortOf } = {}) {
        const waitingOn = new Set(waitingIds || []);
        const status = statusOf || ((task) => getTaskUrgencyStatus(task));
        const effort = effortOf || ((task) => getEstimatedEffortHours(task));
        const dayStart = startOfDay(now);
        const dayEnd = dayStart + 24 * 60 * 60 * 1000;

        const open = (tasks || []).filter((task) => task && !task.completed);
        const info = open.map((task) => ({ task, status: status(task) }));
        const byDue = (a, b) => (a.status.deadlineTimestamp || Infinity) - (b.status.deadlineTimestamp || Infinity);
        // Blocked, in review, or waiting for another task to be finished first.
        const isWaiting = (entry) => entry.task.status === 'blocked' || entry.task.status === 'review' || waitingOn.has(entry.task.id);

        // Tasks waiting on someone (blocked / in review) can't be acted on today, so they are not
        // "due today" or "overdue" for the person: they show under Blocked / In review instead.
        const overdue = info.filter((entry) => !isWaiting(entry) && (entry.status.isOverdue || entry.status.urgencyLevel === 'overdue')).sort(byDue);
        const overdueSet = new Set(overdue);
        const dueToday = info
            .filter((entry) => !isWaiting(entry) && !overdueSet.has(entry) && entry.status.hasDeadline
                && entry.status.deadlineTimestamp >= dayStart && entry.status.deadlineTimestamp < dayEnd)
            .sort(byDue);
        const dueTodaySet = new Set(dueToday);
        const blocked = info.filter((entry) => entry.task.status === 'blocked');
        const inReview = info.filter((entry) => entry.task.status === 'review');
        const inProgress = info.filter((entry) => entry.task.status === 'inprogress' && !overdueSet.has(entry) && !dueTodaySet.has(entry));
        const used = new Set([...overdueSet, ...dueTodaySet, ...inProgress]);
        const rest = info
            .filter((entry) => !used.has(entry) && !isWaiting(entry))
            .sort((a, b) => {
                const ma = MATRIX_ORDER[a.task.matrix] ?? 4;
                const mb = MATRIX_ORDER[b.task.matrix] ?? 4;
                return ma - mb || byDue(a, b);
            });

        // Waiting tasks (blocked / in review) can't be acted on, so they never lead the list.
        // The list is what belongs to today: overdue, due today, and what you've started. Other
        // open tasks only appear (a few, as ideas to get ahead on) when there is nothing else, so
        // a task due next week never sits in today's list just to fill it.
        const todays = [...overdue, ...dueToday, ...inProgress].filter((entry) => !isWaiting(entry));
        const focusEntries = todays.length > 0 ? todays : rest.slice(0, 3);
        const focus = focusEntries.slice(0, MAX_ITEMS).map((entry) => ({
            id: entry.task.id,
            text: entry.task.text,
            level: overdueSet.has(entry) ? 'overdue' : (dueTodaySet.has(entry) ? 'today' : (entry.task.status === 'inprogress' ? 'inprogress' : 'next')),
            label: overdueSet.has(entry) || dueTodaySet.has(entry) || entry.status.hasDeadline ? entry.status.countdownLabel : ''
        }));

        const todaysHours = [...overdue, ...dueToday].filter((entry) => !isWaiting(entry)).reduce((sum, entry) => sum + effort(entry.task), 0);

        const model = {
            greeting: greeting(now),
            counts: {
                overdue: overdue.length, dueToday: dueToday.length, blocked: blocked.length, inReview: inReview.length, open: open.length,
                waiting: info.filter((entry) => waitingOn.has(entry.task.id) && entry.task.status !== 'blocked' && entry.task.status !== 'review').length
            },
            hours: todaysHours,
            focus,
            blocked: blocked.map((entry) => ({ id: entry.task.id, text: entry.task.text, reason: entry.task.blockedReason || '' })),
            reviews: (reviews || []).map((item) => ({ id: item.id, text: item.text, who: item.who || '' }))
        };
        model.summary = summarize(model);
        return model;
    }

    function summarize(model) {
        const { counts, hours, focus, reviews } = model;
        const parts = [];
        if (counts.overdue > 0) {
            parts.push(`${counts.overdue} overdue`);
        }
        if (counts.dueToday > 0) {
            parts.push(`${counts.dueToday} due today`);
        }
        let sentence;
        if (parts.length > 0) {
            sentence = `${model.greeting}. You have ${parts.join(' and ')}${hours > 0 ? ` (about ${hoursLabel(hours)} of work)` : ''}.`;
            if (focus[0]) {
                sentence += ` Start with "${focus[0].text}".`;
            }
        } else if (focus[0]) {
            sentence = `${model.greeting}. Nothing is due today. A good time to get ahead on "${focus[0].text}".`;
        } else if (counts.open === 0) {
            sentence = `${model.greeting}. Your list is clear.`;
        } else {
            sentence = `${model.greeting}. Everything left is waiting on someone.`;
        }
        if (reviews.length > 0) {
            sentence += ` ${reviews.length} ${reviews.length === 1 ? 'task is' : 'tasks are'} waiting for your review.`;
        }
        return sentence;
    }

    // ---- drawing -------------------------------------------------------------

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

    function isCollapsed() {
        try {
            return localStorage.getItem(COLLAPSED_KEY) === '1';
        } catch {
            return false;
        }
    }

    function setCollapsed(value) {
        try {
            if (value) {
                localStorage.setItem(COLLAPSED_KEY, '1');
            } else {
                localStorage.removeItem(COLLAPSED_KEY);
            }
        } catch {
            // Non-fatal.
        }
    }

    function jumpTo(taskId) {
        const target = Array.from(document.querySelectorAll('[data-task-id]')).find((node) => node.dataset.taskId === taskId);
        if (!target) {
            return;
        }
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('todayFlash');
        setTimeout(() => target.classList.remove('todayFlash'), 1600);
    }

    function draw(model, where) {
        container.textContent = '';
        const collapsed = isCollapsed();

        const head = el('div', 'todayHead');
        const toggle = el('button', 'todayToggle');
        toggle.type = 'button';
        toggle.setAttribute('aria-expanded', String(!collapsed));
        const chevron = el('i', 'fa-solid fa-chevron-down todayChevron');
        chevron.setAttribute('aria-hidden', 'true');
        const title = el('span', 'todayTitle', 'Today');
        const date = el('span', 'todayDate', new Date().toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }) + (where ? ' · ' + where : ''));
        toggle.append(chevron, title, date);
        toggle.addEventListener('click', () => {
            setCollapsed(!isCollapsed());
            lastSignature = '';
            refresh();
        });
        head.appendChild(toggle);
        container.appendChild(head);
        container.classList.toggle('collapsed', collapsed);
        if (collapsed) {
            return;
        }

        container.appendChild(el('p', 'todaySummary', model.summary));

        const chips = el('div', 'todayChips');
        const addChip = (label, count, className) => {
            if (count > 0) {
                chips.appendChild(el('span', 'todayChip ' + className, `${count} ${label}`));
            }
        };
        addChip('overdue', model.counts.overdue, 'isOverdue');
        addChip('due today', model.counts.dueToday, 'isToday');
        addChip('blocked', model.counts.blocked, 'isBlocked');
        addChip('in review', model.counts.inReview, 'isReview');
        addChip('waiting on a task', model.counts.waiting, 'isReview');
        if (chips.children.length > 0) {
            container.appendChild(chips);
        }

        if (model.reviews.length > 0) {
            container.appendChild(el('p', 'todayLabel', 'Waiting for your review'));
            const list = el('ul', 'todayList');
            model.reviews.forEach((item) => {
                const row = el('li', 'todayItem isReview');
                row.appendChild(el('span', 'todayItemText', item.text));
                if (item.who) {
                    row.appendChild(el('span', 'todayItemLabel', item.who));
                }
                list.appendChild(row);
            });
            container.appendChild(list);
        }

        if (model.focus.length > 0) {
            container.appendChild(el('p', 'todayLabel', 'Start here'));
            const list = el('ul', 'todayList');
            model.focus.forEach((item, index) => {
                const row = el('li', 'todayItem level-' + item.level);
                const button = el('button', 'todayItemBtn');
                button.type = 'button';
                button.appendChild(el('span', 'todayNumber', String(index + 1)));
                button.appendChild(el('span', 'todayItemText', item.text));
                if (item.label) {
                    button.appendChild(el('span', 'todayItemLabel', item.label));
                }
                button.addEventListener('click', () => jumpTo(item.id));
                row.appendChild(button);
                list.appendChild(row);
            });
            container.appendChild(list);
        }

        if (model.blocked.length > 0) {
            container.appendChild(el('p', 'todayLabel', 'Blocked'));
            const list = el('ul', 'todayList');
            model.blocked.forEach((item) => {
                const row = el('li', 'todayItem isBlocked');
                row.appendChild(el('span', 'todayItemText', item.text));
                if (item.reason) {
                    row.appendChild(el('span', 'todayItemLabel', item.reason));
                }
                list.appendChild(row);
            });
            container.appendChild(list);
        }
    }

    function refresh() {
        if (!container || typeof getModel !== 'function') {
            return;
        }
        let input;
        try {
            input = getModel();
        } catch (error) {
            console.warn('Could not build Today:', error);
            return;
        }
        if (!input) {
            container.classList.add('hidden');
            return;
        }
        const model = build(input.tasks, { reviews: input.reviews, waitingIds: input.waitingIds });
        // Don't rebuild (and lose focus / a scroll position) when nothing a person can see changed.
        const signature = JSON.stringify([model, input.where || '', isCollapsed(), new Date().toDateString()]);
        container.classList.remove('hidden');
        if (signature === lastSignature) {
            return;
        }
        lastSignature = signature;
        draw(model, input.where);
    }

    // `getModelFn()` returns { tasks, reviews?, where? } or null to hide the card.
    function mount(containerEl, getModelFn) {
        container = containerEl;
        getModel = getModelFn;
        lastSignature = '';
        if (!container) {
            return;
        }
        clearInterval(timer);
        timer = setInterval(refresh, REFRESH_MS);
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                refresh();
            }
        });
        // Deferred: the page's own script is still running (and its variables not all set up yet).
        setTimeout(refresh, 0);
    }

    return { build, summarize, mount, refresh };
})();

window.TodayPlan = TodayPlan;
