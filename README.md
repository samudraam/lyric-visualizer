# Lyric Bloom

A browser-based lyric video editor. Load a song, arrange its lyrics on a timeline, and watch them bloom over an audio-reactive particle visualizer. Lyrics can be fetched automatically, often with line-by-line timestamps. Mixes are saved to your Google account, so they follow you across devices.

Built with React 19 + Vite, Three.js, vfx-js and Tailwind CSS 4, with Firebase (Auth, Firestore, Cloud Functions) behind it.

---

## Features

### Editor
- **Audio playback** from any local audio file, with a scrubbable ruler, a playhead and a time readout.
- **Lyric bank.** Paste lyrics one line per row (<kbd>Ctrl/Cmd</kbd>+<kbd>Enter</kbd> adds them), or fetch them with **Find lyrics**. Each line becomes a chip you can drag onto the timeline. The × on a chip removes it.
- **Timeline blocks.**
  - Drag a block to move it, or drag its right edge to resize it.
  - Click a block to edit its look.
  - Double-click a block to send it back to the bank.
- **Move everything at once.** Press <kbd>S</kbd> to select every block, then drag any one of them to shift the whole song. Spacing between lines is kept, and the group can't go past either end of the timeline.

### Stage (visualizer)
- **Falling particles** that pulse with the bass (a Web Audio `AnalyserNode` tracks low-frequency energy).
- **Custom particle shape:** upload a `.glb` model and it replaces the default soft sprites.
- **Active lyric** shown over the particles, with an optional WebGL text effect (vfx-js): Rainbow, RGB Shift, Glitch, Halftone, Duotone, Pixelate, and several transitions.
- **Pop-out window** that shows only the Stage and stays in sync with the editor over `BroadcastChannel`. Good for a second screen or screen capture.

### Styling (Settings menu)
- The palette (block and particle colors), the stage background gradient, the lyric text color and size, the particle size, the text effect, and an uploaded lyric font.
- **Per-block overrides:** click a block to give it its own text color, effect or font. Anything left unset uses the global setting.

