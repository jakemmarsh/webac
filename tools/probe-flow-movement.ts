/**
 * probe-flow-movement — the scorecard's flow-movement beats, driven live on
 * the ACE stack with the retail default keys, measured in the page:
 *
 *   run       hold W 3 s             → ground speed vs RunAnimSpeed 4.0 × runRate
 *   back      hold S 2 s             → speed (retail backs up at WalkAnimSpeed 3.12 × BackwardsFactor 0.65)
 *   turn      hold A 2 s standing    → yaw rate (retail 90°/s standing, × RunTurnFactor 1.5 running)
 *   strafe    hold Z 2 s             → sidestep speed (SidestepAnimSpeed 1.25 × rate, capped at MaxSidestepAnimRate)
 *   jump      tap Space              → airborne, peak height, lands
 *   wall      run into the Holtburg building ahead → stops (collision)
 *
 * ACE MotionInterp.cs constants. Screenshots + numbers → verification/flow-movement/.
 *
 *   npx tsx tools/probe-flow-movement.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { enterWorld, telepoi, collisionState, readAc, shot, REPO } from './lib/game-session.js';

const OUT = join(REPO, 'verification', 'flow-movement');
const TAG = '[flow-movement]';

/**
 * Hold a key and measure over PHYSICS time (ac.frameStats().physDtTotal): headless
 * SwiftShader runs at ~2 fps, so wall-clock time over-counts. Yaw is unwrapped
 * sample-to-sample (a 129°/s turn passes 360° in under 3 s).
 */
async function holdKey(page: Page, key: string, ms: number): Promise<{ dx: number; dz: number; dist: number; dyaw: number; secs: number; ys: number[] }> {
  const a = await collisionState(page);
  const f0 = await readAc<number>(page, 'ac.frameStats().physDtTotal');
  const t0 = Date.now();
  await page.keyboard.down(key);
  const ys: number[] = [];
  let lastYaw = a.playerYaw ?? 0; let dyawRad = 0;
  while (Date.now() - t0 < ms) {
    await page.waitForTimeout(100);
    const c = await collisionState(page);
    ys.push((c.feetY as number) ?? 0);
    let d = (c.playerYaw ?? 0) - lastYaw; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
    dyawRad += d; lastYaw = c.playerYaw ?? 0;
  }
  await page.keyboard.up(key);
  await page.waitForTimeout(600); // let the frame that sees the key-up run
  const b = await collisionState(page);
  const secs = (await readAc<number>(page, 'ac.frameStats().physDtTotal')) - f0 - 0.6;
  let d = (b.playerYaw ?? 0) - lastYaw; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
  dyawRad += d;
  const dx = b.x - a.x; const dz = b.z - a.z;
  return { dx, dz, dist: Math.hypot(dx, dz), dyaw: dyawRad * 180 / Math.PI, secs, ys };
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const { browser, page } = await enterWorld({ cb: 'flowmove', createCharacter: 'Move Tester', settleMs: 4000 });
  await telepoi(page, 'holtburg', 15_000);
  await readAc(page, `(dbg.freezeTimeOfDay(0.5), 0)`);
  await page.click('#game-canvas', { position: { x: 700, y: 400 } }).catch(() => {});
  await page.waitForTimeout(1000);
  const out: Record<string, unknown> = { at: new Date().toISOString() };
  out.runRate = await readAc<number | null>(page, `(ac.cameraController && ac.cameraController.runRate) ?? null`);
  // Expected (ACE MotionInterp): run 4.0·r, back 3.12·0.65·r, strafe 1.25·min(1.248·r, 3), turn 1.5·1.5 rad/s ≈ 129°/s with Run held.
  await shot(page, join(OUT, '0-start.png'));

  const run = await holdKey(page, 'w', 3000);
  out.run = { ...run, ys: undefined, speed: run.dist / run.secs };
  await shot(page, join(OUT, '1-after-run.png'));
  await page.waitForTimeout(800);

  const back = await holdKey(page, 's', 2000);
  out.back = { ...back, ys: undefined, speed: back.dist / back.secs };
  await page.waitForTimeout(800);

  const turn = await holdKey(page, 'a', 2000);
  out.turn = { ...turn, ys: undefined, degPerSec: turn.dyaw / turn.secs };
  await shot(page, join(OUT, '2-after-turn.png'));
  await page.waitForTimeout(800);

  const strafe = await holdKey(page, 'z', 2000);
  out.strafe = { ...strafe, ys: undefined, speed: strafe.dist / strafe.secs };
  await page.waitForTimeout(800);

  // Jump: hold Space to charge (the power bar), release to launch; sample the arc.
  const y0 = ((await collisionState(page)).feetY as number) ?? 0;
  await page.keyboard.down('Space'); await page.waitForTimeout(1200); await page.keyboard.up('Space');
  let peak = y0; let airborneSeen = false;
  for (let i = 0; i < 30; i++) {
    const cs = await collisionState(page);
    peak = Math.max(peak, (cs.feetY as number) ?? y0);
    if (cs.onGround === false) airborneSeen = true;
    if (i === 1) await shot(page, join(OUT, '3-jump.png'));
    await page.waitForTimeout(100);
  }
  const landed = (await collisionState(page)).onGround;
  // Headless runs at ~2 fps, so the arc is easy to miss between samples: the
  // client's own telemetry (acDebug.jumpStats) records every launch.
  const stats = await readAc<unknown>(page, 'dbg.jumpStats()');
  out.jump = { y0, peak, height: peak - y0, airborneSeen, landed, jumpStats: stats };

  // Wall: run 8 s toward the nearest building face — the position must stop changing.
  const wall = await holdKey(page, 'w', 8000);
  const cs = await collisionState(page);
  out.wall = { dist: wall.dist, secs: wall.secs, end: { x: cs.x, z: cs.z } };
  await shot(page, join(OUT, '4-after-long-run.png'));

  writeFileSync(join(OUT, 'state.json'), JSON.stringify(out, null, 2));
  console.log(TAG, JSON.stringify(out, null, 1));
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
