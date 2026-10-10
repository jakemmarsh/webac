/**
 * CORE.18.b.a — live check of the retail in-head view: at the CORE.18.b A/B
 * spot (1600x900), wheel all the way in (retail stops at 0.5 m), press the
 * First Person Camera key (Numpad ., action 0x3a → CameraSet::SetInHead),
 * then one wheel notch out (CameraSet::Farther from the head).
 *
 * Output: verification/core18ba/*.png + core18ba-state.json
 *
 *   npx tsx tools/capture-core18ba-in-head.ts
 */
import { chromium, type Page } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const OUT = join(resolve(__dir, '..'), 'verification', 'core18ba');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const BASE = process.env.AC_BASE ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090';
const URL_A = `${BASE}&account=testacjs&password=testacjs`;
const VIEW = { width: 1600, height: 900 };
const HEADING = '0.9969 0 0 -0.0785';
const NAMES = ['Life Stone', 'Bind Stone', 'Portal to Town Network', 'Novedion', 'Town Crier'];

const ev = <T>(page: Page, src: string): Promise<T> => page.evaluate(src) as Promise<T>;
const admin = (p: Page, cmd: string) => ev(p, `window.acDebug.admin(${JSON.stringify(cmd)})`);
const facing = (p: Page) => ev<{ playerYaw: number; compassDegrees: number }>(p,
  `(() => { const c = window.acDebug.collisionState(); return { playerYaw: c.playerYaw, compassDegrees: c.compassDegrees }; })()`);

const camState = (p: Page) => ev<Record<string, number>>(p, `(() => {
  const cc = window.__ac.cameraController, sm = window.__ac.sceneManager, cam = sm.camera;
  const cs = window.acDebug.collisionState();
  const r = (v) => +v.toFixed(3);
  return { verticalFov: r(cam.fov), gameFov: sm.gameFov, aspect: r(cam.aspect), boomLength: r(cc.cameraDistance),
    viewPitchDeg: r(cc.viewPitch * 180 / Math.PI), camHeightAboveFeet: r(cam.position.y - cs.feetY),
    camBack: r(Math.hypot(cam.position.x - cs.x, cam.position.z - cs.z)),
    inHead: cc.isFirstPerson, playerVisible: !!(window.__ac.playerModel && window.__ac.playerModel.visible),
    viewerToPivot: r(Math.hypot(cam.position.x - cs.x, cam.position.y - (cs.feetY + 1.5), cam.position.z - cs.z)),
    aheadOfPivot: r(-(Math.sin(cc.yaw) * (cam.position.x - cs.x) + Math.cos(cc.yaw) * (cam.position.z - cs.z))) };
})()`);

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
  const page = await (await browser.newContext({ viewport: VIEW })).newPage();
  await page.addInitScript('window.__name = (f) => f;');
  page.on('dialog', (d) => void d.dismiss());
  await page.goto(`${URL_A}&cb=core18ba`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const deadline = Date.now() + 420_000; let lastReload = Date.now();
  while (!(await ev<boolean>(page, `(() => { const cs = window.acDebug && window.acDebug.collisionState && window.acDebug.collisionState(); return !!(cs && cs.x > 0); })()`))) {
    if (Date.now() > deadline) throw new Error('never entered world');
    if (Date.now() - lastReload > 90_000) { await page.reload({ waitUntil: 'domcontentloaded' }); lastReload = Date.now(); }
    await page.waitForTimeout(3000);
  }
  await page.waitForTimeout(4000);
  const state: Record<string, unknown> = { at: new Date().toISOString(), viewport: VIEW };
  await admin(page, `@teleloc 0xA9B40019 84.3 5.0 94 ${HEADING}`);
  await page.waitForTimeout(15_000);
  state.cs = await ev(page, 'window.acDebug.collisionState()');
  state.default = await camState(page);
  await page.screenshot({ path: join(OUT, 'ours-core18ba-default.png') });
  // Wheel all the way in: retail CameraSet::Closer stops at CAMERA_MIN_CHAR_DIST.
  await page.mouse.move(800, 300);
  for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, -100); await page.waitForTimeout(120); }
  await page.waitForTimeout(2500);
  state.wheelInFull = await camState(page);
  await page.screenshot({ path: join(OUT, 'ours-core18ba-wheel-in-full.png') });
  // The First Person Camera action (default key: Numpad . — ActionMap 0x3a).
  await page.mouse.click(800, 120);
  await page.keyboard.press('NumpadDecimal');
  await page.waitForTimeout(2000);
  state.inHead = await camState(page);
  await page.screenshot({ path: join(OUT, 'ours-core18ba-in-head.png') });
  // One notch out of the head: retail's (0, -0.6, 0.5).
  await page.mouse.move(800, 300);
  await page.mouse.wheel(0, 100);
  await page.waitForTimeout(2500);
  state.outOfHead = await camState(page);
  await page.screenshot({ path: join(OUT, 'ours-core18ba-out-of-head.png') });
  await ev(page, 'window.__ac.cameraController.resetZoom()');
  await page.waitForTimeout(2000);
  state.reset = await camState(page);
  writeFileSync(join(OUT, 'core18ba-state.json'), JSON.stringify(state, null, 1));
  console.log(JSON.stringify(state, null, 1));
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
