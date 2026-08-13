// Registers an uploaded font file with the current document so it can be
// referenced by name in CSS. Each tab (the main editor and, later, the
// pop-out visualizer) runs this itself against its own `document.fonts` —
// a FontFace loaded in one tab isn't visible in another.
export const CUSTOM_FONT_FAMILY = 'LyricBloomCustomFont';

export async function loadCustomFont(buffer) {
  const face = new FontFace(CUSTOM_FONT_FAMILY, buffer);
  await face.load();
  document.fonts.add(face);
}
