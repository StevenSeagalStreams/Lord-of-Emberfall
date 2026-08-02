import * as THREE from 'three';

/**
 * Baseline HUD: globe orbs, skill bar, level readout, debug overlay -- plus
 * the F4 playtest fix (monster health legibility):
 *
 *   - a D2-style focus target bar (top-centre): name, health, rank. Tracks
 *     whatever the player is attacking, falling back to whatever they are
 *     hovering, and fades out a few seconds after that target dies or is
 *     lost rather than popping away.
 *   - WoW-style floating nameplates: small health bars projected into screen
 *     space above any monster that is damaged or currently mid-fight, so a
 *     pull is readable at a glance without cluttering an untouched room.
 *
 * Both read the live game off `window.__game` (this HUD is constructed
 * before the game finishes init(), so the reference has to be picked up
 * lazily -- see `_updateCombatUI`) and are ticked from the existing
 * `HUD.update(player)` call in main.js's UI phase. No new hook required.
 */

const NAMEPLATE_POOL = 12;      // generous over the roster's 3-8 pack size
const NAMEPLATE_FADE = 2.5;     // seconds a plate lingers once inactive
const FOCUS_FADE = 3.0;         // seconds the focus bar lingers once lost
const HOVER_RADIUS = 42;        // px, mouse-to-monster hover pick radius

const RANK_LABEL = { normal: 'Normal', champion: 'Champion', rare: 'Rare' };

export class HUD {
  constructor(root) {
    this.root = root;
    this.el = {};
    this._build();
    this._buildFocusBar();
    this._buildNameplates();
    this._debugVisible = false;

    this._game = null;
    this._busBound = false;

    // The focus target is tracked independently of player.target: Player.js
    // nulls that the instant a target dies (see orderAttack/update in
    // Player.js), which would make the bar vanish on the kill frame instead
    // of draining-then-fading. We keep our own handle and only drop it once
    // FOCUS_FADE has elapsed since it was last a valid, alive target.
    this._focusEntity = null;
    this._focusLastValidTime = -Infinity;
    this._focusHitFlashUntil = -Infinity;

    // Per-monster bookkeeping for the floating bars. WeakMaps so nothing
    // needs explicit cleanup when a monster is despawned/GC'd.
    this._activeSince = new WeakMap();   // monster -> world-time last damaged/in-combat
    this._deathTime = new WeakMap();     // monster -> world-time it died
    this._hitFlashUntil = new WeakMap(); // monster -> world-time to stop flashing

    // Fixed-size scratch pool for "closest K active monsters" selection.
    // Reused and mutated in place every frame -- never reallocated -- so
    // picking which monsters get a plate costs no per-frame GC.
    this._candidates = Array.from({ length: NAMEPLATE_POOL }, () => ({
      m: null, distSq: Infinity, dead: false, opacity: 1,
    }));

    // Scratch projection objects, likewise allocated once.
    this._scratchV = new THREE.Vector3();
    this._scratchScreen = { x: 0, y: 0, visible: false };
  }

  _build() {
    const html = `
      <div class="hud-orb left">
        <div class="fill" data-health></div>
        <div class="gloss"></div>
        <div class="label" data-health-label>0 / 0</div>
      </div>
      <div class="hud-orb right">
        <div class="fill" data-mana></div>
        <div class="gloss"></div>
        <div class="label" data-mana-label>0 / 0</div>
      </div>
      <div id="hud-bar">
        <div class="slot">&#9876;<span class="key">1</span></div>
        <div class="slot">&#128293;<span class="key">2</span></div>
        <div class="slot">&#10052;<span class="key">3</span></div>
        <div class="slot">&#9889;<span class="key">4</span></div>
        <div class="slot">&#128138;<span class="key">Q</span></div>
      </div>
      <div id="hud-stats">
        <span class="lvl" data-level>Level 1</span> &middot; <span data-xp>0 XP</span>
      </div>
      <div id="hud-debug" style="display:none"></div>
    `;
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    while (wrap.firstElementChild) this.root.appendChild(wrap.firstElementChild);

    this.el.health = this.root.querySelector('[data-health]');
    this.el.mana = this.root.querySelector('[data-mana]');
    this.el.healthLabel = this.root.querySelector('[data-health-label]');
    this.el.manaLabel = this.root.querySelector('[data-mana-label]');
    this.el.level = this.root.querySelector('[data-level]');
    this.el.xp = this.root.querySelector('[data-xp]');
    this.el.debug = this.root.querySelector('#hud-debug');
  }

