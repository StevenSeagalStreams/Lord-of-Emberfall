import * as THREE from 'three';
import * as TextureGen from '../render/TextureGen.js';

/**
 * Procedural PBR texture sets for character materials, built from TextureGen
 * primitives (owned by the rendering pass, read-only here). Every call is
 * wrapped defensively: TextureGen is someone else's file and may grow or
 * change shape under us, so a missing/renamed export degrades to a flat
 * material instead of throwing at load time.
 */

const cache = new Map();

function has(name) { return typeof TextureGen[name] === 'function'; }

function safeNoise(seed) {
  if (has('makeValueNoise')) {
    try { return TextureGen.makeValueNoise(seed); } catch { /* fall through */ }
  }
  return () => 0.5;
}

function safeFbm(noise, x, y, opts) {
  if (has('fbm')) {
    try { return TextureGen.fbm(noise, x, y, opts); } catch { /* fall through */ }
  }
  return 0.5;
}

function safeWorley(x, y, period, seed) {
  if (has('worley')) {
    try { return TextureGen.worley(x, y, period, seed); } catch { /* fall through */ }
  }
  return { f1: 0.5, f2: 0.5, id: 0 };
}

function safeHeight(size, fn) {
  if (has('generateHeight')) {
    try { return TextureGen.generateHeight(size, fn); } catch { /* fall through */ }
  }
  return null;
}

function safeImage(size, fn) {
  if (has('generateImage')) {
    try { return TextureGen.generateImage(size, fn); } catch { /* fall through */ }
  }
  return null;
}

function safeNormal(height, size, strength) {
  if (height && has('heightToNormal')) {
    try { return TextureGen.heightToNormal(height, size, strength); } catch { /* fall through */ }
  }
  return null;
}

function safeAO(height, size, radius, strength) {
  if (height && has('heightToAO')) {
    try { return TextureGen.heightToAO(height, size, radius, strength); } catch { /* fall through */ }
  }
  return null;
}

function safeCavity(height, size, radius, strength) {
  if (height && has('heightToCavity')) {
    try { return TextureGen.heightToCavity(height, size, radius, strength); } catch { /* fall through */ }
  }
  return null;
}

function safeTexture(canvas, opts) {
  if (canvas && has('toTexture')) {
    try { return TextureGen.toTexture(canvas, opts); } catch { /* fall through */ }
  }
  return null;
}

/**
 * Brushed steel with scratch wear, dents, and darker recesses.
 *
 * "Edge wear" is a cavity-driven effect: `heightToCavity` finds pits relative
 * to the local neighbourhood, which is exactly where oxide/grime collects and,
 * by inverse, exactly where the *raised* brushed ridges get polished bright by
 * handling and combat. Albedo brightens and roughness drops on the raised
 * strokes; both darken/roughen in the cavities. That contrast is what reads as
 * "worn plate" instead of a uniform grey metal swatch.
 */
function buildMetalMaps(seed, size = 256) {
  const noise = safeNoise(seed);
  const height = safeHeight(size, (u, v) => {
    const brushed = Math.sin(u * 90 + safeFbm(noise, u * 3, v * 3, { octaves: 3, basePeriod: 6 }) * 4) * 0.02;
    const scratches = Math.pow(safeFbm(noise, u * 5 + 3, v * 5 + 1, { octaves: 4, basePeriod: 10 }), 6) * 0.6;
    const dents = Math.pow(Math.max(0, 1 - safeWorley(u, v, 5, 41).f1 * 1.4), 3) * -0.35;
    return brushed + scratches + dents;
  });
  const normal = safeNormal(height, size, 1.4);
  const ao = safeAO(height, size, 4, 0.6);
  const cavity = safeCavity(height, size, 3, 1.3);
  const albedo = safeImage(size, (u, v, x, y) => {
    const h = height ? height[y * size + x] : 0;
    const cav = cavity ? cavity[y * size + x] : 0;
    const edgeWear = Math.max(0, h) * 0.55;   // raised brush strokes catch a bright polish
    const grime = cav * 0.30;                 // recesses collect soot and oxide
    const base = 0.60 + edgeWear - grime;
    return [base, base * 0.99, base * 0.94 - grime * 0.05];
  });
  const rough = safeImage(size, (u, v, x, y) => {
    const h = height ? height[y * size + x] : 0;
    const cav = cavity ? cavity[y * size + x] : 0;
    // Worn highlights are polished (low roughness); pits and grime are matte.
    const r = THREE.MathUtils.clamp(0.28 - h * 0.24 + cav * 0.38, 0.05, 0.75);
    return [r, r, r];
  });
  return {
    map: safeTexture(albedo, { srgb: true, repeat: 1 }),
    normalMap: safeTexture(normal, { repeat: 1 }),
    roughnessMap: safeTexture(rough, { repeat: 1 }),
    aoMap: safeTexture(ao, { repeat: 1 }),
  };
}

