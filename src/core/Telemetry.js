/**
 * Session telemetry (F3 overlay + JSON export).
 *
 * The point is not performance profiling. It is so that playtest feedback can
 * cite numbers instead of impressions: "the second pack took 90 seconds and
 * four potions" is actionable, "combat felt slow" is not. Every counter here
 * exists because some balance question needs it.
 *
 * Rates are per-minute over the *session*, which is the honest denominator for
 * a farming run. Instantaneous rates swing too wildly to read on an overlay.
 */
export class Telemetry {
  constructor(game) {
    this.game = game;
    this.reset();
    this._buildDOM();
    this._bindEvents();
    this._bindKeys();
  }

  reset() {
    this.startedAt = performance.now();
    this.kills = 0;
    this.killsByKind = {};
    this.deaths = 0;
    this.damageDealt = 0;
    this.damageTaken = 0;
    this.potionsUsed = 0;
    this.dropsByRarity = { normal: 0, magic: 0, rare: 0, unique: 0, set: 0 };
    this.goldGained = 0;
    this.clearTimerStart = null;
    this.clearTimerLabel = null;
    this._fpsAccum = 0;
    this._fpsFrames = 0;
    this.fps = 0;
  }

  get elapsedSeconds() {
    return (performance.now() - this.startedAt) / 1000;
  }

  perMinute(n) {
    const m = this.elapsedSeconds / 60;
    return m > 0.02 ? n / m : 0;
  }

  _bindEvents() {
    const bus = this.game.bus;

    bus.on('combat:hit', ({ attacker, victim, amount }) => {
      if (!Number.isFinite(amount)) return;
      if (attacker === this.game.player) this.damageDealt += amount;
      if (victim === this.game.player) this.damageTaken += amount;
    });

    bus.on('entity:died', ({ entity }) => {
      if (!entity) return;
      if (entity === this.game.player) { this.deaths++; return; }
      this.kills++;
      const k = entity.kind || entity.type || 'unknown';
      this.killsByKind[k] = (this.killsByKind[k] || 0) + 1;
    });

    bus.on('item:dropped', ({ item }) => {
      const r = (item && (item.rarity || item.quality)) || 'normal';
      if (this.dropsByRarity[r] === undefined) this.dropsByRarity[r] = 0;
      this.dropsByRarity[r]++;
    });

    bus.on('item:pickup', ({ item }) => {
      if (item && item.kind === 'potion') this.potionsUsed++;
      if (item && Number.isFinite(item.gold)) this.goldGained += item.gold;
    });

    bus.on('potion:used', () => { this.potionsUsed++; });

    // Write the session file on the way out so a tester never has to remember
    // to export. beforeunload is best-effort but covers tab close and reload.
    addEventListener('beforeunload', () => {
      try { this.dump({ silent: true }); } catch { /* nothing useful to do here */ }
    });
  }

  startClear(label) {
    this.clearTimerStart = performance.now();
    this.clearTimerLabel = label || 'clear';
  }

  get clearSeconds() {
    return this.clearTimerStart === null ? null : (performance.now() - this.clearTimerStart) / 1000;
  }

  /** Serialise the session. Returns the filename written. */
  dump({ silent = false } = {}) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `session-${stamp}.json`;
    const payload = {
      recordedAt: new Date().toISOString(),
      seed: this.game.seed,
      zone: this.game.zoneName,
      elapsedSeconds: +this.elapsedSeconds.toFixed(1),
      fps: +this.fps.toFixed(1),
      draws: this.game.renderer.info.render.calls,
      triangles: this.game.renderer.info.render.triangles,
      kills: this.kills,
      killsByKind: this.killsByKind,
      deaths: this.deaths,
      damageDealt: Math.round(this.damageDealt),
      damageTaken: Math.round(this.damageTaken),
      damageDealtPerMin: +this.perMinute(this.damageDealt).toFixed(1),
      damageTakenPerMin: +this.perMinute(this.damageTaken).toFixed(1),
      killsPerMin: +this.perMinute(this.kills).toFixed(2),
      potionsUsed: this.potionsUsed,
      goldGained: this.goldGained,
      dropsByRarity: { ...this.dropsByRarity },
      clearSeconds: this.clearSeconds === null ? null : +this.clearSeconds.toFixed(1),
      dropRateMultiplier: this.game.items?.dropRateMultiplier ?? 1,
    };

    // Browsers cannot write into the repo, so hand the file to the user and
    // stash it on window for a headless harness to read directly.
    window.__telemetry = payload;
    if (!silent) {
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `telemetry/${name}`.replace('telemetry/', '');
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }
    return name;
  }

  // --------------------------------------------------------------- overlay

  _buildDOM() {
    const el = document.createElement('div');
    el.id = 'telemetry-overlay';
    el.style.display = 'none';
    document.body.appendChild(el);
    this.el = el;
    this.visible = false;
  }

  _bindKeys() {
    addEventListener('keydown', (e) => {
      if (e.code === 'F3') {
        e.preventDefault();
        this.visible = !this.visible;
        this.el.style.display = this.visible ? 'block' : 'none';
      }
    });
  }

  update(dt) {
    this._fpsAccum += dt;
    this._fpsFrames++;
    if (this._fpsAccum >= 0.5) {
      this.fps = this._fpsFrames / this._fpsAccum;
      this._fpsAccum = 0;
      this._fpsFrames = 0;
    }
    if (!this.visible) return;

    const info = this.game.renderer.info.render;
    const d = this.dropsByRarity;
    const mult = this.game.items?.dropRateMultiplier ?? 1;
    const clear = this.clearSeconds;

    this.el.textContent =
      `fps        ${this.fps.toFixed(1)}\n` +
      `draws      ${info.calls}\n` +
      `tris       ${info.triangles.toLocaleString()}\n` +
      `zone       ${this.game.zoneName}  seed ${this.game.seed}\n` +
      `elapsed    ${this.elapsedSeconds.toFixed(0)}s` +
        (clear !== null ? `   ${this.clearTimerLabel} ${clear.toFixed(0)}s` : '') + '\n' +
      `\n` +
      `kills      ${this.kills}  (${this.perMinute(this.kills).toFixed(1)}/min)\n` +
      `deaths     ${this.deaths}\n` +
      `dmg out    ${Math.round(this.damageDealt)}  (${this.perMinute(this.damageDealt).toFixed(0)}/min)\n` +
      `dmg in     ${Math.round(this.damageTaken)}  (${this.perMinute(this.damageTaken).toFixed(0)}/min)\n` +
      `potions    ${this.potionsUsed}\n` +
      `gold       ${this.goldGained}\n` +
      `\n` +
      `drops      norm ${d.normal}  magic ${d.magic}  rare ${d.rare}\n` +
      `           uniq ${d.unique}  set ${d.set}` +
        (mult !== 1 ? `\n           DROP RATE x${mult} -- stats invalid` : '');
  }
}
