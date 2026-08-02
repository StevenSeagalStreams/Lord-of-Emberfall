import * as THREE from 'three';
import {
  makeValueNoise, fbm, ridgedFbm, domainWarp, worley, smoothstep,
  generateHeight, generateImage, heightToNormal, toTexture,
} from '../render/TextureGen.js';

/**
 * Procedural heightfield + splat-blended terrain mesh + matching collision
 * grid for the Blighted Forest.
 *
 * One baked grid of fields (height, slope, hollow-ness, path proximity, edge
 * proximity) is the single source of truth consumed by four things that must
 * never disagree with each other: the render mesh, the multi-layer material
 * blend, the collision/nav grid, and foliage placement density. Deriving any
 * of those independently is how you get trees floating over cliffs or a path
 * texture painted across a cell the player cannot actually stand on.
 */

const EPS = 1e-4;

/** A worn trail: an authored spline (with per-seed jitter) rather than pure
 * noise, so the eye has something continuous to follow through the ridges and
 * hollows -- exactly the "path threading through the middle" brief. */
function buildPathPolyline(rng, worldSize) {
  const P = (u, v) => new THREE.Vector3(u * worldSize, 0, v * worldSize);
  const jx = () => rng.range(-0.025, 0.025);
  const jz = () => rng.range(-0.02, 0.02);

  const entry = P(0.50 + jx(), 0.12);
  const hollowPt = P(0.40 + jx(), 0.32 + jz());
  const saddle = P(0.57 + jx(), 0.48 + jz());
  const fork = P(0.50 + jx(), 0.62);
  const shrineMid = P(0.63 + jx(), 0.72 + jz());
  const shrine = P(0.74 + jx(), 0.81);
  const deadEndMid = P(0.35 + jx(), 0.70 + jz());
  const deadEnd = P(0.23 + jx(), 0.76);

  const trunk = new THREE.CatmullRomCurve3([entry, hollowPt, saddle, fork], false, 'catmullrom', 0.35);
  const branchShrine = new THREE.CatmullRomCurve3([fork, shrineMid, shrine], false, 'catmullrom', 0.35);
  const branchDead = new THREE.CatmullRomCurve3([fork, deadEndMid, deadEnd], false, 'catmullrom', 0.35);

  const samples = [
    ...trunk.getPoints(160),
    ...branchShrine.getPoints(110),
    ...branchDead.getPoints(90),
  ];

  return { samples, entry, fork, shrine, deadEnd, hollowPt, saddle };
}

