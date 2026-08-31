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

const GROUP_PRIVACY_VALUES = ['open', 'invite-only', 'closed'];

// The invite code IS the group's document ID (not a separate lookup field).
// That lets someone join a group by writing directly to groups/{code} before
// they're a member, which firestore.rules can allow narrowly (append only
// your own uid + name, nothing else) without needing a Cloud Function.
async function createGroup(name, user, privacy = 'open') {
    const trimmedName = name.trim();
    if (!trimmedName) {
        throw new Error('Give your group a name.');
    }
    const normalizedPrivacy = GROUP_PRIVACY_VALUES.includes(privacy) ? privacy : 'open';

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
                privacy: normalizedPrivacy,
                adminIds: [],
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

// A non-member can't read a group's doc (see firestore.rules' groups/{groupId}
// read rule) so there's no way to check its privacy before writing. Instead
// this tries the direct-join write first (only ever allowed by the rules
// when the group is 'open' or predates the privacy field), and if that's
// rejected, falls back to filing a join request (only ever allowed when the
// group is 'invite-only'). If both are rejected - closed group, bad code, or
// already a member - there's no readable signal left to tell those apart,
// so it surfaces one combined message.
async function joinGroup(code, user) {
    const normalizedCode = code.trim().toUpperCase();
    if (!normalizedCode) {
        throw new Error('Enter an invite code.');
    }

    const { doc, updateDoc, arrayUnion } = fs();
    try {
        await updateDoc(doc(db(), 'groups', normalizedCode), {
            memberIds: arrayUnion(user.uid),
            memberNames: arrayUnion(displayNameFor(user))
        });
        return { groupId: normalizedCode, status: 'joined' };
    } catch (directJoinError) {
        try {
            await requestToJoinGroup(normalizedCode, user);
            return { groupId: normalizedCode, status: 'requested' };
        } catch (requestError) {
            throw new Error("Could not join - the group may be closed, the code may be wrong, or you're already a member.");
        }
    }
}

// Files (or refiles, after a denial) a request to join an 'invite-only'
// group. The doc ID is your own uid, so this doubles as "at most one
// outstanding request per group per person" - {merge: true} makes the same
// call work whether the doc is brand new or being revived from 'denied'.
async function requestToJoinGroup(code, user) {
    const normalizedCode = code.trim().toUpperCase();
    const { doc, setDoc, serverTimestamp } = fs();
    await setDoc(doc(db(), 'groups', normalizedCode, 'joinRequests', user.uid), {
        uid: user.uid,
        name: displayNameFor(user),
        status: 'pending',
        requestedAt: serverTimestamp(),
        respondedAt: null
    }, { merge: true });
    return normalizedCode;
}

// Owner/admin-only (enforced by the security rule). Adds the requester as a
// member and clears their request in one batch, so a partial failure can't
// leave them "approved" without membership or "pending" without a request.
async function approveJoinRequest(groupId, requesterUid, requesterName) {
    const { doc, writeBatch, arrayUnion } = fs();
    const batch = writeBatch(db());
    batch.update(doc(db(), 'groups', groupId), {
        memberIds: arrayUnion(requesterUid),
        memberNames: arrayUnion(requesterName)
    });
    batch.delete(doc(db(), 'groups', groupId, 'joinRequests', requesterUid));
    await batch.commit();
}

// Owner/admin-only. Keeps the request doc around (status: 'denied') rather
// than deleting it, so the requester's own client can show them it was
// denied instead of the request just silently vanishing.
async function denyJoinRequest(groupId, requesterUid) {
    const { doc, updateDoc, serverTimestamp } = fs();
    await updateDoc(doc(db(), 'groups', groupId, 'joinRequests', requesterUid), {
        status: 'denied',
        respondedAt: serverTimestamp()
    });
}

function subscribeToJoinRequests(groupId, callback, onError) {
    const { collection, query, where, onSnapshot } = fs();
    const requestsQuery = query(
        collection(db(), 'groups', groupId, 'joinRequests'),
        where('status', '==', 'pending')
    );
    return onSnapshot(requestsQuery, (snapshot) => {
        callback(snapshot.docs.map((requestDoc) => ({ id: requestDoc.id, ...requestDoc.data() })));
    }, onError);
}

// Owner can remove anyone but themselves; an admin can only remove a plain
// member (not another admin, not the owner) - both checked client-side here
// for a clear error message, and enforced for real by the security rule.
// Splices by index (like leaveGroup) rather than arrayRemove-by-value, so it
// works even if a stored name has gone stale. If the person being removed
// was themselves an admin, they're dropped from adminIds in this same write
// - the rule requires that, so a kicked admin can never linger as one.
async function kickMember(groupId, actingUser, targetUid) {
    const { doc, getDoc, updateDoc } = fs();
    const groupRef = doc(db(), 'groups', groupId);
    const snapshot = await getDoc(groupRef);
    if (!snapshot.exists()) {
        return;
    }

    const data = snapshot.data();
    if (targetUid === data.ownerId) {
        throw new Error('You can\'t remove the group\'s owner.');
    }

    const isActingOwner = data.ownerId === actingUser.uid;
    const adminIds = data.adminIds || [];
    if (!isActingOwner && adminIds.includes(targetUid)) {
        throw new Error('Admins can\'t remove other admins.');
    }

    const memberIds = data.memberIds || [];
    const memberNames = data.memberNames || [];
    const index = memberIds.indexOf(targetUid);
    if (index === -1) {
        return;
    }

    const payload = {
        memberIds: memberIds.filter((_, i) => i !== index),
        memberNames: memberNames.filter((_, i) => i !== index)
    };
    if (isActingOwner && adminIds.includes(targetUid)) {
        payload.adminIds = adminIds.filter((uid) => uid !== targetUid);
    }
    await updateDoc(groupRef, payload);
}

// Owner-only (enforced by the security rule). Promotes/demotes a co-leader-
// style admin tier - see firestore.rules for exactly what admins can and
// can't do relative to plain members.
async function setMemberRole(groupId, targetUid, makeAdmin) {
    const { doc, updateDoc, arrayUnion, arrayRemove } = fs();
    await updateDoc(doc(db(), 'groups', groupId), {
        adminIds: makeAdmin ? arrayUnion(targetUid) : arrayRemove(targetUid)
    });
}

// Owner-only (enforced by the security rule).
async function setGroupPrivacy(groupId, privacy) {
    if (!GROUP_PRIVACY_VALUES.includes(privacy)) {
        throw new Error('Not a valid privacy setting.');
    }
    const { doc, updateDoc } = fs();
    await updateDoc(doc(db(), 'groups', groupId), { privacy });
}

// Rebuilds memberIds/memberNames with your own entry spliced out (rather
// than arrayRemove-by-value) so it works even if the stored name at your
// index has gone stale - see resolveMemberName - and matches the security
// rule's "member count shrinks by exactly one, you're the one now missing"
// check regardless of what your display name currently resolves to.
//
// If you're the owner, ownership is handed to one of the remaining members
// in this same write, picked at random client-side (the security rule just
// requires the new owner be a real remaining member, not any specific one -
// see the "owner leaving" branch in firestore.rules). If you're the owner
// and nobody else is left, there's nobody to hand off to - deleteGroupCompletely
// is the only way out of that one.
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

    const remainingIds = memberIds.filter((_, index) => index !== myIndex);
    const remainingNames = memberNames.filter((_, index) => index !== myIndex);
    const adminIds = data.adminIds || [];
    const isOwner = data.ownerId === user.uid;

    if (isOwner && remainingIds.length === 0) {
        throw new Error('You\'re the only member left - delete the group instead of leaving it.');
    }

    const payload = {
        memberIds: remainingIds,
        memberNames: remainingNames
    };

    if (isOwner) {
        const newOwnerId = remainingIds[Math.floor(Math.random() * remainingIds.length)];
        payload.ownerId = newOwnerId;
        // The new owner can't also linger as their own admin (mirrors the
        // owner/admin invariant setMemberRole's rule enforces), and your own
        // admin status (if any) leaves with you same as the non-owner path
        // below.
        payload.adminIds = adminIds.filter((uid) => uid !== newOwnerId && uid !== user.uid);
    } else if (adminIds.includes(user.uid)) {
        // Drop your own admin status in the same write, if you had it - the
        // security rule requires this (an admin who leaves without it would
        // keep a stale, still-privileged entry in adminIds forever).
        payload.adminIds = adminIds.filter((uid) => uid !== user.uid);
    }

    await updateDoc(groupRef, payload);
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

// Owner-only. Deletes every history entry and join request in the group
// (the security rule lets the owner delete any of those) plus the owner's
// OWN tasks, then the group document itself. Deliberately does NOT delete
// other members' tasks - the owner never gets standing permission to
// remove a teammate's task, not even here - so those docs are left behind,
// orphaned: unreachable through the app once the group document they're
// nested under is gone (their read rule needs it), but never silently
// rewritten or removed out from under whoever owns them.
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
    const ownTaskDocs = tasksSnapshot.docs.filter((taskDoc) => taskDoc.data().ownerId === user.uid);
    await Promise.all(ownTaskDocs.map((taskDoc) => deleteDoc(taskDoc.ref)));

    const historySnapshot = await getDocs(collection(db(), 'groups', groupId, 'history'));
    await Promise.all(historySnapshot.docs.map((entryDoc) => deleteDoc(entryDoc.ref)));

    const joinRequestsSnapshot = await getDocs(collection(db(), 'groups', groupId, 'joinRequests'));
    await Promise.all(joinRequestsSnapshot.docs.map((requestDoc) => deleteDoc(requestDoc.ref)));

    await deleteDoc(groupRef);
}

function subscribeToMyGroups(uid, callback, onError) {
    const { collection, query, where, onSnapshot } = fs();
    const myGroupsQuery = query(collection(db(), 'groups'), where('memberIds', 'array-contains', uid));
    return onSnapshot(myGroupsQuery, (snapshot) => {
        callback(snapshot.docs.map((groupDoc) => ({ id: groupDoc.id, ...groupDoc.data() })));
    }, onError);
}