/** Woven cloth: matte, low-frequency thread bumps, no sheen. */
function buildClothMaps(seed, size = 256) {
  const noise = safeNoise(seed);
  const height = safeHeight(size, (u, v) => {
    const weaveX = Math.sin(u * 140) * 0.15;
    const weaveY = Math.sin(v * 140 + Math.PI / 2) * 0.15;
    const grime = safeFbm(noise, u * 2 + 7, v * 2 + 3, { octaves: 4, basePeriod: 8 }) * 0.4;
    return weaveX * weaveY * 0.5 + grime;
  });
  const normal = safeNormal(height, size, 0.9);
  const ao = safeAO(height, size, 3, 0.5);
  const albedo = safeImage(size, (u, v, x, y) => {
    const grime = safeFbm(noise, u * 1.4 + 11, v * 1.4 + 5, { octaves: 4, basePeriod: 6 });
    const base = 0.5 - grime * 0.18;
    return [base, base, base];
  });
  const rough = safeImage(size, () => [0.92, 0.92, 0.92]);
  return {
    map: safeTexture(albedo, { srgb: true, repeat: 1 }),
    normalMap: safeTexture(normal, { repeat: 1 }),
    roughnessMap: safeTexture(rough, { repeat: 1 }),
    aoMap: safeTexture(ao, { repeat: 1 }),
  };
}

/** Bone: mottled porosity, faint sheen at the ridges. */
function buildBoneMaps(seed, size = 192) {
  const noise = safeNoise(seed);
  const height = safeHeight(size, (u, v) => {
    const porous = Math.pow(safeWorley(u, v, 14, 71).f1, 2) * 0.5;
    const crack = Math.pow(safeFbm(noise, u * 4, v * 4, { octaves: 4, basePeriod: 12 }), 5) * 0.6;
    return porous - crack;
  });
  const normal = safeNormal(height, size, 1.1);
  const ao = safeAO(height, size, 3, 0.7);
  const albedo = safeImage(size, (u, v, x, y) => {
    const stain = safeFbm(noise, u * 1.8 + 2, v * 1.8 + 9, { octaves: 4, basePeriod: 10 });
    const base = 0.72 - stain * 0.14;
    return [base, base * 0.96, base * 0.86];
  });
  // A faint waxy sheen on the smoother ridges, roughened in the porous pits --
  // enough variance to read as "subtle sheen", never mirror-bright like metal.
  const rough = safeImage(size, (u, v, x, y) => {
    const h = height ? height[y * size + x] : 0;
    const r = THREE.MathUtils.clamp(0.58 - h * 0.22, 0.4, 0.85);
    return [r, r, r];
  });
  return {
    map: safeTexture(albedo, { srgb: true, repeat: 1 }),
    normalMap: safeTexture(normal, { repeat: 1 }),
    roughnessMap: safeTexture(rough, { repeat: 1 }),
    aoMap: safeTexture(ao, { repeat: 1 }),
  };
}

