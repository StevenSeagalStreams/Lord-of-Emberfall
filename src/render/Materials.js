import * as THREE from 'three';
import {
  makeValueNoise, fbm, ridgedFbm, domainWarp, worley, crackNetwork, drips,
  anisoFbm, smoothstep, hash2,
  generateImage, generateHeight,
  heightToNormal, heightToAO, heightToCavity,
  toTexture, cached,
} from './TextureGen.js';

/**
 * Material library. Each recipe generates a height field first, then derives
 * albedo, normal, roughness, AO (and metalness, where relevant) from that
 * single field so all channels agree. Deriving them independently is the
 * classic mistake -- you get normals that point at cracks the albedo does
 * not have, and the surface reads as a decal rather than geometry.
 *
 * Tiling: `LevelBuilder` reuses one InstancedMesh + one material per floor
 * cell / wall block, so every instance samples the *same* texture, only
 * rotated 90 degrees and colour-tinted per instance. To keep that from
 * reading as a stamped grid, every material here goes through
 * `applyTilingBreaker`, which patches the compiled shader to also rotate
 * (continuously, not just 90 degrees) and offset each instance's UVs from
 * its own instance matrix -- free per-instance variation with zero extra
 * attributes, safe because every generator in TextureGen.js is built to
 * tile seamlessly at the 0/1 UV boundary.
 *
 * Only `.floor` and `.wall` are forced during `build()`, because those are
 * the only two `main.js`/`LevelBuilder` actually wire up today. Every other
 * recipe is a lazy getter, memoized on first access -- so the full library
 * exists and is usable, but the ~2.5s synthesis budget is only ever spent on
 * materials someone actually asked for.
 */
export class MaterialLibrary {
  constructor(opts = {}) {
    this.size = opts.size ?? 512;
    this.anisotropy = opts.anisotropy ?? 16;
    this._built = new Map();

    const recipes = {
      floor: () => this._flagstone(),
      wall: () => this._blockWall(),
      roughRock: () => this._roughRock(),
      crackedTile: () => this._crackedTile(),
      brick: () => this._brick(),
      woodPlanks: () => this._woodPlanks(),
      woodBeams: () => this._woodBeams(),
      iron: () => this._iron(),
      goldBrass: () => this._goldBrass(),
      bone: () => this._bone(),
      cloth: () => this._cloth(),
      mossWall: () => this._mossWall(),
      bloodFloor: () => this._bloodFloor(),
      bloodWall: () => this._bloodWall(),
    };

    for (const name of Object.keys(recipes)) {
      Object.defineProperty(this, name, {
        configurable: true,
        enumerable: true,
        get: () => {
          if (!this._built.has(name)) this._built.set(name, recipes[name]());
          return this._built.get(name);
        },
      });
    }
  }

  async build() {
    // Force the two materials the renderer actually consumes today so any
    // synthesis error surfaces at load time, not mid-frame on first use.
    void this.floor;
    void this.wall;
    return this;
  }

  // -- shared plumbing -------------------------------------------------

  /** One shared fine-grain bump reused as a detail-normal layer everywhere. */
  _detailNormal() {
    const S = this.size;
    return cached(`detail-normal:${S}`, () => {
      const noise = makeValueNoise(0xd377);
      const h = generateHeight(S, (u, v) => {
        const grain = fbm(noise, u + 1, v + 5, { octaves: 4, basePeriod: 24 });
        const pore = ridgedFbm(noise, u + 9, v + 2, { octaves: 3, basePeriod: 40, sharpness: 2.2 });
        return grain * 0.6 + pore * 0.4;
      });
      return heightToNormal(h, S, 1.4);
    });
  }

  /** Assemble a MeshStandardMaterial from a matched channel set. */
  _finish({ albedo, normal, rough, ao, metal }, opts = {}) {
    const S = this.size;
    const params = {
      map: toTexture(albedo, { srgb: true, aniso: this.anisotropy }),
      normalMap: toTexture(normal, { aniso: this.anisotropy }),
      roughnessMap: toTexture(rough, { aniso: this.anisotropy }),
      aoMap: toTexture(ao, { aniso: this.anisotropy }),
      normalScale: new THREE.Vector2(opts.normalStrength ?? 1.15, opts.normalStrength ?? 1.15),
      aoMapIntensity: opts.aoIntensity ?? 1.0,
      roughness: 1.0,
      metalness: opts.metalness ?? 0.0,
      envMapIntensity: opts.envMapIntensity ?? 0.45,
      color: opts.tint ?? 0xffffff,
    };
    if (metal) params.metalnessMap = toTexture(metal, { aniso: this.anisotropy });
    const mat = new THREE.MeshStandardMaterial(params);
    applyTilingBreaker(mat, {
      rotate: opts.tileRotate ?? 0.5,
      offset: opts.tileOffset ?? 0.55,
      detailNormalMap: opts.detail === false ? null : this._detailNormal(),
      detailScale: opts.detailScale ?? (S >= 1024 ? 14 : 9),
      detailStrength: opts.detailStrength ?? 0.5,
    });
    return mat;
  }

