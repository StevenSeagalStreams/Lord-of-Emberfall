import * as THREE from 'three';

import { EventBus } from './core/EventBus.js';
import { RNG } from './core/RNG.js';
import { Input } from './core/Input.js';

import { createRenderer, applyQuality, handleResize } from './render/Renderer.js';
import { CameraRig } from './render/CameraRig.js';
import { PostFX } from './render/PostFX.js';
import { Lighting } from './render/Lighting.js';
import { MaterialLibrary } from './render/Materials.js';

import { TILE } from './world/LevelBuilder.js';
import { createZone, applyZoneLook, DEFAULT_ZONE } from './world/zones/index.js';

import { Player } from './entities/Player.js';
import { Monster } from './entities/Monster.js';
import { resolveOverlaps } from './entities/Entity.js';

import { HUD } from './ui/HUD.js';
import { Settings } from './ui/Settings.js';
import { DebugConsole } from './core/Console.js';
import { Telemetry } from './core/Telemetry.js';
import { PerfMonitor } from './core/PerfMonitor.js';
import { DeathSystem } from './core/DeathSystem.js';

import { createFX } from './fx/index.js';
import { createAudio } from './audio/index.js';
import { createItems } from './items/index.js';
import { createSkills } from './skills/index.js';

/**
 * Game bootstrap and main loop.
 *
 * `world` is the single object every subsystem receives. Adding a subsystem
 * means hanging it here and calling it from the fixed list of update phases
 * below -- the ordering of those phases is load-bearing (input before AI,
 * AI before physics, physics before camera, camera before render).
 */
class Game {
  constructor() {
    this.canvas = document.getElementById('viewport');
    this.uiRoot = document.getElementById('ui-root');
    this.boot = document.getElementById('boot');

    // A URL seed makes screenshots reproducible across critic iterations.
    const params = new URLSearchParams(location.search);
    this.seed = Number(params.get('seed') ?? 20250731) >>> 0;
    // STABILIZE.md: default to the cheapest preset until 60 FPS is PROVEN on
    // the real machine. Captures and the critic harness opt into 'ultra'
    // explicitly via the URL; players start at 'low' and may step up.
    this.qualityName = params.get('quality') ?? 'low';
    this.paused = params.get('paused') === '1';
    this.zoneName = params.get('zone') ?? DEFAULT_ZONE;

    this.rng = new RNG(this.seed);
    this.bus = new EventBus();

    this.scene = new THREE.Scene();
    this.scene.name = 'World';

    this.renderer = createRenderer(this.canvas);
    this.quality = applyQuality(this.renderer, this.qualityName);

    this.rig = new CameraRig({ elevation: 34, azimuth: 45, distance: 34 });
    this.camera = this.rig.camera;

    this.input = new Input(this.canvas);
    this.clock = new THREE.Clock();

    this.entities = [];
    this.monsters = [];

    /** Shared context handed to every entity update. */
    this.world = {
      scene: this.scene,
      bus: this.bus,
      rng: this.rng,
      camera: this.camera,
      colliders: null,
      nav: null,
      player: null,
      entities: this.entities,
      monsters: this.monsters,
      time: 0,
    };

    this.ready = false;
    this.frame = 0;
    this._fpsAccum = 0;
    this._fpsFrames = 0;
    this.fps = 0;
  }

