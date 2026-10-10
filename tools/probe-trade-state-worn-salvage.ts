/**
 * RECON.inventory-grid-dat-cells.c.b — the trade-state overlay 0x10000438
 * (0x06001dae) off the pack grid, live: wield a Rusted Dirk, open an Ust, and
 * drag the dirk from its paperdoll slot onto the salvage list with the real
 * mouse. gmSalvageUI::_AddItem @ 004cb2d0 SetTradeState(1)s it, and
 * UIItem_Update @ 004e21d0 then shows the overlay on every UIItem showing the
 * object: the paperdoll slot and the salvage list cell.
 *
 *   npx tsx tools/probe-trade-state-worn-salvage.ts
 *
 * Output: verification/trade-state-every-uiitem/{probe.json, ours-*.png, sbs-*.png}
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { REPO, sessionArgs, enterWorld, adminCommand, shot, frameCellHtml, renderSheet, sheetHtml } from './lib/game-session.js';

const OUT = join(REPO, 'verification', 'trade-state-every-uiitem');
const SPOT = '0xA9B40019 84.3 1.5 94 0.9969 0 0 -0.0785';
const UST_WCID = 20646;
const DIRK_WCID = 23320;
const MELEE = 0x00100000;
const SALVAGE_LIST = 0x10000074;

const ev = <T>(page: Page, js: string): Promise<T> => page.evaluate(js) as Promise<T>;
const until = async (page: Page, js: string, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await ev<boolean>(page, js)) return true; await page.waitForTimeout(400); }
  return false;
};
const wornDirk = `(() => { const e = window.acDebug.equipped().find((x) => /rusted dirk/i.test(x.name)); return e ? parseInt(e.id, 16) : 0; })()`;
const ustIndex = `window.__ac.gameUI.inventoryItems.findIndex((i) => ((i.itemType || 0) & 0x20000000) !== 0)`;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const s = await enterWorld({ cb: 'trade-state-salvage', settleMs: 4000, ...sessionArgs() } as never);
  const { page } = s;
  const r: Record<string, unknown> = {};
  try {
    await adminCommand(page, `@teleloc ${SPOT}`, 'talk');
    await page.waitForTimeout(12_000);
    if (!(await ev<number>(page, wornDirk))) {
      if (await ev<boolean>(page, `window.acDebug.equipped().some((x) => (x.slot & ${MELEE}) !== 0)`)) await ev(page, `window.acDebug.unwield(${MELEE})`);
      await adminCommand(page, `@ci ${DIRK_WCID}`, 'talk');
      await until(page, `window.__ac.gameUI.inventoryItems.some((i) => /rusted dirk/i.test(i.name))`, 10_000);
      const name = await ev<string>(page, `window.__ac.gameUI.inventoryItems.find((i) => /rusted dirk/i.test(i.name)).name`);
      await ev(page, `window.acDebug.equip(${JSON.stringify(name)}, ${MELEE})`);
    }
    r.dirkGuid = await until(page, `${wornDirk} !== 0`, 10_000) ? await ev<number>(page, wornDirk) : 0;
    if (!r.dirkGuid) throw new Error('no worn dirk');
    if ((await ev<number>(page, ustIndex)) < 0) {
      await adminCommand(page, `@ci ${UST_WCID}`, 'talk');
      await until(page, `${ustIndex} >= 0`, 10_000);
    }
    await ev(page, '(() => { const ui = window.__ac.gameUI; if (!ui.inventoryVisible) ui.toggleInventory(); })()');
    await page.waitForTimeout(1500);
    // Open the Ust the way a player does: double-click its pack cell.
    const ust = await ev<number>(page, ustIndex);
    await page.locator(`[data-inv-slot="${ust}"]`).first().dblclick();
    r.salvageOpen = await until(page, '!!window.__ac.gameUI.isSalvageOpen', 8_000);
    await page.waitForTimeout(1000);
    r.overlaysBefore = await ev(page, `document.querySelectorAll('[data-slot-state="trade"]').length`);
    await shot(page, join(OUT, 'ours-before-drag.png'));

    // The real mouse: the paperdoll slot → the salvage list.
    const slot = page.locator(`[data-equip-slot][data-ac-sel-guid="${r.dirkGuid}"]`).first();
    const list = page.locator(`[data-element-id="0x${SALVAGE_LIST.toString(16)}"]`).first();
    await slot.dragTo(list);
    await page.waitForTimeout(1500);
    r.queued = await ev(page, `window.__ac.gameUI.getSalvageQueue()`);
    r.slotOverlay = await ev(page, `!!document.querySelector('[data-equip-slot][data-ac-sel-guid="${r.dirkGuid}"] > [data-slot-state="trade"]')`);
    r.salvageCellOverlay = await ev(page, `!!document.querySelector('[data-ac-salvage-cell="item"][data-guid="${r.dirkGuid}"] > [data-slot-state="trade"]')`);
    r.overlaysAfter = await ev(page, `document.querySelectorAll('[data-slot-state="trade"]').length`);
    await shot(page, join(OUT, 'ours-dirk-queued.png'));
    const box = await ev<{ x: number; y: number; w: number; h: number } | null>(page, `(() => { const el = document.querySelector('[data-equip-slot][data-ac-sel-guid="${r.dirkGuid}"]'); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`);
    if (box) await page.screenshot({ path: join(OUT, 'ours-slot-zoom.png'), clip: { x: Math.max(0, box.x - 40), y: Math.max(0, box.y - 40), width: box.w + 80, height: box.h + 80 } });

    // Drag it back out of the list: RemoveItem → SetTradeState(0) clears both.
    await ev(page, `window.__ac.gameUI.removeSalvageItem(${r.dirkGuid})`);
    await page.waitForTimeout(800);
    r.overlaysAfterRemove = await ev(page, `document.querySelectorAll('[data-slot-state="trade"]').length`);
    await shot(page, join(OUT, 'ours-after-remove.png'));
    await ev(page, 'window.__ac.gameUI.hideSalvagePanel()');
    await renderSheet(sheetHtml('Trade-state overlay off the pack grid — a worn Rusted Dirk queued for salvage (ours, live)', [
      [frameCellHtml(join(OUT, 'ours-before-drag.png'), 'before: Ust open, dirk worn, no overlay'), frameCellHtml(join(OUT, 'ours-dirk-queued.png'), 'dragged from the paperdoll onto the salvage list: 0x06001dae on the weapon slot and the list cell')],
      [frameCellHtml(join(OUT, 'ours-slot-zoom.png'), 'zoom: the weapon slot with the overlay'), frameCellHtml(join(OUT, 'ours-after-remove.png'), 'removed from the list: both overlays gone')],
    ]), join(OUT, 'sbs-trade-state-salvage.png'), s.browser, { width: 1640, height: 1100 });
  } finally {
    writeFileSync(join(OUT, 'probe.json'), JSON.stringify(r, null, 2));
    console.log(JSON.stringify(r, null, 2));
    await s.browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