  // -- floor -------------------------------------------------------------

  /** Worn flagstone: irregular slabs, mortar valleys, worn-smooth centres. */
  _flagstone() {
    const S = this.size;
    const noise = makeValueNoise(0x51a7);
    const slabAt = (u, v) => {
      const [wu, wv] = domainWarp(noise, u, v, { amp: 0.05, octaves: 3, basePeriod: 3 });
      return worley(wu, wv, 6, 11);
    };

    const height = cached(`flagstone:height:${S}`, () => generateHeight(S, (u, v) => {
      const { f1, f2 } = slabAt(u, v);
      const edge = Math.min(1, (f2 - f1) * 3.0);
      const mortar = Math.pow(edge, 0.55);
      const grain = fbm(noise, u, v, { octaves: 6, basePeriod: 8 }) * 0.22;
      const micro = ridgedFbm(noise, u * 3 + 4, v * 3 + 8, { octaves: 3, basePeriod: 26, sharpness: 1.7 }) * 0.05;
      const pit = Math.pow(fbm(noise, u + 3.1, v + 7.7, { octaves: 4, basePeriod: 24 }), 4) * 0.5;
      const crack = crackNetwork(u * 1.6 + 9, v * 1.6 + 3, 11, 771, { width: 0.018, gapiness: 0.74 }) * 0.12;
      return mortar * 0.8 + grain + micro - pit - crack;
    }));

    const cavity = cached(`flagstone:cavity:${S}`, () => heightToCavity(height, S, 3, 1.3));
    const normal = heightToNormal(height, S, 2.5);
    const ao = heightToAO(height, S, 5, 1.15);

    // Broad, soft high-traffic patches -- boots polish stone along the paths
    // people actually walk, not uniformly across every slab.
    const wearBandAt = (u, v) => smoothstep(
      0.18, 0.6,
      fbm(noise, u * 0.9 + 50, v * 0.9 + 33, { octaves: 3, basePeriod: 3 }),
    );

    const albedo = generateImage(S, (u, v, x, y) => {
      const h = height[y * S + x];
      const cav = cavity[y * S + x];
      const { id } = slabAt(u, v);
      const slab = ((id & 0xff) / 255 - 0.5) * 0.17;
      const grime = fbm(noise, u * 1.3 + 5, v * 1.3 + 2, { octaves: 5, basePeriod: 6 });
      const dirt = cav * 0.4;
      const base = 0.30 + h * 0.22 + slab - dirt * 0.10;
      const r = base * (1.03 + grime * 0.10);
      const g = base * (0.97 + grime * 0.06) * (1 - dirt * 0.04);
      const b = base * (0.90 + grime * 0.02) * (1 + dirt * 0.06);
      return [r, g, b];
    });

    const rough = generateImage(S, (u, v, x, y) => {
      const h = height[y * S + x];
      const cav = cavity[y * S + x];
      const polish = Math.pow(Math.max(0, h), 1.5);
      const wear = wearBandAt(u, v);
      const r = THREE.MathUtils.clamp(0.92 - polish * 0.4 - wear * 0.22 + cav * 0.28, 0.14, 1.0);
      return [r, r, r];
    });

    return this._finish({ albedo, normal, rough, ao }, { normalStrength: 1.15, envMapIntensity: 0.5 });
  }

  // -- wall ----------------------------------------------------------------

  /** Cut-block masonry: courses of rectangular blocks with deep joints. */
  _blockWall() {
    const S = this.size;
    const noise = makeValueNoise(0x9f31);
    const courses = 6;

    const height = cached(`blockWall:height:${S}`, () => generateHeight(S, (u, v) => {
      const row = Math.floor(v * courses);
      const offset = (row % 2) * 0.5;
      const bx = (u * 4 + offset) % 1;
      const by = (v * courses) % 1;
      const jointX = Math.min(bx, 1 - bx);
      const jointY = Math.min(by, 1 - by);
      const joint = Math.min(smoothstep(jointX, 0.0, 0.055), smoothstep(jointY, 0.0, 0.10));
      const face = fbm(noise, u * 2, v * 2, { octaves: 6, basePeriod: 10 }) * 0.30;
      const chip = Math.pow(fbm(noise, u + 11, v + 4, { octaves: 3, basePeriod: 30 }), 5) * 0.7;
      const crack = crackNetwork(u * 2.2 + 4, v * 2.2 + 1, 9, 552, { width: 0.02, gapiness: 0.8 }) * 0.1;
      return joint * 0.85 + face - chip - crack;
    }));

    const cavity = cached(`blockWall:cavity:${S}`, () => heightToCavity(height, S, 4, 1.2));
    const drip = cached(`blockWall:drip:${S}`, () => generateHeight(S, (u, v) =>
      drips(u, v, 5, 604, noise, { reach: 0.95, spread: 0.10, wobble: 0.4 })));

    const normal = heightToNormal(height, S, 3.0);
    const ao = heightToAO(height, S, 6, 1.35);

    const albedo = generateImage(S, (u, v, x, y) => {
      const i = y * S + x;
      const h = height[i], cav = cavity[i], d = drip[i];
      const base = (0.25 + h * 0.20) * (1 - d * 0.42) * (1 - cav * 0.22);
      const moss = Math.max(0, cav - 0.45) * Math.max(0, 1 - v * 1.15) * 0.9;
      const r = base * (1.0 - moss * 0.4 - d * 0.08);
      const g = base * (1.0 + moss * 0.28 - d * 0.02);
      const b = base * (0.93 - moss * 0.12 + d * 0.10);
      return [r, g, b];
    });

    const rough = generateImage(S, (u, v, x, y) => {
      const i = y * S + x;
      const h = height[i], cav = cavity[i], d = drip[i];
      const r = THREE.MathUtils.clamp(0.95 - d * 0.42 - h * 0.10 + cav * 0.2, 0.12, 1.0);
      return [r, r, r];
    });

    return this._finish({ albedo, normal, rough, ao }, { normalStrength: 1.3, envMapIntensity: 0.4 });
  }

