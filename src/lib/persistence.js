// Persists the editor's non-binary state (lyrics/timeline + settings menu
// values) to localStorage so a reload doesn't lose it. Uploaded audio/font/
// particle-shape files are deliberately excluded — they're raw binary blobs
// well past what localStorage is meant to hold, so those still need to be
// re-selected after a reload.
const STORAGE_KEY = 'lyric-bloom-state';

export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage full/unavailable (e.g. private browsing) — persistence is a
    // nice-to-have here, so fail silently rather than breaking the editor.
  }
}
