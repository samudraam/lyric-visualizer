// BroadcastChannel used to mirror the editor tab's Stage into the pop-out
// visualizer tab (StagePopout.jsx). Both sides construct their own
// `new BroadcastChannel(STAGE_CHANNEL_NAME)` — same-origin tabs sharing this
// name can post/receive from each other with no server involved.
export const STAGE_CHANNEL_NAME = 'lyric-bloom-stage';

// Message shapes posted over the channel:
//   { type: 'sync', currentTime, duration, bass }  — editor → popout, every frame
//   { type: 'lyrics', placedBlocks }                — editor → popout, on edit
//   { type: 'shape', buffer }                       — editor → popout, on .glb upload/reset
//   { type: 'font', buffer }                        — editor → popout, on font upload/reset
//   { type: 'palette', palette }                     — editor → popout, on settings-menu edit
//   { type: 'stageColors', stageColors }             — editor → popout, on settings-menu edit
//   { type: 'lyricColor', lyricColor }                — editor → popout, on settings-menu edit
//   { type: 'ready' }                                — popout → editor, once on mount
