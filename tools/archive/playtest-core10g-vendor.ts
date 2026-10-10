/** CORE.10.g live verification — classic_vendor bar (layout 0x21000012).
 *  Teleports to the Holtburg blacksmith, opens the vendor, and exercises
 *  every retail surface: Items/Buying/Selling tabs, type-filter menu,
 *  name/cost lines, Add to List → Buy All, sell-list queue → Sell Item.
 *  Screenshots land in verification/core10g/. */
import { chromium, type Page } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=v10g';
const OUT = '/home/user/acjs/verification/core10g';

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cs = (window as any).acDebug?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

async function barShot(page: Page, name: string): Promise<void> {
  // Full frame + a crop of the 800x110 bottom-center bar.
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  const vp = page.viewportSize()!;
  await page.screenshot({
    path: join(OUT, `${name}-bar.png`),
    clip: { x: (vp.width - 800) / 2, y: vp.height - 115, width: 800, height: 115 },
  });
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: true, args: ['--enable-unsafe-swiftshader'],
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1568, height: 775 } });
  page.setDefaultTimeout(120000);
  page.on('console', m => { if (/\[AC\] (Sent|Vendor|ApproachVendor)/.test(m.text())) console.log('  >', m.text().slice(0, 160)); });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 360_000;
  while (Date.now() < deadline && !(await inWorld(page))) await page.waitForTimeout(3000);
  if (!(await inWorld(page))) throw new Error('no world');
  await page.waitForTimeout(8000);

  await page.evaluate(`window.acDebug.tele('0xA9B40100', 84, 127, 66.005)`);
  await page.waitForTimeout(9000);
  const guid = await page.evaluate(`window.acDebug.getObjects().find(o => /Blacksmith/i.test(o.name))?.guid`) as number;
  console.log('blacksmith guid:', guid && '0x' + guid.toString(16));
  await page.evaluate(`window.__ac.useObject(${guid})`);
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(1000);
    if (await page.evaluate(`window.__ac.gameUI.vendorVisible`)) break;
  }
  const open = await page.evaluate(`window.__ac.gameUI.vendorVisible`);
  if (!open) { await barShot(page, '00-no-vendor'); await browser.close(); throw new Error('vendor never opened'); }

  // ── Items tab ──
  const itemsState = await page.evaluate(`(() => {
    const ui = window.__ac.gameUI; const d = ui.vendorData;
    const listEl = ui.vendorLayoutHandle.elements.get(0x100000bd);
    const strip = listEl && listEl.children[listEl.children.length - 1];
    return { tab: d.tab, filterIdx: d.typeFilterIdx, nItems: d.buyItems.length,
      cells: strip ? strip.children.length : -1,
      filterText: !!ui.vendorLayoutHandle.elements.get(0x1000034d) };
  })()`);
  console.log('items tab:', JSON.stringify(itemsState));
  await barShot(page, '01-items-tab');

  // Select the first strip cell → name/cost lines fill.
  await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    const listEl = ui.vendorLayoutHandle.elements.get(0x100000bd);
    const strip = listEl.children[listEl.children.length - 1];
    strip.children[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
  })()`);
  await page.waitForTimeout(500);
  await barShot(page, '02-items-selected');

  // Filter popup open.
  await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    ui.vendorLayoutHandle.elements.get(0x100000bf).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  })()`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, '03-filter-popup.png') });
  await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    if (ui.vendorData.filterMenuOpen) ui.vendorLayoutHandle.elements.get(0x100000bf).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  })()`);

  // Coins, re-select, Add to List, then Buying tab.
  await page.evaluate(`window.acDebug.sendTalk('@ci 273 5000')`);
  await page.waitForTimeout(4000);
  await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    const listEl = ui.vendorLayoutHandle.elements.get(0x100000bd);
    const strip = listEl.children[listEl.children.length - 1];
    strip.children[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
  })()`);
  await page.waitForTimeout(300);
  await page.evaluate(`window.__ac.gameUI.vendorLayoutHandle.elements.get(0x100000c3).dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await page.waitForTimeout(300);
  await page.evaluate(`window.__ac.gameUI.vendorLayoutHandle.elements.get(0x100000ba).dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await page.waitForTimeout(500);
  const buyState = await page.evaluate(`(() => {
    const d = window.__ac.gameUI.vendorData;
    return { tab: d.tab, buyList: d.buyList };
  })()`);
  console.log('buying tab:', JSON.stringify(buyState));
  await barShot(page, '04-buying-tab');

  // Buy All → server round-trip → inventory delta.
  const invBefore = await page.evaluate(`window.__ac.playerState.inventory.getAll().length`);
  await page.evaluate(`window.__ac.gameUI.vendorLayoutHandle.elements.get(0x100000ca).dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await page.waitForTimeout(4000);
  const invAfter = await page.evaluate(`window.__ac.playerState.inventory.getAll().length`);
  console.log('inventory items before/after Buy All:', invBefore, invAfter);
  await barShot(page, '05-after-buy-all');

  // Queue the bought item on the sell list (drag-in path exercised in the
  // unit suite; here drive the same addVendorSellListItem entry point).
  const sellState = await page.evaluate(`(() => {
    const ui = window.__ac.gameUI; const d = ui.vendorData;
    const candidate = d.sellItems[0];
    if (!candidate) return { queued: false, n: d.sellItems.length };
    ui.addVendorSellListItem(candidate.guid, 1);
    return { queued: true, tab: d.tab, sellList: d.sellList, name: candidate.name };
  })()`);
  console.log('sell queue:', JSON.stringify(sellState));
  await page.waitForTimeout(500);
  await barShot(page, '06-selling-tab');

  if (sellState && (sellState as { queued: boolean }).queued) {
    await page.evaluate(`window.__ac.gameUI.vendorLayoutHandle.elements.get(0x100000d2).dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await page.waitForTimeout(4000);
    await barShot(page, '07-after-sell-item');
  }

  // Close button.
  await page.evaluate(`window.__ac.gameUI.vendorLayoutHandle.elements.get(0x100000d6).dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await page.waitForTimeout(300);
  const closed = await page.evaluate(`({ visible: window.__ac.gameUI.vendorVisible, guid: window.__ac.gameUI.vendorData.vendorGuid })`);
  console.log('after close:', JSON.stringify(closed));
  await page.screenshot({ path: join(OUT, '08-closed.png') });

  await browser.close();
  console.log('DONE');
}

main().catch(e => { console.error(e); process.exit(1); });
