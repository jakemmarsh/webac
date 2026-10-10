/**
 * Scorecard flow-vendor — the vendor flow driven live, for the side-by-side
 * against verification/retail-client/ab/retail-vendor-{items,buying,selling}.png
 * (same NPC, same spot: Shopkeeper Renald the Elder, Holtburg 42.1N 33.6E).
 *
 * Use the vendor (acDebug.useObject → approach + Use → VendorInfo), capture the
 * three tabs, BUY the selected merchandise with a real click on Buy
 * (0x100000c2), then SELL it back from the Selling tab's Sell All (0x100000d3).
 * Records the purse and the pack before / after each step.
 *
 *   npx tsx tools/probe-vendor-flow.ts
 *
 * Output: verification/vendor-flow/{probe.json, ours-*.png, sbs-vendor-flow.png}
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import {
  REPO, sessionArgs, enterWorld, adminCommand, shot, frameCellHtml, renderSheet, sheetHtml,
} from './lib/game-session.js';

const OUT = join(REPO, 'verification', 'vendor-flow');
const AB = join(REPO, 'verification', 'retail-client', 'ab');
const VENDOR = 'Shopkeeper Renald the Elder';
/** The A/B spot and heading (tools/archive/capture-retail-ab.ts). */
const SPOT = '0xA9B40019 84.3 1.5 94 0.9969 0 0 -0.0785';

const ev = <T>(page: Page, js: string): Promise<T> => page.evaluate(js) as Promise<T>;

async function purse(page: Page): Promise<{ coins: number; packItems: number }> {
  // Pack contents = server objects whose container is the player.
  return ev(page, `(() => { const ui = window.__ac.gameUI, som = window.__ac.serverObjectManager;
    const me = som.playerGuid ?? window.__ac.playerGuid; let n = 0;
    for (const o of som.objects.values()) if (me && o.containerId === me) n++;
    return { coins: ui.hud.coinValue, packItems: n }; })()`);
}

async function findObject(page: Page, name: string): Promise<number | null> {
  return ev(page, `(() => { for (const o of window.__ac.serverObjectManager.objects.values()) if (o.name === ${JSON.stringify(name)}) return o.guid; return null; })()`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const s = await enterWorld({ cb: 'vendor-flow', settleMs: 4000, ...sessionArgs() } as never);
  const { page } = s;
  const r: Record<string, unknown> = {};
  try {
    await adminCommand(page, `@teleloc ${SPOT}`, 'talk');
    await page.waitForTimeout(15_000);
    await adminCommand(page, '@ci 273 5000', 'talk'); // a purse to buy with, as the A/B run did
    await page.waitForTimeout(3000);
    const vendor = await findObject(page, VENDOR);
    r.vendor = vendor;
    if (!vendor) throw new Error(`${VENDOR} not found`);
    await ev(page, `window.acDebug.useObject(${vendor})`);
    const end = Date.now() + 25_000;
    while (Date.now() < end && !(await ev<boolean>(page, '!!window.__ac.gameUI.isVendorVisible'))) await page.waitForTimeout(500);
    r.opened = await ev<boolean>(page, '!!window.__ac.gameUI.isVendorVisible');
    await page.waitForTimeout(2500);
    r.merchandise = await ev(page, 'window.__ac.gameUI.vendorData.buyItems.length');
    r.before = await purse(page);
    await shot(page, join(OUT, 'ours-vendor-items.png'));

    // Buy the selected merchandise: a real click on Buy.
    const buyBtn = page.locator('[data-element-id="0x100000c2"]').first();
    r.selectedName = await ev(page, `(() => { const d = window.__ac.gameUI.vendorData; const it = d.buyItems.find((i) => i.guid === d.selectedItemsGuid); return it ? it.name : null; })()`);
    await buyBtn.click();
    await page.waitForTimeout(4000);
    r.afterBuy = await purse(page);

    for (const [tab, name] of [[1, 'buying'], [2, 'selling']] as const) {
      await ev(page, `(() => { const ui = window.__ac.gameUI; ui.vendorData.tab = ${tab}; ui.renderVendorPanel(); })()`);
      await page.waitForTimeout(1500);
      await shot(page, join(OUT, `ours-vendor-${name}.png`));
    }

    // Sell it back: the newest matching item onto the sell list, then Sell All.
    const bought = await ev<number | null>(page, `(() => { const name = ${JSON.stringify(r.selectedName)};
      let g = null; for (const o of window.__ac.serverObjectManager.objects.values()) if (o.name === name && o.containerId) g = o.guid; return g; })()`);
    r.boughtGuid = bought;
    if (bought) {
      await ev(page, `(() => { const ui = window.__ac.gameUI; ui.vendorData.sellList.push({ guid: ${bought}, qty: 1 }); ui.vendorData.tab = 2; ui.renderVendorPanel(); })()`);
      await page.waitForTimeout(1000);
      await shot(page, join(OUT, 'ours-vendor-selling-listed.png'));
      await page.locator('[data-element-id="0x100000d3"]').first().click();
      await page.waitForTimeout(4000);
      r.afterSell = await purse(page);
    }
    await ev(page, `(() => { const ui = window.__ac.gameUI; ui.vendorData.tab = 0; ui.renderVendorPanel(); })()`);

    const rows = [
      [frameCellHtml(join(AB, 'retail-vendor-items.png'), 'retail EoL — Items'), frameCellHtml(join(OUT, 'ours-vendor-items.png'), 'ours (live) — Items')],
      [frameCellHtml(join(AB, 'retail-vendor-buying.png'), 'retail EoL — Buying'), frameCellHtml(join(OUT, 'ours-vendor-buying.png'), 'ours (live, after a real Buy) — Buying')],
      [frameCellHtml(join(AB, 'retail-vendor-selling.png'), 'retail EoL — Selling'), frameCellHtml(join(OUT, 'ours-vendor-selling.png'), 'ours (live) — Selling')],
    ];
    await renderSheet(sheetHtml('flow-vendor — retail EoL | ours (live, Shopkeeper Renald the Elder)', rows), join(OUT, 'sbs-vendor-flow.png'), s.browser, { width: 1640, height: 1500 });
  } finally {
    writeFileSync(join(OUT, 'probe.json'), JSON.stringify(r, null, 2));
    console.log(JSON.stringify(r, null, 2));
    await s.browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
