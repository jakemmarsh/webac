/**
 * probe-exhaustion-runrate — live verification for
 * BUG.exhaustion-does-not-slow-movement.
 *
 * Logs into the ACE stack headlessly (same plumbing as probe-run-speed.ts),
 * teleports to flat open ground, then drives the REAL server-side exhaustion
 * path with the ACE developer command `@setvital stamina 0` — which goes
 * through Player_Vitals.UpdateVital → OnExhausted → the vital push our
 * client's onPrivateUpdateAttribute2ndLevel handler consumes — and measures:
 *
 *   1. baseline: cameraController.runRate + measured forward speed
 *   2. exhausted: runRate must collapse to exactly 1.0 (retail
 *      CACQualities::InqRunRate zeroes the Run skill at stamina 0) and the
 *      measured speed must drop to ~4.0 m/s (RUN_ANIM_SPEED × 1.0)
 *   3. recovered (`@setvital stamina <max>`): runRate + speed must return
 *      to baseline
 *
 * Also greps the page for the server-sent "You're Exhausted!" transient.
 *
 * Usage:  npx tsx tools/probe-exhaustion-runrate.ts [--headed] [--url URL]
 * Output: verification/playtest/<utc>-exhaustion-runrate/{report.json,*.png}
 */

import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const HEADED = process.argv.includes('--headed');
const urlArg = process.argv.indexOf('--url');
const URL = urlArg > -1 ? process.argv[urlArg + 1]
  : process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=exhaust';

// Dead-flat, DRY, object- and scenery-free landblock: 0x67AA — all 81
// height bytes 120 (z=240), hasObjects false, no scenery bits, terrain
// type 9 everywhere (probed from client_cell_1.dat via our CellLandblock
// parser + isWaterTerrainType). probe-run-speed's 0xA8B7 spot is a LAKE —
// the 2026-09-06 run teleported waist-deep into water where movement is
// blocked, measuring 0.00 m/s on every leg.
const TELELOC = '0x67AA0001 96 96 240.005';
const HOLD_SECS = 4;

const UTC = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(__dir, '..', 'verification', 'playtest', `${UTC}-exhaustion-runrate`);

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

interface PhaseState { runRate: number; stamina: number; maxStamina: number }

async function readState(page: Page): Promise<PhaseState> {
  return page.evaluate(`(() => {
    const ps = window.__playerState;
    return {
      runRate: window.__ac.cameraController.runRate,
      stamina: ps ? ps.vitals.getCurrent(2) : -1,
      maxStamina: ps ? ps.vitals.getMax(2, ps.attributes) : -1,
    };
  })()`) as Promise<PhaseState>;
}

interface LegResult {
  /** speed over samples where the run rate was at the WALK clamp (1.0) */
  walkSpeed: number;
  /** speed over samples where the run rate was the normal skill rate */
  normalSpeed: number;
  walkSecs: number;
  normalSecs: number;
  medianRate: number;
  minRate: number;
  fwdSeen: boolean;
  samples: Array<{ t: number; x: number; z: number; rate: number; fwd: boolean; stam: number }>;
}

/**
 * Teleport back to the flat-block center, hold forward for HOLD_SECS while an
 * IN-PAGE rAF sampler records per-frame position + runRate (CDP round-trips
 * race the server vital pushes — the 2026-09-06 first rerun sampled 1.55 on
 * every read because each read landed before the @setvital push arrived).
 * During an exhausted leg an IN-PAGE interval re-pins stamina to 0 every
 * 400ms; the per-frame samples are then partitioned by runRate so the speed
 * while actually exhausted (rate 1.0) is measured separately from the
 * recovery gaps the server regen forces between pins.
 */
