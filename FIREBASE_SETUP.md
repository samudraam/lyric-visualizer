# Firebase Setup — Lyrics Automation & Cloud Sync

Plan for moving Lyric Bloom from `localStorage`-only persistence (`src/lib/persistence.js`) to Firebase, with Google sign-in and automatic lyrics fetched from [LRCLIB](https://lrclib.net) (timestamped when available), with [lyrics.ovh](https://lyricsovh.docs.apiary.io) as a fallback.

## Architecture

```
Google Sign-in (Firebase Auth)
        │  uid
        ▼
Firestore                                  Cloud Storage (bucket)
 users/{uid}/songs/{songId}                 users/{uid}/audio/{songId}.mp3
   artist, title, audioPath,                users/{uid}/fonts/…, shapes/…
   lyricsStatus, lyricBank[], ◄── Cloud Function: on song created →
   timedLines[]                     LRCLIB (fallback: lyrics.ovh)
 users/{uid}/mixes/{mixId}          → [{id, text}] stubs
   placedBlocks[], …                  + [{text, start, duration}] if timed
   palette, colors, effect…
```

A **mix** is a song's timeline (`placedBlocks`) plus its settings. Mixes are stored under the user's Google account `uid`, so signing in on any device brings them back.

## Phase 1 — Cloud setup

### 1. Create the Firebase project
Go to [console.firebase.google.com](https://console.firebase.google.com), click **Add project**, and name it `lyric-bloom`.

### 2. Switch to the Blaze plan
Cloud Functions need Blaze, and the free plan doesn't let Functions call outside APIs like LRCLIB. At this usage it should cost about $0. Set a **budget alert** (for example $5) in Google Cloud Billing anyway.

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
`functions/index.js` has `fetchLyrics`, a Firestore trigger on `users/{uid}/songs/{songId}`. It runs whenever the app creates a song doc (`artist`, `title`, and an optional `duration` in seconds). Calling the lyrics APIs from the server also avoids CORS problems in the browser.

1. It checks `lyricsCache/{artist__title}` first, so each song is only fetched once. Songs that aren't found are cached too.
2. It tries [LRCLIB](https://lrclib.net) first: free, no API key, and often has **timestamped** lyrics. It asks for an exact match (the duration helps it pick the right version of the song), then falls back to LRCLIB's search.
3. If LRCLIB has nothing, it tries lyrics.ovh, which only has plain text.
4. It writes these fields back onto the song doc:
   - `lyricBank: [{id, text}]`, always
   - `timedLines: [{text, start, duration}]`, when timestamps exist. Each line lasts until the next one starts, capped at 8 s; the last line gets 4 s.
   - `lyricsSource`: `lrclib` or `lyrics.ovh`
   - `lyricsStatus`: `fetching`, `ready`, `not_found`, `error` or `missing_info`

In the app, timed lines go straight onto an empty timeline. Otherwise they go to the lyric bank.

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

Steps 9–11 are implemented:

| File | Role |
|---|---|
| `src/lib/firebase.js` | Firebase app, Auth (Google popup), Firestore; switches to emulators when `VITE_USE_EMULATORS=true` |
| `src/lib/cloudMixes.js` | Firestore reads and writes for `users/{uid}/mixes` and `users/{uid}/songs` |
| `src/lib/useCloudMix.js` | Signs the user in or out, opens the last mix, saves edits (debounced to 1 s), switches between mixes and creates new ones |
| `src/LyricFinder.jsx` | Artist + title → creates a song doc → waits for `fetchLyrics` → adds the lines to the lyric bank |

Run against local emulators (requires Java 21+):
```bash
firebase emulators:start            # terminal 1
VITE_USE_EMULATORS=true npm run dev # terminal 2
```
Run against the live project with a plain `npm run dev`. This needs the Google provider enabled, Firestore created, and rules and functions deployed.

9. Run `npm i firebase`, add `src/lib/firebase.js` (config and Auth), and add a **Sign in with Google** button.
10. Replace `src/lib/persistence.js` with debounced Firestore reads and writes. Keep `localStorage` as an offline fallback.
11. Add a song picker: enter artist and title, which creates a song doc, then subscribe to `lyricBank` and load it into the lyric bank.
12. Upload audio, fonts and particle shapes to Storage. This fixes the current problem where audio has to be picked again after every reload.

## Things to know

- **Coverage isn't guaranteed.** LRCLIB is community-run and lyrics.ovh is unofficial and often down, so some songs won't be found. The `lyricsStatus` field lets the UI fall back to "not found, paste it manually."
- **Copyright:** keeping lyrics private to each user's account is fine for personal use. Don't make other people's mixes public without a licensed source (for example Musixmatch).
- **Google Drive:** "in your Google account" here means signing in with Google and seeing your mixes. Exporting mixes as files to Google Drive would be a separate step using the Drive API.
