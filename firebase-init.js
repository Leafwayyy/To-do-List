// Bridges the Firebase modular SDK (ES modules, loaded via CDN) into the rest
// of the app, which is a classic (non-module) script for everything else.
// This file runs as a <script type="module">, so it always executes *after*
// script.js (module scripts are deferred relative to classic scripts). See
// initAuthIntegration() in script.js, which waits for the "ready" signal
// below before touching window.ToDoAuth.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-app-check.js';
import {
    getAuth,
    GoogleAuthProvider,
    signInWithPopup,
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    sendPasswordResetEmail,
    sendEmailVerification,
    signOut,   
    deleteUser,
    onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js';
import {
    initializeFirestore,
    persistentLocalCache,
    persistentMultipleTabManager,
    doc,
    getDoc,
    getDocs,
    getCountFromServer,
    setDoc,
    updateDoc,
    deleteDoc,
    arrayUnion,
    arrayRemove,
    collection,
    query,
    where,
    orderBy,
    limit,
    onSnapshot,
    writeBatch,
    runTransaction,
    serverTimestamp,
    increment
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';

const firebaseConfig = {
    apiKey: 'AIzaSyAgOBEtpfNjpz9DhX4EHrpbGLHrcnMRVPg',
    authDomain: 'todo-list-507018.firebaseapp.com',
    projectId: 'todo-list-507018',
    storageBucket: 'todo-list-507018.firebasestorage.app',
    messagingSenderId: '926156613912',
    appId: '1:926156613912:web:fcfa652f710d85ba31166d',
    measurementId: 'G-QXL2PZ55ZV'
};

const app = initializeApp(firebaseConfig);

// App Check: proves requests are coming from this real web app (via an
// invisible reCAPTCHA Enterprise score check), not a script hitting the
// Firebase project directly. Must run before any Auth/Firestore calls so
// every request carries a token.
//
// Current real state (verified 2026-09-25, not assumed): App Check is NOT
// enforced for Authentication or Firestore - a fresh localhost sign-up,
// sign-in and Firestore read/write all succeeded with every token exchange
// failing. And no token exchange succeeds anywhere, production included:
// the browser API key's API restrictions (Google Cloud Console -> APIs &
// Services -> Credentials) don't allow the "Firebase App Check API", so
// both exchangeRecaptchaEnterpriseToken (live site) and exchangeDebugToken
// (localhost) get a 403 API_KEY_SERVICE_BLOCKED before reCAPTCHA or the
// debug token is even looked at. That's why the App Check console shows
// 100% unverified traffic. Allow that API on the key BEFORE ever turning
// enforcement on, or every real user gets locked out.
//
// Once the key allows it: on localhost the reCAPTCHA Enterprise site key
// (scoped to the production domain) can't produce a valid token, so local
// dev uses the debug provider instead. Setting FIREBASE_APPCHECK_DEBUG_TOKEN
// before initializeAppCheck makes the SDK generate (and persist in
// IndexedDB) a debug token, printed to the console once; it must be
// registered in Firebase Console -> Project Settings -> App Check -> this
// app -> Manage debug tokens. Gated to localhost/127.0.0.1 only, so this
// never touches production's real reCAPTCHA flow.
if (['localhost', '127.0.0.1'].includes(window.location.hostname)) {
    self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
}

initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider('6Lfl5p8tAAAAACAMGgsF09HtWiRrawm2-hrVxTNs'),
    isTokenAutoRefreshEnabled: true
});

const auth = getAuth(app);
// Persistent local cache means the solo list keeps working offline and
// across a page reload before the network round-trip finishes, backed by
// IndexedDB instead of the old localStorage-only approach. Multi-tab manager
// so having the app open in two tabs doesn't fight over the cache.
const db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});
const googleProvider = new GoogleAuthProvider();

// Creates the users/{uid} profile doc the first time someone signs in.
// Safe to call on every sign-in — it's a no-op once the doc already exists.
// Returns whether this was the very first time we've ever seen this uid -
// a simpler, more reliable "is this a new user" signal than Firebase Auth's
// own isNewUser flag (which only reflects the specific sign-in method used,
// not "has this account ever completed setup before"), and it's exactly
// what the onboarding tour/name prompt need to decide whether to auto-run.
async function ensureUserProfile(user) {
    const userRef = doc(db, 'users', user.uid);
    const snapshot = await getDoc(userRef);
    if (snapshot.exists()) {
        return false;
    }
    await setDoc(userRef, {
        displayName: user.displayName || '',
        email: user.email || '',
        photoURL: user.photoURL || '',
        createdAt: serverTimestamp()
    });
    return true;
}

// Accounts created before this shipped already went through onboarding
// under the old (localStorage-only, or no) tour tracking - treat them as
// already toured so this never surprise-replays a tutorial on an existing
// user's next login. Only accounts created after this date are eligible
// for the account-level auto-play checkAndMarkTourSeen implements below.
const TOUR_TRACKING_LAUNCH = new Date('2026-08-30T00:00:00Z');

