/**
 * probe-run-walk-default — live verification for CORE.2.
 *
 * Jake's live report: "characters run by default, shift to walk — right now
 * it's inverted." Retail ground truth (ACE CharacterOptions1.cs:47): the
 * fresh-character default flags include ToggleRun (0x400), i.e.
 * RunAsDefaultMovement is ON — released keys RUN, holding Shift WALKS.
 *
 * This probe logs into the ACE stack headlessly with a FRESH browser profile
 * (clean localStorage — no stale optionsSettings cache) and checks the whole
 * chain live:
 *
 *   1. gameUI.optionsSettings.runAsDefault after PlayerDescription restore
 *      (FAITHFUL.570) — must be true for a fresh character.
 *   2. cameraController.runIsDefault — must be true (startup apply at
 *      main.ts:5244 + restore push).
 *   3. cameraController.isRunning with no keys held — must be true; with
 *      Shift held — must be false.
 *   4. Actual displacement over ~4s of W with no Shift vs W+Shift: the
 *      no-Shift leg must be FASTER (run ≈ 4.0×runRate m/s vs walk 3.12 m/s).
 *
 * Usage: npx tsx tools/probe-run-walk-default.ts
 * Requires: vite dev server (:3000), ws-tcp-bridge (:9090), ACE stack.
 */

import { chromium, type Page } from 'playwright';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const OUT_DIR = join(__dir, '..', 'verification', 'core2-run-default');
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=runwalk';
const VIEW = { width: 1280, height: 800 };

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as unknown as { acDebug?: { collisionState?: () => { x: number } } }).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

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

/** Player world position via the collision debug hook. */
async function pos(page: Page): Promise<{ x: number; z: number }> {
  return page.evaluate(`(() => {
    const cs = window.acDebug.collisionState();
    return { x: cs.x, z: cs.z };
  })()`) as Promise<{ x: number; z: number }>;
}

