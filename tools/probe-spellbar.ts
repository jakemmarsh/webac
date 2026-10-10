/**
 * probe-spellbar — the EoL spell bar (the combat window's spellcasting page)
 * at 1920x1080 in magic mode, beside reference/images/hud/reddit-shutdown.jpg.
 * Writes verification/spellbar/ours.png, a crop, and a side-by-side.
 *
 * Usage: AC_ACCOUNT=testacjs2 AC_PASSWORD=testacjs2 npx tsx tools/probe-spellbar.ts
 */
import { enterWorld, shot } from './lib/game-session.js';
const OUT = 'verification/spellbar';

async function main(): Promise<void> {
  const s = await enterWorld({ cb: 'spellbar', viewport: { width: 1920, height: 1080 } } as never);
  await s.page.waitForTimeout(4000);
  await s.page.evaluate(`window.acDebug.unwield('MeleeWeapon')`);
  await s.page.waitForTimeout(1500);
  await s.page.evaluate(`window.acDebug.equip('Practice Wand')`);
  await s.page.waitForTimeout(2500);
  await s.page.evaluate(`window.acDebug.combatMode('magic')`);
  await s.page.waitForTimeout(4000);
  const rect = await s.page.evaluate(`(() => { const w = document.querySelector('[data-combat-window]'); if (!w) return null; const r = w.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`) as { x: number; y: number; w: number; h: number } | null;
  console.log('combat window rect', JSON.stringify(rect));
  console.log('cells shown', await s.page.evaluate(`[...document.querySelectorAll('[data-spell-slot]')].filter((c) => c.style.display !== 'none' && c.getBoundingClientRect().width > 0).length`));
  await shot(s.page, `${OUT}/ours.png`);
  if (rect) await shot(s.page, `${OUT}/ours-crop.png`, { x: Math.max(0, rect.x - 5), y: Math.max(0, rect.y - 5), w: rect.w + 10, h: rect.h + 10 });
  // The combat window's other page: melee with the dirk.
  await s.page.evaluate(`window.acDebug.combatMode('peace')`);
  await s.page.waitForTimeout(2000);
  await s.page.evaluate(`window.acDebug.unwield('Held')`);
  await s.page.waitForTimeout(1500);
  await s.page.evaluate(`window.acDebug.equip('Rusted Dirk')`);
  await s.page.waitForTimeout(2500);
  await s.page.evaluate(`window.acDebug.combatMode('melee')`);
  await s.page.waitForTimeout(4000);
  const mrect = await s.page.evaluate(`(() => { const w = [...document.querySelectorAll('[data-combat-window]')].find((e) => e.style.display !== 'none'); if (!w) return null; const r = w.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`) as { x: number; y: number; w: number; h: number } | null;
  console.log('melee window rect', JSON.stringify(mrect));
  if (mrect) await shot(s.page, `${OUT}/ours-melee-crop.png`, { x: Math.max(0, mrect.x - 5), y: Math.max(0, mrect.y - 5), w: mrect.w + 10, h: mrect.h + 10 });
  await s.browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
