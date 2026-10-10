/**
 * CORE.18.b.a.a — live check of the retail camera ease, the zoom tick and
 * slope alignment at 1600x900 on the ACE stack:
 *   1. the CORE.18.b A/B spot and heading: default state + screenshot;
 *   2. one wheel notch out / in: the factor vs 1 ± 0.2 × 40 / fps;
 *   3. run forward for 3 s: the viewer trails the target (t_stiffness lag),
 *      then settles back to the default boom when the run stops;
 *   4. on the steepest nearby terrain, run up the slope with Align camera to
 *      slope on and then off: the view pitch follows the slope only when on;
 *   5. a teleport: the viewer restarts at the player's feet and eases out.
 *
 * Output: verification/core18baa/*.png + core18baa-state.json
 *
 *   npx tsx tools/capture-core18baa-camera.ts
 */
import { chromium, type Page } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const OUT = join(resolve(__dir, '..'), 'verification', 'core18baa');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const BASE = process.env.AC_BASE ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090';
const URL_A = `${BASE}&account=testacjs&password=testacjs`;
// AC_VIEW=WxH: SwiftShader manages ~1.5 fps at 1600x900, where the stiffness
// blend (0.45 × dt × 10) clamps to 1 and the physics loop drops the frames —
// the ease and the notch size need a smaller frame to be observable.
const VIEW = (() => {
  const m = /^(\d+)x(\d+)$/.exec(process.env.AC_VIEW ?? '');
  return m ? { width: +m[1], height: +m[2] } : { width: 1600, height: 900 };
})();
const TAG = process.env.AC_VIEW ? `-${VIEW.width}x${VIEW.height}` : '';
const HEADING = '0.9969 0 0 -0.0785';

const ev = <T>(page: Page, src: string): Promise<T> => page.evaluate(src) as Promise<T>;
const admin = (p: Page, cmd: string) => ev(p, `window.acDebug.admin(${JSON.stringify(cmd)})`);

const camState = (p: Page) => ev<Record<string, number | boolean>>(p, `(() => {
  const cc = window.__ac.cameraController, sm = window.__ac.sceneManager, cam = sm.camera, rig = window.__ac.cameraRig;
  const cs = window.acDebug.collisionState();
  const r = (v) => +v.toFixed(3);
  const e = new window.__ac.sceneManager.camera.rotation.constructor().setFromQuaternion(cam.quaternion, 'YXZ');
  const tgt = rig.targetPosition;
  return { fps: r(cc.frameRate.fps), boomLength: r(cc.cameraDistance), tStiffness: cc.tStiffness,
    viewPitchDeg: r(e.x * 180 / Math.PI), targetPitchDeg: r(cc.viewPitch * 180 / Math.PI),
    camHeightAboveFeet: r(cam.position.y - cs.feetY),
    camBack: r(Math.hypot(cam.position.x - cs.x, cam.position.z - cs.z)),
    lagToTarget: r(Math.hypot(cam.position.x - tgt.x, cam.position.y - tgt.y, cam.position.z - tgt.z)),
    frameForwardPitchDeg: r(Math.asin(Math.max(-1, Math.min(1, rig.frameForward.y))) * 180 / Math.PI),
    alignToSlope: cc.alignToSlope, x: r(cs.x), z: r(cs.z), feetY: r(cs.feetY) };
})()`);

