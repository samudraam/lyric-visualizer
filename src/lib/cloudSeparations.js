// Cloud vocal/instrumental separation: upload a song, then watch the job.
//
//   Storage   users/{uid}/separations/{id}/input.<ext>      uploaded here
//             users/{uid}/separations/{id}/vocals.mp3        written by the job
//             users/{uid}/separations/{id}/instrumental.mp3  written by the job
//   Firestore users/{uid}/separations/{id}
//             { fileName, fileHash, inputPath, status, progress, vocalsPath,
//               instrumentalPath, durationSeconds, error, … }
//
// Creating the Firestore doc (after the upload finishes) triggers the
// startSeparation function, which launches the separate-stems Cloud Run
// Job (separation/worker.py). status: queued → starting → running → ready | error
import {
  collection, doc, setDoc, getDoc, getDocs, onSnapshot, query, where, orderBy, limit, serverTimestamp,
} from 'firebase/firestore';
import { ref, uploadBytesResumable, getBlob } from 'firebase/storage';
import { db, storage } from './firebase.js';

// Matches the upload cap in storage.rules.
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const separationsCol = (uid) => collection(db, 'users', uid, 'separations');

// SHA-256 of the file's bytes, as hex. Identifies a song by its content, so
// the same file is recognized even if it was renamed or re-downloaded.
export async function hashFile(file) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// A finished separation of this exact file, if there is one, so it can be
// reused instead of running (and paying for) the job again.
export async function findReadySeparation(uid, fileHash) {
  const q = query(separationsCol(uid), where('fileHash', '==', fileHash), where('status', '==', 'ready'), limit(1));
  const snap = await getDocs(q);
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}

export async function getSeparation(uid, separationId) {
  const snap = await getDoc(doc(separationsCol(uid), separationId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

// Live list of the user's finished separations, newest first. (Filtered
// here rather than in the query, so it needs no composite index.)
export function watchReadySeparations(uid, onChange, onError) {
  const q = query(separationsCol(uid), orderBy('createdAt', 'desc'), limit(100));
  return onSnapshot(
    q,
    (snap) => onChange(snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((s) => s.status === 'ready')),
    onError,
  );
}

// Uploads `file` and creates the separation doc. onUploadProgress gets 0..1.
// Resolves with the separation id once the job has been requested.
export async function startSeparation(uid, file, fileHash, onUploadProgress) {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`That file is ${(file.size / 1e6).toFixed(0)} MB; the limit is 50 MB.`);
  }
  const docRef = doc(separationsCol(uid)); // new id, nothing written yet
  const ext = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : 'audio';
  const inputPath = `users/${uid}/separations/${docRef.id}/input.${ext}`;

  const task = uploadBytesResumable(ref(storage, inputPath), file, { contentType: file.type || 'audio/mpeg' });
  await new Promise((resolve, reject) => {
    task.on('state_changed', (snap) => onUploadProgress?.(snap.bytesTransferred / snap.totalBytes), reject, resolve);
  });

  await setDoc(docRef, { fileName: file.name, fileHash, inputPath, status: 'queued', createdAt: serverTimestamp() });
  return docRef.id;
}

export function watchSeparation(uid, separationId, onChange, onError) {
  return onSnapshot(
    doc(separationsCol(uid), separationId),
    (snap) => onChange(snap.exists() ? { id: snap.id, ...snap.data() } : null),
    onError,
  );
}

// Fetches both finished stems as Blobs (for object URLs the <audio>
// elements can play and the Web Audio graph can read).
export async function downloadStems(separation) {
  const [vocals, instrumental] = await Promise.all([
    getBlob(ref(storage, separation.vocalsPath)),
    getBlob(ref(storage, separation.instrumentalPath)),
  ]);
  return { vocals, instrumental };
}
