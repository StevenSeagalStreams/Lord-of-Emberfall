# Lord of Emberfall — architecture & file ownership

An action-RPG in the Diablo I / Diablo II: Lord of Destruction idiom, built on
three.js r169. All art is **original and procedural** — the project ships no
image, audio, or model files. Every texture, mesh, animation, and sound is
generated in code at load time.

## Running it

```bash
npm install
npm run dev            # http://localhost:5173
node tools/shoot.mjs --all --dir shots/   # headless captures
```

URL params: `?seed=20250731&quality=ultra|high|medium|low&paused=1`

## Update phase order (load-bearing)

`src/main.js` runs a fixed phase order every frame. Subsystems must not
reorder themselves into it arbitrarily:

1. **input** — pointer→ground raycast, edge-triggered keys
2. **orders** — player intent becomes paths/targets
3. **entities** — AI state machines, steering, integration, collision
4. **overlap resolution** — separation so bodies do not interpenetrate
5. **fx** — particles, decals, trails advance
6. **camera** — follows the now-final player position (never before it)
7. **lighting** — flicker, shadow-slot reassignment near the camera focus
8. **ui** — reads final state
9. **render** — composer chain

## The `world` context

Every entity `update(dt, world)` receives one object:

```js
world = {
  scene, bus, rng, camera,
  colliders,   // { isSolidCell(x,y), isBlocked(wx,wz,radius) }
  nav,         // NavGrid: nav.path(fromX, fromZ, toX, toZ) -> [{x,z}] | null
  player, entities, monsters,
  time,        // seconds since start
}
```

## Event bus contract

Emit rather than reach across subsystems. Established events:

| event | payload |
| --- | --- |
| `combat:hit` | `{ attacker, victim, amount, direction, crit? }` |
| `combat:kill` | `{ attacker, victim }` |
| `entity:died` | `{ entity }` |
| `entity:spawned` | `{ entity }` |
| `item:dropped` | `{ item, position }` |
| `item:pickup` | `{ item }` |
| `player:levelup` | `{ level }` |
| `fx:request` | `{ kind, position, direction?, scale?, target?, targetId? }` |

`fx:request` payload notes:

- `position` — where the effect originates, in world space.
- `direction` — unit vector, or `null`. May be absent.
- `target` — `{x,y,z}` **endpoint**, when the effect connects two points.
  Required for anything beam-like or travelling: a lightning bolt must span
  caster to victim exactly, and a projectile must know where it is going.
  Without it an effect can only guess a length, which is why the lightning arc
  used to stop short of whatever it was supposedly hitting.
- `targetId` — optional entity id, so a travelling effect can re-home on a
  moving victim rather than flying at a stale position.

**Projectile stages.** A spell that visibly travels emits three requests, not
two: `<kind>_cast` at the caster, `<kind>_travel` carrying both `position` and
`target`, and `<kind>_impact` at the victim once it arrives. Emitting only cast
and impact produces a puff at each end and nothing in between -- the player
sees no projectile and cannot tell what hit them or from where.

## Rendering rules

- The composer chain renders **scene-referred HDR**. Do not tone map in a
  material or set `renderer.toneMapping` — `PostFX.grade` owns the display
  transform. Bloom thresholds at 1.05, so anything that should glow must
  actually exceed 1.0 in radiance.
- Albedo textures are `SRGBColorSpace`; normal/roughness/AO/metalness are
  `NoColorSpace`. Getting this wrong is the most common cause of "flat" output.
- Every static surface must be instanced or merged. The budget is **< 250 draw
  calls** for a full level view.
- Derive normal/roughness/AO from the *same* height field as the albedo
  (`TextureGen.heightToNormal` / `heightToAO`). Independently authored maps
  disagree and read as decals.

## Art direction (the bar)

The reference is Diablo II: LoD's Act I–II interiors and D1's cathedral.
Concretely:

- **Value structure.** Most of the frame is near-black. Light is *sourced* —
  warm pools from fire, cold from arcane. A uniformly lit room is a failure.
- **Palette.** Desaturated cold stone, warm amber fire, one saturated accent
  (blood red / arcane blue) per scene. Never more than one hue family bright
  at once.
- **Silhouette first.** A character must be readable as a black shape.
  Pauldrons, helms, weapons break the outline; the head is deliberately small.
- **Surfaces tell a story.** Water stains run *down*. Wear is on walking
  lines and edges. Mortar is rough where slabs are polished.
- **No flat.** No untextured plane, no constant-radius limb, no perfectly
  coplanar floor, no unbroken wall run longer than ~6 m.

## File ownership

Agents work on disjoint file sets. **Do not edit a file you do not own.** If
you need a change in someone else's file, note it in your report instead.

| Owner | Files |
| --- | --- |
| core (orchestrator) | `src/main.js`, `src/core/*`, `src/world/zones/index.js`, `ARCHITECTURE.md`, `CRITIC.md`, `tools/*` |
| terrain & environment | `src/world/zones/forest.js`, `src/world/Terrain*.js`, `src/world/Foliage*.js`, `src/world/Props.js`, `src/world/GeoKit.js` |
| dungeon world | `src/world/DungeonGen.js`, `LevelBuilder.js`, `Nav.js`, `src/world/zones/catacombs.js` |
| lighting & atmosphere | `src/render/Lighting.js`, `PostFX.js`, `Renderer.js`, `CameraRig.js`, `src/render/Sky.js` |
| materials | `src/render/TextureGen.js`, `src/render/Materials.js` |
| characters | `src/entities/CharacterRig.js`, `Models.js`, `Animation.js`, `Cloth.js`, `GeoKit.js`, `CharacterTextures.js` |
| enemies | `src/entities/monsters/*` |
| combat & physics | `src/entities/Entity.js`, `Player.js`, `Monster.js`, `src/combat/*`, `src/skills/*` |
| items | `src/items/*`, `src/progress/*` |
| vfx | `src/fx/*` |
| ui | `src/ui/*` |
| audio | `src/audio/*` |

New files go inside your own directory. If you must add a hook in `main.js`,
report the exact snippet rather than editing it.

## Zones

`src/world/zones/index.js` is the registry. A zone factory returns
`{ name, group, colliders, nav, spawnPoint, bounds, spawns, fog, grade,
lightRig, update(dt) }`. The game loop knows nothing about forests or
catacombs -- it asks for a zone by name. Select with `?zone=forest|catacombs`.

`grade` maps onto the PostFX grade uniforms and `lightRig` onto the Lighting
rig, so each zone carries its own colour identity (the WoW pillar) without any
subsystem special-casing it.

## Verification

Nothing is done until it has been seen. Every agent must run:

```bash
node tools/shoot.mjs --all --dir shots/<yourname>/ --quality high
```

and read the resulting PNGs before reporting. Frame rate reported by the
harness is meaningless — headless runs on SwiftShader (software GL). Judge
image quality only; judge performance from draw-call and triangle counts.
