import * as THREE from 'three';
import { CELL } from './DungeonGen.js';
import { RNG } from '../core/RNG.js';

export const TILE = 2.0;          // world units per grid cell
export const WALL_HEIGHT = 4.6;

/**
 * Turns a dungeon grid into renderable geometry.
 *
 * Everything is instanced: at 96x96 a dense level is ~4000 floor tiles and
 * ~3000 wall blocks, which as individual meshes would be 7000 draw calls and
 * would tank the frame. As two InstancedMeshes it is two.
 *
 * Per-instance variation (height jitter, rotation snap, tint) is what keeps
 * instancing from looking like a spreadsheet. A perfectly flat floor at this
 * camera angle is the single loudest "this is a tech demo" signal.
 */
export class LevelBuilder {
  constructor(dungeon, materials, opts = {}) {
    this.dungeon = dungeon;
    this.materials = materials;
    this.rng = opts.rng instanceof RNG ? opts.rng : new RNG(dungeon.seed ^ 0xabcdef);
    this.group = new THREE.Group();
    this.group.name = 'Level';
    this.colliders = null;
  }

  /** grid cell -> world centre */
  static cellToWorld(x, y, out = new THREE.Vector3()) {
    return out.set(x * TILE, 0, y * TILE);
  }

  /** world -> grid cell */
  static worldToCell(v) {
    return { x: Math.round(v.x / TILE), y: Math.round(v.z / TILE) };
  }

  build() {
    const d = this.dungeon;
    const rng = this.rng;

    const floorCells = [];
    const wallCells = [];
    for (let y = 0; y < d.height; y++) {
      for (let x = 0; x < d.width; x++) {
        const c = d.grid[y * d.width + x];
        if (c === CELL.FLOOR) floorCells.push([x, y]);
        else if (c === CELL.WALL) wallCells.push([x, y]);
      }
    }

    this.group.add(this._buildFloor(floorCells));
    this.group.add(this._buildWalls(wallCells));

    // No ceiling geometry: the camera sits above wall height, so any cap
    // occludes the whole level. Fog plus a black clear colour does the same
    // job -- wall tops fade into void instead of silhouetting against a plane.

    this.colliders = this._buildCollisionGrid();
    this.floorCells = floorCells;
    this.wallCells = wallCells;
    return this.group;
  }

  _buildFloor(cells) {
    const rng = this.rng;
    const geo = new THREE.BoxGeometry(TILE, 0.6, TILE);
    const mat = this.materials.floor;
    const mesh = new THREE.InstancedMesh(geo, mat, cells.length);
    mesh.name = 'Floor';
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const color = new THREE.Color();
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cells.length * 3), 3);

    for (let i = 0; i < cells.length; i++) {
      const [x, y] = cells[i];
      // Sub-millimetre height jitter: invisible as displacement, but it breaks
      // the perfectly coplanar specular sheet that screams "grid".
      const dy = rng.range(-0.035, 0.02);
      pos.set(x * TILE, -0.3 + dy, y * TILE);
      // 90-degree rotation snaps decorrelate the texture without seams.
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng.int(0, 3) * Math.PI / 2);
      scl.set(1, 1, 1);
      m.compose(pos, q, scl);
      mesh.setMatrixAt(i, m);

      const v = rng.range(0.78, 1.12);
      const warm = rng.range(-0.03, 0.05);
      color.setRGB(v + warm, v, v - warm * 0.6);
      mesh.setColorAt(i, color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    return mesh;
  }

  _buildWalls(cells) {
    const rng = this.rng;
    const geo = new THREE.BoxGeometry(TILE, WALL_HEIGHT, TILE);
    const mat = this.materials.wall;
    const mesh = new THREE.InstancedMesh(geo, mat, cells.length);
    mesh.name = 'Walls';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const axis = new THREE.Vector3(0, 1, 0);
    const color = new THREE.Color();
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cells.length * 3), 3);

    for (let i = 0; i < cells.length; i++) {
      const [x, y] = cells[i];
      const h = WALL_HEIGHT * rng.range(0.94, 1.14);
      pos.set(x * TILE, h / 2 - 0.6, y * TILE);
      q.setFromAxisAngle(axis, rng.int(0, 3) * Math.PI / 2);
      scl.set(rng.range(0.985, 1.015), h / WALL_HEIGHT, rng.range(0.985, 1.015));
      m.compose(pos, q, scl);
      mesh.setMatrixAt(i, m);

      const v = rng.range(0.72, 1.06);
      color.setRGB(v, v * rng.range(0.97, 1.0), v * rng.range(0.94, 1.0));
      mesh.setColorAt(i, color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    return mesh;
  }

  _buildVoidCap() {
    const d = this.dungeon;
    const geo = new THREE.PlaneGeometry(d.width * TILE * 1.6, d.height * TILE * 1.6);
    const mat = new THREE.MeshBasicMaterial({ color: 0x03050a, side: THREE.DoubleSide, fog: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = Math.PI / 2;
    mesh.position.set((d.width * TILE) / 2, WALL_HEIGHT + 1.2, (d.height * TILE) / 2);
    mesh.name = 'VoidCap';
    mesh.renderOrder = -10;
    return mesh;
  }

  _buildCollisionGrid() {
    const d = this.dungeon;
    const solid = new Uint8Array(d.width * d.height);
    for (let i = 0; i < solid.length; i++) solid[i] = d.grid[i] === CELL.FLOOR ? 0 : 1;
    return {
      width: d.width,
      height: d.height,
      solid,
      isSolidCell: (x, y) =>
        x < 0 || y < 0 || x >= d.width || y >= d.height || solid[y * d.width + x] === 1,
      /** world-space solidity test with a body radius */
      isBlocked(wx, wz, radius = 0.45) {
        const minX = Math.round((wx - radius) / TILE);
        const maxX = Math.round((wx + radius) / TILE);
        const minY = Math.round((wz - radius) / TILE);
        const maxY = Math.round((wz + radius) / TILE);
        for (let y = minY; y <= maxY; y++) {
          for (let x = minX; x <= maxX; x++) {
            if (this.isSolidCell(x, y)) {
              // Narrow-phase: cell AABB vs circle, so you can clip a corner
              // diagonally instead of catching on invisible cell boundaries.
              const cx = x * TILE, cy = y * TILE;
              const nx = Math.max(cx - TILE / 2, Math.min(wx, cx + TILE / 2));
              const ny = Math.max(cy - TILE / 2, Math.min(wz, cy + TILE / 2));
              const dx = wx - nx, dy = wz - ny;
              if (dx * dx + dy * dy < radius * radius) return true;
            }
          }
        }
        return false;
      },
    };
  }
}
