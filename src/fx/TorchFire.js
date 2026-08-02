import * as THREE from 'three';

/**
 * Visible flame sprites for `scene.userData.flameRequests`.
 *
 * The catacombs place `TorchLight`s (a real point light) and separately
 * publish where a *visible* flame should go, because the light and its
 * source are this pillar's job, not lighting's. One `THREE.Points` draw call
 * covers every torch in the level -- each flame is a single point sprite,
 * camera-facing by construction, animated entirely in-shader from `uTime`
 * plus a per-instance phase seed so no two torches flicker in lockstep.
 * Positions are written once per flame request and never touched again.
 */
export class TorchFire {
  constructor({ capacity = 160 } = {}) {
    this.capacity = capacity;
    this._count = 0;

    const geo = new THREE.BufferGeometry();
    const position = new Float32Array(capacity * 3);
    const seed = new Float32Array(capacity);
    const tint = new Float32Array(capacity * 3);
    const scale = new Float32Array(capacity);
    geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geo.setAttribute('aTint', new THREE.BufferAttribute(tint, 3));
    geo.setAttribute('aScale', new THREE.BufferAttribute(scale, 1));
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this._position = position;
    this._seed = seed;
    this._tint = tint;
    this._scale = scale;
    this.geometry = geo;

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uViewportHeight: { value: 800 },
      },
      vertexShader: /* glsl */`
        precision highp float;
        attribute float aSeed;
        attribute vec3 aTint;
        attribute float aScale;
        uniform float uTime;
        uniform float uViewportHeight;
        varying float vSeed;
        varying vec3 vTint;
        void main() {
          vSeed = aSeed;
          vTint = aTint;
          // Gentle vertical bob + width breathing so the flame reads alive
          // even before the fragment-level flicker.
          float bob = sin(uTime * 3.1 + aSeed * 17.0) * 0.03;
          vec3 p = position + vec3(0.0, bob, 0.0);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          float breathe = 1.0 + 0.12 * sin(uTime * 5.3 + aSeed * 23.0);
          float pixelScale = uViewportHeight * 0.5 * projectionMatrix[1][1];
          gl_PointSize = clamp(aScale * breathe * pixelScale / max(0.001, -mv.z), 0.0, 400.0);
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform float uTime;
        varying float vSeed;
        varying vec3 vTint;

        float hash(float n) { return fract(sin(n) * 43758.5453); }

        void main() {
          // gl_PointCoord: (0,0) top-left -> (1,1) bottom-right. Flip so
          // ty=1 is the flame's hot base and ty=0 is its tapering tip.
          vec2 uv = gl_PointCoord;
          float ty = 1.0 - uv.y;
          float dx = (uv.x - 0.5) * 2.0;

          float flick = sin(uTime * 9.0 + vSeed * 31.0) * 0.5 + sin(uTime * 21.0 + vSeed * 7.0) * 0.25;
          float lean = flick * 0.18 * ty;
          float width = mix(0.16, 0.62, ty) - 0.35 * pow(ty, 2.2);
          float body = smoothstep(width, width * 0.35, abs(dx - lean));
          float taper = smoothstep(0.0, 0.12, ty) * smoothstep(1.05, 0.55, ty);
          float shapeAlpha = body * taper;
          if (shapeAlpha <= 0.01) discard;

          vec3 hot = vec3(4.2, 3.0, 1.1) * vTint;
          vec3 mid = vec3(3.0, 1.1, 0.15) * vTint;
          vec3 cool = vec3(0.9, 0.15, 0.05) * vTint;
          vec3 color = mix(cool, mid, smoothstep(0.0, 0.55, ty));
          color = mix(color, hot, smoothstep(0.55, 1.0, ty));

          float alpha = shapeAlpha * (0.75 + 0.25 * flick);
          gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
        }
      `,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
    this.points.raycast = () => {};

    this._nextEmber = new Float32Array(capacity);
    this._flameKind = [];
  }

  setViewport(h) { this.material.uniforms.uViewportHeight.value = h; }

  /**
   * @param {THREE.Vector3|{x,y,z}} position
   * @param {'torch'|'magic'} kind
   * @returns {number} flame index, or -1 if the pool is full
   */
  addFlame(position, kind = 'torch') {
    if (this._count >= this.capacity) return -1;
    const i = this._count++;
    this._position[i * 3] = position.x;
    this._position[i * 3 + 1] = position.y;
    this._position[i * 3 + 2] = position.z;
    this._seed[i] = Math.random() * 100;
    this._scale[i] = 0.55 + Math.random() * 0.15;
    const magic = kind === 'magic';
    this._tint[i * 3] = magic ? 0.35 : 1.0;
    this._tint[i * 3 + 1] = magic ? 0.55 : 1.0;
    this._tint[i * 3 + 2] = magic ? 1.3 : 1.0;
    this.geometry.setDrawRange(0, this._count);
    for (const attr of ['position', 'aSeed', 'aTint', 'aScale']) {
      this.geometry.getAttribute(attr).needsUpdate = true;
    }
    this._nextEmber[i] = Math.random() * 0.6;
    this._flameKind[i] = kind;
    return i;
  }

  /** World position of flame `i`, for ember spawning. */
  flamePosition(i, out) {
    out.set(this._position[i * 3], this._position[i * 3 + 1] + 0.15, this._position[i * 3 + 2]);
    return out;
  }

  get count() { return this._count; }
  kindOf(i) { return this._flameKind[i]; }

  /**
   * Advance the flame clock and, for each live torch, decide whether it is
   * due to kick off an ember -- callers pass a spawn callback so this file
   * never owns the ember particle pool (one fewer draw call).
   */
  update(dt, t, emitEmber) {
    this.material.uniforms.uTime.value = t;
    if (!emitEmber) return;
    const tmp = _tmpVec;
    for (let i = 0; i < this._count; i++) {
      this._nextEmber[i] -= dt;
      if (this._nextEmber[i] <= 0) {
        this._nextEmber[i] = 0.5 + Math.random() * 0.9;
        this.flamePosition(i, tmp);
        emitEmber(tmp, this._flameKind[i]);
      }
    }
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

const _tmpVec = new THREE.Vector3();
