/**
 * probe-character-options — BUG.character-tab-not-retail live check.
 * Opens Options → Character, records the rendered section headers + row
 * keys/labels, screenshots the page top and the User Interface Display
 * section, flips Side By Side Vitals (screenshot of the HUD vitals both
 * ways, then restores it), and runs /lockui twice through the real chat
 * input (radar drag button hides, then returns). Leaves every setting as
 * it found it.
 *
 * Usage: AC_ACCOUNT=testacjs2 AC_PASSWORD=testacjs2 npx tsx tools/probe-character-options.ts
 */
import { enterWorld, shot } from './lib/game-session.js';
import type { Page } from 'playwright';

const OUT = 'verification/character-options';

const PAGE_STATE = `(() => {
  const p = window.__ac.gameUI.optionsPanel;
  if (!p) return null;
  return {
    headers: [...p.querySelectorAll('.options-section-header')].map((e) => e.textContent.trim()),
    rows: [...p.querySelectorAll('.option-toggle-row')].map((e) => [e.dataset.optionKey, e.dataset.optionOn, e.textContent.trim()]),
  };
})()`;

async function chatCommand(page: Page, text: string): Promise<void> {
  await page.evaluate(`(() => { const i = document.getElementById('chat-input'); i.focus(); i.value = ${JSON.stringify(text)}; })()`);
  await page.focus('#chat-input');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
}

const dragShown = (page: Page): Promise<boolean> =>
  page.evaluate(`(() => { const d = document.getElementById('radar-drag-button'); return !!d && d.style.display !== 'none'; })()`) as Promise<boolean>;

async function main(): Promise<void> {
  const s = await enterWorld({ cb: 'character-options' } as never);
  const { page } = s;
  await page.waitForTimeout(4000);
  await page.evaluate('window.__ac.gameUI.toggleOptionsPanel()');
  await page.waitForTimeout(800);
  const clicked = await page.evaluate(`(() => { const t = document.querySelector('[data-options-tab="character"]'); if (!t) return false; t.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);
  await page.waitForTimeout(1200);
  const state = await page.evaluate(PAGE_STATE) as { headers: string[]; rows: string[][] } | null;
  console.log('character tab clicked', clicked);
  console.log('headers', JSON.stringify(state?.headers));
  for (const r of state?.rows ?? []) console.log('  row', r.join(' | '));
  await shot(page, `${OUT}/1-character-top.png`);
  // Scroll the Side By Side Vitals row into view.
  await page.evaluate(`document.querySelector('.option-toggle-row[data-option-key="sideBySideVitals"]').scrollIntoView({ block: 'center' })`);
  await page.waitForTimeout(400);
  await shot(page, `${OUT}/2-ui-display-section.png`);

  const before = await page.evaluate('!!window.__ac.gameUI.optionsSettings.sideBySideVitals');
  await page.evaluate(`document.querySelector('.option-toggle-row[data-option-key="sideBySideVitals"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await page.waitForTimeout(1200);
  const after = await page.evaluate('!!window.__ac.gameUI.optionsSettings.sideBySideVitals');
  console.log('sideBySideVitals', before, '->', after);
  await page.evaluate('window.__ac.gameUI.toggleOptionsPanel()');
  await page.waitForTimeout(800);
  await shot(page, `${OUT}/3-vitals-${after ? 'side-by-side' : 'stacked'}.png`);
  // Restore.
  await page.evaluate('window.__ac.gameUI.toggleOptionsPanel()');
  await page.waitForTimeout(800);
  await page.evaluate(`document.querySelector('.option-toggle-row[data-option-key="sideBySideVitals"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await page.waitForTimeout(1000);
  await page.evaluate('window.__ac.gameUI.toggleOptionsPanel()');
  await page.waitForTimeout(800);
  console.log('sideBySideVitals restored', await page.evaluate('!!window.__ac.gameUI.optionsSettings.sideBySideVitals'));
  await shot(page, `${OUT}/4-vitals-restored.png`);

  console.log('lockUI start', await page.evaluate('!!window.__ac.gameUI.optionsSettings.lockUI'), 'drag shown', await dragShown(page));
  await chatCommand(page, '/lockui');
  console.log('after /lockui', await page.evaluate('!!window.__ac.gameUI.optionsSettings.lockUI'), 'drag shown', await dragShown(page));
  await shot(page, `${OUT}/5-locked.png`);
  await chatCommand(page, '/lockui');
  console.log('after 2nd /lockui', await page.evaluate('!!window.__ac.gameUI.optionsSettings.lockUI'), 'drag shown', await dragShown(page));
  await chatCommand(page, '/lockui now');
  console.log('usage line shown', await page.evaluate(`document.body.innerText.includes('Please use @help lockui for proper usage.')`));
  await s.browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
