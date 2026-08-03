import * as THREE from 'three';
import { dropColor, dropLabel, dropRarity } from './Drops.js';

/**
 * Drops lying on the floor: the mesh, the floating label, and pickup.
 *
 * The beam itself is NOT built here -- the fx pillar already owns rarity
 * coloured loot beams and has been listening for `item:dropped` since before
 * anything emitted it (see src/fx/LootBeams.js). This module produces that
 * event and owns everything else.
 *
 * Pickup rules follow the genre rather than being invented:
 *   - **Gold is picked up by walking over it.** Nobody in this lineage clicks
 *     gold, and making them would add a click per kill to the core loop.
 *   - **Everything else is picked up by clicking it.** Clicking a drop that
 *     is out of reach walks there first and collects on arrival, so a click
 *     is never silently ignored.
 *
 * Labels are DOM, projected each frame, for the same reason the nameplates
 * are: crisp text at any distance with no texture atlas, and they cost
 * nothing when the list is empty.
 */

const PICKUP_RADIUS = 2.6;
const GOLD_MAGNET_RADIUS = 1.9;
/** Labels past this are not drawn -- a floor full of text is unreadable. */
const LABEL_RANGE = 26;
const MAX_LABELS = 14;

export class GroundItems {
  constructor(ctx) {
    this.scene = ctx.scene;
    this.bus = ctx.bus;
    this.world = ctx.world;
    this.camera = ctx.camera;
    this.input = ctx.input;

    /** @type {Array<{drop:object, mesh:THREE.Mesh, pos:THREE.Vector3, born:number}>} */
    this.items = [];
    this._t = 0;
    this._scratch = new THREE.Vector3();

    this._buildLabelLayer();
    this._shared = this._buildSharedGeometry();
  }

  _buildSharedGeometry() {
    // Three tiny shared geometries, one per drop kind, so a floor covered in
    // loot is still only a handful of draw calls' worth of unique geometry.
    return {
      gold: new THREE.SphereGeometry(0.16, 8, 6),
      potion: new THREE.CylinderGeometry(0.1, 0.13, 0.34, 7),
      equipment: new THREE.BoxGeometry(0.34, 0.1, 0.5),
    };
  }

  _buildLabelLayer() {
    const layer = document.createElement('div');
    layer.id = 'drop-label-layer';
    document.body.appendChild(layer);
    this.layer = layer;
    this.labels = [];
    for (let i = 0; i < MAX_LABELS; i++) {
      const el = document.createElement('div');
      el.className = 'drop-label';
      el.style.display = 'none';
      layer.appendChild(el);
      this.labels.push(el);
    }
  }

  /** Spawn one rolled drop into the world at a position. */
  spawn(drop, position) {
    const color = dropColor(drop);
    const geo = this._shared[drop.type] ?? this._shared.equipment;
    // Emissive above 1.0 so the bloom threshold catches it on presets that
    // have bloom, and so it stays visible in an unlit corridor regardless.
    const mat = new THREE.MeshStandardMaterial({
      color,
      emissive: new THREE.Color(color).multiplyScalar(0.9),
      emissiveIntensity: 1.4,
      roughness: 0.5,
      metalness: 0.3,
    });
    const mesh = new THREE.Mesh(geo, mat);
    const y = (this.world.zone?.terrain?.heightAt?.(position.x, position.z) ?? position.y ?? 0);
    mesh.position.set(position.x, y + 0.22, position.z);
    this.scene.add(mesh);

    const entry = { drop, mesh, pos: mesh.position.clone(), born: this._t, label: dropLabel(drop) };
    this.items.push(entry);

    // The fx pillar's loot beam listens for exactly this.
    this.bus.emit('item:dropped', {
      item: { rarity: dropRarity(drop) },
      position: mesh.position.clone(),
      drop,
    });
    return entry;
  }

  /** Scatter a kill's drops so they never stack into one unclickable pile. */
  spawnAll(drops, position, rng) {
    const out = [];
    for (let i = 0; i < drops.length; i++) {
      const a = rng ? rng.next() * Math.PI * 2 : (i / drops.length) * Math.PI * 2;
      const r = 0.35 + (rng ? rng.next() : 0.5) * 0.85;
      const p = {
        x: position.x + Math.cos(a) * r,
        y: position.y ?? 0,
        z: position.z + Math.sin(a) * r,
      };
      out.push(this.spawn(drops[i], p));
    }
    return out;
  }

