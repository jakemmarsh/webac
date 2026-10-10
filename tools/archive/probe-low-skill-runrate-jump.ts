/**
 * probe-low-skill-runrate-jump — live verification for
 * BUG.run-jump-skill-floor-invented.
 *
 * The client previously floored the Run/Jump skill inputs at 50
 * (Math.max(50, getBase(...))) — an invented "untrained baseline" ACE does
 * not have: GetRunRate/GetJumpHeight receive the raw skill
 * (Monster_Navigation.cs:346, Player.cs:891; the only clamps are
 * CreatureSkill.cs:191's Math.Max(iTotal, 0) and the 0.35 jump-RESULT
 * minimum in MovementSystem.cs).
 *
 * This probe drives the REAL server attribute path to make the floor's
 * absence observable:
 *   1. baseline: read cameraController.runRate + measure forward speed
 *   2. self-appraise (IdentifyObject on own GUID → ACE
 *      RequestedAppraisalTarget), then `@modifyattr Quickness <delta>` down
 *      to 10 → PrivateUpdateAttribute push → our handler updates
 *      playerState.attributes; a `@setvital stamina 0`/restore cycle drives
 *      the exhaustion watcher through updateRunRate so the new Run skill
 *      (10) is re-read. Expected runRate = (1*(10/210*11)+4)/4 ≈ 1.1310
 *      (the old floor would report 1.55) and ground speed ~4.5 m/s vs ~6.2.
 *   3. restore Quickness → rate back to baseline.
 *   4. jump baseline: space-tap, read acDebug.jumpStats().launchHeight.
 *   5. `@modifyattr Strength/Coordination` down to 10 → Jump skill 10 →
 *      launchHeight must be the ACE RESULT floor 0.35 (10/1310*22.2+0.05 ≈
 *      0.219 → clamped). The old input floor would give ≈0.872·burdenMod —
 *      only reachable if burden ≥ 1.6, which a fresh test char never is.
 *   6. restore Strength/Coordination.
 *
 * Usage:  npx tsx tools/probe-low-skill-runrate-jump.ts [--headed] [--url URL]
 * Output: verification/playtest/<utc>-low-skill-runrate-jump/{report.json,*.png}
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
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=lowskill';

// Dead-flat, DRY, object- and scenery-free landblock (probed from
// client_cell_1.dat — see probe-exhaustion-runrate.ts).
const TELELOC = '0x67AA0001 96 96 240.005';
const HOLD_SECS = 4;
const LOW_ATTR = 10;

const UTC = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(__dir, '..', 'verification', 'playtest', `${UTC}-low-skill-runrate-jump`);

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

interface AttrState { runRate: number; strength: number; coordination: number; quickness: number; stamina: number; maxStamina: number }

async function readState(page: Page): Promise<AttrState> {
  return page.evaluate(`(() => {
    const ps = window.__playerState;
    return {
      runRate: window.__ac.cameraController.runRate,
      strength: ps.attributes.getCurrent(1),
      coordination: ps.attributes.getCurrent(4),
      quickness: ps.attributes.getCurrent(3),
      stamina: ps.vitals.getCurrent(2),
      maxStamina: ps.vitals.getMax(2, ps.attributes),
    };
  })()`) as Promise<AttrState>;
}

/** Drive updateRunRate via the exhaustion watcher (stamina 0 → restore).
 *  Quickness updates alone don't recompute the rate (no updateRunRate call
 *  on non-Strength attribute pushes — see BUG follow-up filed with this
 *  probe); the stamina round-trip re-reads getBase both ways. */
async function cycleStamina(page: Page, maxStamina: number): Promise<void> {
  await page.evaluate(`window.acDebug.admin('@setvital stamina 0')`);
  await page.waitForTimeout(1500);
  await page.evaluate(`window.acDebug.admin('@setvital stamina ${Math.max(50, maxStamina)}')`);
  await page.waitForTimeout(1500);
}

