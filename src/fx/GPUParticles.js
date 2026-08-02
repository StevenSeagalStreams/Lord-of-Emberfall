import * as THREE from 'three';

/**
 * Pooled GPU particle emitter.
 *
 * One `THREE.Points` draw call per instance, capacity fixed at construction.
 * Spawning writes a handful of attributes for the recycled slot; everything
 * else -- position integration (velocity + gravity + drag), size-over-life,
 * colour-over-life, rotation -- happens in the vertex/fragment shader driven
 * by a single running `uTime` uniform. The CPU never touches per-particle
 * state after spawn, so thousands of live particles cost one small uniform
 * update per frame plus the (rare) attribute re-upload when new ones spawn.
 *
 * Recycling is a ring buffer: spawning a particle when the pool is full
 * silently retires the oldest one. That is the correct trade-off for cosmetic
 * fx under a hard cap -- never allocate, never grow.
 */
export class GPUParticles {
  /**
   * @param {object} opts
   * @param {number} opts.capacity
   * @param {'soft'|'spark'|'glow'|'shard'} opts.shape fragment silhouette
   * @param {number} opts.blending THREE.AdditiveBlending | THREE.NormalBlending
   * @param {[number,number,number,number][]} opts.gradient color-over-life stops: [t, r, g, b] (r,g,b may exceed 1 for bloom)
   * @param {[number,number][]} [opts.alphaGradient] alpha-over-life stops: [t, a]
   * @param {boolean} [opts.soft] enable depth-fade against scene geometry
   * @param {THREE.Texture|null} [opts.depthTexture]
   * @param {THREE.Camera} [opts.camera]
   */
  constructor(opts) {
    this.capacity = opts.capacity;
    this.camera = opts.camera;
    this._cursor = 0;
    this._dirty = false;
    this._active = 0; // highwater mark, so we don't draw unused tail slots

    const geo = new THREE.BufferGeometry();
    const N = this.capacity;
    const position = new Float32Array(N * 3);   // spawn position
    const velocity = new Float32Array(N * 3);   // initial velocity
    const spawnLife = new Float32Array(N * 2);  // spawnTime, life
    const size = new Float32Array(N * 2);       // start, end
    const rot = new Float32Array(N * 2);        // rot0, rotSpeed
    const dyn = new Float32Array(N * 2);        // gravity, drag
    const tint = new Float32Array(N * 3);       // per-particle colour multiplier
    const seed = new Float32Array(N);

    geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geo.setAttribute('aVelocity', new THREE.BufferAttribute(velocity, 3));
    geo.setAttribute('aSpawnLife', new THREE.BufferAttribute(spawnLife, 2));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 2));
    geo.setAttribute('aRot', new THREE.BufferAttribute(rot, 2));
    geo.setAttribute('aDyn', new THREE.BufferAttribute(dyn, 2));
    geo.setAttribute('aTint', new THREE.BufferAttribute(tint, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = geo;

    const gradTex = buildGradientTexture(opts.gradient, opts.alphaGradient);

    const shapeDefine = { soft: 0, spark: 1, glow: 2, shard: 3 }[opts.shape ?? 'soft'];

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uViewportHeight: { value: 800 },
        uGradient: { value: gradTex },
        uSoft: { value: opts.soft ? 1 : 0 },
        uSoftDistance: { value: opts.softDistance ?? 0.6 },
        uSceneDepth: { value: opts.depthTexture ?? null },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uCameraNear: { value: 1 },
        uCameraFar: { value: 400 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: opts.blending ?? THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        precision highp float;
        attribute vec3 aVelocity;
        attribute vec2 aSpawnLife;
        attribute vec2 aSize;
        attribute vec2 aRot;
        attribute vec2 aDyn;
        attribute vec3 aTint;
        attribute float aSeed;

        uniform float uTime;
        uniform float uViewportHeight;

        varying float vLifeT;
        varying float vAlive;
        varying vec3 vTint;
        varying float vRotation;
        varying float vSeed;
        varying float vViewZ;

        void main() {
          float age = uTime - aSpawnLife.x;
          float life = max(0.0001, aSpawnLife.y);
          float lifeT = clamp(age / life, 0.0, 1.0);
          vAlive = (age < 0.0 || age > life) ? 0.0 : 1.0;
          vLifeT = lifeT;
          vTint = aTint;
          vSeed = aSeed;

          float gravity = aDyn.x;
          float drag = aDyn.y;
          vec3 dragOffset = drag > 0.0001
            ? aVelocity * (1.0 - exp(-drag * age)) / drag
            : aVelocity * age;
          vec3 gravOffset = vec3(0.0, -0.5 * gravity * age * age, 0.0);
          vec3 worldPos = position + dragOffset + gravOffset;

          vRotation = aRot.x + aRot.y * age;

          vec4 mvPosition = modelViewMatrix * vec4(worldPos, 1.0);
          vViewZ = mvPosition.z;
          gl_Position = projectionMatrix * mvPosition;

          float sizeT = smoothstep(0.0, 1.0, lifeT);
          float size = mix(aSize.x, aSize.y, sizeT);
          float pixelScale = uViewportHeight * 0.5 * projectionMatrix[1][1];
          float psize = size * pixelScale / max(0.001, -mvPosition.z);
          gl_PointSize = vAlive > 0.5 ? clamp(psize, 0.0, 512.0) : 0.0;
          if (vAlive < 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D uGradient;
        uniform float uSoft;
        uniform float uSoftDistance;
        uniform sampler2D uSceneDepth;
        uniform vec2 uResolution;
        uniform float uCameraNear;
        uniform float uCameraFar;

        varying float vLifeT;
        varying float vAlive;
        varying vec3 vTint;
        varying float vRotation;
        varying float vSeed;
        varying float vViewZ;

        float linearDepth(float ndcZ) {
          float z = ndcZ * 2.0 - 1.0;
          return (2.0 * uCameraNear * uCameraFar) / (uCameraFar + uCameraNear - z * (uCameraFar - uCameraNear));
        }

        void main() {
          if (vAlive < 0.5) discard;
          vec2 c = gl_PointCoord * 2.0 - 1.0;
          float s = sin(vRotation), co = cos(vRotation);
          vec2 rc = vec2(c.x * co - c.y * s, c.x * s + c.y * co);

          float shapeAlpha;
          #if SHAPE_KIND == 1
            // spark: stretched streak with a hot core
            vec2 sc = vec2(rc.x, rc.y * 3.2);
            float d = length(sc);
            shapeAlpha = smoothstep(1.0, 0.0, d) * smoothstep(1.3, 0.0, abs(rc.x) * 2.2);
          #elif SHAPE_KIND == 2
            // glow: hot compact core, soft skirt
            float d = length(rc);
            shapeAlpha = pow(smoothstep(1.0, 0.0, d), 1.6);
          #elif SHAPE_KIND == 3
            // shard: crisp diamond
            float d = abs(rc.x) + abs(rc.y);
            shapeAlpha = step(d, 0.9) * (1.0 - smoothstep(0.55, 0.9, d) * 0.4);
          #else
            // soft: gaussian-ish blob
            float d = length(rc);
            shapeAlpha = smoothstep(1.0, 0.0, d);
            shapeAlpha *= shapeAlpha;
          #endif

          if (shapeAlpha <= 0.001) discard;

          vec4 grad = texture2D(uGradient, vec2(vLifeT, 0.5));
          vec3 color = grad.rgb * vTint;
          float alpha = grad.a * shapeAlpha;

          if (uSoft > 0.5) {
            vec2 uv = gl_FragCoord.xy / uResolution;
            float sceneNdc = texture2D(uSceneDepth, uv).x;
            float sceneZ = linearDepth(sceneNdc);
            float partZ = -vViewZ;
            float fade = clamp((sceneZ - partZ) / uSoftDistance, 0.0, 1.0);
            alpha *= fade;
          }

          if (alpha <= 0.003) discard;
          gl_FragColor = vec4(color, alpha);
        }
      `,
      defines: { SHAPE_KIND: shapeDefine },
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = opts.renderOrder ?? 5;

    this._attrPosition = position;
    this._attrVelocity = velocity;
    this._attrSpawnLife = spawnLife;
    this._attrSize = size;
    this._attrRot = rot;
    this._attrDyn = dyn;
    this._attrTint = tint;
    this._attrSeed = seed;
  }

  /** Absolute simulation clock (seconds). Call once per frame before emit(). */
  setTime(t) {
    this.material.uniforms.uTime.value = t;
    this._time = t;
  }

  setViewport(h) { this.material.uniforms.uViewportHeight.value = h; }
  setResolution(w, h) { this.material.uniforms.uResolution.value.set(w, h); }
  setCameraPlanes(near, far) {
    this.material.uniforms.uCameraNear.value = near;
    this.material.uniforms.uCameraFar.value = far;
  }

  /**
   * Allocate one particle slot and write its attributes. Returns the index.
   * `t` is the current simulation clock (must match setTime for this frame).
   */
  spawn(t, {
    position, velocity, life, sizeStart, sizeEnd,
    rot0 = 0, rotSpeed = 0, gravity = 0, drag = 0, tint = WHITE, seed = Math.random(),
  }) {
    const i = this._cursor;
    this._cursor = (this._cursor + 1) % this.capacity;
    this._active = Math.min(this.capacity, this._active + 1);
    this._dirty = true;

    this._attrPosition[i * 3] = position.x;
    this._attrPosition[i * 3 + 1] = position.y;
    this._attrPosition[i * 3 + 2] = position.z;

    this._attrVelocity[i * 3] = velocity.x;
    this._attrVelocity[i * 3 + 1] = velocity.y;
    this._attrVelocity[i * 3 + 2] = velocity.z;

    this._attrSpawnLife[i * 2] = t;
    this._attrSpawnLife[i * 2 + 1] = life;

    this._attrSize[i * 2] = sizeStart;
    this._attrSize[i * 2 + 1] = sizeEnd;

    this._attrRot[i * 2] = rot0;
    this._attrRot[i * 2 + 1] = rotSpeed;

    this._attrDyn[i * 2] = gravity;
    this._attrDyn[i * 2 + 1] = drag;

    this._attrTint[i * 3] = tint.r ?? tint[0] ?? 1;
    this._attrTint[i * 3 + 1] = tint.g ?? tint[1] ?? 1;
    this._attrTint[i * 3 + 2] = tint.b ?? tint[2] ?? 1;

    this._attrSeed[i] = seed;

    return i;
  }

  /** Push dirty attribute ranges to the GPU. Cheap: only runs when something spawned. */
  flush() {
    if (!this._dirty) return;
    this._dirty = false;
    const geo = this.geometry;
    for (const name of ['position', 'aVelocity', 'aSpawnLife', 'aSize', 'aRot', 'aDyn', 'aTint', 'aSeed']) {
      geo.getAttribute(name).needsUpdate = true;
    }
    geo.setDrawRange(0, this._active);
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.material.uniforms.uGradient.value?.dispose?.();
  }
}

const WHITE = { r: 1, g: 1, b: 1 };

/** RGBA ramp sampled by fragment shader for colour+alpha-over-life. Values may exceed 1 for HDR bloom. */
function buildGradientTexture(colorStops, alphaStops) {
  const W = 32;
  const data = new Float32Array(W * 4);
  const stops = colorStops && colorStops.length ? colorStops : [[0, 1, 1, 1], [1, 1, 1, 1]];
  const aStops = alphaStops && alphaStops.length ? alphaStops : [[0, 1], [1, 0]];
  for (let i = 0; i < W; i++) {
    const t = i / (W - 1);
    const [r, g, b] = sampleStops(stops, t);
    const a = sampleStops1(aStops, t);
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = a;
  }
  const tex = new THREE.DataTexture(data, W, 1, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

function sampleStops(stops, t) {
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i], b = stops[i + 1];
    if (t >= a[0] && t <= b[0]) {
      const u = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
      return [
        a[1] + (b[1] - a[1]) * u,
        a[2] + (b[2] - a[2]) * u,
        a[3] + (b[3] - a[3]) * u,
      ];
    }
  }
  const last = stops[stops.length - 1];
  return [last[1], last[2], last[3]];
}

function sampleStops1(stops, t) {
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i], b = stops[i + 1];
    if (t >= a[0] && t <= b[0]) {
      const u = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
      return a[1] + (b[1] - a[1]) * u;
    }
  }
  return stops[stops.length - 1][1];
}

// ---------------------------------------------------------------------------
// emission shape helpers -- fill a position+direction pair relative to origin
// ---------------------------------------------------------------------------

const _dir = new THREE.Vector3();

/**
 * @param {'point'|'disc'|'sphere'|'cone'|'box'} shape
 * @param {object} p params: radius, size(Vector3), axis(Vector3), angle(radians half-spread)
 * @param {import('../core/RNG.js').RNG} rng
 * @param {THREE.Vector3} outPos relative offset from origin
 * @param {THREE.Vector3} outDir unit direction (emission bias)
 */
export function sampleEmissionShape(shape, p, rng, outPos, outDir) {
  const axis = p.axis ?? UP;
  switch (shape) {
    case 'disc': {
      const [dx, dz] = rng.disc();
      const r = (p.radius ?? 1);
      outPos.set(dx * r, 0, dz * r);
      alignToAxis(outPos, axis);
      outDir.copy(axis);
      return;
    }
    case 'sphere': {
      const r = p.radius ?? 1;
      const u = rng.range(-1, 1);
      const th = rng.range(0, Math.PI * 2);
      const s = Math.sqrt(Math.max(0, 1 - u * u));
      outDir.set(s * Math.cos(th), u, s * Math.sin(th));
      outPos.copy(outDir).multiplyScalar(r * (p.surfaceOnly ? 1 : Math.cbrt(rng.next())));
      return;
    }
    case 'cone': {
      const half = p.angle ?? Math.PI / 6;
      const th = rng.range(0, Math.PI * 2);
      const cosA = rng.range(Math.cos(half), 1);
      const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
      _dir.set(sinA * Math.cos(th), cosA, sinA * Math.sin(th));
      rotateFromUpTo(_dir, axis);
      outDir.copy(_dir);
      outPos.set(0, 0, 0);
      return;
    }
    case 'box': {
      const s = p.size ?? { x: 1, y: 1, z: 1 };
      outPos.set(rng.range(-s.x, s.x), rng.range(-s.y, s.y), rng.range(-s.z, s.z));
      outDir.copy(axis);
      return;
    }
    case 'point':
    default: {
      outPos.set(0, 0, 0);
      outDir.copy(axis);
      return;
    }
  }
}

const UP = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();

function alignToAxis(v, axis) {
  if (axis === UP || (axis.x === 0 && axis.y === 1 && axis.z === 0)) return;
  _q.setFromUnitVectors(UP, axis);
  v.applyQuaternion(_q);
}

function rotateFromUpTo(v, axis) {
  if (axis.x === 0 && axis.y === 1 && axis.z === 0) return;
  _q.setFromUnitVectors(UP, axis);
  v.applyQuaternion(_q);
}