async function measureLeg(page: Page, label: string, keepExhausted: boolean): Promise<LegResult> {
  await page.evaluate(`window.acDebug.admin('@teleloc ${TELELOC}')`);
  await page.waitForTimeout(4000);
  // setInterval, NOT requestAnimationFrame — headless SwiftShader throttles
  // rAF to ~1.2Hz here (8 samples per 6s leg in the 2026-09-06 v2 runs),
  // far too sparse to partition the pin/regen rate flapping. Positions and
  // runRate only advance per render frame, so 0-distance samples between
  // frames are expected; the per-class aggregation below sums dt and
  // distance across each same-rate window, which averages correctly over
  // the frame quantization.
  await page.evaluate(`(() => {
    const w = window;
    w.__exSamples = [];
    if (${keepExhausted}) {
      w.acDebug.admin('@setvital stamina 0');
      w.__exPin = setInterval(() => w.acDebug.admin('@setvital stamina 0'), 300);
    }
    w.__exSampler = setInterval(() => {
      const cs = w.acDebug.collisionState();
      const cc = w.__ac.cameraController;
      w.__exSamples.push({ t: performance.now(), x: cs.x, z: cs.z,
        rate: cc.runRate, fwd: !!cc.isMovingForward,
        stam: w.__playerState.vitals.getCurrent(2) });
    }, 100);
    return true;
  })()`);
  if (keepExhausted) await page.waitForTimeout(800); // let the first pin land
  await page.keyboard.down('w');
  await page.waitForTimeout((keepExhausted ? HOLD_SECS * 3 : HOLD_SECS) * 1000);
  await page.keyboard.up('w');
  await page.evaluate(`(() => {
    clearInterval(window.__exSampler);
    if (window.__exPin) { clearInterval(window.__exPin); window.__exPin = null; }
    return true;
  })()`);
  const samples = await page.evaluate(`window.__exSamples`) as
    Array<{ t: number; x: number; z: number; rate: number; fwd: boolean; stam: number }>;

  const WALK = 1.0 + 1e-6;
  let walkDist = 0, walkSecs = 0, normalDist = 0, normalSecs = 0;
  let fwdSeen = false;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    if (!(a.fwd && b.fwd)) continue;
    fwdSeen = true;
    const dt = (b.t - a.t) / 1000;
    if (dt <= 0) continue;
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    if (a.rate <= WALK && b.rate <= WALK) { walkDist += d; walkSecs += dt; }
    else if (a.rate > WALK && b.rate > WALK) { normalDist += d; normalSecs += dt; }
  }
  const rates = samples.filter(s => s.fwd).map(s => s.rate).sort((x, y) => x - y);
  const res: LegResult = {
    walkSpeed: walkSecs > 0.5 ? walkDist / walkSecs : NaN,
    normalSpeed: normalSecs > 0.5 ? normalDist / normalSecs : NaN,
    walkSecs, normalSecs,
    medianRate: rates.length ? rates[rates.length >> 1] : NaN,
    minRate: rates.length ? rates[0] : NaN,
    fwdSeen,
    samples,
  };
  console.log(`[exhaust] ${label}: walk-rate windows ${res.walkSecs.toFixed(2)}s @ ${res.walkSpeed.toFixed(3)} m/s | normal-rate windows ${res.normalSecs.toFixed(2)}s @ ${res.normalSpeed.toFixed(3)} m/s | median rate ${res.medianRate?.toFixed(3)} min ${res.minRate?.toFixed(3)}${res.fwdSeen ? '' : ' | WARNING: forward never registered'}`);
  return res;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({
    headless: !HEADED,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) && !HEADED ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
  // Small viewport on purpose: SwiftShader frame cost at 1568×775 pushes the
  // frame quantum to ~1s, starving the sampler (in-page timers can't outrun
  // the main-thread frame) — at 400×300 the page runs many frames/second and
  // the pin/regen flapping partitions cleanly. Panel-quality screenshots are
  // not this probe's job.
  const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));

  console.log(`[exhaust] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') {
        console.log(`[exhaust] virgin account — scripted create: ${created}`);
        createSent = true;
        lastReload = Date.now();
      }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[exhaust] not in world yet — reloading (phantom-session retry)');
      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
      } catch (e) {
        console.log(`[exhaust] reload failed (${(e as Error).message.split('\n')[0]}) — continuing`);
      }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) {
    await page.screenshot({ path: join(OUT, '00-never-entered-world.png') });
    console.error('[exhaust] FAILED: never entered world');
    await browser.close();
    process.exit(2);
  }

  console.log('[exhaust] in world — settling 8s');
  await page.waitForTimeout(8000);
  console.log(`[exhaust] teleporting to open ground: @teleloc ${TELELOC}`);
  await page.evaluate(`window.acDebug.admin('@teleloc ${TELELOC}')`);
  await page.waitForTimeout(15_000);
  await page.screenshot({ path: join(OUT, '01-baseline.png') });

  // Phase 1 — baseline
  const baseState = await readState(page);
  console.log(`[exhaust] baseline: runRate=${baseState.runRate.toFixed(4)} stamina=${baseState.stamina}/${baseState.maxStamina}`);
  const baseline = await measureLeg(page, 'baseline run', false);

  // Phase 2 — exhaust via the real server path (@setvital → UpdateVital →
  // OnExhausted → Attribute2ndLevel push → our 10Hz watcher tick). The leg's
  // per-frame samples carry the rate evidence; server regen forces short
  // recovery gaps between pins, partitioned out by the sampler.
  const exhausted = await measureLeg(page, 'exhausted run', true);
  await page.screenshot({ path: join(OUT, '02-exhausted.png') });
  const transientShown = await page.evaluate(`document.body.innerText.includes("Exhausted")`) as boolean;

  // Phase 3 — recover
  await page.evaluate(`window.acDebug.admin('@setvital stamina ${Math.max(50, baseState.maxStamina)}')`);
  await page.waitForTimeout(1500);
  const recoveredState = await readState(page);
  console.log(`[exhaust] recovered: runRate=${recoveredState.runRate.toFixed(4)} stamina=${recoveredState.stamina}`);
  const recovered = await measureLeg(page, 'recovered run', false);
  await page.screenshot({ path: join(OUT, '03-recovered.png') });

  await browser.close();

  const pass = {
    // the exhausted leg must actually reach the walk clamp and hold it
    exhaustedRateHitsWalk: exhausted.minRate <= 1.0 + 1e-6 && exhausted.walkSecs >= 1.0,
    // ground speed while at the walk clamp must be a real slowdown
    exhaustedSlower: exhausted.walkSpeed < baseline.normalSpeed * 0.8,
    recoveredRateRestored: Math.abs(recoveredState.runRate - baseState.runRate) < 1e-6,
    recoveredSpeedRestored: Math.abs(recovered.normalSpeed - baseline.normalSpeed) < baseline.normalSpeed * 0.2,
    transientShown,
  };
  const report = {
    url: URL, teleloc: TELELOC, holdSecs: HOLD_SECS,
    baseline: { state: baseState, leg: baseline },
    exhausted: { leg: exhausted },
    recovered: { state: recoveredState, leg: recovered },
    pass, errors,
  };
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));

  console.log(`[exhaust] PASS checks: ${JSON.stringify(pass)}`);
  const ok = pass.exhaustedRateHitsWalk && pass.exhaustedSlower && pass.recoveredRateRestored && pass.recoveredSpeedRestored;
  console.log(ok ? '[exhaust] VERIFIED — exhaustion slows movement to walk and recovery restores it'
                 : '[exhaust] FAILED — see report.json');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(3); });
