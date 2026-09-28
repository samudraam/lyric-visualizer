import { useRef, useState, useEffect, useMemo } from 'react';
import { Play, Pause, Upload, Plus, Box, X, RotateCcw, Type, ExternalLink, Settings, LogIn, LogOut, Cloud, CloudOff, FilePlus, Layers, AudioLines, FolderOpen } from 'lucide-react';
import Stage from './Stage.jsx';
import LyricFinder from './LyricFinder.jsx';
import Knob from './Knob.jsx';
import { FLORAL_PALETTE, DEFAULT_STAGE_COLORS, DEFAULT_LYRIC_COLOR, DEFAULT_LYRIC_SIZE, DEFAULT_PARTICLE_SIZE } from './lib/palette.js';
import { loadCustomFont, CUSTOM_FONT_FAMILY } from './lib/font.js';
import { STAGE_CHANNEL_NAME } from './lib/stageChannel.js';
import { TEXT_EFFECTS, DEFAULT_TEXT_EFFECT } from './lib/textEffects.js';
import { loadState, saveState } from './lib/persistence.js';
import { signInWithGoogle, signOutUser } from './lib/firebase.js';
import { useCloudMix } from './lib/useCloudMix.js';
import { useCloudSeparation } from './lib/useCloudSeparation.js';
import { getSeparation, downloadStems, watchReadySeparations } from './lib/cloudSeparations.js';

/* =========================================================================
   MODULE-LEVEL CONSTANTS & PURE HELPER FUNCTIONS
   -------------------------------------------------------------------------
   These live OUTSIDE the component on purpose. They don't depend on React
   state/props, so defining them inside the component would just recreate
   identical functions on every single re-render for no benefit. Keeping
   pure, stateless logic at module scope is a common JS pattern that also
   makes these functions easy to unit test in isolation later.
   ========================================================================= */

// How many horizontal pixels represent one second of audio on the timeline.
// Bump this up to "zoom in" on the timeline, or make it a piece of state
// later if you want a pinch-to-zoom control.
const PIXELS_PER_SECOND = 80;

const timeToX = (seconds) => seconds * PIXELS_PER_SECOND;
const xToTime = (pixels) => pixels / PIXELS_PER_SECOND;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const formatTime = (seconds) => {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};

// Shared Tailwind classes for the header's pill buttons — background is left
// out here since it differs per button (default panel vs. the play button's
// gradient), so each usage appends its own bg-*/hover:bg-* classes.
const BTN_BASE =
  'inline-flex items-center gap-2 text-text border border-white/10 rounded-lg ' +
  'px-3.5 py-2 text-[13px] cursor-pointer transition-all duration-150 active:scale-[0.97] ' +
  'disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline ' +
  'focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2';

// Works out which of two chosen stem files is the vocals and which is the
// background music, from their names. Demucs names them vocals.wav and
// instrumental.wav (separation/separate.py) or no_vocals.wav (demucs CLI),
// so the BGM pattern is checked first: "no_vocals" also contains "vocal".
// Returns { vocals, bgm } Files, or null if the names don't say.
const BGM_NAME = /no_vocals|instrumental|accompaniment|karaoke|bgm|backing|music/i;
const VOCALS_NAME = /vocal|voice|acapella|a_cappella/i;
function assignStemFiles([a, b]) {
  const role = (f) => (BGM_NAME.test(f.name) ? 'bgm' : VOCALS_NAME.test(f.name) ? 'vocals' : null);
  const [ra, rb] = [role(a), role(b)];
  if (ra === 'vocals' || rb === 'bgm') return rb === 'vocals' ? null : { vocals: a, bgm: b };
  if (ra === 'bgm' || rb === 'vocals') return { vocals: b, bgm: a };
  return null;
}

// Shared classes for text inputs/selects (lyric finder, mix picker).
const FIELD_BASE =
  'bg-panel-2 text-text border border-white/10 rounded-lg px-3 py-2 text-[13px] ' +
  'disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent';

const SAVE_STATUS_TEXT = {
  idle: 'Synced to your Google account',
  saving: 'Saving…',
  saved: 'Saved to your Google account',
  error: 'Couldn\'t save. Changes are kept on this device only.',
};

