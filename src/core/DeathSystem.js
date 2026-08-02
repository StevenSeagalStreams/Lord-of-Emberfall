import * as THREE from 'three';

/**
 * Death, the corpse run, and the ghost walk.
 *
 * From the direction mandate: "Death: you drop a corpse with your equipped
 * gear. Corpse-run naked to retrieve it. Death must hurt or pulls carry no
 * weight." And from the playtest: there was no way to continue at all once you
 * died, which made the whole loop a dead end.
 *
 * The design is WoW's, because it makes death cost *time* rather than
 * progress: you release, you re-form as a spirit at the last checkpoint you
 * touched, and you walk back. The walk is the punishment. It is long enough to
 * sting and short enough that you do not quit.
 *
 * Implementation note on ownership: this file drives the player directly while
 * ghosting instead of routing through `Entity.update`, because a dead entity
 * deliberately refuses to move and that rule belongs to the combat pillar. The
 * ghost is not an entity state; it is the death system borrowing the body.
 */

const GHOST_SPEED_MULT = 1.35;   // faster than living -- the walk is a tax, not a slog
const RECLAIM_RADIUS = 2.2;      // how close the spirit must get to its corpse
const RELEASE_DELAY = 1.6;       // beat on the death screen before release is offered
const CHECKPOINT_TOUCH_RADIUS = 3.0;

export class DeathSystem {
  constructor(game) {
    this.game = game;
    this.state = 'alive';        // alive | dead | ghost
    this.timer = 0;

    /** @type {THREE.Vector3|null} where the body fell */
    this.corpsePos = null;
    this.corpseMesh = null;
    this.corpseLight = null;

    this.checkpoints = [];
    this.activeCheckpoint = null;
    this.checkpointMeshes = [];

    this.deaths = 0;
    this._ghostMats = [];
    this._tmp = new THREE.Vector3();

    this._buildOverlay();
  }

  // ------------------------------------------------------------- checkpoints

  /**
   * Checkpoints are derived from the zone rather than authored per-zone, so a
   * new zone gets them for free. The mandate puts resting spots only at wing
   * boundaries, so we take the entrance plus the most widely separated rooms
   * rather than sprinkling one everywhere -- a checkpoint every corner would
   * make death free.
   */
  installCheckpoints(zone) {
    this.checkpoints.length = 0;
    for (const m of this.checkpointMeshes) m.removeFromParent();
    this.checkpointMeshes.length = 0;

    const pts = Array.isArray(zone.checkpoints) && zone.checkpoints.length
      ? zone.checkpoints.map((p) => new THREE.Vector3(p.x, p.y ?? 0, p.z))
      : this._deriveCheckpoints(zone);

    for (const p of pts) this._addCheckpoint(p);
    this.activeCheckpoint = this.checkpoints[0] || null;
  }

  _deriveCheckpoints(zone) {
    const out = [zone.spawnPoint.clone()];
    const rooms = zone.dungeon?.rooms;
    if (rooms && rooms.length) {
      const TILE = 2.0;
      // Greedy farthest-point selection: each new checkpoint is the room
      // furthest from every checkpoint already chosen, which spreads them
      // across the level instead of clustering near the entrance.
      const candidates = rooms.map((r) => new THREE.Vector3(r.cx * TILE, 0, r.cy * TILE));
      const want = Math.min(4, Math.max(1, Math.floor(rooms.length / 6)));
      for (let i = 0; i < want; i++) {
        let best = null, bestD = -1;
        for (const c of candidates) {
          let nearest = Infinity;
          for (const chosen of out) nearest = Math.min(nearest, c.distanceToSquared(chosen));
          if (nearest > bestD) { bestD = nearest; best = c; }
        }
        if (!best || bestD < 400) break;   // < 20 units apart is not a new wing
        out.push(best.clone());
      }
    }
    return out;
  }

