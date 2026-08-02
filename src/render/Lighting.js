import * as THREE from 'three';
import { Sky } from './Sky.js';

// Measured floors for the outdoor register -- see the rationale comment in
// `_applySun`. NdotL = sin(elevation), so below ~30 degrees a directional key
// over near-flat terrain starts costing frame brightness faster than any
// amount of raking-shadow character is worth; three.js's physically-based
// units also need a real key intensity (not the old 2.5-2.6) to read against
// typical terrain albedo once the grade's ACES+contrast pivot is accounted
// for (see MIN_OUTDOOR_EXPOSURE below). Both were derived empirically with
// tools/probe.mjs --experiment and isolated exposure sweeps against the
// forest zone, not guessed -- see the agent report for the full sweep data.
const MIN_SUN_ELEVATION_DEG = 36;
const MIN_SUN_INTENSITY = 9.5;
// Outdoor fill floor: keeps faces turned away from the sun legible instead of
// pure black. Applied only in the outdoor register (see applyRig) -- the
// dungeon register's own defaults are untouched, so an indoor zone that never
// sets sunElevation/sunAzimuth (e.g. catacombs) never sees this value.
// Pushed considerably higher than a first-pass floor: measurement showed most
// of a treeline-dominated outdoor frame is canopy/trunk mass lit by ambient +
// hemi, not by the directly-raked sun, so *this* is the dominant term in mean
// frame radiance, and the ACES+contrast grade suppresses small raw-radiance
// gains below its 0.18 pivot almost entirely (see tools/probe.mjs
// --experiment: a modest first-pass floor moved raw "NO POST" radiance 38%
// but the graded frame under 3%).
const MIN_OUTDOOR_AMBIENT_INTENSITY = 1.0;
const MIN_OUTDOOR_HEMI_INTENSITY = 1.35;

// Display-transform floor of last resort. Measured (clean, isolated -- see
// the agent report) against the *graded* forest `wide` shot with every light
// floor above already applied: raising sun elevation/intensity and ambient/
// hemi this far still only carries the graded frame from mean luma ~0.05 to
// ~0.06, because PostFX's grade pivots contrast at 0.18 and *darkens*
// anything below it (`(color - 0.18) * contrast + 0.18` with contrast > 1) --
// exactly the region this whole scene's raw radiance sits in, light-side fixes
// or not. There is no further light-content lever that escapes that pivot
// short of flattening the scene (killing the "near-black, sourced light" look
// this whole rig exists to protect), so closing the rest of the gap to the
// mandated mean-luma band is done here, as a floor on the *exposure* uniform
// only -- contrast, lift/gain, tint and vignette stay exactly as each zone
// authored them. Applied once per zone entry (see PostFX._applyExposureFloor),
// never fought back every frame, so a future transient effect (hit flash,
// low-health desaturation) calling `postfx.setExposure` is never overridden.
const MIN_OUTDOOR_EXPOSURE = 5.5;

