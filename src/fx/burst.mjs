#!/usr/bin/env node
/**
 * VFX burst capture -- the vfx pillar's own verification tool.
 *
 * A single screenshot cannot show a particle system moving; a frozen and a
 * working GPUParticles pool render an identical still. This boots the game
 * with `?fxdemo=1` (this subsystem's own diagnostic hook, which fires a
 * standing rotation of every effect), lets it settle, then takes three
 * screenshots ~120ms apart so the three frames can be diffed by eye for
 * genuine motion -- particle drift, shader-driven flicker, beam scroll --
 * rather than three copies of the same pixels.
 *
 * Mirrors tools/shoot.mjs's browser-launch args, chromium resolution, and
 * capture lock verbatim (read-only reference, not imported -- this file is
 * owned by src/fx and tools/* is not). Always port 5246, per the mission
 * brief.
 *
 *   node src/fx/burst.mjs --zone forest --dir shots/fx
 *   node src/fx/burst.mjs --zone catacombs --probe   # draw calls only, no shots
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import process from 'node:process';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const n = argv[i + 1];
    if (!n || n.startsWith('--')) out[k] = true; else { out[k] = n; i++; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const PORT = 5246; // fixed, per the capture-coordination contract
const ZONE = args.zone ?? 'forest';
const SEED = args.seed ?? '20250731';
const DIR = args.dir ?? 'shots/fx';
const LABEL = args.label ?? ZONE;
const PROBE_ONLY = !!args.probe;

function resolveChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (!existsSync(root)) return undefined;
  const dirs = readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().reverse();
  for (const d of [...dirs, 'chromium']) {
    for (const rel of ['chrome-linux/chrome', 'chrome-linux64/chrome']) {
      const p = join(root, d, rel);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

// ---- capture lock (same shape as tools/shoot.mjs's acquireLock) ----------
const LOCK_DIR = join(tmpdir(), 'emberfall-capture.lock');
const LOCK_STALE_MS = 20 * 60 * 1000;

async function acquireLock(timeoutMs = 45 * 60 * 1000) {
  const started = Date.now();
  let announced = false;
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      writeFileSync(join(LOCK_DIR, 'pid'), String(process.pid));
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    let stale = false;
    try {
      const owner = Number(readFileSync(join(LOCK_DIR, 'pid'), 'utf8').trim());
      const age = Date.now() - statSync(LOCK_DIR).mtimeMs;
      if (age > LOCK_STALE_MS) stale = true;
      else if (owner && owner !== process.pid) {
        try { process.kill(owner, 0); } catch { stale = true; }
      }
    } catch { stale = true; }
    if (stale) {
      try { rmSync(LOCK_DIR, { recursive: true, force: true }); } catch { /* raced */ }
      continue;
    }
    if (Date.now() - started > timeoutMs) throw new Error('could not acquire capture lock');
    if (!announced) { console.log('waiting for the capture lock...'); announced = true; }
    await new Promise((r) => setTimeout(r, 3000 + Math.random() * 2000));
  }
}

function releaseLock() {
  try {
    const owner = Number(readFileSync(join(LOCK_DIR, 'pid'), 'utf8').trim());
    if (owner === process.pid) rmSync(LOCK_DIR, { recursive: true, force: true });
  } catch { /* already gone */ }
}

async function startServer() {
  const child = spawn(
    'npx',
    ['vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort', '--clearScreen', 'false'],
    { cwd: new URL('../..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('vite did not start in 40s')), 40000);
    const onData = (buf) => {
      const s = buf.toString();
      if (s.includes('ready in') || s.includes('Local:')) { clearTimeout(timer); setTimeout(resolve, 400); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
  });
  return child;
}

async function main() {
  await acquireLock();
  for (const sig of ['exit', 'SIGINT', 'SIGTERM', 'uncaughtException']) {
    process.once(sig, () => { releaseLock(); if (sig !== 'exit') process.exit(1); });
  }

  const server = await startServer();
  const browser = await chromium.launch({
    executablePath: resolveChromium(),
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
           '--ignore-gpu-blocklist', '--enable-webgl', '--disable-dev-shm-usage', '--no-sandbox'],
  });

  try {
    const W = Number(args.width ?? 640), H = Number(args.height ?? 360);
    const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const logs = [];
    page.on('console', (m) => { if (m.type() === 'error') logs.push(`[console] ${m.text()}`); });
    page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

    const url = `http://127.0.0.1:${PORT}/?seed=${SEED}&quality=medium&zone=${ZONE}&fxdemo=1`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 });
    await page.waitForFunction(() => window.__ready === true, { timeout: 120000 });
    await page.evaluate(() => document.getElementById('boot')?.remove());
    // Frame in close on the player, where the demo hook centres every effect.
    // `--focus hitfx|beams|torch` recentres on the specific demo anchor
    // instead of the player, since the default framing puts hit-fx and
    // torches out of a 640x360 crop.
    const FOCUS = args.focus ?? 'player';
    await page.evaluate((focus) => {
      const g = window.__game;
      const p = g.player.position;
      let target = p;
      if (focus === 'hitfx') target = { x: p.x - 2.5, y: p.y + 0.9, z: p.z + 1.5 };
      else if (focus === 'beams') target = { x: p.x + 5, y: p.y, z: p.z + 3 };
      else if (focus === 'torch') {
        const reqs = g.scene.userData.flameRequests;
        target = reqs && reqs.length ? reqs[0].position : p;
      }
      g.rig.distance = focus === 'player' ? 15 : 7;
      g.rig.elevation = 0.32;
      g.rig.updateOffset();
      g.rig.snapTo(target);
    }, FOCUS);
    await page.waitForTimeout(2200); // let the demo hook fire its first rotation

    const report = await page.evaluate(() => {
      const g = window.__game;
      return {
        draws: g.renderer.info.render.calls,
        tris: g.renderer.info.render.triangles,
        points: g.renderer.info.render.points,
      };
    });
    console.log(`[${LABEL}] draws=${report.draws} tris=${report.tris}`);

    if (!PROBE_ONLY) {
      await mkdir(DIR, { recursive: true });
      const stamps = [];
      for (let i = 0; i < 3; i++) {
        const buf = await page.screenshot({ type: 'png' });
        const out = join(DIR, `${LABEL}-burst${i}.png`);
        await writeFile(out, buf);
        stamps.push(out);
        if (i < 2) await page.waitForTimeout(120);
      }
      console.log('burst frames:\n' + stamps.join('\n'));
    }

    if (logs.length) console.log('\n--- page errors ---\n' + logs.slice(0, 20).join('\n'));
  } finally {
    await browser.close();
    server.kill('SIGTERM');
    releaseLock();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  releaseLock();
  process.exit(1);
});
