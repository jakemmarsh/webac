/**
 * PERF.2 leak probe — does info.memory.geometries recover after streaming a
 * different area and coming back?
 *
 * tools/perf2-probe.ts settled the churn half: 12+ camera revolutions at
 * Holtburg grew geometries 1243→2101 with the scene-graph mesh count exactly
 * flat (4679) and zero BufferGeometry disposals — lazy first-render GPU
 * upload, no churn. Its movement-based leak phase never executed (input
 * froze), so this probe uses teleports instead: Holtburg (settle+sweep,
 * sample A) → Eastham (settle+sweep, sample B) → Holtburg (settle+sweep,
 * sample C). If unload disposal works, C's geometries land near A's plateau
 * plus the retained shared caches (MaterialFactory materials/textures and
 * SceneryInstancePool template geometries are deliberately never disposed);
 * a C far above A+B's union signals a real leak.
 */
import { chromium, type Page } from 'playwright';
import { existsSync, writeFileSync } from 'node:fs';

const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=perf2leak';
const OUT = process.env.PERF2_OUT ?? '/tmp/perf2-leak-probe.json';

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(`(() => {
    const dbg = window.acDebug;
    const cs = dbg && dbg.collisionState ? dbg.collisionState() : null;
    return !!(cs && cs.x > 0);
  })()`) as Promise<boolean>;
}

async function sample(page: Page, label: string) {
  const s = await page.evaluate(`(() => {
    const sm = window.__ac && window.__ac.sceneManager;
    if (!sm || !sm.renderer) return null;
    const info = sm.renderer.info;
    let meshes = 0, instanced = 0;
    sm.scene.traverse((o) => { if (o.isMesh) { meshes++; if (o.isInstancedMesh) instanced++; } });
    return {
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs ? info.programs.length : 0,
      meshes, instanced,
      disposals: window.__geoDisposals === undefined ? null : window.__geoDisposals,
    };
  })()`) as Record<string, number | null> | null;
  console.log(`[leak] ${label}:`, JSON.stringify(s));
  return { label, ...(s ?? {}) };
}

async function installDisposeCounter(page: Page): Promise<boolean> {
  return page.evaluate(`(() => {
    const sm = window.__ac && window.__ac.sceneManager;
    if (!sm || !sm.scene) return false;
    let mesh = null;
    sm.scene.traverse((o) => { if (!mesh && o.isMesh && o.geometry) mesh = o; });
    if (!mesh) return false;
    const gproto = Object.getPrototypeOf(mesh.geometry);
    if (!gproto.__perf2Patched) {
      const gd = gproto.dispose;
      window.__geoDisposals = 0;
      gproto.dispose = function () { window.__geoDisposals++; return gd.call(this); };
      gproto.__perf2Patched = true;
    }
    return true;
  })()`) as Promise<boolean>;
}

async function worldPos(page: Page): Promise<{ x: number; north: number } | null> {
  return page.evaluate(`(() => {
    const dbg = window.acDebug;
    const cs = dbg && dbg.collisionState ? dbg.collisionState() : null;
    return cs ? { x: cs.x, north: cs.z } : null;
  })()`) as Promise<{ x: number; north: number } | null>;
}

async function telepoi(page: Page, poi: string): Promise<string> {
  const before = await worldPos(page);
  await page.evaluate(`window.acDebug && window.acDebug.admin && window.acDebug.admin('@telepoi ${poi}')`);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const p = await worldPos(page);
    if (before && p && Math.hypot(p.x - before.x, p.north - before.north) > 500) return 'landed';
    await page.waitForTimeout(2000);
  }
  return 'no-move';
}

async function settle(page: Page): Promise<number> {
  let prev = -1, stable = 0;
  const start = Date.now();
  while (Date.now() - start < 120_000) {
    await page.waitForTimeout(2000);
    const n = await page.evaluate(`(() => {
      const sm = window.__ac && window.__ac.sceneManager;
      if (!sm || !sm.scene) return -1;
      let c = 0; sm.scene.traverse((o) => { if (o.isMesh) c++; });
      return c;
    })()`) as number;
    if (prev > 0 && n > 0 && Math.abs(n - prev) <= Math.max(1, prev * 0.01)) stable++;
    else stable = 0;
    prev = n;
    if (stable >= 3) break;
  }
  return prev;
}

/** Sweep the camera one+ full revolution so lazy uploads for this scene complete. */
async function sweep(page: Page): Promise<void> {
  await page.evaluate(`window.acDebug && window.acDebug.setPlayerYaw && window.acDebug.setPlayerYaw(0)`);
  await page.keyboard.down('ArrowLeft');
  await page.waitForTimeout(30_000);
  await page.keyboard.up('ArrowLeft');
  await page.waitForTimeout(2000);
}

async function main() {
  const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1568, height: 775 } });
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());
  console.log('[leak] navigating', URL);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (Date.now() - lastReload > 60_000) {
      console.log('[leak] not in world — reload retry');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* keep polling */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) throw new Error('never entered world');
  await page.waitForTimeout(10_000);

  const samples: Record<string, unknown>[] = [];
  console.log('[leak] holtburg:', await telepoi(page, 'holtburg'));
  console.log('[leak] settle:', await settle(page));
  if (!(await installDisposeCounter(page))) console.log('[leak] *** dispose counter NOT installed');
  await sweep(page);
  samples.push(await sample(page, 'A-holtburg-swept'));

  console.log('[leak] eastham:', await telepoi(page, 'eastham'));
  console.log('[leak] settle:', await settle(page));
  await sweep(page);
  samples.push(await sample(page, 'B-eastham-swept'));

  console.log('[leak] holtburg return:', await telepoi(page, 'holtburg'));
  console.log('[leak] settle:', await settle(page));
  await sweep(page);
  samples.push(await sample(page, 'C-holtburg-return-swept'));

  writeFileSync(OUT, JSON.stringify({ utc: new Date().toISOString(), samples }, null, 2));
  console.log('[leak] wrote', OUT);
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