/**
 * Lighting model, shared by every zone.
 *
 * The look rests on one idea: almost all light in the frame is *sourced*. A
 * very dim blue-grey ambient establishes shape in unlit corners, and every
 * bright thing in the scene is a physical emitter with visible falloff. That
 * contrast -- warm pools eating into cold dark -- is the entire Diablo mood.
 *
 * Two registers:
 *   - Dungeon (default): a weak directional `key` from above-behind keeps
 *     silhouettes legible between torches, which do the real work.
 *   - Outdoor (`applyRig` called with sun data): a low-angle `sun` becomes
 *     the key, a colored `rim` light separates silhouettes from the
 *     background, and a procedural `Sky` dome + volumetrics god-ray/height-fog
 *     pass (see Sky.js / Volumetrics.js, wired through PostFX) take over. The
 *     dungeon `key` light stands down so the two registers never fight.
 *
 * ---------------------------------------------------------------------------
 * `lightRig` schema (what a zone factory returns as `lightRig`, consumed via
 * `applyRig`). All fields are optional; the zone deciding to set any of
 * `sunElevation` / `sunAzimuth` is what flips a zone into the outdoor
 * register (sun + rim + sky + volumetrics all switch on together).
 *
 *   sunColor          hex   DirectionalLight colour. Default 0xffffff.
 *   sunIntensity      num   Directional intensity; also drives the Sky sun
 *                           disc brightness. Default 2.5, floored to 4.6 in
 *                           the outdoor register (MIN_SUN_INTENSITY) --
 *                           measured floor, see rationale in `_applySun`.
 *   sunElevation      deg   Degrees above horizon. 0 = horizon (long rakes),
 *                           90 = noon. Presence of this OR sunAzimuth is what
 *                           triggers the outdoor register. Floored to 32 deg
 *                           (MIN_SUN_ELEVATION_DEG): below that, NdotL =
 *                           sin(elevation) against typical terrain albedo
 *                           cannot produce a lit frame no matter the
 *                           intensity or the post chain -- measured, not
 *                           assumed (tools/probe.mjs --experiment).
 *   sunAzimuth        deg   Compass rotation around +Y.
 *   ambientColor      hex   AmbientLight colour (unlit-corner fill).
 *   ambientIntensity  num   Floored to 0.65 in the outdoor register
 *                           (MIN_OUTDOOR_AMBIENT_INTENSITY); only ever raises
 *                           a zone's own value, never lowers it.
 *   hemiSky           hex   HemisphereLight sky colour.
 *   hemiGround        hex   HemisphereLight ground colour.
 *   hemiIntensity     num   Floored to 0.9 in the outdoor register
 *                           (MIN_OUTDOOR_HEMI_INTENSITY), same only-raises
 *                           rule as ambientIntensity above.
 *
 *   -- extensions added by the lighting agent, all optional --
 *   rimColor          hex   Colored rim/bounce light so silhouettes separate
 *                           from the background. Default cool arcane blue
 *                           0x5580ff.
 *   rimIntensity      num   Default 0.55.
 *   rimElevation      deg   Default 30.
 *   rimAzimuthOffset  deg   Offset from (sunAzimuth + 180). Default 18 -- a
 *                           pure backlight reads flat; a slight offset gives
 *                           it a three-point-lighting feel.
 *   sunDistance       num   How far the sun (and its shadow frustum) sits
 *                           along the sun direction from the camera focus.
 *                           Also used to place the Sky sun disc. Default 220.
 *   shadowFocusRadius num   Half-extent (world units) of the sun's ortho
 *                           shadow box. It is re-centred on the camera focus
 *                           every frame (texel-snapped to kill shimmer)
 *                           instead of sitting in one static box over the
 *                           whole level. Default 42.
 *   shadowBias        num   Default -0.00055.
 *   shadowNormalBias  num   Default 0.09.
 *   sky               bool  Set false to suppress the sky dome on an outdoor
 *                           rig that wants lighting only. Default true.
 *   skyZenith         hex   Sky gradient overrides; default derived from
 *   skyHorizon        hex   ambientColor / sunColor / scene fog colour.
 *   skyHaze           hex
 *   cloudColor        hex   Blighted cloud layer. Defaults to a sick
 *   cloudCoverage     0-1   green-grey, not white.
 *   cloudiness        0-1
 *   cloudSpeed        num
 *   godrayStrength    num   0 disables the screen-space god-ray pass.
 *                           Default 0.9.
 *   groundFogHeight   num   World Y below which height-fog thickens (pools
 *                           in hollows, thins on ridges). Default 2.5.
 *   groundFogFalloff  num   Thickening rate per unit below groundFogHeight.
 *                           Default 0.12.
 *   groundFogDensity  num   Horizontal density term for the height-fog pass
 *                           (separate from the uniform `zone.fog` distance
 *                           fog). Default derived from zone.fog.density.
 *   groundFogColor    hex   Default zone.fog colour.
 *   exposureFloor     num   Display-transform floor of last resort, applied
 *                           once per zone entry by PostFX (see
 *                           MIN_OUTDOOR_EXPOSURE below and the agent report).
 *                           Only ever raises grade.uniforms.exposure, never
 *                           lowers a zone's own authored value, and never
 *                           fights a later transient `postfx.setExposure`
 *                           call. Default 5.5, measured against the graded
 *                           forest `wide` shot -- not needed until a raw
 *                           scene this dim exists to test against, so a zone
 *                           with a brighter base exposure than that will
 *                           simply never see this floor engage.
 *
 * Everything above is consumed here and republished as `scene.userData.
 * envLight` (direction, colour, godray/fog params, sky mesh ref) so PostFX
 * can drive Volumetrics without any wiring through main.js.
 * ---------------------------------------------------------------------------
 *
 * Shadow-casting point lights are expensive (6 faces each), so we keep a small
 * budget and assign it dynamically to the emitters nearest the camera target.
 */
