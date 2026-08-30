// "All my groups" browse page - a scrollable grid of every group the
// current user belongs to, each showing its members, with leave/delete and
// a link into that group's dashboard (group/index.html?g=<id>). Exists
// because the switcher row on the dashboard itself only works well for a
// handful of groups; this is the place to see and manage all of them once
// that starts to pile up.

const groupStatusMsg = document.querySelector('.groupStatusMsg');
const groupBrowseGrid = document.querySelector('.groupBrowseGrid');

let currentUser = null;
let groups = undefined;
let groupTasksByGroupId = {};
let unsubscribeGroups = null;
const taskUnsubscribes = {};

function renderGrid() {
    if (!groupBrowseGrid) {
        return;
    }

    if (!currentUser) {
        groupStatusMsg?.classList.add('hidden');
        groupBrowseGrid.classList.add('hidden');
        return;
    }

    if (groups === undefined) {
        if (groupStatusMsg) {
            groupStatusMsg.textContent = 'Loading your groups...';
            groupStatusMsg.classList.remove('hidden');
        }
        groupBrowseGrid.classList.add('hidden');
        return;
    }

    groupStatusMsg?.classList.add('hidden');
    groupBrowseGrid.classList.remove('hidden');
    groupBrowseGrid.innerHTML = '';

    groups.forEach((group) => {
        groupBrowseGrid.appendChild(createGroupBrowseCard(group));
    });

    groupBrowseGrid.appendChild(createNewGroupCard());
}

function createGroupBrowseCard(group) {
    const tasksForGroup = groupTasksByGroupId[group.id] || [];
    const isOwner = group.ownerId === currentUser.uid;

    const card = document.createElement('div');
    card.classList.add('groupBrowseCard');

    const name = document.createElement('h2');
    name.classList.add('groupBrowseCardName');
    name.textContent = group.name;
    card.appendChild(name);

    const inviteRow = document.createElement('p');
    inviteRow.classList.add('groupBrowseCardInvite');
    inviteRow.textContent = `Invite code: ${group.inviteCode || group.id}`;
    card.appendChild(inviteRow);

    const memberList = document.createElement('div');
    memberList.classList.add('groupBrowseCardMembers');
    const memberIds = group.memberIds || [];
    const memberNames = group.memberNames || [];
    memberIds.forEach((memberId, index) => {
        const chip = document.createElement('span');
        chip.classList.add('groupBrowseMemberChip');
        const resolvedName = resolveMemberName(memberId, memberNames[index], tasksForGroup);
        chip.textContent = memberId === currentUser.uid ? `${resolvedName} (You)` : resolvedName;
        if (memberId === group.ownerId) {
            chip.classList.add('isOwnerChip');
            chip.title = 'Group owner';
        }
        memberList.appendChild(chip);
    });
    card.appendChild(memberList);

    const actions = document.createElement('div');
    actions.classList.add('groupBrowseCardActions');

    const openLink = document.createElement('a');
    openLink.classList.add('groupBrowseOpenBtn');
    openLink.href = `index.html?g=${encodeURIComponent(group.id)}`;
    openLink.textContent = 'Open dashboard';
    actions.appendChild(openLink);

    if (isOwner) {
        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.classList.add('groupDeleteBtn');
        deleteBtn.textContent = 'Delete';
        deleteBtn.addEventListener('click', async () => {
            playClickSound();
            if (!confirm(`Delete "${group.name}" for everyone? This removes all of its tasks too. This can't be undone.`)) {
                return;
            }
            try {
                await deleteGroupCompletely(group.id, currentUser);
            } catch (error) {
                console.error('Failed to delete group:', error);
                alert(error.message || 'Could not delete the group.');
            }
        });
        actions.appendChild(deleteBtn);
    } else {
        const leaveBtn = document.createElement('button');
        leaveBtn.type = 'button';
        leaveBtn.classList.add('groupLeaveBtn');
        leaveBtn.textContent = 'Leave';
        leaveBtn.addEventListener('click', async () => {
            playClickSound();
            if (!confirm(`Leave "${group.name}"? You'll need the invite code to rejoin.`)) {
                return;
            }
            try {
                await leaveGroup(group.id, currentUser);
            } catch (error) {
                console.error('Failed to leave group:', error);
                alert(error.message || 'Could not leave the group.');
            }
        });
        actions.appendChild(leaveBtn);
    }

    card.appendChild(actions);
    return card;
}

function createNewGroupCard() {
    const card = document.createElement('a');
    card.classList.add('groupBrowseCard', 'groupBrowseNewCard');
    card.href = 'index.html?new=1';
    card.innerHTML = '<i class="fa-solid fa-plus"></i><span>Create or join a group</span>';
    return card;
}

function watchGroupTasks(groupId) {
    if (taskUnsubscribes[groupId]) {
        return;
    }
    taskUnsubscribes[groupId] = subscribeToGroupTasks(groupId, (tasks) => {
        groupTasksByGroupId[groupId] = tasks;
        renderGrid();
    }, (error) => {
        console.error(`Failed to load tasks for group ${groupId}:`, error);
    });
}

// subscribeToGroupTasks lives in group.js normally, but this page doesn't
// load group.js (it doesn't need the dashboard) - a small local copy here
// since it's a single, generic query wrapper with no dashboard-specific state.
function subscribeToGroupTasks(groupId, callback, onError) {
    const { collection, onSnapshot } = fs();
    const tasksRef = collection(db(), 'groups', groupId, 'tasks');
    return onSnapshot(tasksRef, (snapshot) => {
        callback(snapshot.docs.map((taskDoc) => ({ id: taskDoc.id, ...taskDoc.data() })));
    }, onError);
}

function resetState() {
    if (unsubscribeGroups) {
        unsubscribeGroups();
        unsubscribeGroups = null;
    }
    Object.values(taskUnsubscribes).forEach((unsubscribe) => unsubscribe());
    Object.keys(taskUnsubscribes).forEach((key) => delete taskUnsubscribes[key]);
    currentUser = null;
    groups = undefined;
    groupTasksByGroupId = {};
    renderGrid();
}

AuthGate.init({
    onSignedIn: (user) => {
        currentUser = user;
        groups = undefined;
        renderGrid();

        unsubscribeGroups = subscribeToMyGroups(user.uid, (nextGroups) => {
            groups = nextGroups;
            nextGroups.forEach((group) => watchGroupTasks(group.id));
            renderGrid();
        }, (error) => {
            console.error('Failed to load your groups:', error);
            groups = [];
            renderGrid();
        });
    },
    onSignedOut: () => {
        resetState();
    }
});
