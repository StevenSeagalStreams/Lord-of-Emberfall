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

/** Quality presets. Critic screenshots always run at 'ultra'. */
export const QUALITY = {
  low:    { pixelRatio: 1,   shadowSize: 512,  ssao: false, bloom: true,  grain: false, softShadows: false, volumetrics: false },
  medium: { pixelRatio: 1,   shadowSize: 1024, ssao: true,  bloom: true,  grain: true,  softShadows: false, volumetrics: true },
  high:   { pixelRatio: 1.5, shadowSize: 2048, ssao: true,  bloom: true,  grain: true,  softShadows: true,  volumetrics: true },
  ultra:  { pixelRatio: 2,   shadowSize: 4096, ssao: true,  bloom: true,  grain: true,  softShadows: true,  volumetrics: true },
};

export function applyQuality(renderer, preset) {
  const q = QUALITY[preset] || QUALITY.high;
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
