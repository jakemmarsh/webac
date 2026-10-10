/**
 * BUG.item-shortcut-restore-runs-before-inventory — live verification.
 *
 * Drives the real ACE stack end-to-end:
 *   1. log in, grant a Dagger via @ci, send the real GameActionAddShortCut
 *      (slot 2) so ACE persists it in CharacterPropertiesShortcutBar,
 *   2. relog (page reload → ACE logs the character off and saves),
 *   3. after re-entering the world, assert the toolbar slot 2 shows the
 *      Dagger icon+title even though PlayerDescription (with the shortcut
 *      list) always arrives BEFORE the Dagger's inventory CreateObject —
 *      the exact ordering that made the pre-fix restore resolve 0 entries.
 *
 * Evidence: console line '[PlayerDesc] Item-shortcut bar: … deferred …'
 * proving the deferred path ran, the GameUI slot state, and screenshots in
 * verification/item-shortcut-restore/.
 */
import { chromium, Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = '/home/user/acjs';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=shortcut';
const OUT = join(REPO, 'verification', 'item-shortcut-restore');
const SLOT = 2;

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
        console.log(`[shortcut-live] scripted character create: ${created}`);
        createSent = true;
        lastReload = Date.now();
      }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[shortcut-live] not in world yet — reloading (phantom-session retry)');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* retry */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  throw new Error('never entered world within 360s');
}

async function findItem(page: Page, name: string): Promise<{ id: number; iconDid: number; name: string } | null> {
  return page.evaluate(`(() => {
    const it = window.__ac.playerState.inventory.getAll().find(i => i.name === ${JSON.stringify(name)});
    return it ? { id: it.id, iconDid: it.iconDid, name: it.name } : null;
  })()`) as any;
}

async function grantAndWait(page: Page, wcid: number, name: string): Promise<{ id: number; iconDid: number; name: string }> {
  const existing = await findItem(page, name);
  if (existing) return existing;
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.evaluate(`window.acDebug.sendTalk('@ci ${wcid}')`);
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(1000);
      const item = await findItem(page, name);
      if (item) return item;
    }
    console.log(`[shortcut-live] '@ci ${wcid}' → ${name} not seen yet, retrying`);
  }
  throw new Error(`@ci ${wcid} never produced '${name}' in inventory`);
}

async function slotState(page: Page, slot: number): Promise<{ iconDid: number | null; title: string | null } | null> {
  return page.evaluate(`(() => {
    const d = window.__ac.gameUI.itemShortcutData[${slot}];
    return d ? { iconDid: d.iconDid ?? null, title: d.title ?? null } : null;
  })()`) as any;
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
  const playerDescLines: string[] = [];
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('Item-shortcut bar:')) playerDescLines.push(t);
  });

  console.log(`[shortcut-live] session 1 — assign the shortcut. ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await loginLoop(page);
  await page.waitForTimeout(8000);

  const dagger = await grantAndWait(page, 314, 'Dagger');
  console.log(`[shortcut-live] dagger=0x${dagger.id.toString(16)} icon=0x${(dagger.iconDid ?? 0).toString(16)}`);

  // Real wire action: GameActionAddShortCut (Index u32 + ObjectId u32 +
  // LayeredSpell) — ACE persists it into CharacterPropertiesShortcutBar.
  await page.evaluate(`window.acDebug.addShortcut(${SLOT}, ${dagger.id})`);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: join(OUT, '01-session1-assigned.png') });

  // Relog: reload drops the connection → ACE logs the character off and
  // saves. The fresh session re-runs the login sequence, whose ordering
  // (PlayerDescription before inventory CreateObjects) is what's under test.
  const session1DescLines = [...playerDescLines];
  playerDescLines.length = 0;
  console.log('[shortcut-live] session 2 — relog and observe the restore');
  await page.waitForTimeout(3000);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await loginLoop(page);
  await page.waitForTimeout(10000);

  const daggerAfter = await findItem(page, 'Dagger');
  const slot = await slotState(page, SLOT);
  console.log('[shortcut-live] slot state after relog:', JSON.stringify(slot));
  console.log('[shortcut-live] PlayerDesc lines:', JSON.stringify(playerDescLines));
  await page.screenshot({ path: join(OUT, '02-session2-restored.png') });
  const toolbar = await page.evaluate(`(() => {
    const el = document.querySelector('.toolbar, [data-panel="toolbar"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  })()`) as any;
  if (toolbar && toolbar.width > 0) {
    await page.screenshot({ path: join(OUT, '03-toolbar-closeup.png'), clip: toolbar });
  }

  const checks = {
    daggerStillInInventory: !!daggerAfter,
    slotRestored: !!slot && slot.title === 'Dagger',
    slotHasIcon: !!slot && slot.iconDid != null && slot.iconDid > 0,
    iconMatchesItem: !!slot && !!daggerAfter && slot.iconDid === daggerAfter.iconDid,
    deferredPathRan: playerDescLines.some(l => /[1-9]\d* deferred/.test(l)),
  };
  const pass = Object.values(checks).every(Boolean);
  const verdict = {
    pass, checks, slot, dagger: daggerAfter,
    session1DescLines, session2DescLines: playerDescLines,
    when: new Date().toISOString(),
  };
  writeFileSync(join(OUT, 'verdict.json'), JSON.stringify(verdict, null, 2));
  console.log(`[shortcut-live] ${pass ? 'PASS' : 'FAIL'} — ${JSON.stringify(checks)}`);

  await browser.close();
  process.exit(pass ? 0 : 1);
}

main().catch(err => { console.error('[shortcut-live] fatal:', err); process.exit(2); });
