import { useRef, useState, useEffect } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FLORAL_PALETTE, DEFAULT_STAGE_COLORS, DEFAULT_LYRIC_COLOR, DEFAULT_LYRIC_SIZE, DEFAULT_PARTICLE_SIZE } from './lib/palette.js';
import { loadCustomFont, CUSTOM_FONT_FAMILY, customFontFaceCss, blockFontFamily } from './lib/font.js';
import { VFX } from '@vfx-js/core';
import { DEFAULT_TEXT_EFFECT, getTextEffect } from './lib/textEffects.js';

/* =========================================================================
   MODULE-LEVEL CONSTANTS & PURE HELPER FUNCTIONS
   -------------------------------------------------------------------------
   Pure, stateless Three.js/particle logic lives outside the component so it
   isn't recreated on every render — see LyricBloom.jsx for the same pattern.
   ========================================================================= */

// Generates a soft circular sprite (radial gradient baked onto a canvas)
// used as the texture for each particle point. Without this, THREE.Points
// renders hard-edged squares — not what we want for a soft floral glow.
function createParticleTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.4, 'rgba(255,255,255,0.55)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

// How many falling particles to simulate. The instanced-mesh path (custom
// .glb shapes) uses fewer instances than the sprite-point path, since each
// instance carries a real 3D mesh instead of a single textured quad.
const POINTS_PARTICLE_COUNT = 650;
const MESH_PARTICLE_COUNT = 220;

// Generates the shared physics state for a batch of falling particles —
// starting position, fall speed, drift phase, and a palette color — used
// by both the default sprite points and the custom-shape instanced mesh.
function createParticleField(count, palette) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const speeds = new Float32Array(count);
  const phases = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 16;
    positions[i * 3 + 1] = Math.random() * 12 - 5;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 6;

    speeds[i] = 0.006 + Math.random() * 0.018;
    phases[i] = Math.random() * Math.PI * 2;

    const hex = palette[Math.floor(Math.random() * palette.length)];
    const c = new THREE.Color(hex);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }

  return { positions, colors, speeds, phases, count };
}

// Pulls the first mesh out of a loaded glTF, then centers it and normalizes
// its geometry to a max dimension of 1 — regardless of the original model's
// size/origin, so it can be scaled to any on-screen size later. The actual
// visual size is applied per-frame in the animate loop below (particleSize
// prop × the bass-reactive pulse), so adjusting it doesn't require re-parsing
// the .glb.
function extractParticleGeometry(gltf) {
  gltf.scene.updateMatrixWorld(true);

  let found = null;
  gltf.scene.traverse((child) => {
    if (!found && child.isMesh && child.geometry) found = child;
  });
  if (!found) return null;

  const geometry = found.geometry.clone();
  geometry.applyMatrix4(found.matrixWorld);
  geometry.computeBoundingBox();

  const box = geometry.boundingBox;
  const center = new THREE.Vector3();
  box.getCenter(center);
  geometry.translate(-center.x, -center.y, -center.z);

  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const scale = 1 / maxDim;
  geometry.scale(scale, scale, scale);

  return geometry;
}

/* =========================================================================
   Stage — the falling-particle visualizer + active-lyric overlay.
   -------------------------------------------------------------------------
   Deliberately reads its live playback data through plain refs instead of
   touching an <audio> element or AnalyserNode directly: `audioTimeRef` and
   `bassRef` are written every frame by whoever renders this component. In
   LyricBloom.jsx that's a real Web Audio analyser; in the pop-out tab
   (StagePopout.jsx) it's values mirrored in over BroadcastChannel. Stage
   itself doesn't need to know or care which — same code path either way.
   ========================================================================= */
// Default sizing for Stage embedded inline in the editor; StagePopout.jsx
// overrides this to fill its own window instead.
const DEFAULT_HEIGHT_CLASSES = 'h-[55vh] sm:h-[42vh] min-h-[260px]';