function distToPath(wx, wz, path) {
  let best = Infinity;
  const s = path.samples;
  for (let i = 0; i < s.length; i++) {
    const dx = wx - s[i].x, dz = wz - s[i].z;
    const d2 = dx * dx + dz * dz;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

/**
 * Bake the full field grid once. `size` is the number of collision-grid
 * cells per side (must match the world's TILE spacing so NavGrid's world<->
 * cell math stays valid); the mesh uses the same (size+1) vertex lattice.
 */
export function bakeTerrainFields(rng, { size, tile }) {
  const worldSize = size * tile;
  const N = size + 1;

  const noiseBase = makeValueNoise(rng.int32());
  const noiseRidge = makeValueNoise(rng.int32());
  const noiseWarp = makeValueNoise(rng.int32());
  const noiseDetail = makeValueNoise(rng.int32());

  const path = buildPathPolyline(rng.fork ? rng.fork('path') : rng, worldSize);
  const pathWidth = 3.6;

  const height = new Float32Array(N * N);
  const hollow = new Float32Array(N * N);
  const pathW = new Float32Array(N * N);
  const edge = new Float32Array(N * N);

  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const u = i / size, v = j / size;
      const wx = u * worldSize, wz = v * worldSize;
      const idx = j * N + i;

      const [wu, wv] = domainWarp(noiseWarp, u * 3.0 + 4, v * 3.0 + 1, { amp: 0.4, octaves: 3, basePeriod: 3 });
      const base = fbm(noiseBase, wu + 2, wv + 6, { octaves: 5, basePeriod: 3 });
      const detail = fbm(noiseDetail, u * 9 + 3, v * 9 + 8, { octaves: 3, basePeriod: 18 }) - 0.5;

      const { f1: ridgeCell } = worley(u * 4.2 + 2, v * 4.2 + 7, 5, 771);
      const ridgeGate = smoothstep(ridgeCell, 0.5, 0.16);
      const ridge = ridgedFbm(noiseRidge, u * 6 + 1, v * 6 + 4, { octaves: 4, basePeriod: 4, sharpness: 1.8 });

      const { f1: hollowCell } = worley(u * 3.1 + 5, v * 3.1 + 9, 4, 313);
      const hollowMask = Math.max(0, 1 - hollowCell * 1.55);

      // Boundary rise starts well outside where the authored path/landmarks
      // ever go (they stay within ~30m of centre) and is fully a cliff/hill
      // by ~83m from centre, leaving a wide sealed rim inside the 96m half-
      // extent -- this is what makes the zone edge unreachable rather than
      // merely undecorated.
      const cheb = Math.max(Math.abs(u - 0.5), Math.abs(v - 0.5)) * 2;
      const edgeMask = smoothstep(cheb, 0.62, 0.86);

      let h = base * 4.6 + ridge * 3.1 * ridgeGate - hollowMask * 2.7
        + edgeMask * edgeMask * 13.0 + detail * 0.35;

      const pw = 1 - smoothstep(distToPath(wx, wz, path), pathWidth * 0.32, pathWidth);
      const smoothBase = base * 4.6 - 0.32;
      h = THREE.MathUtils.lerp(h, smoothBase, pw);

      height[idx] = h;
      hollow[idx] = hollowMask;
      pathW[idx] = pw;
      edge[idx] = edgeMask;
    }
  }

  return { size, tile, worldSize, N, height, hollow, pathW, edge, path };
}

