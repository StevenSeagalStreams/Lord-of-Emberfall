# Critic log

Independent critics, fresh context, given only the captured PNGs and
`CRITIC.md`. Never told what was changed or why. Scores recorded verbatim,
passing and failing alike.

---

## M1 gate 1 — Blighted Forest establishing shot

**Date:** 2026-08-01
**Frames:** `shots/verify/wide.png`, `shots/light/wide.png`
**Measured:** 902,239 tris / 545 draws; mean luma 0.1975, p05 0.087, p50 0.188,
p95 0.350, 0% crushed, 0% clipped.

| pillar | score |
| --- | --- |
| materials / texture | 3 |
| lighting | 3 |
| post-processing | 2 |
| silhouette / readability | 2 |
| animation / physics | 1 |
| vfx | 1 |
| ui | 5 |
| audio | n/a |
| performance | 4 |

**RESULT: FAIL** (gate requires >= 9 on every pillar)
**Side-by-side verdict: NO** on both frames — D2 LoD Act I and Elwynn Forest
both win outright.

### The finding that matters

> "Without being told this was 'The Blighted Forest', I would call this a
> canyon, a dry wash, or a cave interior. **If 386 trees exist in this scene,
> this establishing shot is aimed at the one place they aren't.**"

The trees were built and measured, but the `wide` scenario frames the player
spawn, and the spawn sits in a rock bowl. The capture harness was grading a
part of the level that does not represent the level. That is a defect in the
instrument, not only in the art — the same class of error as the boot-overlay
capture and the HUD-dominated ablation.

### Ranked fixes (critic's own words, condensed)

1. Point the establishing shot where the trees are, or put trees in frame —
   a dozen visible at varying depth, trunks breaking the skyline.
2. Ground reads as cracked desert hardpan, not forest floor. Needs leaf
   litter, moss, root mats, damp soil; and floor must differ in material
   from cliff.
3. No identifiable key direction or hue split — lit and shadowed faces are
   the same desaturated brown. Warm low key against cool ambient fill.
4. Player silhouette unreadable at gameplay distance — needs scale, contact
   AO, and a rim light to separate from equal-value ground.
5. No bloom on any source in a near-black scene; lights do not read as lights.
6. No VFX at all — no embers, mist, motes. (Accurate: `src/fx/` is still a
   stub; no agent has built it.)
7. 545 draw calls against a 250 budget, and the triangle spend is on content
   not visible in frame.

### Notes for the next pass

- Pillars 5 and 6 (animation/physics, vfx) cannot exceed ~1 from a still
  frame. Animation was separately verified by `src/combat/feeltest.mjs`;
  VFX genuinely does not exist yet. Neither number is a surprise, and
  neither is evidence the critic was wrong.
- The two frames were near-identical because both were captured after the
  same lighting fix. Future gates should compare a before/after pair or a
  single frame, not two of the same thing.
