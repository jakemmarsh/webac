import { enterCharSelect, waitFor } from '../lib/game-session.ts';
const OUT = 'verification/charselect-exit-enter';
const RAF = `new Promise(r => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else r(n); }; requestAnimationFrame(f); setTimeout(() => r('timeout n=' + n), 8000); })`;
const LAT = `new Promise(r => { const t0 = performance.now(); setTimeout(() => r(Math.round(performance.now() - t0)), 0); })`;
const { browser, page } = await enterCharSelect({ cb: 'charsel-exit2', settleMs: 5000 });
console.log('pre-world select: raf/2s', await page.evaluate(RAF), 'timer latency ms', await page.evaluate(LAT));
await page.evaluate(`window.__ac.gameUI.showEnteringWorldDialog()`);
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/02b-entering-world-dialog.png` });
await page.evaluate(`window.__ac.gameUI.showCharacterSelect(window.__ac.gameUI.lastCharacterSlots, window.__ac.gameUI.lastSlotCount)`);
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/01b-charselect-clean.png` });
// enter world then log out, measure again
await page.click('[data-ac-press="21000004:100003a2"]');
await waitFor(page, `(() => { const c = window.acDebug && window.acDebug.collisionState && window.acDebug.collisionState(); return !!(c && c.x > 0); })()`, { timeoutMs: 180_000 });
await page.waitForTimeout(8000);
console.log('in world: raf/2s', await page.evaluate(RAF), 'timer latency ms', await page.evaluate(LAT));
await page.evaluate(`window.__ac.gameUI.callbacks.onLogout()`);
await waitFor(page, `window.__ac.gameUI.ui.currentScreen === 'character-select'`, { timeoutMs: 120_000 });
for (const s of [3, 15, 30]) {
  await page.waitForTimeout(s === 3 ? 3000 : 12000);
  console.log(`post-logout select +${s}s: raf/2s`, await page.evaluate(RAF), 'timer latency ms', await page.evaluate(LAT),
    'renderer calls', await page.evaluate(`(() => { const r = window.acDebug && window.acDebug.renderer; return r && r.info ? r.info.render.calls : 'n/a'; })()`));
}
await browser.close();
