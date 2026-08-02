/**
 * Debug console (backtick to toggle).
 *
 * Exists to serve the human playtest gate, not the developer. A playtester
 * cannot give useful feel feedback on a boss fight if reaching it means
 * clearing forty minutes of trash first, and cannot judge whether a rare drop
 * feels exciting at a rate of one per hour. Every command here exists to
 * collapse the distance between "I want to test X" and "I am testing X".
 *
 * Commands are declared as data so `help` can never drift from what actually
 * exists -- the list is generated from the same table that dispatches.
 */
export class DebugConsole {
  constructor(game) {
    this.game = game;
    this.open = false;
    this.history = [];
    this.historyIndex = -1;
    this.lines = [];

    this.commands = this._buildCommands();
    this._buildDOM();
    this._bindKeys();

    this.print('Emberfall debug console. `help` for commands, ` to close.', 'sys');
  }

  // ---------------------------------------------------------------- commands

  _buildCommands() {
    const g = () => this.game;

    return {
      help: {
        usage: 'help',
        desc: 'list commands',
        run: () => {
          for (const [name, c] of Object.entries(this.commands)) {
            this.print(`${c.usage.padEnd(26)} ${c.desc}`, 'info');
          }
        },
      },

      tp: {
        usage: 'tp <zone|x z>',
        desc: 'teleport to a zone, or to world coords in this zone',
        run: (args) => {
          if (args.length === 2 && !Number.isNaN(Number(args[0]))) {
            const [x, z] = args.map(Number);
            const y = g().zone?.terrain?.heightAt?.(x, z) ?? 0;
            g().player.position.set(x, y, z);
            g().player.clearPath();
            g().rig.snapTo(g().player.position);
            return this.print(`teleported to ${x}, ${z}`, 'ok');
          }
          const zone = args[0];
          if (!zone) return this.print('usage: tp <zone|x z>', 'err');
          // Zone switching rebuilds the world, so it goes through a reload
          // with the seed preserved -- cheaper and far less bug-prone than
          // tearing down and rebuilding every subsystem in place.
          const url = new URL(location.href);
          url.searchParams.set('zone', zone);
          this.print(`loading zone "${zone}"...`, 'ok');
          location.href = url.toString();
        },
      },

      level: {
        usage: 'level <n>',
        desc: 'set character level',
        run: (args) => {
          const n = Math.max(1, Math.floor(Number(args[0]) || 1));
          const p = g().player;
          p.level = n;
          if (g().progress?.applyLevel) g().progress.applyLevel(p, n);
          this.print(`level set to ${n}`, 'ok');
        },
      },

      gear: {
        usage: 'gear <tier>',
        desc: 'equip a test loadout (0=naked .. 4=endgame)',
        run: (args) => {
          const tier = Math.max(0, Math.min(4, Math.floor(Number(args[0]) || 0)));
          if (!g().items?.equipTestLoadout) {
            return this.print('items system does not expose equipTestLoadout yet', 'err');
          }
          g().items.equipTestLoadout(g().player, tier);
          this.print(`equipped test loadout tier ${tier}`, 'ok');
        },
      },

      spawn: {
        usage: 'spawn <kind> [count]',
        desc: 'spawn monsters in a ring around the player',
        run: (args) => {
          const kind = args[0];
          if (!kind) return this.print('usage: spawn <kind> [count]', 'err');
          const count = Math.max(1, Math.min(60, Math.floor(Number(args[1]) || 1)));
          const n = g().spawnMonsters(kind, count);
          this.print(`spawned ${n} x ${kind}`, n ? 'ok' : 'err');
        },
      },

      killall: {
        usage: 'killall',
        desc: 'kill every living monster',
        run: () => {
          let n = 0;
          for (const m of g().monsters) if (m.alive) { m.kill(g().player); n++; }
          this.print(`killed ${n}`, 'ok');
        },
      },

      droprate: {
        usage: 'droprate <x>',
        desc: 'temporary drop-rate multiplier (feel testing only)',
        run: (args) => {
          const x = Number(args[0]);
          if (!Number.isFinite(x) || x <= 0) return this.print('usage: droprate <x>  e.g. droprate 10', 'err');
          if (!g().items) return this.print('items system not present', 'err');
          g().items.dropRateMultiplier = x;
          this.print(`drop rate x${x} -- statistical results from this session are INVALID`, 'warn');
        },
      },

      god: {
        usage: 'god',
        desc: 'toggle invulnerability',
        run: () => {
          const p = g().player;
          p.godMode = !p.godMode;
          this.print(`god mode ${p.godMode ? 'ON' : 'OFF'}`, 'ok');
        },
      },

      noclip: {
        usage: 'noclip',
        desc: 'toggle collision',
        run: () => {
          const p = g().player;
          p.noclip = !p.noclip;
          this.print(`noclip ${p.noclip ? 'ON' : 'OFF'}`, 'ok');
        },
      },

      heal: {
        usage: 'heal',
        desc: 'refill health and mana',
        run: () => {
          const p = g().player;
          p.health = p.maxHealth;
          p.mana = p.maxMana;
          this.print('restored', 'ok');
        },
      },

      seed: {
        usage: 'seed [n]',
        desc: 'show the current seed, or reload with a new one',
        run: (args) => {
          if (!args.length) return this.print(`seed ${g().seed}`, 'info');
          const url = new URL(location.href);
          url.searchParams.set('seed', String(Math.floor(Number(args[0]))));
          location.href = url.toString();
        },
      },

      telemetry: {
        usage: 'telemetry <dump|reset>',
        desc: 'write the session file now, or clear counters',
        run: (args) => {
          const t = g().telemetry;
          if (!t) return this.print('telemetry not present', 'err');
          if (args[0] === 'reset') { t.reset(); return this.print('telemetry reset', 'ok'); }
          const name = t.dump();
          this.print(`wrote ${name}`, 'ok');
        },
      },
    };
  }