/** Tanned leather: grain, pores, and creases -- straps, belts, gambesons. */
function buildLeatherMaps(seed, size = 256) {
  const noise = safeNoise(seed);
  const height = safeHeight(size, (u, v) => {
    const grain = safeFbm(noise, u * 10 + 1, v * 10 + 4, { octaves: 4, basePeriod: 14 }) * 0.35;
    const pores = Math.pow(safeWorley(u, v, 22, 53).f1, 3) * 0.4;
    const creases = Math.pow(safeFbm(noise, u * 3 + 9, v * 3 + 2, { octaves: 3, basePeriod: 5 }), 4) * 0.5;
    return grain - pores - creases;
  });
  const normal = safeNormal(height, size, 1.0);
  const ao = safeAO(height, size, 3, 0.55);
  const albedo = safeImage(size, (u, v, x, y) => {
    const h = height ? height[y * size + x] : 0;
    const base = 0.55 + h * 0.30;
    return [base, base * 0.80, base * 0.58];
  });
  const rough = safeImage(size, (u, v, x, y) => {
    const h = height ? height[y * size + x] : 0;
    return [THREE.MathUtils.clamp(0.68 - h * 0.14, 0.45, 0.85)];
  });
  return {
    map: safeTexture(albedo, { srgb: true, repeat: 1 }),
    normalMap: safeTexture(normal, { repeat: 1 }),
    roughnessMap: safeTexture(rough, { repeat: 1 }),
    aoMap: safeTexture(ao, { repeat: 1 }),
  };
}

/** Skin: very low-amplitude pore/blemish variation -- must stay subtle. */
function buildSkinMaps(seed, size = 192) {
  const noise = safeNoise(seed);
  const height = safeHeight(size, (u, v) => {
    const pores = Math.pow(safeWorley(u, v, 34, 17).f1, 4) * -0.20;
    const soft = (safeFbm(noise, u * 2 + 5, v * 2 + 8, { octaves: 3, basePeriod: 4 }) - 0.5) * 0.16;
    return pores + soft;
  });
  const normal = safeNormal(height, size, 0.45);
  const ao = safeAO(height, size, 2, 0.28);
  const albedo = safeImage(size, (u, v, x, y) => {
    const h = height ? height[y * size + x] : 0;
    const flush = safeFbm(noise, u * 1.5 + 3, v * 1.5 + 6, { octaves: 3, basePeriod: 3 });
    const base = 0.82 + h * 0.5;
    return [base, base * 0.86 + flush * 0.05, base * 0.78];
  });
  return {
    map: safeTexture(albedo, { srgb: true, repeat: 1 }),
    normalMap: safeTexture(normal, { repeat: 1 }),
    aoMap: safeTexture(ao, { repeat: 1 }),
  };
}

/** Dyed cloth/leather trim for accent bands, tabard fields, cloak lining. */
function buildAccentMaps(seed, size = 192) {
  const noise = safeNoise(seed);
  const height = safeHeight(size, (u, v) => {
    const weave = Math.sin(u * 100) * Math.sin(v * 100) * 0.10;
    const wear = safeFbm(noise, u * 3 + 2, v * 3 + 7, { octaves: 4, basePeriod: 6 }) * 0.30;
    return weave + wear;
  });
  const normal = safeNormal(height, size, 0.85);
  const ao = safeAO(height, size, 3, 0.5);
  const albedo = safeImage(size, (u, v, x, y) => {
    const h = height ? height[y * size + x] : 0;
    const base = 0.60 + h * 0.32;
    return [base, base * 0.92, base * 0.86];
  });
  const rough = safeImage(size, () => [0.78, 0.78, 0.78]);
  return {
    map: safeTexture(albedo, { srgb: true, repeat: 1 }),
    normalMap: safeTexture(normal, { repeat: 1 }),
    roughnessMap: safeTexture(rough, { repeat: 1 }),
    aoMap: safeTexture(ao, { repeat: 1 }),
  };
}

function cached(key, build) {
  if (cache.has(key)) return cache.get(key);
  let maps;
  try { maps = build(); } catch { maps = {}; }
  cache.set(key, maps);
  return maps;
}

export function metalMaps(seed = 1) { return cached(`metal:${seed}`, () => buildMetalMaps(seed)); }
export function clothMaps(seed = 1) { return cached(`cloth:${seed}`, () => buildClothMaps(seed)); }
export function boneMaps(seed = 1) { return cached(`bone:${seed}`, () => buildBoneMaps(seed)); }
export function leatherMaps(seed = 1) { return cached(`leather:${seed}`, () => buildLeatherMaps(seed)); }
export function skinMaps(seed = 1) { return cached(`skin:${seed}`, () => buildSkinMaps(seed)); }
export function accentMaps(seed = 1) { return cached(`accent:${seed}`, () => buildAccentMaps(seed)); }
