#!/usr/bin/env node
/**
 * Headless capture harness.
 *
 * Boots the game in Chromium with a fixed seed, waits for the deterministic
 * ready flag, drives a named scenario, and writes a PNG. This is the only
 * ground truth the critic agents grade against -- if it is not in the shot, it
 * did not happen.
 *
 *   node tools/shoot.mjs --shot wide --out shots/wide.png
 *   node tools/shoot.mjs --all --dir shots/
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import process from 'node:process';

/**
 * The image this container ships is not necessarily the revision the installed
 * playwright package expects, so resolve the real binary rather than trusting
 * the version-pinned default path.
 */
function resolveChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (!existsSync(root)) return undefined;
  const dirs = readdirSync(root)
    .filter((d) => d.startsWith('chromium-'))
    .sort()
    .reverse();
  for (const d of [...dirs, 'chromium']) {
    for (const rel of ['chrome-linux/chrome', 'chrome-linux64/chrome']) {
      const p = join(root, d, rel);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port ?? 5199);
const SEED = args.seed ?? '20250731';
const QUALITY = args.quality ?? 'ultra';
const ZONE = args.zone ?? 'catacombs';
const WIDTH = Number(args.width ?? 1920);
const HEIGHT = Number(args.height ?? 1080);

/**
 * Luma bands are per shot type, not global.
 *
 * The original 0.18-0.32 band was calibrated on ground-level framings. A vista
 * where sky fills a third of the frame legitimately reads brighter, and
 * "correcting" it would mean darkening a scene that is not wrong. An interior
 * lit only by fire legitimately reads darker. One band for all three would
 * force two of them into a lie.
 *
 * Every scenario declares its type. A capture with no shot-type tag is invalid
 * and must not be graded -- the harness refuses to emit one.
 */
const LUMA_BANDS = {
  ground:   { min: 0.18, max: 0.32, note: 'ground-level exterior (wide/combat/hero)' },
  vista:    { min: 0.28, max: 0.45, note: 'pulled-back exterior, sky >= ~35% of frame' },
  interior: { min: 0.10, max: 0.22, note: 'dungeon/interior, sourced firelight only' },
};

/**
 * A "ground exterior" framing inside a dungeon is an interior shot. Resolve
 * the declared type against the zone rather than making every scenario
 * declare itself twice.
 */
const INTERIOR_ZONES = new Set(['catacombs']);
function resolveShotType(declared, zone) {
  const zoneIsInterior = INTERIOR_ZONES.has(zone);
  // Resolution is symmetric. A ground framing inside a dungeon is an interior
  // shot -- and, just as importantly, the `corridor` scenario declares itself
  // interior but degrades to an exterior framing in an outdoor zone, where
  // grading it against the dungeon band reports a false TOO BRIGHT.
  if (zoneIsInterior) return declared === 'vista' ? 'interior' : 'interior';
  return declared === 'interior' ? 'ground' : declared;
}

function gradeLuma(shotType, meanLuma) {
  const band = LUMA_BANDS[shotType];
  if (!band) return { shotType, valid: false, reason: 'unknown or missing shot type' };
  const inBand = meanLuma >= band.min && meanLuma <= band.max;
  return {
    shotType,
    valid: true,
    band: [band.min, band.max],
    bandNote: band.note,
    inBand,
    verdict: inBand ? 'IN BAND' : (meanLuma < band.min ? 'TOO DARK' : 'TOO BRIGHT'),
  };
}

/**
 * Scenarios. Each gets the page and the in-page game object and is responsible
 * for putting the world into a specific, repeatable state before the capture.
 */
const SHOTS = {
  /** Establishing shot, framed on the densest content in the zone. */
  wide: { type: 'ground', run: async (page) => {
    const at = await frameContent(page);
    if (at) console.log(`     (framed on content cluster at ${at.x},${at.z} -- ${at.clusterSize} instances)`);
    await page.evaluate(() => {
      const g = window.__game;
      g.rig.distance = 38;
      g.rig.updateOffset();
      g.rig.snapTo(g.player.position);
    });
    await settle(page, 1.6);
  } },

  /** Pulled-back vista: judge zone identity and treeline silhouette mass. */
  vista: { type: 'vista', run: async (page) => {
    await frameContent(page);
    await page.evaluate(() => {
      const g = window.__game;
      g.rig.distance = 58;
      g.rig.elevation = 0.52;
      g.rig.updateOffset();
      g.rig.snapTo(g.player.position);
    });
    await settle(page, 1.6);
  } },

  /** Close on the character, to judge model and material quality. */
  hero: { type: 'ground', run: async (page) => {
    // Frame on content like wide/vista do. Without this the close shot lands
    // wherever the player spawned -- which for the forest is a rock bowl with
    // no treeline in it, so every close-range judgement was made against a
    // part of the level that does not represent it.
    await frameContent(page);
    await page.evaluate(() => {
      const g = window.__game;
      g.rig.distance = 13;
      g.rig.elevation = 0.42;
      g.rig.updateOffset();
      g.rig.snapTo(g.player.position);
    });
    await settle(page, 1.2);
  } },

  /** Combat: teleport the nearest pack onto the player and let it swing. */
  combat: { type: 'ground', run: async (page) => {
    await page.evaluate(() => {
      const g = window.__game;
      const p = g.player;
      const near = g.monsters
        .filter((m) => m.alive)
        .sort((a, b) => a.distanceTo(p) - b.distanceTo(p))
        .slice(0, 5);
      near.forEach((m, i) => {
        const a = (i / near.length) * Math.PI * 2;
        m.position.set(p.position.x + Math.sin(a) * 2.4, 0, p.position.z + Math.cos(a) * 2.4);
        m.setState('attack');
      });
      p.target = near[0] || null;
      g.rig.distance = 24;
      g.rig.updateOffset();
      g.rig.snapTo(p.position);
    });
    await settle(page, 2.4);
  } },

  /** A dark corridor, to judge falloff, fog and shadow quality. */
  corridor: { type: 'interior', run: async (page) => {
    await page.evaluate(() => {
      const g = window.__game;
      // Outdoor zones have no corridors -- fall back to a mid-range framing.
      if (!g.dungeon) {
        g.rig.distance = 26;
        g.rig.updateOffset();
        g.rig.snapTo(g.player.position);
        return;
      }
      // Find a floor cell far from any room centre -- that is corridor.
      const d = g.dungeon;
      const T = 2.0;
      let best = null, bestScore = -1;
      for (let y = 2; y < d.height - 2; y += 2) {
        for (let x = 2; x < d.width - 2; x += 2) {
          if (!d.isFloor(x, y)) continue;
          let minRoom = Infinity;
          for (const r of d.rooms) minRoom = Math.min(minRoom, Math.hypot(r.cx - x, r.cy - y));
          if (minRoom > bestScore) { bestScore = minRoom; best = { x, y }; }
        }
      }
      if (best) {
        g.player.position.set(best.x * T, 0, best.y * T);
        g.player.clearPath();
        g.rig.snapTo(g.player.position);
      }
      g.rig.distance = 26;
      g.rig.updateOffset();
    });
    await settle(page, 1.6);
  } },

  /** Top-down survey of a whole wing, for layout and silhouette reading. */
  survey: { type: 'vista', run: async (page) => {
    await page.evaluate(() => {
      const g = window.__game;
      g.rig.distance = 70;
      g.rig.elevation = 0.95;
      g.rig.updateOffset();
      g.rig.snapTo(g.player.position);
      g.lighting.setFogDensity(0.006);
    });
    await settle(page, 1.4);
  } },
};

/**
 * Objective exposure readout for a captured frame.
 *
 * Agents were tuning lighting by eyeballing slow screenshots and oscillating
 * between blown-out and near-black. Numbers converge; vibes do not. We decode
 * the PNG back inside the page (the WebGL drawing buffer is not readable after
 * compositing without preserveDrawingBuffer, so round-tripping the screenshot
 * is the reliable path) and report a luma histogram.
 *
 * Read it as: a good moody exterior sits around mean 0.18-0.32 with <2% pure
 * black and <1% clipped white. `clippedWhite` above ~3% means detail is being
 * destroyed, not "atmospheric".
 */
async function frameStats(page, pngBuffer) {
  const b64 = pngBuffer.toString('base64');
  return page.evaluate(async (data) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + data;
    await img.decode();
    const W = 320, H = Math.max(1, Math.round((img.height / img.width) * 320));
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, W, H);
    const d = ctx.getImageData(0, 0, W, H).data;

    const lumas = [];
    let black = 0, white = 0, sum = 0;
    for (let i = 0; i < d.length; i += 4) {
      // sRGB-weighted luma, good enough for exposure triage
      const l = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      lumas.push(l);
      sum += l;
      if (l <= 0.01) black++;
      if (l >= 0.99) white++;
    }
    lumas.sort((a, b) => a - b);
    const pct = (p) => lumas[Math.min(lumas.length - 1, Math.floor(p * lumas.length))];
    const n = lumas.length;
    return {
      meanLuma: +(sum / n).toFixed(4),
      p05: +pct(0.05).toFixed(4),
      p50: +pct(0.50).toFixed(4),
      p95: +pct(0.95).toFixed(4),
      crushedBlack: +((black / n) * 100).toFixed(2),
      clippedWhite: +((white / n) * 100).toFixed(2),
    };
  }, b64);
}

