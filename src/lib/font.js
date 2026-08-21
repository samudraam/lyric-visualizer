// Registers an uploaded font file with the current document so it can be
// referenced by name in CSS. Each tab (the main editor and the pop-out
// visualizer) runs this itself against its own `document.fonts` — a
// FontFace loaded in one tab isn't visible in another.
//
// `family` defaults to the single global lyric font, but callers can pass a
// distinct name (see blockFontFamily) so multiple different uploaded fonts —
// e.g. one per placed lyric block — can be registered and used at once
// without colliding under the same font-family name.
export const CUSTOM_FONT_FAMILY = 'LyricBloomCustomFont';

export async function loadCustomFont(buffer, family = CUSTOM_FONT_FAMILY) {
  const face = new FontFace(family, buffer);
  await face.load();
  document.fonts.add(face);
}

// A self-contained @font-face rule (font bytes inlined as base64) for the
// same buffer. vfx-js's shader effects snapshot the lyric node into an
// isolated SVG image with no access to this document's `document.fonts`,
// so that snapshot needs its own copy of the font embedded directly in its
// markup — see Stage.jsx, where this is rendered as a <style> child of the
// node passed to vfx.add().
export function customFontFaceCss(buffer, family = CUSTOM_FONT_FAMILY) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const base64 = btoa(binary);
  return `@font-face { font-family: '${family}'; src: url(data:application/octet-stream;base64,${base64}); }`;
}

// Per-block font-family name, so each placed lyric block with its own
// uploaded font gets a name distinct from CUSTOM_FONT_FAMILY (the global
// lyric font) and from every other block's.
export function blockFontFamily(blockId) {
  return `LyricBloomBlockFont-${blockId}`;
}
