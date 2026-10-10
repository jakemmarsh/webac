/**
 * BUG.weenie-targettype-discarded — live verification on the ACE stack.
 *
 * Drives one real client: logs in, spawns a healing kit (wcid 628 —
 * PropertyInt.TargetType=16=Creature in the world DB), and checks the full
 * retail chain live:
 *
 *  1. WIRE: the kit's inventory entry carries targetType=16 parsed from the
 *     real CreateObject (pre-fix the uint was read-and-discarded).
 *  2. BLOCK: arm the kit (double-click), then select an INCOMPATIBLE world
 *     object (itemType without the Creature bit) through the real
 *     selectTarget path — the client must NOT send UseWithTarget and must
 *     print the retail notice "Cannot use the %s with the %s"
 *     (ItemHolder::TargetCompatibleWithObject @ 00587520).
 *  3. SEND: re-arm, select a COMPATIBLE creature target — UseWithTarget
 *     goes out as before (no over-blocking).
 *
 * Evidence: verdict.json + screenshots in verification/targettype-gate/.
 */
import { chromium, Browser, Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = '/home/user/acjs';
const OUT = join(REPO, 'verification', 'targettype-gate');
const CREATE_NAME = 'Targettype Tester';
const KIT_WCID = 628; // healingkit
const CREATURE_BIT = 0x10; // ItemType.Creature

function url(account: string): string {
  return `http://localhost:3000/?ace&bridge=ws://localhost:9090&account=${account}&password=${account}&cb=ttgate`;
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
        console.log(`[tt-live] scripted character create: ${created}`);
        createSent = true;
        lastReload = Date.now();
      }
    }
    if (Date.now() - lastReload > 90_000) {
      console.log('[tt-live] not in world yet — reloading (phantom-session retry)');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* retry */ }
      lastReload = Date.now();
      createSent = false;
    }
    await page.waitForTimeout(3000);
  }
  throw new Error('never entered world within 360s');
}

async function waitFor(cond: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`timeout waiting for: ${what}`);
}

interface KitState { found: boolean; guid?: number; name?: string; targetType?: number; usable?: number }

async function kitInventoryState(page: Page): Promise<KitState> {
  return page.evaluate(`(() => {
    const items = window.__ac.gameUI.inventoryItems || [];
    const it = items.find((i) => i.weenieClassId === ${KIT_WCID});
    if (!it) return { found: false };
    return { found: true, guid: it.id, name: it.name, targetType: it.targetType, usable: it.usable };
  })()`) as Promise<KitState>;
}

async function armKit(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    const idx = ui.inventoryItems.findIndex((i) => i.weenieClassId === ${KIT_WCID});
    ui.dragCallbacks.onDoubleClickItem(idx);
  })()`);
}

/** Chat lines render as AC-bitmap-font canvases (no DOM text), so capture
 *  the raw text via the GameUI onChatLine sniffer callback instead. */
async function installChatTap(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    window.__ttChatLines = [];
    const prev = ui.callbacks.onChatLine;
    ui.callbacks.onChatLine = (t) => { window.__ttChatLines.push(t); if (prev) prev(t); };
  })()`);
}

