import { useRef, useState, useEffect } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FLORAL_PALETTE, DEFAULT_STAGE_COLORS, DEFAULT_LYRIC_COLOR, DEFAULT_LYRIC_SIZE, DEFAULT_PARTICLE_SIZE } from './lib/palette.js';
import { loadCustomFont, CUSTOM_FONT_FAMILY } from './lib/font.js';

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
  particleShapeBuffer,
  onShapeError,
  fontBuffer,
  palette = FLORAL_PALETTE,
  stageColors = DEFAULT_STAGE_COLORS,
  textColor = DEFAULT_LYRIC_COLOR,
  textSize = DEFAULT_LYRIC_SIZE,
  particleSize = DEFAULT_PARTICLE_SIZE,
  heightClassName = DEFAULT_HEIGHT_CLASSES,
}) {
  const [activeLyric, setActiveLyric] = useState('');
  const activeLyricIdRef = useRef(null);
  // Loaded independently of LyricBloom.jsx's own font load — each renders
  // into its own `document`, and a pop-out tab (StagePopout.jsx) needs its
  // own FontFace registration regardless of what the editor tab already did.
  const [fontLoaded, setFontLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const applyFont = async () => {
      if (!fontBuffer) {
        if (!cancelled) setFontLoaded(false);
        return;
      }
      try {
        await loadCustomFont(fontBuffer);
        if (!cancelled) setFontLoaded(true);
      } catch {
        if (!cancelled) setFontLoaded(false);
      }
    };
    applyFont();
    return () => {
      cancelled = true;
    };
  }, [fontBuffer]);

  const mountRef = useRef(null);       // div the Three.js canvas mounts into
  const rafRef = useRef(null);         // requestAnimationFrame id, for cleanup
  const sceneRef = useRef(null);       // so buildParticles() can run outside the mount effect
  // { mode: 'points' | 'mesh', object3D, positions, speeds, phases, count, dummy? }
  const particlesRef = useRef(null);
  // Remembers the currently-active custom shape (or null for default sprite
  // points) so the palette-change effect below can rebuild particles without
  // needing to re-parse the .glb — it just re-reads whatever shape is live.
  const shapeGeometryRef = useRef(null);
  // The animate loop below is set up once on mount (empty dependency array),
  // so it reads particleSize through this ref instead of the prop directly —
  // same "live mirror" trick as bassRef/audioTimeRef.
  const particleSizeRef = useRef(particleSize);
  useEffect(() => {
    particleSizeRef.current = particleSize;
  }, [particleSize]);

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
      prev.object3D.geometry.dispose();
      prev.object3D.material.dispose();
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
        map: createParticleTexture(),
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
      if (activeId !== activeLyricIdRef.current) {
        activeLyricIdRef.current = activeId;
        setActiveLyric(active ? active.text : '');
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

  return (
    <div
      className={`relative ${heightClassName} rounded-2xl overflow-hidden`}
      style={{ backgroundImage: `radial-gradient(circle at 50% 30%, ${stageColors.inner}, ${stageColors.outer})` }}
    >
      <div ref={mountRef} className="absolute inset-0" />
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none px-10">
        <div
          key={activeLyric}
          className={`font-display font-semibold text-center [text-shadow:0_4px_24px_rgba(0,0,0,0.6)] opacity-0 ${activeLyric ? 'animate-fade-in-up' : ''}`}
          style={{
            color: textColor,
            fontSize: `clamp(${Math.round(textSize / 2)}px, 4vw, ${textSize}px)`,
            ...(fontLoaded ? { fontFamily: CUSTOM_FONT_FAMILY } : null),
          }}
        >
          {activeLyric}
        </div>
      </div>
    </div>
  );
}
