import * as THREE from 'three';

/**
 * Procedural texture synthesis.
 *
 * The game ships no image files. Every surface is generated at load time into
 * an OffscreenCanvas and uploaded as a tiling texture. Two reasons: the whole
 * build stays a single self-contained bundle, and a height field generated in
 * code can emit a *matched* normal/roughness/AO set, which is what actually
 * makes stone read as stone under a moving torch.
 *
 * Tileability contract: every generator below that takes `(u, v)` in [0,1)
 * is built so that sampling wraps seamlessly across the 0/1 boundary --
 * `noise`/`fbm`/`worley`/`drips` all index their lattices modulo an integer
 * `period`, so shifting `u` or `v` by exactly 1.0 lands on the same lattice
 * cell. That is what lets Materials.js apply a per-instance UV rotation +
 * offset in a shader patch (RepeatWrapping) without seams, and it is also
 * what makes a height field "tri-planar-friendly": the same tile can be
 * sampled on any of the three axis-aligned planes without a visible cut.
 */

// ---------------------------------------------------------------------------
// noise
// ---------------------------------------------------------------------------

/** Tileable value noise on an integer lattice with cosine interpolation. */
export function makeValueNoise(seed = 1) {
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const cache = new Map();
  const lattice = (period) => {
    let g = cache.get(period);
    if (g) return g;
    g = new Float32Array(period * period);
    for (let i = 0; i < g.length; i++) g[i] = rand();
    cache.set(period, g);
    return g;
  };

  return function noise(x, y, period) {
    const g = lattice(period);
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const wrap = (v) => ((v % period) + period) % period;
    const x0 = wrap(xi), y0 = wrap(yi);
    const x1 = wrap(xi + 1), y1 = wrap(yi + 1);
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const a = g[y0 * period + x0], b = g[y0 * period + x1];
    const c = g[y1 * period + x0], d = g[y1 * period + x1];
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  };
}

/** Tileable fractal Brownian motion. Returns [0,1]. */
export function fbm(noise, x, y, { octaves = 5, basePeriod = 4, lacunarity = 2, gain = 0.5 } = {}) {
  let amp = 1, sum = 0, norm = 0, period = basePeriod;
  for (let o = 0; o < octaves; o++) {
    sum += noise(x * period, y * period, period) * amp;
    norm += amp;
    amp *= gain;
    period = Math.round(period * lacunarity);
  }
  return sum / norm;
}

/** Ridge transform: folds noise around its midpoint so troughs become sharp crests. */
export function ridge(n, sharpness = 1) {
  const r = 1 - Math.abs(n * 2 - 1);
  return sharpness === 1 ? r : Math.pow(r, sharpness);
}

/**
 * Tileable ridged/turbulent FBM -- veins of rock, cracked-earth relief,
 * hammered metal. Each octave is folded so valleys pinch into sharp ridges,
 * which reads as much more geological than plain fbm.
 */
export function ridgedFbm(noise, x, y, { octaves = 5, basePeriod = 4, lacunarity = 2, gain = 0.5, sharpness = 1.6 } = {}) {
  let amp = 0.5, sum = 0, norm = 0, period = basePeriod, weight = 1;
  for (let o = 0; o < octaves; o++) {
    let n = ridge(noise(x * period, y * period, period), sharpness);
    n *= weight;
    weight = THREE.MathUtils.clamp(n * 1.4, 0, 1);
    sum += n * amp;
    norm += amp;
    amp *= gain;
    period = Math.round(period * lacunarity);
  }
  return sum / norm;
}

/**
 * Domain-warp a coordinate with a second, independent fbm field before the
 * caller samples it. Stays tileable because the offset fields are themselves
 * built from the same period-wrapped fbm machinery -- shifting (x,y) by an
 * integer still lands on the same warp value, so warped sampling of a
 * tileable field is itself tileable.
 */
export function domainWarp(noise, x, y, { amp = 0.12, octaves = 3, basePeriod = 3 } = {}) {
  const wx = fbm(noise, x + 4.21, y + 9.78, { octaves, basePeriod }) - 0.5;
  const wy = fbm(noise, x + 17.3, y + 2.05, { octaves, basePeriod }) - 0.5;
  return [x + wx * amp, y + wy * amp];
}

/** Tileable Worley/cellular noise. Returns { f1, f2, id }. */
export function worley(x, y, period, seed = 0) {
  const px = x * period, py = y * period;
  const xi = Math.floor(px), yi = Math.floor(py);
  let f1 = Infinity, f2 = Infinity, id = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx, cy = yi + dy;
      const wx = ((cx % period) + period) % period;
      const wy = ((cy % period) + period) % period;
      const h = worleyHash(wx, wy, seed);
      const ox = ((h & 0xffff) / 65535);
      const oy = (((h >>> 16) & 0xffff) / 65535);
      const fx = cx + ox, fy = cy + oy;
      const d = Math.hypot(px - fx, py - fy);
      if (d < f1) { f2 = f1; f1 = d; id = h; }
      else if (d < f2) { f2 = d; }
    }
  }
  return { f1, f2, id };
}