async function measureRunSpeed(page: Page, label: string): Promise<{ speed: number; medianRate: number; secs: number }> {
  await page.evaluate(`window.acDebug.admin('@teleloc ${TELELOC}')`);
  await page.waitForTimeout(4000);
  await page.evaluate(`(() => {
    const w = window;
    w.__lsSamples = [];
    w.__lsSampler = setInterval(() => {
      const cs = w.acDebug.collisionState();
      const cc = w.__ac.cameraController;
      w.__lsSamples.push({ t: performance.now(), x: cs.x, z: cs.z,
        rate: cc.runRate, fwd: !!cc.isMovingForward });
    }, 100);
    return true;
  })()`);
  await page.keyboard.down('w');
  await page.waitForTimeout(HOLD_SECS * 1000);
  await page.keyboard.up('w');
  await page.evaluate(`(clearInterval(window.__lsSampler), true)`);
  const samples = await page.evaluate(`window.__lsSamples`) as
    Array<{ t: number; x: number; z: number; rate: number; fwd: boolean }>;
  let dist = 0, secs = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    if (!(a.fwd && b.fwd)) continue;
    const dt = (b.t - a.t) / 1000;
    if (dt <= 0) continue;
    dist += Math.hypot(b.x - a.x, b.z - a.z);
    secs += dt;
  }
  const rates = samples.filter(s => s.fwd).map(s => s.rate).sort((x, y) => x - y);
  const res = {
    speed: secs > 0.5 ? dist / secs : NaN,
    medianRate: rates.length ? rates[rates.length >> 1] : NaN,
    secs,
  };
  console.log(`[lowskill] ${label}: ${res.speed.toFixed(3)} m/s over ${res.secs.toFixed(2)}s @ median rate ${res.medianRate?.toFixed(4)}`);
  return res;
}

/** Space-tap a jump and read the FAITHFUL.596 launch telemetry. */
async function measureJump(page: Page, label: string): Promise<{ launchHeight: number }> {
  await page.evaluate(`(window.__ac.gameLoop, true)`); // touch to fail fast if page died
  await page.keyboard.down('Space');
  await page.waitForTimeout(1500); // near-full charge (power → 1.0)
  await page.keyboard.up('Space');
  await page.waitForTimeout(2500); // airtime + landing
  const stats = await page.evaluate(`window.acDebug.jumpStats()`) as
    { last: { launchHeight: number } | null; inFlight: { launchHeight: number } | null };
  const launchHeight = stats.last?.launchHeight ?? stats.inFlight?.launchHeight ?? NaN;
  console.log(`[lowskill] ${label}: launchHeight=${launchHeight.toFixed(4)}`);
  return { launchHeight };
}

