import * as THREE from 'three';

/**
 * Rarity-coloured pillars of light -- the Diablo II loot beam.
 *
 * One `InstancedMesh` for the vertical shaft, one for the ground glow disc
 * beneath it: two draw calls regardless of how many beams are live. Colour,
 * spawn time and a per-instance seed live in one small instanced attribute;
 * everything that moves (the vertical scroll, the flicker, the fade-in) is a
 * function of `uTime` in the shader, so an idle beam costs nothing on the
 * CPU after `spawn()`. A ring buffer recycles the oldest beam once capacity
 * is hit, matching `Decals`/`GPUParticles`.
 */
const RARITY_COLOR = {
  normal: [1.35, 1.35, 1.4],   // white
  magic: [0.35, 0.65, 2.6],    // blue
  rare: [2.6, 2.15, 0.25],     // yellow
  unique: [2.7, 1.05, 0.18],   // orange
  set: [0.22, 2.3, 0.42],      // green
};

export function resolveRarity(item) {
  const raw = String(item?.rarity ?? item?.quality ?? item?.tier ?? 'normal').toLowerCase();
  if (RARITY_COLOR[raw]) return raw;
  if (raw === 'common') return 'normal';
  if (raw === 'uncommon') return 'magic';
  if (raw === 'legendary' || raw === 'mythic' || raw === 'artifact') return 'unique';
  return 'normal';
}

