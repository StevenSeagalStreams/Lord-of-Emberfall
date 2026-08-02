# LORD OF EMBERFALL — VISION (CANONICAL, OUTRANKS ALL METRICS)

> **GAME DIRECTION MANDATE — supersedes the colour script below where they
> conflict. Systems outrank screenshots. "Done" means: a player can play it, it
> can kill them, and it can reward them. Screenshots are evidence, not product.**

## Part 0 — Identity

- **Graphics: Diablo 1.** Oppressive, claustrophobic, torchlit. Darkness is a
  *gameplay resource* — light pools around torches and the hero, corridors fade
  to genuine black, you hear things before you see them. Palette: stone greys,
  dried-blood reds, candle golds, sickly greens. Cathedral → catacombs → caves
  → hell as the tonal ladder. **Interiors dominate; the surface zone exists to
  funnel you underground.**
- **Feel: WoW dungeons and raids.** Deliberate, punishing, pull-based. Enemies
  are not popcorn — they are packs you plan around. One careless step
  chain-pulls the room and you die. Bosses are mechanics checks, not stat
  checks.
- D1's dread, WoW's discipline. That pairing *is* the product.

## Order of operations (non-negotiable)

Each gate STOPS for Borka. Art continues in parallel but may never block or
outrank a systems gate.

1. **Combat feel lock** — player controls + 3 skills + one pack fighting back,
   tuned until movement and hit feel are right.
   *Gate: Borka plays and approves feel before anything below is built.*
2. **Pull system** — pack / social aggro / patrols / runners in a graybox wing.
   *Acceptance test, verbatim: Borka must wipe at least once to a chain pull he
   recognises as his own fault, and clear it on a later attempt through learned
   play.*
3. **Itemization + drop engine + harness validation** → drop-feel gate.
4. **First full dungeon + boss** → dungeon-balance gate.
5. **Crafting / economy** → economy gate.
6. Only then: second dungeon, more skills, breadth.

> A graybox dungeon with perfect pull tension is a better game than a beautiful
> forest with nothing in it.

## Player (D1 DNA)

Strength / Dexterity / Vitality / Energy, allocated on level-up, with real gear
requirements that gate equipping. **Life does not regenerate in combat** —
potions and leech only. Mana regenerates slowly. Six skills on the bar by M2: a
builder, a spender, an AoE, a defensive, a movement/escape, a long-cooldown
ultimate — each with cast time or animation lock, mana cost, cooldown, and a
reason to exist. Death drops a corpse carrying your gear; you run back naked to
retrieve it.

**Controls are the first thing tested:** input buffering, animation cancelling
on the back half of swings, no dead frames. If movement feels floaty, nothing
else matters.

## Enemies — the pull system is the heart

Authored packs of 3-8 with roles (bruisers front, casters back, a leader that
buffs). Aggro radius plus social aggro; packs within link radius chain.
Patrols on fixed 20-40s routes crossing between static packs. Runners flee at
low HP and aggro the next pack. Casters hold range and reposition for line of
sight, so the player can pull around corners onto ground they chose. Packs
leash and reset at full HP. Roster target: swarm melee, skeleton warrior with
block, skeleton archer, caster, bloated exploder, telegraphed brute, summoner
(priority target), stealther. Champions carry two affixes; named rares have
fixed placement and better loot. The player needs a stun and a slow so a bad
pull is *barely* recoverable by skill.

---

## Part 1 — The Vision Gate (runs BEFORE any metric, in every critic pass)

Four qualitative questions, answered from the screenshot alone, before a single
number is consulted. **Failing ANY of them fails the pass** regardless of luma,
draw calls, or triangle counts being in band.

1. **Zone test** — "Name this zone from the shot alone." If the answer is not
   unmistakably the zone under test, FAIL. A sepia desert is not a forest.
2. **Franchise test** — "Which game does this frame most resemble?"
   Acceptable: Diablo II, WoW, "a dark-fantasy ARPG".
   Unacceptable: "an art experiment", "a tech demo", "shadow puppets", "a desert".
3. **Play test** — "What would I do in this frame?" A gradable gameplay shot
   must contain the hero, at least one threat or destination, and at least one
   reward cue (drop, chest, exit, quest object). Empty vistas are allowed only
   for shots explicitly declared `vista`.
