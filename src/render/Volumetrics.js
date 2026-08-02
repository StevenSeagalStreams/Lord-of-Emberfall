import * as THREE from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

/**
 * Screen-space god rays + height-based ground fog, combined into one pass so
 * outdoor zones pay for a single extra full-screen shader instead of two.
 *
 * God rays: the classic GPU Gems 3 "volumetric light scattering as a
 * post-process" radial blur, keyed off bright pixels (the sun disc rendered
 * by Sky.js, which is deliberately > 1.0 radiance) so shafts only ever
 * emanate from the sun/sky, not from arbitrary bright geometry.
 *
 * Height fog: reconstructs world position from a dedicated depth prepass
 * (PostFX owns it, excluding the sky dome so distant sky is never mistakenly
 * fogged) and fogs more heavily the lower a fragment sits below `fogHeight`,
 * which is what makes fog pool in terrain hollows and thin out on ridges
 * instead of sitting as a uniform haze (the failure mode of plain FogExp2).
 *
 * Inert (and effectively free) when `sun.z` / `fogDensity` are zero, which is
 * how dungeon zones -- no envLight registered -- opt out without a branch in
 * the game loop.
 */
const NUM_SAMPLES = 48;

const VolumetricsShader = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    cameraNear: { value: 0.1 },
    cameraFar: { value: 400 },
    projectionMatrixInverse: { value: new THREE.Matrix4() },
    viewMatrixInverse: { value: new THREE.Matrix4() },
    cameraPos: { value: new THREE.Vector3() },
    sunScreenPos: { value: new THREE.Vector3(0.5, 0.5, 0) }, // xy uv, z = visibility
    godrayStrength: { value: 0.0 },
    fogColor: { value: new THREE.Color(0x39423f) },
    fogHeight: { value: 0.0 },
    fogFalloff: { value: 0.12 },
    fogDensity: { value: 0.0 },
    time: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    precision highp float;
    #define NUM_SAMPLES ${NUM_SAMPLES}
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform float cameraNear, cameraFar;
    uniform mat4 projectionMatrixInverse, viewMatrixInverse;
    uniform vec3 cameraPos;
    uniform vec3 sunScreenPos;
    uniform float godrayStrength;
    uniform vec3 fogColor;
    uniform float fogHeight, fogFalloff, fogDensity, time;
    varying vec2 vUv;

    vec3 worldPosFromDepth(vec2 uv, float depth) {
      vec4 ndc = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
      vec4 viewPos = projectionMatrixInverse * ndc;
      viewPos /= viewPos.w;
      vec4 worldPos = viewMatrixInverse * viewPos;
      return worldPos.xyz;
    }

    void main() {
      vec2 uv = vUv;
      vec3 color = texture2D(tDiffuse, uv).rgb;

      // ---- screen-space god rays -------------------------------------
      if (godrayStrength > 0.0001 && sunScreenPos.z > 0.5) {
        vec2 sunUv = sunScreenPos.xy;
        vec2 deltaUv = (uv - sunUv) * (1.0 / float(NUM_SAMPLES)) * 0.92;
        vec2 sampleUv = uv;
        float illum = 1.0;
        vec3 accum = vec3(0.0);
        for (int i = 0; i < NUM_SAMPLES; i++) {
          sampleUv -= deltaUv;
          vec3 s = texture2D(tDiffuse, sampleUv).rgb;
          float lum = dot(s, vec3(0.2126, 0.7152, 0.0722));
          float bright = max(lum - 0.85, 0.0);
          accum += s * bright * illum;
          illum *= 0.982;
        }
        accum *= godrayStrength / float(NUM_SAMPLES) * 2.4;
        float edgeFade = smoothstep(1.4, 0.3, length(uv - sunUv));
        color += accum * mix(0.4, 1.0, edgeFade);
      }

      // ---- height fog ---------------------------------------------------
      float depth = texture2D(tDepth, uv).x;
      if (fogDensity > 0.0001 && depth < 0.9999) {
        vec3 wp = worldPosFromDepth(uv, depth);
        float dist = distance(wp, cameraPos);
        float below = max(fogHeight - wp.y, 0.0);
        float amount = 1.0 - exp(-below * fogFalloff - dist * fogDensity);
        // Capped well under 1.0: this is a pooling accent on top of the
        // scene's own distance fog, never a second full whiteout layer.
        amount = clamp(amount, 0.0, 0.6);
        color = mix(color, fogColor, amount);
      }

      gl_FragColor = vec4(max(color, 0.0), 1.0);
    }
  `,
};

export class VolumetricsPass extends ShaderPass {
  constructor() {
    super(VolumetricsShader);
    this.needsSwap = true;
  }

  setDepthTexture(tex) { this.uniforms.tDepth.value = tex; }

  updateCamera(camera) {
    this.uniforms.cameraNear.value = camera.near;
    this.uniforms.cameraFar.value = camera.far;
    this.uniforms.projectionMatrixInverse.value.copy(camera.projectionMatrixInverse);
    this.uniforms.viewMatrixInverse.value.copy(camera.matrixWorld);
    this.uniforms.cameraPos.value.copy(camera.position);
  }

  /** @param sunUv {x,y} in [0,1] screen space, or null if the sun is behind camera / absent */
  setSun(sunUv, strength) {
    if (sunUv) this.uniforms.sunScreenPos.value.set(sunUv.x, sunUv.y, 1);
    else this.uniforms.sunScreenPos.value.z = 0;
    this.uniforms.godrayStrength.value = strength ?? 0;
  }

  setFog({ color, height, falloff, density } = {}) {
    if (color !== undefined) this.uniforms.fogColor.value.set(color);
    if (height !== undefined) this.uniforms.fogHeight.value = height;
    if (falloff !== undefined) this.uniforms.fogFalloff.value = falloff;
    if (density !== undefined) this.uniforms.fogDensity.value = density;
  }

  disableAll() {
    this.uniforms.godrayStrength.value = 0;
    this.uniforms.fogDensity.value = 0;
  }

  update(dt) { this.uniforms.time.value += dt; }
}