### Automatic lyrics
- Enter an **artist and title** and press **Find lyrics**. A Cloud Function looks the song up on [LRCLIB](https://lrclib.net), falling back to [lyrics.ovh](https://lyricsovh.docs.apiary.io).
- **Timestamped lyrics go straight onto the timeline** at the right times, if the timeline is empty. Plain lyrics, or lyrics fetched while the timeline already has blocks, go to the lyric bank.
- If an audio file is loaded, its length is sent along so LRCLIB picks the version of the song that matches your file.
- Results are cached on the server, so each song is only fetched once.

### Cloud mixes
- **Sign in with Google** to save your work to Firestore. A *mix* is one song's timeline plus its settings.
- **Autosave:** edits are saved about a second after you stop, and again when the tab is hidden or closed.
- **Mix picker** in the header to switch between mixes or start a new one. A new mix is named after its song once lyrics are found.
- **Work from before sign-in is kept:** the first time you sign in, whatever is in the editor becomes your first mix.
- **Signed out,** everything still works and is saved to `localStorage` on this device.

### Keyboard shortcuts
| Key | Action |
|---|---|
| <kbd>Space</kbd> | Play / pause |
| <kbd>S</kbd> | Select all timeline blocks (press again to deselect) |
| <kbd>Esc</kbd> | Deselect all |
| <kbd>Ctrl/Cmd</kbd>+<kbd>Enter</kbd> | Add the pasted lyrics to the bank |

Shortcuts are ignored while you're typing in a text field.

---

## Getting started

```bash
npm install
npm run dev        # http://localhost:5173
```

The app runs against the live Firebase project (`lyric-bloom`) by default. To use local emulators instead:

```bash
firebase emulators:start               # terminal 1 (requires Java 21+)
VITE_USE_EMULATORS=true npm run dev    # terminal 2
```

Other scripts: `npm run build`, `npm run preview`, `npm run lint`.


## Project structure

```
src/
  main.jsx                entry point: renders the pop-out when opened with ?stage=1, otherwise App
  App.jsx                 renders the editor
  LyricBloom.jsx          the editor: audio, lyric bank, timeline, settings, shortcuts
  Stage.jsx               Three.js particles + active lyric + vfx-js text effects
  StagePopout.jsx         Stage-only window, driven by BroadcastChannel messages
  LyricFinder.jsx         artist/title search → fetchLyrics → onFound
  lib/
    firebase.js           Firebase app, Google sign-in, Firestore (db "lyricbloom")
    cloudMixes.js         Firestore reads and writes for mixes and songs
    useCloudMix.js        auth state, mix loading/switching, debounced autosave
    persistence.js        localStorage load/save
    palette.js            default colors and sizes
    textEffects.js        list of WebGL text effects
    font.js               uploaded-font loading (FontFace + inlined @font-face)
    stageChannel.js       BroadcastChannel name shared by editor and pop-out
functions/
  index.js                fetchLyrics Cloud Function (LRCLIB → lyrics.ovh, caching, LRC parsing)
firebase.json             Firestore / Functions / Storage / Hosting / emulator config
firestore.rules, storage.rules, firestore.indexes.json
FIREBASE_SETUP.md         step-by-step cloud setup plan
```

---

## Firebase setup and deployment

See [FIREBASE_SETUP.md](FIREBASE_SETUP.md) for the full walkthrough. In short:

1. The Firebase project is `lyric-bloom`, on the **Blaze** plan (Functions need it to call outside APIs).
2. **Authentication** has the Google provider enabled. **Firestore** uses a database named **`lyricbloom`** in `nam5`. **Storage** uses the bucket `gs://lyric-bloom.firebasestorage.app`.
3. Deploy with:
   ```bash
   firebase deploy --only firestore,functions   # add "storage" once Storage rules are needed
   ```

### Things we ran into (and how they were fixed)

| Symptom | Cause | Fix |
|---|---|---|
| `Failed to get Firebase project health-xr-prototype1` | `firebase use` had been run on `~/Desktop`, and that setting applies to every folder beneath it, overriding this repo's `.firebaserc` | Run `firebase use lyric-bloom` inside this repo |
| `database '(default)' does not exist` | The Firestore database is named `lyricbloom`, not the standard `(default)` | Name it in `firebase.json` (`"database"`), in `getFirestore(DATABASE_ID)` and the trigger's `database` option in `functions/index.js`, and in `initializeFirestore(…, 'lyricbloom')` in `src/lib/firebase.js`. **All four must match.** |
| `Permission denied while using the Eventarc Service Agent` on the first functions deploy | Google Cloud permissions take a few minutes to take effect after services are first turned on | Wait a few minutes and deploy again |
| Emulator: `firebase-tools no longer supports Java version before 21` | Java 17 installed | `brew install openjdk@21` |
| Console: `Cross-Origin-Opener-Policy policy would block the window.closed call` | Harmless Chrome warning from Firebase's popup sign-in | Ignore it. Sign-in still completes. |
| `firebase init` finished but wrote no files | Init exited before its final write step | The config files were written by hand; they're what's in the repo now |

---


## Roadmap

- **Save uploaded files to Storage** (step 12 in `FIREBASE_SETUP.md`): audio, fonts and `.glb` shapes under `users/{uid}/…`, so a mix reopens with its media instead of needing files picked again. The rules are already written.
- **Hosting:** `npm run build && firebase deploy --only hosting` to put the app on `lyric-bloom.web.app`. Once it's there, sign-in could use a full-page redirect instead of a popup.
- **Delete and rename mixes** from the mix picker.
- **Finer timeline controls:** arrow-key nudging, shift-click to select several blocks, zoom.

---

## A note on lyrics and copyright

Song lyrics are copyrighted. LRCLIB and lyrics.ovh are community and unofficial sources. Keeping lyrics private in each user's own account is fine for personal use. Sharing mixes publicly, or any commercial use, needs a licensed provider such as Musixmatch or LyricFind.