// Should THIS app's (solo/group) tour auto-play for this account, right
// now? Tracked per-app, not just per-account - someone might not open
// Group until long after signing up, and it should still get its own
// first-run tour then. Marks it seen the moment shouldAutoPlay is true (not
// on tour completion/skip), so an abandoned tour never re-triggers either -
// and since this lives on the account (not localStorage), it holds across
// every device, not just the one it first played on.
//
// Also returns isLegacyAccount, so callers can hide the passive "quick
// start" hint card's own "Start tutorial" prompt entirely for accounts
// that predate this feature - not just its usual per-browser dismiss
// state, which a legacy account signing in from a fresh browser would
// never have set, and would otherwise still see the prompt.
async function checkAndMarkTourSeen(user, appKey) {
    const userRef = doc(db, 'users', user.uid);
    const snapshot = await getDoc(userRef);
    const data = snapshot.exists() ? snapshot.data() : null;

    const createdAt = (data && data.createdAt && data.createdAt.toDate) ? data.createdAt.toDate() : null;
    const isLegacyAccount = !createdAt || createdAt < TOUR_TRACKING_LAUNCH;
    if (isLegacyAccount) {
        return { shouldAutoPlay: false, isLegacyAccount: true };
    }
    if (data.toursSeen && data.toursSeen[appKey]) {
        return { shouldAutoPlay: false, isLegacyAccount: false };
    }

    await setDoc(userRef, { toursSeen: { [appKey]: true } }, { merge: true });
    return { shouldAutoPlay: true, isLegacyAccount: false };
}

window.ToDoAuth = {
    auth,
    db,
    firestore: {
        doc, getDoc, getDocs, getCountFromServer, setDoc, updateDoc, deleteDoc, arrayUnion, arrayRemove,
        collection, query, where, orderBy, limit, onSnapshot, writeBatch, runTransaction, serverTimestamp, increment
    },
    signInWithGoogle: () => signInWithPopup(auth, googleProvider),
    // A new email-and-password account is sent Firebase's own "verify your email" message right
    // away (best effort - signing up never fails because of it). Email notifications only go to
    // verified addresses, so this is what lets those accounts receive them.
    signUpWithEmail: async (email, password) => {
        const credential = await createUserWithEmailAndPassword(auth, email, password);
        sendEmailVerification(credential.user).catch((error) => console.warn('Could not send the verification email:', error));
        return credential;
    },
    sendVerificationEmail: () => sendEmailVerification(auth.currentUser),
    // Picks up "I clicked the link" without signing out and in again, and refreshes the token so
    // the email worker's own check sees the verified address too.
    reloadCurrentUser: async () => {
        await auth.currentUser.reload();
        await auth.currentUser.getIdToken(true);
        return auth.currentUser;
    },
    signInWithEmail: (email, password) => signInWithEmailAndPassword(auth, email, password),
    sendPasswordReset: (email) => sendPasswordResetEmail(auth, email),
    signOutUser: () => signOut(auth),
    // Deletes the Firebase Auth account itself (not Firestore data - callers
    // should delete a user's profile/tasks/group memberships first). Throws
    // 'auth/requires-recent-login' if the session is old; callers should
    // catch that and prompt a fresh sign-in before retrying.
    deleteAccountAuth: () => deleteUser(auth.currentUser),
    checkAndMarkTourSeen,
    // callback(user, profileReady) - profileReady is a Promise<boolean> that
    // resolves to whether this was the very first time we've ever seen this
    // uid, once the users/{uid} profile doc write (ensureUserProfile above)
    // has actually settled. Deliberately NOT awaited before calling
    // callback - hiding the sign-in gate and starting the app have no real
    // dependency on that Firestore round trip finishing, and awaiting it
    // here used to be exactly what left a brand-new sign-up stuck on the
    // sign-in screen (needing a manual refresh) whenever that write was
    // slow, which happens more often right after a Google popup sign-in
    // than an email/password one - the popup flow's extra cross-origin
    // handshake (the authDomain iframe Firebase uses to relay the popup
    // result back) takes longer to leave Firestore's connection with a
    // healthy, authenticated token than a same-origin password sign-in
    // does. Callers that actually need the doc to exist first (see
    // checkAndMarkTourSeen's callers in script.js/group.js, for the tour
    // auto-play decision) await profileReady themselves before reading it,
    // so that check still never races the doc's creation.
    onAuthChange: (callback) => onAuthStateChanged(auth, (user) => {
        const profileReady = user
            ? ensureUserProfile(user).catch((error) => {
                console.error('Failed to write user profile, retrying once:', error);
                // A transient failure here (network blip, brief auth-token
                // lag right after sign-up) would otherwise be silently
                // indistinguishable from "not a new user," with no retry -
                // one retry after a short delay covers the common transient
                // case without adding real latency to the common (already
                // succeeded) path.
                return new Promise((resolve) => setTimeout(resolve, 1500))
                    .then(() => ensureUserProfile(user))
                    .catch((retryError) => {
                        console.error('Failed to write user profile on retry:', retryError);
                        return false;
                    });
            })
            : Promise.resolve(false);
        callback(user, profileReady);
    })
};

window.dispatchEvent(new CustomEvent('todoauth:ready'));