/**
 * Move the player to where the zone's content actually is.
 *
 * The first critic gate failed partly on the instrument: the `wide` scenario
 * framed the player spawn, the spawn sat in a rock bowl, and ~386 instanced
 * trees were nowhere in shot. The critic's words were "if 386 trees exist in
 * this scene, this establishing shot is aimed at the one place they aren't."
 *
 * Rather than hard-code a viewpoint per zone, find the densest cluster of
 * instanced content in the scene and stand there. Works for any zone without
 * the zone having to declare anything.
 */
async function frameContent(page) {
  return page.evaluate(() => {
    const g = window.__game;
    const pts = [];
    g.scene.traverse((o) => {
      if (!o.isInstancedMesh || o.count < 8) return;
      // Read the instance buffer directly -- getMatrixAt needs a real
      // Matrix4 and we deliberately have no THREE binding inside the page.
      // Translation lives at offsets 12 and 14 of each 16-float matrix.
      const arr = o.instanceMatrix?.array;
      if (!arr) return;
      const step = Math.max(1, Math.floor(o.count / 120));
      for (let i = 0; i < o.count; i += step) {
        pts.push([arr[i * 16 + 12], arr[i * 16 + 14]]);
      }
    });
    if (pts.length < 12) return null;

    // Densest point by a coarse grid histogram: the cell with the most
    // samples is where the level's content actually lives.
    const CELL = 12;
    const bins = new Map();
    for (const [x, z] of pts) {
      const k = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
      let b = bins.get(k);
      if (!b) bins.set(k, (b = { n: 0, x: 0, z: 0 }));
      b.n++; b.x += x; b.z += z;
    }
    let best = null;
    for (const b of bins.values()) if (!best || b.n > best.n) best = b;
    if (!best) return null;

    const cx = best.x / best.n;
    const cz = best.z / best.n;

    // Stand on the nearest walkable spot to that cluster, so the camera looks
    // across the content rather than into it.
    const col = g.world.colliders;
    let target = { x: cx, z: cz };
    if (col) {
      let found = null;
      for (let r = 0; r <= 24 && !found; r += 2) {
        for (let a = 0; a < 12 && !found; a++) {
          const ang = (a / 12) * Math.PI * 2;
          const tx = cx + Math.cos(ang) * r;
          const tz = cz + Math.sin(ang) * r;
          if (!col.isBlocked(tx, tz, 0.8)) found = { x: tx, z: tz };
        }
      }
      if (found) target = found;
    }

    const y = g.zone?.terrain?.heightAt ? g.zone.terrain.heightAt(target.x, target.z) : 0;
    g.player.position.set(target.x, y, target.z);
    g.player.clearPath();
    g.rig.snapTo(g.player.position);
    return { x: +target.x.toFixed(1), z: +target.z.toFixed(1), samples: pts.length, clusterSize: best.n };
  });
}