/** Bilinear sample of a baked (size+1)^2 field at continuous world coords. */
function sampleField(field, fields, wx, wz) {
  const { size, worldSize, N } = fields;
  const fx = THREE.MathUtils.clamp((wx / worldSize) * size, 0, size - EPS);
  const fz = THREE.MathUtils.clamp((wz / worldSize) * size, 0, size - EPS);
  const i0 = Math.floor(fx), j0 = Math.floor(fz);
  const tx = fx - i0, tz = fz - j0;
  const a = field[j0 * N + i0], b = field[j0 * N + i0 + 1];
  const c = field[(j0 + 1) * N + i0], d = field[(j0 + 1) * N + i0 + 1];
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

/**
 * Everything downstream (mesh, materials, colliders, foliage) reads through
 * this one object so nothing can disagree with the baked fields.
 */
export class Terrain {
  constructor(rng, { size = 96, tile = 2.0 } = {}) {
    this.rng = rng;
    this.size = size;
    this.tile = tile;
    this.fields = bakeTerrainFields(rng, { size, tile });
    this.worldSize = this.fields.worldSize;
    this.path = this.fields.path;

    // Derived per-vertex slope, filled in once the mesh geometry (and its
    // computed normals) exist -- see _computeSlope().
    this._slope = null;
  }

  heightAt(wx, wz) { return sampleField(this.fields.height, this.fields, wx, wz); }
  hollowAt(wx, wz) { return sampleField(this.fields.hollow, this.fields, wx, wz); }
  pathAt(wx, wz) { return sampleField(this.fields.pathW, this.fields, wx, wz); }
  edgeAt(wx, wz) { return sampleField(this.fields.edge, this.fields, wx, wz); }
  slopeAt(wx, wz) {
    if (!this._slope) return 0;
    return sampleField(this._slope, this.fields, wx, wz);
  }

  waterAt(wx, wz) {
    const h = this.heightAt(wx, wz);
    const hol = this.hollowAt(wx, wz);
    return hol > 0.6 && h < -0.65 ? THREE.MathUtils.clamp((hol - 0.6) * 2.4, 0, 1) : 0;
  }

  /** Builds the render mesh (base opaque grass pass + 3 alpha-blended splat
   * passes) and fills in the slope field the collider/foliage passes need. */
  buildMesh(materials) {
    this.materials = materials;
    const { N, size, worldSize, height } = this.fields;
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(N * N * 3);
    const uvs = new Float32Array(N * N * 2);

    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const idx = j * N + i;
        const wx = (i / size) * worldSize, wz = (j / size) * worldSize;
        positions[idx * 3] = wx;
        positions[idx * 3 + 1] = height[idx];
        positions[idx * 3 + 2] = wz;
        uvs[idx * 2] = i / size;
        uvs[idx * 2 + 1] = j / size;
      }
    }

    const indices = new (N * N > 65536 ? Uint32Array : Uint16Array)(size * size * 6);
    let p = 0;
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const a = j * N + i, b = j * N + i + 1, c = (j + 1) * N + i, d = (j + 1) * N + i + 1;
        indices[p++] = a; indices[p++] = c; indices[p++] = b;
        indices[p++] = b; indices[p++] = c; indices[p++] = d;
      }
    }

    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.computeVertexNormals();

    const normalAttr = geo.attributes.normal;
    const slope = new Float32Array(N * N);
    const rockW = new Float32Array(N * N);
    const mudW = new Float32Array(N * N);
    const pathWFinal = new Float32Array(N * N);

    for (let k = 0; k < N * N; k++) {
      const ny = THREE.MathUtils.clamp(normalAttr.getY(k), 0, 1);
      const s = 1 - ny;
      slope[k] = s;
      // Loosened from (0.11, 0.30): that let bare rock take over any
      // moderately sloped ground, which is most of a heightmapped forest --
      // exactly the "cracked desert hardpan" read the critic called out.
      // Real forest floor stays grass/dirt-covered until a slope is
      // genuinely steep; only that should go bare.
      const rw = smoothstep(s, 0.26, 0.52);
      rockW[k] = rw;
      const lowness = smoothstep(height[k], 2.2, -1.4);
      let mw = Math.min(1, this.fields.hollow[k] * 1.3) * lowness * (1 - rw * 0.7);
      mw *= 1 - this.fields.pathW[k] * 0.85;
      mudW[k] = mw;
      pathWFinal[k] = this.fields.pathW[k] * (1 - rw);
    }

    geo.setAttribute('aRock', new THREE.BufferAttribute(rockW, 1));
    geo.setAttribute('aMud', new THREE.BufferAttribute(mudW, 1));
    geo.setAttribute('aPath', new THREE.BufferAttribute(pathWFinal, 1));

    this._slope = slope;

    const group = new THREE.Group();
    group.name = 'Terrain';

    const pick = (...names) => {
      for (const n of names) if (materials?.[n]) return materials[n];
      return materials?.floor || new THREE.MeshStandardMaterial({ color: 0x2c3326, roughness: 1 });
    };

    // Synthesized directly (not `pick()`ed from the material library, which
    // has no grass/mud recipe and was silently falling back to roughRock's
    // cracked-cavity relief -- a tinted rock texture still reads as rock).
    // See buildDeadGrassMaterial/buildDampSoilMaterial above.
    const grassSeed = this.rng.int32 ? this.rng.int32() : 0xa17c3;
    const grassBase = buildDeadGrassMaterial(grassSeed, 256);
    grassBase.envMapIntensity = 0.32;
    applyWorldSpaceUV(grassBase, 0.13);
    grassBase.transparent = false;
    grassBase.depthWrite = true;

    const mudMat = buildDampSoilMaterial(grassSeed ^ 0x5bd1e995, 256);
    mudMat.envMapIntensity = 0.32;
    applyWorldSpaceUV(mudMat, 0.1);
    applyWeightAlpha(mudMat, 'aMud', 1);

    const pathMat = pick('dirt', 'path', 'floor').clone();
    tuneLayer(pathMat, { tint: 0x776449, roughBoost: 0.02 });
    applyWorldSpaceUV(pathMat, 0.16);
    applyWeightAlpha(pathMat, 'aPath', 2);

    const rockMat = pick('rock', 'roughRock', 'floor').clone();
    tuneLayer(rockMat, { tint: 0x7c868a, roughBoost: 0.08 });
    applyWorldSpaceUV(rockMat, 0.14);
    applyWeightAlpha(rockMat, 'aRock', 3);

    const meshBase = new THREE.Mesh(geo, grassBase);
    meshBase.name = 'TerrainGrass';
    meshBase.receiveShadow = true;
    meshBase.castShadow = true;

    const meshMud = new THREE.Mesh(geo, mudMat);
    meshMud.name = 'TerrainMud'; meshMud.receiveShadow = true; meshMud.renderOrder = 1;
    const meshPath = new THREE.Mesh(geo, pathMat);
    meshPath.name = 'TerrainPath'; meshPath.receiveShadow = true; meshPath.renderOrder = 2;
    const meshRock = new THREE.Mesh(geo, rockMat);
    meshRock.name = 'TerrainRock'; meshRock.receiveShadow = true; meshRock.renderOrder = 3;

    group.add(meshBase, meshMud, meshPath, meshRock);
    this.geometry = geo;
    this.drawCalls = 4;
    return group;
  }

  /** Zone-registry-shaped collision grid + NavGrid-compatible interface. */
  buildColliders() {
    const { size, tile } = this;
    const solid = new Uint8Array(size * size);
    const RING = 3;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const wx = x * tile, wz = y * tile;
        const inRing = x < RING || y < RING || x >= size - RING || y >= size - RING;
        let blocked = inRing;
        if (!inRing) {
          if (this.slopeAt(wx, wz) > 0.30) blocked = true;
          if (this.waterAt(wx, wz) > 0.5) blocked = true;
          // The authored trail is always walkable end-to-end regardless of
          // what the noise-driven slope/water test says underneath it --
          // without this a single unlucky gradient spike could sever the
          // one route the whole composition (spawn -> fork -> landmarks)
          // depends on.
          if (this.pathAt(wx, wz) > 0.55) blocked = false;
        }
        solid[y * size + x] = blocked ? 1 : 0;
      }
    }

    const colliders = {
      width: size,
      height: size,
      solid,
      isSolidCell: (x, y) => x < 0 || y < 0 || x >= size || y >= size || solid[y * size + x] === 1,
      isBlocked(wx, wz, radius = 0.45) {
        const minX = Math.round((wx - radius) / tile);
        const maxX = Math.round((wx + radius) / tile);
        const minY = Math.round((wz - radius) / tile);
        const maxY = Math.round((wz + radius) / tile);
        for (let y = minY; y <= maxY; y++) {
          for (let x = minX; x <= maxX; x++) {
            if (this.isSolidCell(x, y)) {
              const cx = x * tile, cy = y * tile;
              const nx = Math.max(cx - tile / 2, Math.min(wx, cx + tile / 2));
              const ny = Math.max(cy - tile / 2, Math.min(wz, cy + tile / 2));
              const dx = wx - nx, dy = wz - ny;
              if (dx * dx + dy * dy < radius * radius) return true;
            }
          }
        }
        return false;
      },
    };
    this.colliders = colliders;
    return colliders;
  }

  /** Mark a world-space circular footprint solid (large trunks, standing
   * stones) without disconnecting the path -- used sparingly, callers should
   * keep radius small since this mutates the shared collision grid. */
  markSolidDisc(wx, wz, radius) {
    if (!this.colliders) return;
    const { tile } = this;
    const { size, solid } = this.colliders;
    const minX = Math.floor((wx - radius) / tile), maxX = Math.ceil((wx + radius) / tile);
    const minY = Math.floor((wz - radius) / tile), maxY = Math.ceil((wz + radius) / tile);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const cx = x * tile, cy = y * tile;
        if (Math.hypot(cx - wx, cy - wz) <= radius) solid[y * size + x] = 1;
      }
    }
  }
}