function worleyHash(i, j, seed = 0) {
  let h = (i * 374761393 + j * 668265263 + seed * 1442695040888963407) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return h >>> 0;
}

/** Deterministic 2D hash in [0,1), for one-off jitter that need not tile. */
export function hash2(x, y, seed = 0) {
  const h = worleyHash(Math.floor(x * 131 + seed * 7), Math.floor(y * 131 - seed * 3), seed);
  return h / 4294967295;
}

/**
 * A thin, organic crack network from Worley cell edges: bright where two
 * cells nearly tie (the boundary), with a random per-edge "keep" mask so
 * cracks trail off into dead ends instead of forming a uniform grid.
 */
export function crackNetwork(u, v, period, seed = 0, { width = 0.035, gapiness = 0.55 } = {}) {
  const { f1, f2, id } = worley(u, v, period, seed);
  const d = f2 - f1;
  let line = 1 - smoothstep(0, width, d);
  // Random per-cell suppression so not every boundary becomes a visible crack.
  const keep = hash2((id & 0xffff) * 0.0001, (id >>> 16) * 0.0001, seed + 91);
  line *= keep > gapiness ? 1 : smoothstep(gapiness - 0.25, gapiness, keep);
  return line;
}

/**
 * Downward-flowing stain/drip field, built from a Worley-style lattice of
 * "source" points whose influence only travels in the direction of
 * increasing v (down), tapering as it goes and wobbling under a noise field.
 * Tileable in both axes by construction (same modulo-period neighbour search
 * as `worley`).
 */
export function drips(u, v, period, seed = 0, noise = null, { reach = 0.8, spread = 0.16, wobble = 0.35 } = {}) {
  const px = u * period, py = v * period;
  const xi = Math.floor(px), yi = Math.floor(py);
  let best = 0;
  const maxDv = reach * period;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx, cy = yi + dy;
      const wx = ((cx % period) + period) % period;
      const wy = ((cy % period) + period) % period;
      const h = worleyHash(wx, wy, seed);
      const ox = (h & 0xffff) / 65535;
      const oy = ((h >>> 16) & 0xffff) / 65535;
      const fx = cx + ox, fy = cy + oy;

      let dv = py - fy;
      dv = ((dv % period) + period) % period;
      if (dv > maxDv) continue;

      const wob = noise ? (noise((fx + py * 0.35) / period * 6, oy * 6, 8) - 0.5) * wobble * period : 0;
      let dh = Math.abs(px - fx + wob);
      dh = Math.min(dh, period - dh);

      const spreadPx = spread * period * (0.55 + 0.45 * (1 - dv / maxDv));
      const gaussian = Math.exp(-(dh * dh) / (2 * spreadPx * spreadPx));
      const fall = Math.pow(1 - dv / maxDv, 1.4);
      const strength = ((h >>> 8) & 0xff) / 255;
      const val = gaussian * fall * (0.35 + strength * 0.65);
      if (val > best) best = val;
    }
  }
  return Math.min(1, best);
}

/**
 * Anisotropic streak/scratch field: samples noise in a coordinate frame
 * stretched along `angle`, so the result reads as elongated wear marks
 * rather than isotropic bumps. Feed it through `ridge()` for crisp scratch
 * lines or use raw for brushed-metal grain / wood grain.
 */
export function anisoNoise(noise, x, y, angle, stretch, period) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const xr = x * c - y * s;
  const yr = (x * s + y * c) / stretch;
  return noise(xr * period, yr * period, period);
}

export function anisoFbm(noise, x, y, angle, stretch, { octaves = 4, basePeriod = 6, lacunarity = 2, gain = 0.5 } = {}) {
  let amp = 1, sum = 0, norm = 0, period = basePeriod;
  for (let o = 0; o < octaves; o++) {
    sum += anisoNoise(noise, x, y, angle, stretch, period) * amp;
    norm += amp;
    amp *= gain;
    period = Math.round(period * lacunarity);
  }
  return sum / norm;
}

export function smoothstep(x, a, b) {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// canvas plumbing
// ---------------------------------------------------------------------------

export function createCanvas(size) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(size, size);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

/**
 * Run a per-pixel generator over a square image.
 * @param {(u:number,v:number,x:number,y:number)=>[number,number,number,number?]} fn
 */
export function generateImage(size, fn) {
  const canvas = createCanvas(size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.createImageData(size, size);
  const data = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const [r, g, b, a] = fn(x / size, y / size, x, y);
      data[i] = r * 255;
      data[i + 1] = g * 255;
      data[i + 2] = b * 255;
      data[i + 3] = (a ?? 1) * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Generate a Float32Array height field, which downstream maps derive from. */
export function generateHeight(size, fn) {
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) h[y * size + x] = fn(x / size, y / size, x, y);
  }
  return h;
}

/** Blend a second height field into a base one (in place on a copy). */
export function mixHeight(a, b, t) {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] * (1 - t) + b[i] * t;
  return out;
}

