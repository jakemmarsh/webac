/**
 * CORE.8 live verification — camera terrain clipping while descending hills.
 * Logs into the ACE stack, finds a downhill heading near spawn, walks down it
 * twice: once with the terrain boom-sweep live-disabled (pre-fix behavior via
 * instance method override) and once with the fix active. Records per-frame
 * camera-vs-terrain penetration and screenshots mid-descent.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';

const OUT = '/home/user/acjs/verification/core8';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=core8';

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(`(() => {
    const dbg = window.acDebug; const cs = dbg && dbg.collisionState && dbg.collisionState();
    return !!(cs && cs.x > 0);
  })()`) as Promise<boolean>;
}

async function driveCharacterCreate(page: Page): Promise<string> {
  return page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    if (!ui || !ui.ui || ui.ui.currentScreen !== 'character-create') return 'not-at-create';
    if (!ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return 'no-hooks';
    ui.wizard.name = 'Perf Tester';
    ui.callbacks.onCharacterCreated(ui.wizard);
    return 'sent';
  })()`) as Promise<string>;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1568, height: 775 } });
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') { console.log(`[core8] char create: ${created}`); createSent = true; lastReload = Date.now(); }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[core8] reload (phantom-session retry)');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* keep polling */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) { await browser.close(); throw new Error('never entered world'); }
  console.log('[core8] in world — settling 10s');
  await page.waitForTimeout(10_000);

  // The scripted-create spawn area is flat — hop to Holtburg (hilly, and the
  // area of Jake's live report) before scanning for a descent.
  await page.evaluate(`window.acDebug.admin('@telepoi holtburg')`);
  console.log('[core8] telepoi holtburg — waiting for terrain stream (20s)');
  await page.waitForTimeout(20_000);

  // Find the steepest sustained descent within 400m of the player: scan
  // candidate start points; score = height drop over a 40m monotonic run.
  const hill = await page.evaluate(`(() => {
    const ac = window.__ac; const cs = window.acDebug.collisionState();
    const tc = ac.terrainCollision;
    let best = null;
    for (let r = 0; r <= 400; r += 50) {
      for (let a = 0; a < 64; a++) {
        const ang = a / 64 * Math.PI * 2;
        const sx = cs.x + Math.cos(ang) * r, sz = cs.z + Math.sin(ang) * r;
        const h0 = tc.getHeightAt(sx, sz);
        if (h0 === null) continue;
        for (let b = 0; b < 16; b++) {
          const dir = b / 16 * Math.PI * 2;
          const dx = Math.cos(dir), dz = Math.sin(dir);
          const h1 = tc.getHeightAt(sx + dx * 20, sz + dz * 20);
          const h2 = tc.getHeightAt(sx + dx * 40, sz + dz * 40);
          if (h1 === null || h2 === null) continue;
          const drop = h0 - h2;
          const mono = h0 > h1 && h1 > h2;
          if (mono && (!best || drop > best.drop)) {
            best = { sx, sz, dx, dz, drop, h0, h2 };
          }
        }
      }
    }
    return best;
  })()`) as { sx: number; sz: number; dx: number; dz: number; drop: number } | null;
  if (!hill) { await browser.close(); throw new Error('no hill found near spawn'); }
  console.log(`[core8] hill: start (${hill.sx.toFixed(0)}, ${hill.sz.toFixed(0)}) drop ${hill.drop.toFixed(1)}m over 40m`);

  // SwiftShader renders ~1 fps here, so sampling is frame-paced (~1.2s per
  // sample) and the walk is terminated by distance covered, not sample count.
  const N_SAMPLES = 40;      // hard cap; the 45m distance cut normally ends the run first
  const run = async (label: string, disableFix: boolean) => {
    await page.evaluate(`(() => {
      const ac = window.__ac;
      const tc = ac.terrainCollision;
      if (${disableFix}) {
        // pre-fix behavior: terrain boom leg never clips
        tc.getCameraDistance = function(px, py, pz, bx, bz, maxDist) { return maxDist; };
      } else {
        delete tc.getCameraDistance; // restore the prototype method (the fix)
      }
      ac.teleportPlayer(${hill.sx}, ${hill.sz});
      const yaw = Math.atan2(-(${hill.dx}), -(${hill.dz})); // forward = (-sin(yaw), -cos(yaw))
      ac.cameraController.playerYaw = yaw;
      ac.cameraController.cameraYawOffset = 0;
      ac.cameraController.pitch = 0;
      window.__core8 = { samples: [], done: false, error: null };
      window.acDebug.simulateKey('KeyW', true);
      const probe = () => {
        try {
          const cs = window.acDebug.collisionState();
          const cam = ac.sceneManager.camera.position;
          const hCam = tc.getHeightAt(cam.x, cam.z);
          window.__core8.samples.push({
            px: cs.x, pz: cs.z, camX: cam.x, camY: cam.y, camZ: cam.z,
            terrainAtCam: hCam,
            penetration: hCam === null ? null : hCam - cam.y,
          });
        } catch (e) {
          window.__core8.error = String(e && e.stack || e);
          window.__core8.done = true;
          return;
        }
        const last = window.__core8.samples[window.__core8.samples.length - 1];
        const walked = Math.hypot(last.px - ${hill.sx}, last.pz - ${hill.sz});
        if (walked > 18 || window.__core8.samples.length >= ${N_SAMPLES}) {
          window.acDebug.simulateKey('KeyW', false); window.__core8.done = true;
        } else {
          setTimeout(probe, 100);
        }
      };
      setTimeout(probe, 500); // let the teleport settle one frame
    })()`);
    // screenshot mid-descent (a few samples in — the walk is under way)
    await page.waitForFunction(
      'window.__core8 && (window.__core8.done || window.__core8.samples.length >= 4)',
      undefined, { timeout: 300000 });
    const err = await page.evaluate('window.__core8.error');
    if (err) { throw new Error(`in-page probe failed: ${err}`); }
    await page.screenshot({ path: `${OUT}/core8-mid-${label}-mid.png` });
    await page.waitForFunction('window.__core8 && window.__core8.done', undefined, { timeout: 300000 });
    await page.screenshot({ path: `${OUT}/core8-mid-${label}-end.png` });
    const data = await page.evaluate('window.__core8.samples') as Array<{
      penetration: number | null; camY: number; terrainAtCam: number | null; px: number; pz: number;
    }>;
    const pens = data.map(s => s.penetration).filter((p): p is number => p !== null);
    const maxPen = Math.max(...pens);
    console.log(`[core8] ${label}: maxPenetration=${maxPen.toFixed(3)}m over ${pens.length} samples`);
    writeFileSync(`${OUT}/core8-mid-${label}.json`, JSON.stringify({ label, maxPen, samples: data }, null, 1));
    return maxPen;
  };

  const before = await run('before-fix-disabled', true);
  const after = await run('after-fix-active', false);

  console.log(`[core8] RESULT before=${before.toFixed(3)}m after=${after.toFixed(3)}m`);
  await browser.close();
  if (!(after < 0)) throw new Error(`camera still not clear of terrain: after=${after}`);
}

main().catch(e => { console.error('[core8] FAILED:', e.message); process.exit(1); });