/**
 * Ground base layer, synthesized directly from TextureGen's noise/height
 * pipeline rather than picked from the material library. The library has no
 * `deadGrass`/`grass` recipe, so `pick('deadGrass', 'grass', 'roughRock',
 * 'floor')` was silently resolving to `roughRock` -- a cracked-cavity rock
 * height field -- for the layer that covers most of the frame. Tinting that
 * green doesn't change what it *is*: a cracked-stone relief pattern, which is
 * exactly what read as "canyon / dry wash / desert hardpan" instead of forest
 * floor. This builds a patchy dead-grass-over-dirt relief (worley tufts +
 * fbm clumping, no crack network) so the base layer's *geometry*, not just
 * its color, says grass rather than rock.
 */
function buildDeadGrassMaterial(seed, size = 256) {
  const noiseA = makeValueNoise(seed >>> 0);
  const noiseB = makeValueNoise((seed ^ 0x2545f491) >>> 0);
  // No worley here at all -- any cell-noise component, however low the
  // weight, tiles as a visible hex/crack grid once world-space UVs repeat
  // it across a large ground plane (exactly the "cracked hardpan" read).
  // Grass/dirt relief comes from two octaves of plain fbm at different
  // scales instead: organic, non-cellular, no repeating network structure.
  const height = generateHeight(size, (u, v) => {
    const clump = fbm(noiseA, u * 5 + 2, v * 5 + 7, { octaves: 4, basePeriod: 5 });
    const fine = fbm(noiseB, u * 13 + 9, v * 13 + 2, { octaves: 3, basePeriod: 13 }) - 0.5;
    return clump * 0.8 + fine * 0.2;
  });
  const albedo = generateImage(size, (u, v, x, y) => {
    const h = height[y * size + x];
    const patchy = fbm(noiseB, u * 4 + 20, v * 4 + 8, { octaves: 3, basePeriod: 4 });
    const t = THREE.MathUtils.clamp(h + 0.5, 0, 1);
    // Dead straw over damp dirt, with sparse dull-green survivor tufts in
    // the raised clumps -- never a uniform lawn, never bare rock.
    let r = THREE.MathUtils.lerp(0.20, 0.42, t);
    let g = THREE.MathUtils.lerp(0.18, 0.38, t);
    let b = THREE.MathUtils.lerp(0.13, 0.24, t);
    const greenAmt = smoothstep(patchy, 0.5, 0.78) * 0.68;
    r = THREE.MathUtils.lerp(r, 0.27, greenAmt);
    g = THREE.MathUtils.lerp(g, 0.32, greenAmt);
    b = THREE.MathUtils.lerp(b, 0.18, greenAmt);
    const speck = fbm(noiseA, u * 40 + 3, v * 40 + 9, { octaves: 2, basePeriod: 40 });
    const litter = smoothstep(speck, 0.72, 0.85) * 0.18; // dark leaf-litter flecks
    const shade = (0.82 + h * 0.32) * (1 - litter);
    return [r * shade, g * shade, b * shade, 1];
  });
  // Softer relief than the rock layers (0.85 vs ~2+): grass/dirt has low
  // bump, not carved cavities -- another lever that was making this layer
  // read as stone regardless of color.
  const normalCanvas = heightToNormal(height, size, 0.85);
  return new THREE.MeshStandardMaterial({
    map: toTexture(albedo, { srgb: true, repeat: 1 }),
    normalMap: toTexture(normalCanvas, { srgb: false, repeat: 1 }),
    roughness: 0.96,
    metalness: 0,
  });
}