  // -- rough-hewn rock -------------------------------------------------------

  _roughRock() {
    const S = this.size;
    const noise = makeValueNoise(0x22b7);

    const height = cached(`roughRock:height:${S}`, () => generateHeight(S, (u, v) => {
      const [wu, wv] = domainWarp(noise, u, v, { amp: 0.18, octaves: 4, basePeriod: 3 });
      const mass = ridgedFbm(noise, wu, wv, { octaves: 6, basePeriod: 5, sharpness: 1.4 });
      const { f1 } = worley(wu * 0.9, wv * 0.9, 5, 33);
      const boulder = 1 - Math.min(1, f1 * 1.3);
      const crack = crackNetwork(u * 2 + 2, v * 2 + 6, 7, 88, { width: 0.03, gapiness: 0.5 }) * 0.18;
      return mass * 0.55 + boulder * 0.35 - crack;
    }));

    const cavity = cached(`roughRock:cavity:${S}`, () => heightToCavity(height, S, 4, 1.4));
    const normal = heightToNormal(height, S, 3.4);
    const ao = heightToAO(height, S, 6, 1.5);

    const albedo = generateImage(S, (u, v, x, y) => {
      const i = y * S + x;
      const h = height[i], cav = cavity[i];
      const grime = fbm(noise, u * 1.4 + 8, v * 1.4 + 1, { octaves: 4, basePeriod: 5 });
      const base = 0.24 + h * 0.26 - cav * 0.14;
      const r = base * (1.02 + grime * 0.08);
      const g = base * (0.99 + grime * 0.05);
      const b = base * (0.94 + grime * 0.02);
      return [r, g, b];
    });

    const rough = generateImage(S, (u, v, x, y) => {
      const i = y * S + x;
      const r = THREE.MathUtils.clamp(0.97 - height[i] * 0.15 + cavity[i] * 0.15, 0.4, 1.0);
      return [r, r, r];
    });

    return this._finish({ albedo, normal, rough, ao }, { normalStrength: 1.5, envMapIntensity: 0.4 });
  }

  // -- cracked tile ----------------------------------------------------------

  _crackedTile() {
    const S = this.size;
    const noise = makeValueNoise(0x6c31);

    const height = cached(`crackedTile:height:${S}`, () => generateHeight(S, (u, v) => {
      const { f1, f2, id } = worley(u, v, 10, 41);
      const edge = Math.min(1, (f2 - f1) * 4.2);
      const grout = Math.pow(edge, 0.4);
      const shard = crackNetwork(u * 3.4 + 1, v * 3.4 + 5, 26, (id & 0xffff) + 3, { width: 0.05, gapiness: 0.25 }) * 0.4;
      const face = fbm(noise, u * 2 + 2, v * 2 + 9, { octaves: 4, basePeriod: 12 }) * 0.12;
      const chip = Math.pow(fbm(noise, u + 6, v + 6, { octaves: 3, basePeriod: 22 }), 5) * 0.5;
      return grout * 0.7 + face - shard - chip;
    }));

    const cavity = cached(`crackedTile:cavity:${S}`, () => heightToCavity(height, S, 3, 1.3));
    const normal = heightToNormal(height, S, 2.8);
    const ao = heightToAO(height, S, 5, 1.25);

    const albedo = generateImage(S, (u, v, x, y) => {
      const i = y * S + x;
      const { id } = worley(u, v, 10, 41);
      const tile = ((id & 0xff) / 255 - 0.5) * 0.14;
      const h = height[i], cav = cavity[i];
      const base = 0.33 + h * 0.18 + tile - cav * 0.32;
      return [base * 1.02, base * 0.98, base * 0.92];
    });

    const rough = generateImage(S, (u, v, x, y) => {
      const i = y * S + x;
      const polish = Math.pow(Math.max(0, height[i]), 1.6);
      const r = THREE.MathUtils.clamp(0.55 - polish * 0.28 + cavity[i] * 0.4, 0.12, 1.0);
      return [r, r, r];
    });

    return this._finish({ albedo, normal, rough, ao }, { normalStrength: 1.2, envMapIntensity: 0.55 });
  }

