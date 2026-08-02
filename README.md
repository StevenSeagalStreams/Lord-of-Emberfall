# Lord of Emberfall

A moody isometric ARPG: **Diablo I's dread, WoW's discipline.** Oppressive
torchlit interiors where darkness is a gameplay resource, and deliberate
pull-based combat where one careless step chains packs and kills you.

Built on [three.js](https://threejs.org) r169. **All art is procedurally
generated in code** — the project ships no image, audio, or model files. Every
texture, mesh, animation and effect is synthesised at load time.

> The art is original work in the genre's idiom. It deliberately reproduces no
> assets from Diablo, World of Warcraft, or any other game.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173 — opens in the catacombs
```

URL parameters: `?seed=20250731&zone=catacombs|forest&quality=ultra|high|medium|low&fxdemo=1&silhouette=1`

## In-game tools

| key | |
| --- | --- |
| `` ` `` | debug console — `tp`, `spawn`, `killall`, `level`, `god`, `droprate`, `telemetry`, `help` |
| `F3` | telemetry overlay — fps, draws, kills, damage rates, drop tally; writes session JSON on exit |

## Where things are

```
src/core/      loop plumbing: event bus, seeded RNG, input, console, telemetry
src/render/    renderer, HDR post chain, lighting rig, sky, procedural materials
src/world/     zone registry, dungeon generation, terrain, foliage, props
src/entities/  character rigs, procedural animation, player, monsters
src/combat/    damage model, monster profiles, pack aggro, self-tests
src/skills/    skill definitions and casting
src/fx/        GPU particles, decals, loot beams, torch fire
src/ui/        HUD
tools/         headless capture harness and live scene probe
```

## Verification

Nothing is considered done until it has been seen or measured.

```bash
node tools/probe.mjs                 # live scene: lights, materials, draws, triangles
node tools/shoot.mjs --all --dir shots/   # headless captures with exposure grading
node src/combat/selftest.mjs         # damage, armour, knockback, hit-stop, fx contract
node src/combat/feeltest.mjs         # frame-by-frame combat feel timeline
```

Headless capture runs on SwiftShader (software GL), so **reported FPS is
meaningless** — judge image quality from the captures and performance from
draw-call and triangle counts.

## The documents that govern this project

- **[VISION.md](VISION.md)** — canonical. Identity, the Vision Gate, the order
  of operations, and the anti-drift rules. Outranks every metric.
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — update phase order, the shared world
  context, the event contract, rendering rules, file ownership.
- **[CRITIC.md](CRITIC.md)** — the rubric independent critics grade against.
- **[CRITIC-LOG.md](CRITIC-LOG.md)** — every critic verdict, verbatim, including
  the failing ones.
- **[PLAYTEST_NOTES.md](PLAYTEST_NOTES.md)** — the current open playtest gate.

## Status

**Gate 1 — combat feel lock — is open and awaiting playtest.**

Built and verified: input buffering, animation cancelling on the back half of
swings, three skills with real commitment, and the Diablo rule that life does
not regenerate in combat.

Not yet built, deliberately: loot and itemisation, the full pull system
(patrols, runners, social-aggro chaining), bosses, crafting. The order of
operations gates each behind a human playtest, and no gate closes without an
explicit approval.
