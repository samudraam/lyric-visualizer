// Abstract "floral" palette for the falling particles — warm marigold,
// magenta/rose, saffron, berry, sage, and coral. Shared by Stage.jsx (particle
// colors) and LyricBloom.jsx (lyric block gradients) so the whole UI reads as
// one connected system.
export const FLORAL_PALETTE = ['#F2A93B', '#E14F84', '#F6C445', '#C1447E', '#8FBF7F', '#F2835E'];

// Default two-stop radial gradient behind the Stage's falling particles —
// adjustable from the settings menu, shared as a fallback/reset target by
// LyricBloom.jsx, Stage.jsx, and StagePopout.jsx.
export const DEFAULT_STAGE_COLORS = { inner: '#241A29', outer: '#000000' };

// Default color of the active-lyric text shown on Stage — matches the
// app's base --color-text so it's unchanged until adjusted in settings.
export const DEFAULT_LYRIC_COLOR = '#f5ede4';

// Default max font size (px) of the active-lyric text — matches the original
// hardcoded clamp(20px, 4vw, 40px) upper bound, so the default look is
// unchanged until adjusted in settings.
export const DEFAULT_LYRIC_SIZE = 40;

// Default size (scene units, applied on top of the bass-reactive pulse) of
// an uploaded .glb particle shape — matches the original hardcoded 0.4.
export const DEFAULT_PARTICLE_SIZE = 0.4;
