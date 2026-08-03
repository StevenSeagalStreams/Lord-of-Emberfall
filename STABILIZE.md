# STABILIZE.md — PLAYABILITY FIRST

**Supersedes conflicting parts of VISION.md and the GAME DIRECTION MANDATE.
Read fully before any task.**

The director played the build. Verdict: **unplayable.** Lag, unreadable
darkness, broken run animation, zero visible drops, broken death flow.

**All art tasks, all new systems, and all instrument work are FROZEN** until
every P0 below is fixed and Borka approves the playability gate.

> A laggy beautiful game is a failed game.

---

## RULE 0 — the target hardware is the real machine

Stable **60 FPS**, hard floor **never below 45**, on an **Intel Iris-class
integrated GPU at 1080p** — the machine Borka actually tests on. Not a
dev-mode assumption. Not a gaming rig. Every performance decision is measured
against that target.

An FPS readout is permanently visible in dev builds, and every commit records
measured FPS on the lowest and default presets.

### Honest limitation of this dev environment

**FPS measured here is meaningless and will never be quoted as if it were
real.** The capture harness runs Chromium on SwiftShader — a software GL
rasteriser with no GPU behind it — so its frame timings describe a CPU
software renderer, not an Iris. There is no Intel Iris machine in this
environment.

So commits record the proxies that *are* real and that genuinely drive GPU
cost, measured with `tools/probe.mjs`:

- **draw calls** and **triangles per frame**, counted across every pass
  including shadow maps
- **shadow-casting light count** (each shadow-casting point light re-renders
  the scene six times for its cube map)
- **full-screen post passes enabled**
- **render target pixel count** (`pixelRatio²` × viewport)

and the authoritative number comes from Borka reading the on-screen counter on
the NUC. Any commit claiming an FPS figure without that is lying.

---

## Standing priority order (permanent, top wins)

1. Runs at 60 FPS on the real machine
2. Core loop intact and fun (kill → loot → equip → stronger)
3. Readability (see everything that matters)
4. Death/recovery flow works
5. Exploration pull (somewhere to go, a reason to go there)
6. Depth (affixes, crafting, pulls, bosses)
7. Beauty

Anything on this list may only be improved by sacrificing things **below** it,
never above it. **Graphics quality is rank 7. It stays rank 7.**

---

## P0 defects, in fix order

### P0-1 — Performance ✅ landed, pending hardware confirmation

- SSAO off by default; bloom off at `low`; grain and vignette are uniforms in
  the existing single grade pass, not extra passes; SMAA off below `high`.
- `pixelRatio` hard-capped at 1 on every player-facing preset.
- Shadow maps ≤ 1024. **One shadow-casting light only** (the sun/key); all
  torches non-casting.
- Presets Low / Medium / High, **defaulting to Low**, in a settings menu
  (Esc). Auto-downgrade after 5 s below 55 FPS, with an on-screen notice.
  `ultra` is capture-only and unreachable from the menu.

**Acceptance (Borka):** 5 minutes of combat on the NUC at the default preset
with the readout showing ≥ 60 FPS sustained, no hitches on pack aggro or drops.

### P0-2 — Too dark (readability)

Darkness is a **mood, never an information failure.** The hero, all aggroed
enemies, drops, and walkable floor within 1.5 screen-heights must **always**
be clearly readable. D2 is the reference: dark palette, fully readable play
space. Near-black is reserved for screen edges and unexplored fog — never the
combat space.

**Acceptance:** Borka plays a full dungeon wing without ever losing track of
his character, an enemy, or a drop.

### P0-3 — Run animation

Cycle speed tied to actual velocity (no foot slide), no T-pose or limb
popping, turns must not snap the skeleton, idle↔run blends over ~0.15 s. A
simple correct run beats a fancy broken one.

**Acceptance:** Borka runs a loop and calls it "fine." That is the bar.

### P0-4 — Zero drops seen

Diagnose in order: (1) is the death event firing the drop roll at all? (2) is
the roll producing items but failing to spawn world entities? (3) are entities
spawning but invisible? (4) or are NoDrop rates absurd?

Then enforce the D2 feel-floor: trash packs drop something visible constantly;
a magic (blue) item every pack or two; the screen after a pack fight has
glitter on the ground. Drops need beam + ground label + click pickup + audio
tick.

**Acceptance:** 10 trash mobs killed with no console produces multiple drops;
a blue appears within ~2 packs; pickup works every time.

### P0-5 — Death / ghost-walk

One state machine, every transition tested: die → death anim → corpse persists
with gear → respawn as ghost at graveyard/waypoint → ghost cannot fight, moves
slightly faster, world desaturated → reach corpse → resurrect prompt →
restored with gear → 3 s invulnerability. Edge cases now: dying as a ghost
impossible, corpse in a boss room reachable, reload preserves the corpse.

**Acceptance:** Borka dies on purpose three times in different places and
recovers cleanly each time.

---

## Playability gate

After all five P0s: full playtest gate protocol — build, `PLAYTEST_NOTES.md`,
telemetry. Borka plays the 60-second core loop and the death loop on the NUC.

**Nothing unfreezes without `GATE APPROVED`.** That line is Borka's alone; it
is never written, inferred, or assumed from silence.

---

## Revised pillars

**Feel of Diablo II, exploration of WoW.**

1. **The grinding loop is the product**: kill → loot → stronger → repeat.
   Every build must deliver it smoothly. Farming targets exist so "one more
   run" is always a sensible thought. Unexpected rewards over scheduled ones.
2. **Dark but readable atmosphere**: gritty palette; danger and isolation live
   in the audio and the pacing, not in hiding the game from the player. Sound
   pulls real weight — distinct drop stings, distant monster audio, sparse
   melancholic town music.
3. **Depth without overcomplexity**: a new player needs only click-move, one
   attack, and potions in minute one. Affixes, crafting and synergies reveal
   themselves gradually. **Cut anything not self-explanatory in one tooltip.**
4. **WoW exploration**: distinct zone identities with landmarks on the horizon
   that pull you toward them; hidden corners that reward wandering; quest
   breadcrumbs that lead through zones rather than teleporting past them;
   discovery as an event (zone-name splash, music shift). Scale and openness
   above ground; dungeons stay the tight, dangerous counterpart.
5. **Progression you can feel**: level-ups loud and bright; a gear upgrade
   visibly changes numbers *and* kill speed; always a next goal on screen.

**Deferred, not deleted:** multiplayer/trading, multiple classes, difficulty
tiers. Design data structures so they can bolt on later (difficulty as a
stat/loot multiplier table), but build none of it now.
