/**
 * CORE.18.b.a.a.a.a.a — live check of the retail keyboard camera actions and
 * Map View on the ACE stack (real key presses through the KeyMap):
 *   1. default at the CORE.18.b A/B spot;
 *   2. Numpad4 held (Rotate Camera Left): the viewer swings to the player's
 *      left, the view turns right; Numpad6 swings it back;
 *   3. Numpad8 / Numpad2 held (Rotate Camera Up / Down): the viewer rises /
 *      sinks about the pivot;
 *   4. NumpadEnter (Map View): the viewer ~434 m up looking 74.5° down, fog
 *      and degrades off; NumpadEnter again restores the camera and the fog;
 *   5. Overhead View (Numpad5) + Numpad8: the look-down viewer slides back;
 *   6. First Person (NumpadDecimal) + Numpad8 / Numpad4: the view pitches
 *      down one direction.z step at a time (to −38.7°), Numpad4 turns the player.
 *
 * Output: verification/core18baaaaa/*.png + core18baaaaa-state.json
 *
 *   npx tsx tools/capture-core18baaaaa-camera-keys.ts
 */
import { chromium, type Page } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const OUT = join(resolve(__dir, '..'), 'verification', 'core18baaaaa');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const BASE = process.env.AC_BASE ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090';
const URL_A = `${BASE}&account=testacjs&password=testacjs`;
const VIEW = (() => {
  const m = /^(\d+)x(\d+)$/.exec(process.env.AC_VIEW ?? '');
  return m ? { width: +m[1], height: +m[2] } : { width: 1600, height: 900 };
})();
const TAG = process.env.AC_VIEW ? `-${VIEW.width}x${VIEW.height}` : '';
const HEADING = '0.9969 0 0 -0.0785';

const ev = <T>(page: Page, src: string): Promise<T> => page.evaluate(src) as Promise<T>;
const admin = (p: Page, cmd: string) => ev(p, `window.acDebug.admin(${JSON.stringify(cmd)})`);

const camState = (p: Page) => ev<Record<string, unknown>>(p, `(() => {
  const cc = window.__ac.cameraController, cam = window.__ac.sceneManager.camera, rig = window.__ac.cameraRig;
  const cs = window.acDebug.collisionState();
  const r = (v) => +v.toFixed(3);
  const e = new cam.rotation.constructor().setFromQuaternion(cam.quaternion, 'YXZ');
  const deg = (v) => r(v * 180 / Math.PI);
  return { mapMode: cc.isInMapMode, fogOn: !!window.__ac.sceneManager.scene.fog, degradesDisabled: window.__ac.degradeLod.disabled,
    elevationDeg: deg(cc.orbitElevation), boomBack: r(cc.thirdPersonBoom().back), lookingDown: cc.isLookingDown, firstPerson: cc.isFirstPerson, fps: r(cc.frameRate.fps), playerYawDeg: deg(cc.playerYaw), orbitDeg: deg(cc.cameraYawOffset),
    viewYawDeg: deg(e.y), viewPitchDeg: deg(e.x), target: { ...rig.target },
    frameForwardPitchDeg: deg(Math.asin(Math.max(-1, Math.min(1, rig.frameForward.y)))),
    viewerToPlayer: r(Math.hypot(cam.position.x - cs.x, cam.position.z - cs.z)),
    camHeightAboveFeet: r(cam.position.y - cs.feetY), x: r(cs.x), z: r(cs.z), feetY: r(cs.feetY),
    airborne: !cs.onGround, inDungeon: !!cs.inDungeon,
    floorTiltDeg: (() => { const dc = window.__ac.dungeonCollision; const n = cs.inDungeon && dc ? dc.getFloorNormal(cs.x, cs.z, cs.feetY) : null;
      return n ? deg(Math.acos(Math.min(1, n.y))) : null; })() };
})()`);


async function hold(page: Page, key: string, ms: number): Promise<void> {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
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
  await page.goto(`${URL_A}&cb=core18baaaaa`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const deadline = Date.now() + 420_000; let lastReload = Date.now();
  while (!(await ev<boolean>(page, `(() => { const cs = window.acDebug && window.acDebug.collisionState && window.acDebug.collisionState(); return !!(cs && cs.x > 0); })()`))) {
    if (Date.now() > deadline) throw new Error('never entered world');
    if (Date.now() - lastReload > 90_000) { await page.reload({ waitUntil: 'domcontentloaded' }); lastReload = Date.now(); }
    await page.waitForTimeout(3000);
  }
  await page.waitForTimeout(4000);
  const state: Record<string, unknown> = { at: new Date().toISOString(), viewport: VIEW };
  const shot = (name: string) => page.screenshot({ path: join(OUT, `ours-core18baaaaa-${name}${TAG}.png`) });
  const settle = () => page.waitForTimeout(5000);

  // 1 — default at the A/B spot.
  await admin(page, `@teleloc 0xA9B40019 84.3 5.0 94 ${HEADING}`);
  await page.waitForTimeout(12_000);
  await page.mouse.click(VIEW.width / 2, VIEW.height * 0.13); // focus the world (sky)
  await page.waitForTimeout(1500);
  state.default = await camState(page);
  await shot('default');

  // 2 — Rotate Camera Left, then Right.
  await hold(page, 'Numpad4', 400);
  await settle();
  state.rotateLeft = await camState(page);
  await shot('rotate-left');
  await hold(page, 'Numpad6', 400);
  await settle();
  state.rotateRight = await camState(page);
  await ev(page, `window.__ac.cameraController.resetZoom()`);
  await settle();

  // 3 — Rotate Camera Up, then Down.
  await hold(page, 'Numpad8', 300);
  await settle();
  state.raise = await camState(page);
  await shot('raise');
  await hold(page, 'Numpad2', 900);
  await settle();
  state.lower = await camState(page);
  await shot('lower');
  await ev(page, `window.__ac.cameraController.resetZoom()`);
  await settle();
  state.reset = await camState(page);

  // 4 — Map View on / off.
  await page.keyboard.press('NumpadEnter');
  await page.waitForTimeout(12_000);
  state.mapView = await camState(page);
  await shot('map-view');
  await page.keyboard.press('NumpadEnter');
  await settle();
  state.mapViewOff = await camState(page);
  await shot('map-view-off');

  // 5 — Overhead View, then Rotate Camera Up slides the viewer back.
  await page.keyboard.press('Numpad5');
  await settle();
  state.overhead = await camState(page);
  await shot('overhead');
  await page.keyboard.press('Numpad8');
  await page.keyboard.press('Numpad8');
  await settle();
  state.overheadRaised = await camState(page);
  await shot('overhead-raised');
  await page.keyboard.press('Numpad5');
  await settle();

  // 6 — First Person: Rotate Camera Up pitches down; Rotate Camera Left turns the player.
  await page.keyboard.press('NumpadDecimal');
  await settle();
  state.inHead = await camState(page);
  await page.keyboard.press('Numpad8');
  await page.waitForTimeout(2000);
  state.inHeadRaiseOnce = await camState(page);
  await hold(page, 'Numpad8', 1500);
  await page.waitForTimeout(2000);
  state.inHeadRaiseHeld = await camState(page);
  await shot('inhead-raised');
  await hold(page, 'Numpad4', 1000);
  await page.waitForTimeout(2000);
  state.inHeadRotateLeft = await camState(page);
  await ev(page, `window.__ac.cameraController.resetZoom()`);

  writeFileSync(join(OUT, `core18baaaaa-state${TAG}.json`), JSON.stringify(state, null, 1));
  console.log(JSON.stringify(state, null, 1));
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