  _addCheckpoint(pos) {
    const y = this.game.zone?.terrain?.heightAt?.(pos.x, pos.z) ?? pos.y ?? 0;
    const p = new THREE.Vector3(pos.x, y, pos.z);
    this.checkpoints.push(p);

    // A shrine the player can actually see and aim for. Cheap: two small
    // meshes and one light, only a handful per level.
    const stone = new THREE.Mesh(
      new THREE.CylinderGeometry(0.34, 0.46, 1.5, 7),
      new THREE.MeshStandardMaterial({ color: 0x4a4a52, roughness: 0.85, metalness: 0.05 })
    );
    stone.position.set(p.x, p.y + 0.75, p.z);
    stone.castShadow = true;
    stone.receiveShadow = true;

    // Above 1.0 so the HDR bloom threshold catches it -- a checkpoint should
    // read as a beacon across a dark room.
    const flame = new THREE.Mesh(
      new THREE.SphereGeometry(0.18, 10, 8),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 1.5, 0.5), fog: false })
    );
    flame.position.set(p.x, p.y + 1.7, p.z);

    const light = new THREE.PointLight(0xffc070, 9, 12, 2);
    light.position.copy(flame.position);

    this.game.scene.add(stone, flame, light);
    this.checkpointMeshes.push(stone, flame, light);
  }

  // ------------------------------------------------------------------ update

  update(dt) {
    const g = this.game;
    const player = g.player;
    if (!player) return;

    switch (this.state) {
      case 'alive': {
        this._touchCheckpoints(player.position);
        if (!player.alive) this._onDeath();
        break;
      }

      case 'dead': {
        this.timer += dt;
        if (this.timer >= RELEASE_DELAY) {
          this._setOverlay('release');
          // Space or click releases the spirit.
          if (g.input.pressed('Space') || g.input.mousePressed('left')) this._release();
        }
        break;
      }

      case 'ghost': {
        this._updateGhost(dt);
        break;
      }
      default: break;
    }
  }

  _touchCheckpoints(pos) {
    for (const c of this.checkpoints) {
      if (c === this.activeCheckpoint) continue;
      if (pos.distanceToSquared(c) < CHECKPOINT_TOUCH_RADIUS * CHECKPOINT_TOUCH_RADIUS) {
        this.activeCheckpoint = c;
        this.game.bus.emit('checkpoint:reached', { position: c.clone() });
      }
    }
  }

  _onDeath() {
    this.state = 'dead';
    this.timer = 0;
    this.deaths++;

    const p = this.game.player;
    this.corpsePos = p.position.clone();

    // The corpse is the destination, so it has to be findable across a dark
    // room: a marker plus a cold light, deliberately a different colour from
    // the warm checkpoint beacons so the two never read as the same thing.
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.3, 10, 8),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 0.9, 2.6), fog: false })
    );
    marker.position.set(this.corpsePos.x, this.corpsePos.y + 0.9, this.corpsePos.z);
    const glow = new THREE.PointLight(0x88bbff, 6, 14, 2);
    glow.position.copy(marker.position);
    this.game.scene.add(marker, glow);
    this.corpseMesh = marker;
    this.corpseLight = glow;

    this._setOverlay('dead');
    this.game.bus.emit('player:died', { position: this.corpsePos.clone(), deaths: this.deaths });
  }

  _release() {
    const g = this.game;
    const p = g.player;

    const target = this.activeCheckpoint || this.checkpoints[0] || this.corpsePos;
    p.position.copy(target);
    p.clearPath?.();
    p.velocity?.set(0, 0, 0);
    g.rig.snapTo(p.position);

    this._setGhostVisual(true);
    this.state = 'ghost';
    this._setOverlay('ghost');
    g.bus.emit('player:ghost', { from: target.clone(), corpse: this.corpsePos.clone() });
  }

  /**
   * Ghost movement. Deliberately does not go through `Entity.update` -- a dead
   * entity refuses to move by design, and that rule belongs to combat. The
   * spirit steers straight toward the cursor, ignores collision (it is a
   * ghost), and cannot act.
   */
  _updateGhost(dt) {
    const g = this.game;
    const p = g.player;

    if (g.input.mouseDown('left') && g.input.groundValid) {
      this._tmp.set(g.input.ground.x - p.position.x, 0, g.input.ground.z - p.position.z);
      const d = this._tmp.length();
      if (d > 0.15) {
        this._tmp.multiplyScalar(1 / d);
        const speed = (p.moveSpeed || 5) * GHOST_SPEED_MULT;
        p.position.x += this._tmp.x * speed * dt;
        p.position.z += this._tmp.z * speed * dt;
        const y = g.zone?.terrain?.heightAt?.(p.position.x, p.position.z);
        if (Number.isFinite(y)) p.position.y = y;
        p.facing = p.targetFacing = Math.atan2(this._tmp.x, this._tmp.z);
        p.object.rotation.y = p.facing;
      }
    }

    // Animate the rig as a slow walk so the spirit does not slide as a statue.
    p.animator?.update?.(dt, { speed: 1.2, facing: p.facing });

    if (this.corpsePos &&
        p.position.distanceToSquared(this.corpsePos) < RECLAIM_RADIUS * RECLAIM_RADIUS) {
      this._resurrect();
    }
  }

  _resurrect() {
    const g = this.game;
    const p = g.player;

    p.alive = true;
    p.deathTimer = 0;
    // Resurrection sickness in the genre's grammar: you come back weak, so
    // dying still costs something after the walk is over.
    p.health = Math.max(1, Math.floor(p.maxHealth * 0.35));
    p.mana = Math.max(0, Math.floor(p.maxMana * 0.25));
    p.animator.dead = false;
    p.animator.deathTime = 0;
    p.animator.deathSeed = null;
    p.clearPath?.();
    p.target = null;

    this._setGhostVisual(false);
    this._clearCorpse();
    this.state = 'alive';
    this._setOverlay(null);
    g.bus.emit('player:resurrected', { position: p.position.clone() });
  }

  _clearCorpse() {
    this.corpseMesh?.removeFromParent();
    this.corpseLight?.removeFromParent();
    this.corpseMesh = null;
    this.corpseLight = null;
    this.corpsePos = null;
  }

  /** Wash the rig translucent and cold, then put it back exactly as it was. */
  _setGhostVisual(on) {
    const rig = this.game.player?.rig;
    if (!rig) return;

    if (on) {
      this._ghostMats.length = 0;
      for (const part of rig.parts) {
        const mat = Array.isArray(part.material) ? part.material[0] : part.material;
        if (!mat) continue;
        this._ghostMats.push({
          mat,
          transparent: mat.transparent,
          opacity: mat.opacity,
          color: mat.color ? mat.color.clone() : null,
          emissive: mat.emissive ? mat.emissive.clone() : null,
        });
        mat.transparent = true;
        mat.opacity = 0.34;
        mat.color?.setRGB(0.45, 0.65, 0.95);
        mat.emissive?.setRGB(0.06, 0.12, 0.22);
      }
    } else {
      for (const s of this._ghostMats) {
        s.mat.transparent = s.transparent;
        s.mat.opacity = s.opacity;
        if (s.color) s.mat.color.copy(s.color);
        if (s.emissive) s.mat.emissive.copy(s.emissive);
      }
      this._ghostMats.length = 0;
    }
  }

  // ----------------------------------------------------------------- overlay

  _buildOverlay() {
    const el = document.createElement('div');
    el.id = 'death-overlay';
    el.innerHTML = `
      <div class="death-inner">
        <div class="death-title"></div>
        <div class="death-sub"></div>
      </div>`;
    document.body.appendChild(el);
    this.overlay = el;
    this.overlayTitle = el.querySelector('.death-title');
    this.overlaySub = el.querySelector('.death-sub');
    el.style.display = 'none';
  }

  _setOverlay(mode) {
    const el = this.overlay;
    if (!mode) { el.style.display = 'none'; el.className = ''; return; }
    el.style.display = 'grid';
    el.className = `mode-${mode}`;
    if (mode === 'dead') {
      this.overlayTitle.textContent = 'YOU HAVE DIED';
      this.overlaySub.textContent = '';
    } else if (mode === 'release') {
      this.overlayTitle.textContent = 'YOU HAVE DIED';
      this.overlaySub.textContent = 'click or press space to release your spirit';
    } else if (mode === 'ghost') {
      this.overlayTitle.textContent = '';
      this.overlaySub.textContent = 'hold the mouse to walk — return to your corpse to live again';
    }
  }
}
