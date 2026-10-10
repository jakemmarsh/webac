/**
 * RECON.inventory-grid-dat-cells.c.a — sell a WORN item live: wield a dagger,
 * open Shopkeeper Renald the Elder (Holtburg, the flow-vendor A/B spot), drag
 * the dagger from its paperdoll slot onto the vendor bar with the real mouse
 * (HTML5 drag-and-drop), then click Sell All (0x100000d3). Retail lets this
 * happen (VendorSellUI::DragItemAcceptable @ 004c20c0 → IsOwnedByPlayer,
 * which counts the wielder); ACE dequips and sells it (Player_Commerce
 * TryDequipObjectWithNetworking(SellItem)).
 *
 *   npx tsx tools/probe-vendor-sell-worn.ts
 *
 * Output: verification/vendor-sell-worn/{probe.json, ours-*.png}
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { REPO, sessionArgs, enterWorld, adminCommand, shot, frameCellHtml, renderSheet, sheetHtml } from './lib/game-session.js';

const OUT = join(REPO, 'verification', 'vendor-sell-worn');
const AB = join(REPO, 'verification', 'retail-client', 'ab');
const VENDOR = 'Shopkeeper Renald the Elder';
const SPOT = '0xA9B40019 84.3 1.5 94 0.9969 0 0 -0.0785';
const DAGGER_WCID = 314;
const MELEE = 0x00100000;

const ev = <T>(page: Page, js: string): Promise<T> => page.evaluate(js) as Promise<T>;
const until = async (page: Page, js: string, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await ev<boolean>(page, js)) return true; await page.waitForTimeout(400); }
  return false;
};
const wornDagger = `(() => { const e = window.acDebug.equipped().find((x) => x.name === 'Dagger'); return e ? parseInt(e.id, 16) : 0; })()`;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const s = await enterWorld({ cb: 'vendor-sell-worn', settleMs: 4000, ...sessionArgs() } as never);
  const { page } = s;
  const r: Record<string, unknown> = {};
  try {
    await adminCommand(page, `@teleloc ${SPOT}`, 'talk');
    await page.waitForTimeout(15_000);
    if (!(await ev<number>(page, wornDagger))) {
      const empty = await ev<boolean>(page, `!window.acDebug.equipped().some((x) => (x.slot & ${MELEE}) !== 0)`);
      if (!empty) await ev(page, `window.acDebug.unwield(${MELEE})`);
      await adminCommand(page, `@ci ${DAGGER_WCID}`, 'talk');
      await until(page, `window.__ac.gameUI.inventoryItems.some((i) => i.name === 'Dagger')`, 10_000);
      await ev(page, `window.acDebug.equip('Dagger', ${MELEE})`);
    }
    r.daggerGuid = await until(page, `${wornDagger} !== 0`, 10_000) ? await ev<number>(page, wornDagger) : 0;
    if (!r.daggerGuid) throw new Error('no worn dagger');

    const vendor = await ev<number | null>(page, `(() => { for (const o of window.__ac.serverObjectManager.objects.values()) if (o.name === ${JSON.stringify(VENDOR)}) return o.guid; return null; })()`);
    if (!vendor) throw new Error(`${VENDOR} not found`);
    r.vendor = vendor;
    // The use-approach walk can stall on the first try; retail re-sends the use on a click.
    for (let i = 0; i < 3 && !r.opened; i++) {
      r.useSent = await ev(page, `window.acDebug.useObject(${vendor})`);
      r.opened = await until(page, '!!window.__ac.gameUI.isVendorVisible', 20_000);
    }
    if (!r.opened) await shot(page, join(OUT, 'ours-vendor-not-open.png'));
    await page.waitForTimeout(2500);
    // The inventory (paperdoll) open beside the bar, as a player does it.
    await ev(page, '(() => { const ui = window.__ac.gameUI; if (!ui.inventoryVisible) ui.toggleInventory(); })()');
    await page.waitForTimeout(1500);
    r.sellRowForDagger = await ev(page, `window.__ac.gameUI.vendorData.sellItems.some((i) => i.guid === ${r.daggerGuid})`);
    r.coinsBefore = await ev(page, 'window.__ac.gameUI.hud.coinValue');
    await shot(page, join(OUT, 'ours-before-drag.png'));

    // The real mouse: paperdoll slot → the vendor bar.
    const slot = page.locator(`[data-equip-slot][data-ac-sel-guid="${r.daggerGuid}"]`).first();
    const bar = page.locator('[data-dock-panel="vendor"]').first();
    await slot.dragTo(bar);
    await page.waitForTimeout(1500);
    r.sellList = await ev(page, 'window.__ac.gameUI.vendorData.sellList');
    r.listed = (r.sellList as Array<{ guid: number }>).some((e) => e.guid === r.daggerGuid);
    r.tab = await ev(page, 'window.__ac.gameUI.vendorData.tab');
    await shot(page, join(OUT, 'ours-dagger-listed.png'));

    if (r.listed) {
      await page.locator('[data-element-id="0x100000d3"]').first().click();
      await page.waitForTimeout(5000);
      r.coinsAfter = await ev(page, 'window.__ac.gameUI.hud.coinValue');
      r.stillWorn = (await ev<number>(page, wornDagger)) !== 0;
      r.inPack = await ev(page, `window.__ac.gameUI.inventoryItems.some((i) => i.id === ${r.daggerGuid})`);
      await shot(page, join(OUT, 'ours-after-sell.png'));
    }
    await ev(page, 'window.__ac.gameUI.hideVendorWindow()');
    await renderSheet(sheetHtml('Selling a worn item — retail EoL | ours (live, Shopkeeper Renald the Elder)', [
      [frameCellHtml(join(AB, 'retail-inventory-vendor.png'), 'retail EoL — vendor + inventory open, nothing listed'), frameCellHtml(join(OUT, 'ours-dagger-listed.png'), 'ours — the worn Dagger dragged from the paperdoll onto the bar: listed, sell-state badge on its slot')],
      [frameCellHtml(join(AB, 'retail-vendor-selling.png'), 'retail EoL — Selling tab'), frameCellHtml(join(OUT, 'ours-after-sell.png'), 'ours — after Sell All: weapon slot empty, 36p')],
    ]), join(OUT, 'sbs-vendor-sell-worn.png'), s.browser, { width: 1640, height: 1100 });
  } finally {
    writeFileSync(join(OUT, 'probe.json'), JSON.stringify(r, null, 2));
    console.log(JSON.stringify(r, null, 2));
    await s.browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