/** Damp-soil replacement for the mud layer -- soft clod relief rather than
 * the rock library's cavity network, matching the critic's "needs ... damp
 * soil" note. */
function buildDampSoilMaterial(seed, size = 256) {
  const noiseA = makeValueNoise(seed >>> 0);
  const height = generateHeight(size, (u, v) => {
    const base = fbm(noiseA, u * 4 + 11, v * 4 + 3, { octaves: 4, basePeriod: 4 });
    const { f1 } = worley(u * 6 + 1, v * 6 + 9, 5, 913);
    const clod = 1 - Math.min(1, f1 * 1.4);
    return base * 0.6 + clod * 0.4;
  });
  const albedo = generateImage(size, (u, v, x, y) => {
    const h = height[y * size + x];
    const t = THREE.MathUtils.clamp(h + 0.5, 0, 1);
    const r = THREE.MathUtils.lerp(0.10, 0.20, t);
    const g = THREE.MathUtils.lerp(0.09, 0.17, t);
    const b = THREE.MathUtils.lerp(0.07, 0.13, t);
    const shade = 0.85 + h * 0.3;
    return [r * shade, g * shade, b * shade, 1];
  });
  const normalCanvas = heightToNormal(height, size, 1.6);
  return new THREE.MeshStandardMaterial({
    map: toTexture(albedo, { srgb: true, repeat: 1 }),
    normalMap: toTexture(normalCanvas, { srgb: false, repeat: 1 }),
    roughness: 0.7,
    metalness: 0,
  });
}