async function settle(page, seconds) {
  // Let the render loop run so animation, flicker and TAA-ish settling land in
  // a representative frame rather than frame zero.
  await page.waitForTimeout(seconds * 1000);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

async function startServer() {
  const child = spawn(
    'npx',
    ['vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort', '--clearScreen', 'false'],
    { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('vite did not start in 40s')), 40000);
    const onData = (buf) => {
      const s = buf.toString();
      if (s.includes('ready in') || s.includes('Local:')) {
        clearTimeout(timer);
        setTimeout(resolve, 400);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
  });
  return child;
}

/**
 * Global capture lock.
 *
 * Rendering here is SwiftShader -- pure software GL on 4 cores. Several agents
 * capturing at once does not give you several captures; it gives you N
 * captures each running at 1/N speed, and past a certain point the page cannot
 * even finish navigating before Playwright's timeout. Serialising turns that
 * thrash into a queue: one capture at full speed, then the next.
 *
 * The lock is a directory (atomic create on every POSIX filesystem) holding
 * the owner's pid. A lock whose owner is gone, or which is older than the
 * staleness window, is reclaimed -- so a killed run never wedges the queue.
 */
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

    // Reclaim if the holder died or has been holding too long.
    let stale = false;
    try {
      const owner = Number(readFileSync(join(LOCK_DIR, 'pid'), 'utf8').trim());
      const age = Date.now() - statSync(LOCK_DIR).mtimeMs;
      if (age > LOCK_STALE_MS) stale = true;
      else if (owner && owner !== process.pid) {
        try { process.kill(owner, 0); } catch { stale = true; }
      }
    } catch {
      stale = true; // unreadable lock -- treat as abandoned
    }

    if (stale) {
      try { rmSync(LOCK_DIR, { recursive: true, force: true }); } catch { /* raced */ }
      continue;
    }

    if (Date.now() - started > timeoutMs) {
      throw new Error(`could not acquire capture lock within ${Math.round(timeoutMs / 60000)}m`);
    }
    if (!announced) {
      console.log('waiting for the capture lock (another shoot is running)...');
      announced = true;
    }
    await new Promise((r) => setTimeout(r, 3000 + Math.random() * 2000));
  }
}

