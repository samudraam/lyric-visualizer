import { useRef, useState, useEffect } from 'react';
import { Play, Pause, Upload, Plus, Box, X, RotateCcw, Type, ExternalLink, Settings } from 'lucide-react';
import Stage from './Stage.jsx';
import { FLORAL_PALETTE, DEFAULT_STAGE_COLORS, DEFAULT_LYRIC_COLOR, DEFAULT_LYRIC_SIZE, DEFAULT_PARTICLE_SIZE } from './lib/palette.js';
import { loadCustomFont, CUSTOM_FONT_FAMILY } from './lib/font.js';
import { STAGE_CHANNEL_NAME } from './lib/stageChannel.js';
import { TEXT_EFFECTS, DEFAULT_TEXT_EFFECT } from './lib/textEffects.js';
import { loadState, saveState } from './lib/persistence.js';

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
  const [audioDuration, setAudioDuration] = useState(60); // seconds; refined once metadata loads
  const [isPlaying, setIsPlaying] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  const [glbBuffer, setGlbBuffer] = useState(null); // raw uploaded .glb bytes, or null for default particles
  const [glbName, setGlbName] = useState('');
  const [glbError, setGlbError] = useState('');

  const [fontBuffer, setFontBuffer] = useState(null); // raw uploaded font bytes, or null for the default typeface
  const [fontName, setFontName] = useState('');
  const [fontError, setFontError] = useState('');
  const [fontLoaded, setFontLoaded] = useState(false); // whether the uploaded font has finished loading in THIS document

  const [showSettings, setShowSettings] = useState(false); // palette/stage-color/font settings menu
  const [selectedBlockId, setSelectedBlockId] = useState(null); // placed block currently shown in the settings menu's per-chip section
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

  // Persist lyrics/timeline + settings-menu state to localStorage on every
  // change, so a reload picks up where this session left off (see the
  // matching read in the savedState initializer above).
  useEffect(() => {
    saveState({
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
    });
  }, [lyricBank, placedBlocks, nextId, palette, stageColors, lyricColor, lyricSize, particleSize, textEffect]);

  // Revoke the previous object URL when a new audio file is chosen, or on
  // unmount — object URLs hold a reference to the underlying file blob in
  // memory until explicitly released.
  useEffect(() => {
    return () => {
      if (audioURL) URL.revokeObjectURL(audioURL);
    };
  }, [audioURL]);

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
    const source = ctx.createMediaElementSource(audioRef.current);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    // Graph: <audio> → source → analyser → speakers.
    // Routing through the analyser doesn't change what you hear; it just
    // gives us a tap point to read frequency data from every frame.
    source.connect(analyser);
    analyser.connect(ctx.destination);

    audioCtxRef.current = ctx;
    analyserRef.current = analyser;
    dataArrayRef.current = new Uint8Array(analyser.frequencyBinCount);
  };

  const togglePlay = () => {
    if (!audioRef.current || !audioURL) return;
    ensureAudioGraph();
    if (audioCtxRef.current.state === 'suspended') audioCtxRef.current.resume();
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play();
      setIsPlaying(true);
    }
  };

  const handleAudioFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (audioURL) URL.revokeObjectURL(audioURL);
    setAudioURL(URL.createObjectURL(file));
    setAudioName(file.name);
    setIsPlaying(false);
  };

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
  const openStagePopout = () => {
    window.open(`${window.location.pathname}?stage=1`, 'lyric-bloom-stage', 'width=960,height=600');
  };

  /* =======================================================================
     LYRIC BANK
     ======================================================================= */
  const handleAddLyrics = () => {
    const lines = lyricInput.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return;
    const newItems = lines.map((text, i) => ({ id: nextId + i, text }));
    setLyricBank((prev) => [...prev, ...newItems]);
    setNextId((prev) => prev + lines.length);
    setLyricInput('');
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

    const onMove = (ev) => {
      if (!dragged && (Math.abs(ev.clientX - startX) > CLICK_DRAG_THRESHOLD || Math.abs(ev.clientY - startY) > CLICK_DRAG_THRESHOLD)) {
        dragged = true;
      }
      const deltaTime = (ev.clientX - startX) / PIXELS_PER_SECOND;
      const newStart = clamp(startTime + deltaTime, 0, Math.max(0, audioDuration - block.duration));
      setPlacedBlocks((prev) => prev.map((b) => (b.id === block.id ? { ...b, start: newStart } : b)));
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      if (!dragged) {
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
          <button
            className={`${BTN_BASE} border-none bg-gradient-to-br from-[#E14F84] to-[#F2A93B]`}
            onClick={togglePlay}
            disabled={!audioURL}
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
        </div>
        {glbError && <div className="w-full text-xs text-[#E14F84] mt-1.5">{glbError}</div>}
      </header>

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
              className={`absolute top-2.5 h-[54px] rounded-md px-[18px] flex items-center cursor-grab active:cursor-grabbing shadow-[0_3px_10px_rgba(0,0,0,0.35)] min-w-[60px] ${block.id === selectedBlockId ? 'ring-2 ring-white' : ''}`}
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
          Drag a chip onto the track · drag a placed block to move it · drag its right edge to resize · double-click to send it back to the bank
        </div>
      </div>

      <audio
        ref={audioRef}
        src={audioURL || undefined}
        onLoadedMetadata={() => setAudioDuration(audioRef.current.duration || 60)}
        onEnded={() => setIsPlaying(false)}
        className="hidden"
      />
    </div>
  );
}
