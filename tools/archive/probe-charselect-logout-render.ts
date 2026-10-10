// PERF.charselect-after-logout-renders-world — does char select after a logout
// still draw the world? Counts WebGLRenderer.render calls and rAF/timer latency
// at pre-world char select, in world, and at +3/+15/+30 s after logout.
//   npx tsx tools/archive/probe-charselect-logout-render.ts
import { mkdirSync } from 'node:fs';
import { enterCharSelect, waitFor, IN_WORLD_JS, PRESS_CHARSEL_ENTER_JS } from '../lib/game-session.ts';

const OUT = 'verification/charselect-logout-render';
mkdirSync(OUT, { recursive: true });
const RAF = `new Promise(r => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else r(n); }; requestAnimationFrame(f); setTimeout(() => r('timeout n=' + n), 8000); })`;
const LAT = `new Promise(r => { const t0 = performance.now(); setTimeout(() => r(Math.round(performance.now() - t0)), 0); })`;
// Wrap the live renderer's render() so draws are counted over a 2 s window.
const DRAWS = `new Promise(r => { const rd = window.__ac.sceneManager.renderer; if (!('__n' in rd)) { const o = rd.render.bind(rd); rd.__n = 0; rd.render = (...a) => { rd.__n++; return o(...a); }; }
  const n0 = rd.__n; setTimeout(() => r({ draws2s: rd.__n - n0, canvas: rd.domElement.style.visibility, sceneChildren: window.__ac.sceneManager.scene.children.length }), 2000); })`;

async function sample(page: import('playwright').Page, tag: string): Promise<void> {
  const raf = await page.evaluate(RAF);
  const lat = await page.evaluate(LAT);
  const d = await page.evaluate(DRAWS);
  console.log(`${tag}: raf/2s=${raf} timerLatencyMs=${lat}`, JSON.stringify(d));
}

const { browser, page } = await enterCharSelect({ cb: 'charsel-logout-render', settleMs: 5000 });
await sample(page, 'pre-world select');
await page.evaluate(PRESS_CHARSEL_ENTER_JS);
await waitFor(page, IN_WORLD_JS, { timeoutMs: 180_000 });
await page.waitForTimeout(8000);
await sample(page, 'in world');
await page.screenshot({ path: `${OUT}/01-in-world.png` });
await page.evaluate(`window.__ac.gameUI.callbacks.onLogout()`);
await waitFor(page, `window.__ac.gameUI.ui.currentScreen === 'character-select'`, { timeoutMs: 120_000 });
for (const s of [3, 15, 30]) {
  await page.waitForTimeout(s === 3 ? 3000 : 12000);
  await sample(page, `post-logout select +${s}s`);
}
await page.screenshot({ path: `${OUT}/02-charselect-after-logout.png` });
// Re-enter: the world must draw again.
await page.evaluate(PRESS_CHARSEL_ENTER_JS);
await waitFor(page, IN_WORLD_JS, { timeoutMs: 180_000 });
await page.waitForTimeout(8000);
await sample(page, 're-entered world');
await page.screenshot({ path: `${OUT}/03-reentered-world.png` });
await browser.close();
