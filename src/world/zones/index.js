/**
 * Zone registry.
 *
 * A zone owns everything that makes a place feel like a place: its geometry,
 * its navigation, its light rig bias, its colour grade, and its ambience. The
 * game loop knows nothing about forests or catacombs -- it asks for a zone by
 * name and gets back a uniform handle.
 *
 * Every zone factory returns:
 *
 *   {
 *     name,          // string id
 *     group,         // THREE.Object3D added to the scene
 *     colliders,     // { isSolidCell(x,y), isBlocked(wx,wz,radius) }
 *     nav,           // NavGrid
 *     spawnPoint,    // THREE.Vector3 where the player starts
 *     bounds,        // { minX, maxX, minZ, maxZ } world-space playable extent
 *     grade,         // per-zone colour grading applied to PostFX
 *     fog,           // { color, density }
 *     lightRig,      // per-zone Lighting overrides
 *     spawns,        // [{ kind, position }] enemy spawn requests
 *     update(dt),    // optional per-frame zone logic
 *   }
 *
 * `grade` fields map onto PostFX.grade uniforms:
 *   { exposure, contrast, saturation, lift:[r,g,b], gain:[r,g,b],
 *     shadowTint:[r,g,b], shadowTintAmt, highlightTint:[r,g,b], highlightAmt,
 *     vignette }
 */

import { createCatacombs } from './catacombs.js';
import { createForest } from './forest.js';

const ZONES = {
  forest: createForest,
  catacombs: createCatacombs,
};

export const ZONE_NAMES = Object.keys(ZONES);

// Interiors dominate. Per the direction mandate the surface zone exists to
// funnel the player underground, so the build boots into the dungeon -- the
// place the game actually is -- rather than the showcase exterior.
export const DEFAULT_ZONE = 'catacombs';

export async function createZone(name, ctx) {
  const factory = ZONES[name] || ZONES[DEFAULT_ZONE];
  const zone = await factory(ctx);
  zone.name = zone.name || name;
  return zone;
}

/** Apply a zone's grade + fog to the render stack. Called on zone entry. */
export function applyZoneLook(zone, postfx, lighting) {
  const g = zone.grade || {};
  const u = postfx?.grade?.uniforms;
  if (u) {
    if (g.exposure !== undefined) u.exposure.value = g.exposure;
    if (g.contrast !== undefined) u.contrast.value = g.contrast;
    if (g.saturation !== undefined) u.saturation.value = g.saturation;
    if (g.vignette !== undefined) u.vignette.value = g.vignette;
    if (g.shadowTintAmt !== undefined) u.shadowTintAmt.value = g.shadowTintAmt;
    if (g.highlightAmt !== undefined) u.highlightAmt.value = g.highlightAmt;
    if (g.lift) u.lift.value.set(...g.lift);
    if (g.gain) u.gain.value.set(...g.gain);
    if (g.shadowTint) u.shadowTint.value.set(...g.shadowTint);
    if (g.highlightTint) u.highlightTint.value.set(...g.highlightTint);
  }
  if (zone.fog && lighting) {
    if (zone.fog.density !== undefined) lighting.setFogDensity(zone.fog.density);
    if (zone.fog.color !== undefined && lighting.scene.fog) {
      lighting.scene.fog.color.set(zone.fog.color);
    }
  }
  if (zone.lightRig && lighting?.applyRig) lighting.applyRig(zone.lightRig);
}
