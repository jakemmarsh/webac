/**
 * BUG.daynight-phase-not-server-synced — live verification on the ACE stack.
 *
 * Drives one real client and checks the full chain live:
 *  1. SYNC ARRIVES: acDebug.timeOfDay().gameClock becomes non-null (the
 *     TimeSync optional header reached the skybox; ACE sends one every 20s).
 *  2. RETAIL FORMULA: the rendered phase equals
 *     ((gameClock + zeroTimeOfYear=3600) mod dayLength=7620) / 7620
 *     (retail GameTime::CalcDayBegin/UseTime; EoL portal.dat GameTime).
 *  3. CLOCK IS THE SERVER'S: gameClock matches ACE's PortalYearTicks
 *     epoch — DerethDateTime.UtcNowToEMUTime = seconds since
 *     2017-01-31 17:00 UTC (retailDayLast, EST) — within tolerance.
 *  4. ADVANCES IN REAL TIME: two samples ~25s apart advance the clock by
 *     the elapsed wall time (±5s), phase follows.
 *
 * Evidence: verdict.json + sky screenshot in verification/daynight-sync/.
 */
import { chromium, Page } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = '/home/user/acjs';
const OUT = join(REPO, 'verification', 'daynight-sync');
const CREATE_NAME = 'Daynight Tester';
const DAY_LENGTH = 7620;
const ZERO_TIME_OF_YEAR = 3600;
// ACE DerethDateTime.UtcNowToEMUTime: (UtcNow - 5h) - 2017-01-31T12:00 naive
// = seconds since 2017-01-31T17:00:00Z.
const EMU_EPOCH_MS = Date.UTC(2017, 0, 31, 17, 0, 0);

function url(account: string): string {
  return `http://localhost:3000/?ace&bridge=ws://localhost:9090&account=${account}&password=${account}&cb=dnsync`;
}

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbg = (window as any).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

