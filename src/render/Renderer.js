import * as THREE from 'three';

/**
 * WebGL renderer configuration.
 *
 * Art direction note: the entire look depends on rendering in linear space and
 * grading at the end of the chain. Tone mapping is deliberately left as
 * NoToneMapping here -- PostFX owns the filmic curve so that bloom and AO
 * operate on scene-referred HDR values rather than display-referred ones.
 */
export function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,        // we resolve AA in post (SMAA) to keep MRT-friendly
    stencil: false,
    depth: true,
    powerPreference: 'high-performance',
    alpha: false,
  });

  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setSize(innerWidth, innerHeight, false);

  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = 1.0;

  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = true;

  renderer.info.autoReset = false;
  renderer.setClearColor(0x000000, 1);

  return renderer;
}

/**
 * Quality presets.
 *
 * STABILIZE.md rule 0: the target machine is an Intel Iris-class integrated
 * GPU at 1080p, and the game must hold 60 FPS there. **`low` is the default**
 * and everything in it is chosen to be cheap, not pretty -- beauty is rank 7
 * on the standing priority order and it stays there.
 *
 * The costs that actually matter on integrated graphics are, roughly in
 * order: pixel count (pixelRatio), full-screen post passes, and shadow map
 * resolution. So `low` pays for none of the post stack and renders at exactly
 * one device pixel per CSS pixel.
 *
 * `ultra` exists only for offline critic captures on this dev box. It is not
 * reachable from the settings menu and no player should ever run it.
 */
export const QUALITY = {
  low: {
    pixelRatio: 1, shadowSize: 512, ssao: false, bloom: false, grain: false,
    vignette: false, smaa: false, softShadows: false, volumetrics: false,
    shadowBudget: 0, maxParticles: 240,
  },
  medium: {
    pixelRatio: 1, shadowSize: 1024, ssao: false, bloom: true, grain: false,
    vignette: true, smaa: false, softShadows: false, volumetrics: false,
    shadowBudget: 0, maxParticles: 600,
  },
  high: {
    pixelRatio: 1, shadowSize: 1024, ssao: true, bloom: true, grain: true,
    vignette: true, smaa: true, softShadows: true, volumetrics: true,
    shadowBudget: 1, maxParticles: 1200,
  },
  // Capture-only. Deliberately excluded from the settings menu.
  ultra: {
    pixelRatio: 2, shadowSize: 2048, ssao: true, bloom: true, grain: true,
    vignette: true, smaa: true, softShadows: true, volumetrics: true,
    shadowBudget: 2, maxParticles: 2400,
  },
};

/** Presets a player may actually pick, cheapest first. */
export const PLAYER_PRESETS = ['low', 'medium', 'high'];

export function applyQuality(renderer, preset) {
  const q = QUALITY[preset] || QUALITY.low;
  // Hard cap at 1 for every player-facing preset: on an integrated GPU a
  // devicePixelRatio of 2 means rendering 4x the pixels, which is the single
  // most expensive thing this renderer can do and the first thing to go.
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, q.pixelRatio));
  renderer.shadowMap.type = q.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
  return q;
}

export function handleResize(renderer, camera, composer) {
  const w = innerWidth;
  const h = innerHeight;
  renderer.setSize(w, h, false);
  if (camera) {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  if (composer) composer.setSize(w, h);
}
