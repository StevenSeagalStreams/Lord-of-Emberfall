import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { VolumetricsPass } from './Volumetrics.js';

/**
 * The grade pass. This is where the game gets its face.
 *
 * The chain renders scene-referred HDR, so bloom can threshold on real
 * radiance (only emissive fire and spell cores exceed 1.0) rather than on
 * arbitrary bright pixels. This pass then does the display transform:
 *
 *   exposure -> ACES filmic -> lift/gamma/gain -> shadow tint -> saturation
 *   -> vignette -> chromatic aberration -> film grain
 *
 * Output stays linear; OutputPass owns the sRGB encode.
 */
const GradeShader = {
  uniforms: {
    tDiffuse:        { value: null },
    exposure:        { value: 1.30 },
    contrast:        { value: 1.06 },
    saturation:      { value: 1.02 },
    lift:            { value: new THREE.Vector3(0.008, 0.010, 0.018) },
    gain:            { value: new THREE.Vector3(1.02, 1.00, 0.96) },
    shadowTint:      { value: new THREE.Vector3(0.28, 0.38, 0.62) },
    shadowTintAmt:   { value: 0.16 },
    highlightTint:   { value: new THREE.Vector3(1.00, 0.86, 0.62) },
    highlightAmt:    { value: 0.10 },
    vignette:        { value: 0.62 },
    vignetteSoft:    { value: 0.52 },
    aberration:      { value: 0.0016 },
    grain:           { value: 0.032 },
    time:            { value: 0 },
    resolution:      { value: new THREE.Vector2(1, 1) },
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
    uniform sampler2D tDiffuse;
    uniform float exposure, contrast, saturation;
    uniform vec3  lift, gain, shadowTint, highlightTint;
    uniform float shadowTintAmt, highlightAmt;
    uniform float vignette, vignetteSoft, aberration, grain, time;
    uniform vec2  resolution;
    varying vec2 vUv;

    // ACES filmic tone mapping, Stephen Hill's fit of the RRT+ODT.
    const mat3 ACESInput = mat3(
      0.59719, 0.07600, 0.02840,
      0.35458, 0.90834, 0.13383,
      0.04823, 0.01566, 0.83777
    );
    const mat3 ACESOutput = mat3(
       1.60475, -0.10208, -0.00327,
      -0.53108,  1.10813, -0.07276,
      -0.07367, -0.00605,  1.07602
    );

    vec3 RRTAndODTFit(vec3 v) {
      vec3 a = v * (v + 0.0245786) - 0.000090537;
      vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
      return a / b;
    }

    vec3 ACESFitted(vec3 color) {
      color = ACESInput * color;
      color = RRTAndODTFit(color);
      color = ACESOutput * color;
      return clamp(color, 0.0, 1.0);
    }

    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

    // Interleaved-gradient noise: cheap, temporally stable per-frame, and it
    // dithers banding in the dark falloff of torchlight where 8-bit output
    // would otherwise show rings.
    float ign(vec2 p) {
      return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
    }

    void main() {
      vec2 uv = vUv;
      vec2 center = uv - 0.5;
      float r2 = dot(center, center);

      // Lateral chromatic aberration: scales with radius, so the frame centre
      // stays clean and only the extreme edges fringe.
      vec3 color;
      if (aberration > 0.0) {
        vec2 dir = center * aberration * (0.35 + r2 * 2.4);
        color.r = texture2D(tDiffuse, uv + dir).r;
        color.g = texture2D(tDiffuse, uv).g;
        color.b = texture2D(tDiffuse, uv - dir).b;
      } else {
        color = texture2D(tDiffuse, uv).rgb;
      }

      color *= exposure;
      color = ACESFitted(color);

      // lift / gain, then contrast pivoted at mid grey
      color = color * gain + lift * (1.0 - color);
      color = (color - 0.18) * contrast + 0.18;
      color = max(color, 0.0);

      // split tone: cool the shadows, warm the highlights. This single step
      // does more for the gothic mood than any amount of texture detail.
      float l = luma(color);
      float sMask = pow(1.0 - clamp(l * 1.6, 0.0, 1.0), 2.0);
      float hMask = pow(clamp(l * 1.25 - 0.25, 0.0, 1.0), 1.5);
      color = mix(color, color * shadowTint * 2.0, sMask * shadowTintAmt);
      color = mix(color, color * highlightTint, hMask * highlightAmt);

      color = mix(vec3(luma(color)), color, saturation);

      // vignette
      float v = smoothstep(vignette, vignette - vignetteSoft, sqrt(r2));
      color *= mix(1.0, v, 0.85);

      // film grain, scaled down in highlights the way real emulsion behaves
      float n = ign(gl_FragCoord.xy + fract(time * 60.0) * 137.0) - 0.5;
      color += n * grain * (0.35 + 0.65 * (1.0 - luma(color)));

      gl_FragColor = vec4(max(color, 0.0), 1.0);
    }
  `,
};

export class PostFX {
  constructor(renderer, scene, camera, quality = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());

    this.composer = new EffectComposer(renderer);
    this.composer.setSize(size.x, size.y);

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    // --- ambient occlusion -------------------------------------------------
    // GTAO's own g-buffer prepass (depth + view-space normals) is reused by
    // the Volumetrics pass below for height fog, so outdoor zones do not pay
    // for a second full-scene depth render.
    //
    // screenSpaceRadius:true keeps the AO kernel a constant *pixel* footprint
    // rather than a fixed world-space radius. A fixed world-space radius over
    // a huge, nearly coplanar outdoor ground plane viewed from far away (a
    // survey/establishing shot) subtends a wildly different number of samples
    // than it does close-up, and on this engine's flat placeholder terrain
    // that mismatch was crushing the whole far shot toward black -- a screen-
    // space radius degrades gracefully with distance instead.
    this.gtao = new GTAOPass(scene, camera, size.x, size.y);
    this.gtao.output = GTAOPass.OUTPUT.Default;
    this.gtao.blendIntensity = 0.8;
    this.gtao.updateGtaoMaterial({
      radius: 0.5,
      distanceExponent: 1.6,
      thickness: 0.55,
      scale: 1.0,
      samples: 16,
      distanceFallOff: 1.0,
      screenSpaceRadius: true,
    });
    this.gtao.enabled = quality.ssao !== false;
    this.composer.addPass(this.gtao);

    // --- volumetrics: god rays + height fog ---------------------------------
    // Free (and disabled) on dungeon zones, which never publish
    // scene.userData.envLight -- see Lighting.applyRig / Volumetrics.js.
    this.volumetrics = new VolumetricsPass();
    this.volumetrics.enabled = quality.volumetrics !== false;
    this.composer.addPass(this.volumetrics);

    // --- bloom -------------------------------------------------------------
    // threshold > 1.0 makes this physically selective: only emitters that
    // actually exceed white (fire, spell cores, the sun disc) bloom. Kept
    // tight (small radius, modest strength) so it reads as hot cores, not a
    // haze over the whole frame.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.55, 0.42, 1.05);
    this.bloom.enabled = quality.bloom !== false;
    this.composer.addPass(this.bloom);

    // --- grade -------------------------------------------------------------
    this.grade = new ShaderPass(GradeShader);
    this.grade.uniforms.resolution.value.set(size.x, size.y);
    if (quality.grain === false) this.grade.uniforms.grain.value = 0;
    this.composer.addPass(this.grade);

    this.output = new OutputPass();
    this.composer.addPass(this.output);

    this.smaa = new SMAAPass(size.x, size.y);
    this.composer.addPass(this.smaa);

    this._time = 0;
    this._sunWorld = new THREE.Vector3();
    this._sunClip = new THREE.Vector4();
    // See _applyExposureFloor: tracks which Lighting.applyRig publish we have
    // already reacted to, so the floor engages once per zone entry rather
    // than fighting a transient setExposure every frame.
    this._exposureFloorRevision = -1;
  }

  /** Push transient looks: hit flashes, low-health desaturation, level intros. */
  setExposure(v) { this.grade.uniforms.exposure.value = v; }
  setSaturation(v) { this.grade.uniforms.saturation.value = v; }
  setVignette(v) { this.grade.uniforms.vignette.value = v; }

  /** Apply Lighting's outdoor exposure floor (scene.userData.envLight.
   *  exposureFloor -- see the extensive comment on MIN_OUTDOOR_EXPOSURE in
   *  Lighting.js) exactly once per zone entry, identified by the envLight
   *  object's `_revision` stamp. Only ever raises the current exposure
   *  uniform, and only reacts to a *new* revision, so it never re-stomps a
   *  transient look (`setExposure` from a hit flash, low-health vignette,
   *  etc.) applied after zone entry. */
  _applyExposureFloor() {
    const env = this.scene.userData.envLight;
    if (!env || env.exposureFloor === undefined) return;
    if (env._revision === this._exposureFloorRevision) return;
    this._exposureFloorRevision = env._revision;
    if (this.grade.uniforms.exposure.value < env.exposureFloor) {
      this.grade.uniforms.exposure.value = env.exposureFloor;
    }
  }

  /** Feed the Volumetrics pass from whatever Lighting last published. Reads
   *  scene.userData rather than taking a direct reference so main.js never
   *  needs to wire Lighting and PostFX together. */
  _updateVolumetrics() {
    const env = this.scene.userData.envLight;
    if (!env || !this.volumetrics.enabled) {
      this.volumetrics.disableAll();
      return;
    }

    this.volumetrics.updateCamera(this.camera);
    this.volumetrics.setDepthTexture(this.gtao.depthTexture ?? null);
    this.volumetrics.setFog(env.fog);

    // Project a point far along the sun direction into screen space by hand
    // (Vector3.project() divides by w before we can check its sign, which
    // mirrors off-screen when the sun is behind the camera).
    this._sunWorld.copy(this.camera.position).addScaledVector(env.sunDirection, 300);
    this._sunClip.set(this._sunWorld.x, this._sunWorld.y, this._sunWorld.z, 1)
      .applyMatrix4(this.camera.matrixWorldInverse)
      .applyMatrix4(this.camera.projectionMatrix);

    if (this._sunClip.w > 0) {
      const x = this._sunClip.x / this._sunClip.w;
      const y = this._sunClip.y / this._sunClip.w;
      this.volumetrics.setSun({ x: x * 0.5 + 0.5, y: y * 0.5 + 0.5 }, env.godrayStrength);
    } else {
      this.volumetrics.setSun(null, 0);
    }
  }

  update(dt) {
    this._time += dt;
    this.grade.uniforms.time.value = this._time;
    this.volumetrics.update(dt);
    this._updateVolumetrics();
    this._applyExposureFloor();
  }

  setSize(w, h) {
    this.composer.setSize(w, h);
    this.gtao.setSize(w, h);
    this.volumetrics.setSize(w, h);
    this.bloom.setSize(w, h);
    this.smaa.setSize(w, h);
    this.grade.uniforms.resolution.value.set(w, h);
  }

  render(dt) {
    this.composer.render(dt);
  }
}