async function driveCharacterCreate(page: Page, name: string): Promise<string> {
  return page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    if (!ui || !ui.ui || ui.ui.currentScreen !== 'character-create') return 'not-at-create';
    if (!ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return 'no-hooks';
    ui.wizard.name = ${JSON.stringify(name)};
    ui.callbacks.onCharacterCreated(ui.wizard);
    return 'sent';
  })()`) as Promise<string>;
}

async function loginLoop(page: Page): Promise<void> {
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) return;
    if (!createSent) {
      const created = await driveCharacterCreate(page, CREATE_NAME);
      if (created !== 'not-at-create') {
        console.log(`[dnsync-live] scripted character create: ${created}`);
        createSent = true;
        lastReload = Date.now();
      }
    }
    if (Date.now() - lastReload > 90_000) {
      console.log('[dnsync-live] not in world yet — reloading (phantom-session retry)');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* retry */ }
      lastReload = Date.now();
      createSent = false;
    }
    await page.waitForTimeout(3000);
  }
  throw new Error('never entered world within 360s');
}

interface TimeState { timeOfDay: number; dayLengthSeconds: number; gameClock: number | null; wallMs: number }

async function timeState(page: Page): Promise<TimeState> {
  return page.evaluate(`(() => {
    const t = window.acDebug.timeOfDay();
    return { ...t, wallMs: Date.now() };
  })()`) as Promise<TimeState>;
}

const HOURS = ['Darktide', 'Darktide-and-Half', 'Foredawn', 'Foredawn-and-Half', 'Dawnsong',
  'Dawnsong-and-Half', 'Morntide', 'Morntide-and-Half', 'Midsong', 'Midsong-and-Half',
  'Warmtide', 'Warmtide-and-Half', 'Evensong', 'Evensong-and-Half', 'Gloaming', 'Gloaming-and-Half'];

function phaseOf(clock: number): number {
  return ((clock + ZERO_TIME_OF_YEAR) % DAY_LENGTH) / DAY_LENGTH;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--enable-unsafe-swiftshader', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('console', m => { if (m.text().includes('[Sky]') || m.text().includes('TimeSync')) console.log('[page]', m.text()); });

  const checks: Record<string, { pass: boolean; detail: unknown }> = {};
  try {
    await page.goto(url('testacjs'), { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await loginLoop(page);
    console.log('[dnsync-live] in world');

    // New characters spawn in the training-academy INTERIOR, where skybox
    // updates are intentionally skipped (dungeon fog/lighting). The phase can
    // only be observed outdoors — teleport to Holtburg and wait for the
    // outdoor state.
    const st = await page.evaluate(`window.acDebug.collisionState()`) as { inDungeon: boolean };
    if (st.inDungeon) {
      console.log('[dnsync-live] spawned indoors — @telepoi holtburg');
      await page.evaluate(`window.acDebug.admin('@telepoi holtburg')`);
      const outDeadline = Date.now() + 90_000;
      while (Date.now() < outDeadline) {
        const s = await page.evaluate(`window.acDebug.collisionState()`) as { inDungeon: boolean };
        if (!s.inDungeon) break;
        await page.waitForTimeout(2000);
      }
      await page.waitForTimeout(8000); // let streaming + a few sky updates settle
      const after = await page.evaluate(`window.acDebug.collisionState()`) as { inDungeon: boolean };
      if (after.inDungeon) throw new Error('still indoors after @telepoi holtburg');
      console.log('[dnsync-live] outdoors at Holtburg');
    }

    // 1. TimeSync arrives (ACE sends the first one within seconds of connect)
    const syncDeadline = Date.now() + 60_000;
    let s1 = await timeState(page);
    while (s1.gameClock === null && Date.now() < syncDeadline) {
      await page.waitForTimeout(2000);
      s1 = await timeState(page);
    }
    checks['1-timesync-arrives'] = { pass: s1.gameClock !== null, detail: s1 };
    if (s1.gameClock === null) throw new Error('no TimeSync within 60s of world entry');

    // 2. Retail phase formula
    const expectedPhase = phaseOf(s1.gameClock);
    const phaseErr = Math.abs(s1.timeOfDay - expectedPhase);
    checks['2-retail-phase-formula'] = {
      pass: phaseErr < 0.01 && s1.dayLengthSeconds === DAY_LENGTH,
      detail: { phase: s1.timeOfDay, expectedPhase, phaseErr, dayLength: s1.dayLengthSeconds },
    };

    // 3. Clock matches ACE's PortalYearTicks epoch (server boot skew tolerance)
    const expectedTicks = (s1.wallMs - EMU_EPOCH_MS) / 1000;
    const tickErr = Math.abs(s1.gameClock - expectedTicks);
    checks['3-server-epoch'] = {
      pass: tickErr < 600,
      detail: { gameClock: s1.gameClock, expectedTicks, tickErrSeconds: tickErr },
    };

    // 4. Advances in real time across ~25s (a fresh TimeSync also lands in that window)
    await page.waitForTimeout(25_000);
    const s2 = await timeState(page);
    const elapsed = (s2.wallMs - s1.wallMs) / 1000;
    const clockAdvance = (s2.gameClock ?? 0) - (s1.gameClock ?? 0);
    checks['4-advances-realtime'] = {
      pass: Math.abs(clockAdvance - elapsed) < 5,
      detail: { elapsed, clockAdvance, phase1: s1.timeOfDay, phase2: s2.timeOfDay },
    };

    const hour = HOURS[Math.floor(s2.timeOfDay * 16) % 16];
    console.log(`[dnsync-live] in-game time: ${hour} (phase ${s2.timeOfDay.toFixed(4)}, clock ${s2.gameClock?.toFixed(0)})`);
    await page.screenshot({ path: join(OUT, '1-sky-at-synced-phase.png') });

    const allPass = Object.values(checks).every(c => c.pass);
    writeFileSync(join(OUT, 'verdict.json'), JSON.stringify({
      task: 'BUG.daynight-phase-not-server-synced',
      when: new Date().toISOString(),
      inGameHour: hour,
      allPass, checks,
    }, null, 2));
    console.log(`[dnsync-live] ${allPass ? 'ALL PASS' : 'FAILURES'} — ${Object.entries(checks).map(([k, c]) => `${k}:${c.pass ? 'ok' : 'FAIL'}`).join(' ')}`);
    process.exitCode = allPass ? 0 : 1;
  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error('[dnsync-live] ERROR', e); process.exit(2); });
