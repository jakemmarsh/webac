/**
 * probe-fellowship-stats — RECON.social-rows-dat-templates.a live check.
 * gmFellowshipUI::UpdateFellowStats @ 0048eb20 always formats
 * ID_Fellowship_FellowStats ("LEVEL/EXPERIENCE%"); the share stays 0 when the
 * fellowship shares no XP. Creates a real fellowship on ACE through the
 * client's own create path twice — Share Fellowship XP off, then on — opens
 * the Fellowship tab and reads + screenshots the member row each time, then
 * disbands. Row text is drawn as DAT glyphs on canvas, so the evidence is the
 * screenshots (verification/fellowship-stats/*-panel.png); the log only
 * confirms a row appeared.
 *
 * Usage: npx tsx tools/probe-fellowship-stats.ts
 */
import { mkdirSync } from 'node:fs';
import type { Page } from 'playwright';
import { enterWorld, shot } from './lib/game-session.js';

const OUT = 'verification/fellowship-stats';

const rowNames = (page: Page): Promise<string[]> => page.evaluate(`(() => {
  const p = window.__ac.gameUI.socialPanel;
  return p ? [...p.querySelectorAll('.fellow-row')].map((r) => r.dataset.fellowName) : [];
})()`) as Promise<string[]>;

async function createAndRead(page: Page, share: boolean, label: string): Promise<string[]> {
  await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    ui.optionsSettings.shareFellowshipXP = ${share};
    ui.callbacks.onCreateFellowship('Probe ${label}');
    ui.socialTab = 'fellowship';
    if (!ui.socialPanelVisible) ui.toggleSocialPanel(); else ui.renderSocialPanel();
  })()`);
  let rows: string[] = [];
  for (let t = 0; t < 15_000 && rows.length === 0; t += 500) {
    await page.waitForTimeout(500);
    rows = await rowNames(page);
  }
  await page.waitForTimeout(800);
  rows = await rowNames(page);
  const box = await page.evaluate(`(() => { const r = window.__ac.gameUI.socialPanel.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`) as { x: number; y: number; w: number; h: number };
  await shot(page, `${OUT}/${label}-panel.png`, box);
  await shot(page, `${OUT}/${label}-scene.png`);
  // The leader's Disband button (0x10000280), through the pane's own binding.
  await page.evaluate(`(() => { const b = window.__ac.gameUI.socialPanel.querySelector('[data-element-id="0x10000280"]'); if (b) b.click(); })()`);
  for (let t = 0; t < 10_000; t += 500) {
    await page.waitForTimeout(500);
    if ((await rowNames(page)).length === 0) break;
  }
  return rows;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const { browser, page } = await enterWorld({ cb: 'fellow-stats', createCharacter: 'Fellowprobe', settleMs: 4000 });
  try {
    const off = await createAndRead(page, false, 'share-off');
    console.log(`share off: ${off.length} row(s) ${JSON.stringify(off)} → ${OUT}/share-off-panel.png`);
    const on = await createAndRead(page, true, 'share-on');
    console.log(`share on : ${on.length} row(s) ${JSON.stringify(on)} → ${OUT}/share-on-panel.png`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