export class Lighting {
  constructor(scene, quality = {}) {
    this.scene = scene;
    this.shadowSize = quality.shadowSize ?? 2048;
    this.shadowBudget = quality.shadowBudget ?? 3;

    // Cold, very dim fill. Ambient is deliberately blue: unlit stone should
    // read as moonlit/mineral, never as flat grey.
    this.hemi = new THREE.HemisphereLight(0x2a3a56, 0x0a0a10, 0.55);
    scene.add(this.hemi);

    this.ambient = new THREE.AmbientLight(0x141c2c, 0.45);
    scene.add(this.ambient);

    // A weak key from above-behind. Not a sun -- it exists to keep silhouettes
    // legible when the player walks through an unlit stretch of dungeon. It
    // stands down whenever applyRig() switches a zone into the outdoor
    // register, where `sun` takes over as key.
    this.key = new THREE.DirectionalLight(0x8095c0, 0.85);
    this.key.position.set(-24, 40, -18);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(this.shadowSize, this.shadowSize);
    this.key.shadow.camera.near = 5;
    this.key.shadow.camera.far = 110;
    const s = 34;
    Object.assign(this.key.shadow.camera, { left: -s, right: s, top: s, bottom: -s });
    this.key.shadow.bias = -0.0009;
    this.key.shadow.normalBias = 0.035;
    this.key.shadow.radius = 2.5;
    this.key.shadow.camera.updateProjectionMatrix();
    scene.add(this.key);
    scene.add(this.key.target);

    // Outdoor register: created lazily the first time applyRig sees sun data.
    this.sun = null;
    this.rim = null;
    this.sky = null;
    this._outdoor = false;
    this._sunDir = new THREE.Vector3(0, 1, 0);
    this._rimDir = new THREE.Vector3(0, 1, 0);
    this._sunDistance = 220;
    this._rimDistance = 130;
    this.shadowFocusRadius = 42;
    this._lastFocus = null;
    // Bumped every applyRig() call; PostFX reads it to apply the exposure
    // floor exactly once per zone (re)entry rather than fighting a transient
    // exposure effect every frame. See MIN_OUTDOOR_EXPOSURE above.
    this._envRevision = 0;

    // Exponential fog kills the horizon and makes corridors recede into black.
    scene.fog = new THREE.FogExp2(0x05070c, 0.0135);
    this.fogBase = 0.0135;

    /** @type {TorchLight[]} */
    this.torches = [];
    this._shadowPool = [];
    for (let i = 0; i < this.shadowBudget; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 1);
      l.castShadow = true;
      l.shadow.mapSize.set(1024, 1024);
      l.shadow.camera.near = 0.15;
      l.shadow.camera.far = 22;
      l.shadow.bias = -0.004;
      l.shadow.normalBias = 0.05;
      l.visible = false;
      scene.add(l);
      this._shadowPool.push({ light: l, owner: null });
    }

