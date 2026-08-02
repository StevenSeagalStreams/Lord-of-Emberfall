import * as THREE from 'three';
import { NavGrid } from '../Nav.js';
import { Terrain } from '../TerrainGen.js';
import { buildForestFoliage, buildUndergrowth } from '../Foliage.js';
import { buildForestDressing } from '../Props.js';

/**
 * Zone 1 -- the Blighted Forest. *** M1 TARGET ZONE ***
 *
 * The WoW pillar lives here: a readable outdoor space with strong zone
 * identity, silhouette-driven treelines, and a low sun that rakes across
 * terrain. The Diablo pillar keeps it oppressive rather than pastoral -- this
 * is Elwynn Forest after something went wrong in it.
 *
 * Art direction targets:
 *   - Low-angle key from a sickly amber sun near the horizon, long shadows.
 *   - Cool desaturated blue-green ambient; the palette is sick, not lush.
 *   - Ground plane is heightmapped, never flat. Ridges, hollows, a path worn
 *     through the middle that the eye can follow.
 *   - Treelines read as silhouette masses first, individual trees second.
 *   - Volumetric ground fog pooling in the hollows; god rays through canopy.
 *   - Blight: dead bark, curled leaves, ash drift, sickly fungal accents as
 *     the single saturated colour note.
 *
 * Layout: a single worn trail climbs from the south trailhead (spawn, an old
 * reclaimed fence line) through a boggy hollow and a ridge saddle to a fork
 * at the Dead Great-Tree clearing -- the landmark visible from spawn. From
 * the fork, one branch reaches a standing-stone shrine (secondary landmark,
 * the bioluminescent-fungus focal point); the other peters into a thicket
 * against the sealed treeline boundary.
 */
export async function createForest(ctx) {
  const { scene } = ctx;
  const rng = ctx.rng;

  const group = new THREE.Group();
  group.name = 'Zone:forest';

  const SIZE = 96; // collision-grid cells; must match TILE spacing (2m)
  const TILE_SIZE = 2.0;

  // -- terrain: heightfield, splat-blended mesh, matching collision grid ----
  const terrain = new Terrain(rng.fork('terrain'), { size: SIZE, tile: TILE_SIZE });
  const terrainMesh = terrain.buildMesh(ctx.materials);
  group.add(terrainMesh);
  const colliders = terrain.buildColliders();
  const nav = new NavGrid(colliders);

  // Sky is the Lighting agent's responsibility (src/render/Sky.js, installed
  // by Lighting.applyRig from lightRig below) -- not built here, so it can
  // never drift from the directional sun's actual position.

  // -- treelines: silhouette-mass trees, instanced ---------------------------
  const foliage = buildForestFoliage({ rng: rng.fork('foliage'), terrain });
  group.add(foliage.group);

  // -- undergrowth: ferns, tufts, shrubs, logs, roots ------------------------
  const undergrowth = buildUndergrowth({ rng: rng.fork('undergrowth'), terrain });
  group.add(undergrowth.group);

  // -- dressing: rocks, bones, the reclaimed fence, the shrine, blight glow --
  const dressing = buildForestDressing({ rng: rng.fork('dressing'), materials: ctx.materials, terrain });
  group.add(dressing.group);

  // -- spawn point: the trailhead, on the authored path ----------------------
  const entry = terrain.path.entry;
  const spawnPoint = new THREE.Vector3(entry.x, terrain.heightAt(entry.x, entry.z), entry.z);

  // -- monster spawns: scattered through the reachable interior, away from
  // the immediate trailhead -------------------------------------------------
  const spawnRng = rng.fork('spawns');
  const spawns = [];
  for (let i = 0; i < 14; i++) {
    let pos = null;
    for (let attempt = 0; attempt < 60; attempt++) {
      const wx = spawnRng.range(terrain.worldSize * 0.14, terrain.worldSize * 0.86);
      const wz = spawnRng.range(terrain.worldSize * 0.14, terrain.worldSize * 0.86);
      if (colliders.isBlocked(wx, wz, 1.0)) continue;
      if (Math.hypot(wx - spawnPoint.x, wz - spawnPoint.z) < 9) continue;
      pos = new THREE.Vector3(wx, terrain.heightAt(wx, wz), wz);
      break;
    }
    spawns.push({
      kind: spawnRng.bool(0.5) ? 'swarmer' : 'skeleton',
      position: pos || spawnPoint.clone(),
    });
  }

  scene.add(group);

  return {
    name: 'forest',
    group,
    colliders,
    nav,
    terrain,
    spawns,
    spawnPoint,
    bounds: { minX: 0, maxX: terrain.worldSize, minZ: 0, maxZ: terrain.worldSize },
    drawCalls: terrain.drawCalls + foliage.drawCalls + undergrowth.drawCalls + dressing.drawCalls,
    // Sick amber-and-slate exterior: desaturated, cold shadows, warm low sun.
    fog: { color: 0x39423f, density: 0.0075 },
    grade: {
      exposure: 1.15, contrast: 1.08, saturation: 0.88,
      lift: [0.010, 0.014, 0.016],
      gain: [1.03, 1.00, 0.92],
      shadowTint: [0.32, 0.44, 0.58], shadowTintAmt: 0.20,
      highlightTint: [1.00, 0.82, 0.52], highlightAmt: 0.16,
      vignette: 0.66,
    },
    // The sun's azimuth is chosen RELATIVE TO THE CAMERA, which sits at
    // azimuth 45. At the old 232 the sun was 173 degrees off the view
    // direction -- almost perfectly behind the subject -- so every tree turned
    // its shade side to the camera and read as a black cutout standing in
    // front of the light rather than an object standing in it. No material
    // change could have fixed that; it was lighting geometry.
    //
    // 115 puts the sun 70 degrees off the camera: raking side light, so each
    // trunk and canopy shows a lit face and a shade face, which is the whole
    // point of "trees are objects IN the light".
    //
    // Elevation stays at 36. At the original 14 the sun grazed flat ground at
    // NdotL 0.24 and no exposure could rescue it; 36 gives 0.59 and still
    // throws long, characterful shadows.
    lightRig: {
      sunColor: 0xffb066,
      sunIntensity: 9.5,
      sunElevation: 36,
      sunAzimuth: 115,
      ambientColor: 0x36434c,
      ambientIntensity: 1.0,
      hemiSky: 0x53606b,
      hemiGround: 0x241f18,
      hemiIntensity: 1.35,
    },
    update(dt) {
      dressing.update?.(dt);
    },
  };
}
