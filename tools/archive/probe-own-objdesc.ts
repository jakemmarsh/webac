/**
 * probe-own-objdesc — live verification for BUG.own-objdescevent-dropped.
 *
 * Logs into the ACE stack headlessly (same driver as measure-perf.ts) and
 * drives three real appearance-changing actions, asserting each lands as an
 * own ObjDescEvent on the player model (console line
 * `[AC] Own appearance updated: ...` from applyPlayerAppearance):
 *
 *   1. DEQUIP the starter Cap via the real paperdoll double-click path
 *      (onUnequipToInventory) — ACE Creature_Equipment.cs:438 broadcasts
 *      ObjDescEvent (sendSelf:true) on dequip.
 *   2. EQUIP a spawned Helmet (@ci 75) into the now-empty head slot via the
 *      real inventory double-click path (onDoubleClickItem →
 *      GetAndWieldItem) — Creature_Equipment.cs:365.
 *      NOTE: dequip-first kept for determinism of the beat ordering; since
 *      BUG.equip-no-auto-dequip-conflicting was fixed the client would now
 *      auto-dequip the Cap itself (see tools/probe-autodequip.ts).
 *   3. Toggle ShowYourHelmOrHeadGear (CharacterOption 0x2F) off —
 *      GameActionSetSingleCharacterOption.cs:31.
 *
 * Screenshots under verification/own-objdesc/ document each beat.
 *
 * Usage: npx tsx tools/probe-own-objdesc.ts
 * Requires: vite dev server (:3000), ws-tcp-bridge (:9090), ACE stack,
 * admin-enabled testacjs account.
 */

import { chromium, type Page } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const OUT_DIR = join(__dir, '..', 'verification', 'own-objdesc');
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=ownobjdesc';
const VIEW = { width: 1280, height: 800 };

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as unknown as { acDebug?: { collisionState?: () => { x: number } } }).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

async function driveCharacterCreate(page: Page): Promise<string> {
  // Source string, not a function — tsx injects __name into named fns
  // inside evaluate() callbacks (see measure-perf.ts).
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
    if (t.includes('Own appearance updated') || t.includes('GetAndWieldItem')
      || t.includes('InventoryServerSaveFailed') || t.includes('SetSingleCharacterOption')) {
      lines.push(t);
      console.log(`[probe][console] ${t}`);
    }
  });
  const updates = () => lines.filter(l => l.includes('Own appearance updated')).length;

  console.log(`[probe] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  // Phantom-session retry loop (see measure-perf.ts).
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
      try { await page.goto(URL, { waitUntil: 'domcontentloaded' }); } catch { /* retry next window */ }
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

  // Teleport outdoors so the third-person camera actually shows the player
  // model (the fresh-character spawn is a dungeon corridor with the camera
  // against a wall).
  await page.evaluate(`window.acDebug.sendChat('@telepoi Holtburg')`);
  console.log('[probe] @telepoi Holtburg — waiting 20s for teleport + terrain');
  await page.waitForTimeout(20000);

  // Ensure a Helmet exists in the pack (idempotent across reruns).
  const hasHelmet = await page.evaluate(
    `window.__ac.playerState.inventory.getAll().some(i => i.name === 'Helmet')`,
  );
  if (!hasHelmet) {
    await page.evaluate(`window.acDebug.sendChat('@ci 75')`);
    await page.waitForTimeout(3000);
  }

  await page.screenshot({ path: join(OUT_DIR, '01-login-cap-worn.png') });
  const n0 = updates();

  // Beat 1: dequip the worn head item (Cap) — real paperdoll dblclick path.
  const dequip = await page.evaluate(`(() => {
    const ac = window.__ac;
    const head = ac.playerState.equipment.getAll().find(e => (e.slot & 0x1) !== 0);
    if (!head) return 'no-headwear-equipped';
    ac.gameUI.dragCallbacks.onUnequipToInventory(head.slot);
    return 'dequipped:' + head.name;
  })()`);
  console.log(`[probe] beat 1 (dequip): ${dequip}`);
  await page.waitForTimeout(4000);
  await page.screenshot({ path: join(OUT_DIR, '02-cap-dequipped.png') });
  const n1 = updates();

  // Beat 2: equip Helmet into the now-empty head slot — real dblclick path.
  const equip = await page.evaluate(`(() => {
    const ac = window.__ac;
    const items = ac.playerState.inventory.getAll();
    const idx = items.findIndex(i => i.name === 'Helmet');
    if (idx < 0) return 'no-helmet';
    ac.gameUI.dragCallbacks.onDoubleClickItem(idx);
    return 'equip-sent:' + items[idx].name;
  })()`);
  console.log(`[probe] beat 2 (equip): ${equip}`);
  await page.waitForTimeout(4000);
  await page.screenshot({ path: join(OUT_DIR, '03-helmet-equipped.png') });
  const n2 = updates();

  // Beat 3: ShowYourHelmOrHeadGear off (CharacterOption 0x2F,
  // ACE.Entity/Enum/CharacterOption.cs:157).
  await page.evaluate(`window.acDebug.setCharacterOption(0x2f, false)`);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: join(OUT_DIR, '04-helm-hidden.png') });
  const n3 = updates();
  // Restore for future runs.
  await page.evaluate(`window.acDebug.setCharacterOption(0x2f, true)`);
  await page.waitForTimeout(2000);

  console.log('[probe] === RESULT ===');
  console.log(`[probe] dequip updates: ${n1 - n0} (expect >= 1)`);
  console.log(`[probe] equip updates:  ${n2 - n1} (expect >= 1)`);
  console.log(`[probe] toggle updates: ${n3 - n2} (expect >= 1)`);
  for (const l of lines) console.log(`[probe] LOG: ${l}`);

  await browser.close();
  process.exit(n1 - n0 >= 1 && n2 - n1 >= 1 && n3 - n2 >= 1 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
