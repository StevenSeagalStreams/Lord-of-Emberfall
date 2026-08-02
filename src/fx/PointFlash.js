import * as THREE from 'three';

/**
 * Pooled point-light flashes.
 *
 * Crits and heavy hits want a real light hitting nearby geometry for one or
 * two frames -- a particle glow alone doesn't throw light on the floor or the
 * victim's own model. Allocating a `THREE.PointLight` per flash would grow
 * the light count without bound under sustained combat, so this is a small
 * ring buffer of pre-created lights: `trigger()` claims the next slot and
 * `update()` decays it back to zero on a fast-attack/exponential-release
 * envelope. Capacity is intentionally tiny -- these are a punctuation mark,
 * not ambient lighting, and Lighting.js already owns the shadow-casting
 * budget.
 */
export class PointFlashPool {
  constructor(scene, { capacity = 6 } = {}) {
    this.capacity = capacity;
    this._scene = scene;
    this._slots = [];
    for (let i = 0; i < capacity; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 6, 2.0);
      light.castShadow = false;
      light.visible = false;
      scene.add(light);
      this._slots.push({ light, t: 0, life: 0.001, peak: 0 });
    }
    this._cursor = 0;
  }

  /**
   * @param {{x:number,y:number,z:number}} position
   * @param {object} opts color, intensity (peak), distance, life (seconds)
   */
  trigger(position, opts = {}) {
    const slot = this._slots[this._cursor];
    this._cursor = (this._cursor + 1) % this.capacity;
    const { light } = slot;
    light.position.set(position.x, position.y, position.z);
    light.color.set(opts.color ?? 0xffffff);
    light.distance = opts.distance ?? 6;
    light.decay = 2.0;
    light.visible = true;
    slot.t = 0;
    slot.life = Math.max(0.02, opts.life ?? 0.22);
    slot.peak = opts.intensity ?? 40;
    light.intensity = 0;
  }

  update(dt) {
    for (const slot of this._slots) {
      if (!slot.light.visible) continue;
      slot.t += dt;
      const lifeT = slot.t / slot.life;
      if (lifeT >= 1) {
        slot.light.visible = false;
        slot.light.intensity = 0;
        continue;
      }
      // Fast attack (12% of life) then a decelerating decay -- reads as a
      // strike, not a light switch.
      const attack = 0.12;
      const k = lifeT < attack
        ? lifeT / attack
        : Math.pow(1 - (lifeT - attack) / (1 - attack), 1.7);
      slot.light.intensity = slot.peak * k;
    }
  }

  dispose() {
    for (const slot of this._slots) this._scene.remove(slot.light);
  }
}