export default function LyricBloom() {
  /* =======================================================================
     REACT STATE
     -----------------------------------------------------------------------
     State drives re-renders — use it for things the JSX actually needs to
     redraw around (lyric text, block positions/widths, whether we're
     playing). Anything that changes 60x/second (the playhead line, the time
     readout, the particle animation itself) is handled OUTSIDE React state
     below, via refs + direct DOM writes — see the audio-sync loop for why.
     ======================================================================= */
  // Read once, synchronously, on the very first render — so restored values
  // are there for the initial paint instead of flashing defaults first. Only
  // lyrics/timeline + settings-menu values are persisted; uploaded audio/
  // font/shape files are binary blobs well past what localStorage should
  // hold, so those still need to be re-selected after a reload.
  const [savedState] = useState(() => loadState() || {});

  const [lyricBank, setLyricBank] = useState(savedState.lyricBank ?? []);       // lines not yet placed: [{id, text}]
  const [placedBlocks, setPlacedBlocks] = useState(savedState.placedBlocks ?? []);  // [{id, text, start, duration, color}]
  const [lyricInput, setLyricInput] = useState('');
  const [nextId, setNextId] = useState(savedState.nextId ?? 1);

  const [audioURL, setAudioURL] = useState(null);
  const [audioName, setAudioName] = useState('');
  const [audioFile, setAudioFile] = useState(null); // the full-mix File from "Upload audio" (for cloud separation)
  const [audioDuration, setAudioDuration] = useState(60); // seconds; refined once metadata loads
  // Stems mode: the main <audio> plays the background music and a second,
  // hidden <audio> plays the vocals in sync, each through its own dial.
  const [stems, setStems] = useState(null); // null | { vocalsURL, vocalsName, bgmName, separationId }
  const [stemsError, setStemsError] = useState('');
  // The saved cloud separation this mix uses, so reopening the mix (or
  // reloading the page) loads its stems again without re-running the job.
  const [stemsSeparationId, setStemsSeparationId] = useState(savedState.stemsSeparationId ?? null);
  const [stemsLoading, setStemsLoading] = useState(''); // file name while saved stems download
  const [showSavedStems, setShowSavedStems] = useState(false);
  const [vocalsVolume, setVocalsVolume] = useState(savedState.vocalsVolume ?? 1); // gain, 1 = 100%
  const [bgmVolume, setBgmVolume] = useState(savedState.bgmVolume ?? 1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  const [glbBuffer, setGlbBuffer] = useState(null); // raw uploaded .glb bytes, or null for default particles
  const [glbName, setGlbName] = useState('');
  const [glbError, setGlbError] = useState('');

  const [fontBuffer, setFontBuffer] = useState(null); // raw uploaded font bytes, or null for the default typeface
  const [fontName, setFontName] = useState('');
  const [fontError, setFontError] = useState('');
  const [fontLoaded, setFontLoaded] = useState(false); // whether the uploaded font has finished loading in THIS document

  const [authError, setAuthError] = useState('');

  const [showSettings, setShowSettings] = useState(false); // palette/stage-color/font settings menu
  const [selectedBlockId, setSelectedBlockId] = useState(null); // placed block currently shown in the settings menu's per-chip section
  const [allSelected, setAllSelected] = useState(false); // "S" pressed: every placed block moves together when one is dragged
  const [palette, setPalette] = useState(savedState.palette ?? FLORAL_PALETTE);       // lyric-block + particle colors, editable in settings
  const [stageColors, setStageColors] = useState(savedState.stageColors ?? DEFAULT_STAGE_COLORS); // Stage's background gradient stops
  const [lyricColor, setLyricColor] = useState(savedState.lyricColor ?? DEFAULT_LYRIC_COLOR); // active-lyric text color on Stage
  const [lyricSize, setLyricSize] = useState(savedState.lyricSize ?? DEFAULT_LYRIC_SIZE); // active-lyric max font size (px) on Stage
  const [particleSize, setParticleSize] = useState(savedState.particleSize ?? DEFAULT_PARTICLE_SIZE); // uploaded .glb particle scale on Stage
  const [textEffect, setTextEffect] = useState(savedState.textEffect ?? DEFAULT_TEXT_EFFECT); // active-lyric WebGL shader id, see lib/textEffects.js

  /* =======================================================================
     REFS
     -----------------------------------------------------------------------
     A ref (useRef) is a plain mutable box: `.current` can change without
     triggering a re-render. We use refs for two jobs here:

     1. DOM handles (audioRef, trackRef, playheadRef) — so we can
        imperatively read/write actual DOM nodes.
     2. "Live mirrors" of state (placedBlocksRef) or continuously-updated
        values (audioTimeRef, bassRef) that Stage's own animation loop reads
        every frame without needing to be re-created whenever state changes.
        This sidesteps the classic "stale closure" bug: a function created in
        one render only "remembers" the state values from THAT render unless
        you explicitly refresh a ref.
     ======================================================================= */
  const audioRef = useRef(null);
  const vocalsAudioRef = useRef(null); // second <audio>, only has a src in stems mode
  const mainGainRef = useRef(null);    // GainNode after audioRef (the BGM dial in stems mode)
  const vocalsGainRef = useRef(null);  // GainNode after vocalsAudioRef (the vocals dial)
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const dataArrayRef = useRef(null);
  const rafRef = useRef(null); // requestAnimationFrame id for the audio-sync loop below

  const trackRef = useRef(null);       // timeline track div (for drop-position math)
  const playheadRef = useRef(null);    // playhead line — mutated directly, not via state
  const timeDisplayRef = useRef(null); // "0:42 / 3:10" text — also mutated directly

  const placedBlocksRef = useRef([]);
  // Fed to Stage every frame instead of Stage reading <audio>/AnalyserNode
  // directly — see Stage.jsx's top comment for why.
  const audioTimeRef = useRef({ currentTime: 0, duration: 0 });
  const bassRef = useRef(0);

  // Keep placedBlocksRef in sync whenever the real state changes, so Stage's
  // animation loop always sees fresh lyric-timing data.
  useEffect(() => {
    placedBlocksRef.current = placedBlocks;
  }, [placedBlocks]);

  // Keyboard shortcuts: Space plays/pauses, S toggles "select all blocks"
  // (drag any one to shift the whole song), Esc clears it. Ignored while
  // typing in a field so Space and "s" still type into the lyric/artist/
  // title inputs.
  // togglePlay is re-created every render (it reads isPlaying/audioURL), so
  // this once-registered listener calls it through a ref kept current below.
  const togglePlayRef = useRef(null);
  useEffect(() => {
    const isTyping = (t) => t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
    const onKeyDown = (e) => {
      if (isTyping(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'Space') {
        // Also stops the page scrolling and, if a button has focus (e.g. Play
        // itself, after being clicked), stops Space from clicking it too.
        e.preventDefault();
        if (!e.repeat) togglePlayRef.current?.();
      } else if (e.key === 's' || e.key === 'S') {
        if (placedBlocksRef.current.length === 0) return;
        e.preventDefault();
        setAllSelected((v) => !v);
      } else if (e.key === 'Escape') {
        setAllSelected(false);
      }
    };
    // Browsers "click" a focused button on Space *keyup*, so block that too.
    const onKeyUp = (e) => {
      if (e.code === 'Space' && !isTyping(e.target)) e.preventDefault();
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  // Everything that gets persisted: lyrics/timeline + settings-menu values.
  // Saved to localStorage on every change, so a reload picks up where this
  // session left off (see the matching read in the savedState initializer
  // above), and to the open cloud mix when signed in (see useCloudMix).
  const persistedState = useMemo(
    () => ({
      lyricBank,
      // Persist each block's own overrides, but not its uploaded font bytes
      // — binary, and excluded for the same reason the global font upload
      // is (see savedState initializer above). fontName is kept as a small
      // hint; the font itself needs re-uploading after a reload.
      placedBlocks: placedBlocks.map((b) => ({
        id: b.id,
        text: b.text,
        start: b.start,
        duration: b.duration,
        color: b.color,
        textColor: b.textColor,
        textEffect: b.textEffect,
        fontName: b.fontName,
      })),
      nextId,
      palette,
      stageColors,
      lyricColor,
      lyricSize,
      particleSize,
      textEffect,
      vocalsVolume,
      bgmVolume,
      stemsSeparationId,
    }),
    [lyricBank, placedBlocks, nextId, palette, stageColors, lyricColor, lyricSize, particleSize, textEffect, vocalsVolume, bgmVolume, stemsSeparationId],
  );

  useEffect(() => {
    saveState(persistedState);
  }, [persistedState]);

  // The inverse: load a persisted-state object (e.g. a cloud mix being
  // opened) into the editor. Missing fields fall back to defaults, so `{}`
  // gives a blank mix.
  const applyPersistedState = (s) => {
    setLyricBank(s.lyricBank ?? []);
    setPlacedBlocks(s.placedBlocks ?? []);
    setNextId(s.nextId ?? 1);
    setPalette(s.palette ?? FLORAL_PALETTE);
    setStageColors(s.stageColors ?? DEFAULT_STAGE_COLORS);
    setLyricColor(s.lyricColor ?? DEFAULT_LYRIC_COLOR);
    setLyricSize(s.lyricSize ?? DEFAULT_LYRIC_SIZE);
    setParticleSize(s.particleSize ?? DEFAULT_PARTICLE_SIZE);
    setTextEffect(s.textEffect ?? DEFAULT_TEXT_EFFECT);
    setVocalsVolume(s.vocalsVolume ?? 1);
    setBgmVolume(s.bgmVolume ?? 1);
    // A mix without saved stems keeps whatever audio is loaded, same as
    // before stems existed; one with them loads them (see the effect below).
    if (s.stemsSeparationId) setStemsSeparationId(s.stemsSeparationId);
    setSelectedBlockId(null);
    setAllSelected(false);
  };

  const { user, authReady, mixes, mixId, saveStatus, selectMix, newMix, nameMixIfUntitled } =
    useCloudMix(persistedState, applyPersistedState);

  // Revoke the previous object URL when a new audio file is chosen, or on
  // unmount — object URLs hold a reference to the underlying file blob in
  // memory until explicitly released.
  useEffect(() => {
    return () => {
      if (audioURL) URL.revokeObjectURL(audioURL);
    };
  }, [audioURL]);

  const vocalsURL = stems?.vocalsURL;
  useEffect(() => {
    return () => {
      if (vocalsURL) URL.revokeObjectURL(vocalsURL);
    };
  }, [vocalsURL]);

  // Dials → gain nodes. Outside stems mode the main track plays at full
  // volume. (If the graph isn't built yet, ensureAudioGraph applies these.)
  useEffect(() => {
    if (mainGainRef.current) mainGainRef.current.gain.value = stems ? bgmVolume : 1;
    if (vocalsGainRef.current) vocalsGainRef.current.gain.value = vocalsVolume;
  }, [stems, bgmVolume, vocalsVolume]);

  /* =======================================================================
     POP-OUT SYNC — BroadcastChannel to the pop-out visualizer tab
     -----------------------------------------------------------------------
     Mirrors this tab's lyrics/particle-shape/font/audio-position into any
     open pop-out (StagePopout.jsx). glbBufferRef/fontBufferRef exist purely
     so the 'ready' handler below — set up once on mount — can read the
     LATEST values instead of whatever they were when the channel was
     created, same "live mirror" trick as placedBlocksRef above.
     ======================================================================= */
  const channelRef = useRef(null);
  const glbBufferRef = useRef(null);
  const fontBufferRef = useRef(null);
  const paletteRef = useRef(palette);
  const stageColorsRef = useRef(stageColors);
  const lyricColorRef = useRef(lyricColor);
  const lyricSizeRef = useRef(lyricSize);
  const particleSizeRef = useRef(particleSize);
  const textEffectRef = useRef(textEffect);

  useEffect(() => {
    const channel = new BroadcastChannel(STAGE_CHANNEL_NAME);
    channelRef.current = channel;

    // A pop-out only announces itself once, on mount — resend the current
    // snapshot immediately so it doesn't stay blank until the next edit.
    channel.onmessage = (event) => {
      if (event.data?.type !== 'ready') return;
      channel.postMessage({ type: 'lyrics', placedBlocks: placedBlocksRef.current });
      if (glbBufferRef.current) channel.postMessage({ type: 'shape', buffer: glbBufferRef.current });
      if (fontBufferRef.current) channel.postMessage({ type: 'font', buffer: fontBufferRef.current });
      channel.postMessage({ type: 'palette', palette: paletteRef.current });
      channel.postMessage({ type: 'stageColors', stageColors: stageColorsRef.current });
      channel.postMessage({ type: 'lyricColor', lyricColor: lyricColorRef.current });
      channel.postMessage({ type: 'lyricSize', lyricSize: lyricSizeRef.current });
      channel.postMessage({ type: 'particleSize', particleSize: particleSizeRef.current });
      channel.postMessage({ type: 'textEffect', textEffect: textEffectRef.current });
    };

    return () => channel.close();
  }, []);

  useEffect(() => {
    glbBufferRef.current = glbBuffer;
    channelRef.current?.postMessage({ type: 'shape', buffer: glbBuffer });
  }, [glbBuffer]);

  useEffect(() => {
    fontBufferRef.current = fontBuffer;
    channelRef.current?.postMessage({ type: 'font', buffer: fontBuffer });
  }, [fontBuffer]);

  useEffect(() => {
    channelRef.current?.postMessage({ type: 'lyrics', placedBlocks });
  }, [placedBlocks]);

  useEffect(() => {
    paletteRef.current = palette;
    channelRef.current?.postMessage({ type: 'palette', palette });
  }, [palette]);

  useEffect(() => {
    stageColorsRef.current = stageColors;
    channelRef.current?.postMessage({ type: 'stageColors', stageColors });
  }, [stageColors]);

  useEffect(() => {
    lyricColorRef.current = lyricColor;
    channelRef.current?.postMessage({ type: 'lyricColor', lyricColor });
  }, [lyricColor]);

  useEffect(() => {
    lyricSizeRef.current = lyricSize;
    channelRef.current?.postMessage({ type: 'lyricSize', lyricSize });
  }, [lyricSize]);

  useEffect(() => {
    particleSizeRef.current = particleSize;
    channelRef.current?.postMessage({ type: 'particleSize', particleSize });
  }, [particleSize]);

  useEffect(() => {
    textEffectRef.current = textEffect;
    channelRef.current?.postMessage({ type: 'textEffect', textEffect });
  }, [textEffect]);

  /* =======================================================================
     AUDIO-SYNC LOOP — runs exactly once (empty dependency array)
     -----------------------------------------------------------------------
     Drives everything that needs to track audio.currentTime every frame:
     the bass-energy calculation Stage reacts to, the playhead position, and
     the time readout. Writes into audioTimeRef/bassRef instead of React
     state — pushing 60 setState calls/second through React's reconciler for
     values Stage just reads imperatively would be wasted work.
     ======================================================================= */
  useEffect(() => {
    const animate = () => {
      rafRef.current = requestAnimationFrame(animate);

      // --- audio analysis: average energy in the low frequency bins ---
      let bass = 0;
      if (analyserRef.current && dataArrayRef.current) {
        analyserRef.current.getByteFrequencyData(dataArrayRef.current);
        const bassRange = 12; // first N FFT bins ≈ bass/kick energy
        let sum = 0;
        for (let i = 0; i < bassRange; i++) sum += dataArrayRef.current[i];
        bass = sum / (bassRange * 255); // normalize to 0..1
      }
      bassRef.current = bass;

      // --- sync playhead + shared audio-time ref from the <audio> element ---
      const audioEl = audioRef.current;
      if (audioEl) {
        const ct = audioEl.currentTime;
        const dur = audioEl.duration || 0;
        audioTimeRef.current = { currentTime: ct, duration: dur };

        if (playheadRef.current) {
          playheadRef.current.style.left = `${timeToX(ct)}px`;
        }
        if (timeDisplayRef.current) {
          timeDisplayRef.current.textContent = `${formatTime(ct)} / ${formatTime(dur)}`;
        }

        // Stems mode: the vocals element follows the main one. Checked every
        // frame, so seeking, scrubbing and play/pause from anywhere stay in
        // step; re-seeking only when they drift apart by more than 50 ms
        // keeps it from stuttering over tiny scheduling differences.
        const vocalsEl = vocalsAudioRef.current;
        if (vocalsEl?.getAttribute('src') && ct < (vocalsEl.duration || Infinity)) {
          if (Math.abs(vocalsEl.currentTime - ct) > 0.05) vocalsEl.currentTime = ct;
          if (audioEl.paused && !vocalsEl.paused) vocalsEl.pause();
          else if (!audioEl.paused && vocalsEl.paused) vocalsEl.play().catch(() => {});
        }
      }

      channelRef.current?.postMessage({
        type: 'sync',
        currentTime: audioTimeRef.current.currentTime,
        duration: audioTimeRef.current.duration,
        bass,
      });
    };
    animate();
    return () => cancelAnimationFrame(rafRef.current);
  }, []); // empty array = run once on mount, clean up once on unmount

  /* =======================================================================
     WEB AUDIO GRAPH
     -----------------------------------------------------------------------
     Browsers block audio contexts from starting until a real user gesture
     (like a click) happens — that's why this is built lazily inside
     togglePlay() rather than in a useEffect on mount.
     ======================================================================= */
  const ensureAudioGraph = () => {
    if (audioCtxRef.current) return; // already built — MediaElementSource can only be created ONCE per element
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioContextClass();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    // Graph: main <audio>   → gain (BGM dial)    ┐
    //        vocals <audio> → gain (vocals dial) ┴→ analyser → speakers.
    // Routing through the analyser doesn't change what you hear; it just
    // gives us a tap point to read frequency data from every frame. The
    // vocals element is always wired up (it's silent without a src), since
    // a MediaElementSource can't be added later for an element that
    // already played outside the graph.
    const mainGain = ctx.createGain();
    mainGain.gain.value = stems ? bgmVolume : 1;
    ctx.createMediaElementSource(audioRef.current).connect(mainGain).connect(analyser);
    const vocalsGain = ctx.createGain();
    vocalsGain.gain.value = vocalsVolume;
    ctx.createMediaElementSource(vocalsAudioRef.current).connect(vocalsGain).connect(analyser);
    analyser.connect(ctx.destination);

    mainGainRef.current = mainGain;
    vocalsGainRef.current = vocalsGain;
    audioCtxRef.current = ctx;
    analyserRef.current = analyser;
    dataArrayRef.current = new Uint8Array(analyser.frequencyBinCount);
  };

  const togglePlay = () => {
    if (!audioRef.current || !audioURL) return;
    ensureAudioGraph();
    if (audioCtxRef.current.state === 'suspended') audioCtxRef.current.resume();
    const vocalsEl = stems ? vocalsAudioRef.current : null;
    if (isPlaying) {
      audioRef.current.pause();
      vocalsEl?.pause();
      setIsPlaying(false);
    } else {
      // The audio-sync loop lines the vocals up with the main track's
      // position within a frame, so they don't need seeking here.
      audioRef.current.play();
      vocalsEl?.play();
      setIsPlaying(true);
    }
  };

  useEffect(() => {
    togglePlayRef.current = togglePlay;
  });

  const handleAudioFile = (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setAudioURL(URL.createObjectURL(file));
    setAudioName(file.name);
    setAudioFile(file);
    setStems(null); // a single full-mix file replaces any loaded stems
    setStemsSeparationId(null);
    setStemsError('');
    setIsPlaying(false);
  };

  // Two files at once: a vocals stem and a background-music stem (e.g. the
  // vocals.wav + instrumental.wav separation/separate.py produces). The BGM
  // becomes the main track, so the timeline, seeking, duration and pop-out
  // all keep working off audioRef unchanged; the vocals ride along in sync.
  const handleStemFiles = (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length === 0) return;
    const assigned = files.length === 2 ? assignStemFiles(files) : null;
    if (!assigned) {
      setStemsError(
        files.length !== 2
          ? 'Choose exactly two files: a vocals stem and a background-music stem.'
          : "Couldn't tell which file is which. Include \"vocals\" in one name and \"instrumental\" in the other."
      );
      return;
    }
    setAudioFile(null);
    applyStems(assigned.vocals, assigned.bgm, assigned.vocals.name, assigned.bgm.name,
      `Stems: ${assigned.bgm.name.replace(/\.[^.]+$/, '')} + vocals`);
  };

  // Loads a vocals + BGM pair (Files or downloaded Blobs) into stems mode.
  // separationId is set when they came from a saved cloud separation, so
  // the mix remembers them; local files leave it null.
  const applyStems = (vocalsBlob, bgmBlob, vocalsName, bgmName, label, separationId = null) => {
    audioRef.current?.pause();
    vocalsAudioRef.current?.pause();
    setAudioURL(URL.createObjectURL(bgmBlob));
    setAudioName(label);
    setStems({ vocalsURL: URL.createObjectURL(vocalsBlob), vocalsName, bgmName, separationId });
    setStemsSeparationId(separationId);
    setStemsError('');
    setIsPlaying(false);
  };

  const applyCloudStems = (blobs, sep) => {
    const base = (sep.fileName ?? 'song').replace(/\.[^.]+$/, '');
    applyStems(blobs.vocals, blobs.instrumental, `${base} (vocals).mp3`, `${base} (instrumental).mp3`, `Stems: ${base}`, sep.id);
  };

  // Cloud separation (Split vocals): when the job's stems arrive (or saved
  // ones for the same file are found), load them into the mixer, but only
  // if that song is still the one loaded; if the user has moved on to
  // another file, leave the editor alone.
  const separation = useCloudSeparation(user, (blobs, { file, separation: sep }) => {
    if (file !== audioFile) return;
    setAudioFile(null);
    applyCloudStems(blobs, sep);
  });

  // Saved stems: download a finished separation's files and load them. No
  // job runs; the stems are already in Storage.
  const loadSavedStems = async (sep) => {
    setShowSavedStems(false);
    setStemsLoading(sep.fileName ?? 'saved stems');
    try {
      const blobs = await downloadStems(sep);
      setAudioFile(null);
      applyCloudStems(blobs, sep);
    } catch (err) {
      setStemsError(`Couldn't load the saved stems: ${err.message}`);
    } finally {
      setStemsLoading('');
    }
  };

  // Reopening a mix (or reloading) whose stems aren't loaded yet: fetch
  // them. Runs through a ref so the effect only re-runs when the ids change.
  const loadSavedStemsRef = useRef(loadSavedStems);
  useEffect(() => {
    loadSavedStemsRef.current = loadSavedStems;
  });
  const uid = user?.uid;
  const loadedSeparationId = stems?.separationId ?? null;
  useEffect(() => {
    if (!uid || !stemsSeparationId || loadedSeparationId === stemsSeparationId) return;
    let cancelled = false;
    getSeparation(uid, stemsSeparationId)
      .then((sep) => {
        if (cancelled) return;
        if (sep?.status === 'ready') loadSavedStemsRef.current(sep);
        else setStemsSeparationId(null); // deleted, or never finished
      })
      .catch((err) => !cancelled && setStemsError(`Couldn't find this mix's saved stems: ${err.message}`));
    return () => {
      cancelled = true;
    };
  }, [uid, stemsSeparationId, loadedSeparationId]);

  /* =======================================================================
     CUSTOM PARTICLE SHAPE (.glb upload)
     -----------------------------------------------------------------------
     The actual GLTFLoader parsing/geometry-building lives in Stage.jsx (it
     owns the Three.js scene); here we just read the file into raw bytes and
     hand them down as a prop. Stage reports back via onShapeError if the
     bytes don't parse into a usable mesh.
     ======================================================================= */
  const handleGlbFile = (e) => {
    const file = e.target.files[0];
    e.target.value = ''; // allow re-selecting the same file after an error
    if (!file) return;

    setGlbError('');
    setGlbName(file.name);

    file.arrayBuffer()
      .then((buffer) => setGlbBuffer(buffer))
      .catch(() => {
        setGlbError('Could not read that file.');
        setGlbName('');
      });
  };

  const handleShapeError = (message) => {
    setGlbError(message);
    setGlbName('');
    setGlbBuffer(null); // fall back to the default particles
  };

  const handleResetParticles = () => {
    setGlbBuffer(null);
    setGlbName('');
    setGlbError('');
  };

  /* =======================================================================
     CUSTOM FONT (upload)
     -----------------------------------------------------------------------
     Loaded here too (not just in Stage) so the lyric bank chips below — part
     of the editor UI, not the Stage — can pick it up as well.
     ======================================================================= */
  const handleFontFile = (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;

    setFontError('');
    setFontLoaded(false);

    file.arrayBuffer()
      .then((buffer) =>
        loadCustomFont(buffer).then(() => {
          setFontBuffer(buffer);
          setFontName(file.name);
          setFontLoaded(true);
        })
      )
      .catch(() => {
        setFontError('Could not load that font file.');
        setFontName('');
        setFontBuffer(null);
      });
  };

  const handleResetFont = () => {
    setFontBuffer(null);
    setFontName('');
    setFontError('');
    setFontLoaded(false);
  };

  /* =======================================================================
     SETTINGS MENU — palette, stage background colors, lyric text color
     ======================================================================= */
  const handlePaletteColorChange = (index, value) => {
    setPalette((prev) => prev.map((c, i) => (i === index ? value : c)));
  };

  const handleResetPalette = () => setPalette(FLORAL_PALETTE);

  const handleStageColorChange = (key, value) => {
    setStageColors((prev) => ({ ...prev, [key]: value }));
  };

  const handleResetStageColors = () => setStageColors(DEFAULT_STAGE_COLORS);

  const handleResetLyricColor = () => setLyricColor(DEFAULT_LYRIC_COLOR);

  const handleResetLyricSize = () => setLyricSize(DEFAULT_LYRIC_SIZE);

  const handleResetParticleSize = () => setParticleSize(DEFAULT_PARTICLE_SIZE);

  const handleResetTextEffect = () => setTextEffect(DEFAULT_TEXT_EFFECT);

  // Opens the visualizer-only pop-out. A named window target means clicking
  // this again re-focuses the same tab instead of spawning duplicates.
  const handleSignIn = () => {
    setAuthError('');
    signInWithGoogle().catch((err) => setAuthError(err.message));
  };

  const openStagePopout = () => {
    window.open(`${window.location.pathname}?stage=1`, 'lyric-bloom-stage', 'width=960,height=600');
  };

  /* =======================================================================
     LYRIC BANK
     ======================================================================= */
  const addLinesToBank = (lines) => {
    if (lines.length === 0) return;
    const newItems = lines.map((text, i) => ({ id: nextId + i, text }));
    setLyricBank((prev) => [...prev, ...newItems]);
    setNextId((prev) => prev + lines.length);
  };

  const handleAddLyrics = () => {
    addLinesToBank(lyricInput.split('\n').map((l) => l.trim()).filter(Boolean));
    setLyricInput('');
  };

  // Lyrics fetched by LyricFinder. Timestamped lyrics go straight onto the
  // timeline, but only when it's empty; otherwise they'd pile on top of
  // blocks already placed, so they go to the bank like plain lyrics do.
  // Either way lines get fresh numeric ids from nextId (not the function's
  // string ids) so they can't collide with existing blocks.
  // Returns the message LyricFinder shows under the search row.
  const handleLyricsFound = (song, { artist, title }) => {
    nameMixIfUntitled(`${artist} – ${title}`);
    const timed = song.timedLines ?? [];

    if (timed.length && placedBlocks.length === 0) {
      const blocks = timed.map((line, i) => ({
        id: nextId + i,
        text: line.text,
        start: line.start,
        duration: Math.max(0.3, line.duration),
        color: palette[i % palette.length],
      }));
      setPlacedBlocks(blocks);
      setNextId((prev) => prev + blocks.length);
      // Without audio the track is only as long as the default duration, so
      // stretch it to fit; loading audio later resets it to the file's
      // length (see onLoadedMetadata).
      if (!audioURL) {
        const end = Math.max(...blocks.map((b) => b.start + b.duration));
        setAudioDuration((prev) => Math.max(prev, Math.ceil(end)));
      }
      return `Placed ${blocks.length} timed lines on the timeline.`;
    }

    const lines = song.lyricBank.map((stub) => stub.text);
    addLinesToBank(lines);
    if (timed.length) return `Timeline isn't empty, so ${lines.length} lines went to the bank instead.`;
    return `Added ${lines.length} lines to the bank. No timestamps were available for this song.`;
  };

/* =======================================================================
  Handle Remove Lyrics
  ======================================================================= */
  const handleRemoveFromBank = (id) => {
    setLyricBank(prev => prev.filter(b => b.id !== id))
  };

  /* =======================================================================
     DRAG FROM BANK → DROP ONTO TIMELINE
     -----------------------------------------------------------------------
     The HTML5 Drag and Drop API fires a specific sequence of events:
     dragstart (on the source) → dragenter/dragover (on valid drop targets,
     REQUIRED to call preventDefault() or the drop is rejected by the
     browser) → drop (on the target) → dragend (back on the source).
     We use dataTransfer to hand the dragged item's data across that
     boundary, since the source and target are different DOM elements.
     ======================================================================= */
  const handleDragStart = (e, item) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', JSON.stringify(item));
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragOver(false);
    const raw = e.dataTransfer.getData('text/plain');
    if (!raw) return;
    let item;
    try {
      item = JSON.parse(raw);
    } catch {
      return;
    }
    const rect = trackRef.current.getBoundingClientRect();
    const offsetX = e.clientX - rect.left + trackRef.current.scrollLeft;
    const start = clamp(xToTime(offsetX), 0, Math.max(0, audioDuration - 2));
    const color = palette[placedBlocks.length % palette.length];

    setPlacedBlocks((prev) => [...prev, { id: item.id, text: item.text, start, duration: 2, color }]);
    setLyricBank((prev) => prev.filter((b) => b.id !== item.id));
  };

  const handleRemoveBlock = (block) => {
    setPlacedBlocks((prev) => prev.filter((b) => b.id !== block.id));
    setLyricBank((prev) => [...prev, { id: block.id, text: block.text }]);
    setSelectedBlockId((prev) => (prev === block.id ? null : prev));
  };

  /* =======================================================================
     PER-CHIP OVERRIDES — text color/effect/font for the selected placed
     block, editable from the settings menu's "Chip" section. Any field left
     unset falls back to the matching global setting — see the "effective *"
     values Stage.jsx derives from a block's own fields.
     ======================================================================= */
  const updateSelectedBlock = (patch) => {
    setPlacedBlocks((prev) => prev.map((b) => (b.id === selectedBlockId ? { ...b, ...patch } : b)));
  };

  const handleBlockTextColorChange = (value) => updateSelectedBlock({ textColor: value });
  const handleResetBlockTextColor = () => updateSelectedBlock({ textColor: undefined });

  const handleBlockTextEffectChange = (value) => updateSelectedBlock({ textEffect: value });
  const handleResetBlockTextEffect = () => updateSelectedBlock({ textEffect: undefined });

  const handleBlockFontFile = (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    file.arrayBuffer()
      .then((buffer) => updateSelectedBlock({ fontBuffer: buffer, fontName: file.name }))
      .catch(() => {});
  };
  const handleResetBlockFont = () => updateSelectedBlock({ fontBuffer: undefined, fontName: undefined });

  /* =======================================================================
     REPOSITION / RESIZE PLACED BLOCKS
     -----------------------------------------------------------------------
     This is deliberately NOT built with React state for "am I dragging."
     Instead, pointerdown attaches listeners straight to `document`, and
     pointerup removes them. This is a classic vanilla-JS drag pattern:
     - Each onMove/onUp pair is a CLOSURE that "remembers" startX and
       startTime from the moment the drag began — no stale-state bugs,
       because we never read component state inside the move handler.
     - Attaching to `document` (not just the block) means the drag keeps
       tracking even if the cursor moves faster than the block and briefly
       leaves its bounding box.
     ======================================================================= */
  // How far the pointer has to move before a press counts as a drag rather
  // than a click — below this, releasing selects the block for editing
  // instead. Without this, every reposition drag also fires a native click
  // at pointerup (mousedown/up landed on the same element regardless of the
  // distance dragged between them), which reopened the edit menu mid-drag.
  const CLICK_DRAG_THRESHOLD = 4;

  const handleBlockPointerDown = (e, block) => {
    e.stopPropagation();
    if (e.button !== 0) return; // left button only — no drag/select on right- or middle-click
    const startX = e.clientX;
    const startY = e.clientY;
    const startTime = block.start;
    let dragged = false;

    // Group drag (after pressing S): snapshot every block's start so each
    // move applies one shared offset, keeping their relative timing intact.
    // The offset is clamped so the earliest block can't go before 0 and the
    // latest can't run past the end of the audio.
    const groupStarts = allSelected ? new Map(placedBlocks.map((b) => [b.id, b.start])) : null;
    const minDelta = groupStarts ? -Math.min(...placedBlocks.map((b) => b.start)) : 0;
    const maxDelta = groupStarts ? Math.max(0, audioDuration - Math.max(...placedBlocks.map((b) => b.start + b.duration))) : 0;

    const onMove = (ev) => {
      if (!dragged && (Math.abs(ev.clientX - startX) > CLICK_DRAG_THRESHOLD || Math.abs(ev.clientY - startY) > CLICK_DRAG_THRESHOLD)) {
        dragged = true;
      }
      const deltaTime = (ev.clientX - startX) / PIXELS_PER_SECOND;
      if (groupStarts) {
        const delta = clamp(deltaTime, minDelta, maxDelta);
        setPlacedBlocks((prev) => prev.map((b) => (groupStarts.has(b.id) ? { ...b, start: groupStarts.get(b.id) + delta } : b)));
        return;
      }
      const newStart = clamp(startTime + deltaTime, 0, Math.max(0, audioDuration - block.duration));
      setPlacedBlocks((prev) => prev.map((b) => (b.id === block.id ? { ...b, start: newStart } : b)));
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      if (!dragged) {
        // A plain click drops out of select-all and edits just this block.
        setAllSelected(false);
        setSelectedBlockId(block.id);
        setShowSettings(true);
      }
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  const handleResizePointerDown = (e, block) => {
    e.stopPropagation();
    if (e.button !== 0) return; // left button only
    const startX = e.clientX;
    const startDuration = block.duration;

    const onMove = (ev) => {
      const deltaTime = (ev.clientX - startX) / PIXELS_PER_SECOND;
      const newDuration = clamp(startDuration + deltaTime, 0.3, Math.max(0.3, audioDuration - block.start));
      setPlacedBlocks((prev) => prev.map((b) => (b.id === block.id ? { ...b, duration: newDuration } : b)));
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  /* =======================================================================
     SCRUB THE RULER TO SEEK
     -----------------------------------------------------------------------
     Same document-level pointerdown/move/up pattern as the block drag/resize
     handlers above. Just writes audio.currentTime directly — the audio-sync
     loop already reads it every frame, so the playhead and time readout
     catch up on the very next frame with no extra state needed here.
     ======================================================================= */
  const seekToClientX = (clientX) => {
    if (!audioRef.current || !audioURL) return;
    const rect = trackRef.current.getBoundingClientRect();
    const time = clamp(xToTime(clientX - rect.left), 0, audioDuration);
    audioRef.current.currentTime = time;
  };

  const handleRulerPointerDown = (e) => {
    if (!audioURL) return;
    seekToClientX(e.clientX);
    const onMove = (ev) => seekToClientX(ev.clientX);
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  const selectedBlock = placedBlocks.find((b) => b.id === selectedBlockId) || null;

  // Build ruler tick marks once per render — cheap, and audioDuration only
  // changes rarely (on file load), so no need to memoize with useMemo here.
  const ticks = [];
  for (let s = 0; s <= Math.ceil(audioDuration); s++) {
    ticks.push(
      <div
        key={s}
        className="absolute top-0 w-px h-1.5 bg-white/25"
        style={{ left: `${timeToX(s)}px` }}
      >
        {s % 5 === 0 && (
          <span className="absolute top-2 left-[3px] text-[10px] text-text-dim whitespace-nowrap">
            {formatTime(s)}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col gap-3.5 p-5 bg-bg text-text font-mono">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="font-display font-bold text-[26px] m-0 tracking-[0.3px]">Lyric Bloom</h1>
        <div className="flex items-center gap-2.5 flex-wrap">
          <label className={`${BTN_BASE} bg-panel-2 hover:bg-[#2E2136]`}>
            <Upload size={16} />
            <span>{audioName || 'Upload audio'}</span>
            <input type="file" accept="audio/*" onChange={handleAudioFile} className="hidden" />
          </label>
          <label
            className={`${BTN_BASE} bg-panel-2 hover:bg-[#2E2136]`}
            title="Load a vocals file and an instrumental file together (e.g. from separation/separate.py) to mix them with dials"
          >
            <Layers size={16} />
            <span>Load stems</span>
            <input type="file" accept="audio/*" multiple onChange={handleStemFiles} className="hidden" />
          </label>
          {user && audioFile && !stems && (
            <button
              className={`${BTN_BASE} bg-panel-2 hover:bg-[#2E2136]`}
              onClick={() => separation.start(audioFile)}
              disabled={separation.busy}
              title="Separate this song into vocals and instrumental on Google Cloud, then load them into the mixer"
            >
              <AudioLines size={16} />
              <span>Split vocals</span>
            </button>
          )}
          {user && (
            <div className="relative">
              <button
                className={`${BTN_BASE} bg-panel-2 hover:bg-[#2E2136]`}
                onClick={() => setShowSavedStems((v) => !v)}
                aria-expanded={showSavedStems}
                title="Load stems you've already separated in the cloud (no re-processing)"
              >
                <FolderOpen size={16} />
                <span>Saved stems</span>
              </button>
              {showSavedStems && (
                <SavedStemsMenu
                  uid={user.uid}
                  currentId={loadedSeparationId}
                  onPick={loadSavedStems}
                  onClose={() => setShowSavedStems(false)}
                />
              )}
            </div>
          )}
          <button
            className={`${BTN_BASE} border-none bg-gradient-to-br from-[#E14F84] to-[#F2A93B]`}
            onClick={togglePlay}
            disabled={!audioURL}
            title="Play/pause (Space)"
          >
            {isPlaying ? <Pause size={16} /> : <Play size={16} />}
            <span>{isPlaying ? 'Pause' : 'Play'}</span>
          </button>
          <span ref={timeDisplayRef} className="text-[13px] text-text-dim min-w-[92px]">0:00 / 0:00</span>
          <label
            className={`${BTN_BASE} bg-panel-2 hover:bg-[#2E2136]`}
            title="Replace the falling particles with an uploaded 3D model"
          >
            <Box size={16} />
            <span>{glbName || 'Upload particle shape (.glb)'}</span>
            <input
              type="file"
              accept=".glb,.gltf,model/gltf-binary"
              onChange={handleGlbFile}
              className="hidden"
            />
          </label>
          {glbName && (
            <button
              className={`${BTN_BASE} bg-panel-2 hover:bg-[#2E2136]`}
              onClick={handleResetParticles}
              title="Reset to default particles"
            >
              <RotateCcw size={16} />
            </button>
          )}
          <button
            className={`${BTN_BASE} bg-panel-2 hover:bg-[#2E2136]`}
            onClick={openStagePopout}
            title="Open the visualizer in its own window, synced to this one"
          >
            <ExternalLink size={16} />
            <span>Pop out</span>
          </button>
          <div className="relative">
            <button
              className={`${BTN_BASE} bg-panel-2 hover:bg-[#2E2136]`}
              onClick={() => setShowSettings((v) => !v)}
              title="Adjust palette, stage colors, and lyric font"
              aria-expanded={showSettings}
            >
              <Settings size={16} />
              <span>Settings</span>
            </button>
            {showSettings && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowSettings(false)} />
                <div className="absolute right-0 top-full mt-2 z-50 w-72 bg-panel border border-white/10 rounded-xl p-4 shadow-[0_8px_30px_rgba(0,0,0,0.5)] flex flex-col gap-4 text-left">
                  {selectedBlock && (
                    <div className="border border-white/10 rounded-lg p-3 bg-panel-2/40">
                      <div className="flex items-center justify-between mb-3">
                        <span
                          className="text-[11px] font-semibold text-accent uppercase tracking-wide truncate max-w-[170px]"
                          title={selectedBlock.text}
                        >
                          Chip: {selectedBlock.text}
                        </span>
                        <button
                          className="text-[11px] text-text-dim hover:text-text hover:underline underline-offset-2 cursor-pointer"
                          onClick={() => setSelectedBlockId(null)}
                        >
                          Done
                        </button>
                      </div>

                      <div className="mb-3">
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-[11px] text-text-dim">Text color</span>
                          <button
                            className="text-[11px] text-text-dim hover:text-text hover:underline underline-offset-2 cursor-pointer"
                            onClick={handleResetBlockTextColor}
                          >
                            Use global
                          </button>
                        </div>
                        <input
                          type="color"
                          value={selectedBlock.textColor || lyricColor}
                          onChange={(e) => handleBlockTextColorChange(e.target.value)}
                          className="w-8 h-8 rounded-md border border-white/10 bg-transparent p-0 cursor-pointer"
                        />
                      </div>

                      <div className="mb-3">
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-[11px] text-text-dim">Text effect</span>
                          <button
                            className="text-[11px] text-text-dim hover:text-text hover:underline underline-offset-2 cursor-pointer"
                            onClick={handleResetBlockTextEffect}
                          >
                            Use global
                          </button>
                        </div>
                        <select
                          value={selectedBlock.textEffect || textEffect}
                          onChange={(e) => handleBlockTextEffectChange(e.target.value)}
                          className="w-full bg-panel-2 text-text border border-white/10 rounded-lg px-3 py-2 text-[13px] cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                        >
                          {TEXT_EFFECTS.map((effect) => (
                            <option key={effect.id} value={effect.id}>{effect.label}</option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-[11px] text-text-dim">Font</span>
                          {selectedBlock.fontName && (
                            <button
                              className="text-[11px] text-text-dim hover:text-text hover:underline underline-offset-2 cursor-pointer"
                              onClick={handleResetBlockFont}
                            >
                              Use global
                            </button>
                          )}
                        </div>
                        <label className={`${BTN_BASE} bg-panel-2 hover:bg-[#2E2136] w-full justify-center`}>
                          <Type size={16} />
                          <span className="truncate">{selectedBlock.fontName || 'Upload font for this chip'}</span>
                          <input
                            type="file"
                            accept=".woff2,.woff,.ttf,.otf"
                            onChange={handleBlockFontFile}
                            className="hidden"
                          />
                        </label>
                      </div>
                    </div>
                  )}

                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[11px] font-semibold text-text-dim uppercase tracking-wide">Palette</span>
                      <button
                        className="text-[11px] text-text-dim hover:text-text hover:underline underline-offset-2 cursor-pointer"
                        onClick={handleResetPalette}
                      >
                        Reset
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {palette.map((color, i) => (
                        <input
                          key={i}
                          type="color"
                          value={color}
                          onChange={(e) => handlePaletteColorChange(i, e.target.value)}
                          className="w-8 h-8 rounded-md border border-white/10 bg-transparent p-0 cursor-pointer"
                          title={`Palette color ${i + 1}`}
                        />
                      ))}
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[11px] font-semibold text-text-dim uppercase tracking-wide">Particle size</span>
                      <button
                        className="text-[11px] text-text-dim hover:text-text hover:underline underline-offset-2 cursor-pointer"
                        onClick={handleResetParticleSize}
                      >
                        Reset
                      </button>
                    </div>
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        min="0.1"
                        max="1.2"
                        step="0.05"
                        value={particleSize}
                        onChange={(e) => setParticleSize(Number(e.target.value))}
                        className="flex-1 cursor-pointer accent-accent"
                        title="Size of an uploaded .glb particle shape"
                      />
                      <span className="text-xs text-text-dim w-11 text-right tabular-nums">{particleSize.toFixed(2)}</span>
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[11px] font-semibold text-text-dim uppercase tracking-wide">Stage colors</span>
                      <button
                        className="text-[11px] text-text-dim hover:text-text hover:underline underline-offset-2 cursor-pointer"
                        onClick={handleResetStageColors}
                      >
                        Reset
                      </button>
                    </div>
                    <div className="flex items-center gap-4">
                      <label className="flex items-center gap-2 text-xs cursor-pointer">
                        <input
                          type="color"
                          value={stageColors.inner}
                          onChange={(e) => handleStageColorChange('inner', e.target.value)}
                          className="w-8 h-8 rounded-md border border-white/10 bg-transparent p-0 cursor-pointer"
                        />
                        Inner
                      </label>
                      <label className="flex items-center gap-2 text-xs cursor-pointer">
                        <input
                          type="color"
                          value={stageColors.outer}
                          onChange={(e) => handleStageColorChange('outer', e.target.value)}
                          className="w-8 h-8 rounded-md border border-white/10 bg-transparent p-0 cursor-pointer"
                        />
                        Outer
                      </label>
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[11px] font-semibold text-text-dim uppercase tracking-wide">Font color</span>
                      <button
                        className="text-[11px] text-text-dim hover:text-text hover:underline underline-offset-2 cursor-pointer"
                        onClick={handleResetLyricColor}
                      >
                        Reset
                      </button>
                    </div>
                    <label className="flex items-center gap-2 text-xs cursor-pointer">
                      <input
                        type="color"
                        value={lyricColor}
                        onChange={(e) => setLyricColor(e.target.value)}
                        className="w-8 h-8 rounded-md border border-white/10 bg-transparent p-0 cursor-pointer"
                      />
                      Active lyric text
                    </label>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[11px] font-semibold text-text-dim uppercase tracking-wide">Font size</span>
                      <button
                        className="text-[11px] text-text-dim hover:text-text hover:underline underline-offset-2 cursor-pointer"
                        onClick={handleResetLyricSize}
                      >
                        Reset
                      </button>
                    </div>
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        min="16"
                        max="200"
                        step="1"
                        value={lyricSize}
                        onChange={(e) => setLyricSize(Number(e.target.value))}
                        className="flex-1 cursor-pointer accent-accent"
                      />
                      <span className="text-xs text-text-dim w-11 text-right tabular-nums">{lyricSize}px</span>
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[11px] font-semibold text-text-dim uppercase tracking-wide">Text effect</span>
                      <button
                        className="text-[11px] text-text-dim hover:text-text hover:underline underline-offset-2 cursor-pointer"
                        onClick={handleResetTextEffect}
                      >
                        Reset
                      </button>
                    </div>
                    <select
                      value={textEffect}
                      onChange={(e) => setTextEffect(e.target.value)}
                      className="w-full bg-panel-2 text-text border border-white/10 rounded-lg px-3 py-2 text-[13px] cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                      title="WebGL shader applied to the active lyric text on Stage"
                    >
                      {TEXT_EFFECTS.map((effect) => (
                        <option key={effect.id} value={effect.id}>{effect.label}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <span className="text-[11px] font-semibold text-text-dim uppercase tracking-wide block mb-2">
                      Lyric font
                    </span>
                    <div className="flex items-center gap-2 flex-wrap">
                      <label
                        className={`${BTN_BASE} bg-panel-2 hover:bg-[#2E2136]`}
                        title="Use an uploaded font for the lyric text"
                      >
                        <Type size={16} />
                        <span>{fontName || 'Upload font'}</span>
                        <input
                          type="file"
                          accept=".woff2,.woff,.ttf,.otf"
                          onChange={handleFontFile}
                          className="hidden"
                        />
                      </label>
                      {fontName && (
                        <button
                          className={`${BTN_BASE} bg-panel-2 hover:bg-[#2E2136]`}
                          onClick={handleResetFont}
                          title="Reset to default font"
                        >
                          <RotateCcw size={16} />
                        </button>
                      )}
                    </div>
                    {fontError && <div className="text-xs text-[#E14F84] mt-1.5">{fontError}</div>}
                  </div>
                </div>
              </>
            )}
          </div>
          {authReady && (user ? (
            <div className="flex items-center gap-2">
              <select
                value={mixId ?? ''}
                onChange={(e) => selectMix(e.target.value)}
                className={`${FIELD_BASE} max-w-[200px] cursor-pointer`}
                title="Your saved mixes"
              >
                {!mixId && <option value="">Loading mixes…</option>}
                {mixes.map((m) => (
                  <option key={m.id} value={m.id}>{m.title}</option>
                ))}
              </select>
              <button
                className={`${BTN_BASE} bg-panel-2 hover:bg-[#2E2136]`}
                onClick={newMix}
                title="Start a new blank mix"
              >
                <FilePlus size={16} />
              </button>
              <span className="text-text-dim" title={SAVE_STATUS_TEXT[saveStatus]}>
                {saveStatus === 'error' ? <CloudOff size={16} className="text-[#E14F84]" /> : <Cloud size={16} className={saveStatus === 'saving' ? 'animate-pulse' : ''} />}
              </span>
              <button
                className={`${BTN_BASE} bg-panel-2 hover:bg-[#2E2136]`}
                onClick={signOutUser}
                title={`Signed in as ${user.email}. Click to sign out.`}
              >
                {user.photoURL && (
                  <img src={user.photoURL} alt="" referrerPolicy="no-referrer" className="w-4 h-4 rounded-full" />
                )}
                <LogOut size={16} />
              </button>
            </div>
          ) : (
            <button className={`${BTN_BASE} bg-panel-2 hover:bg-[#2E2136]`} onClick={handleSignIn}>
              <LogIn size={16} />
              <span>Sign in with Google</span>
            </button>
          ))}
        </div>
        {glbError && <div className="w-full text-xs text-[#E14F84] mt-1.5">{glbError}</div>}
        {authError && <div className="w-full text-xs text-[#E14F84] mt-1.5">{authError}</div>}
        {stemsError && <div className="w-full text-xs text-[#E14F84] mt-1.5">{stemsError}</div>}
        {separation.job && <SeparationStatus job={separation.job} onDismiss={separation.dismiss} />}
        {stemsLoading && <div className="w-full text-xs text-text-dim mt-1.5">Loading saved stems for {stemsLoading}…</div>}
      </header>

      {stems && (
        <div className="flex items-center gap-5 flex-wrap bg-panel rounded-xl px-4 py-2.5">
          <span className="flex items-center gap-2 text-xs text-text-dim">
            <Layers size={14} />
            Mixer
          </span>
          <Knob label="Vocals" value={vocalsVolume} onChange={setVocalsVolume} color={palette[1]} />
          <Knob label="BGM" value={bgmVolume} onChange={setBgmVolume} color={palette[0]} />
          <span className="text-[11px] text-text-dim truncate min-w-0 flex-1" title={`${stems.vocalsName} + ${stems.bgmName}`}>
            {stems.vocalsName} + {stems.bgmName}
          </span>
        </div>
      )}

      <Stage
        audioTimeRef={audioTimeRef}
        bassRef={bassRef}
        placedBlocksRef={placedBlocksRef}
        placedBlocks={placedBlocks}
        particleShapeBuffer={glbBuffer}
        onShapeError={handleShapeError}
        fontBuffer={fontBuffer}
        palette={palette}
        stageColors={stageColors}
        textColor={lyricColor}
        textSize={lyricSize}
        particleSize={particleSize}
        textEffect={textEffect}
      />

      <LyricFinder
        user={user}
        audioDuration={audioURL ? audioDuration : null}
        inputClassName={FIELD_BASE}
        buttonClassName={`${BTN_BASE} bg-panel-2 hover:bg-[#2E2136]`}
        onFound={handleLyricsFound}
      />

      <div className="flex gap-2.5 items-start">
        <textarea
          className="flex-1 bg-panel text-text border border-white/10 rounded-lg px-3 py-2.5 font-mono text-[13px] resize-y focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          placeholder="Paste lyrics here, one line per row... (Ctrl/Cmd+Enter to add)"
          value={lyricInput}
          onChange={(e) => setLyricInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleAddLyrics();
          }}
          rows={2}
        />
        <button className={`${BTN_BASE} bg-panel-2 hover:bg-[#2E2136]`} onClick={handleAddLyrics}>
          <Plus size={16} /> Add to bank
        </button>
      </div>

      <div className="flex gap-2 flex-wrap min-h-[20px] px-0.5 py-1">
        {lyricBank.length === 0 && (
          <span className="text-xs text-text-dim py-1.5">
            Add lyrics above, then drag each line onto the timeline below.
          </span>
        )}
        {lyricBank.map((item) => (
          <div
            key={item.id}
            className="flex items-center gap-1.5 bg-panel-2 border border-white/10 rounded-full px-3.5 py-1.5 text-xs cursor-grab select-none active:cursor-grabbing"
            style={fontLoaded ? { fontFamily: CUSTOM_FONT_FAMILY } : undefined}
            draggable
            onDragStart={(e) => handleDragStart(e, item)}
          >
            <span>{item.text}</span>
            <button onClick={(e)=> {e.stopPropagation(); handleRemoveFromBank(item.id);}}>
              <X size = {12} />
            </button>
          </div>
        ))}
      </div>

      <div className="bg-panel rounded-xl p-3 overflow-x-auto">
        <div
          className={`relative h-5 mb-1 select-none ${audioURL ? 'cursor-pointer' : ''}`}
          style={{ width: `${timeToX(audioDuration)}px` }}
          onPointerDown={handleRulerPointerDown}
          title={audioURL ? 'Drag to scrub the playhead' : undefined}
        >
          {ticks}
        </div>
        <div
          ref={trackRef}
          className={`relative h-[74px] rounded-lg transition-colors duration-150 ${isDragOver ? 'bg-timeline-active' : 'bg-timeline'}`}
          style={{ width: `${timeToX(audioDuration)}px` }}
          onPointerDown={(e) => { if (e.target === e.currentTarget) setAllSelected(false); }}
          onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={handleDrop}
        >
          <div
            ref={playheadRef}
            className="absolute top-0 bottom-0 w-0.5 bg-accent shadow-[0_0_8px_var(--color-accent)] z-[5] pointer-events-none"
            style={{ left: '0px' }}
          />
          {placedBlocks.map((block) => (
            <div
              key={block.id}
              className={`absolute top-2.5 h-[54px] rounded-md px-[18px] flex items-center cursor-grab active:cursor-grabbing shadow-[0_3px_10px_rgba(0,0,0,0.35)] min-w-[60px] ${allSelected || block.id === selectedBlockId ? 'ring-2 ring-white' : ''}`}
              style={{
                left: `${timeToX(block.start)}px`,
                width: `${timeToX(block.duration)}px`,
                background: `linear-gradient(135deg, ${block.color}, ${block.color}cc)`,
              }}
              onPointerDown={(e) => handleBlockPointerDown(e, block)}
              onDoubleClick={() => handleRemoveBlock(block)}
              title="Click to edit this chip's look · drag to move · drag right edge to resize · double-click to remove"
            >
              <span className="text-xs text-[#1A1120] font-semibold whitespace-nowrap overflow-hidden text-ellipsis">
                {block.text}
              </span>
              <div
                className="absolute right-0 top-0 bottom-0 w-2.5 cursor-ew-resize"
                onPointerDown={(e) => handleResizePointerDown(e, block)}
              />
            </div>
          ))}
        </div>
        <div className="text-[11px] text-text-dim mt-2">
          {allSelected
            ? 'All blocks selected: drag any block to move them together · Esc or click the empty track to deselect'
            : 'Drag a chip onto the track · drag a placed block to move it · drag its right edge to resize · double-click to send it back to the bank · press S to select all'}
        </div>
      </div>

      <audio
        ref={audioRef}
        src={audioURL || undefined}
        onLoadedMetadata={() => setAudioDuration(audioRef.current.duration || 60)}
        onEnded={() => {
          vocalsAudioRef.current?.pause();
          setIsPlaying(false);
        }}
        className="hidden"
      />
      <audio ref={vocalsAudioRef} src={stems?.vocalsURL || undefined} preload="auto" className="hidden" />
    </div>
  );
}

// One-line status for a cloud separation, with a progress bar while
// uploading or separating. Cold starts (container + model load) show as
// "running" at 0% for the first half-minute or so.
function SeparationStatus({ job, onDismiss }) {
  const pct = Math.round((job.progress ?? 0) * 100);
  const text = {
    checking: 'Checking for saved stems of this song…',
    uploading: `Uploading ${job.fileName}… ${pct}%`,
    queued: 'Starting a separation job on Google Cloud…',
    starting: 'Starting a separation job on Google Cloud…',
    running: pct > 0 ? `Separating vocals on Google Cloud… ${pct}%` : 'Separating vocals on Google Cloud (loading the model)…',
    downloading: 'Downloading the stems…',
    done: job.reused
      ? 'Found saved stems for this song, loaded into the mixer (no re-processing).'
      : `Stems ready${job.processingSeconds ? ` (processed in ${Math.round(job.processingSeconds)} s)` : ''}, loaded into the mixer.`,
    error: job.error,
  }[job.phase];
  const showBar = job.phase === 'uploading' || job.phase === 'running';

  return (
    <div className="w-full flex items-center gap-3 mt-1.5 text-xs">
      <span className={job.phase === 'error' ? 'text-[#E14F84]' : 'text-text-dim'}>{text}</span>
      {showBar && (
        <div className="h-1 w-40 rounded-full bg-white/10 overflow-hidden">
          <div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${pct}%` }} />
        </div>
      )}
      {(job.phase === 'done' || job.phase === 'error') && (
        <button className="text-text-dim hover:text-text cursor-pointer" onClick={onDismiss} title="Dismiss">
          <X size={12} />
        </button>
      )}
    </div>
  );
}

// Dropdown of the user's finished cloud separations. Picking one downloads
// its stems from Storage; nothing is re-processed.
function SavedStemsMenu({ uid, currentId, onPick, onClose }) {
  const [items, setItems] = useState(null); // null while loading
  const [error, setError] = useState('');

  useEffect(
    () => watchReadySeparations(uid, setItems, (err) => setError(err.message)),
    [uid],
  );

  const formatDate = (ts) => (ts?.toDate ? ts.toDate().toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute right-0 top-full mt-2 z-50 w-80 max-h-80 overflow-y-auto bg-panel border border-white/10 rounded-xl p-2 shadow-[0_8px_30px_rgba(0,0,0,0.5)] text-left">
        {error && <div className="text-xs text-[#E14F84] p-2">{error}</div>}
        {!error && items === null && <div className="text-xs text-text-dim p-2">Loading…</div>}
        {!error && items?.length === 0 && (
          <div className="text-xs text-text-dim p-2">No saved stems yet. Load a song and click Split vocals.</div>
        )}
        {items?.map((sep) => (
          <button
            key={sep.id}
            className={`w-full flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-[13px] cursor-pointer hover:bg-panel-2 ${sep.id === currentId ? 'bg-panel-2' : ''}`}
            onClick={() => onPick(sep)}
          >
            <span className="truncate">{sep.fileName ?? 'Untitled'}</span>
            <span className="shrink-0 text-[11px] text-text-dim tabular-nums">
              {sep.id === currentId ? 'loaded' : [sep.durationSeconds ? formatTime(sep.durationSeconds) : '', formatDate(sep.createdAt)].filter(Boolean).join(' · ')}
            </span>
          </button>
        ))}
      </div>
    </>
  );
}
