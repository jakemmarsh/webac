/**
 * CORE.10.f live verification — split-stack keybind + vendor splitSize seeding.
 * Boots the real ACE stack client, then:
 *  1. acDebug.testVendor() → click stack rows → probe toolbar split state.
 *  2. Bind KeyK → 0x1000002d (Split Selected Stack) → press K → probe focus.
 *  3. Best-effort real-ACE vendor via nearby shopkeeper (wire plumbing check).
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=core10f';
const OUT = join('/home/user/acjs', 'verification', 'core10f');
const VIEW = { width: 1568, height: 775 };

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

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: true, args: ['--enable-unsafe-swiftshader'],
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));

  console.log('[core10f] navigating…');
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    await driveCharacterCreate(page);
    if (Date.now() - lastReload > 60_000) {
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* retry */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) { await page.screenshot({ path: join(OUT, '00-never-entered.png') }); throw new Error('never entered world'); }
  console.log('[core10f] in world — settling 8s');
  await page.waitForTimeout(8000);

  // ── 1. testVendor + stack-row clicks ─────────────────────────────
  await page.evaluate(`window.acDebug.testVendor()`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, '01-vendor-open.png') });

  // Vendor rows render names via the AC bitmap font (no textContent), so
  // find them structurally: flex + pointer + the row borderBottom, in
  // buyItems order, and click by item name → index.
  const clickRow = async (name: string) => page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    const idx = ui.vendorData.buyItems.findIndex(i => i.name === ${JSON.stringify(name)});
    if (idx < 0) return 'no-item';
    const rows = Array.from(document.querySelectorAll('div')).filter(d =>
      d.style.cursor === 'pointer' && d.style.display === 'flex' &&
      d.style.borderBottom && d.style.borderBottom.indexOf('rgba(60') >= 0);
    if (idx >= rows.length) return 'no-row(' + rows.length + ')';
    rows[idx].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'clicked';
  })()`);

  const probe = async () => page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    return {
      split: ui.getToolbarSplitState(),
      entry: ui.targetStackEntry ? ui.targetStackEntry.value : null,
      entryShown: ui.targetStackEntryWrap ? ui.targetStackEntryWrap.style.display : null,
      label: ui.targetNameHost ? ui.targetNameHost.textContent : null,
      target: ui.hud.target ? { id: ui.hud.target.id, containerId: ui.hud.target.containerId, itemType: ui.hud.target.itemType, stackSize: ui.hud.target.stackSize } : null,
    };
  })()`) as Promise<Record<string, unknown>>;

  const potClicked = await clickRow('Healing Potion');
  await page.waitForTimeout(400);
  const potState = await probe();
  console.log('[core10f] potion row clicked=' + potClicked + ' state=' + JSON.stringify(potState));
  await page.screenshot({ path: join(OUT, '02-potion-selected-seeds-1.png') });

  const arrowClicked = await clickRow('Arrow');
  await page.waitForTimeout(400);
  const arrowState = await probe();
  console.log('[core10f] arrow row clicked=' + arrowClicked + ' state=' + JSON.stringify(arrowState));
  await page.screenshot({ path: join(OUT, '03-arrow-selected-seeds-full.png') });

  // ── 2. keybind: bind KeyK → 0x1000002d, press K, probe focus ─────
  await page.evaluate(`window.__ac.gameUI.keybindRegistry.setMapping(0x1000002d, 0, 'KeyK')`);
  // Re-select the potion stack first (arrow currently selected — full seed).
  await clickRow('Healing Potion');
  await page.waitForTimeout(300);
  await page.keyboard.press('k');
  await page.waitForTimeout(300);
  const focusState = await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    return {
      activeId: document.activeElement ? document.activeElement.id : null,
      inputFocused: ui.uiManager ? ui.uiManager.inputFocused : ui.ui.inputFocused,
      selStart: document.activeElement && document.activeElement.selectionStart,
      selEnd: document.activeElement && document.activeElement.selectionEnd,
      entry: ui.targetStackEntry.value,
    };
  })()`) as Record<string, unknown>;
  console.log('[core10f] after K press: ' + JSON.stringify(focusState));
  await page.screenshot({ path: join(OUT, '04-splitkey-focuses-entry.png') });

  // Type a replacement amount — select-all means digits replace the seed.
  await page.keyboard.type('5');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  const typed = await probe();
  console.log('[core10f] after typing 5+Enter: ' + JSON.stringify(typed));
  await page.screenshot({ path: join(OUT, '05-typed-amount-5.png') });

  // Close the test vendor.
  await page.evaluate(`window.__ac.gameUI.hideVendorWindow()`);

  // ── 3. best-effort real ACE vendor ───────────────────────────────
  try {
    await page.evaluate(`window.acDebug.admin('@telepoi holtburg')`).catch(() => null);
    await page.waitForTimeout(12000);
    const vendors = await page.evaluate(`(() => {
      const objs = window.acDebug.getObjects ? window.acDebug.getObjects() : [];
      const me = window.acDebug.collisionState();
      return objs.filter(o => o.name && /shopkeeper|provisioner|grocer|armorer|weaponsmith|barkeep/i.test(o.name))
        .map(o => ({ guid: o.guid, name: o.name, dist: o.pos ? Math.hypot(o.pos.x - me.x, o.pos.y - me.y) : 1e9 }))
        .sort((a, b) => a.dist - b.dist).slice(0, 3);
    })()`) as Array<{ guid: number; name: string; dist: number }>;
    console.log('[core10f] nearby vendors: ' + JSON.stringify(vendors));
    if (vendors.length && vendors[0].dist < 40) {
      await page.evaluate(`window.__ac.useObject(${vendors[0].guid})`).catch(() => null);
      await page.waitForTimeout(5000);
      const real = await page.evaluate(`(() => {
        const ui = window.__ac.gameUI;
        if (!ui.isVendorVisible) return { open: false };
        const stacks = ui.vendorData.buyItems.filter(i => (i.stackSize|0) >= 2).slice(0, 5)
          .map(i => ({ name: i.name, stackSize: i.stackSize, itemType: '0x' + (i.itemType>>>0).toString(16), inMask: ((i.itemType||0) & 0x0dc41cb0) !== 0 }));
        return { open: true, vendorGuid: '0x' + ui.vendorData.vendorGuid.toString(16), stackCount: stacks.length, stacks };
      })()`) as Record<string, unknown>;
      console.log('[core10f] real vendor: ' + JSON.stringify(real));
      await page.screenshot({ path: join(OUT, '06-real-vendor.png') });
    }
  } catch (e) { console.log('[core10f] real-vendor step skipped: ' + (e as Error).message); }

  console.log('[core10f] pageerrors: ' + JSON.stringify(errors.slice(0, 5)));
  await browser.close();

  // Assertions
  const pot = potState as any; const arw = arrowState as any; const foc = focusState as any; const typ = typed as any;
  const ok =
    pot.split.splitSize === 1 && pot.split.maxSplitSize === 50 && pot.entry === '1' &&
    arw.split.splitSize === 100 && arw.split.maxSplitSize === 100 &&
    foc.activeId === 'tb-stack-entry' && foc.inputFocused === true &&
    typ.split.splitSize === 5;
  console.log(ok ? '[core10f] LIVE VERIFY PASS' : '[core10f] LIVE VERIFY FAIL');
  if (!ok) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
