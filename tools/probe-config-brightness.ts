/**
 * probe-config-brightness — "opening Config seemed to cause the dimming".
 * Records document.body's filter + the stored Screen Brightness pref before
 * the options panel opens, after it opens, and after its Config tab is
 * clicked; screenshots each to verification/config-brightness/.
 *
 * Usage: AC_ACCOUNT=testacjs2 AC_PASSWORD=testacjs2 npx tsx tools/probe-config-brightness.ts
 */
import { enterWorld, shot } from './lib/game-session.js';
const OUT = 'verification/config-brightness';
const STATE = `JSON.stringify({ filter: document.body.style.filter, pref: window.__ac.gameUI.optionsSettings.screenBrightness })`;

async function main(): Promise<void> {
  const s = await enterWorld({ cb: 'config-brightness' } as never);
  await s.page.waitForTimeout(4000);
  console.log('before      ', await s.page.evaluate(STATE));
  await shot(s.page, `${OUT}/1-before.png`);
  await s.page.evaluate('window.__ac.gameUI.toggleOptionsPanel()');
  await s.page.waitForTimeout(1500);
  console.log('options open', await s.page.evaluate(STATE));
  const clicked = await s.page.evaluate(`(() => { const t = document.querySelector('[data-options-tab="config"]'); if (!t) return false; t.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);
  await s.page.waitForTimeout(1500);
  console.log('config tab  ', clicked, await s.page.evaluate(STATE));
  await shot(s.page, `${OUT}/2-config.png`);
  await s.page.evaluate('window.__ac.gameUI.toggleOptionsPanel()');
  await s.page.waitForTimeout(1000);
  console.log('closed      ', await s.page.evaluate(STATE));
  await s.browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
