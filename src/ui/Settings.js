import { PLAYER_PRESETS } from '../render/Renderer.js';

/**
 * The settings menu (Esc).
 *
 * Two controls, both mandated by STABILIZE.md, both usability rather than
 * decoration:
 *
 *   - **Quality preset.** Low / Medium / High. Low is the default and stays
 *     the default until 60 FPS is proven on the real machine. Picking one by
 *     hand also tells the automatic governor to stop second-guessing the
 *     player.
 *   - **Brightness.** Monitors, panel types and room lighting genuinely
 *     differ, and a dark game without a brightness control is unplayable on
 *     half of them. This is standard usability, not an excuse for a scene
 *     that is too dark -- the scene's own readability floors are a separate
 *     fix (P0-2) and this slider sits on top of them.
 *
 * The game keeps running underneath: this is deliberately not a pause menu,
 * because the whole point of the brightness slider is judging the change
 * against the live scene.
 */
export class Settings {
  constructor(game) {
    this.game = game;
    this.open = false;
    this._build();

    addEventListener('keydown', (e) => {
      if (e.code !== 'Escape') return;
      // Never fight the debug console for Escape.
      const dbg = document.getElementById('debug-console');
      if (dbg && dbg.style.display !== 'none') return;
      e.preventDefault();
      this.toggle();
    });
  }

  _build() {
    const el = document.createElement('div');
    el.id = 'settings-overlay';
    el.style.display = 'none';
    el.innerHTML = `
      <div class="settings-panel">
        <h2>Settings</h2>
        <div class="settings-row">
          <label>Graphics quality</label>
          <div class="preset-buttons">
            ${PLAYER_PRESETS.map((p) => `<button data-preset="${p}">${p}</button>`).join('')}
          </div>
          <div class="settings-hint">Lower is faster. Start at Low and raise it only while the frame counter stays green.</div>
        </div>
        <div class="settings-row">
          <label>Brightness</label>
          <input type="range" class="brightness" min="0.6" max="2.0" step="0.02" value="1">
          <div class="settings-hint">Raise this until the floor is clearly readable in an unlit corridor.</div>
        </div>
        <button class="settings-close">Close</button>
      </div>`;
    document.body.appendChild(el);
    this.el = el;

    // Clicks inside the panel must not fall through to the world, or opening
    // the menu would order the character to walk somewhere.
    for (const ev of ['pointerdown', 'pointerup', 'click']) {
      el.addEventListener(ev, (e) => e.stopPropagation());
    }

    for (const b of el.querySelectorAll('[data-preset]')) {
      b.addEventListener('click', () => {
        this.game.perf?.setPreset(b.dataset.preset, false);
        // A deliberate choice outranks the governor's opinion.
        if (this.game.perf) this.game.perf.autoDowngraded = false;
        this._sync();
      });
    }

    this.brightness = el.querySelector('.brightness');
    this.brightness.addEventListener('input', () => {
      this.game.postfx?.setBrightness?.(Number(this.brightness.value));
    });

    el.querySelector('.settings-close').addEventListener('click', () => this.toggle(false));
  }

  _sync() {
    const cur = this.game.qualityName;
    for (const b of this.el.querySelectorAll('[data-preset]')) {
      b.classList.toggle('active', b.dataset.preset === cur);
    }
  }

  toggle(force) {
    this.open = force === undefined ? !this.open : force;
    this.el.style.display = this.open ? 'grid' : 'none';
    // The pointer sits over UI while this is up; the input layer uses that
    // flag to refuse move orders.
    if (this.game.input) this.game.input.pointerOverUI = this.open;
    if (this.open) this._sync();
  }
}
