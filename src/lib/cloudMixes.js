// Firestore reads/writes for a signed-in user's mixes and songs.
//
//   users/{uid}/mixes/{mixId}  { title, state, createdAt, updatedAt }
//     state = the same object persistence.js keeps in localStorage
//     (lyricBank, placedBlocks, nextId, palette, stage/lyric settings).
//   users/{uid}/songs/{songId} { artist, title, duration?, lyricsStatus,
//                                lyricBank, timedLines? }
//     created here; everything after duration is filled in by the
//     fetchLyrics Cloud Function (functions/index.js).
import {
  collection, doc, addDoc, updateDoc, onSnapshot, query, orderBy, serverTimestamp,
} from 'firebase/firestore';
import { db } from './firebase.js';

export const UNTITLED_MIX = 'Untitled mix';

const mixesCol = (uid) => collection(db, 'users', uid, 'mixes');
const songsCol = (uid) => collection(db, 'users', uid, 'songs');

// Live list of the user's mixes, most recently edited first. Each entry
// includes its full `state`, so opening a mix needs no extra read.
export function watchMixes(uid, onChange, onError) {
  const q = query(mixesCol(uid), orderBy('updatedAt', 'desc'));
  return onSnapshot(q, (snap) => onChange(snap.docs.map((d) => ({ id: d.id, ...d.data() }))), onError);
}

export async function createMix(uid, state, title = UNTITLED_MIX) {
  const ref = await addDoc(mixesCol(uid), {
    title,
    state: state ?? {},
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

// Replaces the whole `state` field (rather than merging into it), so
// removed blocks/bank lines don't linger.
export function saveMix(uid, mixId, state) {
  return updateDoc(doc(mixesCol(uid), mixId), { state, updatedAt: serverTimestamp() });
}

export function renameMix(uid, mixId, title) {
  return updateDoc(doc(mixesCol(uid), mixId), { title });
}

// Creating the song doc is what triggers the fetchLyrics function. Passing
// the loaded audio's duration (seconds) helps it pick the matching version
// of the song, so timestamps line up with the file.
export async function requestLyrics(uid, artist, title, duration) {
  const ref = await addDoc(songsCol(uid), {
    artist,
    title,
    ...(duration ? { duration } : {}),
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export function watchSong(uid, songId, onChange, onError) {
  return onSnapshot(doc(songsCol(uid), songId), (snap) => onChange(snap.data()), onError);
}
