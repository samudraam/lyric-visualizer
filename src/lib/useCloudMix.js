// Syncs the editor's persisted state (the same object persistence.js keeps
// in localStorage) with the signed-in user's mixes in Firestore.
//
// - Signed out: does nothing; the editor keeps running on localStorage alone.
// - On sign-in: opens the last mix used on this device (or the most recent
//   one). A user with no mixes yet gets one created from whatever is in the
//   editor right now, so work done before signing in isn't lost.
// - Edits are saved to the open mix after SAVE_DEBOUNCE_MS of quiet, so a
//   block drag (dozens of state updates) becomes one write.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { auth } from './firebase.js';
import { watchMixes, createMix, saveMix, renameMix, UNTITLED_MIX } from './cloudMixes.js';

const SAVE_DEBOUNCE_MS = 1000;
const lastMixKey = (uid) => `lyric-bloom-last-mix:${uid}`;

function rememberMix(uid, mixId) {
  try {
    localStorage.setItem(lastMixKey(uid), mixId);
  } catch {
    // Only a convenience — the most recent mix opens instead.
  }
}

function recallMix(uid) {
  try {
    return localStorage.getItem(lastMixKey(uid));
  } catch {
    return null;
  }
}

export function useCloudMix(persistedState, applyState) {
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [mixes, setMixes] = useState([]);
  const [mixId, setMixId] = useState(null);
  const [saveStatus, setSaveStatus] = useState('idle'); // idle | saving | saved | error

  // Live mirrors so the Firestore callbacks below (created once per sign-in)
  // always see the latest editor state and apply function.
  const applyRef = useRef(applyState);
  const stateRef = useRef(persistedState);
  useLayoutEffect(() => {
    applyRef.current = applyState;
    stateRef.current = persistedState;
  });

  const pendingRef = useRef(null); // { uid, mixId, state } waiting on the debounce
  const timerRef = useRef(null);
  // Set right before a mix's state is loaded into the editor, so the state
  // change that load causes isn't immediately written back as an "edit".
  const skipNextSaveRef = useRef(false);

  const flush = useCallback(() => {
    clearTimeout(timerRef.current);
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    setSaveStatus('saving');
    saveMix(pending.uid, pending.mixId, pending.state)
      .then(() => setSaveStatus('saved'))
      .catch((err) => {
        console.error('Saving mix failed', err);
        setSaveStatus('error');
      });
  }, []);

  const openMixData = useCallback((uid, mix) => {
    skipNextSaveRef.current = true;
    applyRef.current(mix.state ?? {});
    setMixId(mix.id);
    rememberMix(uid, mix.id);
  }, []);

  useEffect(() => {
    return onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthReady(true);
      if (!u) {
        setMixes([]);
        setMixId(null);
        setSaveStatus('idle');
      }
    });
  }, []);

  useEffect(() => {
    if (!user) return;
    const uid = user.uid;
    let initialized = false;

    const unsubscribe = watchMixes(
      uid,
      (list) => {
        setMixes(list);
        if (initialized) return;
        initialized = true;

        const remembered = recallMix(uid);
        const target = list.find((m) => m.id === remembered) ?? list[0];
        if (target) {
          openMixData(uid, target);
        } else {
          createMix(uid, stateRef.current).then((id) => {
            skipNextSaveRef.current = true;
            setMixId(id);
            rememberMix(uid, id);
          });
        }
      },
      (err) => {
        console.error('Loading mixes failed', err);
        setSaveStatus('error');
      },
    );

    return () => {
      flush();
      unsubscribe();
    };
  }, [user, flush, openMixData]);

  // Queue a save whenever the editor state changes while a mix is open.
  useEffect(() => {
    if (!user || !mixId) return;
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      return;
    }
    pendingRef.current = { uid: user.uid, mixId, state: persistedState };
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
  }, [persistedState, user, mixId, flush]);

  // Don't drop the last second of edits when the tab is closed or hidden.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flush);
    };
  }, [flush]);

  const selectMix = useCallback((id) => {
    if (!user || id === mixId) return;
    const mix = mixes.find((m) => m.id === id);
    if (!mix) return;
    flush(); // save the mix being left before its state is replaced
    openMixData(user.uid, mix);
  }, [user, mixId, mixes, flush, openMixData]);

  const newMix = useCallback(async () => {
    if (!user) return;
    flush();
    const id = await createMix(user.uid, null);
    skipNextSaveRef.current = true;
    applyRef.current({});
    setMixId(id);
    rememberMix(user.uid, id);
  }, [user, flush]);

  const currentMix = mixes.find((m) => m.id === mixId) ?? null;

  // Give an untitled mix a real name (e.g. once lyrics are found for a song).
  const nameMixIfUntitled = useCallback((title) => {
    if (!user || !mixId || (currentMix && currentMix.title !== UNTITLED_MIX)) return;
    renameMix(user.uid, mixId, title).catch((err) => console.error('Renaming mix failed', err));
  }, [user, mixId, currentMix]);

  return { user, authReady, mixes, mixId, currentMix, saveStatus, selectMix, newMix, nameMixIfUntitled };
}
