/**
 * probe-trade-by-use — using (double-clicking) another player opens trade,
 * retail's only way in (DetermineUseResult case 5 → AttemptToOpenTrade
 * Negotiations). Two sessions: testacjs2 (+TestPartner) brings the plain
 * character (AC_OBSERVER, default testacjs3 / Obsprobe) to it; Obsprobe
 * double-clicks TestPartner. Screenshots to verification/trade-by-use/.
 *
 * Usage: npx tsx tools/probe-trade-by-use.ts
 */
import { enterWorld, adminCommand, shot, gameUrl } from './lib/game-session.js';
const OUT = 'verification/trade-by-use';
const OBS = process.env.AC_OBSERVER ?? 'testacjs3';

async function main(): Promise<void> {
  const admin = await enterWorld({ url: gameUrl({ cb: 'tbu-admin', env: { ...process.env, AC_ACCOUNT: 'testacjs2', AC_PASSWORD: 'testacjs2' } }) } as never);
  await admin.page.waitForTimeout(3000);
  await adminCommand(admin.page, '@teleloc 0xA9B40019 [85.0 20.5 94.0] 1 0 0 0');
  await admin.page.waitForTimeout(6000);
  const guest = await enterWorld({ createCharacter: 'Obsprobe', consoleFilter: /Trade|trade|Use|approach|peace/, url: gameUrl({ cb: 'tbu-guest', env: { ...process.env, AC_ACCOUNT: OBS, AC_PASSWORD: OBS } }) } as never);
  await guest.page.waitForTimeout(3000);
  await adminCommand(admin.page, '@teletome Obsprobe');
  await guest.page.waitForTimeout(9000);
  const partner = await admin.page.evaluate('window.__ac.charGuid') as number;
  const at = await guest.page.evaluate(`window.acDebug.screenPosOf(${partner})`) as { x: number; y: number } | null;
  console.log('partner on screen at', JSON.stringify(at));
  console.log('partner object', await guest.page.evaluate(`(() => { const o = window.__ac.serverObjectManager.getObject(${partner}); return o ? JSON.stringify({ flags: o.objectDescFlags.toString(16), usable: o.usable, itemType: o.itemType }) : null; })()`));
  if (at) {
    await guest.page.mouse.dblclick(at.x, at.y);
    await guest.page.waitForTimeout(3500);
    await shot(guest.page, `${OUT}/guest-after-double-click.png`);
    await shot(admin.page, `${OUT}/partner.png`);
  }
  await guest.browser.close();
  await admin.browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