export class LootBeams {
  constructor({ capacity = 24, height = 5.6, radius = 0.22 } = {}) {
    this.capacity = capacity;
    this._cursor = 0;
    this._active = 0;
    this._dirty = false;
    this._slots = new Array(capacity).fill(null); // { x,z, next-mote-timer }

    const shaftGeo = new THREE.CylinderGeometry(radius, radius * 1.15, height, 14, 1, true);
    shaftGeo.translate(0, height / 2, 0);
    const shaftData = new Float32Array(capacity * 4); // seed, spawnTime, r*, g* packed via aColor separately
    const shaftColor = new Float32Array(capacity * 3);
    shaftGeo.setAttribute('aData', new THREE.InstancedBufferAttribute(shaftData, 4));
    shaftGeo.setAttribute('aColor', new THREE.InstancedBufferAttribute(shaftColor, 3));
    this._shaftData = shaftData;
    this._shaftColor = shaftColor;

    const shaftMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */`
        precision highp float;
        attribute vec4 aData;
        attribute vec3 aColor;
        varying vec2 vUv;
        varying vec4 vData;
        varying vec3 vColor;
        void main() {
          vUv = uv;
          vData = aData;
          vColor = aColor;
          vec4 world = instanceMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform float uTime;
        varying vec2 vUv;
        varying vec4 vData;
        varying vec3 vColor;
        void main() {
          float seed = vData.x;
          float age = uTime - vData.y;
          if (age < 0.0) discard;
          float fadeIn = smoothstep(0.0, 0.5, age);

          // Vertical falloff: solid near the ground, tapering to a soft tip.
          float h = vUv.y;
          float vertical = (1.0 - smoothstep(0.15, 1.0, h)) * mix(0.35, 1.0, 1.0 - h);

          // Scrolling striations climbing the shaft -- the classic upward
          // "energy" read, plus a slow azimuthal shimmer so the cylinder
          // never looks like a static painted texture.
          float scroll = fract(h * 3.0 - uTime * 0.9 + seed * 7.0);
          float stripes = 0.55 + 0.45 * smoothstep(0.0, 0.5, scroll) * (1.0 - smoothstep(0.5, 1.0, scroll));
          float shimmer = 0.85 + 0.15 * sin(vUv.x * 26.0 + uTime * 2.3 + seed * 11.0);

          float alpha = vertical * stripes * shimmer * fadeIn;
          if (alpha <= 0.004) discard;
          gl_FragColor = vec4(vColor, alpha);
        }
      `,
    });
    this._shaft = new THREE.InstancedMesh(shaftGeo, shaftMat, capacity);
    this._shaft.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._shaft.frustumCulled = false;
    this._shaft.count = 0;
    this._shaft.raycast = () => {};

    // Ground glow disc: a flattened radial gradient sitting under the shaft.
    const discGeo = new THREE.CircleGeometry(1, 24);
    discGeo.rotateX(-Math.PI / 2);
    const discData = new Float32Array(capacity * 4);
    const discColor = new Float32Array(capacity * 3);
    discGeo.setAttribute('aData', new THREE.InstancedBufferAttribute(discData, 4));
    discGeo.setAttribute('aColor', new THREE.InstancedBufferAttribute(discColor, 3));
    this._discData = discData;
    this._discColor = discColor;

    const discMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */`
        precision highp float;
        attribute vec4 aData;
        attribute vec3 aColor;
        varying vec2 vUv;
        varying vec4 vData;
        varying vec3 vColor;
        void main() {
          vUv = uv;
          vData = aData;
          vColor = aColor;
          vec4 world = instanceMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform float uTime;
        varying vec2 vUv;
        varying vec4 vData;
        varying vec3 vColor;
        void main() {
          float seed = vData.x;
          float age = uTime - vData.y;
          if (age < 0.0) discard;
          float fadeIn = smoothstep(0.0, 0.5, age);
          vec2 c = (vUv - 0.5) * 2.0;
          float d = length(c);
          float pulse = 0.85 + 0.15 * sin(uTime * 2.6 + seed * 9.0);
          float alpha = smoothstep(1.0, 0.0, d) * pulse * fadeIn;
          if (alpha <= 0.004) discard;
          gl_FragColor = vec4(vColor, alpha * 0.9);
        }
      `,
    });
    this._disc = new THREE.InstancedMesh(discGeo, discMat, capacity);
    this._disc.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._disc.frustumCulled = false;
    this._disc.count = 0;
    this._disc.raycast = () => {};

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._noRot = new THREE.Quaternion();
    this._sclShaft = new THREE.Vector3(1, 1, 1);
    this._sclDisc = new THREE.Vector3();
  }

  get meshes() { return [this._shaft, this._disc]; }

  /**
   * @param {THREE.Vector3|{x,y,z}} position ground contact point
   * @param {string} rarity normal|magic|rare|unique|set
   * @param {number} t current fx clock
   */
  spawn(position, rarity, t) {
    const i = this._cursor;
    this._cursor = (this._cursor + 1) % this.capacity;
    this._active = Math.min(this.capacity, this._active + 1);
    this._dirty = true;

    const [r, g, b] = RARITY_COLOR[rarity] ?? RARITY_COLOR.normal;
    const seed = Math.random();
    const discRadius = 0.85;

    this._m.compose(position, this._noRot, this._sclShaft);
    this._shaft.setMatrixAt(i, this._m);
    this._shaftData[i * 4] = seed;
    this._shaftData[i * 4 + 1] = t;
    this._shaftColor[i * 3] = r;
    this._shaftColor[i * 3 + 1] = g;
    this._shaftColor[i * 3 + 2] = b;

    this._sclDisc.set(discRadius, 1, discRadius);
    this._m.compose(position, this._noRot, this._sclDisc);
    this._disc.setMatrixAt(i, this._m);
    this._discData[i * 4] = seed;
    this._discData[i * 4 + 1] = t;
    this._discColor[i * 3] = r;
    this._discColor[i * 3 + 1] = g;
    this._discColor[i * 3 + 2] = b;

    this._slots[i] = { x: position.x, y: position.y, z: position.z, r, g, b, nextMote: 0 };
    return i;
  }

  /**
   * Sparkle motes rising out of each active beam, fed into a shared glow
   * particle pool so this file never owns another draw call.
   */
  update(dt, t, emitMote) {
    this._shaft.material.uniforms.uTime.value = t;
    this._disc.material.uniforms.uTime.value = t;
    if (emitMote) {
      for (let i = 0; i < this._active; i++) {
        const s = this._slots[i];
        if (!s) continue;
        s.nextMote -= dt;
        if (s.nextMote <= 0) {
          s.nextMote = 0.12 + Math.random() * 0.16;
          emitMote(s, [s.r, s.g, s.b]);
        }
      }
    }
  }

  flush() {
    if (!this._dirty) return;
    this._dirty = false;
    this._shaft.instanceMatrix.needsUpdate = true;
    this._shaft.geometry.getAttribute('aData').needsUpdate = true;
    this._shaft.geometry.getAttribute('aColor').needsUpdate = true;
    this._shaft.count = this._active;

    this._disc.instanceMatrix.needsUpdate = true;
    this._disc.geometry.getAttribute('aData').needsUpdate = true;
    this._disc.geometry.getAttribute('aColor').needsUpdate = true;
    this._disc.count = this._active;
  }

  dispose() {
    this._shaft.geometry.dispose();
    this._shaft.material.dispose();
    this._disc.geometry.dispose();
    this._disc.material.dispose();
  }
}
