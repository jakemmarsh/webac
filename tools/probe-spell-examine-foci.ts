/**
 * probe-spell-examine-foci — DECOMP.spell-examine-appropriate-formula: the
 * spell examine page lists ClientMagicSystem::GetAppropriateSpellFormula's
 * components. Examines Flame Bolt I (War) without a focus, creates the War
 * focus (Foci of Strife, wcid 15271) on the admin account, examines again.
 *
 * Usage: AC_ACCOUNT=testacjs AC_PASSWORD=testacjs npx tsx tools/probe-spell-examine-foci.ts [outDir]
 */
import { mkdirSync } from 'node:fs';
import { enterWorld, adminCommand, gameUrl } from './lib/game-session.js';

const OUT = process.argv[2] ?? 'verification/spell-examine-foci';
const SPELL = 27; // Flame Bolt I

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const s = await enterWorld({ viewport: { width: 1600, height: 900 }, url: gameUrl({ cb: 'spellfoci' }) } as never);
  await s.page.waitForTimeout(2000);
  await s.page.evaluate(`(() => { const ui = window.__ac.gameUI; const orig = ui.showExaminationWindow.bind(ui);
    ui.showExaminationWindow = (a) => { window.__lastSpellExam = a.spell ? { title: a.spell.title, comps: a.spell.components.map((c) => c.name) } : null; return orig(a); }; })()`);
  const examine = async (): Promise<unknown> => {
    await s.page.evaluate(`window.__ac.gameUI.onExamineSpell(${SPELL})`);
    await s.page.waitForTimeout(500);
    return s.page.evaluate('window.__lastSpellExam');
  };
  const hasFoci = (): Promise<boolean> => s.page.evaluate(`window.__ac.gameUI.inventoryItems.some((i) => /Foci of Strife/i.test(i.name))`) as Promise<boolean>;
  console.log('focus carried:', await hasFoci(), 'examine:', JSON.stringify(await examine()));
  await s.page.screenshot({ path: `${OUT}/without-focus.png` });
  if (!(await hasFoci())) {
    await adminCommand(s.page, '@ci 15271');
    for (let i = 0; i < 20 && !(await hasFoci()); i++) await s.page.waitForTimeout(500);
  }
  console.log('focus carried:', await hasFoci(), 'examine:', JSON.stringify(await examine()));
  await s.page.screenshot({ path: `${OUT}/with-focus.png` });
  await s.browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
