/**
 * PERF.2 probe — is the idle→turning geometry growth (566→1697→1963 in the
 * 2026-09-07 runs) rebuild churn / a leak, or three.js lazy first-render
 * GPU-buffer allocation as new headings reveal already-loaded meshes?
 *
 * Design:
 *   - instrument BufferGeometry.prototype.dispose (via a live mesh's proto)
 *     to count disposals; uploads ≈ Δinfo.memory.geometries + disposals.
 *   - sample {info.geometries, info.textures, programs, scene mesh count,
 *     camera yaw, disposals} at: settle, after idle, after each of 4
 *     consecutive 30s ArrowLeft turn blocks, after a 30s forward run, and
 *     after telepoi back + re-settle (leak probe).
 *   - lazy upload ⇒ big jump on turn block 1, ~zero on blocks 2–4 (same arc
 *     re-swept), scene mesh count flat, disposals ~0.
 *   - churn ⇒ repeated growth + disposals every block.
 *   - leak ⇒ final re-settled geometries >> post-turn plateau.
 */
import { chromium, type Page } from 'playwright';
import { existsSync, writeFileSync } from 'node:fs';

const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=perf2probe';
const OUT = process.env.PERF2_OUT ?? '/tmp/perf2-probe.json';

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
    const cam = sm.camera;
    return {
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs ? info.programs.length : 0,
      meshes, instanced,
      camYaw: cam ? Math.round(cam.rotation.y * 1000) / 1000 : null,
      disposals: window.__geoDisposals === undefined ? null : window.__geoDisposals,
      texDisposals: window.__texDisposals === undefined ? null : window.__texDisposals,
    };
  })()`) as Record<string, number | null> | null;
  console.log(`[probe] ${label}:`, JSON.stringify(s));
  return { label, ...(s ?? {}) };
}

/** Count geometry+texture disposals via prototype patch reached from a live mesh. */
async function installDisposeCounters(page: Page): Promise<boolean> {
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
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const tex = mat && mat.map;
    if (tex) {
      const tproto = Object.getPrototypeOf(tex);
      if (!tproto.__perf2Patched) {
        const td = tproto.dispose;
        window.__texDisposals = 0;
        tproto.dispose = function () { window.__texDisposals++; return td.call(this); };
        tproto.__perf2Patched = true;
      }
    }
    return true;
  })()`) as Promise<boolean>;
}

async function setYaw(page: Page, yaw: number) {
  await page.evaluate(`window.acDebug && window.acDebug.setPlayerYaw && window.acDebug.setPlayerYaw(${yaw})`);
}

async function worldPos(page: Page): Promise<{ x: number; north: number } | null> {
  return page.evaluate(`(() => {
    const dbg = window.acDebug;
    const cs = dbg && dbg.collisionState ? dbg.collisionState() : null;
    return cs ? { x: cs.x, north: cs.z } : null;
  })()`) as Promise<{ x: number; north: number } | null>;
}

const PARK = { x: 32532, north: 34567 };

async function telepoiPark(page: Page): Promise<string> {
  const before = await worldPos(page);
  const dist = before ? Math.hypot(before.x - PARK.x, before.north - PARK.north) : Infinity;
  if (dist <= 10) return 'skipped-near';
  await page.evaluate(`window.acDebug && window.acDebug.admin && window.acDebug.admin('@telepoi holtburg')`);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const p = await worldPos(page);
    if (p && Math.hypot(p.x - PARK.x, p.north - PARK.north) < 150) return 'landed';
    await page.waitForTimeout(2000);
  }
  return 'failed';
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
  console.log('[probe] navigating', URL);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (Date.now() - lastReload > 60_000) {
      console.log('[probe] not in world — reload retry');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* keep polling */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) throw new Error('never entered world');
  console.log('[probe] in world; parking…');
  await page.waitForTimeout(10_000);
  console.log('[probe] telepoi:', await telepoiPark(page));
  console.log('[probe] settle meshes:', await settle(page));
  await setYaw(page, 0);
  if (!(await installDisposeCounters(page))) console.log('[probe] *** dispose counters NOT installed');

  const samples: Record<string, unknown>[] = [];
  samples.push(await sample(page, 'settled'));

  await page.waitForTimeout(10_000);
  samples.push(await sample(page, 'idle-10s'));

  for (let i = 1; i <= 4; i++) {
    await page.keyboard.down('ArrowLeft');
    await page.waitForTimeout(30_000);
    await page.keyboard.up('ArrowLeft');
    await page.waitForTimeout(2000);
    samples.push(await sample(page, `turn-block-${i}`));
  }

  // leak probe: run forward to stream new blocks, then return + resettle
  await setYaw(page, 0);
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(30_000);
  await page.keyboard.up('ArrowUp');
  await page.waitForTimeout(2000);
  samples.push(await sample(page, 'after-run-30s'));

  console.log('[probe] telepoi back:', await telepoiPark(page));
  console.log('[probe] resettle meshes:', await settle(page));
  // sweep a full turn so lazy uploads of any NEW scene content complete,
  // then compare against the post-turn plateau
  await page.keyboard.down('ArrowLeft');
  await page.waitForTimeout(30_000);
  await page.keyboard.up('ArrowLeft');
  await page.waitForTimeout(2000);
  samples.push(await sample(page, 'returned-resettled-swept'));

  writeFileSync(OUT, JSON.stringify({ utc: new Date().toISOString(), samples }, null, 2));
  console.log('[probe] wrote', OUT);
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