  async init() {
    this._status('quarrying stone', 0.1);
    const materials = await new MaterialLibrary({ size: 512 }).build();
    this.materials = materials;

    // Lighting exists before the zone so a zone can register its own emitters
    // and hand back a rig override during construction.
    this.lighting = new Lighting(this.scene, {
      shadowSize: this.quality.shadowSize,
      // Driven by the preset, and zero below `high` -- see Lighting's own
      // note on why cube-map point shadows are the expensive thing here.
      shadowBudget: this.quality.shadowBudget ?? 0,
    });

    this._status(`entering the ${this.zoneName}`, 0.45);
    this.zone = await createZone(this.zoneName, {
      scene: this.scene,
      rng: this.rng.fork(`zone:${this.zoneName}`),
      materials,
      lighting: this.lighting,
      quality: this.quality,
    });

    this.world.colliders = this.zone.colliders;
    this.world.nav = this.zone.nav;
    this.world.zone = this.zone;
    this.dungeon = this.zone.dungeon || null;
    this.level = this.zone.level || null;
    this.torchCount = this.zone.torchCount || 0;

    this._status('waking the dead', 0.85);
    this._spawnActors();

    // Hero light. Every ARPG in this lineage cheats one: a soft warm point
    // light riding the player so the character stays readable in unlit
    // stretches. Without it the hero vanishes between torches, which reads as
    // a bug rather than as atmosphere.
    this.heroLight = new THREE.PointLight(0xffd2a0, 14, 11, 2.0);
    this.heroLight.position.set(0, 2.2, 0);
    this.scene.add(this.heroLight);

    this._status('binding the sigils', 0.94);
    this.postfx = new PostFX(this.renderer, this.scene, this.camera, this.quality);
    this.hud = new HUD(this.uiRoot);
    this.settings = new Settings(this);
    // Restore the player's own brightness before the first visible frame, so
    // it never flashes at the default and then correct itself.
    this.postfx.loadBrightness();
    this.settings.brightness.value = String(this.postfx.grade.uniforms.brightness.value);

    // The zone owns its own look: colour grade, fog, and light rig bias.
    applyZoneLook(this.zone, this.postfx, this.lighting);

    // Subsystems. Each owns a directory, is constructed once with the shared
    // context, and is ticked from exactly one phase of the loop below.
    // Playtest instrumentation. Built before the subsystems so telemetry is
    // subscribed to the bus in time to catch their first events.
    // Frame-rate readout + automatic quality governor (STABILIZE.md rule 0).
    // Built before the subsystems so it is already sampling during the first
    // frames, which are the expensive ones.
    this.perf = new PerfMonitor(this);
    this.telemetry = new Telemetry(this);
    this.console = new DebugConsole(this);

    // Death, the corpse run and the ghost walk. Installed after the zone so it
    // can derive checkpoints from the level's own rooms.
    this.death = new DeathSystem(this);
    this.death.installCheckpoints(this.zone);

    this.fx = createFX(this._ctx());
    this.audio = createAudio(this._ctx());
    this.items = createItems(this._ctx());
    this.skills = createSkills(this._ctx());
    this.subsystems = [this.fx, this.audio, this.items, this.skills, this.zone];

    addEventListener('resize', () => {
      handleResize(this.renderer, this.camera, null);
      const s = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      this.postfx.setSize(s.x, s.y);
    });

    // Warm the shader cache before the first visible frame, otherwise the
    // opening second is a slideshow while WebGL compiles every program.
    this.renderer.compile(this.scene, this.camera);

    this._status('ready', 1.0);
    this.ready = true;
    setTimeout(() => this.boot.classList.add('hidden'), 260);

    // Test hook for the headless screenshot harness.
    window.__game = this;
    window.__ready = true;
  }

  /** Context handed to every subsystem factory. */
  _ctx() {
    return {
      scene: this.scene,
      camera: this.camera,
      renderer: this.renderer,
      bus: this.bus,
      rng: this.rng,
      world: this.world,
      dungeon: this.dungeon,
      level: this.level,
      lighting: this.lighting,
      materials: this.materials,
      uiRoot: this.uiRoot,
      input: this.input,
      get player() { return this.world.player; },
    };
  }

  _status(text, progress) {
    const s = this.boot?.querySelector('.boot-status');
    const bar = this.boot?.querySelector('.boot-bar > i');
    if (s) s.textContent = text;
    if (bar) bar.style.width = `${Math.round(progress * 100)}%`;
  }

