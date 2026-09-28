// Cloud Functions for Lyric Bloom.
//
// fetchLyrics: when the app creates users/{uid}/songs/{songId} with an
// { artist, title }, look the lyrics up on lyrics.ovh and write them back as
// lyric-bank stubs ([{ id, text }], the same shape LyricBloom.jsx keeps in
// lyricBank) so they show up ready to drag onto the timeline.
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions';

initializeApp();
const db = getFirestore();

const LYRICS_API = 'https://api.lyrics.ovh/v1';
// lyrics.ovh is slow at the best of times; don't let a hung request eat the
// function's whole timeout.
const FETCH_TIMEOUT_MS = 15_000;

// "Taylor Swift" + "Love Story" -> "taylor swift__love story". Used as the
// lyricsCache doc id so the same song is only ever fetched once.
function cacheKey(artist, title) {
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim().replaceAll('/', '-');
  return `${norm(artist)}__${norm(title)}`;
}

// Returns the raw lyrics string, or null if lyrics.ovh doesn't have the song.
// Throws on network/server errors so those are logged as failures rather
// than cached as "not found".
async function lookupLyrics(artist, title) {
  const url = `${LYRICS_API}/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`lyrics.ovh responded ${res.status}`);
  const { lyrics } = await res.json();
  return lyrics?.trim() ? lyrics : null;
}

// Split lyrics into one stub per non-empty line. Blank lines (verse breaks)
// are dropped, matching how the "Add to bank" textarea handles pasted text.
function toStubs(lyrics, songId) {
  return lyrics
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((text, i) => ({ id: `${songId}-${i}`, text }));
}

export const fetchLyrics = onDocumentCreated(
  { document: 'users/{uid}/songs/{songId}', timeoutSeconds: 60 },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const { artist, title } = snap.data();
    const { songId } = event.params;

    if (!artist?.trim() || !title?.trim()) {
      await snap.ref.update({ lyricsStatus: 'missing_info' });
      return;
    }

    await snap.ref.update({ lyricsStatus: 'fetching' });

    try {
      const cacheRef = db.collection('lyricsCache').doc(cacheKey(artist, title));
      const cached = await cacheRef.get();

      let lyrics;
      if (cached.exists) {
        lyrics = cached.get('lyrics');
      } else {
        lyrics = await lookupLyrics(artist.trim(), title.trim());
        // Cache misses too, so repeated lookups of an unknown song don't
        // keep hitting the API.
        await cacheRef.set({ artist, title, lyrics, fetchedAt: FieldValue.serverTimestamp() });
      }

      if (!lyrics) {
        await snap.ref.update({ lyricsStatus: 'not_found' });
        return;
      }

      await snap.ref.update({
        lyricBank: toStubs(lyrics, songId),
        lyricsStatus: 'ready',
        lyricsFetchedAt: FieldValue.serverTimestamp(),
      });
    } catch (err) {
      logger.error('fetchLyrics failed', { artist, title, songId, error: err.message });
      await snap.ref.update({ lyricsStatus: 'error' });
    }
  },
);
