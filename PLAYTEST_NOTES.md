# PLAYTEST GATE 1 — COMBAT FEEL LOCK

**Status: awaiting Borka. Nothing below gate 1 is being built until this is approved.**

```bash
cd game
npm install
npm run dev        # http://localhost:5173  — opens in the catacombs
```

---

## What changed since the last gate (5 lines)

1. The build now opens **underground**. Interiors are the game; the surface is a funnel.
2. **Controls**: clicks buffer during a swing and fire the instant it becomes cancellable; recovery is cancellable the moment damage lands.
3. **Three skills** on 2 / 3 / 4 — a builder, an AoE spender, and a panic button.
4. **Life no longer regenerates in combat.** Potions and leech only.
5. Melee damage now flows through the one damage funnel, so equipment will actually change it.

---

## What to test — concrete scenarios

### A. Movement and swing feel (this is the gate)
Walk around. Attack a skeleton. Attack while moving. Click again mid-swing.

- **Expected:** movement starts on the frame you click, with no slide or lag.
  A click landing mid-swing is never dropped — it fires the moment the current
  swing connects, giving a roughly **0.27 s** cadence when you chain attacks
  instead of **0.62 s** if you wait out each animation.
- **Reference anchor:** this should feel like **Diablo II at Blood Moor level
  2–4** — deliberate, weighty, but never sticky. If it feels floaty or
  unresponsive, the gate fails and nothing else matters.

### B. The three skills
`2` Firebolt · `3` Frost Nova · `4` Arc Storm

- **Expected:** each has a visible commitment. You cannot cancel a cast by
  moving, and you cannot fire a second skill during one. Firebolt is cheap and
  spammable; Arc Storm is your pack answer; Frost Nova is the button you press
  when a pull goes wrong.
- **Reference anchor:** WoW dungeon pacing — you should be *choosing* when to
  spend, not mashing.

### C. The D1 life rule
Take damage. Stand still. Watch the red orb.

- **Expected:** it does **not** refill while you are in combat, and only starts
  regenerating ~5 s after the fight ends. This is the rule that makes a bad
  pull actually cost something.

### D. One pack, fought carefully vs carelessly
Find a room with 3–4 skeletons. Fight them in the open. Then reload and fight
them in a doorway.

- **Expected:** the open fight should be genuinely dangerous — roughly **8 s to
  kill you** if you stand still and facetank. The corridor fight should be
  clearly better. **Trash time-to-kill is ~2–3 hits each.**
- **Reference anchor:** clearing Blood Moor at level 2–4 — trash dies fast, but
  a careless group still kills you.

---

## Debug console — backtick (`` ` ``)

```
tp <zone|x z>     teleport (catacombs | forest, or coordinates)
spawn <kind> [n]  spawn monsters around you   (kinds: skeleton, swarmer, brute)
killall           clear the room
level <n>         set character level
heal              refill life and mana
god / noclip      god works; noclip is stored but NOT yet enforced
droprate <x>      drop multiplier — WARNS that stats gathered under it are invalid
telemetry dump    write the session JSON now
seed [n]          show or change the seed
help              generated from the command table, so it cannot go stale
```

## Telemetry — F3

fps, draws, tris, kills and kills-by-kind, deaths, damage in/out with
per-minute rates, potions, gold, live drop tally by rarity, clear timer.
Writes `telemetry/session-<timestamp>.json` on exit.

---

## Known gaps — deliberately NOT built for this gate

The order of operations says gate 1 is *controls + 3 skills + one pack*, and
the scope firewall forbids building past it. So these are **known missing**,
not oversights:

- **No loot.** Items is still a stub; nothing drops. That is gate 3.
- **No stat allocation, no gear requirements, no corpse run.** Gate 1 is feel.
- **No patrols, runners, social-aggro chaining, or authored pack placement.**
  That is gate 2 — the pull system — and it is the next thing built.
- **Only 3 of the 6 eventual skills.**
- `noclip` is accepted by the console but not enforced; it needs a change in a
  file the combat pillar owns.
- Art is mid-flight: the catacombs are the old dungeon dressing, not the D1
  cathedral palette from the mandate.

---

## What I need from you

Fill in `PLAYTEST_FEEDBACK.md` (template beside this file). The only question
that matters at this gate:

> **Does the character feel good to move and swing?**

Everything else is noise until that is yes. If it is no, say what specifically
feels wrong — sticky, floaty, delayed, weightless — and I will fix that before
building anything else.

**The gate closes only when you write `GATE APPROVED` in the feedback file.**
I will not write that line, infer it, or proceed on silence.
