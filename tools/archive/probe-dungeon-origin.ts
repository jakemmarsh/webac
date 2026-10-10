/**
 * probe-dungeon-origin — targeted live verification for
 * BUG.movementsync-dungeon-origin-floor-division.
 *
 * Logs into the ACE stack headlessly (same path as live-playtest.ts),
 * creates a fresh character if the account is virgin, then samples
 * window.acDebug.collisionState() every 500ms for ~45s while idle inside
 * the starting cottage. The defect manifested as the position flapping
 * exactly ±192m (355.518 <-> 547.518 on one axis) with zero input, as ACE
 * echoed back the mis-encoded AutonomousPosition. The probe records every
 * sample, reports the max per-axis delta, and screenshots start/end.
 *
 * Usage:  npx tsx tools/probe-dungeon-origin.ts [--headed] [--url URL]
 * Output: verification/playtest/<utc>-dungeon-origin/{samples.json,*.png}
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
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=dungeonprobe';

const UTC = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(__dir, '..', 'verification', 'playtest', `${UTC}-dungeon-origin`);

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

async function collision(page: Page): Promise<Record<string, number>> {
  return page.evaluate(`window.acDebug.collisionState()`) as Promise<Record<string, number>>;
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

  console.log(`[probe] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  // Phantom-session retry loop (same shape as live-playtest.ts).
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') {
        console.log(`[probe] virgin account — scripted create: ${created}`);
        createSent = true;
        lastReload = Date.now();
      }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[probe] not in world yet — reloading (phantom-session retry)');
      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
      } catch (e) {
        console.log(`[probe] reload failed (${(e as Error).message.split('\n')[0]}) — continuing`);
      }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) {
    await page.screenshot({ path: join(OUT, '00-never-entered-world.png') });
    console.error('[probe] FAILED: never entered world');
    await browser.close();
    process.exit(2);
  }

  console.log('[probe] in world — settling 5s, then sampling 45s idle');
  await page.waitForTimeout(5000);
  await page.screenshot({ path: join(OUT, '01-start.png') });

  const samples: Array<{ t: number } & Record<string, number>> = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 45_000) {
    const cs = await collision(page);
    samples.push({ t: Date.now() - t0, ...cs });
    await page.waitForTimeout(500);
  }
  await page.screenshot({ path: join(OUT, '02-end.png') });

  // Analyze: max excursion on the position axes (cells/stepUp counters vary legitimately).
  const axes = ['x', 'y', 'z', 'lastFloor'].filter(k => typeof samples[0][k] === 'number');
  const report: Record<string, { min: number; max: number; delta: number }> = {};
  let worst = 0;
  for (const a of axes) {
    const vals = samples.map(s => s[a]).filter(v => Number.isFinite(v));
    const min = Math.min(...vals), max = Math.max(...vals);
    report[a] = { min, max, delta: max - min };
    if (max - min > worst) worst = max - min;
  }
  writeFileSync(join(OUT, 'samples.json'), JSON.stringify({ url: URL, samples, report, errors }, null, 2));

  console.log('[probe] per-axis excursion over 45s idle:');
  for (const [a, r] of Object.entries(report)) {
    console.log(`  ${a}: min=${r.min.toFixed(3)} max=${r.max.toFixed(3)} delta=${r.delta.toFixed(3)}`);
  }
  const flap = worst > 50; // the defect flapped exactly 192m; idle drift should be ~0
  console.log(flap
    ? `[probe] FAIL: position flapped ${worst.toFixed(1)}m while idle (192m snap regression)`
    : `[probe] PASS: max idle excursion ${worst.toFixed(3)}m — no snap-teleport`);
  console.log(`[probe] output: ${OUT}`);
  await browser.close();
  process.exit(flap ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(3); });
