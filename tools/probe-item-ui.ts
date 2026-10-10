/**
 * probe-item-ui — what an item's hover tooltip, right-click and examine look
 * like right now (inventory open, first pack item). Screenshots to
 * verification/item-ui/.
 *
 * Usage: AC_ACCOUNT=testacjs2 AC_PASSWORD=testacjs2 npx tsx tools/probe-item-ui.ts
 */
import { enterWorld, shot } from './lib/game-session.js';
const OUT = 'verification/item-ui';

async function main(): Promise<void> {
  const s = await enterWorld({ cb: 'item-ui', consoleFilter: /Identify|xamin|Appraise|0x00C8/i } as never);
  await s.page.waitForTimeout(4000);
  await s.page.click('#tb-inv').catch(() => {});
  await s.page.waitForTimeout(2500);
  const cell = await s.page.evaluate(`(() => { const el = [...document.querySelectorAll('[data-ac-tooltip-text]')].find((e) => e.closest('[id*=inv], [class*=inv]') && e.getBoundingClientRect().width > 10 && !/Drag/.test(e.dataset.acTooltipText));
    if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: el.dataset.acTooltipText }; })()`) as { x: number; y: number; text: string } | null;
  console.log('item cell', JSON.stringify(cell));
  // Fallback: the second backpack cell (an apple on +TestPartner) at the default layout.
  const at = cell ?? { x: 1326, y: 580, text: '?' };
  await s.page.mouse.move(at.x, at.y);
  await s.page.waitForTimeout(1200);
  await shot(s.page, `${OUT}/1-hover.png`);
  await s.page.mouse.click(at.x, at.y, { button: 'right' });
  await s.page.waitForTimeout(2500);
  await shot(s.page, `${OUT}/2-right-click.png`);
  console.log('selected after right-click:', await s.page.evaluate('JSON.stringify(window.__ac.gameUI.hudState.target && window.__ac.gameUI.hudState.target.name)'));
  const menu = await s.page.evaluate(`(() => { const m = [...document.querySelectorAll('div')].find((d) => /context/i.test(d.className || '') && d.offsetParent); return m ? m.innerText : null; })()`);
  console.log('context menu text:', JSON.stringify(menu));
  // Examine through the menu, as a player would find it today.
  const ex = await s.page.evaluate(`(() => { const el = [...document.querySelectorAll('div')].find((d) => d.innerText === 'Examine' && d.offsetParent); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`) as { x: number; y: number } | null;
  if (ex) { await s.page.mouse.click(ex.x, ex.y); await s.page.waitForTimeout(2500); await shot(s.page, `${OUT}/2b-examine.png`); }
  // Select the item and look for any examine route: the 'examine' action via the page API.
  await s.page.mouse.click(at.x, at.y);
  await s.page.waitForTimeout(700);
  await shot(s.page, `${OUT}/3-selected.png`);
  // The E key (ACT.ExamineSelected) on a different pack item: the wand cell.
  await s.page.mouse.click(1295, 580);
  await s.page.waitForTimeout(600);
  await s.page.keyboard.press('e');
  await s.page.waitForTimeout(2500);
  await shot(s.page, `${OUT}/4-e-key.png`);
  // Right-click an NPC in the world: select + examine (sr_Examine).
  const npc = await s.page.evaluate(`(() => { const cs = window.acDebug.collisionState(); let best = null;
    for (const o of window.__ac.serverObjectManager.objects.values()) { if (!(o.itemType & 0x10) || !o.mesh || !o.mesh.visible || o.guid === window.__ac.charGuid) continue;
      const d = Math.hypot(o.worldX - cs.x, o.worldZ - cs.z); const at = window.acDebug.screenPosOf(o.guid);
      if (at && at.x > 20 && at.x < 1200 && at.y > 60 && at.y < 640 && (!best || d < best.d)) best = { guid: o.guid, name: o.name, d, at }; }
    return best; })()`) as { guid: number; name: string; at: { x: number; y: number } } | null;
  console.log('world npc', JSON.stringify(npc));
  if (npc) {
    await s.page.mouse.move(npc.at.x, npc.at.y);
    await s.page.mouse.down({ button: 'right' });
    await s.page.mouse.up({ button: 'right' });
    await s.page.waitForTimeout(2500);
    await shot(s.page, `${OUT}/5-world-right-click.png`);
    console.log('selected after world right-click:', await s.page.evaluate('JSON.stringify(window.__ac.gameUI.hudState.target && window.__ac.gameUI.hudState.target.name)'));
  }
  await s.browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
