/**
 * probe-side-packs — clicking a side pack in the inventory's pack column
 * switches the grid to that pack's contents ("Contents of <pack>").
 * Reports what is under the pointer at each pack slot, clicks the first
 * side pack like a player, and screenshots before/after to
 * verification/side-packs/.
 *
 * Usage: AC_ACCOUNT=testacjs2 AC_PASSWORD=testacjs2 npx tsx tools/probe-side-packs.ts
 */
import { enterWorld, shot } from './lib/game-session.js';
const OUT = 'verification/side-packs';

async function main(): Promise<void> {
  const s = await enterWorld({ cb: 'side-packs' } as never);
  await s.page.waitForTimeout(4000);
  await s.page.click('#tb-inv').catch(() => {});
  await s.page.waitForTimeout(2500);
  await shot(s.page, `${OUT}/1-before.png`);
  const info = await s.page.evaluate(`(() => { const ui = window.__ac.gameUI;
    const strip = ui.inventoryPanelHandle && ui.inventoryPanelHandle.elements.get(0x100001ce);
    const slots = strip ? [...strip.children].filter((d) => d.style.width === '36px' && d.style.height === '36px') : [];
    return { sidePackGuids: ui.sidePackGuids.map((g) => g.toString(16)), selected: ui.selectedPackSlot,
      slots: slots.map((d) => { const r = d.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return { top: d.style.top, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), hitIsSlot: !!hit && (hit === d || d.contains(hit)), hit: hit && (hit.tagName + '.' + (hit.className || '')) }; }) }; })()`) as { slots: Array<{ top: string; x: number; y: number; hitIsSlot: boolean; hit: string }> };
  console.log(JSON.stringify(info, null, 1));
  const first = info.slots.find((sl) => sl.top === '73px');
  if (first) {
    await s.page.mouse.click(first.x, first.y);
    await s.page.waitForTimeout(1500);
    console.log('after click selected=', await s.page.evaluate('window.__ac.gameUI.selectedPackSlot'));
    await shot(s.page, `${OUT}/2-after-click.png`);
  }
  await s.browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
