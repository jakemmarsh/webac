/**
 * probe-skill-list-select — BUG.skill-select-scrolls-to-top +
 * BUG.untrained-skill-footer-plus live check. Opens the Skills page,
 * scrolls the list to the bottom, clicks the last row and records the list
 * scrollTop before/after plus the footer title text; screenshots to
 * verification/skill-list-select/.
 *
 * Usage: AC_ACCOUNT=testacjs2 AC_PASSWORD=testacjs2 npx tsx tools/probe-skill-list-select.ts
 */
import { enterWorld, shot } from './lib/game-session.js';
const OUT = 'verification/skill-list-select';
const LIST = `document.querySelector('[data-stat-row^="skill:"]').parentElement`;

async function main(): Promise<void> {
  const s = await enterWorld({ cb: 'skill-list-select' } as never);
  const { page } = s;
  await page.waitForTimeout(4000);
  await page.evaluate(`(() => { const ui = window.__ac.gameUI; ui.charPanelTab = 'skills'; if (!ui.charPanelVisible) ui.toggleCharPanel(); else ui.renderCharPanel(); })()`);
  await page.waitForTimeout(1200);
  // The scroll viewport is the nearest scrollable ancestor of the rows.
  const VIEWPORT = `(() => { let el = ${LIST}; while (el && el.scrollHeight <= el.clientHeight) el = el.parentElement; return el; })()`;
  const before = await page.evaluate(`(() => { const v = ${VIEWPORT}; v.scrollTop = v.scrollHeight; v.dispatchEvent(new Event('scroll')); return [v.scrollTop, v.scrollHeight, v.clientHeight]; })()`);
  await page.waitForTimeout(400);
  await shot(page, `${OUT}/1-scrolled-bottom.png`);
  const clicked = await page.evaluate(`(() => { const rows = [...document.querySelectorAll('[data-stat-row^="skill:"]')]; const r = rows[rows.length - 1]; r.dispatchEvent(new MouseEvent('click', { bubbles: true })); return r.getAttribute('data-stat-row'); })()`);
  await page.waitForTimeout(800);
  const after = await page.evaluate(`(() => { const v = ${VIEWPORT}; return v ? v.scrollTop : -1; })()`);
  const footer = await page.evaluate(`(() => { const ui = window.__ac.gameUI; const sk = ui.charInfo.skills.find((x) => x.id === ui.selectedSkillId); return { skill: sk && [sk.name, sk.status, sk.base, sk.effective], model: ui.statFooterModel('skills') && { title: ui.statFooterModel('skills').title, value: ui.statFooterModel('skills').value, runs: ui.statFooterModel('skills').titleRuns } }; })()`);
  console.log('viewport before click [scrollTop, scrollHeight, clientHeight]', JSON.stringify(before));
  console.log('clicked', clicked, 'scrollTop after click', after);
  console.log('footer', JSON.stringify(footer));
  await shot(page, `${OUT}/2-after-click.png`);
  await s.browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
