/**
 * CORE.18 — live check that the world is no longer an east-west mirror image.
 * Same spot as the retail A/B (tools/capture-retail-ab.ts): @teleloc to the
 * Holtburg lifestone spawn with the retail session's heading, face due north
 * (acDebug.setPlayerYaw(π)), then record where the named Holtburg objects
 * project on screen next to their AC east offset from the player, and
 * screenshot. Then hold A (turn left) and D (turn right) for 0.5 s each and
 * record which way the Life Stone slides on screen.
 *
 * Output: verification/retail-client/ab/ours-core18-*.png + core18-state.json
 *
 *   npx tsx tools/capture-core18-mirror.ts
 */
import { chromium, type Page } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const OUT = join(resolve(__dir, '..'), 'verification', 'retail-client', 'ab');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const BASE = process.env.AC_BASE ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090';
const URL_A = `${BASE}&account=testacjs&password=testacjs`;
const VIEW = { width: 1600, height: 900 };
const HEADING = '0.9969 0 0 -0.0785';
const NAMES = ['Life Stone', 'Bind Stone', 'Portal to Town Network', 'Novedion', 'Town Crier'];

const ev = <T>(page: Page, src: string): Promise<T> => page.evaluate(src) as Promise<T>;
const admin = (p: Page, cmd: string) => ev(p, `window.acDebug.admin(${JSON.stringify(cmd)})`);

async function probe(page: Page): Promise<unknown[]> {
  return ev<unknown[]>(page, `(() => {
    const cs = window.acDebug.collisionState();
    const out = [];
    for (const o of (window.acDebug.getObjects() || [])) {
      if (!${JSON.stringify(NAMES)}.some((n) => o.name && o.name.startsWith(n))) continue;
      const obj = window.__ac.serverObjectManager ? window.__ac.serverObjectManager.getObject(o.guid) : null;
      const m = obj && obj.mesh;
      const sp = window.acDebug.objectScreenPoint(o.guid);
      out.push({ name: o.name, dEast: m ? +(m.position.x - cs.x).toFixed(1) : null,
        dNorth: m ? +(m.position.z - cs.z).toFixed(1) : null, screen: sp ? { x: Math.round(sp.x), y: Math.round(sp.y) } : null });
    }
    return out;
  })()`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
  const page = await (await browser.newContext({ viewport: VIEW })).newPage();
  await page.addInitScript('window.__name = (f) => f;');
  page.on('dialog', (d) => void d.dismiss());
  await page.goto(`${URL_A}&cb=core18`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const deadline = Date.now() + 420_000; let lastReload = Date.now();
  while (!(await ev<boolean>(page, `(() => { const cs = window.acDebug && window.acDebug.collisionState && window.acDebug.collisionState(); return !!(cs && cs.x > 0); })()`))) {
    if (Date.now() > deadline) throw new Error('never entered world');
    if (Date.now() - lastReload > 90_000) { await page.reload({ waitUntil: 'domcontentloaded' }); lastReload = Date.now(); }
    await page.waitForTimeout(3000);
  }
  await page.waitForTimeout(4000);
  await admin(page, `@teleloc 0xA9B40019 84.3 5.0 94 ${HEADING}`);
  await page.waitForTimeout(10_000);
  await ev(page, `window.acDebug.setPlayerYaw(Math.PI)`);
  await page.waitForTimeout(4000);
  const state: Record<string, unknown> = { at: new Date().toISOString(), viewport: VIEW };
  state.facingNorth = await probe(page);
  await page.screenshot({ path: join(OUT, 'ours-core18-facing-north.png') });
  // retail heading (NNE) — the frame retail-holtburg.png was taken at
  await admin(page, `@teleloc 0xA9B40019 84.3 5.0 94 ${HEADING}`);
  await page.waitForTimeout(6000);
  await ev(page, `window.acDebug.setPlayerYaw(Math.PI - 2 * Math.atan2(-0.0785, 0.9969))`);
  await page.waitForTimeout(3000);
  state.retailHeading = await probe(page);
  await page.screenshot({ path: join(OUT, 'ours-core18-retail-heading.png') });
  // controls: the Life Stone's screen x before / after holding A, then D
  const lifeX = async () => ((await probe(page)) as Array<{ name: string; screen: { x: number } | null }>)
    .find((o) => o.name === 'Life Stone')?.screen?.x ?? null;
  await ev(page, `window.acDebug.setPlayerYaw(Math.PI)`);
  await page.waitForTimeout(1500);
  const x0 = await lifeX();
  await page.mouse.click(800, 250);
  await page.keyboard.down('KeyA'); await page.waitForTimeout(500); await page.keyboard.up('KeyA');
  await page.waitForTimeout(800);
  const xA = await lifeX();
  await page.keyboard.down('KeyD'); await page.waitForTimeout(1000); await page.keyboard.up('KeyD');
  await page.waitForTimeout(800);
  const xD = await lifeX();
  state.controls = { lifeStoneX_start: x0, afterTurnLeft: xA, afterTurnRight: xD };
  writeFileSync(join(OUT, 'core18-state.json'), JSON.stringify(state, null, 1));
  console.log(JSON.stringify(state, null, 1));
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