  _spawnActors() {
    const rng = this.rng.fork('actors');
    const zone = this.zone;

    const player = new Player();
    player.position.copy(zone.spawnPoint);
    this.scene.add(player.object);
    this.entities.push(player);
    this.player = player;
    this.world.player = player;
    this.rig.snapTo(player.position);

    // `god` is honoured here rather than inside Entity.damage, which belongs
    // to the combat pillar. Wrapping the bound method keeps the cheat entirely
    // inside the debug surface that owns it.
    const baseDamage = player.damage.bind(player);
    player.damage = (amount, source, opts) => (player.godMode ? 0 : baseDamage(amount, source, opts));

    // The zone decides where and what spawns; the loop only instantiates.
    for (const spawn of zone.spawns || []) {
      // Pass only what the zone legitimately knows. Every combat stat comes
      // from the per-kind profile in src/combat/MonsterProfiles.js, which is
      // the single source of truth -- a flat fallback here would silently
      // flatten the swarmer/skeleton split back into identical monsters.
      // `height` stays per-spawn because it is harmless visual variety.
      const m = new Monster({
        kind: spawn.kind,
        height: spawn.height ?? rng.range(1.6, 1.86),
        ...(spawn.overrides || {}),
      });
      m.position.copy(spawn.position);
      m.spawnPoint.copy(m.position);
      m.facing = m.targetFacing = rng.range(-Math.PI, Math.PI);
      this.scene.add(m.object);
      this.entities.push(m);
      this.monsters.push(m);
    }
  }

