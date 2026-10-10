/**
 * VISUAL.combat-bar-checkbox-tooltips — live probe: melee combat mode, a REAL
 * mouse hover (Playwright page.mouse, so UIElementManager's CheckTooltip path
 * runs) over each combat-bar checkbox; screenshots the tooltip + records its DOM.
 */
import { writeFileSync } from 'node:fs';
import { enterWorld, shot, sessionArgs, REPO } from '../lib/game-session.js';

const OUT = `${REPO}/verification/combat-bar-checkbox-tooltips`;
const { browser, page } = await enterWorld({ ...sessionArgs(), createCharacter: 'Perf Tester', settleMs: 8000 });
try {
  await page.evaluate('window.acDebug.combatMode("melee")');
  await page.waitForTimeout(2500);
  const results: unknown[] = [];
  for (const key of ['repeatAttacks', 'autoTarget', 'keepCombatTargetsInView']) {
    const r = await page.evaluate(`(() => { const el = document.querySelector('[data-option-key="${key}"]'); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`) as { x: number; y: number; w: number; h: number } | null;
    if (!r) { results.push({ key, error: 'checkbox missing' }); continue; }
    await page.mouse.move(r.x + r.w / 2 - 25, r.y + r.h / 2);
    await page.mouse.move(r.x + r.w / 2, r.y + r.h / 2, { steps: 3 });
    await page.waitForTimeout(1200);
    const tip = await page.evaluate(`Array.from(document.querySelectorAll('[data-ac-tooltip-for]')).filter(e => e.getBoundingClientRect().width > 0).map(e => ({ text: e.dataset.acText, root: e.dataset.acTooltipRoot, box: (b => [b.left, b.top, b.width, b.height].map(Math.round))(e.getBoundingClientRect()) }))`);
    const file = await shot(page, `${OUT}/ours-${key}-hover.png`, { x: Math.max(0, r.x - 40), y: Math.max(0, r.y - 60), w: 520, h: 180 });
    await shot(page, `${OUT}/ours-${key}-hover-full.png`);
    results.push({ key, checkbox: r, tooltipNodes: tip, file });
    await page.mouse.move(700, 150);
    await page.waitForTimeout(600);
  }
  writeFileSync(`${OUT}/live-state.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