  // -------------------------------------------------------------------- exec

  exec(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    this.print(`> ${trimmed}`, 'echo');
    this.history.push(trimmed);
    this.historyIndex = this.history.length;

    const [name, ...args] = trimmed.split(/\s+/);
    const cmd = this.commands[name];
    if (!cmd) return this.print(`unknown command "${name}" -- try help`, 'err');
    try {
      cmd.run(args);
    } catch (err) {
      this.print(`error: ${err.message}`, 'err');
    }
  }

  print(text, kind = 'info') {
    this.lines.push({ text, kind });
    if (this.lines.length > 200) this.lines.shift();
    const div = document.createElement('div');
    div.className = `dbg-line dbg-${kind}`;
    div.textContent = text;
    this.log.appendChild(div);
    while (this.log.childElementCount > 200) this.log.removeChild(this.log.firstChild);
    this.log.scrollTop = this.log.scrollHeight;
  }

  toggle(force) {
    this.open = force !== undefined ? force : !this.open;
    this.root.style.display = this.open ? 'flex' : 'none';
    if (this.open) this.input.focus();
    else this.input.blur();
  }

  // --------------------------------------------------------------------- DOM

  _buildDOM() {
    const root = document.createElement('div');
    root.id = 'debug-console';
    root.innerHTML = `<div class="dbg-log"></div><input class="dbg-input" spellcheck="false" autocomplete="off" />`;
    document.body.appendChild(root);
    this.root = root;
    this.log = root.querySelector('.dbg-log');
    this.input = root.querySelector('.dbg-input');
    root.style.display = 'none';

    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        this.exec(this.input.value);
        this.input.value = '';
      } else if (e.key === 'ArrowUp') {
        if (this.historyIndex > 0) this.input.value = this.history[--this.historyIndex] ?? '';
        e.preventDefault();
      } else if (e.key === 'ArrowDown') {
        if (this.historyIndex < this.history.length - 1) this.input.value = this.history[++this.historyIndex] ?? '';
        else { this.historyIndex = this.history.length; this.input.value = ''; }
        e.preventDefault();
      } else if (e.key === 'Escape') {
        this.toggle(false);
      }
    });
  }

  _bindKeys() {
    addEventListener('keydown', (e) => {
      if (e.code === 'Backquote') {
        e.preventDefault();
        this.toggle();
      }
    });
  }
}
