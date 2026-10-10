/**
 * probe-autodequip — live verification for BUG.equip-no-auto-dequip-conflicting.
 *
 * The exact 2026-08-23 live repro: double-click-equip a Helmet while the
 * starter Cap is worn. Pre-fix the client sent GetAndWieldItem with the full
 * validLocations mask into the occupied slot and ACE rejected it with
 * InventoryServerSaveFailed (error=0), rolling back the optimistic equip.
 *
 * Post-fix (retail CPlayerSystem::AutoWield semantics) the expected wire
 * sequence is:
 *   1. PutItemInContainer(Cap → player pack)   [client-side auto-dequip]
 *   2. (server confirms the dequip via InventoryPut)
 *   3. GetAndWieldItem(Helmet, 0x1)            [retry with the single bit]
 *   4. (server confirms via WieldObject — no InventoryServerSaveFailed)
 *
 * Also drives a weapon swap (spawn two Training Wands? no — two maces via
 * @ci) — kept to the head-slot beat: the filed repro; the resolver's other
 * branches are behaviorally covered in tests/verify-autowield.ts.
 *
 * Screenshots + console transcript land in verification/autodequip/.
 * Usage: npx tsx tools/probe-autodequip.ts
 */

import { chromium, type Page } from 'playwright';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const OUT_DIR = join(__dir, '..', 'verification', 'autodequip');
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=autodequip';
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

  const lines: string[] = [];
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('GetAndWieldItem') || t.includes('PutItemInContainer')
      || t.includes('InventoryServerSaveFailed') || t.includes('WieldObject')
      || t.includes('InventoryPut') || t.includes('auto-dequip')) {
      lines.push(t);
      console.log(`[probe][console] ${t}`);
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

  // Make sure the Cap is WORN (rerun hygiene: a previous run leaves the
  // Helmet worn and the Cap in the pack — re-arm the conflict either way by
  // wielding whichever head item is in the pack while the other is worn).
  const state0 = await page.evaluate(`(() => {
    const ac = window.__ac;
    const worn = ac.playerState.equipment.getAll().find(e => (e.slot & 0x1) !== 0);
    return worn ? 'worn:' + worn.name : 'head-empty';
  })()`);
  console.log(`[probe] head slot: ${state0}`);
  if (state0 === 'head-empty') {
    // Wear the Cap first so the conflict exists.
    const wore = await page.evaluate(`(() => {
      const ac = window.__ac;
      const items = ac.playerState.inventory.getAll();
      const idx = items.findIndex(i => (i.validLocations || 0) & 0x1);
      if (idx < 0) return 'no-head-item-in-pack';
      ac.gameUI.dragCallbacks.onDoubleClickItem(idx);
      return 'wore:' + items[idx].name;
    })()`);
    console.log(`[probe] pre-arm: ${wore}`);
    await page.waitForTimeout(4000);
  }

  // Ensure a SECOND head item exists in the pack (Helmet, wcid 75).
  const packHead = await page.evaluate(`(() => {
    const ac = window.__ac;
    return ac.playerState.inventory.getAll().some(i => ((i.validLocations || 0) & 0x1)
      && !ac.playerState.equipment.getAll().some(e => e.id === i.id));
  })()`);
  if (!packHead) {
    await page.evaluate(`window.acDebug.sendChat('@ci 75')`);
    await page.waitForTimeout(3000);
  }

  await page.screenshot({ path: join(OUT_DIR, '01-before-conflicting-equip.png') });
  const before = await page.evaluate(`(() => {
    const ac = window.__ac;
    const worn = ac.playerState.equipment.getAll().find(e => (e.slot & 0x1) !== 0);
    return worn ? worn.name : '(none)';
  })()`);

  // THE BEAT: double-click the pack's head item while another is worn.
  const equip = await page.evaluate(`(() => {
    const ac = window.__ac;
    const items = ac.playerState.inventory.getAll();
    const wornIds = new Set(ac.playerState.equipment.getAll().map(e => e.id));
    const idx = items.findIndex(i => ((i.validLocations || 0) & 0x1) && !wornIds.has(i.id));
    if (idx < 0) return 'no-conflicting-head-item';
    ac.gameUI.dragCallbacks.onDoubleClickItem(idx);
    return 'dblclick:' + items[idx].name;
  })()`);
  console.log(`[probe] conflicting equip: ${equip} (worn before: ${before})`);
  await page.waitForTimeout(6000);
  await page.screenshot({ path: join(OUT_DIR, '02-after-auto-dequip-swap.png') });

  const after = await page.evaluate(`(() => {
    const ac = window.__ac;
    const worn = ac.playerState.equipment.getAll().find(e => (e.slot & 0x1) !== 0);
    const pack = ac.playerState.inventory.getAll()
      .filter(i => ((i.validLocations || 0) & 0x1))
      .map(i => i.name + (ac.playerState.equipment.getAll().some(e => e.id === i.id) ? '(worn)' : '(pack)'));
    return { worn: worn ? worn.name : '(none)', headItems: pack };
  })()`) as { worn: string; headItems: string[] };

  const sentDequip = lines.some(l => l.includes('auto-dequip for wield'));
  const sentWield = lines.some(l => l.includes('GetAndWieldItem (auto-wield)'));
  const saveFailed = lines.some(l => l.includes('InventoryServerSaveFailed'));
  const swapped = after.worn !== '(none)' && after.worn !== before;

  console.log('[probe] === RESULT ===');
  console.log(`[probe] worn before: ${before} → after: ${after.worn}`);
  console.log(`[probe] head items: ${after.headItems.join(', ')}`);
  console.log(`[probe] auto-dequip sent: ${sentDequip}  retried wield sent: ${sentWield}  SaveFailed: ${saveFailed}  swapped: ${swapped}`);
  writeFileSync(join(OUT_DIR, 'transcript.txt'),
    [`worn before: ${before}`, `worn after: ${after.worn}`, ...lines].join('\n'));

  await browser.close();
  process.exit(sentDequip && sentWield && !saveFailed && swapped ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