/**
 * Sobel a height field into a tangent-space normal map.
 * `strength` is in height-units per texel; higher = more pronounced relief.
 */
export function heightToNormal(height, size, strength = 2.2) {
  const canvas = createCanvas(size);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const at = (x, y) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
      const l = at(x - 1, y), r = at(x + 1, y);
      const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);

      const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);

      let nx = -dx * strength;
      let ny = -dy * strength;
      let nz = 1.0;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;

      const i = (y * size + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * 0.5 + 0.5) * 255;
      d[i + 2] = (nz * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Blend two tangent-space normal maps whiteout-style (adds slopes, keeps unit
 * length). Used to layer a high-frequency detail bump onto a low-frequency
 * relief normal so close-up shots still show micro-relief.
 */
export function blendNormals(base, detail, size, detailScale = 6, strength = 0.6) {
  const bctx = base.getContext('2d');
  const dctx = detail.getContext('2d');
  const bd = bctx.getImageData(0, 0, size, size).data;
  const dd = dctx.getImageData(0, 0, size, size).data;
  const canvas = createCanvas(size);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const out = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = Math.floor(((x * detailScale) % size + size) % size);
      const dy = Math.floor(((y * detailScale) % size + size) % size);
      const j = (dy * size + dx) * 4;
      const n1x = bd[i] / 255 * 2 - 1, n1y = bd[i + 1] / 255 * 2 - 1, n1z = bd[i + 2] / 255 * 2 - 1;
      const n2x = (dd[j] / 255 * 2 - 1) * strength, n2y = (dd[j + 1] / 255 * 2 - 1) * strength;
      let nx = n1x + n2x, ny = n1y + n2y, nz = n1z;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = (nz * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Cheap screen-space-style AO baked from a height field (concavity estimate). */
export function heightToAO(height, size, radius = 4, strength = 1.0) {
  const canvas = createCanvas(size);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const at = (x, y) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)];

  const samples = [];
  for (let a = 0; a < 8; a++) {
    const ang = (a / 8) * Math.PI * 2;
    samples.push([Math.cos(ang), Math.sin(ang)]);
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const h0 = at(x, y);
      let occ = 0;
      for (const [sx, sy] of samples) {
        let maxSlope = 0;
        for (let s = 1; s <= radius; s++) {
          const hs = at(Math.round(x + sx * s), Math.round(y + sy * s));
          maxSlope = Math.max(maxSlope, (hs - h0) / s);
        }
        occ += Math.max(0, maxSlope);
      }
      occ = 1 - Math.min(1, (occ / samples.length) * 6 * strength);
      const i = (y * size + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = occ * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Cavity mask: separable box-blur of the height field minus the height field
 * itself, clamped positive and normalised. Positive where the surface is a
 * local *pit* relative to its neighbourhood -- exactly where dirt, grime and
 * moss physically accumulate, and where mortar joints sit relative to slab
 * faces. This is what lets albedo/roughness "know" where the crevices are
 * without re-deriving them from scratch.
 */
export function heightToCavity(height, size, radius = 3, strength = 1.2) {
  const at = (arr, x, y) => arr[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  const tmp = new Float32Array(size * size);
  const blur = new Float32Array(size * size);
  const norm = 1 / (radius * 2 + 1);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let s = 0;
      for (let d = -radius; d <= radius; d++) s += at(height, x + d, y);
      tmp[y * size + x] = s * norm;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let s = 0;
      for (let d = -radius; d <= radius; d++) s += at(tmp, x, y + d);
      blur[y * size + x] = s * norm;
    }
  }
  let maxC = 1e-5;
  const cav = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    const c = Math.max(0, blur[i] - height[i]);
    cav[i] = c;
    if (c > maxC) maxC = c;
  }
  for (let i = 0; i < size * size; i++) cav[i] = Math.min(1, (cav[i] / maxC) * strength);
  return cav;
}

// ---------------------------------------------------------------------------
// texture wrapping
// ---------------------------------------------------------------------------

export function toTexture(canvas, { srgb = false, repeat = 1, aniso = 16 } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = aniso;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// cache
// ---------------------------------------------------------------------------

const _cache = new Map();

/**
 * Memoize an expensive synthesis step (a height field, a canvas, a whole
 * material recipe) behind a string key. Repeated `MaterialLibrary` builds --
 * hot reload, a second playthrough in the same tab, a lazily-accessed
 * material fetched twice -- become a Map lookup instead of a resynthesis.
 */
export function cached(key, factory) {
  if (_cache.has(key)) return _cache.get(key);
  const v = factory();
  _cache.set(key, v);
  return v;
}

export function clearTextureCache() {
  _cache.clear();
}
