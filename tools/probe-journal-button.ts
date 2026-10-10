/**
 * probe-journal-button — BUG.journal-button-opens-map live check: a real
 * click on the toolbar journal button (0x1000055a, panel id 25 =
 * QuestManagement_UIPanelID) opens the contracts panel, not the map, and the
 * button lights (state 6) while it is open. Screenshot to
 * verification/journal-button/.
 *
 * Usage: AC_ACCOUNT=fxprobe3 AC_PASSWORD=fxprobe3 npx tsx tools/probe-journal-button.ts
 */
import { enterWorld, shot } from './lib/game-session.js';
const OUT = 'verification/journal-button';
const STATE = `JSON.stringify({ contracts: window.__ac.gameUI.contractVisible, map: window.__ac.gameUI.mapPanelVisible, btnState: document.getElementById('tb-journal').dataset.acState })`;

async function main(): Promise<void> {
  const s = await enterWorld({ cb: 'journal-button' } as never);
  await s.page.waitForTimeout(4000);
  console.log('before', await s.page.evaluate(STATE));
  await s.page.click('#tb-journal');
  await s.page.waitForTimeout(1200);
  console.log('after click', await s.page.evaluate(STATE));
  await shot(s.page, `${OUT}/journal-open.png`);
  await s.page.click('#tb-journal');
  await s.page.waitForTimeout(800);
  console.log('after 2nd click', await s.page.evaluate(STATE));
  await s.browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