function releaseLock() {
  try {
    const owner = Number(readFileSync(join(LOCK_DIR, 'pid'), 'utf8').trim());
    if (owner === process.pid) rmSync(LOCK_DIR, { recursive: true, force: true });
  } catch { /* already gone */ }
}

async function main() {
  const wanted = args.all ? Object.keys(SHOTS) : [args.shot ?? 'wide'];
  for (const name of wanted) {
    if (!SHOTS[name]) throw new Error(`unknown shot "${name}" (have: ${Object.keys(SHOTS).join(', ')})`);
  }

  if (args.nolock !== true) {
    await acquireLock();
    for (const sig of ['exit', 'SIGINT', 'SIGTERM', 'uncaughtException']) {
      process.once(sig, () => { releaseLock(); if (sig !== 'exit') process.exit(1); });
    }
  }

  const server = await startServer();
  const browser = await chromium.launch({
    executablePath: resolveChromium(),
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--enable-webgl',
      '--disable-dev-shm-usage',
      '--no-sandbox',
    ],
  });

  const results = [];
  try {
    const context = await browser.newContext({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();

    const logs = [];
    page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

    const url = `http://127.0.0.1:${PORT}/?seed=${SEED}&quality=${QUALITY}&zone=${ZONE}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 });

    try {
      await page.waitForFunction(() => window.__ready === true, { timeout: 120000 });
    } catch (e) {
      const bootErr = await page.evaluate(() => window.__bootError || null);
      throw new Error(`game never became ready.\nbootError: ${bootErr}\nconsole:\n${logs.join('\n')}`);
    }

    // The boot overlay fades on a CSS transition. Under SwiftShader that
    // transition can be starved, and a captured frame then shows the splash
    // instead of the game -- which silently poisons every critic grade. Remove
    // the element outright rather than trusting the animation to have finished.
    await page.evaluate(() => document.getElementById('boot')?.remove());

    // Let the first frames render and shaders warm before any capture.
    await settle(page, 1.5);

    for (const name of wanted) {
      await SHOTS[name].run(page);
      const out = args.out && !args.all
        ? args.out
        : join(args.dir ?? 'shots', `${name}.png`);
      await mkdir(dirname(out), { recursive: true });
      const buf = await page.screenshot({ type: 'png' });
      await writeFile(out, buf);
      const exposure = await frameStats(page, buf);
      const shotType = resolveShotType(SHOTS[name].type, ZONE);
      const grade = gradeLuma(shotType, exposure.meanLuma);
      if (!grade.valid) {
        throw new Error(`capture "${name}" has no valid shot-type tag -- refusing to emit an ungradable image`);
      }

      const stats = await page.evaluate(() => {
        const g = window.__game;
        return {
          fps: Number(g.fps.toFixed(1)),
          draws: g.renderer.info.render.calls,
          tris: g.renderer.info.render.triangles,
          entities: g.entities.length,
        };
      });
      // Sidecar so a critic can verify the shot-type tag and its band verdict
      // without having to trust stdout.
      await writeFile(out.replace(/\.png$/, '.json'), JSON.stringify(
        { shot: name, zone: ZONE, ...grade, ...exposure,
          draws: stats.draws, tris: stats.tris }, null, 2));

      results.push({ name, out, ...stats, ...exposure, ...grade });
      console.log(
        `shot ${name} -> ${out}\n` +
        `     draws=${stats.draws} tris=${stats.tris} entities=${stats.entities}\n` +
        `     luma mean=${exposure.meanLuma} p05=${exposure.p05} p50=${exposure.p50} ` +
        `p95=${exposure.p95} crushed=${exposure.crushedBlack}% clipped=${exposure.clippedWhite}%\n` +
        `     [${grade.shotType}] band ${grade.band[0]}-${grade.band[1]}  ${grade.verdict}`
      );
    }

    const errors = logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'));
    if (errors.length) {
      console.log('\n--- page errors ---\n' + errors.join('\n'));
    }
  } finally {
    await browser.close();
    server.kill('SIGTERM');
    releaseLock();
  }

  console.log('\n' + JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