  /**
   * @param {number} dt
   * @param {*} player
   * @returns {Array} drops collected this frame, for the owner to apply
   */
  update(dt, player) {
    this._t += dt;
    const collected = [];
    if (!player) return collected;

    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];

      // A slow bob and spin: motion is what makes a small object on a dark
      // floor register as a *thing to take* rather than as scenery.
      const age = this._t - it.born;
      it.mesh.position.y = it.pos.y + Math.sin(age * 2.2) * 0.06;
      it.mesh.rotation.y += dt * 1.5;

      const dx = player.position.x - it.pos.x;
      const dz = player.position.z - it.pos.z;
      const distSq = dx * dx + dz * dz;

      // Gold collects by walking over it.
      if (it.drop.type === 'gold' && distSq < GOLD_MAGNET_RADIUS * GOLD_MAGNET_RADIUS) {
        collected.push(it.drop);
        this._remove(i);
        continue;
      }

      // A queued click-to-pick that we have now walked into range of.
      if (it.wanted && distSq < PICKUP_RADIUS * PICKUP_RADIUS) {
        collected.push(it.drop);
        this._remove(i);
      }
    }

    this._updateLabels(player);
    return collected;
  }

  /**
   * Click handling. Returns true if the click was consumed by a drop, so the
   * caller does not also issue a move order to the same point.
   */
  handleClick(worldX, worldZ, player) {
    let best = -1;
    let bestD = 1.4 * 1.4;   // click tolerance around the drop
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      const dx = worldX - it.pos.x;
      const dz = worldZ - it.pos.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0) return false;

    const it = this.items[best];
    const px = player.position.x - it.pos.x;
    const pz = player.position.z - it.pos.z;
    if (px * px + pz * pz <= PICKUP_RADIUS * PICKUP_RADIUS) {
      return { collect: it.drop, index: best };
    }
    // Out of reach: remember the intent and walk there. Collected on arrival
    // by update() above, so a click is never silently dropped.
    it.wanted = true;
    return { walkTo: { x: it.pos.x, z: it.pos.z } };
  }

  collectAt(index) {
    const it = this.items[index];
    if (!it) return null;
    this._remove(index);
    return it.drop;
  }

  _remove(i) {
    const it = this.items[i];
    it.mesh.removeFromParent();
    it.mesh.material.dispose();
    this.items.splice(i, 1);
    this.bus.emit('item:pickup', { drop: it.drop, position: it.pos.clone() });
  }

  _updateLabels(player) {
    const cam = this.camera;
    let n = 0;
    if (cam) {
      // Nearest-first so a crowded floor shows the drops you can actually
      // reach rather than an arbitrary slice.
      const near = this.items
        .map((it) => ({ it, d: it.pos.distanceToSquared(player.position) }))
        .filter((e) => e.d < LABEL_RANGE * LABEL_RANGE)
        .sort((a, b) => a.d - b.d)
        .slice(0, MAX_LABELS);

      for (const { it } of near) {
        const el = this.labels[n];
        this._scratch.set(it.pos.x, it.mesh.position.y + 0.55, it.pos.z).project(cam);
        if (this._scratch.z >= 1) continue;
        el.style.display = 'block';
        el.textContent = it.label;
        el.style.color = `#${dropColor(it.drop).toString(16).padStart(6, '0')}`;
        el.style.transform =
          `translate(${((this._scratch.x * 0.5 + 0.5) * innerWidth).toFixed(1)}px, ` +
          `${((1 - (this._scratch.y * 0.5 + 0.5)) * innerHeight).toFixed(1)}px)`;
        n++;
      }
    }
    for (let i = n; i < this.labels.length; i++) this.labels[i].style.display = 'none';
  }

  clear() {
    for (const it of this.items) { it.mesh.removeFromParent(); it.mesh.material.dispose(); }
    this.items.length = 0;
  }
}