async function chatTail(page: Page, lines = 10): Promise<string[]> {
  return page.evaluate(`(window.__ttChatLines || []).slice(-${lines})`) as Promise<string[]>;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser: Browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());

  const consoleLog: string[] = [];
  page.on('console', m => consoleLog.push(m.text()));

  const checks: Record<string, boolean> = {};
  const notes: Record<string, unknown> = {};

  console.log('[tt-live] logging in testacjs …');
  await page.goto(url('testacjs'), { waitUntil: 'domcontentloaded' });
  await loginLoop(page);
  console.log('[tt-live] in world.');
  await page.waitForTimeout(3000);

  // Spawn the healing kit and open the inventory.
  await page.evaluate(`window.acDebug.sendTalk('@ci ${KIT_WCID}')`);
  await waitFor(async () => (await kitInventoryState(page)).found, 30_000, 'healing kit in inventory');
  await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    if (!ui.inventoryVisible) ui.toggleInventory();
  })()`);
  await page.waitForTimeout(1500);

  // ── 1. WIRE ──
  const kit = await kitInventoryState(page);
  notes.kit = kit;
  checks['wire-targetType-creature'] = kit.targetType === CREATURE_BIT;
  console.log(`[tt-live] kit: guid=0x${(kit.guid ?? 0).toString(16)} "${kit.name}" targetType=${kit.targetType} usable=0x${(kit.usable ?? 0).toString(16)}`);

  // Pick an incompatible and a compatible world target from live objects.
  const objects = await page.evaluate('window.acDebug.listServerObjects()') as
    Array<{ guid: number; name: string; itemType: number; targetType: number }>;
  const incompatible = objects.find(o => ((o.itemType >>> 0) & CREATURE_BIT) === 0 && o.name);
  // Compatible: any non-player creature (exclude the 0x5xxxxxxx player guid
  // range so we don't select ourselves mid-gesture).
  const compatible = objects.find(o =>
    ((o.itemType >>> 0) & CREATURE_BIT) !== 0 && ((o.guid >>> 28) !== 0x5) && o.name);
  notes.incompatibleTarget = incompatible;
  notes.compatibleTarget = compatible;
  if (!incompatible || !compatible) {
    throw new Error(`could not find test targets among ${objects.length} live objects`);
  }
  console.log(`[tt-live] incompatible: "${incompatible.name}" itemType=0x${(incompatible.itemType >>> 0).toString(16)}; compatible: "${compatible.name}" itemType=0x${(compatible.itemType >>> 0).toString(16)}`);

  // ── 2. BLOCK ──
  await installChatTap(page);
  await armKit(page);
  await page.waitForTimeout(500);
  const armedChat = await chatTail(page);
  checks['arm-message'] = armedChat.some(l => l.includes(`Select a target for the ${kit.name}`));

  const sentBefore = consoleLog.filter(l => l.includes('Sent UseWithTarget')).length;
  await page.evaluate(`window.acDebug.selectServerObject(${incompatible.guid})`);
  await page.waitForTimeout(1000);
  const sentAfterBlock = consoleLog.filter(l => l.includes('Sent UseWithTarget')).length;
  const blockChat = await chatTail(page);
  notes.blockChat = blockChat;
  const expectedNotice = `Cannot use the ${kit.name} with the ${incompatible.name}`;
  checks['block-no-send'] = sentAfterBlock === sentBefore;
  checks['block-retail-notice'] = blockChat.some(l => l.includes(expectedNotice));
  checks['block-console-gate-log'] = consoleLog.some(l => l.includes('UseWithTarget blocked client-side'));
  console.log(`[tt-live] block: sends ${sentBefore}->${sentAfterBlock}; notice present=${checks['block-retail-notice']} ("${expectedNotice}")`);
  await page.screenshot({ path: join(OUT, '1-blocked-incompatible.png') });

  // ── 3. SEND ──
  await armKit(page);
  await page.waitForTimeout(500);
  await page.evaluate(`window.acDebug.selectServerObject(${compatible.guid})`);
  await page.waitForTimeout(1000);
  const sentAfterAllow = consoleLog.filter(l => l.includes('Sent UseWithTarget')).length;
  checks['compatible-sends'] = sentAfterAllow === sentAfterBlock + 1;
  console.log(`[tt-live] allow: sends ${sentAfterBlock}->${sentAfterAllow}`);
  await page.screenshot({ path: join(OUT, '2-sent-compatible.png') });

  const pass = Object.values(checks).every(Boolean);
  writeFileSync(join(OUT, 'verdict.json'), JSON.stringify({ pass, checks, notes, at: new Date().toISOString() }, null, 2));
  console.log(`[tt-live] ${Object.values(checks).filter(Boolean).length}/${Object.keys(checks).length} checks passed`);
  for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? 'PASS' : 'FAIL'} ${k}`);
  await browser.close();
  if (!pass) process.exit(1);
}

main().catch(e => { console.error('[tt-live] FATAL:', e); process.exit(1); });
