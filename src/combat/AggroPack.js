/**
 * Pack coordination -- duck-typed on purpose.
 *
 * Every function here takes plain objects shaped like `{ position:{x,z},
 * state, alive, setState(s) }`. Real Monster instances satisfy that shape
 * (position is a THREE.Vector3, which has .x/.z), and so do the mock actors
 * in feeltest.mjs/selftest.mjs -- no THREE import needed, so this file runs
 * fine under plain node.
 */

/** How many pack members are currently committed to swinging (or winding up
 *  to). Anything not in one of these states is available to flank instead. */
export function committedAttackers(monsters, statesCommitted = ['attack']) {
  let n = 0;
  for (const m of monsters) {
    if (!m) continue;
    if (m.alive === false) continue;
    if (statesCommitted.includes(m.state)) n++;
  }
  return n;
}

/**
 * Should `self` be allowed to commit to an attack right now, or should it
 * flank instead? Keeps only `maxAttackers` pack members swinging at once so a
 * pack surrounds the target rather than queuing into it one at a time.
 */
export function canCommitToAttack(self, monsters, maxAttackers = 3) {
  let committedOthers = 0;
  for (const m of monsters) {
    if (!m || m === self) continue;
    if (m.alive === false) continue;
    if (m.state === 'attack') committedOthers++;
  }
  return committedOthers < Math.max(1, maxAttackers);
}

/**
 * Hitting one pack member wakes idle neighbours within `radius`. Returns the
 * list of monsters that were woken, for tests/telemetry.
 */
export function propagateAggro(source, monsters, radius = 10, opts = {}) {
  const from = opts.from ?? 'idle';
  const to = opts.to ?? 'alert';
  const woken = [];
  if (!source || !source.position) return woken;
  for (const m of monsters) {
    if (!m || m === source) continue;
    if (m.alive === false) continue;
    if (m.state !== from) continue;
    if (!m.position) continue;
    const dx = m.position.x - source.position.x;
    const dz = m.position.z - source.position.z;
    if (Math.hypot(dx, dz) <= radius) {
      m.setState?.(to);
      woken.push(m);
    }
  }
  return woken;
}
