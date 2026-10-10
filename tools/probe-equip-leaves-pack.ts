/**
 * probe-equip-leaves-pack — equipping an item takes it out of the pack grid
 * (it is on the paperdoll now); unequipping puts it back. Logs the grid's
 * item names + the equipped list before/after, screenshots to
 * verification/equip-leaves-pack/.
 *
 * Usage: AC_ACCOUNT=testacjs2 AC_PASSWORD=testacjs2 npx tsx tools/probe-equip-leaves-pack.ts
 */
import { enterWorld, shot } from './lib/game-session.js';
const OUT = 'verification/equip-leaves-pack';

const STATE = `(() => { const ui = window.__ac.gameUI; const ps = window.__ac.playerState;
  const main = ui.sidePackGuids[0];
  return JSON.stringify({
    gridMainPack: ui.inventoryItems.filter((i) => i.containerId === main).map((i) => i.name),
    gridCells: [...document.querySelectorAll('[data-inv-slot]')].map((c) => c.dataset.acTooltipText).filter(Boolean),
    equipped: ps.equipment.getAll().map((e) => e.name + '@' + e.slot.toString(16)),
    dirk: (() => { const d = ui.inventoryItems.find((i) => /rusted dirk/i.test(i.name)); return d ? { containerId: d.containerId.toString(16), wielder: (d.wielderId || 0).toString(16), loc: (d.currentWieldedLocation || 0).toString(16) } : null; })(),
  }); })()`;

async function main(): Promise<void> {
  const s = await enterWorld({ cb: 'equip-leaves', consoleFilter: /Wield|wield|equip|Equip/ } as never);
  await s.page.waitForTimeout(4000);
  await s.page.click('#tb-inv').catch(() => {});
  await s.page.waitForTimeout(2000);
  await s.page.evaluate(`window.acDebug.unwield('MeleeWeapon')`);
  await s.page.evaluate(`window.acDebug.unwield('Held')`);
  await s.page.waitForTimeout(2500);
  console.log('unwielded:', await s.page.evaluate(STATE));
  await shot(s.page, `${OUT}/1-unwielded.png`);
  await s.page.evaluate(`window.acDebug.equip('Rusted Dirk')`);
  await s.page.waitForTimeout(3000);
  console.log('equipped:', await s.page.evaluate(STATE));
  await shot(s.page, `${OUT}/2-equipped.png`);
  await s.browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
