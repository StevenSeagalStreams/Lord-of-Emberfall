import * as THREE from 'three';

/**
 * Procedural sky dome for outdoor zones.
 *
 * A single inverted sphere, fully procedural (no textures), rendered *behind*
 * everything (renderOrder -1000, depthWrite false) and recentred on the
 * camera every frame via `onBeforeRender` so it always reads as infinitely
 * far away regardless of map size.
 *
 * The shader layers, back to front:
 *   1. zenith -> horizon gradient (cool zenith, hazy warm band near the sun)
 *   2. a sun disc + corona aligned with Lighting's directional sun, with a
 *      core that exceeds 1.0 radiance so it survives the bloom threshold and
 *      feeds the screen-space god-ray pass in Volumetrics.js
 *   3. a thin, slow-scrolling "blighted" cloud layer (fbm value noise, tinted
 *      sick green-grey rather than white)
 *   4. ground-level haze that fades the horizon into the fog colour so the
 *      sky-to-terrain seam never shows a hard line
 *
 * Lighting owns the instance: created in `Lighting.applyRig` whenever the rig
 * describes a sun, destroyed otherwise, so dungeon zones keep the void.
 */
export class Sky {
  constructor() {
    const geo = new THREE.SphereGeometry(1, 32, 18);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        sunDirection: { value: new THREE.Vector3(0, 1, 0) },
        sunColor: { value: new THREE.Color(0xffffff) },
        sunIntensity: { value: 1.0 },
        zenithColor: { value: new THREE.Color(0x1b2440) },
        horizonColor: { value: new THREE.Color(0x8a6a4a) },
        hazeColor: { value: new THREE.Color(0x39423f) },
        cloudColor: { value: new THREE.Color(0x556052) },
        cloudCoverage: { value: 0.45 },
        cloudiness: { value: 0.55 },
        cloudSpeed: { value: 0.015 },
        time: { value: 0 },
      },
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main() {
          vDir = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec3 vDir;
        uniform vec3 sunDirection, sunColor, zenithColor, horizonColor, hazeColor, cloudColor;
        uniform float sunIntensity, cloudCoverage, cloudiness, cloudSpeed, time;

        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          float a = hash(i), b = hash(i + vec2(1.0, 0.0));
          float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
        }
        float fbm(vec2 p) {
          float v = 0.0, a = 0.5;
          for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.02; a *= 0.5; }
          return v;
        }

        void main() {
          vec3 dir = normalize(vDir);
          vec3 sun = normalize(sunDirection);

          // zenith/horizon gradient -- exponent shapes how quickly it lifts
          // off the horizon band into the cold zenith.
          float up = clamp(dir.y, -1.0, 1.0);
          float t = pow(clamp(up, 0.0, 1.0), 0.45);
          vec3 sky = mix(horizonColor, zenithColor, t);

          // horizon haze -- thickest right at the skyline, same family as the
          // scene fog colour so the seam disappears.
          float hazeAmt = exp(-max(up, 0.0) * 3.2);
          sky = mix(sky, hazeColor, hazeAmt * 0.65);
          // below the horizon (looking under the terrain silhouette at glancing
          // angles) fall fully into haze rather than showing zenith blue.
          sky = mix(sky, hazeColor, smoothstep(0.02, -0.08, up));

          // sun disc + corona. Core intentionally > 1.0 radiance: this is the
          // HDR source the bloom pass and the god-ray pass both key off.
          float sunDot = max(dot(dir, sun), 0.0);
          float corona = pow(sunDot, 340.0);
          float glow = pow(sunDot, 8.0) * 0.5 + pow(sunDot, 2.0) * 0.08;
          vec3 sunLight = sunColor * sunIntensity;
          sky += sunLight * glow;
          sky += sunLight * corona * 8.0;

          // blighted cloud layer: planar fbm projected onto the dome, biased
          // to a sick green-grey rather than white, faded out near the
          // horizon so it doesn't smear into the haze band.
          vec2 cp = dir.xz / max(dir.y * 0.7 + 0.35, 0.08);
          vec2 flow = vec2(time * cloudSpeed, time * cloudSpeed * 0.6);
          float n = fbm(cp * 0.10 + flow);
          float mask = smoothstep(cloudCoverage, cloudCoverage + 0.30, n);
          mask *= smoothstep(0.01, 0.30, up) * cloudiness;
          vec3 litCloud = mix(cloudColor, cloudColor + sunLight * 0.35, glow);
          sky = mix(sky, litCloud, mask);

          gl_FragColor = vec4(max(sky, 0.0), 1.0);
        }
      `,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'SkyDome';
    this.mesh.scale.setScalar(370);
    this.mesh.renderOrder = -1000;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = true;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // Recentre on the camera every render so the dome reads as infinitely far
    // away no matter how far the player wanders -- no coupling to CameraRig
    // needed, three.js calls this per-object at render time.
    this.mesh.onBeforeRender = (renderer, scene, camera) => {
      this.mesh.position.copy(camera.position);
    };
  }

  setSun(direction, color, intensity) {
    this.material.uniforms.sunDirection.value.copy(direction);
    if (color !== undefined) this.material.uniforms.sunColor.value.set(color);
    if (intensity !== undefined) this.material.uniforms.sunIntensity.value = intensity;
  }

  setPalette({ zenith, horizon, haze, cloudColor, cloudCoverage, cloudiness, cloudSpeed } = {}) {
    if (zenith !== undefined) this.material.uniforms.zenithColor.value.set(zenith);
    if (horizon !== undefined) this.material.uniforms.horizonColor.value.set(horizon);
    if (haze !== undefined) this.material.uniforms.hazeColor.value.set(haze);
    if (cloudColor !== undefined) this.material.uniforms.cloudColor.value.set(cloudColor);
    if (cloudCoverage !== undefined) this.material.uniforms.cloudCoverage.value = cloudCoverage;
    if (cloudiness !== undefined) this.material.uniforms.cloudiness.value = cloudiness;
    if (cloudSpeed !== undefined) this.material.uniforms.cloudSpeed.value = cloudSpeed;
  }

  update(dt) {
    this.material.uniforms.time.value += dt;
  }

  dispose() {
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}