async function sampleWhile(page: Page, ms: number, every = 250): Promise<Array<Record<string, number | boolean>>> {
  const out: Array<Record<string, number | boolean>> = [];
  const end = Date.now() + ms;
  while (Date.now() < end) { out.push(await camState(page)); await page.waitForTimeout(every); }
  return out;
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
  await page.goto(`${URL_A}&cb=core18baa`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const deadline = Date.now() + 420_000; let lastReload = Date.now();
  while (!(await ev<boolean>(page, `(() => { const cs = window.acDebug && window.acDebug.collisionState && window.acDebug.collisionState(); return !!(cs && cs.x > 0); })()`))) {
    if (Date.now() > deadline) throw new Error('never entered world');
    if (Date.now() - lastReload > 90_000) { await page.reload({ waitUntil: 'domcontentloaded' }); lastReload = Date.now(); }
    await page.waitForTimeout(3000);
  }
  await page.waitForTimeout(4000);
  const state: Record<string, unknown> = { at: new Date().toISOString(), viewport: VIEW };

  // 5 (first, from wherever we arrived) — a teleport restarts the viewer at the feet.
  await admin(page, `@teleloc 0xA9B40019 84.3 5.0 94 ${HEADING}`);
  const tp: Array<Record<string, number | boolean>> = [];
  const tpEnd = Date.now() + 15_000;
  while (Date.now() < tpEnd) { tp.push(await camState(page)); await page.waitForTimeout(100); }
  state.teleportEaseOut = tp.filter((_, i) => i % 5 === 0 || i < 30);
  await page.waitForTimeout(3000);

  // 1 — default.
  state.default = await camState(page);
  await page.screenshot({ path: join(OUT, `ours-core18baa-default${TAG}.png`) });

  // 2 — one wheel notch out, then in (factor vs 1 ± 0.2 × 40 / fps).
  await page.mouse.move(VIEW.width / 2, VIEW.height / 3);
  const before = await camState(page);
  await page.mouse.wheel(0, 100);
  await page.waitForTimeout(400);
  const out1 = await camState(page);
  await page.mouse.wheel(0, -100);
  await page.waitForTimeout(400);
  const in1 = await camState(page);
  state.wheel = {
    before, out1, in1,
    outFactor: +((out1.boomLength as number) / (before.boomLength as number)).toFixed(4),
    expectedOutAtFps: +(1 + 0.2 * 40 / (before.fps as number)).toFixed(4),
    inFactor: +((in1.boomLength as number) / (out1.boomLength as number)).toFixed(4),
    expectedInAtFps: +(1 - 0.2 * 40 / (out1.fps as number)).toFixed(4),
  };
  await ev(page, 'window.__ac.cameraController.resetZoom()');
  await page.waitForTimeout(3000);

  // 3 — run forward 3 s, then stop: the viewer trails, then settles.
  await page.mouse.click(VIEW.width / 2, VIEW.height * 0.13);
  await page.keyboard.down('KeyW');
  const running = await sampleWhile(page, 3000);
  await page.screenshot({ path: join(OUT, `ours-core18baa-running${TAG}.png`) });
  await page.keyboard.up('KeyW');
  const stopping = await sampleWhile(page, 3000);
  state.run = { running, stopping };

  // 4 — slope: the steepest terrain within 80 m, run uphill with align on, then off.
  let slope = await ev<{ x: number; z: number; tiltDeg: number; facing: number } | null>(page, `(() => {
    const tc = window.__ac.terrainCollision, cs = window.acDebug.collisionState();
    let best = null;
    for (let dx = -80; dx <= 80; dx += 4) for (let dz = -80; dz <= 80; dz += 4) {
      const x = cs.x + dx, z = cs.z + dz, n = tc.getNormalAt(x, z), n2 = tc.getNormalAt(x - n.x * 8, z - n.z * 8);
      if (!n || !n2) continue;
      const tilt = Math.acos(Math.min(1, n.y)) * 180 / Math.PI, tilt2 = Math.acos(Math.min(1, n2.y)) * 180 / Math.PI;
      if (tilt > 30 || tilt2 < 8) continue;
      const score = Math.min(tilt, tilt2);
      if (!best || score > best.tiltDeg) {
        // uphill = against the normal's horizontal part; start 8 m downhill of it.
        const hl = Math.hypot(n.x, n.z);
        best = { x: x + n.x / hl * 8, z: z + n.z / hl * 8, tiltDeg: +score.toFixed(2), facing: Math.atan2(n.x / hl, n.z / hl) };
      }
    }
    return best;
  })()`);
  // AC_SLOPE=x,z,facing pins a site (the search can land on water / a floor,
  // where the feet do not climb).
  const pinned = /^([\d.-]+),([\d.-]+),([\d.-]+)$/.exec(process.env.AC_SLOPE ?? '');
  if (pinned && slope) { slope.x = +pinned[1]; slope.z = +pinned[2]; slope.facing = +pinned[3]; }
  state.slopeSite = slope;
  if (slope) {
    for (const align of [true, false]) {
      await ev(page, `(() => { const cc = window.__ac.cameraController; cc.alignToSlope = ${align}; cc.cameraYawOffset = 0; cc.pitch = 0; })()`);
      // Face uphill (renderer yaw: forward = (−sin, −cos)), just off the slope's foot.
      await ev(page, `(() => { window.__ac.teleportPlayer(${slope.x}, ${slope.z}); window.__ac.cameraController.playerYaw = ${slope.facing}; })()`);
      await page.waitForTimeout(4000);
      await page.keyboard.down('KeyW');
      await page.keyboard.down('KeyC'); // a strafe component keeps the averaged velocity off the world axes
      const up = await sampleWhile(page, 1600, 200);
      await page.screenshot({ path: join(OUT, `ours-core18baa-uphill-align-${align ? 'on' : 'off'}${TAG}.png`) });
      await page.keyboard.up('KeyC');
      await page.keyboard.up('KeyW');
      state[`uphillAlign${align ? 'On' : 'Off'}`] = up;
      await page.waitForTimeout(1500);
    }
    await ev(page, 'window.__ac.cameraController.alignToSlope = true');
  }
  writeFileSync(join(OUT, `core18baa-state${TAG}.json`), JSON.stringify(state, null, 1));
  console.log(JSON.stringify({ wheel: state.wheel, slopeSite: state.slopeSite, default: state.default }, null, 1));
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
