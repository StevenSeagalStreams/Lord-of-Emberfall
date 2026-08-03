#!/usr/bin/env node
/**
 * Drop-rate harness.
 *
 * STABILIZE.md P0-4 states the feel floor in words: "trash packs drop
 * something visible constantly; a magic (blue) item every pack or two; the
 * screen after a pack fight should have glitter on the ground." This turns
 * each of those into a number and checks it over a large sample, so the
 * tuning conversation is about measurements rather than impressions.
 *
 * This is HALF of the verification. The drop-feel rule is explicit that rates
 * need a harness pass AND a human pass, in that order, and that neither one
 * alone settles it. Nothing here says the drops *feel* right -- only that
 * they occur at the rate the mandate asked for.
 *
 *   node src/items/droptest.mjs [kills]
 */
import { RNG } from '../core/RNG.js';
import { rollDrops } from './Drops.js';

const KILLS = Number(process.argv[2] ?? 10000);
const PACK = 4;

const rng = new RNG(20250731).fork('drops');
const trash = { rank: 'trash' };

let pass = 0;
let fail = 0;
const failures = [];
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  ok   ${label}${detail ? ` (${detail})` : ''}`); }
  else { fail++; failures.push(label); console.log(`  FAIL ${label}${detail ? ` (${detail})` : ''}`); }
}

// --- roll a big sample -----------------------------------------------------
let anyDrop = 0;
let gold = 0, potion = 0, equipment = 0;
const byRarity = { normal: 0, magic: 0, rare: 0 };
let totalDrops = 0;

for (let i = 0; i < KILLS; i++) {
  const drops = rollDrops(rng, trash, { itemLevel: 5 });
  if (drops.length) anyDrop++;
  totalDrops += drops.length;
  for (const d of drops) {
    if (d.type === 'gold') gold++;
    else if (d.type === 'potion') potion++;
    else { equipment++; byRarity[d.item.rarity] = (byRarity[d.item.rarity] ?? 0) + 1; }
  }
}

const pAny = anyDrop / KILLS;
const pMagicPerKill = byRarity.magic / KILLS;
const pRarePerKill = byRarity.rare / KILLS;

console.log(`\nDrop harness -- ${KILLS} trash kills, itemLevel 5\n`);
console.log(`  any drop        ${(pAny * 100).toFixed(1)}% of kills`);
console.log(`  drops per kill  ${(totalDrops / KILLS).toFixed(2)}`);
console.log(`  gold            ${gold}`);
console.log(`  potions         ${potion}`);
console.log(`  equipment       ${equipment}  (normal ${byRarity.normal}, magic ${byRarity.magic}, rare ${byRarity.rare})`);

// --- the mandate's own thresholds -----------------------------------------
console.log('\n[1] "trash packs drop something visible constantly"');
// A 4-monster pack producing nothing at all must be genuinely rare.
const pPackEmpty = Math.pow(1 - pAny, PACK);
check('a 4-monster pack drops nothing less than 2% of the time',
  pPackEmpty < 0.02, `${(pPackEmpty * 100).toFixed(2)}%`);
check('more than half of individual kills drop something',
  pAny > 0.5, `${(pAny * 100).toFixed(1)}%`);

console.log('\n[2] "a magic (blue) item every pack or two"');
// Expected magic items across two 4-monster packs should be at least ~1.
const magicPerTwoPacks = pMagicPerKill * PACK * 2;
check('at least one magic item is expected per two 4-monster packs',
  magicPerTwoPacks >= 1.0, `${magicPerTwoPacks.toFixed(2)} expected`);
check('...but magic items are not so common they stop reading as special',
  magicPerTwoPacks < 4.0, `${magicPerTwoPacks.toFixed(2)} expected`);

console.log('\n[3] rares stay rare');
check('rare items are under 5% of kills', pRarePerKill < 0.05,
  `${(pRarePerKill * 100).toFixed(2)}%`);
check('rare items still actually occur', byRarity.rare > 0, `${byRarity.rare} in ${KILLS}`);

console.log('\n[4] the acceptance test as written: 10 trash mobs, no console');
// "Borka kills 10 trash mobs and sees multiple drops."
let worst = Infinity;
for (let trial = 0; trial < 2000; trial++) {
  let n = 0;
  for (let i = 0; i < 10; i++) n += rollDrops(rng, trash, { itemLevel: 5 }).length;
  if (n < worst) worst = n;
}
check('even the worst run of 10 kills in 2000 trials yields multiple drops',
  worst >= 2, `worst = ${worst}`);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('Failures:', failures.join(', '));
  process.exit(1);
}
