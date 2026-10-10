// RECON.charselect-dat-controls.b — live: one click on a character row only
// selects; a double-click (real mouse, OS click count 2) raises Entering World
// and logs that character in (0x100003a5 message 0x1a → EnterGame @ 004ed440).
import { mkdirSync } from 'node:fs';
import { enterCharSelect, waitFor, waitForWorld } from '../lib/game-session.ts';
const OUT = 'verification/charselect-row-dblclick';
mkdirSync(OUT, { recursive: true });
const logs: string[] = [];
const { browser, page } = await enterCharSelect({ cb: 'charsel-dbl', settleMs: 4000 });
page.on('console', (m) => { const t = m.text(); if (/LogOnCharacter|Entering|EnterWorld|enter/i.test(t)) logs.push(t); });
const shot = (n: string) => page.screenshot({ path: `${OUT}/${n}.png` });
const names: string[] = await page.$$eval('.char-slot-name', (e) => e.map((x) => x.textContent ?? ''));
console.log('characters:', names);
if (names.length === 0) { console.log('NO CHARACTERS — cannot probe'); await browser.close(); process.exit(2); }
const target = names[names.length - 1];
const rowBox = async () => (await page.$$('.char-slot'))[names.length - 1].boundingBox();
await shot('01-charselect');
// One click: selection only.
let b = (await rowBox())!;
await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
await page.waitForTimeout(1500);
const afterSingle = await page.evaluate(`({ dialog: !!document.getElementById('charsel-enteringworld'), sel: document.querySelector('.char-slot[data-state]') && [...document.querySelectorAll('.char-slot')].map(e => e.dataset.state) })`);
console.log('after single click:', JSON.stringify(afterSingle));
await shot('02-single-click-selected');
// Double-click: Entering World, then the world.
b = (await rowBox())!;
await page.mouse.dblclick(b.x + b.width / 2, b.y + b.height / 2);
await page.waitForTimeout(120);
const up = await page.evaluate(`!!document.getElementById('charsel-enteringworld')`);
console.log('entering-world dialog up after double-click:', up);
await shot('03-double-click-entering-world');
const world = await waitForWorld(page, { timeoutMs: 180_000 });
console.log('in world:', world);
const who = await page.evaluate(`(() => { try { return window.__ac.gameUI.selectScreen.selectedCharacter.name; } catch { return null; } })()`);
console.log('entered as:', who, 'expected:', target);
await page.waitForTimeout(4000);
await shot('04-in-world');
await page.evaluate(`window.__ac.gameUI.callbacks.onLogout()`);
console.log('back at select:', await waitFor(page, `window.__ac.gameUI.ui.currentScreen === 'character-select'`, { timeoutMs: 120_000 }));
console.log(logs.slice(0, 10).join('\n'));
await browser.close();
