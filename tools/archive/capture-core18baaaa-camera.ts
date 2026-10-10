/**
 * CORE.18.b.a.a.a.a — live check of the retail camera modes on the ACE stack:
 *   1. default at the CORE.18.b A/B spot (unchanged);
 *   2. Overhead View (Numpad5 → CameraSet::LookDown): the view pitches
 *      −74.5° from (0, −2, 0.75) and Numpad5 again restores the offset;
 *   3. First Person (NumpadDecimal) + a right-drag: the PLAYER turns
 *      (TurnToHeading ± 8° per mouse-look update), the orbit stays 0;
 *   4. Target In View in melee with a selected attackable creature: the
 *      frame heads toward the target and looks at the pivot (LOOK_AT_OBJECT),
 *      and with the option off the camera goes back behind the player.
 *
 * Output: verification/core18baaaa/*.png + core18baaaa-state.json
 *
 *   npx tsx tools/capture-core18baaaa-camera.ts
 */
import { chromium, type Page } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const OUT = join(resolve(__dir, '..'), 'verification', 'core18baaaa');
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
  return { lookingDown: cc.isLookingDown, firstPerson: cc.isFirstPerson, fps: r(cc.frameRate.fps), playerYawDeg: deg(cc.playerYaw), orbitDeg: deg(cc.cameraYawOffset),
    viewYawDeg: deg(e.y), viewPitchDeg: deg(e.x), target: { ...rig.target },
    frameForwardPitchDeg: deg(Math.asin(Math.max(-1, Math.min(1, rig.frameForward.y)))),
    viewerToPlayer: r(Math.hypot(cam.position.x - cs.x, cam.position.z - cs.z)),
    camHeightAboveFeet: r(cam.position.y - cs.feetY), x: r(cs.x), z: r(cs.z), feetY: r(cs.feetY),
    airborne: !cs.onGround, inDungeon: !!cs.inDungeon,
    floorTiltDeg: (() => { const dc = window.__ac.dungeonCollision; const n = cs.inDungeon && dc ? dc.getFloorNormal(cs.x, cs.z, cs.feetY) : null;
      return n ? deg(Math.acos(Math.min(1, n.y))) : null; })() };
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
  await page.goto(`${URL_A}&cb=core18baaaa`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const deadline = Date.now() + 420_000; let lastReload = Date.now();
  while (!(await ev<boolean>(page, `(() => { const cs = window.acDebug && window.acDebug.collisionState && window.acDebug.collisionState(); return !!(cs && cs.x > 0); })()`))) {
    if (Date.now() > deadline) throw new Error('never entered world');
    if (Date.now() - lastReload > 90_000) { await page.reload({ waitUntil: 'domcontentloaded' }); lastReload = Date.now(); }
    await page.waitForTimeout(3000);
  }
  await page.waitForTimeout(4000);
  const state: Record<string, unknown> = { at: new Date().toISOString(), viewport: VIEW };
  const shot = (name: string) => page.screenshot({ path: join(OUT, `ours-core18baaaa-${name}${TAG}.png`) });

  // 1 — default at the A/B spot.
  await admin(page, `@teleloc 0xA9B40019 84.3 5.0 94 ${HEADING}`);
  await page.waitForTimeout(12_000);
  await page.mouse.click(VIEW.width / 2, VIEW.height * 0.13); // focus the world (sky)
  await page.waitForTimeout(1500);
  state.default = await camState(page);
  await shot('default');

  // 2 — Overhead View on / off.
  await page.keyboard.press('Numpad5');
  await page.waitForTimeout(5000);
  state.overhead = await camState(page);
  await shot('overhead');
  await page.keyboard.press('Numpad5');
  await page.waitForTimeout(5000);
  state.overheadOff = await camState(page);

  // 3 — First Person, then a right-drag to the right.
  await page.keyboard.press('NumpadDecimal');
  await page.waitForTimeout(3000);
  state.inHeadBefore = await camState(page);
  await shot('inhead-before');
  await page.mouse.move(VIEW.width / 2, VIEW.height / 2);
  await page.mouse.down({ button: 'right' });
  for (let i = 1; i <= 12; i++) { await page.mouse.move(VIEW.width / 2 + i * 15, VIEW.height / 2); await page.waitForTimeout(60); }
  state.inHeadDuring = await camState(page);
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(3000);
  state.inHeadAfter = await camState(page);
  await shot('inhead-after-drag');
  await ev(page, `window.__ac.cameraController.resetZoom()`);
  await page.waitForTimeout(3000);

  // 4 — Target In View in melee.
  await admin(page, '@create drudge-skulker-noaggro'.replace('drudge-skulker', 'drudgeskulker'));
  await page.waitForTimeout(6000);
  const guid = await ev<number | null>(page, `(() => {
    const cs = window.acDebug.collisionState(), som = window.__ac.serverObjectManager;
    const list = window.acDebug.listServerObjects().filter((o) => /Drudge Skulker/.test(o.name));
    let best = null, bd = 1e9;
    for (const o of list) { const s = som.getObject(o.guid); if (!s || !s.mesh) continue;
      const d = Math.hypot(s.mesh.position.x - cs.x, s.mesh.position.z - cs.z); if (d < bd) { bd = d; best = o.guid; } }
    return best;
  })()`);
  state.targetGuid = guid;
  if (guid !== null) {
    await ev(page, `window.acDebug.selectServerObject(${guid})`);
    await ev(page, `window.__ac.gameUI.optionsSettings.keepCombatTargetsInView = true`);
    await page.keyboard.press('Backquote');
    await page.waitForTimeout(5000);
    // Turn the player a quarter away so the target sits off to the side.
    await ev(page, `window.__ac.cameraController.playerYaw += Math.PI / 2`);
    await page.waitForTimeout(6000);
    const bearing = `(() => { const s = window.__ac.serverObjectManager.getObject(${guid}); const cs = window.acDebug.collisionState();
      const dx = s.mesh.position.x - cs.x, dz = s.mesh.position.z - cs.z;
      return { targetBearingYawDeg: +(Math.atan2(-dx, -dz) * 180 / Math.PI).toFixed(2), targetDist: +Math.hypot(dx, dz).toFixed(2),
        combatMode: window.__ac.gameUI.hudState.combatMode }; })()`;
    state.tracking = { ...(await camState(page)), ...(await ev<Record<string, unknown>>(page, bearing)) };
    await shot('tracking');
    await ev(page, `window.__ac.gameUI.optionsSettings.keepCombatTargetsInView = false`);
    await page.waitForTimeout(6000);
    state.trackingOff = { ...(await camState(page)), ...(await ev<Record<string, unknown>>(page, bearing)) };
    await shot('tracking-off');
    await page.keyboard.press('Backquote');
  }

  writeFileSync(join(OUT, `core18baaaa-state${TAG}.json`), JSON.stringify(state, null, 1));
  console.log(JSON.stringify(state, null, 1));
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
