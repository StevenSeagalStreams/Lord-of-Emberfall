import * as THREE from 'three';

/**
 * Pooled floor decals: blood pools, scorch marks, frost patches.
 *
 * A single InstancedMesh, one draw call regardless of count. Spawning writes
 * an instance matrix (position/rotation/scale) plus one small custom instanced
 * attribute (seed, kind, spawnTime, life); fade-over-life is entirely a
 * fragment-shader function of `uTime`, so ageing costs nothing on the CPU.
 * Capacity is a hard ring buffer -- the oldest decal is silently recycled.
 */
export class Decals {
  constructor({ capacity = 220, camera }) {
    this.capacity = capacity;
    this._cursor = 0;
    this._active = 0;
    this._dirty = false;

    // Base quad: unit size in the XZ plane, facing +Y, centred at origin.
    const geo = new THREE.PlaneGeometry(1, 1, 1, 1);
    geo.rotateX(-Math.PI / 2);

    const data = new Float32Array(capacity * 4); // seed, kind, spawnTime, life
    const attr = new THREE.InstancedBufferAttribute(data, 4);
    geo.setAttribute('aData', attr);
    this._data = data;
    this._attr = attr;

    const mesh = new THREE.InstancedMesh(geo, this._buildMaterial(), capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    mesh.count = 0;
    this.mesh = mesh;

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._axis = new THREE.Vector3(0, 1, 0);
    this._scl = new THREE.Vector3();
  }

  _buildMaterial() {
    return new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */`
        precision highp float;
        attribute vec4 aData;
        varying vec2 vUv;
        varying vec4 vData;
        void main() {
          vUv = uv;
          vData = aData;
          vec4 worldPos = instanceMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform float uTime;
        varying vec2 vUv;
        varying vec4 vData;

        float hash(vec2 p) { return fract(sin(dot(p, vec2(41.7, 289.1))) * 43758.5453); }

        void main() {
          float seed = vData.x;
          float kind = vData.y;
          float age = uTime - vData.z;
          float life = max(0.001, vData.w);
          float lifeT = clamp(age / life, 0.0, 1.0);
          if (age < 0.0) discard;

          vec2 c = (vUv - 0.5) * 2.0;
          float ang = atan(c.y, c.x);
          float d = length(c);

          // Irregular torn-edge blob via a few angular harmonics, seeded per instance.
          float edge = 1.0
            + 0.28 * sin(ang * 3.0 + seed * 6.28)
            + 0.16 * sin(ang * 5.0 + seed * 11.3)
            + 0.10 * sin(ang * 9.0 + seed * 3.7);

          float fadeOut = 1.0 - smoothstep(0.65, 1.0, lifeT);
          float fadeIn = smoothstep(0.0, 0.06, lifeT);
          float body = smoothstep(edge, edge - 0.22, d);
          if (body <= 0.01) discard;

          vec3 color;
          float alpha;
          if (kind < 0.5) {
            // blood pool: dark maroon, darker rough rim, faint wet sheen near centre
            float rim = smoothstep(edge - 0.14, edge, d);
            vec3 base = mix(vec3(0.10, 0.010, 0.008), vec3(0.30, 0.02, 0.015), 1.0 - d);
            vec3 rimColor = vec3(0.05, 0.004, 0.003);
            color = mix(base, rimColor, rim);
            float speck = step(0.94, hash(floor(vUv * 18.0 + seed * 40.0)));
            color += speck * vec3(0.05, 0.0, 0.0);
            alpha = body * mix(0.85, 0.62, d) ;
          } else if (kind < 1.5) {
            // scorch mark: charred black with warm ash edge
            vec3 base = vec3(0.02, 0.018, 0.017);
            vec3 ash = vec3(0.12, 0.08, 0.05);
            color = mix(ash, base, smoothstep(0.0, 0.8, d));
            alpha = body * 0.72;
          } else {
            // frost patch: pale cold crystal, brighter core
            vec3 base = vec3(0.55, 0.72, 0.92);
            vec3 core = vec3(0.82, 0.92, 1.0);
            color = mix(base, core, 1.0 - d);
            float facet = 0.85 + 0.15 * sin(ang * 7.0 + seed * 5.0);
            color *= facet;
            alpha = body * 0.5;
          }

          gl_FragColor = vec4(color, alpha * fadeOut * fadeIn);
        }
      `,
    });
  }

  setTime(t) { this.mesh.material.uniforms.uTime.value = t; }

  /**
   * @param {THREE.Vector3} position world position (Y is the floor contact height)
   * @param {number} kind 0=blood 1=scorch 2=frost
   * @param {object} opts radius, rotation, life, seed
   */
  spawn(position, kind, opts = {}) {
    const i = this._cursor;
    this._cursor = (this._cursor + 1) % this.capacity;
    this._active = Math.min(this.capacity, this._active + 1);
    this._dirty = true;

    const radius = opts.radius ?? 0.6;
    this._scl.set(radius, 1, radius);
    this._q.setFromAxisAngle(this._axis, opts.rotation ?? Math.random() * Math.PI * 2);
    this._m.compose(position, this._q, this._scl);
    this.mesh.setMatrixAt(i, this._m);

    this._data[i * 4] = opts.seed ?? Math.random();
    this._data[i * 4 + 1] = kind;
    this._data[i * 4 + 2] = opts.time ?? 0;
    this._data[i * 4 + 3] = opts.life ?? 25;

    return i;
  }

  flush() {
    if (!this._dirty) return;
    this._dirty = false;
    this.mesh.instanceMatrix.needsUpdate = true;
    this._attr.needsUpdate = true;
    this.mesh.count = this._active;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