  // -- mortar-heavy brick ----------------------------------------------------

  _brick() {
    const S = this.size;
    const noise = makeValueNoise(0xb412);
    const rows = 10;

    const height = cached(`brick:height:${S}`, () => generateHeight(S, (u, v) => {
      const row = Math.floor(v * rows);
      const off = (row % 2) * 0.5;
      const bx = (u * 5 + off) % 1;
      const by = (v * rows) % 1;
      const jointX = Math.min(bx, 1 - bx);
      const jointY = Math.min(by, 1 - by);
      const joint = Math.min(smoothstep(jointX, 0.0, 0.11), smoothstep(jointY, 0.0, 0.16));
      const mortarGrain = fbm(noise, u * 6, v * 6, { octaves: 3, basePeriod: 20 }) * 0.06;
      const face = fbm(noise, u * 3 + 2, v * 3 + 7, { octaves: 5, basePeriod: 12 }) * 0.18;
      const crumble = Math.pow(fbm(noise, u + 9, v + 3, { octaves: 3, basePeriod: 30 }), 4) * 0.55;
      return joint * 0.7 + mortarGrain + face - crumble;
    }));

    const cavity = cached(`brick:cavity:${S}`, () => heightToCavity(height, S, 3, 1.2));
    const normal = heightToNormal(height, S, 2.7);
    const ao = heightToAO(height, S, 5, 1.3);

    const albedo = generateImage(S, (u, v, x, y) => {
      const i = y * S + x;
      const row = Math.floor(v * rows);
      const off = (row % 2) * 0.5;
      const col = Math.floor((u * 5 + off));
      const fireVariance = (hash2(col * 0.31, row * 0.71, 61) - 0.5) * 0.22;
      const h = height[i], cav = cavity[i];
      const base = 0.30 + h * 0.16 + fireVariance - cav * 0.12;
      const r = base * 1.12;
      const g = base * 0.78;
      const b = base * 0.66;
      return [r, g, b];
    });

    const rough = generateImage(S, (u, v, x, y) => {
      const i = y * S + x;
      const r = THREE.MathUtils.clamp(0.9 - height[i] * 0.12 + cavity[i] * 0.25, 0.3, 1.0);
      return [r, r, r];
    });

    return this._finish({ albedo, normal, rough, ao }, { normalStrength: 1.25, envMapIntensity: 0.4 });
  }

  // -- wood ------------------------------------------------------------------

  _woodPlanks() {
    const S = this.size;
    const noise = makeValueNoise(0x7731);
    const planks = 5;

    const height = cached(`woodPlanks:height:${S}`, () => generateHeight(S, (u, v) => {
      const grain = anisoFbm(noise, u, v, 0.06, 14, { octaves: 5, basePeriod: 10 }) * 0.3;
      const plankIdx = Math.floor(u * planks);
      const px = (u * planks) % 1;
      const seam = 1 - smoothstep(Math.min(px, 1 - px), 0, 0.03);
      const knot = worley(u * 3 + plankIdx * 3.1, v * 2 + plankIdx * 1.7, 4, 19);
      const knotMask = Math.pow(Math.max(0, 1 - knot.f1 * 2.2), 3) * 0.4;
      const crack = crackNetwork(u * 4 + plankIdx, v * 1.2 + 3, 5, 210 + plankIdx, { width: 0.02, gapiness: 0.6 }) * 0.12;
      return grain * 0.6 - seam * 0.5 - knotMask - crack;
    }));

    const cavity = cached(`woodPlanks:cavity:${S}`, () => heightToCavity(height, S, 3, 1.2));
    const normal = heightToNormal(height, S, 2.2);
    const ao = heightToAO(height, S, 4, 1.15);

    const albedo = generateImage(S, (u, v, x, y) => {
      const i = y * S + x;
      const h = height[i], cav = cavity[i];
      const plankIdx = Math.floor(u * planks);
      const tint = (hash2(plankIdx * 0.41, 0.17, 88) - 0.5) * 0.2;
      const grain2 = anisoFbm(noise, u + 4, v + 1, 0.06, 20, { octaves: 4, basePeriod: 16 });
      const base = 0.30 + h * 0.22 + tint - cav * 0.2;
      const r = base * (1.28 + grain2 * 0.1);
      const g = base * (0.86 + grain2 * 0.06);
      const b = base * (0.52 + grain2 * 0.03);
      return [r, g, b];
    });

    const rough = generateImage(S, (u, v, x, y) => {
      const i = y * S + x;
      const r = THREE.MathUtils.clamp(0.62 - height[i] * 0.18 + cavity[i] * 0.28, 0.25, 1.0);
      return [r, r, r];
    });

    return this._finish({ albedo, normal, rough, ao }, { normalStrength: 1.05, envMapIntensity: 0.4 });
  }

