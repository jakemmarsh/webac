/**
 * CORE.17.h.g.c.b — close-up evidence for the detail pass. The 0x5001787
 * pattern (tiling 4 over the wall UVs) averages out to ~1.03× beyond a few
 * metres (mipmaps), so the whole-screen town frames barely move; retail's
 * pass is an up-close effect. This probe parks the camera 1.5 m from the
 * player's head facing a Training Academy wall (~3 m away) and a Holtburg
 * cottage wall, and writes ON / OFF frames + 3x crops:
 *   verification/core17hgcb/closeup-dungeon-{on,off}.png
 *   verification/core17hgcb/closeup-town-{on,off}.png
 *   verification/core17hgcb/closeup-sidebyside.png
 * Usage: npx tsx tools/probe-core17hgcb-closeup.ts
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17hgcb');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const DUNGEON = '@teleloc 0x86020115 [190 -240 -11.5] 1 0 0 0';
const HOLTBURG = '@telepoi holtburg';
/** From the Holtburg POI at yaw 2.4 (world-town-day-alt's heading) the
 *  cottage is ~25 m ahead — run at it for this long, then face its wall. */
const RUN_MS = 5200;

function launch() {
  return chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
}

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as unknown as { acDebug?: { collisionState?: () => { x: number } } }).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

async function setPass(page: Page, on: boolean): Promise<void> {
  await page.evaluate((v) => (window as any).__ac.gameUI.applyOptionsBulk({ buildingDetailTextures: v }), on);
  await page.waitForTimeout(1000);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', (d) => void d.dismiss());
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (Date.now() - lastReload > 60_000) {
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* keep polling */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) throw new Error('never entered world');
  await page.waitForTimeout(8000);
  await page.evaluate(() => (window as any).__ac?.skybox?.setWeatherEnabled?.(false));
  await page.evaluate((t) => (window as any).acDebug?.freezeTimeOfDay?.(t), 0.5);
  await page.evaluate(`(() => { const ui = window.__ac.gameUI; if (ui.optionsPanelVisible) ui.toggleOptionsPanel(); })()`);

  const shots: Array<[string, string, number]> = [['closeup-dungeon', DUNGEON, 1.57], ['closeup-town', HOLTBURG, 2.4]];
  const results: Record<string, unknown> = {};
  for (const [name, tele, yaw] of shots) {
    await page.evaluate((cmd) => (window as any).acDebug?.admin?.(cmd), tele);
    await page.waitForTimeout(8000);
    await page.evaluate((y) => (window as any).acDebug?.setPlayerYaw?.(y), yaw);
    if (tele === HOLTBURG) {
      await page.waitForTimeout(1500);
      await page.keyboard.down('w');
      await page.waitForTimeout(RUN_MS);
      await page.keyboard.up('w');
      await page.waitForTimeout(2500);
    }
    await page.evaluate(() => { const c = (window as any).__ac?.cameraController; if (c) c.cameraDistance = 1.5; });
    await page.waitForTimeout(2500);
    await setPass(page, true);
    await page.screenshot({ path: join(OUT, `${name}-on.png`) });
    await setPass(page, false);
    await page.screenshot({ path: join(OUT, `${name}-off.png`) });
    await setPass(page, true);
    results[name] = await page.evaluate(() => {
      const cs = (window as any).acDebug?.collisionState?.();
      return { x: cs?.x, y: cs?.y, z: cs?.z, cell: cs?.cell };
    });
    console.log(`[closeup] ${name}: ${JSON.stringify(results[name])}`);
  }
  await page.evaluate(() => { const c = (window as any).__ac?.cameraController; if (c) c.cameraDistance = 5; });

  const dataUrl = (f: string) => `data:image/png;base64,${readFileSync(f).toString('base64')}`;
  const crop = (file: string, label: string, r: { x: number; y: number; w: number; h: number }, zoom: number) =>
    `<div style="display:flex;flex-direction:column;gap:4px"><div style="color:#ffd">${label}</div>
     <div style="position:relative;overflow:hidden;background:#000;border:1px solid #444;width:${r.w * zoom}px;height:${r.h * zoom}px">
       <img src="${dataUrl(file)}" style="position:absolute;left:${-r.x * zoom}px;top:${-r.y * zoom}px;transform-origin:0 0;transform:scale(${zoom});image-rendering:pixelated"/></div></div>`;
  const full = (file: string, label: string) => `<div style="display:flex;flex-direction:column;gap:4px"><div style="color:#ffd">${label}</div><img src="${dataUrl(file)}" style="width:700px;border:1px solid #444"/></div>`;
  await composeSheet(browser);
}

/** The nearest wall in each frame (the cottage's plastered gable at the
 *  left edge of the town frame; the cave wall beside the player). */
const CROPS: Record<string, { x: number; y: number; w: number; h: number }> = {
  'closeup-dungeon': { x: 300, y: 380, w: 260, h: 150 },
  'closeup-town': { x: 0, y: 100, w: 230, h: 170 },
};

async function composeSheet(browser: import('playwright').Browser): Promise<void> {
  const dataUrl = (f: string) => `data:image/png;base64,${readFileSync(f).toString('base64')}`;
  const crop = (file: string, label: string, r: { x: number; y: number; w: number; h: number }, zoom: number) =>
    `<div style="display:flex;flex-direction:column;gap:4px"><div style="color:#ffd">${label}</div>
     <div style="position:relative;overflow:hidden;background:#000;border:1px solid #444;width:${r.w * zoom}px;height:${r.h * zoom}px">
       <img src="${dataUrl(file)}" style="position:absolute;left:${-r.x * zoom}px;top:${-r.y * zoom}px;transform-origin:0 0;transform:scale(${zoom});image-rendering:pixelated"/></div></div>`;
  const full = (file: string, label: string) => `<div style="display:flex;flex-direction:column;gap:4px"><div style="color:#ffd">${label}</div><img src="${dataUrl(file)}" style="width:700px;border:1px solid #444"/></div>`;
  const html = `<!doctype html><html><body style="margin:0;background:#1a1a1a;color:#eee;font:13px monospace;padding:10px">
  <h1 style="font-size:14px">CORE.17.h.g.c.b — close-up: retail second draw (0x5001787 ×4, DESTCOLOR/INVSRCALPHA) ON vs OFF beside a Training Academy cave wall and the Holtburg cottage gable</h1>
  ${Object.entries(CROPS).map(([name, R]) => `<h2 style="font-size:13px;color:#9cf">${name}</h2>
    <div style="display:flex;gap:12px">${full(join(OUT, `${name}-on.png`), 'ON (default)')}${full(join(OUT, `${name}-off.png`), 'OFF')}</div>
    <div style="display:flex;gap:12px;margin-top:6px">${crop(join(OUT, `${name}-on.png`), 'wall 3x — ON', R, 3)}${crop(join(OUT, `${name}-off.png`), 'wall 3x — OFF', R, 3)}</div>`).join('')}
  </body></html>`;
  const p2 = await browser.newPage({ viewport: { width: 1900, height: 1200 } });
  await p2.setContent(html, { waitUntil: 'load' });
  await p2.waitForTimeout(800);
  await p2.screenshot({ path: join(OUT, 'closeup-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[closeup] wrote ${join(OUT, 'closeup-sidebyside.png')}`);
}

if (process.argv.includes('--compose')) {
  launch().then(composeSheet).catch((e) => { console.error(e); process.exit(1); });
} else {
  main().catch((e) => { console.error(e); process.exit(1); });
}
