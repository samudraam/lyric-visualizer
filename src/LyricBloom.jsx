import { useRef, useState, useEffect } from 'react';
import { Play, Pause, Upload, Plus, Box, RotateCcw, Type, ExternalLink } from 'lucide-react';
import Stage from './Stage.jsx';
import { FLORAL_PALETTE } from './lib/palette.js';
import { loadCustomFont, CUSTOM_FONT_FAMILY } from './lib/font.js';
import { STAGE_CHANNEL_NAME } from './lib/stageChannel.js';

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
  const [lyricBank, setLyricBank] = useState([]);       // lines not yet placed: [{id, text}]
  const [placedBlocks, setPlacedBlocks] = useState([]);  // [{id, text, start, duration, color}]
  const [lyricInput, setLyricInput] = useState('');
  const [nextId, setNextId] = useState(1);

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
    const color = FLORAL_PALETTE[placedBlocks.length % FLORAL_PALETTE.length];

    setPlacedBlocks((prev) => [...prev, { id: item.id, text: item.text, start, duration: 2, color }]);
    setLyricBank((prev) => prev.filter((b) => b.id !== item.id));
  };

  const handleRemoveBlock = (block) => {
    setPlacedBlocks((prev) => prev.filter((b) => b.id !== block.id));
    setLyricBank((prev) => [...prev, { id: block.id, text: block.text }]);
  };

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
  const handleBlockPointerDown = (e, block) => {
    e.stopPropagation();
    const startX = e.clientX;
    const startTime = block.start;

    const onMove = (ev) => {
      const deltaTime = (ev.clientX - startX) / PIXELS_PER_SECOND;
      const newStart = clamp(startTime + deltaTime, 0, Math.max(0, audioDuration - block.duration));
      setPlacedBlocks((prev) => prev.map((b) => (b.id === block.id ? { ...b, start: newStart } : b)));
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  const handleResizePointerDown = (e, block) => {
    e.stopPropagation();
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
          <button
            className={`${BTN_BASE} bg-panel-2 hover:bg-[#2E2136]`}
            onClick={openStagePopout}
            title="Open the visualizer in its own window, synced to this one"
          >
            <ExternalLink size={16} />
            <span>Pop out</span>
          </button>
        </div>
        {glbError && <div className="w-full text-xs text-[#E14F84] mt-1.5">{glbError}</div>}
        {fontError && <div className="w-full text-xs text-[#E14F84] mt-1.5">{fontError}</div>}
      </header>

      <Stage
        audioTimeRef={audioTimeRef}
        bassRef={bassRef}
        placedBlocksRef={placedBlocksRef}
        particleShapeBuffer={glbBuffer}
        onShapeError={handleShapeError}
        fontBuffer={fontBuffer}
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
            className="bg-panel-2 border border-white/10 rounded-full px-3.5 py-1.5 text-xs cursor-grab select-none active:cursor-grabbing"
            style={fontLoaded ? { fontFamily: CUSTOM_FONT_FAMILY } : undefined}
            draggable
            onDragStart={(e) => handleDragStart(e, item)}
          >
            {item.text}
          </div>
        ))}
      </div>

      <div className="bg-panel rounded-xl p-3 overflow-x-auto">
        <div className="relative h-5 mb-1" style={{ width: `${timeToX(audioDuration)}px` }}>
          {ticks}
        </div>
        <div
          ref={trackRef}
          className={`relative h-[74px] rounded-lg transition-colors duration-150 ${isDragOver ? 'bg-[#33253C]' : 'bg-panel-2'}`}
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
              className="absolute top-2.5 h-[54px] rounded-[60%_40%_55%_45%/55%_45%_60%_40%] px-[18px] flex items-center cursor-grab active:cursor-grabbing shadow-[0_3px_10px_rgba(0,0,0,0.35)] min-w-[60px]"
              style={{
                left: `${timeToX(block.start)}px`,
                width: `${timeToX(block.duration)}px`,
                background: `linear-gradient(135deg, ${block.color}, ${block.color}cc)`,
              }}
              onPointerDown={(e) => handleBlockPointerDown(e, block)}
              onDoubleClick={() => handleRemoveBlock(block)}
              title="Drag to move · drag right edge to resize · double-click to remove"
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