  _woodBeams() {
    const S = this.size;
    const noise = makeValueNoise(0x8842);

    const height = cached(`woodBeams:height:${S}`, () => generateHeight(S, (u, v) => {
      const adze = ridgedFbm(noise, u * 1.2, v * 5 + 2, { octaves: 4, basePeriod: 6, sharpness: 1.3 }) * 0.32;
      const grain = anisoFbm(noise, u + 2, v + 5, 0.02, 22, { octaves: 4, basePeriod: 14 }) * 0.18;
      const crack = crackNetwork(u * 1.6 + 4, v * 3 + 2, 6, 340, { width: 0.028, gapiness: 0.55 }) * 0.2;
      return adze * 0.6 + grain - crack;
    }));

    const cavity = cached(`woodBeams:cavity:${S}`, () => heightToCavity(height, S, 4, 1.3));
    const normal = heightToNormal(height, S, 2.6);
    const ao = heightToAO(height, S, 5, 1.3);

    const albedo = generateImage(S, (u, v, x, y) => {
      const i = y * S + x;
      const h = height[i], cav = cavity[i];
      const weather = smoothstep(0.3, 0.85, fbm(noise, u * 1.1 + 9, v * 1.1 + 4, { octaves: 3, basePeriod: 4 }));
      const base = 0.28 + h * 0.2 - cav * 0.18;
      const woodR = base * 1.22, woodG = base * 0.80, woodB = base * 0.48;
      const greyR = base * 0.92, greyG = base * 0.90, greyB = base * 0.86;
      return [
        THREE.MathUtils.lerp(woodR, greyR, weather * 0.6),
        THREE.MathUtils.lerp(woodG, greyG, weather * 0.6),
        THREE.MathUtils.lerp(woodB, greyB, weather * 0.6),
      ];
    });

    const rough = generateImage(S, (u, v, x, y) => {
      const i = y * S + x;
      const r = THREE.MathUtils.clamp(0.75 - height[i] * 0.15 + cavity[i] * 0.25, 0.35, 1.0);
      return [r, r, r];
    });

    return this._finish({ albedo, normal, rough, ao }, { normalStrength: 1.2, envMapIntensity: 0.35 });
  }

  // -- metal -------------------------------------------------------------

  /** Worn, pitted iron/steel with rust in the crevices and shine on the edges. */
  _iron() {
    const S = this.size;
    const noise = makeValueNoise(0x1290);

    const height = cached(`iron:height:${S}`, () => generateHeight(S, (u, v) => {
      const hammer = ridgedFbm(noise, u * 4, v * 4, { octaves: 4, basePeriod: 14, sharpness: 2.0 }) * 0.22;
      const { f1 } = worley(u * 8, v * 8, 20, 71);
      const pit = Math.pow(Math.max(0, 1 - f1 * 3), 4) * 0.35;
      const scratch = anisoFbm(noise, u * 6 + 3, v * 6 + 1, 0.4, 30, { octaves: 3, basePeriod: 40 }) * 0.05;
      return hammer - pit + scratch;
    }));

    const cavity = cached(`iron:cavity:${S}`, () => heightToCavity(height, S, 3, 1.4));
    const normal = heightToNormal(height, S, 2.2);
    const ao = heightToAO(height, S, 5, 1.3);

    const rustAt = (u, v) => Math.max(0, fbm(noise, u * 1.6 + 7, v * 1.6 + 2, { octaves: 4, basePeriod: 5 }) - 0.42) * 1.7;

    const albedo = generateImage(S, (u, v, x, y) => {
      const i = y * S + x;
      const h = height[i], cav = cavity[i];
      const rust = Math.min(1, rustAt(u, v) + cav * 0.5);
      const edgeShine = smoothstep(0.55, 0.9, h);
      const steel = 0.32 + edgeShine * 0.22;
      const r = THREE.MathUtils.lerp(steel, 0.42, rust);
      const g = THREE.MathUtils.lerp(steel, 0.20, rust);
      const b = THREE.MathUtils.lerp(steel, 0.10, rust);
      return [r, g, b];
    });

    const rough = generateImage(S, (u, v, x, y) => {
      const i = y * S + x;
      const rust = Math.min(1, rustAt(u, v) + cavity[i] * 0.5);
      const edgeShine = smoothstep(0.55, 0.9, height[i]);
      const r = THREE.MathUtils.clamp(0.55 - edgeShine * 0.35 + rust * 0.4, 0.12, 0.95);
      return [r, r, r];
    });

    const metal = generateImage(S, (u, v, x, y) => {
      const i = y * S + x;
      const rust = Math.min(1, rustAt(u, v) + cavity[i] * 0.5);
      const m = THREE.MathUtils.clamp(1.0 - rust * 0.85, 0.1, 1.0);
      return [m, m, m];
    });

    return this._finish({ albedo, normal, rough, ao, metal }, {
      metalness: 1.0, normalStrength: 1.0, envMapIntensity: 1.1, detailStrength: 0.35,
    });
  }

