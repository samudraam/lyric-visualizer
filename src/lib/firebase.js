// Firebase app + the services the editor uses (Auth, Firestore).
//
// This web config is safe to commit: it only identifies the project. What a
// client can actually read/write is enforced by firestore.rules /
// storage.rules, not by keeping these values secret.
import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, connectAuthEmulator } from 'firebase/auth';
import { initializeFirestore, connectFirestoreEmulator } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: 'AIzaSyD6l6ziSDODaeSCnCLAMvGNV1s3wOUHnTg',
  authDomain: 'lyric-bloom.firebaseapp.com',
  projectId: 'lyric-bloom',
  storageBucket: 'lyric-bloom.firebasestorage.app',
  messagingSenderId: '361284680008',
  appId: '1:361284680008:web:3123971c9494dbf0fedb7d',
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);

// Placed blocks carry optional per-chip overrides that are `undefined` when
// unset (see updateSelectedBlock in LyricBloom.jsx). Firestore rejects
// undefined values outright, so drop them on write instead.
// The project's database is named "lyricbloom", not "(default)" — this must
// match firebase.json and DATABASE_ID in functions/index.js.
export const db = initializeFirestore(app, { ignoreUndefinedProperties: true }, 'lyricbloom');

// `VITE_USE_EMULATORS=true npm run dev` points the app at
// `firebase emulators:start` instead of the live project.
if (import.meta.env.VITE_USE_EMULATORS === 'true') {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}

const googleProvider = new GoogleAuthProvider();

export function signInWithGoogle() {
  return signInWithPopup(auth, googleProvider).catch((err) => {
    // Closing the popup isn't an error worth surfacing.
    if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') return null;
    throw err;
  });
}

export function signOutUser() {
  return signOut(auth);
}
