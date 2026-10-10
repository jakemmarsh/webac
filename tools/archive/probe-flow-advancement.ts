// Scorecard flow-advancement live probe (2026-10-04): grant XP, raise
// Strength through the attributes footer, raise a trained skill, train an
// untrained one. Screenshots → verification/flow-advancement/.
import { enterWorld, adminCommand } from '../lib/game-session.ts';
import { mkdirSync } from 'node:fs';
const OUT = 'verification/flow-advancement';
mkdirSync(OUT, { recursive: true });
const { browser, page } = await enterWorld({ cb: 'flow-advancement', settleMs: 8000 });
const lines: string[] = [];
page.on('console', (m) => { const t = m.text(); if (/Raise|Train|level|XP|Experience/i.test(t)) lines.push(t); });
const ci = () => page.evaluate(`(() => { const c = window.__ac.gameUI.charInfo; return JSON.stringify({ level: c.level, totalXp: c.totalXp, unassignedXp: c.unassignedXp, str: c.attributes.strength, credits: c.skillCredits }); })()`);
const shot = (n: string) => page.screenshot({ path: `${OUT}/${n}.png`, timeout: 180_000 });
console.log('before:', await ci());
if ((JSON.parse(await ci() as string)).totalXp < 1000000) await adminCommand(page, "@grantxp 2000000");
await page.waitForTimeout(8000);
console.log('after grant:', await ci());
await shot('01-after-grantxp');
await page.click('#tb-char');
await page.waitForTimeout(1500);
await page.click('[data-stat-row="attr:1"]');
await page.waitForTimeout(1000);
await shot('02-strength-selected');
const raise = await page.$('[data-raise-button="0x10000246"]');
console.log('raise button state:', raise && await raise.getAttribute('data-ac-state'));
if (raise) await raise.click();
await page.waitForTimeout(3000);
console.log('after raise:', await ci());
await shot('03-strength-raised');
// skills tab
await page.mouse.click(1400, 321);
await page.waitForTimeout(1500);
const rows = await page.$$eval('[data-stat-row^="skill:"]', (e) => e.map((x) => x.getAttribute('data-stat-row')));
console.log('skill rows:', rows.length, rows.slice(0, 8).join(','));
await shot('04-skills');
const skills = await page.evaluate(`JSON.stringify(window.__ac.gameUI.charInfo.skills.map(s => [s.id, s.status, s.base]))`);
console.log('skills:', skills);
const parsed: Array<[number, string, number]> = JSON.parse(skills as string);
const trained = parsed.find((s) => s[1] === 'Trained' || s[1] === 'Specialized');
if (trained) {
  await page.click(`[data-stat-row="skill:${trained[0]}"]`);
  await page.waitForTimeout(1000);
  const b = await page.$('[data-raise-button="0x10000246"]');
  console.log('skill raise state:', b && await b.getAttribute('data-ac-state'));
  if (b) await b.click();
  await page.waitForTimeout(3000);
  console.log('after skill raise:', await page.evaluate(`JSON.stringify(window.__ac.gameUI.charInfo.skills.find(s => s.id === ${trained[0]}))`));
  await shot('05-skill-raised');
}
const untrained = parsed.find((s) => s[1] === 'Untrained');
if (untrained) {
  await page.click(`[data-stat-row="skill:${untrained[0]}"]`).catch(() => {});
  await page.waitForTimeout(1000);
  await shot('06-untrained-selected');
}
console.log(lines.slice(-15).join('\n'));
await browser.close();