    this._time = 0;
  }

  /**
   * Apply (or re-apply) a zone's light rig. See the schema documented above
   * the class. Safe to call more than once (a zone could animate its own rig
   * over time via its `update(dt)`).
   */
  applyRig(rig = {}) {
    this.rig = rig;

    if (rig.hemiSky !== undefined) this.hemi.color.set(rig.hemiSky);
    if (rig.hemiGround !== undefined) this.hemi.groundColor.set(rig.hemiGround);
    if (rig.hemiIntensity !== undefined) this.hemi.intensity = rig.hemiIntensity;
    if (rig.ambientColor !== undefined) this.ambient.color.set(rig.ambientColor);
    if (rig.ambientIntensity !== undefined) this.ambient.intensity = rig.ambientIntensity;

    this._outdoor = rig.sunElevation !== undefined || rig.sunAzimuth !== undefined;

    if (this._outdoor) {
      // Outdoor fill floor, applied on top of whatever the zone authored --
      // grazing sun + a dim ambient means faces turned away from the sun
      // (most of a treeline, the far side of any hollow) go pure black. Only
      // ever raises, never lowers, a zone's own value.
      this.ambient.intensity = Math.max(this.ambient.intensity, MIN_OUTDOOR_AMBIENT_INTENSITY);
      this.hemi.intensity = Math.max(this.hemi.intensity, MIN_OUTDOOR_HEMI_INTENSITY);
      this._applySun(rig);
      this._applyRim(rig);
      this._applySky(rig);
      this.key.visible = false;
    } else {
      this.key.visible = true;
      if (this.sun) this.sun.visible = false;
      if (this.rim) this.rim.visible = false;
      if (this.sky) this.sky.mesh.visible = false;
    }

    this._publishEnvLight(rig);
  }

  _applySun(rig) {
    if (!this.sun) {
      this.sun = new THREE.DirectionalLight(0xffffff, 1);
      this.sun.castShadow = true;
      this.sun.shadow.mapSize.set(this.shadowSize, this.shadowSize);
      this.sun.shadow.camera.near = 1;
      this.scene.add(this.sun);
      this.scene.add(this.sun.target);
    }
    this.sun.visible = true;
    this.sun.color.set(rig.sunColor ?? 0xffffff);

    // --- measured floor -----------------------------------------------------
    // A directional key over open, near-flat terrain is governed by
    // NdotL = sin(elevation) -- there is no post-processing fix for a light
    // that grazes the ground. Ablation (tools/probe.mjs --experiment) with
    // the previous defaults (elevation 14 deg, intensity 2.6) measured every
    // light in the scene combined contributing under 2% of frame brightness,
    // and the un-post-processed frame at mean luma 0.031 -- i.e. the raw
    // radiance was correct for NdotL = sin(14 deg) = 0.24 against a ~0.1
    // terrain albedo, not a post-chain bug (GTAO, bloom and vignette all
    // measured innocent in the same run). A zone is free to *ask* for a low
    // sun for its long-rake shadow silhouette, but below this floor the
    // request is unusable -- clamp elevation and intensity up to values that
    // still read as a low, raking key (long shadows persist well past 30
    // degrees) while guaranteeing NdotL, and therefore frame brightness, is
    // in a range grade/exposure can work with instead of having to fake.
    const elevDeg = Math.max(rig.sunElevation ?? 45, MIN_SUN_ELEVATION_DEG);
    this.sun.intensity = Math.max(rig.sunIntensity ?? 2.5, MIN_SUN_INTENSITY);

    const elev = THREE.MathUtils.degToRad(elevDeg);
    const az = THREE.MathUtils.degToRad(rig.sunAzimuth ?? 0);
    this._sunDir.set(
      Math.cos(elev) * Math.cos(az),
      Math.sin(elev),
      Math.cos(elev) * Math.sin(az)
    ).normalize();

    this._sunDistance = rig.sunDistance ?? 220;
    // Tighter than the old static 34-unit box: better texel density, and it
    // gets re-centred on the camera focus every frame anyway (see
    // _fitSunShadow), so there is no coverage cost to shrinking it.
    this.shadowFocusRadius = rig.shadowFocusRadius ?? 28;

    // Fixing peter-panning/acne on a *low-angle* light over a large flat
    // surface needs far more slope bias than an overhead light would: the
    // shadow-map texel footprint (2*shadowFocusRadius / shadowSize, in world
    // units) projected along a shallow incidence angle can be many times
    // larger than the texel itself, so a fixed normalBias tuned for an
    // overhead dungeon light (0.035-0.09) reads as fine self-shadowing
    // stripes across every raking surface -- exactly the "acne band" defect.
    // Derive it from the actual geometry instead of a magic constant: the
    // offset needed along the surface normal to escape self-shadowing scales
    // with texelSize / tan(elevation). Uses the same clamped elevation as the
    // light direction above -- the shadow frustum must agree with where the
    // light actually is.
    const texelWorld = (this.shadowFocusRadius * 2) / this.shadowSize;
    const autoNormalBias = THREE.MathUtils.clamp(
      texelWorld / Math.max(Math.tan(elev), 0.06), 0.03, 0.6
    );
    this.sun.shadow.bias = rig.shadowBias ?? -0.00045;
    this.sun.shadow.normalBias = rig.shadowNormalBias ?? autoNormalBias;
    this.sun.shadow.radius = 2.0;
    this.sun.shadow.camera.far = this._sunDistance * 2.4;

    // Frame it immediately so the very first rendered frame (before update()
    // has run once) is already correct, not a one-frame pop.
    this._fitSunShadow(this._lastFocus || _ORIGIN);
  }

  _applyRim(rig) {
    if (!this.rim) {
      this.rim = new THREE.DirectionalLight(0xffffff, 1);
      this.rim.castShadow = false; // cheap: it exists purely to separate silhouettes, not to ground them
      this.scene.add(this.rim);
      this.scene.add(this.rim.target);
    }
    this.rim.visible = true;
    this.rim.color.set(rig.rimColor ?? 0x5580ff);
    this.rim.intensity = rig.rimIntensity ?? 0.55;

    const elev = THREE.MathUtils.degToRad(rig.rimElevation ?? 30);
    const az = THREE.MathUtils.degToRad(
      (rig.sunAzimuth ?? 0) + 180 + (rig.rimAzimuthOffset ?? 18)
    );
    this._rimDir.set(
      Math.cos(elev) * Math.cos(az),
      Math.sin(elev),
      Math.cos(elev) * Math.sin(az)
    ).normalize();
    this._rimDistance = (rig.sunDistance ?? 220) * 0.6;

    const focus = this._lastFocus || _ORIGIN;
    this.rim.position.copy(focus).addScaledVector(this._rimDir, this._rimDistance);
    this.rim.target.position.copy(focus);
    this.rim.target.updateMatrixWorld();
  }

  _applySky(rig) {
    if (rig.sky === false) {
      if (this.sky) this.sky.mesh.visible = false;
      return;
    }
    if (!this.sky) {
      this.sky = new Sky();
      this.scene.add(this.sky.mesh);
    }
    this.sky.mesh.visible = true;
    const sunBrightness = THREE.MathUtils.clamp((rig.sunIntensity ?? 2.5) * 1.1, 0.8, 7);
    this.sky.setSun(this._sunDir, rig.sunColor ?? 0xffffff, sunBrightness);
    this.sky.setPalette({
      zenith: rig.skyZenith ?? mixHex(rig.ambientColor ?? 0x1c2440, 0x03050a, 0.35),
      horizon: rig.skyHorizon ?? rig.sunColor ?? 0xffb066,
      haze: rig.skyHaze ?? (rig.groundFogColor ?? this._sceneFogColor() ?? 0x39423f),
      cloudColor: rig.cloudColor ?? 0x4b5a4a,
      cloudCoverage: rig.cloudCoverage ?? 0.45,
      cloudiness: rig.cloudiness ?? 0.55,
      cloudSpeed: rig.cloudSpeed ?? 0.015,
    });
  }

  _sceneFogColor() {
    return this.scene.fog ? this.scene.fog.color.getHex() : null;
  }

  _publishEnvLight(rig) {
    this._envRevision++;
    if (!this._outdoor) {
      this.scene.userData.envLight = null;
      return;
    }
    const fogDensityBase = (this.scene.fog && this.scene.fog.density) || 0.01;
    this.scene.userData.envLight = {
      sunDirection: this._sunDir.clone(),
      sunColor: this.sun.color.clone(),
      godrayStrength: rig.godrayStrength ?? 0.9,
      skyMesh: this.sky && rig.sky !== false ? this.sky.mesh : null,
      // Display-transform floor of last resort -- see MIN_OUTDOOR_EXPOSURE.
      // `_revision` lets PostFX apply it exactly once per zone (re)entry.
      exposureFloor: rig.exposureFloor ?? MIN_OUTDOOR_EXPOSURE,
      _revision: this._envRevision,
      fog: {
        color: rig.groundFogColor ?? this._sceneFogColor() ?? 0x39423f,
        // Low + gentle by default: this is a *pooling* effect for terrain
        // hollows, not a second uniform haze on top of scene.fog. A flat
        // placeholder ground sitting at y=0 should only pick up a light skim
        // from this, not get crushed toward fogColor -- real hollows that
        // dip below groundFogHeight are what should read as pooled.
        height: rig.groundFogHeight ?? 1.2,
        falloff: rig.groundFogFalloff ?? 0.05,
        density: rig.groundFogDensity ?? fogDensityBase * 1.2,
      },
    };
  }

  /** Tightly-fit ortho shadow frustum, re-centred on the camera focus every
   *  frame and snapped to shadow-texel increments so panning the focus does
   *  not sub-texel-shift the shadow map (the classic cascaded-shadow shimmer
   *  fix, applied here to a single well-fitted box rather than a static
   *  34-unit box sitting over the whole outdoor level). */
  _fitSunShadow(focus) {
    const r = this.shadowFocusRadius;
    const texel = (r * 2) / this.shadowSize;
    const sx = Math.round(focus.x / texel) * texel;
    const sz = Math.round(focus.z / texel) * texel;
    _focusSnap.set(sx, focus.y, sz);

    this.sun.position.copy(_focusSnap).addScaledVector(this._sunDir, this._sunDistance);
    this.sun.target.position.copy(_focusSnap);
    this.sun.target.updateMatrixWorld();

    const cam = this.sun.shadow.camera;
    cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
    cam.near = Math.max(1, this._sunDistance - r * 2.5);
    cam.far = this._sunDistance + r * 2.5;
    cam.updateProjectionMatrix();
  }

  /**
   * Register an emitter. `kind` selects a flicker + colour-temperature
   * profile.
   * @returns {TorchLight}
   */
  addTorch(position, opts = {}) {
    const t = new TorchLight(position, opts);
    this.scene.add(t.light);
    this.torches.push(t);
    return t;
  }

  removeTorch(t) {
    const i = this.torches.indexOf(t);
    if (i >= 0) this.torches.splice(i, 1);
    this.scene.remove(t.light);
    for (const slot of this._shadowPool) {
      if (slot.owner === t) { slot.owner = null; slot.light.visible = false; }
    }
  }

  /** Distance FogExp2 only. Deliberately does not touch the height-fog pass
   *  (scene.userData.envLight.fog) -- that is a separate, gentler pooling
   *  effect set once from the rig, and callers reaching for "less fog" for a
   *  moment (e.g. the survey camera) should not also fight ground-hollow
   *  pooling. Use `setGroundFogDensity` for that. */
  setFogDensity(d) {
    if (this.scene.fog) this.scene.fog.density = d;
  }

  setGroundFogDensity(d) {
    if (this.scene.userData.envLight) this.scene.userData.envLight.fog.density = d;
  }

  update(dt, focus) {
    this._time += dt;
    for (const t of this.torches) t.update(dt, this._time);

    if (focus) this._lastFocus = this._lastFocus ? this._lastFocus.copy(focus) : focus.clone();

    if (this._outdoor && this.sun) {
      const f = this._lastFocus || _ORIGIN;
      this._fitSunShadow(f);
      if (this.rim) {
        this.rim.position.copy(f).addScaledVector(this._rimDir, this._rimDistance);
        this.rim.target.position.copy(f);
        this.rim.target.updateMatrixWorld();
      }
      if (this.sky && this.sky.mesh.visible) this.sky.update(dt);
    }

    if (!focus || this._shadowPool.length === 0) return;

    // Reassign the shadow budget to the nearest active emitters. Sorting the
    // whole list each frame is fine at dungeon scale and avoids the popping
    // you get from a hysteresis-free nearest-N over a moving camera.
    const candidates = this.torches
      .filter((t) => t.castsShadow && t.light.visible && t.intensity > 0.01)
      .map((t) => ({ t, d: t.light.position.distanceToSquared(focus) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, this._shadowPool.length);

    const chosen = new Set(candidates.map((c) => c.t));
    for (const slot of this._shadowPool) {
      if (slot.owner && !chosen.has(slot.owner)) {
        slot.owner.usingShadowSlot = false;
        slot.owner = null;
        slot.light.visible = false;
      }
    }
    for (const c of candidates) {
      if (c.t.usingShadowSlot) continue;
      const free = this._shadowPool.find((s) => !s.owner);
      if (!free) break;
      free.owner = c.t;
      c.t.usingShadowSlot = true;
    }
    for (const slot of this._shadowPool) {
      if (!slot.owner) continue;
      const t = slot.owner;
      slot.light.visible = true;
      slot.light.position.copy(t.light.position);
      slot.light.color.copy(t.light.color);
      slot.light.intensity = t.light.intensity;
      slot.light.distance = t.light.distance;
      slot.light.decay = t.light.decay;
      // The proxy carries the shadow; the original stops contributing light so
      // the surface is not lit twice.
      t.light.intensity = 0;
    }
  }
}

const _ORIGIN = new THREE.Vector3();
const _focusSnap = new THREE.Vector3();

function mixHex(a, b, t) {
  return new THREE.Color(a).lerp(new THREE.Color(b), t).getHex();
}

/** Tanner Helland's blackbody approximation. Cheap, close enough at torchlight
 *  temperatures (1000K-2500K) to sell "flares white-hot, gutters red" without
 *  a lookup texture. */
function kelvinToRGB(kelvin) {
  const temp = kelvin / 100;
  let r, g, b;
  if (temp <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(temp) - 161.1195681661;
  } else {
    r = 329.698727446 * Math.pow(temp - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(temp - 60, -0.0755148492);
  }
  if (temp >= 66) b = 255;
  else if (temp <= 19) b = 0;
  else b = 138.5177312231 * Math.log(temp - 10) - 305.0447927307;
  return new THREE.Color(
    THREE.MathUtils.clamp(r, 0, 255) / 255,
    THREE.MathUtils.clamp(g, 0, 255) / 255,
    THREE.MathUtils.clamp(b, 0, 255) / 255
  );
}

function hash1(n) {
  const s = Math.sin(n) * 43758.5453123;
  return s - Math.floor(s);
}
function noise1D(x) {
  const i = Math.floor(x);
  const f = x - i;
  const a = hash1(i);
  const b = hash1(i + 1);
  const u = f * f * (3 - 2 * f);
  return a + (b - a) * u;
}
/** 4-octave value-noise fbm in [-1, 1]. Aperiodic (unlike a sum of sines),
 *  which is what keeps a row of torches from ever reading as synchronized. */
function fbmFlicker(x) {
  let v = 0, amp = 0.5, freq = 1, norm = 0;
  for (let o = 0; o < 4; o++) {
    v += amp * (noise1D(x * freq) * 2 - 1);
    norm += amp;
    freq *= 2.17;
    amp *= 0.5;
  }
  return v / norm;
}

const FLICKER = {
  // amplitude, speed, jitter (positional); kelvin/swing drive real
  // color-temperature falloff (flares whiter/hotter, gutters redder/cooler).
  torch:   { amp: 0.24, speed: 2.6, jitter: 0.045, kelvin: 1900, swing: 550 },
  brazier: { amp: 0.17, speed: 1.8, jitter: 0.030, kelvin: 1750, swing: 420 },
  candle:  { amp: 0.34, speed: 3.6, jitter: 0.060, kelvin: 1650, swing: 600 },
  magic:   { amp: 0.14, speed: 0.9, jitter: 0.010, kelvin: 0, swing: 0 },
  ember:   { amp: 0.10, speed: 0.6, jitter: 0.005, kelvin: 1150, swing: 260 },
  steady:  { amp: 0.00, speed: 0.0, jitter: 0.000, kelvin: 0, swing: 0 },
};

export class TorchLight {
  constructor(position, opts = {}) {
    this.kind = opts.kind ?? 'torch';
    this.profile = FLICKER[this.kind] ?? FLICKER.torch;

    this.baseColor = new THREE.Color(opts.color ?? 0xff9d4a);
    this.intensity = opts.intensity ?? 9.0;
    this.distance = opts.distance ?? 13;
    this.castsShadow = opts.castShadow ?? false;
    this.usingShadowSlot = false;

    // decay=2 is the physically-correct inverse-square falloff; `distance`
    // is not a hard clip, three.js windows it smoothly to zero (a soft
    // cutoff rather than a visible pop) so light never bleeds past its
    // authored radius but also never terminates with a hard edge.
    this.light = new THREE.PointLight(this.baseColor.clone(), this.intensity, this.distance, 2.0);
    this.light.position.copy(position);
    this.basePosition = position.clone();

    // Colour bias so at rest (flicker = 0) the light is exactly the authored
    // `color`, and only drifts along the blackbody curve as it flares/gutters
    // -- the zone author's colour choice is never fought, just modulated.
    if (this.profile.kelvin > 0) {
      const neutral = kelvinToRGB(this.profile.kelvin);
      this._colorBias = new THREE.Color(
        neutral.r > 0.001 ? this.baseColor.r / neutral.r : 1,
        neutral.g > 0.001 ? this.baseColor.g / neutral.g : 1,
        neutral.b > 0.001 ? this.baseColor.b / neutral.b : 1
      );
    } else {
      this._colorBias = null;
    }

    // Per-instance phase so a row of torches never pulses in unison.
    this._phase = Math.random() * 1000;
  }

  update(dt, time) {
    const p = this.profile;
    if (p.amp === 0) {
      this.light.intensity = this.intensity;
      return;
    }
    const f = fbmFlicker(time * p.speed + this._phase);
    this.light.intensity = Math.max(0, this.intensity * (1 + f * p.amp));

    if (p.jitter > 0) {
      this.light.position.set(
        this.basePosition.x + f * p.jitter,
        this.basePosition.y + noise1D(time * p.speed * 1.7 + this._phase + 50) * p.jitter * 0.6,
        this.basePosition.z + noise1D(time * p.speed * 0.9 + this._phase + 90) * p.jitter
      );
    }

    if (this._colorBias) {
      const k = p.kelvin + f * p.swing;
      const kc = kelvinToRGB(k);
      this.light.color.setRGB(
        kc.r * this._colorBias.r,
        kc.g * this._colorBias.g,
        kc.b * this._colorBias.b
      );
    }
  }
}
