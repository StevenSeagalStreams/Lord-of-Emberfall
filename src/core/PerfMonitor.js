import { QUALITY, PLAYER_PRESETS, applyQuality } from '../render/Renderer.js';

/**
 * Frame-rate readout and automatic quality governor.
 *
 * STABILIZE.md rule 0: the game must hold 60 FPS (hard floor 45) on an
 * Intel Iris-class integrated GPU at 1080p, and a frame-rate readout is
 * permanently visible in dev builds. This owns both halves of that.
 *
 * Two deliberate design points:
 *
 * 1. **The readout is always on and always honest.** It reports the rolling
 *    average, the 1% low (the worst frame in the window, which is what a
 *    hitch actually feels like), and the live preset. An average of 60 with
 *    a 1% low of 12 is a stuttering game, and a single averaged number would
 *    hide exactly the hitch the director reported.
 *
 * 2. **The governor only ever steps DOWN, and only on sustained evidence.**
 *    Auto-*upgrading* would produce an oscillation: raise quality, drop
 *    below the threshold, lower it, rise above, raise again -- visible as
 *    the whole scene's look pulsing. Stepping up is a deliberate player
 *    choice in the settings menu, nothing else.
 */

/** Sustained average below this triggers a downgrade. From STABILIZE.md. */
const DOWNGRADE_FPS = 55;
/** ...but only after this long, so a load spike or an alt-tab is not a verdict. */
const DOWNGRADE_WINDOW = 5.0;
/** Rolling window for the displayed average and 1% low. */
const SAMPLE_WINDOW = 90;
/** Grace period after boot before the governor may act -- shader compilation,
 *  texture upload and the first zone build all land in the opening second and
 *  none of them represent steady-state cost. */
const WARMUP = 3.0;

export class PerfMonitor {
  constructor(game) {
    this.game = game;
    this.samples = [];
    this.fps = 0;
    this.low1 = 0;
    this._belowFor = 0;
    this._age = 0;
    this._noticeTimer = 0;
    /** Set once the governor acts, so it never fights a player's own choice. */
    this.autoDowngraded = false;

    this._build();
  }

  _build() {
    const el = document.createElement('div');
    el.id = 'perf-readout';
    el.innerHTML = `<span class="perf-fps">--</span><span class="perf-low"></span><span class="perf-preset"></span>`;
    document.body.appendChild(el);
    this.el = el;
    this.elFps = el.querySelector('.perf-fps');
    this.elLow = el.querySelector('.perf-low');
    this.elPreset = el.querySelector('.perf-preset');

    const notice = document.createElement('div');
    notice.id = 'perf-notice';
    notice.style.display = 'none';
    document.body.appendChild(notice);
    this.notice = notice;
  }

  update(dt) {
    if (dt <= 0) return;
    this._age += dt;

    this.samples.push(dt);
    if (this.samples.length > SAMPLE_WINDOW) this.samples.shift();

    let total = 0;
    let worst = 0;
    for (const s of this.samples) {
      total += s;
      if (s > worst) worst = s;
    }
    this.fps = this.samples.length / total;
    this.low1 = worst > 0 ? 1 / worst : 0;

    this._render();
    this._govern(dt);

    if (this._noticeTimer > 0) {
      this._noticeTimer -= dt;
      if (this._noticeTimer <= 0) this.notice.style.display = 'none';
    }
  }

  _render() {
    const fps = Math.round(this.fps);
    this.elFps.textContent = `${fps} fps`;
    // Colour against the mandate's own numbers, so the readout states the
    // verdict rather than leaving it to be worked out: green at or above the
    // 60 target, amber between the target and the 45 hard floor, red below.
    this.elFps.className = `perf-fps ${fps >= 60 ? 'ok' : fps >= 45 ? 'warn' : 'bad'}`;
    this.elLow.textContent = `${Math.round(this.low1)} low`;
    this.elPreset.textContent = this.game.qualityName;
  }

  _govern(dt) {
    if (this._age < WARMUP) return;
    if (this.fps >= DOWNGRADE_FPS) { this._belowFor = 0; return; }

    this._belowFor += dt;
    if (this._belowFor < DOWNGRADE_WINDOW) return;
    this._belowFor = 0;

    const i = PLAYER_PRESETS.indexOf(this.game.qualityName);
    if (i <= 0) return;   // already at the cheapest preset; nothing left to give
    this.setPreset(PLAYER_PRESETS[i - 1], true);
  }

  /**
   * Apply a preset live. Everything a preset controls is a flag, a uniform or
   * a pixel-ratio -- nothing here rebuilds the composer or reallocates the
   * scene, so this is safe to call mid-combat.
   */
  setPreset(name, automatic = false) {
    if (!QUALITY[name]) return;
    const g = this.game;
    g.qualityName = name;
    const q = applyQuality(g.renderer, name);
    g.quality = q;

    const fx = g.postfx;
    if (fx) {
      if (fx.gtao) fx.gtao.enabled = q.ssao !== false;
      if (fx.bloom) fx.bloom.enabled = q.bloom !== false;
      if (fx.smaa) fx.smaa.enabled = q.smaa !== false;
      if (fx.volumetrics) fx.volumetrics.enabled = q.volumetrics !== false;
      if (fx.grade?.uniforms?.grain) fx.grade.uniforms.grain.value = q.grain === false ? 0 : fx.grainBase ?? 0.035;
      if (fx.grade?.uniforms?.vignette && q.vignette === false) fx.grade.uniforms.vignette.value = 0;
    }
    if (g.lighting) g.lighting.shadowBudget = q.shadowBudget ?? 0;
    g.renderer.shadowMap.needsUpdate = true;

    if (automatic) {
      this.autoDowngraded = true;
      // Telling the player is required, not optional: a game that silently
      // changes how it looks reads as a bug.
      this._say(`Performance: quality lowered to ${name} to hold the frame rate. Change it in Settings (Esc).`);
    }
  }

  _say(text) {
    this.notice.textContent = text;
    this.notice.style.display = 'block';
    this._noticeTimer = 6;
  }
}
