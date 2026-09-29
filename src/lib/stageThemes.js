import { FLORAL_PALETTE, DEFAULT_STAGE_COLORS } from './palette.js';

// How the particle field (default sprites or an uploaded .glb) moves on Stage.
// Stage.jsx implements each one in its animate loop.
export const MOTION_MODES = [
  { id: 'fall', label: 'Falling', hint: 'Particles drift down; the signal speeds up the fall.' },
  { id: 'float', label: 'Still (reactive)', hint: 'Particles hold their place and bloom outward with the signal.' },
  { id: 'orbit', label: 'Rotation', hint: 'The whole field spins; the signal drives the spin speed.' },
];

// Which part of the audio the motion reacts to. Each maps to a 0..1 value in
// the audio-levels object LyricBloom.jsx writes every frame (see
// computeAudioLevels). The stem sources only exist with vocals + music stems
// loaded; without them Stage falls back to `fallback`.
export const REACT_SOURCES = [
  { id: 'bass', label: 'Bass' },
  { id: 'mids', label: 'Mids' },
  { id: 'highs', label: 'Highs' },
  { id: 'level', label: 'Overall level' },
  { id: 'vocals', label: 'Vocals stem', needsStems: true, fallback: 'mids' },
  { id: 'music', label: 'Music stem', needsStems: true, fallback: 'level' },
];

export const DEFAULT_GLB_SETTINGS = {
  motion: 'fall',
  reactTo: 'bass',
  sensitivity: 1, // multiplier on the chosen signal
  speed: 1,       // base fall / spin speed
  spin: 1,        // per-particle tumble (only visible on .glb shapes)
  pulse: 1,       // how much particle size swells with the signal
};

// The 0..1 levels Stage reacts to. `hasStems` tells it whether the stem
// sources are real or should fall back.
export const EMPTY_AUDIO_LEVELS = { bass: 0, mids: 0, highs: 0, level: 0, vocals: 0, music: 0, hasStems: false };

// Reads the chosen signal out of an audio-levels object, falling back when
// a stem source is picked but no stems are loaded.
export function readSignal(levels, reactTo) {
  if (!levels) return 0;
  const source = REACT_SOURCES.find((s) => s.id === reactTo) ?? REACT_SOURCES[0];
  const key = source.needsStems && !levels.hasStems ? source.fallback : source.id;
  return levels[key] || 0;
}

// Presets that bundle a look (palette + stage gradient) with a motion setup.
// Picking one in the GLB settings panel overwrites all three; any edit after
// that just shows the theme picker as "Custom".
export const STAGE_THEMES = [
  {
    id: 'floral',
    label: 'Floral Fall',
    palette: FLORAL_PALETTE,
    stageColors: DEFAULT_STAGE_COLORS,
    glbSettings: DEFAULT_GLB_SETTINGS,
  },
  {
    id: 'bass-storm',
    label: 'Bass Storm',
    palette: ['#FF3B3B', '#FF8A00', '#FFD23F', '#FF5E78', '#FFFFFF', '#C2185B'],
    stageColors: { inner: '#2A0A0A', outer: '#000000' },
    glbSettings: { motion: 'fall', reactTo: 'bass', sensitivity: 1.8, speed: 1.4, spin: 2, pulse: 1.6 },
  },
  {
    id: 'vocal-bloom',
    label: 'Vocal Bloom',
    palette: ['#F7B2D9', '#C3A6FF', '#FFE3A3', '#A8E6CF', '#FFFFFF', '#FF9CB5'],
    stageColors: { inner: '#2B1B33', outer: '#07030A' },
    glbSettings: { motion: 'float', reactTo: 'vocals', sensitivity: 1.3, speed: 0.6, spin: 0.5, pulse: 1.4 },
  },
  {
    id: 'galaxy',
    label: 'Bass Galaxy',
    palette: ['#6C8CFF', '#9D6CFF', '#48E5C2', '#FFFFFF', '#3D5AFE', '#B388FF'],
    stageColors: { inner: '#0D1030', outer: '#000000' },
    glbSettings: { motion: 'orbit', reactTo: 'bass', sensitivity: 1.2, speed: 1, spin: 0.8, pulse: 0.8 },
  },
  {
    id: 'neon-shimmer',
    label: 'Neon Shimmer',
    palette: ['#00F5D4', '#F15BB5', '#FEE440', '#00BBF9', '#9B5DE5', '#FFFFFF'],
    stageColors: { inner: '#0B1E24', outer: '#020608' },
    glbSettings: { motion: 'float', reactTo: 'highs', sensitivity: 2, speed: 1.2, spin: 1.5, pulse: 1.8 },
  },
];

// The theme whose look + motion exactly match the current values, or null
// ("Custom") once anything has been tweaked.
export function matchStageTheme(palette, stageColors, glbSettings) {
  const current = JSON.stringify([palette, stageColors, { ...DEFAULT_GLB_SETTINGS, ...glbSettings }]);
  return STAGE_THEMES.find((t) => JSON.stringify([t.palette, t.stageColors, t.glbSettings]) === current) ?? null;
}
