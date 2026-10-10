/**
 * BUG.updateobject-own-inventory-routed-to-world — live verification.
 *
 * Drives the real ACE stack: grants a Perennial Verdalim Dye (wcid 30085,
 * foolproof) + Leather Bracers (wcid 36) via @ci, then UseWithTarget
 * dye→bracers. ACE's RecipeManager runs the dye recipe and sends
 * GameMessageUpdateObject (RecipeManager.cs:397) for the bracers — an item
 * inside our own inventory, the exact traffic the fixed routing handles.
 *
 * Asserts (vs the pre-fix defect):
 *   1. the bracers do NOT gain a phantom ServerObject registration
 *      (pre-fix: world-routed, mesh scene-added at world origin),
 *   2. the inventory keeps exactly ONE entry for the bracers guid,
 *      refreshed in place,
 *   3. the bracers move to the FIRST slot of their container (retail
 *      move-on-update, RecipeManager.cs:407-416 mimics it server-side),
 *   4. the recipe success chat line arrived ("You apply the dye." — proof
 *      the recipe ran server-side, so the UpdateObject really was on the
 *      wire) and the PERENNIAL dye was retained (eternal dyes are never
 *      consumed — a consumed-dye check is the wrong premise for wcid 30085).
 *
 * Screenshots + JSON verdict land in verification/updateobject-dye/.
 */
import { chromium, Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = '/home/user/acjs';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=updobj';
const OUT = join(REPO, 'verification', 'updateobject-dye');

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as any).acDebug;
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

async function loginLoop(page: Page): Promise<void> {
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) return;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') {
        console.log(`[updobj] scripted character create: ${created}`);
        createSent = true;
        lastReload = Date.now();
      }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[updobj] not in world yet — reloading (phantom-session retry)');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* retry */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  throw new Error('never entered world within 360s');
}

/** Find an inventory item by exact name; returns null if absent. */
async function findItem(page: Page, name: string): Promise<{ id: number; containerId: number; iconDid: number; name: string } | null> {
  return page.evaluate(`(() => {
    const it = window.__ac.playerState.inventory.getAll().find(i => i.name === ${JSON.stringify(name)});
    return it ? { id: it.id, containerId: it.containerId, iconDid: it.iconDid, name: it.name } : null;
  })()`) as any;
}

async function grantAndWait(page: Page, wcid: number, name: string): Promise<{ id: number; containerId: number; iconDid: number; name: string }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.evaluate(`window.acDebug.sendTalk('@ci ${wcid}')`);
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(1000);
      const item = await findItem(page, name);
      if (item) return item;
    }
    console.log(`[updobj] '@ci ${wcid}' → ${name} not seen yet, retrying`);
  }
  throw new Error(`@ci ${wcid} never produced '${name}' in inventory`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());

  console.log(`[updobj] logging in — ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await loginLoop(page);
  await page.waitForTimeout(8000);

  const dye = await grantAndWait(page, 30085, 'Perennial Verdalim Dye');
  const bracers = await grantAndWait(page, 36, 'Leather Bracers');
  // A filler item granted AFTER the bracers so "moved to first slot" is
  // distinguishable from "stayed last".
  await grantAndWait(page, 314, 'Dagger');
  console.log(`[updobj] dye=0x${dye.id.toString(16)} bracers=0x${bracers.id.toString(16)}`);

  // Open the inventory panel for the screenshots.
  await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    if (!ui.inventoryVisible) ui.toggleInventory();
  })()`);
  await page.waitForTimeout(1500);

  // Make the run idempotent: push the bracers AWAY from slot 0 first so
  // "moved to first slot" is meaningful on re-runs against the same character.
  await page.evaluate(`(() => {
    const inv = window.__ac.playerState.inventory;
    inv.reorderItem(${bracers.id}, inv.getAll().length - 1);
    // Direct reorderItem doesn't raise inventoryDirty, and reopening the
    // panel re-renders the LAST setInventoryData payload — push fresh data
    // so the BEFORE screenshot shows the true pre-update slot.
    const ui = window.__ac.gameUI;
    const ps = window.__ac.playerState;
    const ic = window.__ac.inventoryController;
    ui.setInventoryData(inv.getAll(), ps.equipment.getAll(), ic.currentBurden, ic.maxBurden);
    // Chat renders through the AC font canvas painter (no DOM text), so
    // capture messages at the addSystemMessage seam for the recipe proof.
    window.__updChat = [];
    const orig = ui.addSystemMessage.bind(ui);
    ui.addSystemMessage = (msg, ...rest) => { window.__updChat.push(String(msg)); return orig(msg, ...rest); };
  })()`);
  await page.waitForTimeout(1500);

  const snapshot = (label: string) => page.evaluate(`(() => {
    const inv = window.__ac.playerState.inventory;
    const som = window.__ac.serverObjectManager;
    const bracersGuid = ${bracers.id};
    const entries = inv.getAll().filter(i => i.id === bracersGuid);
    const containerOrder = inv.getByContainer(${JSON.stringify(bracers.containerId)}).map(i => i.id);
    let originMeshes = 0;
    for (const o of som.getAllObjects().values()) {
      if (o.mesh && o.worldX === 0 && o.worldZ === 0) originMeshes++;
    }
    return {
      label: '${label}',
      bracersEntries: entries.length,
      bracersName: entries[0] ? entries[0].name : null,
      bracersIndexInContainer: containerOrder.indexOf(bracersGuid),
      containerSize: containerOrder.length,
      bracersPhantomRegistered: !!som.getObject(bracersGuid),
      originMeshes,
      dyePresent: !!inv.getAll().find(i => i.id === ${dye.id}),
      chatHasApplyDye: (window.__updChat || []).some(m => m.includes('You apply the dye.')),
    };
  })()`) as any;

  const before = await snapshot('before');
  console.log('[updobj] before:', JSON.stringify(before));
  await page.screenshot({ path: join(OUT, '01-before-dye.png') });

  // Fire the recipe: UseWithTarget dye → bracers.
  await page.evaluate(`window.acDebug.useWithTarget(${dye.id}, ${bracers.id})`);
  await page.waitForTimeout(6000);

  const after = await snapshot('after');
  console.log('[updobj] after:', JSON.stringify(after));
  await page.screenshot({ path: join(OUT, '02-after-dye.png') });

  const checks = {
    recipeRan_chatConfirms: after.chatHasApplyDye === true,
    eternalDyeRetained: before.dyePresent && after.dyePresent,
    noPhantomRegistration: !after.bracersPhantomRegistered,
    noNewOriginMeshes: after.originMeshes <= before.originMeshes,
    singleEntryRefreshed: after.bracersEntries === 1,
    movedToFirstSlot: after.bracersIndexInContainer === 0,
    wasNotFirstBefore: before.bracersIndexInContainer > 0,
  };
  const pass = Object.values(checks).every(Boolean);
  const verdict = { pass, checks, before, after, when: new Date().toISOString() };
  writeFileSync(join(OUT, 'verdict.json'), JSON.stringify(verdict, null, 2));
  console.log(`[updobj] ${pass ? 'PASS' : 'FAIL'} — ${JSON.stringify(checks)}`);

  await browser.close();
  process.exit(pass ? 0 : 1);
}

main().catch(err => { console.error('[updobj] fatal:', err); process.exit(2); });
