/**
 * probe-tab-chat-combat — BUG.tab-toggles-combat live check: real key
 * presses in the world. Tab focuses chat, Tab again leaves chat, combat mode
 * never changes; ` (Backquote) toggles combat.
 *
 * Usage: AC_ACCOUNT=testacjs2 AC_PASSWORD=testacjs2 npx tsx tools/probe-tab-chat-combat.ts
 */
import { enterWorld } from './lib/game-session.js';

async function main(): Promise<void> {
  const s = await enterWorld({ cb: 'tab-chat-combat' } as never);
  const { page } = s;
  await page.waitForTimeout(4000);
  const state = async (): Promise<string> => page.evaluate(`JSON.stringify({ chatFocused: document.activeElement && document.activeElement.id === 'chat-input', combat: window.__ac.gameUI.hud.combatMode })`) as Promise<string>;
  await page.mouse.click(700, 400);
  console.log('start      ', await state());
  for (let i = 1; i <= 4; i++) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(400);
    console.log(`after Tab ${i}`, await state());
  }
  await page.keyboard.press('Backquote');
  await page.waitForTimeout(1500);
  console.log('after `    ', await state());
  await page.keyboard.press('Backquote');
  await page.waitForTimeout(1500);
  console.log('after ` x2 ', await state());
  await s.browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