  /** D2-style focus target bar: top-centre, name + rank + draining health. */
  _buildFocusBar() {
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div id="focus-bar">
        <div class="focus-header">
          <span class="focus-name" data-focus-name>&nbsp;</span>
          <span class="focus-rank" data-focus-rank data-rank="normal">Normal</span>
        </div>
        <div class="focus-track"><div class="focus-fill" data-focus-fill></div></div>
        <div class="focus-text" data-focus-text>0 / 0</div>
      </div>
    `;
    const el = wrap.firstElementChild;
    el.style.opacity = '0';
    this.root.appendChild(el);
    this.el.focusBar = el;
    this.el.focusName = el.querySelector('[data-focus-name]');
    this.el.focusRank = el.querySelector('[data-focus-rank]');
    this.el.focusFill = el.querySelector('[data-focus-fill]');
    this.el.focusText = el.querySelector('[data-focus-text]');
  }

  /** WoW-style floating nameplates: a pooled, reused set of DOM elements. */
  _buildNameplates() {
    const layer = document.createElement('div');
    layer.id = 'nameplate-layer';
    this.root.appendChild(layer);
    this.el.nameplateLayer = layer;

    this._nameplates = [];
    for (let i = 0; i < NAMEPLATE_POOL; i++) {
      const plate = document.createElement('div');
      plate.className = 'nameplate';
      plate.innerHTML = `
        <div class="nameplate-name"></div>
        <div class="nameplate-track"><div class="nameplate-fill"></div></div>
      `;
      plate.style.display = 'none';
      layer.appendChild(plate);
      this._nameplates.push({
        el: plate,
        name: plate.querySelector('.nameplate-name'),
        fill: plate.querySelector('.nameplate-fill'),
      });
    }
  }

  toggleDebug() {
    this._debugVisible = !this._debugVisible;
    this.el.debug.style.display = this._debugVisible ? 'block' : 'none';
  }

  setDebug(text) {
    if (this._debugVisible) this.el.debug.textContent = text;
  }

  update(player) {
    const hp = Math.max(0, player.health) / player.maxHealth;
    const mp = Math.max(0, player.mana) / player.maxMana;
    this.el.health.style.height = `${hp * 100}%`;
    this.el.mana.style.height = `${mp * 100}%`;
    this.el.healthLabel.textContent = `${Math.ceil(player.health)} / ${player.maxHealth}`;
    this.el.manaLabel.textContent = `${Math.ceil(player.mana)} / ${player.maxMana}`;
    this.el.level.textContent = `Level ${player.level}`;
    this.el.xp.textContent = `${player.experience} XP`;

    this._updateCombatUI(player);
  }

  // ---------------------------------------------------------- combat ui

  _updateCombatUI(player) {
    if (!this._game) {
      // HUD is constructed mid-init(), before `window.__game` exists. By the
      // time update() is first called from the main loop, init() has
      // finished and set it -- see main.js Game.init(). Picking it up here
      // (read-only) is the sanctioned way to reach monsters/camera/bus
      // without a main.js hook.
      this._game = window.__game || null;
    }
    const game = this._game;
    if (game && game.bus && !this._busBound) this._bindBus(game.bus);

    // Never fight the debug console for the player's attention.
    const debugEl = document.getElementById('debug-console');
    const debugOpen = !!debugEl && debugEl.style.display !== 'none';

    if (!game || debugOpen) {
      this._hideFocusBar();
      this._hideNameplates();
      return;
    }

    const now = game.world?.time ?? 0;
    const camera = game.camera;
    const monsters = game.monsters || [];

    const hovered = camera ? this._pickHovered(monsters, camera, game.input) : null;
    this._updateFocusBar(player, hovered, now);

    if (camera) this._updateNameplates(monsters, camera, now);
    else this._hideNameplates();
  }

  _bindBus(bus) {
    this._busBound = true;
    // `combat:hit` / `entity:died` -- see ARCHITECTURE.md's event bus
    // contract. Used only to flash a bar on hit and to timestamp deaths;
    // the health numbers themselves are read straight off the monster each
    // frame, so a missed event never desyncs the bar.
    bus.on('combat:hit', ({ victim }) => {
      if (!victim) return;
      const t = this._game?.world?.time ?? 0;
      this._hitFlashUntil.set(victim, t + 0.12);
      if (victim === this._focusEntity) this._focusHitFlashUntil = t + 0.12;
    });
    bus.on('entity:died', ({ entity }) => {
      if (!entity) return;
      if (!this._deathTime.has(entity)) this._deathTime.set(entity, this._game?.world?.time ?? 0);
    });
  }

  /** Project a world point to CSS-pixel screen space. Scratch-only, no allocation. */
  _project(x, y, z, camera, out) {
    this._scratchV.set(x, y, z);
    this._scratchV.project(camera);
    out.visible = this._scratchV.z < 1;
    out.x = (this._scratchV.x * 0.5 + 0.5) * window.innerWidth;
    out.y = (1 - (this._scratchV.y * 0.5 + 0.5)) * window.innerHeight;
    return out;
  }

  /**
   * Mouse-hover pick, reusing the same projection the nameplates need rather
   * than a second raycast against the scene. Screen-space distance to the
   * pointer is plenty precise at nameplate scale.
   */
  _pickHovered(monsters, camera, input) {
    if (!input) return null;
    const mx = input.screen.x, my = input.screen.y;
    let best = null, bestDist = HOVER_RADIUS * HOVER_RADIUS;
    for (const m of monsters) {
      if (!m || !m.alive) continue;
      // visualHeight (Entity.js): since G1 scaled the art up, the physics
      // capsule is half the size of the model. The player aims at the body
      // they can see, not at the capsule.
      const vh = m.visualHeight ?? m.height;
      this._project(m.position.x, m.position.y + vh * 0.6, m.position.z, camera, this._scratchScreen);
      if (!this._scratchScreen.visible) continue;
      const dx = this._scratchScreen.x - mx;
      const dy = this._scratchScreen.y - my;
      const d = dx * dx + dy * dy;
      if (d < bestDist) { bestDist = d; best = m; }
    }
    return best;
  }

  _updateFocusBar(player, hovered, now) {
    let target = player?.target;
    if (!(target && target.alive)) target = hovered;

    if (target && target.alive) {
      this._focusEntity = target;
      this._focusLastValidTime = now;
    }

    const entity = this._focusEntity;
    if (!entity) { this._hideFocusBar(); return; }

    const elapsed = now - this._focusLastValidTime;
    if (elapsed > FOCUS_FADE) {
      this._focusEntity = null;
      this._hideFocusBar();
      return;
    }

    const dead = !entity.alive;
    const opacity = elapsed > 0 ? Math.max(0, 1 - elapsed / FOCUS_FADE) : 1;

    const bar = this.el.focusBar;
    bar.style.display = 'flex';
    bar.style.opacity = String(opacity);
    bar.classList.toggle('is-dead', dead);
    bar.classList.toggle('is-hit', now < this._focusHitFlashUntil);

    const pct = Math.max(0, Math.min(1, entity.health / Math.max(1, entity.maxHealth)));
    this.el.focusFill.style.width = `${(pct * 100).toFixed(1)}%`;
    this.el.focusName.textContent = displayName(entity);
    const rank = rankOf(entity);
    this.el.focusRank.textContent = rank.label;
    this.el.focusRank.dataset.rank = rank.key;
    this.el.focusText.textContent = `${Math.max(0, Math.ceil(entity.health))} / ${Math.round(entity.maxHealth)}`;
  }

  _hideFocusBar() {
    if (this.el.focusBar) this.el.focusBar.style.opacity = '0';
  }

  _updateNameplates(monsters, camera, now) {
    const buf = this._candidates;
    for (let i = 0; i < buf.length; i++) { buf[i].m = null; buf[i].distSq = Infinity; }

    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;

    for (const m of monsters) {
      if (!m) continue;
      let dead = false;
      let opacity = 1;

      if (m.alive) {
        const damaged = m.health < m.maxHealth - 0.01;
        const inCombat = !!m.state && m.state !== 'idle';
        if (damaged || inCombat) this._activeSince.set(m, now);
        const since = this._activeSince.has(m) ? now - this._activeSince.get(m) : Infinity;
        if (since > NAMEPLATE_FADE) continue; // untouched/idle -- no clutter
        opacity = since > 0 ? Math.max(0, 1 - since / NAMEPLATE_FADE) : 1;
      } else {
        if (!this._deathTime.has(m)) this._deathTime.set(m, now); // safety net if entity:died was missed
        const since = now - this._deathTime.get(m);
        if (since > NAMEPLATE_FADE) continue;
        dead = true;
        opacity = Math.max(0, 1 - since / NAMEPLATE_FADE);
      }

      const dx = m.position.x - cx, dy = m.position.y - cy, dz = m.position.z - cz;
      this._insertCandidate(m, dx * dx + dy * dy + dz * dz, dead, opacity);
    }

    for (let i = 0; i < buf.length; i++) {
      const slot = this._nameplates[i];
      const c = buf[i];
      if (!c.m) { slot.el.style.display = 'none'; continue; }

      // A nameplate floats above the head, so it must use the *visible* head
      // (Entity.visualHeight), not the physics capsule -- with G1's scaled
      // art the capsule is half the model, which parked every plate at the
      // monster's waist.
      const vh = c.m.visualHeight ?? c.m.height;
      this._project(c.m.position.x, c.m.position.y + vh + 0.32, c.m.position.z, camera, this._scratchScreen);
      if (!this._scratchScreen.visible) { slot.el.style.display = 'none'; continue; }

      slot.el.style.display = 'block';
      slot.el.style.transform = `translate(${this._scratchScreen.x.toFixed(1)}px, ${this._scratchScreen.y.toFixed(1)}px)`;
      slot.el.style.opacity = String(c.opacity);
      slot.el.classList.toggle('is-dead', c.dead);
      slot.el.classList.toggle('is-hit', now < (this._hitFlashUntil.get(c.m) ?? -Infinity));

      const pct = Math.max(0, Math.min(1, c.m.health / Math.max(1, c.m.maxHealth)));
      slot.fill.style.width = `${(pct * 100).toFixed(1)}%`;
      slot.name.textContent = displayName(c.m);
    }
  }

  /** Top-K-nearest insertion into the fixed candidate pool -- O(POOL) per
   *  monster, zero allocation, so a room full of active monsters still only
   *  surfaces the nearest NAMEPLATE_POOL of them. */
  _insertCandidate(m, distSq, dead, opacity) {
    const buf = this._candidates;
    let worstIdx = 0, worstVal = -Infinity;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i].m === null) { worstIdx = i; worstVal = Infinity; break; }
      if (buf[i].distSq > worstVal) { worstVal = buf[i].distSq; worstIdx = i; }
    }
    if (distSq < worstVal) {
      const slot = buf[worstIdx];
      slot.m = m; slot.distSq = distSq; slot.dead = dead; slot.opacity = opacity;
    }
  }

  _hideNameplates() {
    for (const p of this._nameplates) p.el.style.display = 'none';
  }
}

function displayName(entity) {
  const kind = entity.kind || 'monster';
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

/**
 * No elite-affix system exists yet (VISION's champion/rare roster is M2+
 * scope), so this reads speculative fields that don't exist on any monster
 * in the current build and always resolves to 'normal' today -- but the bar
 * already renders the rank slot, so the day combat/enemies stamps a
 * `rank`/`tier` on a monster, it appears with no UI change required.
 */
function rankOf(entity) {
  const raw = entity.rank || entity.eliteRank || entity.tier || entity.profile?.rank;
  const key = raw ? String(raw).toLowerCase() : 'normal';
  if (key === 'champion') return { key, label: RANK_LABEL.champion };
  if (key === 'rare' || key === 'unique') return { key: 'rare', label: RANK_LABEL.rare };
  return { key: 'normal', label: RANK_LABEL.normal };
}
