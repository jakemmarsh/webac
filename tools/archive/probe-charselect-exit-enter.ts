import { enterCharSelect, waitFor, waitForWorld, waitForCharSelect, createCharacterIfNeeded, AT_CHAR_SELECT_JS } from '../lib/game-session.ts';
const VISIBLE_SELECT = `(() => { const b = document.querySelector('[data-ac-press="21000004:100003a4"]'); return !!(b && b.getClientRects().length && getComputedStyle(document.getElementById('charsel-inner')).visibility !== 'hidden' && document.getElementById('charsel-inner').offsetParent !== null); })()`;
const OUT = 'verification/charselect-exit-enter';
const logs: string[] = [];
const { browser, page } = await enterCharSelect({ cb: 'charsel-exit', settleMs: 4000 });
page.on('console', (m) => { const t = m.text(); if (/\[AC\]/.test(t)) logs.push(t); });
const shot = (n: string) => page.screenshot({ path: `${OUT}/${n}.png` });
const btn = (el: number) => `[data-ac-press="21000004:${el.toString(16)}"]`;
let names: string[] = await page.$$eval('.char-slot-name', (e) => e.map((x) => x.textContent ?? ''));
console.log('characters:', names);
if (names.length === 0) {
  await page.click('#btn-create-character');
  const poll = createCharacterIfNeeded('Probe Exiter');
  for (let i = 0; i < 60 && !(await page.evaluate(AT_CHAR_SELECT_JS).catch(() => false)); i++) { await poll(page); await page.waitForTimeout(1000); }
  // a create enters the world directly in ACE; log back out if so
  await page.waitForTimeout(5000);
  names = await page.$$eval('.char-slot-name', (e) => e.map((x) => x.textContent ?? '')).catch(() => []);
  console.log('after create:', names);
}
await shot('01-charselect');
// ENTER → Entering World dialog
if (await page.$(btn(0x100003a2))) {
  await page.click(btn(0x100003a2));
  await page.waitForTimeout(150);
  const up = await page.$('#charsel-enteringworld');
  console.log('entering-world dialog up:', !!up);
  await shot('02-entering-world');
  console.log('world:', await waitForWorld(page, { timeoutMs: 180_000 }));
  await page.waitForTimeout(5000);
  // log out
  await page.evaluate(`window.__ac.gameUI.callbacks.onLogout()`);
  console.log('back at select:', await waitFor(page, `window.__ac.gameUI.ui.currentScreen === 'character-select'`, { timeoutMs: 120_000 }));
  console.log('diag:', await page.evaluate(`(() => { const i = document.getElementById('charsel-inner'); const b = document.querySelector('[data-ac-press="21000004:100003a4"]'); return JSON.stringify({ inner: !!i, mode: i && i.dataset.mode, disp: i && getComputedStyle(i.parentElement).display, rects: b && b.getClientRects().length, op: i && String(i.offsetParent && i.offsetParent.id), screen: window.__ac.gameUI.ui && window.__ac.gameUI.ui.currentScreen }); })()`));
  console.log('raf/2s:', await page.evaluate(`new Promise(r => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else r(n); }; requestAnimationFrame(f); setTimeout(() => r('timeout n=' + n), 8000); })`));
  console.log('longtask probe:', await page.evaluate(`new Promise(r => { const t0 = performance.now(); setTimeout(() => r(performance.now() - t0), 0); })`));
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${OUT}/03-after-logout.png`, timeout: 120_000 }).catch(e => console.log('shot fail', String(e).slice(0, 80)));
}
// EXIT → confirm
await page.click(btn(0x100003a4));
await page.waitForTimeout(500);
await shot('04-exit-confirm');
const text = await page.$eval('.ac-dialog-plate', (e) => e.textContent).catch(() => null);
console.log('confirm text:', text);
const btns = await page.$$('.ac-dialog-button');
await btns[1].click(); // No
await page.waitForTimeout(500);
console.log('after No — still select:', await page.evaluate(AT_CHAR_SELECT_JS), 'dialog:', !!(await page.$('.ac-dialog-plate')));
await page.click(btn(0x100003a4));
await page.waitForTimeout(400);
await (await page.$$('.ac-dialog-button'))[0].click(); // Yes
await page.waitForTimeout(100);
await shot('05-after-yes');
console.log('relaunch → select:', await waitFor(page, `!!document.querySelector('#charsel-inner[data-mode=select]') && !document.getElementById('epilogue-inner')`, { timeoutMs: 120_000 }));
await page.waitForTimeout(6000);
console.log('in world after relaunch (should be false):', await page.evaluate(`!!document.querySelector('#charsel-inner')`).then((x) => !x));
await shot('06-relaunched-select');
console.log(logs.filter((l) => /exit|LogOff|Entering|relaunch|Delete/i.test(l)).join('\n'));
await browser.close();