4. **Material test** — "Point at three surfaces and describe their material."
   If any surface can only be described as "flat black" or "flat colour", FAIL.
   Silhouette-black objects in a lit scene means broken materials, not mood.

---

## Part 2 — Colour script

**Superseded for the primary target.** Part 0 moves the graphics target to
Diablo 1 interiors: stone greys, dried-blood reds, candle golds, sickly greens,
darkness as a gameplay resource. The forest script below still governs the
surface zone, but the surface zone is now a funnel to the dungeon, not the
showcase. Interior colour script is written before interior work begins.

### Blighted Forest (surface funnel)

No zone is built from vibes. Every zone gets its section here **before** work
begins.

- **Ground** — cold grey-brown earth and mud, patches of dead green-grey grass,
  worn dirt paths, exposed roots, scattered rocks.
  **NOT sand. NOT dunes. NOT hardpan tiling.**
- **Vegetation** — trunks are *lit bark*: deep brown-grey with visible
  normal-mapped ridges, sun side and shade side clearly different. Canopies are
  dark desaturated green-to-sickly-olive foliage masses that **receive light**,
  with sky visible through gaps. Trees must read as objects **in** the light,
  never as cutouts **in front of** it.
- **Sky** — cold overcast gradient, pale grey-blue zenith to sickly
  yellow-green horizon haze. Never beige, never featureless.
- **Atmosphere** — exponential fog for depth layering: near trees dark and
  detailed, far trees pale and simple. Aerial perspective is what makes a
  forest look deep.
- **Accents** — warm torch/ember orange, used sparingly as the only warm note.
  That contrast *is* the Diablo mood.
- **Props (D2 Blood Moor DNA)** — broken fences, a cart, gravestones, corpse
  piles, crows, a hut ruin, a visible dirt road leading somewhere.

---

## Part 3 — Playability is a pillar, not a later

**Core Loop Invariant.** The game must be playable and fun in a 60-second slice
at all times:

> spawn → see a destination → fight a pack (readable, punchy, dodgeable) →
> loot drops with a beam → pick it up → equip something → feel stronger → repeat

- If **any** link is broken, fixing it takes priority over all visual and all
  instrument work.
- Every capture set must include one `combat` shot proving the loop: hero
  mid-fight, enemies reacting, at least one drop on the ground.
- Every session report opens with
  `Core loop status: INTACT | BROKEN at <link>`.

---

## Part 4 — Anti-drift process rules

1. **Task ratio** — instrumentation/tooling may never exceed 1 task per 3
   art-or-gameplay tasks. Four instrument bugs fixed in one session while trees
   shipped black means the ratio inverted.
2. **Metrics are floors, not goals** — luma bands, draw budgets and triangle
   counts are disqualifiers for obviously broken output. Being in band earns
   nothing. **No task may be phrased as "get metric X into band"**; it must be
   phrased as a visual or gameplay outcome whose success also lands in band.
3. **Vision diff ritual** — at the end of every session, place the best current
   gameplay shot beside Part 2 and answer in writing: *"What is the single
   biggest gap between this frame and the script?"* That gap is automatically
   the next session's first art task.
4. **Scope firewall** — no new systems, zones or features while any Vision Gate
   question fails on the current zone. Depth before breadth.
5. **The human is the director** — Borka may override any priority at any gate.
   When the session report and Borka's play experience disagree, Borka's
   experience is ground truth.

---

## Open findings

### Draw calls: the world is instanced; the characters are not (2026-08-02)

Measured in the catacombs at default framing: **865 draws / 722,391 tris**.
Attribution from `tools/probe.mjs`:

- `Walls` — 1,114 instances in **1 draw call**
- `Floor` — 3,049 instances in **1 draw call**
- everything else — a long tail of ~15 small meshes per character, x56 living
  monsters, which is roughly **840 of the 865**

So the level is not the cost and never was. Each `CharacterRig` parents ~15
separate `Mesh` objects to bones, and every one is its own draw call, on every
monster. The `wide` scenario's 2,325 reading is the same problem with more
monsters pulled into frame by content-framing.

