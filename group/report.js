// Weekly team report, for a group's owner and admins (Team tab): how the last 7 days went -
// what got done compared with the week before, what is overdue, blocked or waiting for
// review, and how loaded each person is. TeamReport.build() is pure (tested on its own);
// render() draws it; toText() makes a plain-text version to paste into a chat or an email
// (until the app can send email itself).
//
// Numbers come from data the page already has: the group's open tasks and its completion
// history (the newest 200 entries, which is plenty for a week of a small team).
//
// Classic script, loaded before group.js. All text is rendered with textContent.

const TeamReport = (() => {
    const DAY = 24 * 60 * 60 * 1000;

    function weekKey(now) {
        // The Monday that starts this calendar week, as YYYY-MM-DD (local time).
        const date = new Date(now);
        date.setHours(0, 0, 0, 0);
        date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
        const pad = (n) => String(n).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    }

    // members: [{ uid, name }]; tasks: the group's tasks; history: [{ ownerId, completedAt }]
    function build({ members, tasks, history, now = Date.now(), statusOf, effortOf }) {
        const status = statusOf || ((task) => getTaskUrgencyStatus(task));
        const effort = effortOf || ((task) => getEstimatedEffortHours(task));
        const weekStart = now - 7 * DAY;
        const prevStart = now - 14 * DAY;
        const horizon = now + 7 * DAY;

        const doneIn = (uid, from, to) => (history || []).filter((entry) => {
            const at = new Date(entry.completedAt).getTime();
            return entry.ownerId === uid && Number.isFinite(at) && at > from && at <= to;
        }).length;

        const people = members.map((member) => {
            const mine = (tasks || []).filter((task) => task.ownerId === member.uid && !task.completed);
            const overdue = mine.filter((task) => {
                const s = status(task);
                return s.isOverdue || s.urgencyLevel === 'overdue';
            });
            const loadTasks = mine.filter((task) => {
                const s = status(task);
                return s.isOverdue || (s.hasDeadline && s.deadlineTimestamp <= horizon);
            });
            return {
                uid: member.uid,
                name: member.name,
                done: doneIn(member.uid, weekStart, now),
                donePrev: doneIn(member.uid, prevStart, weekStart),
                open: mine.length,
                overdue: overdue.length,
                blocked: mine.filter((task) => task.status === 'blocked').length,
                inReview: mine.filter((task) => task.status === 'review').length,
                loadHours: loadTasks.reduce((sum, task) => sum + effort(task), 0)
            };
        });

        const sum = (key) => people.reduce((total, person) => total + person[key], 0);
        const totals = {
            done: sum('done'),
            donePrev: sum('donePrev'),
            open: sum('open'),
            overdue: sum('overdue'),
            blocked: sum('blocked'),
            inReview: sum('inReview')
        };
        totals.delta = totals.done - totals.donePrev;

        const stuck = (tasks || [])
            .filter((task) => !task.completed && task.status === 'blocked')
            .map((task) => ({
                who: (members.find((member) => member.uid === task.ownerId) || {}).name || 'Teammate',
                text: task.text,
                reason: task.blockedReason || ''
            }));

        return { weekKey: weekKey(now), from: weekStart, to: now, people, totals, stuck };
    }

    function headline(report) {
        const { totals } = report;
        const change = totals.delta === 0 ? 'same as the week before' : `${totals.delta > 0 ? 'up' : 'down'} ${Math.abs(totals.delta)} from the week before`;
        const bits = [`${totals.done} finished (${change})`];
        if (totals.overdue > 0) {
            bits.push(`${totals.overdue} overdue`);
        }
        if (totals.blocked > 0) {
            bits.push(`${totals.blocked} blocked`);
        }
        if (totals.inReview > 0) {
            bits.push(`${totals.inReview} waiting for review`);
        }
        return bits.join(', ');
    }

    function hoursText(hours) {
        if (hours <= 0) {
            return '-';
        }
        const rounded = Math.round(hours * 2) / 2;
        return `${rounded % 1 === 0 ? rounded : rounded.toFixed(1)}h`;
    }

    const dateText = (ms) => new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });

    function toText(report, groupName) {
        const lines = [
            `Weekly team report${groupName ? ' - ' + groupName : ''}`,
            `${dateText(report.from)} to ${dateText(report.to)}`,
            '',
            headline(report) + '.',
            '',
            'Per person (finished / open / overdue / blocked / load this week):'
        ];
        report.people.forEach((person) => {
            lines.push(`- ${person.name}: ${person.done} finished, ${person.open} open, ${person.overdue} overdue, ${person.blocked} blocked, ${hoursText(person.loadHours)}`);
        });
        if (report.stuck.length > 0) {
            lines.push('', 'Blocked right now:');
            report.stuck.forEach((item) => lines.push(`- ${item.who}: ${item.text}${item.reason ? ' (' + item.reason + ')' : ''}`));
        }
        return lines.join('\n');
    }

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

    function render(container, report, { groupName, onCopy } = {}) {
        container.textContent = '';
        const head = el('div', 'reportHead');
        const titles = el('div');
        titles.appendChild(el('h2', 'reportTitle', 'Weekly report'));
        titles.appendChild(el('p', 'reportPeriod', `${dateText(report.from)} to ${dateText(report.to)} · only owners and admins see this`));
        const copy = el('button', 'reportCopyBtn', 'Copy as text');
        copy.type = 'button';
        copy.addEventListener('click', () => onCopy?.(toText(report, groupName), copy));
        head.append(titles, copy);
        container.appendChild(head);

        container.appendChild(el('p', 'reportHeadline', headline(report) + '.'));

        const tiles = el('div', 'reportTiles');
        const tile = (label, value, className) => {
            const node = el('div', 'reportTile ' + className);
            node.appendChild(el('span', 'reportTileValue', String(value)));
            node.appendChild(el('span', 'reportTileLabel', label));
            tiles.appendChild(node);
        };
        tile('Finished', report.totals.done, 'isDone');
        tile('Overdue', report.totals.overdue, report.totals.overdue > 0 ? 'isOverdue' : '');
        tile('Blocked', report.totals.blocked, report.totals.blocked > 0 ? 'isBlocked' : '');
        tile('In review', report.totals.inReview, report.totals.inReview > 0 ? 'isReview' : '');
        container.appendChild(tiles);

        const table = el('div', 'reportTable');
        table.setAttribute('role', 'table');
        const header = el('div', 'reportRow reportRowHead');
        ['Person', 'Finished', 'Open', 'Overdue', 'Blocked', 'Load'].forEach((label) => header.appendChild(el('span', null, label)));
        table.appendChild(header);
        report.people.forEach((person) => {
            const row = el('div', 'reportRow');
            row.setAttribute('role', 'row');
            row.appendChild(el('span', 'reportName', person.name));
            row.appendChild(el('span', null, String(person.done)));
            row.appendChild(el('span', null, String(person.open)));
            row.appendChild(el('span', person.overdue > 0 ? 'isOverdue' : '', String(person.overdue)));
            row.appendChild(el('span', person.blocked > 0 ? 'isBlocked' : '', String(person.blocked)));
            row.appendChild(el('span', null, hoursText(person.loadHours)));
            table.appendChild(row);
        });
        container.appendChild(table);
        container.appendChild(el('p', 'reportNote', 'Load is the estimated hours of open tasks that are overdue or due in the next 7 days.'));

        if (report.stuck.length > 0) {
            container.appendChild(el('p', 'reportSection', 'Blocked right now'));
            const list = el('ul', 'reportStuck');
            report.stuck.forEach((item) => {
                const li = el('li');
                li.appendChild(el('strong', null, item.who + ': '));
                li.appendChild(document.createTextNode(item.text + (item.reason ? ' (' + item.reason + ')' : '')));
                list.appendChild(li);
            });
            container.appendChild(list);
        }
    }

    return { build, headline, toText, render, weekKey };
})();

window.TeamReport = TeamReport;
