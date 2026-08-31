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
// every request carries a token. Stays in "Monitor" mode with no real
// effect until Firestore/Authentication are switched to "Enforced" in the
// Firebase Console's App Check page - don't flip that until real traffic
// through this app is showing up as verified there.
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

window.ToDoAuth = {
    auth,
    db,
    firestore: {
        doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, arrayUnion, arrayRemove,
        collection, query, where, orderBy, limit, onSnapshot, writeBatch, serverTimestamp, increment
    },
    signInWithGoogle: () => signInWithPopup(auth, googleProvider),
    signUpWithEmail: (email, password) => createUserWithEmailAndPassword(auth, email, password),
    signInWithEmail: (email, password) => signInWithEmailAndPassword(auth, email, password),
    sendPasswordReset: (email) => sendPasswordResetEmail(auth, email),
    signOutUser: () => signOut(auth),
    // Deletes the Firebase Auth account itself (not Firestore data - callers
    // should delete a user's profile/tasks/group memberships first). Throws
    // 'auth/requires-recent-login' if the session is old; callers should
    // catch that and prompt a fresh sign-in before retrying.
    deleteAccountAuth: () => deleteUser(auth.currentUser),
    // callback(user, isFirstTimeEver) - the second argument is only ever
    // true the one time a brand-new account's profile doc gets created.
    onAuthChange: (callback) => onAuthStateChanged(auth, async (user) => {
        let isFirstTime = false;
        if (user) {
            try {
                isFirstTime = await ensureUserProfile(user);
            } catch (error) {
                console.error('Failed to write user profile:', error);
            }
        }
        callback(user, isFirstTime);
    })
};

window.dispatchEvent(new CustomEvent('todoauth:ready'));
