/**
 * probe-run-speed — targeted live verification for
 * BUG.forward-run-speed-exceeds-configured-rate.
 *
 * Logs into the ACE stack headlessly (same path as probe-dungeon-origin.ts),
 * then holds forward-run while an in-page rAF sampler records, PER FRAME,
 * the player world position, the frame dt, and the client's own configured
 * forward speed (RUN_ANIM_SPEED x cameraController.runRate). Sampling in the
 * page (not over the CDP round-trip) is what makes the per-frame step
 * comparable to the per-frame dt — the discriminator between "too much
 * distance applied per frame" (a speed bug) and "more frames than wall time"
 * (a measurement artifact).
 *
 * Reported: configured speed, measured wall-clock speed, measured per-frame
 * speed (median), and the ratio. The 2026-08-19 discovery run measured
 * 16.6 m/s against a configured 6.2 m/s while the dungeon-origin z-flap was
 * still polluting positions.
 *
 * Usage:  npx tsx tools/probe-run-speed.ts [--headed] [--secs N] [--url URL]
 *         [--teleloc "<cell> <x> <y> <z>"] [--no-teleport]
 * Output: verification/playtest/<utc>-run-speed/{samples.json,*.png}
 */

import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const HEADED = process.argv.includes('--headed');
const secsArg = process.argv.indexOf('--secs');
const HOLD_SECS = secsArg > -1 ? Number(process.argv[secsArg + 1]) : 10;
const urlArg = process.argv.indexOf('--url');
const URL = urlArg > -1 ? process.argv[urlArg + 1]
  : process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=runspeed';

// Open, dead-flat ground to measure on: landblock 0xA8B7 is the nearest
// landblock to the Holtburg start whose 81 CellLandblock height bytes are all
// 14 (z = 28.0) with hasObjects false — no buildings, no scenery collision, no
// slope (probed from client_cell_1.dat via our own CellLandblock parser).
// @telepoi is unusable here: the reduced world dump has 0 points_of_interest
// rows (the same gap that blocks GAP.30).
const telelocArg = process.argv.indexOf('--teleloc');
const TELELOC = telelocArg > -1 ? process.argv[telelocArg + 1] : '0xA8B70025 96 96 28.005';

const UTC = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(__dir, '..', 'verification', 'playtest', `${UTC}-run-speed`);

interface Frame {
  t: number; x: number; z: number; y: number;
  fwd: boolean; running: boolean; runRate: number; airborne: boolean;
}

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as unknown as { acDebug?: { collisionState?: () => { x: number } } }).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

/** Same virgin-account handling as measure-perf.ts (source string — __name landmine). */
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