  /**
   * Spawn monsters in a ring around the player. Used by the debug console so a
   * playtester can set up a specific fight in one command instead of hunting
   * for one.
   */
  spawnMonsters(kind, count = 1) {
    const rng = this.rng;
    let spawned = 0;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + rng.range(-0.2, 0.2);
      const r = 4 + rng.range(0, 3);
      const x = this.player.position.x + Math.sin(a) * r;
      const z = this.player.position.z + Math.cos(a) * r;
      if (this.world.colliders?.isBlocked(x, z, 0.6)) continue;
      let m;
      try {
        m = new Monster({ kind, height: rng.range(1.6, 1.86) });
      } catch (err) {
        console.warn('spawnMonsters failed', err);
        return spawned;
      }
      m.position.set(x, this.zone?.terrain?.heightAt?.(x, z) ?? 0, z);
      m.spawnPoint.copy(m.position);
      m.facing = m.targetFacing = rng.range(-Math.PI, Math.PI);
      this.scene.add(m.object);
      this.entities.push(m);
      this.monsters.push(m);
      this.bus.emit('entity:spawned', { entity: m });
      spawned++;
    }
    return spawned;
  }

  // -------------------------------------------------------------- main loop

  start() {
    const loop = () => {
      requestAnimationFrame(loop);
      this.tick();
    };
    loop();
  }

  tick() {
    if (!this.ready) return;
    // Clamp dt: a background tab returns a multi-second delta that would
    // teleport every actor through walls.
    const dt = Math.min(this.clock.getDelta(), 1 / 20);
    this.frame++;
    this.world.time += dt;

    if (!this.paused) {
      this.death.update(dt);
      // While dead or ghosting the death system owns the player entirely --
      // it moves the body itself, because a dead Entity refuses to move by
      // design and that rule belongs to the combat pillar.
      if (this.death.state === 'alive') this._updateInput(dt);
      this._updateEntities(dt);
    }

    // fx phase: after the world has settled, before the camera reads it.
    for (const s of this.subsystems) s?.update?.(dt);

    this.heroLight.position.set(this.player.position.x, 2.2, this.player.position.z);

    this.rig.setTarget(this.player.position);
    this.rig.update(dt, this.input.groundValid ? this.input.ground : null);
    this.lighting.update(dt, this.player.position);
    this.postfx.update(dt);

    this.hud.update(this.player);
    this.perf.update(dt);
    this.telemetry.update(dt);
    this._updateDebug(dt);

    this.renderer.info.reset();
    // Diagnostic bypass: render the scene straight to the screen, skipping the
    // whole composer chain. Lets the probe attribute a crushed frame to the
    // post stack versus the scene itself in one measurement.
    if (this.__nopost) this.renderer.render(this.scene, this.camera);
    else this.postfx.render(dt);
    this.input.endFrame();
  }

  _updateInput(dt) {
    const input = this.input;
    input.updateGround(this.camera, 0);

    if (input.wheel !== 0) this.rig.zoom(input.wheel);
    if (input.pressed('F3')) this.hud.toggleDebug();

    // Hold-to-move (F1). Diablo players hold the left button down and steer
    // with the cursor; they do not click once per step. This block already ran
    // on every held frame, but it called orderMove/orderAttack, and both of
    // those run a fresh A* -- sixty pathfinds a second at a cursor that has
    // barely moved. orderHold() is the held-order path: it steers straight at
    // the live cursor while the line is clear and only falls back to A* when
    // something is actually in the way. Releasing the button leaves the last
    // path in place, so a single click is still a discrete move order and
    // needs no second code path.
    if (!input.pointerOverUI && input.mouseDown('left') && this.player.alive) {
      const hit = this._pickEntity();
      const hostile = (hit && hit.faction === 'hostile' && hit.alive) ? hit : null;
      if (hostile) {
        this.player.orderHold(this.player.position.x, this.player.position.z, this.world.nav, hostile);
      } else if (input.groundValid) {
        this.player.orderHold(input.ground.x, input.ground.z, this.world.nav, null);
      }
    }

    // Skills first: a deliberate cast outranks the filler swing. The skills
    // subsystem reads its own hotkeys, so this is just giving it the frame.
    this.skills?.update?.(dt);

    // Auto-swing when a target is in reach.
    const t = this.player.target;
    // Pass input so the auto-swing yields when the player is asking for a
    // skill this frame. Without it, melee re-issues attack() every frame a
    // live target is in range, the animator never leaves the swing chain, and
    // a cast can literally never get through -- which is exactly why spells
    // "did not hit the monsters": they were never firing at all.
    if (t && t.alive && this.player.distanceTo(t) <= this.player.attackRange
        && this.player.canAttack(this.input)) {
      this.player.attack((ev) => {
        if (ev !== 'impact') return;
        if (!t.alive || this.player.distanceTo(t) > this.player.attackRange * 1.35) return;
        _v1.set(t.position.x - this.player.position.x, 0, t.position.z - this.player.position.z).normalize();

        // Everything about resolving a hit -- armour, crit, mass-scaled
        // knockback, hit-stop, camera shake, the combat:hit event -- lives in
        // Entity.damage(). This call site used to re-derive all of it, which
        // meant three bugs at once: melee rolled a hardcoded 18 +/- and so
        // never saw equipment (breaking "equip something -> feel stronger"),
        // combat:hit was emitted twice per swing (double-counting telemetry
        // and firing the fx layer twice), and knockback was applied on top of
        // the knockback damage() had already applied. Pass the raw weapon
        // amount and let the one funnel do its job.
        const dealt = t.damage(this._playerWeaponDamage(), this.player, {
          direction: _v1,
          stagger: 0.7,
        });

        if (!t.alive) {
          this.player.experience += t.experienceValue;
          // Entity does not announce its own death -- the loop owns reaping and
          // rewards, so it owns the event that items/telemetry key off.
          this.bus.emit('entity:died', { entity: t, killer: this.player });
        }
        return dealt;
      });
    }
  }

  /**
   * Raw melee damage before the victim's mitigation. Reads aggregated
   * equipment from the items pillar when it exists so that equipping a better
   * weapon actually raises the number -- that is the "feel stronger" link of
   * the core loop, and it is only real if it is read here.
   */
  _playerWeaponDamage() {
    // Equipment ADDS to the character's base swing; it never replaces it.
    //
    // The previous version read damageMin/damageMax straight off items.stats
    // and fell back only when they were non-finite. The items pillar is still
    // a stub and reports a placeholder 0/0 -- which is perfectly finite -- so
    // every swing resolved to exactly zero damage and the game became
    // unwinnable. A subsystem that is not built yet must contribute nothing,
    // not zero everything out.
    const p = this.player;
    const baseLo = Number.isFinite(p?.baseDamageMin) ? p.baseDamageMin : 14;
    const baseHi = Number.isFinite(p?.baseDamageMax) ? p.baseDamageMax : 24;

    const s = this.items?.stats;
    const bonusLo = Number.isFinite(s?.damageMin) ? s.damageMin : 0;
    const bonusHi = Number.isFinite(s?.damageMax) ? s.damageMax : 0;

    const lo = Math.max(1, Math.min(baseLo + bonusLo, baseHi + bonusHi));
    const hi = Math.max(lo, Math.max(baseLo + bonusLo, baseHi + bonusHi));
    return lo + this.rng.next() * (hi - lo);
  }

  _pickEntity() {
    const ray = this.input.raycaster(this.camera);
    let best = null, bestDist = Infinity;
    for (const e of this.entities) {
      if (e === this.player || !e.alive) continue;
      // Capsule-ish proxy test: cheaper and far more forgiving than raycasting
      // the actual limb meshes, which at this camera makes targeting fiddly.
      const center = _v1.copy(e.position).setY(e.height * 0.5);
      const d = ray.ray.distanceSqToPoint(center);
      if (d > (e.radius * 1.9) ** 2) continue;
      const along = ray.ray.origin.distanceToSquared(center);
      if (along < bestDist) { bestDist = along; best = e; }
    }
    return best;
  }

  _updateEntities(dt) {
    const ghosting = this.death?.state !== 'alive';
    for (const e of this.entities) {
      if (ghosting && e === this.player) continue;   // the death system drives it
      e.update(dt, this.world);
    }
    resolveOverlaps(this.entities, 2);

    // Corpses persist. This is a Diablo rule, not an oversight: a field of
    // bodies is the record of the fight you just had, and clearing it deletes
    // the player's own evidence of progress. Entity never despawns itself, so
    // this loop only enforces a hard ceiling to bound memory on very long
    // sessions -- and it evicts the OLDEST corpses first, far from the player,
    // rather than deleting whatever happens to be underfoot.
    const corpses = [];
    for (const e of this.entities) {
      if (!e.alive && e !== this.player) corpses.push(e);
    }
    if (corpses.length > MAX_CORPSES) {
      corpses.sort((a, b) => b.deathTimer - a.deathTimer);
      for (const e of corpses.slice(0, corpses.length - MAX_CORPSES)) {
        e.dispose();
        const i = this.entities.indexOf(e);
        if (i >= 0) this.entities.splice(i, 1);
        const j = this.monsters.indexOf(e);
        if (j >= 0) this.monsters.splice(j, 1);
      }
    }
  }

  _updateDebug(dt) {
    this._fpsAccum += dt;
    this._fpsFrames++;
    if (this._fpsAccum >= 0.5) {
      this.fps = this._fpsFrames / this._fpsAccum;
      this._fpsAccum = 0;
      this._fpsFrames = 0;
    }
    const info = this.renderer.info;
    this.hud.setDebug(
      `fps      ${this.fps.toFixed(1)}\n` +
      `seed     ${this.seed}\n` +
      `draws    ${info.render.calls}\n` +
      `tris     ${info.render.triangles.toLocaleString()}\n` +
      `entities ${this.entities.length}\n` +
      `torches  ${this.torchCount}\n` +
      `zone     ${this.zoneName}\n` +
      `pos      ${this.player.position.x.toFixed(1)}, ${this.player.position.z.toFixed(1)}`
    );
  }
}

/** Hard ceiling on persistent corpses -- memory bound, not a fade timer. */
const MAX_CORPSES = 120;

const _v1 = new THREE.Vector3();

const game = new Game();
window.__gameInstance = game;
game.init().then(() => game.start()).catch((err) => {
  console.error(err);
  const s = document.querySelector('.boot-status');
  if (s) { s.textContent = 'failed: ' + err.message; s.style.color = '#c33'; }
  window.__bootError = String(err && err.stack || err);
});
