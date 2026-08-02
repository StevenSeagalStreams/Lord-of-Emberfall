# PLAYTEST FEEDBACK — GATE 1: COMBAT FEEL LOCK

## Round 1 — Borka, 2026-08-02

**VERDICT: NOT APPROVED — sent back.**

Raw feedback as given:

> it is not running great, the controls needs to be better, usually diablo
> players hold down the mouse button instead of clicking to move the character,
> so this needs to be done for this game too, the spells dont hit the monsters,
> and there is no way to tell how much life the monsters have, the character
> model needs to be more recognizable, and his cloak maybe made a bit bigger,
> thats overall for the game, everything needs to be a little bit bigger, so you
> can tell the different when you put on a new armor or weapon, and so you can
> tell what class you are. the spells and attacks are not hitting the mobs, that
> needs to be fixed. there is no way to start the game after death, it would be
> cool to add a ghost walk like in world of warcraft, but then there needs to be
> add'ed checkpoints where you can shadow walk from to you corpse if you should
> die.

### Named fix tasks

| # | Task | Owner | Status |
| --- | --- | --- | --- |
| F1 | **Hold-to-move.** Holding the mouse button moves the character continuously toward the cursor, Diablo-style. Click-to-move alone is wrong for the genre. | combat | **FIXED** — see below |
| F2 | **Attacks do not hit.** Melee resolved to zero damage. | core | **FIXED** — see below |
| F3 | **Spells do not hit.** Skill damage is not landing on monsters. | combat | **FIXED** — melee auto-swing was starving every cast |
| F4 | **No monster health readout.** No way to tell how much life a monster has. | ui | built, awaiting visual confirmation |
| F5 | **Character not recognisable.** Model needs to read as a class at gameplay zoom; cloak bigger. | characters | open — folded into G1/G2 |
| F6 | **Everything slightly bigger.** Gear changes must be visible — you should see a new weapon or armour piece. | characters | open — folded into G1/G2 |
| F7 | **No restart after death.** The game cannot be continued once you die. | core | **FIXED** — `src/core/DeathSystem.js` |
| F8 | **Ghost walk + checkpoints.** WoW-style: die, walk back as a ghost from a checkpoint to your corpse. | core | **FIXED** — `src/core/DeathSystem.js` |

### F1 root cause — the method existed, nothing called it

`Player.orderHold()` was written but never wired: `main.js` still called
`orderMove`/`orderAttack` on every held frame, and both start a fresh A*. Sixty
pathfinds a second at a cursor that has barely moved is a real part of what
"it is not running great" felt like.

Writing the test then found a second bug inside `orderHold` itself. Its repath
guard treated *"pathIndex is on the last leg"* as *"the path has run out"* —
true for the entire final stretch of every path and for the whole of any short
one, so a held cursor just behind a wall re-ran A* on all sixty frames anyway,
precisely the cost the guard existed to avoid.

Measured with a call-counting nav stub: a second of holding with clear line of
sight now runs A* **zero** times (it steers straight at the live cursor); a
blocked hold runs it **under fifteen** times instead of sixty.

### F2 root cause — my regression, fixed

`main.js` read `damageMin`/`damageMax` straight off `items.stats` and only fell
back when they were non-finite. The items pillar is still a stub reporting a
placeholder `0/0`, which is perfectly finite, so **every melee swing resolved to
exactly zero damage** and the game was unwinnable. Introduced by me in the same
commit that fixed three other bugs in that call site.

Equipment now **adds** to a base swing instead of replacing it, so a subsystem
that does not exist yet contributes nothing rather than zeroing everything out.
Verified: stub `{0,0}` now yields base `[14,24]`; gear `+6/+10` yields `[20,34]`.


---

## Round 2 — Borka, 2026-08-02

> The visuals are not up to standard they need to be utterly perfect especially
> Characters like the hero (player model) and the enemies they need to be made
> bigger, scaled up 2 times, and more detailed. the characters cloak looks very
> spread out like a flat board on hes back, it needs to be more loose and float
> down his body. the spells need to be more visual so you know where they hit,
> lightning needs to be a line to the target and fire flies trough the air
> making a trail behind it and so on.

### Named fix tasks

| # | Task | Owner | Status |
| --- | --- | --- | --- |
| G1 | **Characters 2x scale + far more detail** — hero and every enemy. | characters | in progress |
| G2 | **Cloak reads as a flat board.** Must hang loose and drape down the body, not stand out rigid behind it. | characters | in progress |
| G3 | **Fire must fly with a trail.** | vfx + combat | **FIXED** — see below |
| G4 | **Lightning must be a line that reaches the target.** | vfx + combat | **FIXED** — see below |

### Root causes found before dispatch

**G3 — there is no projectile.** `firebolt` emits only `castFx` at the caster
and `impactFx` at the victim. `fireball_travel` is implemented in the FX layer
but **nothing ever emits it**, so nothing crosses the gap. The player sees a
puff at each end and no flight.

**G4 — the bolt never reaches anything.** `lightningArc` draws along
`length = 3 + scale * 5`, a hardcoded distance down a direction vector. It has
no idea where the target is, so it stops wherever that constant runs out.

Both are contract gaps as much as art gaps: `fx:request` carried `position` and
`direction` but no **endpoint**. The contract now carries `target` (and
optional `targetId` so a projectile can re-home on a moving victim), and
documents that a travelling spell emits three stages, not two.

### What shipped for G3 / G4

**G3.** Firebolt is a real projectile. The cast's `impact` animation event now
only *releases* the bolt; the bolt carries its own damage roll and applies it
**on arrival**, so there is a genuine gap between casting and hitting. It
re-homes to the live target each tick, and if that target dies mid-flight the
bolt impacts at the last point it was actually seen at. The trail is
emission-per-frame rather than a bolted-on system: a hot glow core above 1.0
radiance so bloom catches it, and a deliberately sub-1.0 dust wake cooling
behind it.

**G4.** Arcs now span caster to victim exactly — a dim halo pass under a
bright jagged core, with forks peeling off. Frost Nova, which has neither
travel nor target and so read as nothing at all, gained an expanding ring at
its true radius so you can see who it caught rather than inferring it from the
health bars afterwards.

One consequence worth stating plainly: because damage now lands on arrival
rather than on cast, **the spells are slightly slower to kill than they were**.
That is the intended trade — a projectile you can see is a projectile that
takes time to get there — but it is a feel change, and feel is yours to judge,
not mine.