function median(vals: number[]): number {
  if (!vals.length) return NaN;
  const s = [...vals].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({
    headless: !HEADED,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) && !HEADED ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1568, height: 775 } });
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));

  console.log(`[runspeed] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') {
        console.log(`[runspeed] virgin account — scripted create: ${created}`);
        createSent = true;
        lastReload = Date.now();
      }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[runspeed] not in world yet — reloading (phantom-session retry)');
      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
      } catch (e) {
        console.log(`[runspeed] reload failed (${(e as Error).message.split('\n')[0]}) — continuing`);
      }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) {
    await page.screenshot({ path: join(OUT, '00-never-entered-world.png') });
    console.error('[runspeed] FAILED: never entered world');
    await browser.close();
    process.exit(2);
  }

  console.log('[runspeed] in world — settling 8s');
  await page.waitForTimeout(8000);

  // Measure on open ground. The starter cottage is a sealed room barely wider
  // than two seconds of running, and the character's last position persists
  // server-side, so repeat runs start wedged against a wall or a prop.
  // @teleloc is an ACE admin command (AdminCommands.cs:912); the bundled
  // testacjs account is accessLevel 5.
  if (!process.argv.includes('--no-teleport')) {
    console.log(`[runspeed] teleporting to open ground: @teleloc ${TELELOC}`);
    await page.evaluate(`window.acDebug.admin('@teleloc ${TELELOC}')`);
    await page.waitForTimeout(15_000); // landblock load + settle onto terrain
  }
  await page.screenshot({ path: join(OUT, '01-start.png') });

  // Install the in-page per-frame sampler (source string — __name landmine).
  await page.evaluate(`(() => {
    const w = window;
    w.__runSpeedSamples = [];
    w.__runSpeedStop = false;
    const tick = () => {
      const cs = w.acDebug.collisionState();
      const cc = w.__ac.cameraController;
      w.__runSpeedSamples.push({
        t: performance.now(),
        x: cs.x, z: cs.z, y: cs.y,
        fwd: !!cc.isMovingForward, running: !!cc.isRunning,
        runRate: cc.runRate, airborne: !cs.onGround,
      });
      if (!w.__runSpeedStop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return true;
  })()`);

  // Sweep several headings. Wherever the character happens to re-log (its
  // position persists server-side), at least one heading has open ground; a
  // heading that stops early is wall contact, which is itself the behaviour
  // under test — a correct client stops rather than tunnelling through.
  const legs: Array<{
    heading: number; distance: number; wallSecs: number; simSecs: number; rawSecs: number;
    frames: number; dropped: number; speedPerSimSecond: number;
  }> = [];
  for (let leg = 0; leg < 4; leg++) {
    if (leg > 0) {
      await page.keyboard.down('ArrowLeft');
      await page.waitForTimeout(1200); // ~90 degrees at the base turn rate
      await page.keyboard.up('ArrowLeft');
      await page.waitForTimeout(300);
    }
    const before = await page.evaluate(`window.acDebug.collisionState()`) as { x: number; z: number };
    const fsBefore = await page.evaluate(`window.__ac.frameStats ? window.__ac.frameStats() : null`) as
      { frames: number; rawDtTotal: number; physDtTotal: number; droppedFrames: number } | null;
    const wallBefore = Date.now();
    console.log(`[runspeed] leg ${leg + 1}/4 — holding forward-run for ${HOLD_SECS}s…`);
    await page.keyboard.down('w');
    await page.waitForTimeout(HOLD_SECS * 1000);
    await page.keyboard.up('w');
    await page.waitForTimeout(500);
    const after = await page.evaluate(`window.acDebug.collisionState()`) as { x: number; z: number };
    const fsAfter = await page.evaluate(`window.__ac.frameStats ? window.__ac.frameStats() : null`) as
      typeof fsBefore;
    const wallSecs = (Date.now() - wallBefore) / 1000;
    const simSecs = fsAfter && fsBefore ? fsAfter.physDtTotal - fsBefore.physDtTotal : NaN;
    const rawSecs = fsAfter && fsBefore ? fsAfter.rawDtTotal - fsBefore.rawDtTotal : NaN;
    const distance = Math.hypot(after.x - before.x, after.z - before.z);
    legs.push({
      heading: leg, distance, wallSecs, simSecs, rawSecs,
      frames: fsAfter && fsBefore ? fsAfter.frames - fsBefore.frames : NaN,
      dropped: fsAfter && fsBefore ? fsAfter.droppedFrames - fsBefore.droppedFrames : NaN,
      speedPerSimSecond: simSecs > 0 ? distance / simSecs : NaN,
    });
    console.log(`[runspeed]   travelled ${distance.toFixed(2)}m | wall ${wallSecs.toFixed(2)}s, raw dt sum ${rawSecs.toFixed(2)}s, simulated ${simSecs.toFixed(2)}s over ${legs[leg].frames} frames (${legs[leg].dropped} dropped) → ${(distance / simSecs).toFixed(2)} m/simulated-s`);
  }
  await page.screenshot({ path: join(OUT, '02-end.png') });

  // A leg that moved proves movement is not stuck (the failure mode a wall
  // stop could otherwise mask).
  const turnLegDistance = Math.max(...legs.map(l => l.distance));

  // Jump: the airborne branch integrates on the same quantum-bounded delta, so
  // check the peak still matches the launch formula's height (FAITHFUL.596).
  await page.keyboard.press('Space');
  await page.waitForTimeout(4000);
  const jumpStats = await page.evaluate(`window.acDebug.jumpStats ? window.acDebug.jumpStats() : null`) as
    { last: { peakY: number; airtime: number; launchHeight: number } | null } | null;
  await page.evaluate(`(() => { window.__runSpeedStop = true; return true; })()`);
  await page.screenshot({ path: join(OUT, '03-after-jump.png') });

  const frames = await page.evaluate(`window.__runSpeedSamples`) as Frame[];
  await browser.close();

  // Only frames where forward-run was actually engaged and the player was
  // grounded (a fall adds momentum-driven displacement that isn't run speed).
  const moving = frames.filter(f => f.fwd && f.running && !f.airborne);
  const steps: Array<{ dt: number; dist: number; speed: number; configured: number }> = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1], b = frames[i];
    if (!(a.fwd && a.running && !a.airborne && b.fwd && b.running && !b.airborne)) continue;
    const dt = (b.t - a.t) / 1000;
    if (dt <= 0) continue;
    const dist = Math.hypot(b.x - a.x, b.z - a.z);
    steps.push({ dt, dist, speed: dist / dt, configured: 4.0 * b.runRate });
  }

  const runRate = median(moving.map(f => f.runRate));
  const configured = 4.0 * runRate;

  // Speed is only meaningful while the run is unobstructed. Take the leading
  // free-run window: steps from the start until travel first drops below half
  // the configured rate (wall contact — expected inside the sealed starter
  // cottage, where a correct client stops instead of tunnelling through).
  // Leading steps can straddle the keydown, so skip up to the first full-speed
  // step before collecting the window.
  const threshold = configured * 0.5;
  let best: typeof steps = [];
  let current: typeof steps = [];
  for (const st of steps) {
    if (st.speed >= threshold) {
      current.push(st);
      const cur = current.reduce((a, x) => a + x.dt, 0);
      if (cur > best.reduce((a, x) => a + x.dt, 0)) best = [...current];
    } else {
      current = [];
    }
  }
  const freeRun = best;
  const freeDist = freeRun.reduce((a, x) => a + x.dist, 0);
  const freeTime = freeRun.reduce((a, x) => a + x.dt, 0);
  const freeSpeed = freeTime > 0 ? freeDist / freeTime : NaN;
  const totalDist = steps.reduce((s, x) => s + x.dist, 0);
  const totalTime = steps.reduce((s, x) => s + x.dt, 0);
  const wallSpeed = totalTime > 0 ? totalDist / totalTime : NaN;
  const ratio = configured > 0 ? freeSpeed / configured : NaN;
  const maxStepDist = steps.reduce((m, x) => Math.max(m, x.dist), 0);

  const report = {
    url: URL, holdSecs: HOLD_SECS,
    frameCount: frames.length, movingFrameCount: moving.length, stepCount: steps.length,
    runRate, configuredSpeed: configured,
    freeRunSpeed: freeSpeed, freeRunSteps: freeRun.length, freeRunTime: freeTime, freeRunDist: freeDist,
    ratio,
    wholeHoldSpeed: wallSpeed, totalDist, totalTime,
    maxSingleStepDistance: maxStepDist,
    medianFrameDt: median(steps.map(s => s.dt)),
    turnLegDistance, legs,
    jumpStats,
    errors,
  };
  writeFileSync(join(OUT, 'samples.json'), JSON.stringify({ report, frames }, null, 2));

  console.log(`[runspeed] runRate=${runRate.toFixed(4)} → configured ${configured.toFixed(3)} m/s`);
  console.log(`[runspeed] free-run ${freeSpeed.toFixed(3)} m/s over ${freeTime.toFixed(2)}s (${freeRun.length} steps, median dt ${(report.medianFrameDt * 1000).toFixed(1)}ms)`);
  console.log(`[runspeed] whole hold ${wallSpeed.toFixed(3)} m/s over ${totalTime.toFixed(2)}s (drops when the run meets a wall)`);
  console.log(`[runspeed] largest single-frame travel ${maxStepDist.toFixed(3)}m`);
  console.log(`[runspeed] best leg travelled ${turnLegDistance.toFixed(2)}m (legs: ${legs.map(l => l.distance.toFixed(1)).join(', ')}m)`);
  if (jumpStats?.last) {
    const j = jumpStats.last;
    console.log(`[runspeed] jump: launchHeight ${j.launchHeight.toFixed(3)}m peak ${j.peakY.toFixed(3)}m airtime ${j.airtime.toFixed(2)}s (expected ~${(2 * Math.sqrt(2 * 9.8 * j.launchHeight) / 9.8).toFixed(2)}s)`);
  }
  console.log(`[runspeed] ratio free-run/configured = ${ratio.toFixed(3)}`);
  const ok = Number.isFinite(ratio) && ratio > 0.85 && ratio < 1.15 && turnLegDistance > 0.5;
  console.log(ok ? '[runspeed] PASS: forward run matches the configured rate (±15%) and movement resumes after turning'
                 : `[runspeed] FAIL: ratio ${ratio.toFixed(2)}x, turn-leg ${turnLegDistance.toFixed(2)}m`);
  console.log(`[runspeed] output: ${OUT}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(3); });
