// Cloud Functions for Lyric Bloom.
//
// fetchLyrics: when the app creates users/{uid}/songs/{songId} with an
// { artist, title, duration? }, look the lyrics up and write them back onto
// the song doc:
//   lyricBank   [{ id, text }]                 always, same shape LyricBloom.jsx
//                                              keeps in its lyric bank
//   timedLines  [{ text, start, duration }]    only when timestamped lyrics
//                                              exist, so the app can place
//                                              lines on the timeline directly
//
// Sources, in order: LRCLIB (free, often has timestamped lyrics), then
// lyrics.ovh (plain text only) as a fallback.
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions';

// The project's Firestore database is named "lyricbloom" rather than the
// usual "(default)", so both the Admin SDK and the trigger must name it.
const DATABASE_ID = 'lyricbloom';

initializeApp();
const db = getFirestore(DATABASE_ID);

const LRCLIB_API = 'https://lrclib.net/api';
const LYRICS_OVH_API = 'https://api.lyrics.ovh/v1';
// LRCLIB asks clients to identify themselves.
const USER_AGENT = 'LyricBloom/0.1 (Firebase Cloud Function)';
// Don't let one hung request eat the function's whole timeout.
const FETCH_TIMEOUT_MS = 15_000;

// Timed-line lengths when the lyrics don't say where a line ends: the last
// line gets LAST_LINE_SECONDS, and a line followed by a long instrumental
// gap is capped at MAX_LINE_SECONDS instead of stretching across it.
const LAST_LINE_SECONDS = 4;
const MAX_LINE_SECONDS = 8;

// "Taylor Swift" + "Love Story" -> "taylor swift__love story". Used as the
// lyricsCache doc id so the same song is only fetched once.
function cacheKey(artist, title) {
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim().replaceAll('/', '-');
  return `${norm(artist)}__${norm(title)}`;
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${new URL(url).host} responded ${res.status}`);
  return res.json();
}

// LRCLIB: exact match first (duration helps it pick the right version of the
// song), then its looser search. Returns { plain, synced } or null.
async function lookupLrclib(artist, title, duration) {
  const params = new URLSearchParams({ artist_name: artist, track_name: title });
  if (duration) params.set('duration', String(Math.round(duration)));

  let track = await getJson(`${LRCLIB_API}/get?${params}`);
  if (!track) {
    const results = await getJson(
      `${LRCLIB_API}/search?${new URLSearchParams({ artist_name: artist, track_name: title })}`
    );
    // Prefer a result with timestamps, but take plain lyrics over nothing.
    track = results?.find((r) => r.syncedLyrics) ?? results?.find((r) => r.plainLyrics) ?? null;
  }
  if (!track || track.instrumental) return null;

  const plain = track.plainLyrics?.trim() || null;
  const synced = track.syncedLyrics?.trim() || null;
  return plain || synced ? { plain, synced } : null;
}

async function lookupLyricsOvh(artist, title) {
  const data = await getJson(`${LYRICS_OVH_API}/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`);
  const plain = data?.lyrics?.trim();
  return plain ? { plain, synced: null } : null;
}

// Try each source in turn. A source that errors (down, slow) is logged and
// skipped. Only if every source errors does this throw, so a real "no
// lyrics anywhere" is distinguishable from "couldn't reach anyone".
async function lookupLyrics(artist, title, duration) {
  const sources = [
    ['lrclib', () => lookupLrclib(artist, title, duration)],
    ['lyrics.ovh', () => lookupLyricsOvh(artist, title)],
  ];
  let failures = 0;
  for (const [source, lookup] of sources) {
    try {
      const found = await lookup();
      if (found) return { ...found, source };
    } catch (err) {
      failures += 1;
      logger.warn(`${source} lookup failed`, { artist, title, error: err.message });
    }
  }
  if (failures === sources.length) throw new Error('All lyrics sources failed');
  return null;
}

// Parse LRC ("[01:02.34] line") into [{ text, start, duration }]. A line can
// carry several timestamps ("[00:12.00][01:30.00] chorus") when it repeats.
// Empty timestamped lines mark where the previous line ends; they don't
// become lines themselves.
export function parseSyncedLyrics(lrc) {
  const stamp = /\[(\d+):(\d+(?:\.\d+)?)\]/g;
  const events = []; // { start, text } — text '' is an end marker
  for (const raw of lrc.split(/\r?\n/)) {
    const times = [...raw.matchAll(stamp)].map((m) => Number(m[1]) * 60 + Number(m[2]));
    if (times.length === 0) continue; // metadata tags like [ar:…] have no mm:ss
    const text = raw.replace(stamp, '').trim();
    for (const start of times) events.push({ start, text });
  }
  events.sort((a, b) => a.start - b.start);

  const lines = [];
  events.forEach((event, i) => {
    if (!event.text) return;
    const next = events[i + 1];
    const duration = next
      ? Math.min(next.start - event.start, MAX_LINE_SECONDS)
      : LAST_LINE_SECONDS;
    if (duration <= 0) return; // two lines on the same timestamp
    lines.push({
      text: event.text,
      start: Math.round(event.start * 100) / 100,
      duration: Math.round(duration * 100) / 100,
    });
  });
  return lines;
}

function toStubs(texts, songId) {
  return texts.map((text, i) => ({ id: `${songId}-${i}`, text }));
}

// One entry per non-empty line. Blank lines (verse breaks) are dropped,
// matching how the "Add to bank" textarea handles pasted text.
function plainLines(lyrics) {
  return lyrics.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export const fetchLyrics = onDocumentCreated(
  { document: 'users/{uid}/songs/{songId}', database: DATABASE_ID, timeoutSeconds: 60 },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const { artist, title, duration } = snap.data();
    const { songId } = event.params;

    if (!artist?.trim() || !title?.trim()) {
      await snap.ref.update({ lyricsStatus: 'missing_info' });
      return;
    }

    await snap.ref.update({ lyricsStatus: 'fetching' });

    try {
      const cacheRef = db.collection('lyricsCache').doc(cacheKey(artist, title));
      const cached = await cacheRef.get();

      let found;
      // Entries cached before the LRCLIB switch have no `source` field;
      // look those up again rather than trusting an old lyrics.ovh miss.
      if (cached.exists && cached.get('source') !== undefined) {
        const { plain, synced, source } = cached.data();
        found = source ? { plain, synced, source } : null;
      } else {
        found = await lookupLyrics(artist.trim(), title.trim(), duration);
        // Cache misses too, so repeated lookups of an unknown song don't
        // keep hitting the APIs.
        await cacheRef.set({
          artist,
          title,
          plain: found?.plain ?? null,
          synced: found?.synced ?? null,
          source: found?.source ?? null,
          fetchedAt: FieldValue.serverTimestamp(),
        });
      }

      if (!found) {
        await snap.ref.update({ lyricsStatus: 'not_found' });
        return;
      }

      const timedLines = found.synced ? parseSyncedLyrics(found.synced) : [];
      const texts = timedLines.length ? timedLines.map((l) => l.text) : plainLines(found.plain ?? '');

      await snap.ref.update({
        lyricBank: toStubs(texts, songId),
        timedLines: timedLines.length ? timedLines : FieldValue.delete(),
        lyricsSource: found.source,
        lyricsStatus: 'ready',
        lyricsFetchedAt: FieldValue.serverTimestamp(),
      });
    } catch (err) {
      logger.error('fetchLyrics failed', { artist, title, songId, error: err.message });
      await snap.ref.update({ lyricsStatus: 'error' });
    }
  },
);
