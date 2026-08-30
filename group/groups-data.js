// Group data layer - Firestore reads/writes for groups themselves (create,
// join, leave, delete, list "my groups") and the per-user display name.
// Shared by group/group.js (the dashboard) and group/browse.js (the "all my
// groups" page) so both work from the exact same rules and behavior instead
// of two copies that can drift. Task-level operations (add/complete/delete
// a task, subtasks) stay in group.js since only the dashboard needs them.
//
// Classic script, loaded by both pages before their own script.

const db = () => window.ToDoAuth.db;
const fs = () => window.ToDoAuth.firestore;

// No ambiguous characters (0/O, 1/I) since people read these codes aloud or
// type them from a screenshot.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// crypto.getRandomValues instead of Math.random - Math.random isn't a
// cryptographically strong source, and an invite code is effectively a
// short-lived credential (whoever has it can join the group), so it
// shouldn't be guessable/predictable even in principle.
function generateInviteCode(length = 6) {
    const randomValues = new Uint32Array(length);
    crypto.getRandomValues(randomValues);
    let code = '';
    for (let i = 0; i < length; i += 1) {
        code += CODE_CHARS[randomValues[i] % CODE_CHARS.length];
    }
    return code;
}

// The name shown to teammates. Firebase Auth's own displayName is empty for
// anyone who signed up with email/password (only Google sign-in sets it),
// so we keep an explicit, editable one on the user's own profile doc and
// prefer that. Loaded once at sign-in (see loadProfileName below).
let profileDisplayName = null;

function displayNameFor(user) {
    return profileDisplayName || user.displayName || user.email || 'Unnamed';
}

async function loadProfileName(user, onLoaded) {
    const { doc, getDoc } = fs();
    try {
        const snapshot = await getDoc(doc(db(), 'users', user.uid));
        const data = snapshot.exists() ? snapshot.data() : null;
        profileDisplayName = (data && data.displayName) ? data.displayName : null;
    } catch (error) {
        console.error('Failed to load your profile name:', error);
        profileDisplayName = null;
    }
    onLoaded?.(displayNameFor(user));
}

// Saving only changes your name for groups you create or join from now on -
// it does not rename you in memberNames on groups you already joined, since
// the security rule for joining only allows appending a new member, not
// editing an existing one's name in place (a narrower "rename yourself"
// rule is possible later if this turns out to matter).
async function saveProfileName(user, name) {
    const trimmed = name.trim();
    if (!trimmed) {
        return;
    }
    const { doc, setDoc } = fs();
    await setDoc(doc(db(), 'users', user.uid), { displayName: trimmed }, { merge: true });
    profileDisplayName = trimmed;
}

// A group's memberNames array is only as fresh as whenever each person last
// created or joined - it's never rewritten after that. Every task a person
// owns is re-stamped with their current name on every write though, so the
// freshest name we actually have for anyone is whatever their most recently
// updated task says - fall back to the stored membership name, then a
// generic label, only if they have no tasks yet (or the caller has no task
// list handy, like the groups browse page).
function resolveMemberName(memberId, storedName, tasksForFreshness = []) {
    const theirTasks = tasksForFreshness.filter((task) => task.ownerId === memberId && task.ownerName);
    if (theirTasks.length > 0) {
        const freshest = [...theirTasks].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))[0];
        return freshest.ownerName;
    }
    return storedName || 'Teammate';
}

// The invite code IS the group's document ID (not a separate lookup field).
// That lets someone join a group by writing directly to groups/{code} before
// they're a member, which firestore.rules can allow narrowly (append only
// your own uid + name, nothing else) without needing a Cloud Function.
async function createGroup(name, user) {
    const trimmedName = name.trim();
    if (!trimmedName) {
        throw new Error('Give your group a name.');
    }

    const { doc, setDoc, serverTimestamp } = fs();
    const maxAttempts = 5;
    let lastError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const code = generateInviteCode();
        try {
            await setDoc(doc(db(), 'groups', code), {
                name: trimmedName,
                ownerId: user.uid,
                memberIds: [user.uid],
                memberNames: [displayNameFor(user)],
                inviteCode: code,
                createdAt: serverTimestamp()
            });
            return code;
        } catch (error) {
            // A code collision is rejected by the security rule (it isn't a
            // valid "create" or a valid "join" write) - just try another
            // random code rather than surfacing an error for that.
            lastError = error;
        }
    }

    throw lastError || new Error('Could not create a group. Please try again.');
}

async function joinGroup(code, user) {
    const normalizedCode = code.trim().toUpperCase();
    if (!normalizedCode) {
        throw new Error('Enter an invite code.');
    }

    const { doc, updateDoc, arrayUnion } = fs();
    await updateDoc(doc(db(), 'groups', normalizedCode), {
        memberIds: arrayUnion(user.uid),
        memberNames: arrayUnion(displayNameFor(user))
    });

    return normalizedCode;
}

// Rebuilds memberIds/memberNames with your own entry spliced out (rather
// than arrayRemove-by-value) so it works even if the stored name at your
// index has gone stale - see resolveMemberName - and matches the security
// rule's "member count shrinks by exactly one, you're the one now missing"
// check regardless of what your display name currently resolves to.
async function leaveGroup(groupId, user) {
    const { doc, getDoc, updateDoc } = fs();
    const groupRef = doc(db(), 'groups', groupId);
    const snapshot = await getDoc(groupRef);
    if (!snapshot.exists()) {
        return;
    }

    const data = snapshot.data();
    const memberIds = data.memberIds || [];
    const memberNames = data.memberNames || [];
    const myIndex = memberIds.indexOf(user.uid);
    if (myIndex === -1) {
        return;
    }
    if (data.ownerId === user.uid) {
        throw new Error('The group owner can\'t leave - delete the group instead.');
    }

    await updateDoc(groupRef, {
        memberIds: memberIds.filter((_, index) => index !== myIndex),
        memberNames: memberNames.filter((_, index) => index !== myIndex)
    });
}

// Owner-only (enforced by the security rule, not checked client-side here -
// a non-owner's write would just be rejected).
async function renameGroup(groupId, newName) {
    const trimmedName = newName.trim();
    if (!trimmedName) {
        return;
    }
    const { doc, updateDoc } = fs();
    await updateDoc(doc(db(), 'groups', groupId), { name: trimmedName.slice(0, 80) });
}

// Owner-only. Deletes every task in the group (the security rule lets the
// group's owner delete any member's task, not just their own, specifically
// for this) before deleting the group document itself, so nothing is left
// orphaned in Firestore.
async function deleteGroupCompletely(groupId, user) {
    const { doc, getDoc, getDocs, collection, deleteDoc } = fs();
    const groupRef = doc(db(), 'groups', groupId);
    const snapshot = await getDoc(groupRef);
    if (!snapshot.exists()) {
        return;
    }
    if (snapshot.data().ownerId !== user.uid) {
        throw new Error('Only the group\'s owner can delete it.');
    }

    const tasksSnapshot = await getDocs(collection(db(), 'groups', groupId, 'tasks'));
    await Promise.all(tasksSnapshot.docs.map((taskDoc) => deleteDoc(taskDoc.ref)));

    await deleteDoc(groupRef);
}

function subscribeToMyGroups(uid, callback, onError) {
    const { collection, query, where, onSnapshot } = fs();
    const myGroupsQuery = query(collection(db(), 'groups'), where('memberIds', 'array-contains', uid));
    return onSnapshot(myGroupsQuery, (snapshot) => {
        callback(snapshot.docs.map((groupDoc) => ({ id: groupDoc.id, ...groupDoc.data() })));
    }, onError);
}
