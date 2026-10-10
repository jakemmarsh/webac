/**
 * BUG.clothingpriority-never-lands — live end-to-end probe.
 *
 * Logs into the real ACE stack and verifies that ClothingPriority now lands
 * from the CreateObject wire field (WeenieHeaderFlag.Priority) onto:
 *   1. the player's own equipped items (playerState.inventory entries), and
 *   2. world objects (ServerObjectManager), where any NPC-wielded clothing
 *      in range carries the value.
 * Pre-fix both were undefined for every object, always (the parser discarded
 * the field and the FAITHFUL.599 login stamp was a runtime no-op).
 *
 * The fresh test char may spawn with no ClothingPriority-bearing gear, so
 * the decisive leg is a `@ci <wcid>` of a known armor piece (ACE fills
 * ClothingPriority from the weenie's PropertyInt.ClothingPriority = 4) —
 * its CreateObject must produce an inventory entry with the value set.
 *
 * Usage: npx tsx tools/probe-clothingpriority.ts [--headed] [--url <url>]
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
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=clothpri';

// Mail Coif (wcid 85, "mailcoif") — ClothingPriority 16384 (0x4000) in the
// ACE world DB (verified live: weenie_properties_int type=4). Any armor
// with the property works; this one is era-stable.
const TEST_WCID = 85;
const EXPECTED_PRIORITY = 16384;
const UTC = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(__dir, '..', 'verification', 'playtest', `${UTC}-clothingpriority`);

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

interface Snapshot {
  inventory: Array<{ name: string; wcid: number; clothingPriority: number | null }>;
  world: Array<{ name: string; guid: string; clothingPriority: number }>;
  worldTotal: number;
}

async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(`(() => {
    const ps = window.__playerState;
    const som = window.__ac.serverObjectManager;
    const inventory = ps.inventory.getAll().map(i => ({
      name: i.name, wcid: i.weenieClassId,
      clothingPriority: i.clothingPriority === undefined ? null : i.clothingPriority,
    }));
    const world = [];
    let worldTotal = 0;
    for (const [guid, obj] of som.getAllObjects()) {
      worldTotal++;
      if (obj.clothingPriority !== undefined) {
        world.push({ name: obj.name, guid: '0x' + guid.toString(16), clothingPriority: obj.clothingPriority });
      }
    }
    return { inventory, world, worldTotal };
  })()`) as Promise<Snapshot>;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({
    headless: !HEADED,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) && !HEADED ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));

  console.log(`[clothpri] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') {
        console.log(`[clothpri] virgin account — scripted create: ${created}`);
        createSent = true;
        lastReload = Date.now();
      }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[clothpri] not in world yet — reloading (phantom-session retry)');
      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
      } catch (e) {
        console.log(`[clothpri] reload failed (${(e as Error).message.split('\n')[0]}) — continuing`);
      }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) {
    await page.screenshot({ path: join(OUT, '00-never-entered-world.png') });
    console.error('[clothpri] FAILED: never entered world');
    await browser.close();
    process.exit(2);
  }

  console.log('[clothpri] in world — settling 8s');
  await page.waitForTimeout(8000);

  const before = await snapshot(page);
  console.log(`[clothpri] login inventory (${before.inventory.length} items):`);
  for (const i of before.inventory) console.log(`  wcid=${i.wcid} clothingPriority=${i.clothingPriority} ${i.name}`);
  console.log(`[clothpri] world objects with clothingPriority set: ${before.world.length}/${before.worldTotal}`);

  // Decisive leg: create a known armor piece — its CreateObject rides the
  // same parser path with WeenieHeaderFlag.Priority set.
  await page.evaluate(`window.acDebug.admin('@ci ${TEST_WCID}')`);
  await page.waitForTimeout(4000);
  const after = await snapshot(page);
  const vest = after.inventory.filter(i => i.wcid === TEST_WCID);
  console.log(`[clothpri] after @ci ${TEST_WCID}: ${vest.length} match(es):`);
  for (const i of vest) console.log(`  wcid=${i.wcid} clothingPriority=${i.clothingPriority} ${i.name}`);

  await page.screenshot({ path: join(OUT, '01-in-world.png') });

  const gotPriority = vest.some(i => i.clothingPriority === EXPECTED_PRIORITY);
  const verdict = {
    url: URL,
    testWcid: TEST_WCID,
    loginInventory: before.inventory,
    worldWithPriority: before.world.slice(0, 20),
    worldTotal: before.worldTotal,
    createdItem: vest,
    gotPriority,
    pageErrors: errors,
  };
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(verdict, null, 2));
  console.log(`[clothpri] ${gotPriority ? 'PASS' : 'FAIL'} — created armor ${gotPriority ? `carries clothingPriority=${EXPECTED_PRIORITY}` : `is missing clothingPriority=${EXPECTED_PRIORITY}`}; ${errors.length} page error(s)`);
  console.log(`[clothpri] evidence: ${OUT}`);
  await browser.close();
  process.exit(gotPriority && errors.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