  /** Gilt gold/brass: bright polished highs, tarnish pooled in the grooves. */
  _goldBrass() {
    const S = this.size;
    const noise = makeValueNoise(0x5a10);

    const height = cached(`goldBrass:height:${S}`, () => generateHeight(S, (u, v) => {
      const form = fbm(noise, u * 2 + 1, v * 2 + 3, { octaves: 4, basePeriod: 8 }) * 0.16;
      const groove = crackNetwork(u * 3 + 2, v * 3 + 5, 12, 902, { width: 0.045, gapiness: 0.2 }) * 0.5;
      const dent = Math.pow(fbm(noise, u + 8, v + 6, { octaves: 3, basePeriod: 26 }), 5) * 0.25;
      return form - groove - dent;
    }));

    const cavity = cached(`goldBrass:cavity:${S}`, () => heightToCavity(height, S, 3, 1.3));
    const normal = heightToNormal(height, S, 1.8);
    const ao = heightToAO(height, S, 4, 1.2);

    const albedo = generateImage(S, (u, v, x, y) => {
      const i = y * S + x;
      const tarnish = Math.min(1, cavity[i] * 1.3);
      const polish = smoothstep(0.5, 0.9, height[i]);
      const r = THREE.MathUtils.lerp(0.80 + polish * 0.15, 0.30, tarnish);
      const g = THREE.MathUtils.lerp(0.63 + polish * 0.15, 0.24, tarnish);
      const b = THREE.MathUtils.lerp(0.20 + polish * 0.10, 0.14, tarnish);
      return [r, g, b];
    });

    const rough = generateImage(S, (u, v, x, y) => {
      const i = y * S + x;
      const tarnish = Math.min(1, cavity[i] * 1.3);
      const polish = smoothstep(0.5, 0.9, height[i]);
      const r = THREE.MathUtils.clamp(0.5 - polish * 0.38 + tarnish * 0.4, 0.08, 0.9);
      return [r, r, r];
    });

    return this._finish({ albedo, normal, rough, ao }, {
      metalness: 1.0, normalStrength: 0.9, envMapIntensity: 1.2, detailStrength: 0.3,
    });
  }

  // -- organic ----------------------------------------------------------

  _bone() {
    const S = this.size;
    const noise = makeValueNoise(0x3ba1);

    const height = cached(`bone:height:${S}`, () => generateHeight(S, (u, v) => {
      const form = fbm(noise, u * 2, v * 2, { octaves: 5, basePeriod: 6 }) * 0.24;
      const { f1 } = worley(u * 10, v * 10, 22, 41);
      const pore = Math.pow(Math.max(0, 1 - f1 * 3.2), 5) * 0.3;
      const crack = crackNetwork(u * 3 + 1, v * 3 + 4, 16, 512, { width: 0.015, gapiness: 0.78 }) * 0.15;
      return form - pore - crack;
    }));

    const cavity = cached(`bone:cavity:${S}`, () => heightToCavity(height, S, 3, 1.2));
    const normal = heightToNormal(height, S, 1.6);
    const ao = heightToAO(height, S, 4, 1.1);

    const albedo = generateImage(S, (u, v, x, y) => {
      const i = y * S + x;
      const h = height[i], cav = cavity[i];
      const age = fbm(noise, u * 1.2 + 5, v * 1.2 + 9, { octaves: 3, basePeriod: 4 });
      const base = 0.72 + h * 0.14 - cav * 0.22;
      const r = base * (1.02 + age * 0.05);
      const g = base * (0.97 + age * 0.04);
      const b = base * (0.86 - age * 0.02);
      return [r, g, b];
    });

    const rough = generateImage(S, (u, v, x, y) => {
      const i = y * S + x;
      const r = THREE.MathUtils.clamp(0.72 - height[i] * 0.16 + cavity[i] * 0.2, 0.35, 0.95);
      return [r, r, r];
    });

    return this._finish({ albedo, normal, rough, ao }, { normalStrength: 0.9, envMapIntensity: 0.4 });
  }

  /** Woven banner cloth: crossed warp/weft weave, grime pooled in the weave. */
  _cloth() {
    const S = this.size;
    const noise = makeValueNoise(0x64c2);

    const height = cached(`cloth:height:${S}`, () => generateHeight(S, (u, v) => {
      const warp = anisoFbm(noise, u, v, 0.0, 24, { octaves: 3, basePeriod: 34 }) * 0.5;
      const weft = anisoFbm(noise, u + 3, v + 7, Math.PI / 2, 24, { octaves: 3, basePeriod: 34 }) * 0.5;
      const weave = warp * weft * 2;
      const drape = fbm(noise, u * 1.1 + 2, v * 0.6 + 4, { octaves: 3, basePeriod: 3 }) * 0.3;
      return weave * 0.4 + drape;
    }));

    const cavity = cached(`cloth:cavity:${S}`, () => heightToCavity(height, S, 3, 1.2));
    const normal = heightToNormal(height, S, 1.5);
    const ao = heightToAO(height, S, 4, 1.15);

    const albedo = generateImage(S, (u, v, x, y) => {
      const i = y * S + x;
      const h = height[i], cav = cavity[i];
      const grime = cav * 0.3;
      const base = 0.30 + h * 0.14 - grime;
      const r = base * 1.35;
      const g = base * 0.18;
      const b = base * 0.20;
      return [r, g, b];
    });

    const rough = generateImage(S, (u, v, x, y) => {
      const i = y * S + x;
      const r = THREE.MathUtils.clamp(0.88 - height[i] * 0.1 + cavity[i] * 0.1, 0.55, 1.0);
      return [r, r, r];
    });

    return this._finish({ albedo, normal, rough, ao }, { normalStrength: 0.8, envMapIntensity: 0.3, detailStrength: 0.3 });
  }

