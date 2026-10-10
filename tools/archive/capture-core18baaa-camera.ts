/**
 * CORE.18.b.a.a.a — live check of the remaining retail camera-rig edges on
 * the ACE stack:
 *   1. default state at the CORE.18.b A/B spot (orbit 0 must be unchanged);
 *   2. mouse-look orbit with the viewer lowered into the level-look band:
 *      a small orbit (|x| < 1) looks along the PLAYER's heading; a quarter
 *      orbit looks at the pivot and drops ALIGN_WITH_PLANE;
 *   3. a running jump with Align on: the frame pitches along the damped
 *      velocity while airborne (it stayed level before);
 *   4. a sloped dungeon floor: the contact normal is the BSP polygon's
 *      plane, and running along it pitches the frame;
 *   5. a server blip beyond 100 m (driven through the real
 *      applyServerPositionCorrection path): the viewer restarts on the player.
 *
 * Output: verification/core18baaa/*.png + core18baaa-state.json
 *
 *   npx tsx tools/capture-core18baaa-camera.ts
 */
import { chromium, type Page } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const OUT = join(resolve(__dir, '..'), 'verification', 'core18baaa');
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
  return { fps: r(cc.frameRate.fps), playerYawDeg: deg(cc.playerYaw), orbitDeg: deg(cc.cameraYawOffset),
    viewYawDeg: deg(e.y), viewPitchDeg: deg(e.x), target: { ...rig.target },
    frameForwardPitchDeg: deg(Math.asin(Math.max(-1, Math.min(1, rig.frameForward.y)))),
    viewerToPlayer: r(Math.hypot(cam.position.x - cs.x, cam.position.z - cs.z)),
    camHeightAboveFeet: r(cam.position.y - cs.feetY), x: r(cs.x), z: r(cs.z), feetY: r(cs.feetY),
    airborne: !cs.onGround, inDungeon: !!cs.inDungeon,
    floorTiltDeg: (() => { const dc = window.__ac.dungeonCollision; const n = cs.inDungeon && dc ? dc.getFloorNormal(cs.x, cs.z, cs.feetY) : null;
      return n ? deg(Math.acos(Math.min(1, n.y))) : null; })() };
})()`);

async function sampleWhile(page: Page, ms: number, every = 150): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
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
  await page.goto(`${URL_A}&cb=core18baaa`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const deadline = Date.now() + 420_000; let lastReload = Date.now();
  while (!(await ev<boolean>(page, `(() => { const cs = window.acDebug && window.acDebug.collisionState && window.acDebug.collisionState(); return !!(cs && cs.x > 0); })()`))) {
    if (Date.now() > deadline) throw new Error('never entered world');
    if (Date.now() - lastReload > 90_000) { await page.reload({ waitUntil: 'domcontentloaded' }); lastReload = Date.now(); }
    await page.waitForTimeout(3000);
  }
  await page.waitForTimeout(4000);
  const state: Record<string, unknown> = { at: new Date().toISOString(), viewport: VIEW };

  // 1 — default at the A/B spot.
  await admin(page, `@teleloc 0xA9B40019 84.3 5.0 94 ${HEADING}`);
  await page.waitForTimeout(12_000);
  state.default = await camState(page);
  await page.screenshot({ path: join(OUT, `ours-core18baaa-default${TAG}.png`) });

  // 2 — orbit in the level band (pitch lowers the viewer to z ≈ 0.55).
  const orbitShot = async (orbit: number, name: string) => {
    await ev(page, `(() => { const cc = window.__ac.cameraController; cc.pitch = 0.1; cc.cameraYawOffset = ${orbit}; })()`);
    await page.waitForTimeout(5000);
    const s = await camState(page);
    await page.screenshot({ path: join(OUT, `ours-core18baaa-${name}${TAG}.png`) });
    return s;
  };
  state.orbitLevel0 = await orbitShot(0, 'orbit-level-0');
  state.orbitSmall = await orbitShot(0.3, 'orbit-small');
  state.orbitQuarter = await orbitShot(Math.PI / 2, 'orbit-quarter');
  await ev(page, `(() => { const cc = window.__ac.cameraController; cc.pitch = 0; cc.cameraYawOffset = 0; })()`);
  await page.waitForTimeout(3000);

  // 3 — a running jump with a strafe component (off the world axes).
  await page.mouse.click(VIEW.width / 2, VIEW.height * 0.13);
  await page.keyboard.down('KeyW');
  await page.keyboard.down('KeyC');
  await page.waitForTimeout(1500);
  await page.keyboard.down('Space');
  await page.waitForTimeout(400);
  await page.keyboard.up('Space');
  const jump = await sampleWhile(page, 2500, 80);
  await page.keyboard.up('KeyC');
  await page.keyboard.up('KeyW');
  state.jump = jump;
  await page.waitForTimeout(2000);

  // 5 — a server blip 150 m east (interpolate-free: the real correction path).
  const blip = await ev<Record<string, unknown>>(page, `(() => {
    const ac = window.__ac, rig = ac.cameraRig, cs = window.acDebug.collisionState();
    const lbX = Math.floor((cs.x + 150) / 192), lbY = Math.floor(cs.z / 192);
    const cell = ((lbX << 24) | (lbY << 16) | 1) >>> 0;
    const lx = (cs.x + 150) - lbX * 192, ly = cs.z - lbY * 192;
    const before = { x: cs.x, z: cs.z };
    ac.applyServerPositionCorrection(cell, lx, ly, cs.feetY, 1, 0, 0, 0, true);
    const cam = ac.sceneManager.camera, after = window.acDebug.collisionState();
    return { before, after: { x: after.x, z: after.z },
      rigSoughtToPlayer: Math.hypot(rig.soughtPosition.x - after.x, rig.soughtPosition.z - after.z) };
  })()`);
  const blipEase = await sampleWhile(page, 4000, 40);
  state.blip = { ...blip, ease: blipEase };
  await page.screenshot({ path: join(OUT, `ours-core18baaa-after-blip${TAG}.png`) });

  // 4 — a sloped dungeon floor.
  await admin(page, '@teleloc 0x86020115 [190 -240 -11.5] 1 0 0 0');
  await page.waitForTimeout(15_000);
  const site = await ev<Record<string, unknown> | null>(page, `(() => {
    const dc = window.__ac.dungeonCollision, cs = window.acDebug.collisionState();
    if (!dc) return null;
    let best = null, flat = 0, scanned = 0;
    for (let dx = -60; dx <= 60; dx += 1) for (let dz = -60; dz <= 60; dz += 1) {
      const x = cs.x + dx, z = cs.z + dz;
      // Floors on the player's own level (teleportPlayer moves x / z only).
      for (const from of [cs.feetY]) {
        const y = dc.getFloorHeight(x, z, from);
        if (y === null || Math.abs(y - cs.feetY) > 0.6) continue;
        const n = dc.getFloorNormal(x, z, y);
        if (!n) continue;
        scanned++;
        const tilt = Math.acos(Math.min(1, n.y)) * 180 / Math.PI;
        if (tilt < 1) { flat++; continue; }
        if (tilt > 40 || tilt < 5) continue;
        const dist = Math.hypot(dx, dz);
        if (!best || dist < best.dist) {
          const hl = Math.hypot(n.x, n.z);
          best = { x, z, y, dist, tiltDeg: +tilt.toFixed(2), normal: n, uphillFacing: Math.atan2(n.x / hl, n.z / hl) };
        }
      }
    }
    return { best, flat, scanned, inDungeon: window.acDebug.collisionState().inDungeon };
  })()`);
  state.dungeonSlopeSite = site;
  const best = site && (site.best as { x: number; z: number; uphillFacing: number } | null);
  if (best) {
    await ev(page, `(() => { window.__ac.teleportPlayer(${best.x}, ${best.z}); window.__ac.cameraController.playerYaw = ${best.uphillFacing}; })()`);
    await page.waitForTimeout(4000);
    await page.keyboard.down('KeyW');
    await page.keyboard.down('KeyC');
    state.dungeonSlopeRun = await sampleWhile(page, 1500, 120);
    await page.screenshot({ path: join(OUT, `ours-core18baaa-dungeon-slope${TAG}.png`) });
    await page.keyboard.up('KeyC');
    await page.keyboard.up('KeyW');
  }

  writeFileSync(join(OUT, `core18baaa-state${TAG}.json`), JSON.stringify(state, null, 1));
  console.log(JSON.stringify({
    default: state.default, orbitLevel0: state.orbitLevel0, orbitSmall: state.orbitSmall, orbitQuarter: state.orbitQuarter,
    jumpPitch: (state.jump as Array<Record<string, unknown>>).map((s) => s.frameForwardPitchDeg),
    blip: { ...blip, first: blipEase.slice(0, 5).map((s) => s.viewerToPlayer) },
    dungeonSlopeSite: site,
    dungeonRunPitch: (state.dungeonSlopeRun as Array<Record<string, unknown>> | undefined)?.map((s) => s.frameForwardPitchDeg),
  }, null, 1));
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
