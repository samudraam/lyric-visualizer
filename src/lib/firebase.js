// Firebase app + the services the editor uses (Auth, Firestore).
//
// The web config comes from Vite env vars (see .env.example; real values
// live in the untracked .env.local). Note that Vite inlines VITE_* values
// into the browser bundle, so this keeps the key out of git, not out of the
// shipped site. What protects data is firestore.rules / storage.rules plus
// the key's website + API restrictions in Google Cloud. Never put a real
// server secret in a VITE_ variable; use Cloud Functions secrets instead.
import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, connectAuthEmulator } from 'firebase/auth';
import { initializeFirestore, connectFirestoreEmulator } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

// Fail loudly on a fresh clone instead of with a cryptic Firebase error.
const missing = Object.entries(firebaseConfig).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  throw new Error(`Missing Firebase config (${missing.join(', ')}). Copy .env.example to .env.local and fill it in.`);
}

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
