/**
 * probe-power-bar — hold Space in the world and read the floaty power bar
 * (layout 0x21000072) mid-charge: which meter children are visible and
 * where, plus a screenshot of the bar. Retail hides the Recklessness band
 * 0x100005ee for jump (gmPowerbarUI::RecvNotice_BeginPowerbar @ 004da730).
 *
 * Usage (own account, so it never boots a teammate's character; the first
 * run auto-creates the account and a character):
 *   AC_ACCOUNT=jumpbarprobe AC_PASSWORD=jumpbarprobe npx tsx tools/probe-power-bar.ts
 */
import { mkdirSync } from 'node:fs';
import { enterWorld, elementBox, shot } from './lib/game-session.js';

const OUT = 'verification/power-bar';
mkdirSync(OUT, { recursive: true });

const READ = `(() => {
  const bar = document.getElementById('hud-power-bar');
  if (!bar) return null;
  const kids = [...bar.querySelectorAll('[data-element-id]')]
    .filter((e) => ['0x10000034', '0x2', '0x100005ee', '0x10000035'].includes(e.dataset.elementId))
    .map((e) => { const r = e.getBoundingClientRect(); return { id: e.dataset.elementId, shown: getComputedStyle(e).display !== 'none', x: Math.round(r.left), w: Math.round(r.width) }; });
  return { display: bar.style.display, kids };
})()`;

const { browser, page } = await enterWorld({ createCharacter: 'Jumpbar Probe', settleMs: 8000 });
try {
  await page.mouse.click(780, 500);
  await page.keyboard.down('Space');
  await page.waitForTimeout(700);
  console.log(JSON.stringify(await page.evaluate(READ), null, 1));
  const box = await elementBox(page, '#hud-power-bar', 20);
  console.log('screenshot:', await shot(page, `${OUT}/jump-charge.png`, box ?? undefined));
  await page.keyboard.up('Space');
} finally {
  await browser.close();
}