  // -- overlays / variants ------------------------------------------------

  /** Block wall with moss colonising the damp, shaded crevices near the floor. */
  _mossWall() {
    const S = this.size;
    const noise = makeValueNoise(0x9f31);
    const baseHeight = cached(`blockWall:height:${S}`, () => this._blockWall() && cached(`blockWall:height:${S}`, () => { throw new Error('unreachable'); }));
    // (baseHeight above always hits the cache populated by _blockWall(); see note below)
    const height = cached(`blockWall:height:${S}`);
    const cavity = cached(`blockWall:cavity:${S}`);
    const drip = cached(`blockWall:drip:${S}`);

    const mossPatch = cached(`mossWall:patch:${S}`, () => generateHeight(S, (u, v) => {
      const { f1 } = worley(u * 5 + 2, v * 5 + 6, 8, 703);
      const cluster = Math.max(0, 1 - f1 * 1.6);
      return cluster;
    }));

    const mossHeight = cached(`mossWall:height:${S}`, () => {
      const h = new Float32Array(S * S);
      for (let i = 0; i < h.length; i++) {
        const damp = Math.max(0, cavity[i] - 0.3);
        h[i] = height[i] + mossPatch[i] * damp * 0.35;
      }
      return h;
    });

    const normal = heightToNormal(mossHeight, S, 3.0);
    const ao = heightToAO(mossHeight, S, 6, 1.35);

    const albedo = generateImage(S, (u, v, x, y) => {
      const i = y * S + x;
      const h = height[i], cav = cavity[i], d = drip[i];
      const lowBias = Math.max(0, 1 - v * 1.1);
      const moss = Math.min(1, mossPatch[i] * Math.max(0, cav - 0.25) * (0.4 + lowBias * 0.8) * 1.6);
      const base = (0.25 + h * 0.2) * (1 - d * 0.4) * (1 - cav * 0.2);
      const r = base * (1.0 - moss * 0.55) - d * 0.02;
      const g = base * (1.0 + moss * 0.55);
      const b = base * (0.92 - moss * 0.25);
      return [r, g, b];
    });

    const rough = generateImage(S, (u, v, x, y) => {
      const i = y * S + x;
      const lowBias = Math.max(0, 1 - v * 1.1);
      const moss = Math.min(1, mossPatch[i] * Math.max(0, cavity[i] - 0.25) * (0.4 + lowBias * 0.8) * 1.6);
      const r = THREE.MathUtils.clamp(0.95 - drip[i] * 0.42 - height[i] * 0.1 + cavity[i] * 0.2 + moss * 0.15, 0.12, 1.0);
      return [r, r, r];
    });

    return this._finish({ albedo, normal, rough, ao }, { normalStrength: 1.3, envMapIntensity: 0.4 });
  }

  /** Flagstone with a fresh dark pool + spatter of blood. */
  _bloodFloor() {
    const S = this.size;
    const noise = makeValueNoise(0x51a7);
    if (!this._built.has('floor')) void this.floor; // ensure caches are warm
    const height = cached(`flagstone:height:${S}`);
    const cavity = cached(`flagstone:cavity:${S}`);
    const normal = heightToNormal(height, S, 2.5);
    const ao = heightToAO(height, S, 5, 1.15);

    const poolAt = (u, v) => {
      const { f1 } = worley(u * 2 + 3, v * 2 + 8, 3, 909);
      return Math.max(0, 1 - f1 * 1.9);
    };

    const albedo = generateImage(S, (u, v, x, y) => {
      const i = y * S + x;
      const h = height[i], cav = cavity[i];
      const pool = poolAt(u, v);
      const spatter = Math.max(0, fbm(noise, u * 5 + 3, v * 5 + 9, { octaves: 4, basePeriod: 30 }) - 0.6) * 2;
      const blood = Math.min(1, pool + spatter * 0.6);
      const slabBase = 0.30 + h * 0.22 - cav * 0.1;
      const r = THREE.MathUtils.lerp(slabBase * 1.03, 0.22, blood);
      const g = THREE.MathUtils.lerp(slabBase * 0.97, 0.02, blood);
      const b = THREE.MathUtils.lerp(slabBase * 0.90, 0.03, blood);
      return [r, g, b];
    });

    const rough = generateImage(S, (u, v, x, y) => {
      const i = y * S + x;
      const pool = poolAt(u, v);
      const base = THREE.MathUtils.clamp(0.92 - Math.max(0, height[i]) * 0.4 + cavity[i] * 0.28, 0.14, 1.0);
      return [THREE.MathUtils.lerp(base, 0.18, pool), THREE.MathUtils.lerp(base, 0.18, pool), THREE.MathUtils.lerp(base, 0.18, pool)];
    });

    return this._finish({ albedo, normal, rough, ao }, { normalStrength: 1.15, envMapIntensity: 0.5 });
  }

