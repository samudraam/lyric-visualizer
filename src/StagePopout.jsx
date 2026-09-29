import { useEffect, useRef, useState } from 'react';
import Stage from './Stage.jsx';
import { STAGE_CHANNEL_NAME } from './lib/stageChannel.js';
import { FLORAL_PALETTE, DEFAULT_STAGE_COLORS, DEFAULT_LYRIC_COLOR, DEFAULT_LYRIC_SIZE, DEFAULT_PARTICLE_SIZE } from './lib/palette.js';
import { DEFAULT_TEXT_EFFECT } from './lib/textEffects.js';
import { DEFAULT_GLB_SETTINGS, EMPTY_AUDIO_LEVELS } from './lib/stageThemes.js';

/* =========================================================================
   StagePopout — the visualizer-only view opened in a second tab.
   -------------------------------------------------------------------------
   Renders the exact same <Stage/> the editor tab does, but fed entirely by
   BroadcastChannel messages instead of a real <audio> element — audio only
   ever plays in the editor tab, this one just mirrors its playback position,
   lyrics, particle shape, and font in real time. See lib/stageChannel.js for
   the message shapes and LyricBloom.jsx for the sending side.
   ========================================================================= */
export default function StagePopout() {
  const audioTimeRef = useRef({ currentTime: 0, duration: 0 });
  const audioLevelsRef = useRef(EMPTY_AUDIO_LEVELS);
  const placedBlocksRef = useRef([]);
  // Mirrors placedBlocksRef into real state too — Stage's per-block font
  // preloading effect needs a reactive prop to key off of, not just a ref it
  // only reads once per animation frame.
  const [placedBlocks, setPlacedBlocks] = useState([]);

  const [shapeBuffer, setShapeBuffer] = useState(null);
  const [fontBuffer, setFontBuffer] = useState(null);
  const [palette, setPalette] = useState(FLORAL_PALETTE);
  const [stageColors, setStageColors] = useState(DEFAULT_STAGE_COLORS);
  const [lyricColor, setLyricColor] = useState(DEFAULT_LYRIC_COLOR);
  const [lyricSize, setLyricSize] = useState(DEFAULT_LYRIC_SIZE);
  const [particleSize, setParticleSize] = useState(DEFAULT_PARTICLE_SIZE);
  const [textEffect, setTextEffect] = useState(DEFAULT_TEXT_EFFECT);
  const [glbSettings, setGlbSettings] = useState(DEFAULT_GLB_SETTINGS);

  useEffect(() => {
    const channel = new BroadcastChannel(STAGE_CHANNEL_NAME);

    channel.onmessage = (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'sync':
          audioTimeRef.current = { currentTime: msg.currentTime, duration: msg.duration };
          audioLevelsRef.current = msg.levels;
          break;
        case 'lyrics':
          placedBlocksRef.current = msg.placedBlocks;
          setPlacedBlocks(msg.placedBlocks);
          break;
        case 'shape':
          setShapeBuffer(msg.buffer);
          break;
        case 'font':
          setFontBuffer(msg.buffer);
          break;
        case 'palette':
          setPalette(msg.palette);
          break;
        case 'stageColors':
          setStageColors(msg.stageColors);
          break;
        case 'lyricColor':
          setLyricColor(msg.lyricColor);
          break;
        case 'lyricSize':
          setLyricSize(msg.lyricSize);
          break;
        case 'particleSize':
          setParticleSize(msg.particleSize);
          break;
        case 'textEffect':
          setTextEffect(msg.textEffect);
          break;
        case 'glbSettings':
          setGlbSettings(msg.glbSettings);
          break;
        default:
          break;
      }
    };

    // Announce that we're up so the editor tab immediately resends its
    // current lyrics/shape/font snapshot — those only broadcast on change,
    // so without this a freshly opened pop-out would stay blank until the
    // next edit.
    channel.postMessage({ type: 'ready' });

    return () => channel.close();
  }, []);

  return (
    <div className="min-h-screen w-screen bg-bg">
      <Stage
        audioTimeRef={audioTimeRef}
        audioLevelsRef={audioLevelsRef}
        placedBlocksRef={placedBlocksRef}
        placedBlocks={placedBlocks}
        particleShapeBuffer={shapeBuffer}
        fontBuffer={fontBuffer}
        palette={palette}
        stageColors={stageColors}
        textColor={lyricColor}
        textSize={lyricSize}
        particleSize={particleSize}
        textEffect={textEffect}
        glbSettings={glbSettings}
        heightClassName="h-screen"
      />
    </div>
  );
}
