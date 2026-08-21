// Iterable menu of WebGL text effects, backed by @vfx-js/core's built-in
// shader presets (https://amagi.dev/vfx-js/). Both the settings dropdown
// (LyricBloom.jsx) and the actual shader application (Stage.jsx) read from
// this single list — add a new effect by adding an entry here, nothing else
// needs to change.
//
// `overflow` tells vfx-js how many px beyond the element's own box the
// shader is allowed to render into — effects like glitch/rgbShift displace
// pixels past the text's natural bounds and get clipped without it.
export const TEXT_EFFECTS = [
  { id: 'none', label: 'None', shader: null },
  { id: 'rainbow', label: 'Rainbow', shader: 'rainbow' },
  { id: 'rgbShift', label: 'RGB Shift', shader: 'rgbShift', overflow: 40 },
  { id: 'glitch', label: 'Glitch', shader: 'glitch', overflow: 40 },
  { id: 'halftone', label: 'Halftone', shader: 'halftone' },
  { id: 'duotone', label: 'Duotone', shader: 'duotone' },
  { id: 'pixelate', label: 'Pixelate', shader: 'pixelate' },
  // The four below key off vfx-js's own enterTime/leaveTime/intersection
  // uniforms, which it updates automatically as a node attaches/detaches —
  // no extra wiring needed, they just animate in each time a new lyric
  // block's div (re)mounts and gets vfx.add()'d.
  { id: 'pixelateTransition', label: 'Pixelate Transition', shader: 'pixelateTransition' },
  { id: 'slitScanTransition', label: 'Slit Scan Transition', shader: 'slitScanTransition' },
  { id: 'warpTransition', label: 'Warp Transition', shader: 'warpTransition', overflow: 40 },
  { id: 'focusTransition', label: 'Focus Transition', shader: 'focusTransition', overflow: 40 },
];

export const DEFAULT_TEXT_EFFECT = TEXT_EFFECTS[0].id;

export function getTextEffect(id) {
  return TEXT_EFFECTS.find((e) => e.id === id) || TEXT_EFFECTS[0];
}