  /** Block wall with a dark stain of blood running down from a height. */
  _bloodWall() {
    const S = this.size;
    const noise = makeValueNoise(0x9f31);
    if (!this._built.has('wall')) void this.wall;
    const height = cached(`blockWall:height:${S}`);
    const cavity = cached(`blockWall:cavity:${S}`);
    const normal = heightToNormal(height, S, 3.0);
    const ao = heightToAO(height, S, 6, 1.35);

    const bloodDrip = cached(`bloodWall:drip:${S}`, () => generateHeight(S, (u, v) =>
      drips(u, v, 3, 415, noise, { reach: 0.55, spread: 0.09, wobble: 0.5 })));

    const albedo = generateImage(S, (u, v, x, y) => {
      const i = y * S + x;
      const h = height[i], cav = cavity[i], b2 = bloodDrip[i];
      const base = (0.26 + h * 0.2) * (1 - cav * 0.2);
      const r = THREE.MathUtils.lerp(base * 1.0, 0.24, b2);
      const g = THREE.MathUtils.lerp(base * 0.98, 0.03, b2);
      const b = THREE.MathUtils.lerp(base * 0.9, 0.04, b2);
      return [r, g, b];
    });

    const rough = generateImage(S, (u, v, x, y) => {
      const i = y * S + x;
      const base = THREE.MathUtils.clamp(0.95 - height[i] * 0.1 + cavity[i] * 0.2, 0.14, 1.0);
      return [
        THREE.MathUtils.lerp(base, 0.2, bloodDrip[i]),
        THREE.MathUtils.lerp(base, 0.2, bloodDrip[i]),
        THREE.MathUtils.lerp(base, 0.2, bloodDrip[i]),
      ];
    });

    return this._finish({ albedo, normal, rough, ao }, { normalStrength: 1.3, envMapIntensity: 0.4 });
  }
}

// ---------------------------------------------------------------------------
// tiling breaker: continuous per-instance UV rotate + offset, plus a
// high-frequency detail-normal blend for close-up relief.
// ---------------------------------------------------------------------------

function applyTilingBreaker(material, opts = {}) {
  const rotate = opts.rotate ?? 0.5;
  const offset = opts.offset ?? 0.55;
  const detailNormalMap = opts.detailNormalMap ?? null;
  const detailScale = opts.detailScale ?? 9;
  const detailStrength = opts.detailStrength ?? 0.5;

  material.customProgramCacheKey = () =>
    `tilebreak|r${rotate}|o${offset}|d${detailNormalMap ? `${detailScale}_${detailStrength}` : 'none'}`;

  material.onBeforeCompile = (shader) => {
    if (detailNormalMap) {
      shader.uniforms.detailNormalMap = { value: detailNormalMap };
      shader.uniforms.detailScale = { value: detailScale };
      shader.uniforms.detailStrength = { value: detailStrength };
    }

    // Per-instance continuous UV rotation + offset, derived from each
    // instance's own world position (no extra attributes needed). Applied
    // identically to every map's UV so albedo/normal/roughness/AO stay in
    // registration with each other on every instance.
    shader.vertexShader = shader.vertexShader.replace(
      '#include <uv_vertex>',
      `#include <uv_vertex>
      #ifdef USE_INSTANCING
      {
        vec2 iseed = instanceMatrix[3].xz * 0.093;
        float ih1 = rand(iseed);
        float ih2 = rand(iseed + 11.7);
        float iang = (ih1 - 0.5) * ${rotate.toFixed(4)};
        float ica = cos(iang), isa = sin(iang);
        mat2 irot = mat2(ica, -isa, isa, ica);
        vec2 ioff = (vec2(ih1, ih2) - 0.5) * ${offset.toFixed(4)};
        #ifdef USE_MAP
          vMapUv = irot * (vMapUv - 0.5) + 0.5 + ioff;
        #endif
        #ifdef USE_NORMALMAP
          vNormalMapUv = irot * (vNormalMapUv - 0.5) + 0.5 + ioff;
        #endif
        #ifdef USE_ROUGHNESSMAP
          vRoughnessMapUv = irot * (vRoughnessMapUv - 0.5) + 0.5 + ioff;
        #endif
        #ifdef USE_AOMAP
          vAoMapUv = irot * (vAoMapUv - 0.5) + 0.5 + ioff;
        #endif
        #ifdef USE_METALNESSMAP
          vMetalnessMapUv = irot * (vMetalnessMapUv - 0.5) + 0.5 + ioff;
        #endif
      }
      #endif`,
    );

    if (detailNormalMap) {
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform sampler2D detailNormalMap;
          uniform float detailScale;
          uniform float detailStrength;`,
        )
        .replace(
          'mapN.xy *= normalScale;',
          `mapN.xy *= normalScale;
          vec3 mapD = texture2D( detailNormalMap, vNormalMapUv * detailScale ).xyz * 2.0 - 1.0;
          mapN = normalize( vec3( mapN.xy + mapD.xy * detailStrength, mapN.z ) );`,
        );
    }
  };
}
