import * as THREE from 'three';
import { DungeonGen } from '../DungeonGen.js';
import { LevelBuilder, TILE } from '../LevelBuilder.js';
import { NavGrid } from '../Nav.js';
import { decorate } from '../Props.js';

/**
 * Zone 2 -- the catacombs.
 *
 * Enclosed, oppressive, lit almost entirely by fire. This is the Diablo I
 * register: the player's own torch is the main light source, and the room you
 * are in is the only room that exists.
 */
export async function createCatacombs(ctx) {
  const { scene, rng, materials, lighting } = ctx;
  const group = new THREE.Group();
  group.name = 'Zone:catacombs';

  const gen = new DungeonGen({ width: 88, height: 88, rng: rng.fork('catacombs') });
  const dungeon = gen.generate();

  const level = new LevelBuilder(dungeon, materials, { rng: rng.fork('catacombs-level') });
  group.add(level.build());

  const colliders = level.colliders;
  const nav = new NavGrid(colliders);

  const props = decorate({ ...ctx, dungeon, level, group });
  if (props?.group) group.add(props.group);

  const torches = placeTorches({ dungeon, lighting, rng: rng.fork('catacombs-torches'), group });

  const spawns = [];
  for (const room of dungeon.rooms) {
    if (room.kind === 'entrance') continue;
    const count = room.kind === 'boss' ? 6 : rng.int(1, 4);
    for (let i = 0; i < count; i++) {
      spawns.push({
        kind: room.kind === 'boss' ? 'brute' : 'skeleton',
        position: new THREE.Vector3(
          (room.x + rng.range(1, room.w - 1)) * TILE, 0,
          (room.y + rng.range(1, room.h - 1)) * TILE
        ),
      });
    }
  }

  scene.add(group);

  return {
    name: 'catacombs',
    group, colliders, nav, dungeon, level, spawns,
    torchCount: torches,
    spawnPoint: new THREE.Vector3(dungeon.entrance.cx * TILE, 0, dungeon.entrance.cy * TILE),
    bounds: { minX: 0, maxX: dungeon.width * TILE, minZ: 0, maxZ: dungeon.height * TILE },
    fog: { color: 0x05070c, density: 0.0135 },
    // Cold, crushed, high-contrast. The catacombs should feel airless.
    grade: {
      exposure: 1.30, contrast: 1.10, saturation: 0.96,
      shadowTint: [0.26, 0.36, 0.62], shadowTintAmt: 0.18,
      highlightTint: [1.00, 0.84, 0.58], highlightAmt: 0.12,
      vignette: 0.58,
    },
    update(dt) { props?.update?.(dt); },
  };
}

/**
 * Wall-mounted torches on cells that face into a room, spaced so the level has
 * a rhythm of light and dark rather than uniform glow.
 */
function placeTorches({ dungeon, lighting, rng, group }) {
  const candidates = [];
  for (const room of dungeon.rooms) {
    for (let y = room.y - 1; y <= room.y + room.h; y++) {
      for (let x = room.x - 1; x <= room.x + room.w; x++) {
        if (!dungeon.isSolid(x, y)) continue;
        const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => dungeon.isFloor(x + dx, y + dy));
        if (n.length !== 1) continue;
        candidates.push({ x, y, dir: n[0] });
      }
    }
  }
  rng.shuffle(candidates);

  const placed = [];
  for (const c of candidates) {
    const wx = c.x * TILE + c.dir[0] * TILE * 0.55;
    const wz = c.y * TILE + c.dir[1] * TILE * 0.55;
    if (placed.some((p) => Math.hypot(p.x - wx, p.z - wz) < 7.5)) continue;
    placed.push({ x: wx, z: wz });

    const pos = new THREE.Vector3(wx, 2.5, wz);
    const isBlue = rng.bool(0.10);
    lighting.addTorch(pos, {
      kind: isBlue ? 'magic' : 'torch',
      color: isBlue ? 0x5da8ff : 0xff8c3a,
      intensity: isBlue ? 22 : 34,
      distance: isBlue ? 17 : 21,
      castShadow: true,
    });

    const bracket = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.07, 0.5, 6),
      new THREE.MeshStandardMaterial({ color: 0x2a2620, roughness: 0.8, metalness: 0.4 })
    );
    bracket.position.set(wx, 2.15, wz);
    bracket.castShadow = true;
    group.add(bracket);

    // The visible flame itself is owned by the VFX system, which subscribes to
    // this request and attaches real animated fire.
    lighting.scene.userData.flameRequests = lighting.scene.userData.flameRequests || [];
    lighting.scene.userData.flameRequests.push({ position: pos.clone(), kind: isBlue ? 'magic' : 'torch' });

    if (placed.length > 90) break;
  }
  return placed.length;
}