function tuneLayer(mat, { tint, roughBoost = 0 }) {
  mat.color = new THREE.Color(tint);
  mat.roughness = THREE.MathUtils.clamp((mat.roughness ?? 1) + roughBoost, 0.15, 1.0);
  mat.envMapIntensity = 0.32;
  mat.needsUpdate = true;
}

/**
 * Re-maps a material's map/normalMap/roughnessMap/aoMap UVs to world-space XZ
 * (scaled) instead of the terrain mesh's own [0,1]-across-the-whole-plane UV,
 * so a single ground mesh spanning ~190m still reads as a tiled surface
 * rather than one giant smeared texture. Composes with any tiling-breaker
 * patch already on the material (harmless no-op there since terrain isn't
 * instanced) by chaining onto the existing onBeforeCompile.
 */
function applyWorldSpaceUV(material, scale) {
  const prevCompile = material.onBeforeCompile ? material.onBeforeCompile.bind(material) : null;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSplatScale = { value: scale };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nuniform float uSplatScale;`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>\n{\n  vec2 wxz = (modelMatrix * vec4(position, 1.0)).xz * uSplatScale;\n  #ifdef USE_MAP\n  vMapUv = wxz;\n  #endif\n  #ifdef USE_NORMALMAP\n  vNormalMapUv = wxz;\n  #endif\n  #ifdef USE_ROUGHNESSMAP\n  vRoughnessMapUv = wxz;\n  #endif\n  #ifdef USE_AOMAP\n  vAoMapUv = wxz;\n  #endif\n}`);
    if (prevCompile) prevCompile(shader);
  };
  material.customProgramCacheKey = () => `forestWorldUV:${scale}`;
}

/**
 * Patches a cloned library material so its final alpha is driven by a
 * per-vertex weight attribute (baked from height/slope/path/hollow) rather
 * than its own alpha channel -- this is the actual "splat" in the blend.
 * Must be called after applyWorldSpaceUV so both onBeforeCompile patches
 * chain together and share one program cache key.
 */
function applyWeightAlpha(material, attrName, layerIndex) {
  const prevCompile = material.onBeforeCompile ? material.onBeforeCompile.bind(material) : null;
  const prevKey = material.customProgramCacheKey ? material.customProgramCacheKey() : '';
  material.transparent = true;
  material.depthWrite = false;
  material.polygonOffset = true;
  material.polygonOffsetFactor = -layerIndex;
  material.polygonOffsetUnits = -layerIndex;

  material.onBeforeCompile = (shader) => {
    if (prevCompile) prevCompile(shader);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute float ${attrName};\nvarying float vSplatWeight;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvSplatWeight = ${attrName};`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying float vSplatWeight;`)
      .replace('#include <dithering_fragment>', `gl_FragColor.a *= vSplatWeight;\n#include <dithering_fragment>`);
  };
  material.customProgramCacheKey = () => `forestSplat:${attrName}:${prevKey}`;
}
