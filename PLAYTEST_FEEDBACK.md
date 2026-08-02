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
| F1 | **Hold-to-move.** Holding the mouse button moves the character continuously toward the cursor, Diablo-style. Click-to-move alone is wrong for the genre. | combat | open |
| F2 | **Attacks do not hit.** Melee resolved to zero damage. | core | **FIXED** — see below |
| F3 | **Spells do not hit.** Skill damage is not landing on monsters. | combat | open |
| F4 | **No monster health readout.** No way to tell how much life a monster has. | ui | open |
| F5 | **Character not recognisable.** Model needs to read as a class at gameplay zoom; cloak bigger. | characters | open |
| F6 | **Everything slightly bigger.** Gear changes must be visible — you should see a new weapon or armour piece. | characters | open |
| F7 | **No restart after death.** The game cannot be continued once you die. | core | open |
| F8 | **Ghost walk + checkpoints.** WoW-style: die, walk back as a ghost from a checkpoint to your corpse. | core | open |

### F2 root cause — my regression, fixed

`main.js` read `damageMin`/`damageMax` straight off `items.stats` and only fell
back when they were non-finite. The items pillar is still a stub reporting a
placeholder `0/0`, which is perfectly finite, so **every melee swing resolved to
exactly zero damage** and the game was unwinnable. Introduced by me in the same
commit that fixed three other bugs in that call site.

Equipment now **adds** to a base swing instead of replacing it, so a subsystem
that does not exist yet contributes nothing rather than zeroing everything out.
Verified: stub `{0,0}` now yields base `[14,24]`; gear `+6/+10` yields `[20,34]`.