async function modifyAttr(page: Page, attr: string, delta: number): Promise<void> {
  await page.evaluate(`window.acDebug.admin('@modifyattr ${attr} ${delta}')`);
  await page.waitForTimeout(1500);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({
    headless: !HEADED,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) && !HEADED ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
  // Small viewport: SwiftShader frame cost at full size starves in-page
  // samplers (see probe-exhaustion-runrate.ts).
  const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));

  console.log(`[lowskill] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') {
        console.log(`[lowskill] virgin account — scripted create: ${created}`);
        createSent = true;
        lastReload = Date.now();
      }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[lowskill] not in world yet — reloading (phantom-session retry)');
      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
      } catch (e) {
        console.log(`[lowskill] reload failed (${(e as Error).message.split('\n')[0]}) — continuing`);
      }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) {
    await page.screenshot({ path: join(OUT, '00-never-entered-world.png') });
    console.error('[lowskill] FAILED: never entered world');
    await browser.close();
    process.exit(2);
  }

  console.log('[lowskill] in world — settling 8s');
  await page.waitForTimeout(8000);
  await page.evaluate(`window.acDebug.admin('@teleloc ${TELELOC}')`);
  await page.waitForTimeout(15_000);
  await page.screenshot({ path: join(OUT, '01-baseline.png') });

  // ── Phase 1: baseline — the fresh test char is S/C/Q 10/10/10, so the
  // baseline IS the low-skill case the invented floor used to inflate:
  // Run 10 must give runRate (1*(10/210*11)+4)/4 ≈ 1.1310 (the floor bug
  // reported 1.55 — last cycle's exhaustion probe logged exactly that on
  // this same character) and Jump 10 must bottom at the 0.35 RESULT floor.
  const base = await readState(page);
  console.log(`[lowskill] baseline: runRate=${base.runRate.toFixed(4)} S/C/Q=${base.strength}/${base.coordination}/${base.quickness}`);
  const baseRun = await measureRunSpeed(page, 'baseline (low-skill) run');
  const baseJump = await measureJump(page, 'baseline (low-skill) jump');

  // ── Phase 2: self-appraise, RAISE attributes to mid-level ──
  const HIGH_Q = 300, HIGH_SC = 200;
  const guid = await page.evaluate(`window.__ac.charGuid`) as number | null;
  console.log(`[lowskill] self-appraise guid=0x${guid?.toString(16)}`);
  await page.evaluate(`window.__ac.identifyObject(${guid})`);
  await page.waitForTimeout(2000);
  const qDelta = HIGH_Q - base.quickness;
  const sDelta = HIGH_SC - base.strength;
  const cDelta = HIGH_SC - base.coordination;
  await modifyAttr(page, 'Quickness', qDelta);
  await modifyAttr(page, 'Strength', sDelta);
  await modifyAttr(page, 'Coordination', cDelta);
  const afterRaise = await readState(page);
  console.log(`[lowskill] after raises: S/C/Q=${afterRaise.strength}/${afterRaise.coordination}/${afterRaise.quickness}`);
  await cycleStamina(page, afterRaise.maxStamina);
  const high = await readState(page);
  console.log(`[lowskill] high-Quickness: runRate=${high.runRate.toFixed(4)} (expect ≈2.65 for Run 300)`);
  const highRun = await measureRunSpeed(page, 'high-Quickness run');
  await page.evaluate(`window.acDebug.admin('@setvital stamina ${Math.max(50, afterRaise.maxStamina)}')`);
  await page.waitForTimeout(1000);
  const highJump = await measureJump(page, 'high-skill jump');
  await page.screenshot({ path: join(OUT, '02-high-attrs.png') });

  // ── Phase 3: restore to the character's real attributes ──
  await modifyAttr(page, 'Quickness', -qDelta);
  await modifyAttr(page, 'Strength', -sDelta);
  await modifyAttr(page, 'Coordination', -cDelta);
  await cycleStamina(page, base.maxStamina);
  const restored = await readState(page);
  console.log(`[lowskill] restored: runRate=${restored.runRate.toFixed(4)} S/C/Q=${restored.strength}/${restored.coordination}/${restored.quickness}`);
  await page.screenshot({ path: join(OUT, '03-restored.png') });

  await browser.close();

  // Run 10 → (1*(10/210*11)+4)/4 = 1.130952…; Run 300 → (300/500*11+4)/4 = 2.65
  const EXPECT_LOW_RATE = (10 / 210 * 11 + 4) / 4;
  const EXPECT_HIGH_RATE = (300 / 500 * 11 + 4) / 4;
  const pass = {
    // The heart of the fix: raw skill 10 rate, NOT the floored 1.55
    lowRateIsRaw: Math.abs(base.runRate - EXPECT_LOW_RATE) < 1e-3,
    lowRateNotFloored: base.runRate < 1.2,
    // Jump 10 → ACE's 0.35 RESULT floor (input-floor bug gave ≈0.872·power)
    lowJumpAtResultFloor: Math.abs(baseJump.launchHeight - 0.35) < 1e-3,
    attrsArrived: afterRaise.quickness === HIGH_Q && afterRaise.strength === HIGH_SC && afterRaise.coordination === HIGH_SC,
    // Raw feed at Run 300 through the real update path
    highRateIsRaw: Math.abs(high.runRate - EXPECT_HIGH_RATE) < 1e-3,
    // Ground speed scales with the rate (≈ rate ratio, generous tolerance)
    highRunFaster: highRun.speed > baseRun.speed * 1.5,
    // Jump 200 clears the result floor by a wide margin (monotonicity back)
    highJumpAboveFloor: highJump.launchHeight > 1.0,
    rateRestored: Math.abs(restored.runRate - base.runRate) < 1e-6,
    noPageErrors: errors.length === 0,
  };
  const report = {
    task: 'BUG.run-jump-skill-floor-invented',
    url: URL, teleloc: TELELOC, utc: UTC,
    baselineLowSkill: { state: base, run: { speed: baseRun.speed, medianRate: baseRun.medianRate }, jump: baseJump, expectRate: EXPECT_LOW_RATE },
    highAttrs: { state: high, run: { speed: highRun.speed, medianRate: highRun.medianRate }, jump: highJump, expectRate: EXPECT_HIGH_RATE },
    restored: { runRate: restored.runRate, attrs: [restored.strength, restored.coordination, restored.quickness] },
    pass, errors,
  };
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  const ok = Object.values(pass).every(Boolean);
  console.log(`[lowskill] ${ok ? 'PASS' : 'FAIL'} — ${JSON.stringify(pass)}`);
  console.log(`[lowskill] report: ${join(OUT, 'report.json')}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(3); });
