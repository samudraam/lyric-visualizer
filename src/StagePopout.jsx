import { useEffect, useRef, useState } from 'react';
import Stage from './Stage.jsx';
import { STAGE_CHANNEL_NAME } from './lib/stageChannel.js';
import { FLORAL_PALETTE, DEFAULT_STAGE_COLORS, DEFAULT_LYRIC_COLOR } from './lib/palette.js';

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
  const bassRef = useRef(0);
  const placedBlocksRef = useRef([]);

  const [shapeBuffer, setShapeBuffer] = useState(null);
  const [fontBuffer, setFontBuffer] = useState(null);
  const [palette, setPalette] = useState(FLORAL_PALETTE);
  const [stageColors, setStageColors] = useState(DEFAULT_STAGE_COLORS);
  const [lyricColor, setLyricColor] = useState(DEFAULT_LYRIC_COLOR);

  useEffect(() => {
    const channel = new BroadcastChannel(STAGE_CHANNEL_NAME);

    channel.onmessage = (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'sync':
          audioTimeRef.current = { currentTime: msg.currentTime, duration: msg.duration };
          bassRef.current = msg.bass;
          break;
        case 'lyrics':
          placedBlocksRef.current = msg.placedBlocks;
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
        bassRef={bassRef}
        placedBlocksRef={placedBlocksRef}
        particleShapeBuffer={shapeBuffer}
        fontBuffer={fontBuffer}
        palette={palette}
        stageColors={stageColors}
        textColor={lyricColor}
        heightClassName="h-screen"
      />
    </div>
  );
}
