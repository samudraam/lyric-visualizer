# Firebase Setup — Lyrics Automation & Cloud Sync

Plan for moving Lyric Bloom from `localStorage`-only persistence (`src/lib/persistence.js`) to Firebase, with Google sign-in and automatic lyric-bank stubs fetched from [lyrics.ovh](https://lyricsovh.docs.apiary.io).

## Architecture

```
Google Sign-in (Firebase Auth)
        │  uid
        ▼
Firestore                                  Cloud Storage (bucket)
 users/{uid}/songs/{songId}                 users/{uid}/audio/{songId}.mp3
   artist, title, audioPath,                users/{uid}/fonts/…, shapes/…
   lyricsStatus, lyricBank[]  ◄── Cloud Function: on song created →
 users/{uid}/mixes/{mixId}          GET api.lyrics.ovh/v1/{artist}/{title}
   songId, placedBlocks[],          → split into lines → [{id, text}] stubs
   palette, colors, effect…
```

A **mix** is a song's timeline (`placedBlocks`) plus its settings. Mixes are stored under the user's Google account `uid`, so signing in on any device brings them back.

## Phase 1 — Cloud setup

### 1. Create the Firebase project
Go to [console.firebase.google.com](https://console.firebase.google.com), click **Add project**, and name it `lyric-bloom`.

### 2. Switch to the Blaze plan
Cloud Functions need Blaze, and the free plan doesn't let Functions call outside APIs like lyrics.ovh. At this usage it should cost about $0. Set a **budget alert** (for example $5) in Google Cloud Billing anyway.

### 3. Turn on services in the console
- **Authentication** → Sign-in method → enable **Google**
- **Firestore Database** → create in production mode, pick a region (for example `us-central1`)
- **Storage** → create the default bucket in the same region

### 4. Install the CLI and connect the repo
```bash
npm i -g firebase-tools
firebase login
firebase init   # select: Firestore, Functions (JavaScript), Storage, Hosting (public dir: dist), Emulators
```

### 5. Security rules — users can only read and write their own data
`firestore.rules`:
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid}/{doc=**} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```

`storage.rules`:
```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{uid}/{allPaths=**} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```

### 6. Lyrics Cloud Function
`functions/index.js`: a Firestore trigger, so creating a song fetches its lyrics automatically. Calling lyrics.ovh from the server also avoids CORS problems in the browser.

```js
import { onDocumentCreated } from 'firebase-functions/v2/firestore';

export const fetchLyrics = onDocumentCreated('users/{uid}/songs/{songId}', async (e) => {
  const { artist, title } = e.data.data();
  const res = await fetch(
    `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`
  );
  if (!res.ok) return e.data.ref.update({ lyricsStatus: 'not_found' });

  const { lyrics } = await res.json();
  const lyricBank = lyrics
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((text, i) => ({ id: `${e.params.songId}-${i}`, text }));

  await e.data.ref.update({ lyricBank, lyricsStatus: 'ready' });
});
```

Later, you can add a `lyricsCache/{artist__title}` collection so the same song isn't fetched twice.

### 7. Test locally
```bash
firebase emulators:start
```
Add a song doc in the Emulator UI and check that its `lyricBank` fills in.

### 8. Deploy
```bash
firebase deploy --only functions,firestore,storage
```

## Phase 2 — App wiring

9. Run `npm i firebase`, add `src/lib/firebase.js` (config and Auth), and add a **Sign in with Google** button.
10. Replace `src/lib/persistence.js` with debounced Firestore reads and writes. Keep `localStorage` as an offline fallback.
11. Add a song picker: enter artist and title, which creates a song doc, then subscribe to `lyricBank` and load it into the lyric bank.
12. Upload audio, fonts and particle shapes to Storage. This fixes the current problem where audio has to be picked again after every reload.

## Things to know

- **lyrics.ovh isn't reliable.** It's an unofficial free API that is often slow or down and misses songs. The `lyricsStatus` field lets the UI fall back to "not found, paste it manually."
- **Copyright:** keeping lyrics private to each user's account is fine for personal use. Don't make other people's mixes public without a licensed source (for example Musixmatch).
- **Google Drive:** "in your Google account" here means signing in with Google and seeing your mixes. Exporting mixes as files to Google Drive would be a separate step using the Drive API.