export default function Stage({
  audioTimeRef,
  bassRef,
  placedBlocksRef,
  placedBlocks = [],
  particleShapeBuffer,
  onShapeError,
  fontBuffer,
  palette = FLORAL_PALETTE,
  stageColors = DEFAULT_STAGE_COLORS,
  textColor = DEFAULT_LYRIC_COLOR,
  textSize = DEFAULT_LYRIC_SIZE,
  particleSize = DEFAULT_PARTICLE_SIZE,
  heightClassName = DEFAULT_HEIGHT_CLASSES,
  textEffect = DEFAULT_TEXT_EFFECT,
}) {
  // The whole active placedBlocks entry (or null), not just its text — so a
  // block's own textColor/textEffect/font overrides (see the "effective *"
  // values below) travel with it as playback moves from block to block.
  const [activeBlock, setActiveBlock] = useState(null);
  const activeBlockIdRef = useRef(null);
  // Loaded independently of LyricBloom.jsx's own font load — each renders
  // into its own `document`, and a pop-out tab (StagePopout.jsx) needs its
  // own FontFace registration regardless of what the editor tab already did.
  const [fontLoaded, setFontLoaded] = useState(false);
  // Same font, but as a self-contained @font-face rule — see customFontFaceCss.
  const [fontFaceCss, setFontFaceCss] = useState('');

  useEffect(() => {
    let cancelled = false;
    const applyFont = async () => {
      if (!fontBuffer) {
        if (!cancelled) {
          setFontLoaded(false);
          setFontFaceCss('');
        }
        return;
      }
      try {
        await loadCustomFont(fontBuffer);
        if (!cancelled) {
          setFontLoaded(true);
          setFontFaceCss(customFontFaceCss(fontBuffer));
        }
      } catch {
        if (!cancelled) {
          setFontLoaded(false);
          setFontFaceCss('');
        }
      }
    };
    applyFont();
    return () => {
      cancelled = true;
    };
  }, [fontBuffer]);

  /* =======================================================================
     PER-BLOCK FONTS — each placedBlocks entry can carry its own uploaded
     font, distinct from the single global one above.
     -----------------------------------------------------------------------
     Keyed by block id rather than reloaded per-active-lyric: preloading
     every block's font as soon as it's uploaded (instead of only when that
     block becomes active) avoids a visible fallback-font flash the first
     time playback reaches it. blockFontCacheRef tracks which ArrayBuffer is
     currently loaded/loading for each id, so re-running this effect (it
     fires on every placedBlocks change, including drag-reposition) doesn't
     redundantly reload a font whose bytes haven't actually changed.
     ======================================================================= */
  const [blockFonts, setBlockFonts] = useState({}); // blockId -> { family, css }
  const blockFontCacheRef = useRef(new Map()); // blockId -> the ArrayBuffer currently loaded/loading for it

  useEffect(() => {
    let cancelled = false;
    // Drop cache entries for blocks that no longer exist, so re-adding a
    // block that reuses a stale id later doesn't skip loading its font.
    // (blockFonts state itself is left to accumulate — a removed block's
    // entry there is simply never read again, since the animate loop below
    // clears activeBlock to null within one frame of the block vanishing
    // from placedBlocksRef.)
    const liveIds = new Set(placedBlocks.map((b) => b.id));
    for (const id of blockFontCacheRef.current.keys()) {
      if (!liveIds.has(id)) blockFontCacheRef.current.delete(id);
    }

    placedBlocks.forEach((block) => {
      if (!block.fontBuffer) return;
      if (blockFontCacheRef.current.get(block.id) === block.fontBuffer) return; // already loaded this exact buffer

      blockFontCacheRef.current.set(block.id, block.fontBuffer);
      const family = blockFontFamily(block.id);
      loadCustomFont(block.fontBuffer, family)
        .then(() => {
          if (cancelled || blockFontCacheRef.current.get(block.id) !== block.fontBuffer) return;
          setBlockFonts((prev) => ({ ...prev, [block.id]: { family, css: customFontFaceCss(block.fontBuffer, family) } }));
        })
        .catch(() => {
          // Leave this block without a font override — effectiveFontFamily
          // below just falls back to the global font.
        });
    });

    return () => {
      cancelled = true;
    };
  }, [placedBlocks]);

  // The currently-active block's own overrides win; anything it doesn't set
  // falls back to the global settings passed in as props.
  const activeBlockFont = activeBlock ? blockFonts[activeBlock.id] : null;
  const effectiveTextColor = activeBlock?.textColor || textColor;
  const effectiveTextEffect = activeBlock?.textEffect || textEffect;
  const effectiveFontFamily = activeBlockFont ? activeBlockFont.family : (fontLoaded ? CUSTOM_FONT_FAMILY : null);
  const effectiveFontFaceCss = activeBlockFont ? activeBlockFont.css : (fontLoaded ? fontFaceCss : '');

  const mountRef = useRef(null);       // div the Three.js canvas mounts into
  const rafRef = useRef(null);         // requestAnimationFrame id, for cleanup
  const sceneRef = useRef(null);       // so buildParticles() can run outside the mount effect
  // { mode: 'points' | 'mesh', object3D, positions, speeds, phases, count, dummy? }
  const particlesRef = useRef(null);
  // Remembers the currently-active custom shape (or null for default sprite
  // points) so the palette-change effect below can rebuild particles without
  // needing to re-parse the .glb — it just re-reads whatever shape is live.
  const shapeGeometryRef = useRef(null);
  // The sprite texture is a fixed radial-gradient glow with no dependency on
  // palette/shape — created once and reused across every buildParticles()
  // call instead of regenerating (and leaking) a new canvas+GPU texture on
  // every palette tweak. See buildParticles below.
  const particleTextureRef = useRef(null);
  // The animate loop below is set up once on mount (empty dependency array),
  // so it reads particleSize through this ref instead of the prop directly —
  // same "live mirror" trick as bassRef/audioTimeRef.
  const particleSizeRef = useRef(particleSize);
  useEffect(() => {
    particleSizeRef.current = particleSize;
  }, [particleSize]);
  // Same live-mirror trick, but for the active block's effective text effect
  // (global default, or that block's own override) — read by the mount
  // effect below and the ref callback in the JSX, neither of which can read
  // component state/props directly since they don't re-run on every render.
  const effectiveTextEffectRef = useRef(effectiveTextEffect);
  useEffect(() => {
    effectiveTextEffectRef.current = effectiveTextEffect;
  }, [effectiveTextEffect]);

  const vfxRef = useRef(null);            // the shared VFX instance, created once in the setup effect
  const vfxCanvasRef = useRef(null);      // vfx-js's own overlay <canvas>, captured so we can remove it ourselves — see setup effect
  const vfxAttachedNodeRef = useRef(null); // DOM node currently holding a *resolved* vfx-js attachment, or null
  const activeLyricNodeRef = useRef(null); // the (possibly empty-text) lyric div, kept live by the ref callback below
  // vfx.add() is async (it snapshots the node to a canvas texture before
  // registering it internally), so a call can still be in flight when a
  // newer one supersedes it — e.g. the font finishes loading right as the
  // effect picker changes. Each call stamps the generation it was issued
  // at; when its promise resolves, it only claims vfxAttachedNodeRef if
  // it's still current — otherwise it undoes its own vfx.add() so it
  // doesn't linger as an orphaned shader layer nothing else points at.
  const effectGenerationRef = useRef(0);

  // Swaps whatever vfx-js attachment currently exists for `effectId` on `node`.
  // Always removes before adding — vfx-js has no documented dispose(), so
  // vfxAttachedNodeRef is how we track whether there's anything to remove at
  // all, rather than relying on vfx.remove() being a safe no-op otherwise.
  const applyTextEffect = (node, effectId) => {
    const vfx = vfxRef.current;
    if (!vfx) return;
    const generation = ++effectGenerationRef.current;

    if (vfxAttachedNodeRef.current) {
      vfx.remove(vfxAttachedNodeRef.current);
      vfxAttachedNodeRef.current = null;
    }
    if (!node) return;

    const effect = getTextEffect(effectId);
    if (!effect.shader) return;

    vfx.add(node, { shader: effect.shader, overflow: effect.overflow }).then(() => {
      if (generation !== effectGenerationRef.current) {
        vfx.remove(node);
        return;
      }
      vfxAttachedNodeRef.current = node;
    });
  };

  /* =======================================================================
     PARTICLE SYSTEM BUILDER
     -----------------------------------------------------------------------
     (Re)builds the falling-particle system: either the default soft-glow
     sprite points, or — when shapeGeometry is provided — an instanced mesh
     of an uploaded .glb model. Both share the same fall/drift physics from
     createParticleField(); only how each particle is drawn differs. Called
     once on mount (below) and again whenever particleShapeBuffer changes, so
     it disposes whatever particle system was previously in the scene first.
     ======================================================================= */
  const buildParticles = (shapeGeometry) => {
    const scene = sceneRef.current;
    if (!scene) return;

    const prev = particlesRef.current;
    if (prev) {
      scene.remove(prev.object3D);
      // Custom-shape mode reuses the same geometry object (shapeGeometryRef)
      // across rebuilds — disposing it here would free GPU buffers the new
      // mesh below is about to reattach and reuse. Only dispose when this
      // rebuild is actually switching to a different geometry.
      if (prev.object3D.geometry !== shapeGeometry) {
        prev.object3D.geometry.dispose();
      }
      prev.object3D.material.dispose();
    }
    if (!particleTextureRef.current) {
      particleTextureRef.current = createParticleTexture();
    }

    if (shapeGeometry) {
      const field = createParticleField(MESH_PARTICLE_COUNT, palette);
      // No vertexColors flag here — per-instance tinting goes through
      // InstancedMesh's own instanceColor channel, which doesn't require
      // the uploaded geometry to carry a vertex color attribute.
      const material = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 });
      const mesh = new THREE.InstancedMesh(shapeGeometry, material, field.count);
      const dummy = new THREE.Object3D();
      const color = new THREE.Color();
      for (let i = 0; i < field.count; i++) {
        dummy.position.set(field.positions[i * 3], field.positions[i * 3 + 1], field.positions[i * 3 + 2]);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        color.setRGB(field.colors[i * 3], field.colors[i * 3 + 1], field.colors[i * 3 + 2]);
        mesh.setColorAt(i, color);
      }
      mesh.instanceMatrix.needsUpdate = true;
      scene.add(mesh);
      particlesRef.current = { mode: 'mesh', object3D: mesh, dummy, ...field };
    } else {
      const field = createParticleField(POINTS_PARTICLE_COUNT, palette);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(field.positions, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(field.colors, 3));
      const material = new THREE.PointsMaterial({
        size: 0.14,
        map: particleTextureRef.current,
        vertexColors: true,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
      });
      const points = new THREE.Points(geometry, material);
      scene.add(points);
      particlesRef.current = { mode: 'points', object3D: points, ...field };
    }
  };

  /* =======================================================================
     THREE.JS SETUP — runs exactly once (empty dependency array)
     -----------------------------------------------------------------------
     Why one big effect instead of splitting scene/particles/loop apart?
     Because they all share the same renderer/scene/camera lifecycle — they
     need to be created together and torn down together. Splitting them
     would mean juggling multiple refs just to hand objects between effects.
     ======================================================================= */
  useEffect(() => {
    const mount = mountRef.current;
    const width = mount.clientWidth;
    const height = mount.clientHeight;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 100);
    camera.position.z = 6;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    sceneRef.current = scene;

    // Same lifecycle spot as renderer/scene: created once on mount, torn
    // down once on unmount. Whichever lyric div is already mounted (set by
    // the ref callback below, which runs during commit — before this effect)
    // gets its shader attached immediately after.
    //
    // vfx-js has no documented destroy(), but its constructor appends its
    // own full-page overlay <canvas> straight to the DOM. Diff canvases
    // before/after construction to capture that element ourselves — without
    // this, StrictMode's dev-mode double-invoke (mount → cleanup → mount)
    // orphans the first instance's canvas permanently, and you get two
    // shader overlays stacked on top of each other.
    const canvasesBefore = new Set(document.querySelectorAll('canvas'));
    vfxRef.current = new VFX();
    vfxCanvasRef.current = Array.from(document.querySelectorAll('canvas')).find((c) => !canvasesBefore.has(c)) || null;
    applyTextEffect(activeLyricNodeRef.current, effectiveTextEffectRef.current);

    // Lighting only matters once a custom .glb shape is active — the default
    // sprite points are unlit (additive-blended glow texture) and ignore
    // scene lights entirely, so adding these upfront is harmless either way.
    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const keyLight = new THREE.DirectionalLight(0xffffff, 0.8);
    keyLight.position.set(2, 4, 3);
    scene.add(keyLight);

    // Build the default particle field synchronously so the animate loop
    // below always has something to read on its very first frame — the
    // effect that reacts to particleShapeBuffer (further down) will rebuild
    // this again once it runs, which is a harmless one-time redundancy.
    buildParticles(null);

    // --- The animation loop -------------------------------------------------
    // This loop does TWO jobs every frame:
    //   1. Moves the particles (and reacts to bass energy from audioTimeRef/bassRef)
    //   2. Detects which lyric block is "active" right now
    const animate = () => {
      rafRef.current = requestAnimationFrame(animate);
      const t = performance.now() * 0.001;
      const bass = bassRef.current || 0;

      // --- particle motion ---
      const p = particlesRef.current;
      for (let i = 0; i < p.count; i++) {
        const ix = i * 3;
        const iy = i * 3 + 1;
        p.positions[iy] -= p.speeds[i] * (1 + bass * 1.6);          // fall, boosted by bass
        p.positions[ix] += Math.sin(t * 0.6 + p.phases[i]) * 0.01;  // gentle sideways drift
        if (p.positions[iy] < -6) {
          p.positions[iy] = 6 + Math.random() * 2;   // recycle to the top
          p.positions[ix] = (Math.random() - 0.5) * 16;
        }
      }
      if (p.mode === 'points') {
        p.object3D.geometry.attributes.position.needsUpdate = true;
        p.object3D.material.size = 0.13 + bass * 0.16;
      } else {
        // Instanced .glb shapes: no geometry attribute to touch — each
        // particle's transform is written straight into the instance matrix.
        const scale = particleSizeRef.current * (1 + bass * 0.5);
        for (let i = 0; i < p.count; i++) {
          p.dummy.position.set(p.positions[i * 3], p.positions[i * 3 + 1], p.positions[i * 3 + 2]);
          p.dummy.rotation.set(t * 0.3 + p.phases[i], t * 0.2 + p.phases[i] * 1.3, 0);
          p.dummy.scale.setScalar(scale);
          p.dummy.updateMatrix();
          p.object3D.setMatrixAt(i, p.dummy.matrix);
        }
        p.object3D.instanceMatrix.needsUpdate = true;
      }

      // --- active lyric, from the shared audio time ---
      const { currentTime = 0 } = audioTimeRef.current || {};
      const active = (placedBlocksRef.current || []).find(
        (b) => currentTime >= b.start && currentTime < b.start + b.duration
      );
      const activeId = active ? active.id : null;
      // Only touch React state when the active lyric actually changes —
      // cheap to check every frame, but only triggers a re-render on the
      // rare frame it matters.
      if (activeId !== activeBlockIdRef.current) {
        activeBlockIdRef.current = activeId;
        setActiveBlock(active || null);
      }

      renderer.render(scene, camera);
    };
    animate();

    const handleResize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', handleResize);

    // Cleanup: React calls this when the component unmounts. Three.js/WebGL
    // resources are NOT garbage-collected like normal JS objects — GPU
    // memory has to be released explicitly via .dispose().
    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener('resize', handleResize);
      const current = particlesRef.current;
      if (current) {
        current.object3D.geometry.dispose();
        current.object3D.material.dispose();
      }
      particleTextureRef.current?.dispose();
      particleTextureRef.current = null;
      // Remove the tracked shader attachment, then the overlay canvas itself
      // (captured above) since vfx-js gives us no destroy() to do it for us.
      applyTextEffect(null, null);
      vfxRef.current = null;
      vfxCanvasRef.current?.remove();
      vfxCanvasRef.current = null;
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) {
        mount.removeChild(renderer.domElement);
      }
      sceneRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // empty array = run once on mount, clean up once on unmount

  /* =======================================================================
     CUSTOM PARTICLE SHAPE — rebuilds whenever the uploaded .glb bytes change
     -----------------------------------------------------------------------
     GLTFLoader.parse() takes the raw ArrayBuffer directly. particleShapeBuffer
     is null for the default sprite points, or the raw bytes of an uploaded
     .glb — same bytes get broadcast to the pop-out tab so both views end up
     with an identical shape.
     ======================================================================= */
  useEffect(() => {
    if (!particleShapeBuffer) {
      shapeGeometryRef.current = null;
      buildParticles(null);
      return;
    }

    let cancelled = false;
    new GLTFLoader().parse(
      particleShapeBuffer,
      '',
      (gltf) => {
        if (cancelled) return;
        const geometry = extractParticleGeometry(gltf);
        if (!geometry) {
          onShapeError?.('No mesh found in that file.');
          return;
        }
        shapeGeometryRef.current = geometry;
        buildParticles(geometry);
      },
      () => {
        if (!cancelled) onShapeError?.('Could not parse that .glb file.');
      }
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [particleShapeBuffer]);

  // Re-tint particles when the palette changes in the settings menu — reuses
  // whatever shape is currently active (default points or an uploaded .glb)
  // rather than re-parsing anything.
  useEffect(() => {
    buildParticles(shapeGeometryRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [palette]);

  // Re-attach the shader when the effective effect/font changes (global
  // settings, the active block's own override, or a block font finishing
  // its load), but the lyric text itself doesn't change (so the div never
  // remounts, and the ref callback below never re-fires on its own).
  // Without effectiveFontFamily/effectiveFontFaceCss here, an effect
  // attached before the font is ready bakes the fallback typeface into its
  // shader texture permanently.
  useEffect(() => {
    applyTextEffect(activeLyricNodeRef.current, effectiveTextEffect);
  }, [effectiveTextEffect, effectiveFontFamily, effectiveFontFaceCss]);

  return (
    <div
      className={`relative ${heightClassName} rounded-2xl overflow-hidden`}
      style={{ backgroundImage: `radial-gradient(circle at 50% 30%, ${stageColors.inner}, ${stageColors.outer})` }}
    >
      <div ref={mountRef} className="absolute inset-0" />
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none px-10">
        {/*
          key={activeBlock?.id} means this wrapper fully remounts whenever the
          active lyric block changes, restarting the fade-in animation and
          re-firing the inner ref callback (null then node) so applyTextEffect
          re-attaches, same remove-before-add sequence as buildParticles()
          above.

          The animation lives on this wrapper, not the vfx-js target below:
          fadeInUp's `forwards` fill-mode permanently pins opacity:1 on
          whatever element carries it, which would fight vfx-js's own
          opacity:0 (used to hide the source node once its shader canvas is
          ready) and leave the original text visible underneath the effect.
        */}
        <div key={activeBlock?.id ?? 'none'} className={`opacity-0 ${activeBlock ? 'animate-fade-in-up' : ''}`}>
          <div
            ref={(node) => {
              activeLyricNodeRef.current = node;
              applyTextEffect(node, effectiveTextEffectRef.current);
            }}
            className="font-display font-semibold text-center [text-shadow:0_4px_24px_rgba(0,0,0,0.6)]"
            style={{
              color: effectiveTextColor,
              fontSize: `clamp(${Math.round(textSize / 2)}px, 4vw, ${textSize}px)`,
              ...(effectiveFontFamily ? { fontFamily: effectiveFontFamily } : null),
            }}
          >
            {/*
              vfx-js snapshots this node into an isolated SVG image with no
              access to document.fonts — embedding the font here too lets
              that snapshot resolve the active font family as well.
            */}
            {effectiveFontFamily && effectiveFontFaceCss && <style>{effectiveFontFaceCss}</style>}
            {activeBlock?.text ?? ''}
          </div>
        </div>
      </div>
    </div>
  );
}
