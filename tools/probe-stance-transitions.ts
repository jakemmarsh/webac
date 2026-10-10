/**
 * probe-stance-transitions — combat-mode changes play the style-change
 * transition (draw weapon / ready hands) instead of snapping: peace → melee
 * → peace → magic → peace, sampling the player's MotionManager
 * (isChangingStyle, style, stance) every 100 ms and screenshotting mid-draw.
 *
 * Usage: AC_ACCOUNT=testacjs2 AC_PASSWORD=testacjs2 npx tsx tools/probe-stance-transitions.ts
 */
import { enterWorld, shot } from './lib/game-session.js';
const OUT = 'verification/stance-transitions';

async function main(): Promise<void> {
  const s = await enterWorld({ cb: 'stance' } as never);
  await s.page.waitForTimeout(4000);
  await s.page.evaluate(`window.acDebug.unwield('Held')`);
  await s.page.waitForTimeout(1500);
  await s.page.evaluate(`window.acDebug.equip('Rusted Dirk')`);
  await s.page.waitForTimeout(3000);
  const mmExpr = `(window.__ac.animController && (window.__ac.animController.mm || window.__ac.animController.motionManager)) || window.__ac.motionManager`;
  // Sampled IN the page (setInterval, performance.now) — Playwright round
  // trips are too slow for a ~0.55 s transition.
  const sample = async (label: string, mode: string) => {
    await s.page.evaluate(`(() => { const mm = ${mmExpr}; const rec = window.__st = []; const t0 = performance.now();
      window.acDebug.combatMode('${mode}');
      const id = setInterval(() => { rec.push(Math.round(performance.now() - t0) + (mm.isChangingStyle ? 'T' : '-') + (mm.stance >>> 16).toString(16)); if (rec.length > 40) clearInterval(id); }, 50); })()`);
    await s.page.waitForTimeout(350);
    await shot(s.page, `${OUT}/${label}-mid.png`);
    await s.page.waitForTimeout(2500);
    await shot(s.page, `${OUT}/${label}-end.png`);
    const rec = await s.page.evaluate('window.__st') as string[];
    const firstIdle = rec.find((r) => r.includes('-'));
    console.log(label.padEnd(16), 'transition samples:', rec.filter((r) => r.includes('T')).length, '| first settled:', firstIdle, '| end:', rec[rec.length - 1]);
  };
  await sample('1-to-melee', 'melee');
  await sample('2-to-peace', 'peace');
  await s.page.evaluate(`window.acDebug.unwield('MeleeWeapon')`);
  await s.page.waitForTimeout(2000);
  await s.page.evaluate(`window.acDebug.equip('Practice Wand')`);
  await s.page.waitForTimeout(3000);
  await sample('3-to-magic', 'magic');
  await sample('4-to-peace', 'peace');
  await s.browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
