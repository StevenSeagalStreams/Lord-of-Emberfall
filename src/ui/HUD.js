/**
 * Baseline HUD: globe orbs, skill bar, level readout, debug overlay.
 * Intentionally thin -- this is the seam the UI pass builds on.
 */
export class HUD {
  constructor(root) {
    this.root = root;
    this.el = {};
    this._build();
    this._debugVisible = false;
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
  }
}