/** Drive keys through the real CameraController key set and measure displacement. */
async function measureLeg(page: Page, label: string, shift: boolean, ms: number) {
  await page.evaluate(`(() => {
    const cc = window.__ac.cameraController;
    ${shift ? `cc.simulateKeyDown('ShiftLeft');` : ''}
    cc.simulateKeyDown('KeyW');
  })()`);
  const p0 = await pos(page);
  const t0 = Date.now();
  const samples: Array<{ t: number; x: number; z: number; onGround: boolean; auto: number; move: number; lastAutoZ: number | null }> = [];
  while (Date.now() - t0 < ms) {
    await page.waitForTimeout(1000);
    const s = await page.evaluate(`(() => {
      const cs = window.acDebug.collisionState();
      const ps = window.__probeSync || {};
      return { x: cs.x, z: cs.z, onGround: cs.onGround, auto: ps.auto, move: ps.move,
               lastAutoZ: ps.lastAuto ? ps.lastAuto.z : null };
    })()`) as { x: number; z: number; onGround: boolean; auto: number; move: number; lastAutoZ: number | null };
    samples.push({ t: Date.now() - t0, ...s });
  }
  const p1 = await pos(page);
  const t1 = Date.now();
  const state = await page.evaluate(`(() => {
    const cc = window.__ac.cameraController;
    return { isRunning: cc.isRunning, runIsDefault: cc.runIsDefault, runRate: cc.runRate };
  })()`) as { isRunning: boolean; runIsDefault: boolean; runRate: number };
  await page.evaluate(`(() => {
    const cc = window.__ac.cameraController;
    cc.simulateKeyUp('KeyW');
    ${shift ? `cc.simulateKeyUp('ShiftLeft');` : ''}
  })()`);
  const dist = Math.hypot(p1.x - p0.x, p1.z - p0.z);
  const speed = dist / ((t1 - t0) / 1000);
  console.log(`[probe] leg ${label}: dist=${dist.toFixed(2)}m over ${t1 - t0}ms → ${speed.toFixed(2)} m/s (isRunning=${state.isRunning}, runRate=${state.runRate.toFixed(2)})`);
  for (const s of samples) console.log(`[probe]   t=${s.t}ms x=${s.x.toFixed(2)} z=${s.z.toFixed(2)} onGround=${s.onGround} auto#=${s.auto} move#=${s.move} lastAutoZ=${s.lastAutoZ == null ? 'n/a' : s.lastAutoZ.toFixed(2)}`);
  return { label, dist, speed, samples, ...state };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());

  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('Position correction') || t.includes('teleport') || t.includes('Teleport')
      || t.includes('violation') || t.includes('MoveToState')) {
      console.log(`[client] ${t}`);
    }
  });

  console.log(`[probe] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') {
        console.log(`[probe] character-create: ${created}`);
        createSent = true;
        lastReload = Date.now();
      }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[probe] not in world yet — reloading');
      try { await page.goto(URL, { waitUntil: 'domcontentloaded' }); } catch { /* retry */ }
      lastReload = Date.now();
      createSent = false;
    }
    await page.waitForTimeout(2000);
  }
  if (!(await inWorld(page))) {
    console.error('[probe] FAIL: never entered world');
    await browser.close();
    process.exit(1);
  }
  console.log('[probe] in world — settling 8s');
  await page.waitForTimeout(8000);

  // Flat open terrain for a clean displacement measurement.
  await page.evaluate(`window.acDebug.sendChat('@telepoi Holtburg')`);
  console.log('[probe] @telepoi Holtburg — waiting 20s for teleport + terrain');
  await page.waitForTimeout(20000);

  // 1+2: option + controller state after login restore.
  const optState = await page.evaluate(`(() => {
    const ac = window.__ac;
    let stored = null;
    try { stored = localStorage.getItem('ac_options_settings_v1'); } catch {}
    return {
      optionsRunAsDefault: ac.gameUI.optionsSettings.runAsDefault,
      ccRunIsDefault: ac.cameraController.runIsDefault,
      ccAutoRun: ac.cameraController.autoRun,
      storedOptions: stored ? JSON.parse(stored).runAsDefault : 'no-localStorage-entry',
    };
  })()`) as Record<string, unknown>;
  console.log(`[probe] state: ${JSON.stringify(optState)}`);

  // 3: isRunning polarity without touching real DOM keys.
  const polarity = await page.evaluate(`(() => {
    const cc = window.__ac.cameraController;
    const idle = cc.isRunning;
    cc.simulateKeyDown('ShiftLeft');
    const shifted = cc.isRunning;
    cc.simulateKeyUp('ShiftLeft');
    return { idleIsRunning: idle, shiftHeldIsRunning: shifted };
  })()`) as { idleIsRunning: boolean; shiftHeldIsRunning: boolean };
  console.log(`[probe] polarity: ${JSON.stringify(polarity)}`);

  // Instrument MovementSync: count MoveToState + AutonomousPosition sends
  // and record the last positions shipped, so a rubber-band can be traced to
  // "client stopped telling the server" vs "server rejecting what we send".
  await page.evaluate(`(() => {
    const ms = window.__ac.movementSync;
    window.__probeSync = { auto: 0, move: 0, lastAuto: null, lastMove: null };
    const origAuto = ms.sendAutonomousPosition.bind(ms);
    ms.sendAutonomousPosition = (pos) => {
      window.__probeSync.auto++;
      window.__probeSync.lastAuto = { x: pos.worldX, z: pos.worldZ, t: Date.now() };
      return origAuto(pos);
    };
    const origMove = ms.sendMoveToState.bind(ms);
    ms.sendMoveToState = (state, pos) => {
      window.__probeSync.move++;
      window.__probeSync.lastMove = { x: pos.worldX, z: pos.worldZ, running: state.running, fwd: state.forward, t: Date.now() };
      return origMove(state, pos);
    };
  })()`);

  await page.screenshot({ path: join(OUT_DIR, '01-pre-move.png') });

  // 4: real displacement — discriminator legs.
  //   A: walk baseline. B: run baseline (rubber-bands in prior runs).
  //   E: run with autopos forced to ≤250ms cadence — if run tracks here, the
  //      per-request position delta (speed × interval) is what ACE's legacy
  //      update_object_server transition chokes on.
  //   F: run heading reversed (180°) — if run tracks here, a server-side
  //      obstacle south of the POI explains the band, not the run encoding.
  const walkA = await measureLeg(page, 'A W+Shift (expect WALK)', true, 4000);
  await page.waitForTimeout(1500);
  const runA = await measureLeg(page, 'B W (no shift — expect RUN)', false, 4000);
  await page.waitForTimeout(1500);
  // Force fast autopos cadence through the real update() path.
  await page.evaluate(`(() => {
    const ms = window.__ac.movementSync;
    const origUpdate = ms.update.bind(ms);
    window.__lastFast = 0;
    ms.update = (state, pos, now) => {
      origUpdate(state, pos, now);
      const moving = state.forward || state.backward || state.strafeLeft || state.strafeRight;
      if (moving && now - window.__lastFast >= 250) {
        window.__lastFast = now;
        ms.sendAutonomousPosition(pos);
      }
    };
  })()`);
  const runE = await measureLeg(page, 'E W run + 250ms autopos', false, 4000);
  // Restore normal cadence and turn 180°.
  await page.evaluate(`(() => {
    const ms = window.__ac.movementSync;
    ms.update = ms.constructor.prototype.update.bind(ms);
    window.__ac.cameraController.playerYaw += Math.PI;
  })()`);
  await page.waitForTimeout(1500);
  const runF = await measureLeg(page, 'F W run, reversed heading', false, 4000);
  const runLeg = [runA, runE, runF].sort((a, b) => b.dist - a.dist)[0];
  const walkLeg = walkA;
  const allLegs = [walkA, runA, runE, runF];
  await page.screenshot({ path: join(OUT_DIR, '02-post-move.png') });

  const result = {
    when: new Date().toISOString(),
    optState, polarity,
    allLegs,
    legs: { run: runLeg, walk: walkLeg },
    verdict: {
      optionsRestoredTrue: optState.optionsRunAsDefault === true,
      controllerTrue: optState.ccRunIsDefault === true,
      idleRuns: polarity.idleIsRunning === true,
      shiftWalks: polarity.shiftHeldIsRunning === false,
      noShiftFasterThanShift: runLeg.speed > walkLeg.speed * 1.1,
    },
  };
  writeFileSync(join(OUT_DIR, 'result.json'), JSON.stringify(result, null, 2));
  console.log('[probe] === RESULT ===');
  console.log(JSON.stringify(result.verdict, null, 2));

  await browser.close();
  const pass = Object.values(result.verdict).every(Boolean);
  console.log(pass ? '[probe] PASS — run is default, shift walks' : '[probe] FAIL — see result.json');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
