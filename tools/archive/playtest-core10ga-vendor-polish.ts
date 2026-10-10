/** CORE.10.g.a live verification — vendor bar polish.
 *  Exercises: (1) 10px authored bottom overhang, (2) DAT menu-widget popup
 *  chrome (120px, 100x18 green rows), (3) retail value/purse/cost line
 *  sentences, (4) selected-cell quantity overlay (merchandise amount; sell
 *  an item back so the restocked unique has a finite amount).
 *  Screenshots land in verification/core10ga/. */
import { chromium, type Page } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=v10ga';
const OUT = '/home/user/acjs/verification/core10ga';

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cs = (window as any).acDebug?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

async function barShot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  const vp = page.viewportSize()!;
  // Visible bar = 100px (bottom 10 of the 110 authored px clip off-screen).
  await page.screenshot({
    path: join(OUT, `${name}-bar.png`),
    clip: { x: (vp.width - 800) / 2, y: vp.height - 105, width: 800, height: 105 },
  });
}

const click = (elId: number) =>
  `window.__ac.gameUI.vendorLayoutHandle.elements.get(${elId}).dispatchEvent(new MouseEvent('click', { bubbles: true }))`;
const stripClick = (listId: number, idx: number) => `(() => {
  const listEl = window.__ac.gameUI.vendorLayoutHandle.elements.get(${listId});
  const strip = listEl.children[listEl.children.length - 1];
  strip.children[${idx}].dispatchEvent(new MouseEvent('click', { bubbles: true }));
})()`;
const lineText = (elId: number) => `(() => {
  const el = window.__ac.gameUI.vendorLayoutHandle.elements.get(${elId});
  return el ? el.textContent : null;
})()`;

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
  if (!(await page.evaluate(`window.__ac.gameUI.vendorVisible`))) {
    await barShot(page, '00-no-vendor'); await browser.close(); throw new Error('vendor never opened');
  }

  // ── (1) overhang: wrapper bottom must be -10px ──
  const overhang = await page.evaluate(`window.__ac.gameUI.vendorWrapper.style.bottom`);
  console.log('wrapper bottom (expect -10px):', overhang);
  await barShot(page, '01-items-tab');

  // ── (3) cost line after selecting a shop item ──
  await page.evaluate(`window.acDebug.sendTalk('@ci 273 5000')`);
  await page.waitForTimeout(4000);
  await page.evaluate(stripClick(0x100000bd, 0));
  await page.waitForTimeout(500);
  console.log('items name line:', JSON.stringify(await page.evaluate(lineText(0x100000c0))));
  console.log('items cost line (expect "costs Np (you have Mp)"):', JSON.stringify(await page.evaluate(lineText(0x100000c1))));
  await barShot(page, '02-items-selected');

  // ── (2) filter popup chrome ──
  await page.evaluate(click(0x100000bf));
  await page.waitForTimeout(400);
  const popupState = await page.evaluate(`(() => {
    const w = window.__ac.gameUI.vendorWrapper;
    for (const c of w.children) {
      if (c.style.bottom === '86px') {
        const rows = [...c.children];
        return { width: c.style.width, maxHeight: c.style.maxHeight, rows: rows.length,
          rowW: rows[0] && rows[0].style.width, rowH: rows[0] && rows[0].style.height,
          rowHasTile: !!(rows[0] && rows[0].style.backgroundImage) };
      }
    }
    return null;
  })()`);
  console.log('popup (expect 120px/126px, rows 100x18, tile bg):', JSON.stringify(popupState));
  await page.screenshot({ path: join(OUT, '03-filter-popup.png') });
  const vp = page.viewportSize()!;
  await page.screenshot({
    path: join(OUT, '03-filter-popup-crop.png'),
    clip: { x: (vp.width - 800) / 2, y: vp.height - 250, width: 300, height: 250 },
  });
  await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    if (ui.vendorData.filterMenuOpen) ${click(0x100000bf)};
  })()`);

  // ── (3) Buying-tab lines ──
  await page.evaluate(stripClick(0x100000bd, 0));
  await page.waitForTimeout(300);
  await page.evaluate(click(0x100000c3)); // Add to List
  await page.waitForTimeout(300);
  await page.evaluate(click(0x100000ba)); // Buying tab
  await page.waitForTimeout(500);
  console.log('buy value line (expect "Buying N item(s) worth Np"):', JSON.stringify(await page.evaluate(lineText(0x100000c7))));
  console.log('buy purse line (expect "You have Np"):', JSON.stringify(await page.evaluate(lineText(0x100000c8))));
  await barShot(page, '04-buying-tab');

  // ── (4) sell an item back, then select the restocked (finite) stack ──
  await page.evaluate(click(0x100000bb)); // Selling tab
  await page.waitForTimeout(300);
  const sellable = await page.evaluate(`window.__ac.gameUI.vendorData.sellItems[0]?.guid`) as number | undefined;
  if (sellable) {
    await page.evaluate(`window.__ac.gameUI.addVendorSellListItem(${sellable}, 1)`);
    await page.waitForTimeout(300);
    console.log('sell value line (expect "Selling N item(s) worth Np"):', JSON.stringify(await page.evaluate(lineText(0x100000d0))));
    console.log('sell purse line (expect "You have Np" — never alt):', JSON.stringify(await page.evaluate(lineText(0x100000d1))));
    await barShot(page, '05-selling-tab');
    await page.evaluate(click(0x100000d2)); // Sell Item → restock round-trip
    await page.waitForTimeout(4000);
    const shop = await page.evaluate(`window.__ac.gameUI.vendorData.buyItems.map(i => ({ n: i.name, s: i.stackSize }))`) as Array<{ n: string; s: number }>;
    const finite = shop.findIndex(i => (i.s ?? -1) >= 1);
    console.log('restocked shop finite-stack index:', finite, finite >= 0 ? JSON.stringify(shop[finite]) : '(none)');
    if (finite >= 0) {
      // Select it (walking every filter category until its cell is visible)
      // and scan the selected cell for the right:3px overlay element.
      const ok = await page.evaluate(`(() => {
        const ui = window.__ac.gameUI; const d = ui.vendorData;
        const guid = d.buyItems[${finite}].guid;
        d.tab = 0;
        for (let f = 0; f < 20; f++) {
          d.typeFilterIdx = f;
          d.selectedItemsGuid = guid;
          ui.renderVendorPanel();
          const listEl = ui.vendorLayoutHandle.elements.get(0x100000bd);
          const strip = listEl.children[listEl.children.length - 1];
          for (const cell of strip.children) {
            for (const ch of cell.children) {
              if (ch.style && ch.style.right === '3px') return { filter: f, qty: ch.textContent };
            }
          }
        }
        return null;
      })()`);
      console.log('selected-cell quantity overlay (expect finite amount):', JSON.stringify(ok));
      await barShot(page, '06-qty-overlay');
    }
  }

  await browser.close();
  console.log('done');
}

main().catch(e => { console.error(e); process.exit(1); });