**Owner: the character pillar**, not the world. The fix is to merge each rig's
parts into a single geometry (or a skinned mesh), or to instance across
monsters that share a kind. Until then no amount of world-side instancing moves
this number, and any budget conversation about zones is measuring the wrong
thing.

## Vision diff log

Newest first. One entry per session, written against the best gameplay shot.

### 2026-08-02 (later) — the loop closed underground; the characters are the gap

Best shot: `shots/f4/combat.png` — catacombs, five skeletons engaged, hero
mid-fight. Vision Gate: **1 PASS, 2 PASS, 3 FAIL, 4 FAIL.**

1. **Zone test — PASS.** Cobbled stone, a torch pool, bone. It is unmistakably
   a catacomb. This is the first frame in the project's history to pass
   question 1, and it passed by moving underground rather than by fixing the
   forest — the mandate said interiors dominate and it was right.
2. **Franchise test — PASS.** Orb HUD, skill bar, torchlit stone, a pack of
   skeletons closing in. "A dark-fantasy ARPG" is the honest answer.
3. **Play test — FAIL.** Hero present, five threats present and legibly
   health-barred, but **no reward cue anywhere in frame.** Nothing drops
   because items is still a stub. This is a known, deliberate gate-3 gap, so
   it is not a surprise — but the gate asks whether the frame shows a game,
   and a fight with no possibility of loot does not.
4. **Material test — FAIL.** The floor reads as genuine wet cobble and the
   bone reads as bone, but the walls beyond the torch radius are flat black,
   and "flat black" is the explicit failure condition. In D1 darkness is a
   gameplay resource, which means you must see *just enough* — a silhouette,
   an edge, a suggestion of depth. Here there is simply nothing there.

**Single biggest gap: the characters are stick figures.** They are the subject
of the frame — five of them, front and centre, nameplated — and at gameplay
zoom they read as poles with a suggestion of ribcage. Every other element of
the frame is now carrying its weight and they are not. This is exactly what
Borka said, twice, in his own words, and it outranks the wall-blackness above.

Next art tasks, in order: land G1/G2 (2x scale, real silhouette, a cloak that
hangs); then give unlit walls a floor of readable form so darkness reads as
depth rather than absence; then the reward cue, which arrives with gate 3.

Process note, recorded honestly against rule 1: this session ran four
gameplay/art tasks (F1 hold-to-move, G3 projectiles, G4 arcs, F4 confirmation)
against one throwaway measurement script. The ratio held.

### 2026-08-02 — sun moved off the camera axis

Best shot: `shots/sunfix/wide.png`. Vision Gate: **1 FAIL, 2 FAIL, 3 FAIL, 4 PASS.**

The black trees are fixed, and the cause was not materials. The camera sits at
azimuth 45; the sun sat at 232, which is 173 degrees off the view direction --
almost perfectly behind the subject. Every tree turned its shade side to the
camera. That is exactly "cutouts in front of the light", and no albedo change
could have fixed it. Sun moved to azimuth 115, 70 degrees off camera, so every
trunk and canopy now shows a lit face and a shade face.

Material test now PASSES: the three largest surfaces can be named as cracked
stone, dry sandy earth, and dark metal. None are flat black.

**Single biggest gap:** the canopies are made of *cracked stone* and the ground
is *sand*. The frame reads as a boulder field in a desert. Zone identity is
still the failure, and it is now purely a palette-and-texture problem rather
than a lighting one.

Next art tasks, in order: canopy foliage material (dark desaturated green to
sickly olive, receiving light, sky through gaps); ground rebuilt as cold
grey-brown moor with dead grass; overcast sky gradient; zone props.

### 2026-08-01 — gate 3

Best shot: `shots/gate3/wide.png`. Vision Gate result: **FAIL on 1, 3 and 4.**

**Single biggest gap:** the trees are unlit black cutouts standing in front of
a sepia frame, so the zone reads as desert badlands rather than forest. The
frame has no reward cue and no readable material on its largest objects.

Correction backlog, in order: un-black the trees (materials/lighting), rebuild
the ground as moor rather than dune, sky and fog per the colour script, zone
props, then core-loop proof.
