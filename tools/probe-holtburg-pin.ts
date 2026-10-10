/**
 * probe-holtburg-pin — live repro + diagnosis for BUG.movement-pinned-south-holtburg-slope.
 *
 * Logs in (ACE stack), @telepoi Holtburg, runs due south with W held and
 * samples the player position. If the player stops moving while W is held,
 * dumps, for 8 headings, what each stage of the outdoor movement path does
 * to a 0.5 m step (outdoorCollision.getAdjustedMovement, GAP.5 slope test,
 * GAP.6 water test) so the stage that zeroes the step is named.
 *
 * Usage: npx tsx tools/probe-holtburg-pin.ts   (vite :3000 + bridge :9090 + ACE)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, collisionState, enterWorld, sessionArgs, shot, telepoi, type CollisionState } from './lib/game-session.js';

const OUT = join(REPO, 'verification', 'holtburg-pin');

const DIAG = `(() => {
  const ac = window.__ac;
  const cs = window.acDebug.collisionState();
  const THREE_V = ac.sceneManager.camera.position.constructor;
  const out = { pos: cs, headings: [] };
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4;
    const dx = Math.sin(a) * 0.5, dz = Math.cos(a) * 0.5;
    const check = new THREE_V(cs.x, cs.lastFloor, cs.z);
    const [adjX, adjZ] = ac.outdoorCollision.getAdjustedMovement(check, dx, dz);
    const destX = cs.x + adjX, destZ = cs.z + adjZ;
    const walk = ac.terrainCollision.isWalkable(destX, destZ);
    const destH = ac.terrainCollision.getHeightAt(destX, destZ);
    const curH = ac.terrainCollision.getHeightAt(cs.x, cs.z);
    const water = ac.waterMap.cellWaterTypeAt(destX, destZ);
    out.headings.push({ deg: i * 45, dx: +dx.toFixed(3), dz: +dz.toFixed(3), adjX: +adjX.toFixed(3), adjZ: +adjZ.toFixed(3),
      walkable: walk, destH, curH, water });
  }
  out.curWater = ac.waterMap.cellWaterTypeAt(cs.x, cs.z);
  out.curWalkable = ac.terrainCollision.isWalkable(cs.x, cs.z);
  const oc = ac.outdoorCollision;
  // BUG.scenery-setup-instances-invisible-near-player — drawn scenery
  // instances within 4 m of the pin-point tree (Setup 0x020002D3, #53).
  { const m4 = new (ac.sceneManager.camera.matrixWorld.constructor)(); const p = new THREE_V(); const near = [];
    ac.sceneManager.scene.traverse((o) => { if (!o.isInstancedMesh || !o.visible) return;
      for (let i = 0; i < o.count; i++) { o.getMatrixAt(i, m4); p.setFromMatrixPosition(m4); p.applyMatrix4(o.matrixWorld);
        if (Math.hypot(p.x - 32512.21, p.z - 34446.81) < 4) near.push(o.name); } });
    out.treeDrawn = near; }
  // Name the blocking source for the due-south step.
  const check = new THREE_V(cs.x, cs.lastFloor, cs.z);
  // Internal collision helpers change shape; name the blocker if the
  // current build still exposes them.
  try {
    const near = [];
    const cyls = oc.cylinders instanceof Map ? oc.cylinders : new Map();
    for (const [k, c] of cyls) { const d = Math.hypot(c.x - cs.x, c.z - cs.z); if (d < 6) near.push({ key: String(k), x: +c.x.toFixed(2), z: +c.z.toFixed(2), r: c.radius, d: +d.toFixed(2) }); }
    out.nearCylinders = near;
  } catch (e) { out.nearCylinders = String(e); }
  return out;
})()`;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const log: string[] = [];
  const say = (s: string) => { console.log(s); log.push(s); };
  let session;
  try {
    session = await enterWorld({ ...sessionArgs(), cb: 'holtpin', viewport: { width: 1280, height: 800 }, timeoutMs: 300_000, reloadVia: 'goto' });
  } catch {
    say('FAIL: never entered world'); process.exit(1);
  }
  const { browser, page } = session;
  say('in world; settling');
  await page.waitForTimeout(8000);
  await telepoi(page, 'Holtburg', 20000);
  // CORE.18.a flipped the yaw convention; turn 180° from the arrival heading
  // (which faces north at the Holtburg POI) so W runs south like the repro.
  await page.evaluate(`window.__ac.cameraController.playerYaw += Math.PI`);
  const start = await collisionState(page);
  say(`start ${JSON.stringify(start)}`);
  await page.evaluate(`window.__ac.cameraController.simulateKeyDown('KeyW')`);
  let stuckSince = 0; let prev: CollisionState = start; let diagDone = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 30_000) {
    await page.waitForTimeout(500);
    const p = await collisionState(page) as CollisionState & { onGround: boolean; playerYaw: number };
    const moved = Math.hypot(p.x - prev.x, p.z - prev.z);
    say(`t=${Date.now() - t0} x=${p.x.toFixed(2)} z=${p.z.toFixed(2)} onGround=${p.onGround} yaw=${p.playerYaw.toFixed(2)} moved=${moved.toFixed(2)}`);
    if (moved < 0.01) { stuckSince ||= Date.now(); } else stuckSince = 0;
    if (stuckSince && Date.now() - stuckSince > 2000 && !diagDone) {
      say('STUCK — diagnostics:');
      say(JSON.stringify(await page.evaluate(DIAG), null, 1));
      await shot(page, join(OUT, 'stuck.png'));
      diagDone = true;
    }
    prev = p;
  }
  await page.evaluate(`window.__ac.cameraController.simulateKeyUp('KeyW')`);
  if (!diagDone) { say('never stuck; final diagnostics:'); say(JSON.stringify(await page.evaluate(DIAG), null, 1)); }
  await shot(page, join(OUT, 'final.png'));
  writeFileSync(join(OUT, 'probe.log'), log.join('\n') + '\n');
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
