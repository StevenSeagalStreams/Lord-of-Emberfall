#!/usr/bin/env node
/**
 * Live scene probe.
 *
 * When a frame comes out wrong, the question "is the light actually reaching
 * the surface?" is answerable in about a second by asking the running scene,
 * and effectively unanswerable by staring at a dark PNG. This boots the game
 * once and dumps the state that matters: every light, the biggest meshes and
 * their materials, and the renderer's own view of the frame.
 *
 *   node tools/probe.mjs --zone forest
 */
import { chromium } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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

const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port ?? 5260);
const ZONE = args.zone ?? 'catacombs';
const SEED = args.seed ?? '20250731';

const server = spawn('npx',
  ['vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort', '--clearScreen', 'false'],
  { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'] });

await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('vite did not start')), 60000);
  const on = (b) => { if (/ready in|Local:/.test(b.toString())) { clearTimeout(t); setTimeout(resolve, 400); } };
  server.stdout.on('data', on); server.stderr.on('data', on); server.on('error', reject);
});

const browser = await chromium.launch({
  executablePath: resolveChromium(),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--ignore-gpu-blocklist', '--enable-webgl', '--disable-dev-shm-usage', '--no-sandbox'],
});

try {
  const page = await browser.newPage({ viewport: args.experiment ? { width: 320, height: 180 } : { width: 640, height: 360 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

  await page.goto(`http://127.0.0.1:${PORT}/?seed=${SEED}&zone=${ZONE}&quality=medium`,
    { waitUntil: 'domcontentloaded', timeout: 180000 });
  try {
    await page.waitForFunction(() => window.__ready === true, { timeout: 240000 });
  } catch (e) {
    const boot = await page.evaluate(() => window.__bootError || null);
    console.log('GAME NEVER BECAME READY.\nbootError: ' + boot + '\nconsole:\n' + errs.slice(0, 12).join('\n'));
    throw e;
  }
  await page.waitForTimeout(2500);

  /**
   * Ablation mode. Renders the same frame under a series of single-variable
   * mutations and reports mean luma for each. One run localises "the light is
   * not arriving" to a specific stage, which is otherwise many slow guesses.
   */
  if (args.experiment) {
    // The HUD is DOM, not scene. At 320x180 the health/mana orbs alone are a
    // big share of the frame, and their constant brightness masked every
    // lighting change in the first run of this experiment.
    await page.evaluate(() => {
      const ui = document.getElementById('ui-root');
      if (ui) ui.style.display = 'none';
    });

    const measure = async (label, mutate) => {
      await page.evaluate(([m]) => {
        const g = window.__game;
        // Restore from the snapshot taken on the first call so each variant is
        // a single change against baseline, never cumulative.
        if (!window.__snap) {
          window.__snap = [];
          g.scene.traverse((o) => {
            if (o.isLight) window.__snap.push({ o, i: o.intensity, v: o.visible, cs: o.castShadow });
          });
          // Every mutable knob a variant can touch must be snapshotted, or
          // variants stack silently and each reading is measured against a
          // different baseline than the one it claims.
          const u = g.postfx?.grade?.uniforms;
          window.__snapPost = {
            exposure: u?.exposure?.value,
            vignette: u?.vignette?.value,
            contrast: u?.contrast?.value,
            saturation: u?.saturation?.value,
            gtao: g.postfx?.gtao?.enabled,
            bloom: g.postfx?.bloom?.enabled,
          };
        }
        for (const s of window.__snap) { s.o.intensity = s.i; s.o.visible = s.v; s.o.castShadow = s.cs; }
        const u = g.postfx?.grade?.uniforms;
        const snap = window.__snapPost;
        if (u) {
          u.exposure.value = snap.exposure;
          u.vignette.value = snap.vignette;
          u.contrast.value = snap.contrast;
          u.saturation.value = snap.saturation;
        }
        if (g.postfx?.gtao) g.postfx.gtao.enabled = snap.gtao;
        if (g.postfx?.bloom) g.postfx.bloom.enabled = snap.bloom;
        g.__nopost = false;
        // eslint-disable-next-line no-eval
        eval(m);
      }, [mutate]);
      await page.waitForTimeout(700);
      const buf = await page.screenshot({ type: 'png' });
      const b64 = buf.toString('base64');
      const luma = await page.evaluate(async (data) => {
        const img = new Image();
        img.src = 'data:image/png;base64,' + data;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = 240; c.height = Math.round((img.height / img.width) * 240);
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, c.width, c.height);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        const ls = [];
        let s = 0;
        for (let i = 0; i < d.length; i += 4) {
          const l = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
          ls.push(l); s += l;
        }
        ls.sort((a, b) => a - b);
        return {
          mean: +(s / ls.length).toFixed(4),
          p50: +ls[Math.floor(ls.length * 0.5)].toFixed(4),
          p95: +ls[Math.floor(ls.length * 0.95)].toFixed(4),
        };
      }, b64);
      console.log(`  ${label.padEnd(40)} mean=${String(luma.mean).padEnd(8)} p50=${String(luma.p50).padEnd(8)} p95=${luma.p95}`);
    };

    console.log('\n=== light ablation (mean luma per variant) ===');
    await measure('baseline (as shipped)', 'void 0');
    await measure('sun.castShadow = false', `
      g.scene.traverse(o => { if (o.isDirectionalLight && o.intensity > 1) o.castShadow = false; });`);
    await measure('sun OFF (ambient+hemi only)', `
      g.scene.traverse(o => { if (o.isDirectionalLight) o.visible = false; });`);
    await measure('ambient+hemi OFF (sun only)', `
      g.scene.traverse(o => { if (o.isAmbientLight || o.isHemisphereLight) o.visible = false; });`);

    // Nothing about the lights moves the frame, so the crush must live after
    // them. Walk the post chain one pass at a time.
    await measure('GTAO pass disabled', 'if (g.postfx?.gtao) g.postfx.gtao.enabled = false;');
    await measure('vignette off', 'if (g.postfx?.grade) g.postfx.grade.uniforms.vignette.value = 4.0;');
    await measure('grade exposure x4', 'if (g.postfx?.grade) g.postfx.grade.uniforms.exposure.value *= 4;');
    await measure('BLOOM disabled', 'if (g.postfx?.bloom) g.postfx.bloom.enabled = false;');
    await measure('NO POST (direct render)', 'g.__nopost = true;');
    console.log('');
  }

  const report = await page.evaluate(() => {
    const g = window.__game;
    const THREE = g.THREE || null;
    const out = { zone: g.zoneName, lights: [], meshes: [], scene: {}, camera: {}, fog: null };

    // Read straight out of matrixWorld -- getWorldPosition needs a real
    // Vector3, and we deliberately have no THREE import inside the page.
    const wp = (o) => {
      o.updateWorldMatrix?.(true, false);
      const e = o.matrixWorld?.elements;
      return e ? [+e[12].toFixed(1), +e[13].toFixed(1), +e[14].toFixed(1)] : null;
    };

    g.scene.traverse((o) => {
      if (o.isLight) {
        out.lights.push({
          type: o.type,
          name: o.name || '(unnamed)',
          visible: o.visible,
          intensity: +(o.intensity ?? 0).toFixed(3),
          color: '#' + o.color.getHexString(),
          pos: wp(o),
          castShadow: !!o.castShadow,
          target: o.target ? wp(o.target) : null,
          distance: o.distance ?? null,
        });
      }
    });

    // Biggest renderables by bounding-sphere radius -- the things filling frame.
    const meshes = [];
    g.scene.traverse((o) => {
      if (!o.isMesh && !o.isInstancedMesh) return;
      const geo = o.geometry;
      if (!geo) return;
      if (!geo.boundingSphere) geo.computeBoundingSphere?.();
      const r = geo.boundingSphere ? geo.boundingSphere.radius : 0;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      meshes.push({
        name: o.name || o.type,
        instances: o.isInstancedMesh ? o.count : 1,
        radius: +r.toFixed(1),
        visible: o.visible,
        material: m ? m.type : 'none',
        color: m && m.color ? '#' + m.color.getHexString() : null,
        rough: m && m.roughness !== undefined ? +m.roughness.toFixed(2) : null,
        metal: m && m.metalness !== undefined ? +m.metalness.toFixed(2) : null,
        hasMap: !!(m && m.map),
        hasNormal: !!(m && m.normalMap),
        vertexColors: !!(m && m.vertexColors),
        flatShading: !!(m && m.flatShading),
        side: m ? m.side : null,
        emissive: m && m.emissive ? '#' + m.emissive.getHexString() : null,
      });
    });
    meshes.sort((a, b) => b.radius - a.radius);
    out.meshes = meshes.slice(0, 14);

    out.scene.children = g.scene.children.length;
    out.scene.envLight = !!g.scene.userData.envLight;
    out.fog = g.scene.fog
      ? { type: g.scene.fog.type || (g.scene.fog.density !== undefined ? 'FogExp2' : 'Fog'),
          color: '#' + g.scene.fog.color.getHexString(),
          density: g.scene.fog.density ?? null }
      : null;

    out.camera = { pos: wp(g.camera), fov: g.camera.fov, far: g.camera.far };
    out.player = g.player ? { pos: wp(g.player.object), alive: g.player.alive } : null;
    out.monsters = (g.monsters || []).length;
    out.aliveMonsters = (g.monsters || []).filter((m) => m.alive).length;
    out.toneMapping = g.renderer.toneMapping;
    out.exposureUniform = g.postfx?.grade?.uniforms?.exposure?.value ?? null;
    out.draws = g.renderer.info.render.calls;
    out.tris = g.renderer.info.render.triangles;
    return out;
  });

  console.log(JSON.stringify(report, null, 2));
  if (errs.length) console.log('\n--- page errors ---\n' + errs.slice(0, 10).join('\n'));
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
