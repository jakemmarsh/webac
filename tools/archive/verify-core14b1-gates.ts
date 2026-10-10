/**
 * CORE.14.b.1 live verification — portal-polygon gating for outdoor stab cells.
 *
 * Logs in, teleports to Holtburg, pins time-of-day and camera yaw, then at
 * three deterministic yaws captures draw calls + surface-cell state +
 * screenshots twice per yaw: gating OFF (CORE.14.b stab rule — the "before")
 * and gating ON (this change). The covenant check is the screenshot pair at
 * each yaw: doorways facing the camera must render identically; the win is
 * the draw-call drop at yaws where doorways face away.
 *
 * Usage: npx tsx tools/verify-core14b1-gates.ts
 * Requires: vite dev server (:3000), ws-tcp-bridge (:9090), ACE stack.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';

const OUT = '/home/user/acjs/verification/core14';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=core14b1';

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

/** Wait for n rendered frames (SwiftShader frames are slow — count, not sleep). */
async function waitFrames(page: Page, n: number): Promise<void> {
  await page.evaluate(`new Promise((resolve) => {
    let left = ${n};
    const tick = () => { if (--left <= 0) resolve(null); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  })`);
}

interface Sample {
  drawCalls: number;
  triangles: number;
  visibleCells: number;
  hiddenCells: number;
  gateCount: number;
  alwaysOpenGates: number;
  currentCellId: number;
}

async function sample(page: Page): Promise<Sample> {
  return page.evaluate(`(() => {
    const info = window.__ac.sceneManager.renderer.info;
    const scs = window.acDebug.surfaceCellState();
    return {
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      visibleCells: scs.visibleCells,
      hiddenCells: scs.hiddenCells,
      gateCount: scs.gateCount,
      alwaysOpenGates: scs.alwaysOpenGates,
      currentCellId: scs.currentCellId,
    };
  })()`) as Promise<Sample>;
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
      if (created !== 'not-at-create') { console.log(`[core14b1] char create: ${created}`); createSent = true; lastReload = Date.now(); }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[core14b1] reload (phantom-session retry)');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* keep polling */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) { await browser.close(); throw new Error('never entered world'); }
  console.log('[core14b1] in world — settling 10s');
  await page.waitForTimeout(10_000);

  await page.evaluate(`window.acDebug.admin('@telepoi holtburg')`);
  console.log('[core14b1] telepoi holtburg — streaming 25s');
  await page.waitForTimeout(25_000);

  const loc = await page.evaluate(`window.acDebug.collisionState()`) as { x: number; y: number; z: number };
  console.log(`[core14b1] parked at (${loc.x.toFixed(1)}, ${loc.y.toFixed(1)}, ${loc.z.toFixed(1)})`);
  await page.evaluate(`window.acDebug.setTimeOfDay(0.5)`);

  const yaws = [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3];
  const rows: string[] = [];
  for (let yi = 0; yi < yaws.length; yi++) {
    await page.evaluate(`window.acDebug.setPlayerYaw(${yaws[yi]})`);
    for (const gating of [false, true]) {
      await page.evaluate(`window.acDebug.setPortalGating(${gating})`);
      await waitFrames(page, 4); // let visibility + render settle
      const s = await sample(page);
      const tag = gating ? 'gated' : 'stab';
      await page.screenshot({ path: `${OUT}/core14b1-yaw${yi}-${tag}.png` });
      rows.push(
        `yaw${yi} ${tag.padEnd(5)}  drawCalls=${String(s.drawCalls).padStart(5)}  tris=${String(s.triangles).padStart(6)}` +
        `  visCells=${String(s.visibleCells).padStart(4)}  hidCells=${String(s.hiddenCells).padStart(4)}` +
        `  gates=${s.gateCount} alwaysOpen=${s.alwaysOpenGates} cell=0x${s.currentCellId.toString(16)}`);
      console.log('[core14b1] ' + rows[rows.length - 1]);
    }
  }
  // leave gating ON (the shipped state)
  await page.evaluate(`window.acDebug.setPortalGating(true)`);
  console.log('\n[core14b1] summary:\n' + rows.join('\n'));
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
