/**
 * probe-confirmation-dialogs — DECOMP.confirmation-dialog-text live check.
 * Handle_Character__ConfirmationRequest @ 005640a0 picks the dialog text by
 * type: 4 (Fellowship) fills ID_Fellowship_FellowshipRequest with the
 * leader's name; 2 (AlterSkill) is the server string + " Continue?"
 * (gmGamePlayUI::RecvNotice_AlterSkill_ConfirmationRequest @ 004eba70).
 *
 * Two sessions: testacjs (admin) creates a fellowship and recruits the
 * plain character (AC_OBSERVER, default testacjs2 / Obsprobe), whose
 * dialog is captured; then the guest @ci's an Arcane Lore Gem of
 * Forgetfulness and uses it, capturing its AlterSkill dialog.
 * Both dialogs are answered No. Screenshots to verification/confirmation-dialogs/.
 *
 * Usage: npx tsx tools/probe-confirmation-dialogs.ts
 */
import { mkdirSync } from 'node:fs';
import type { Page } from 'playwright';
import { enterWorld, adminCommand, shot, gameUrl } from './lib/game-session.js';
const OUT = 'verification/confirmation-dialogs';
const OBS = process.env.AC_OBSERVER ?? 'testacjs2';
// skillgemdown<skill> (TypeOfAlteration 2 = Lower): arcane lore, which a
// char-gen character has trained. The guest @ci's it, so its account needs
// admin rights: UPDATE ace_auth.account SET accessLevel=5 WHERE accountName='testacjs2'.
const LOWER_GEMS = [22316];

/** The open confirmation dialog's text, or null when none is up. */
function dialogText(page: Page): Promise<string | null> {
  return page.evaluate(`(() => { const d = window.__ac.gameUI.confirmationDialog;
    if (!d) return null; const t = d.querySelector('.ac-dialog-text');
    return t ? (t.getAttribute('aria-label') || t.dataset.acText || t.textContent || '') : ''; })()`) as Promise<string | null>;
}

const chatLines = (page: Page): Promise<string[]> => page.evaluate(`(() => { const c = document.getElementById('chat-messages');
  return c ? [...c.children].map((e) => ((e.dataset && e.dataset.chatText) || e.textContent || '').trim()) : []; })()`) as Promise<string[]>;

async function waitDialog(page: Page, ms: number): Promise<string | null> {
  for (let t = 0; t < ms; t += 500) {
    const s = await dialogText(page);
    if (s !== null) return s;
    await page.waitForTimeout(500);
  }
  return null;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const reqs: string[] = [];
  const admin = await enterWorld({ consoleFilter: /ConfirmationRequest/, url: gameUrl({ cb: 'cfd-admin', env: { ...process.env, AC_ACCOUNT: 'testacjs', AC_PASSWORD: 'testacjs' } }) } as never);
  admin.page.on('console', (m) => { if (m.text().includes('ConfirmationRequest')) reqs.push(`admin: ${m.text()}`); });
  await admin.page.waitForTimeout(3000);
  await adminCommand(admin.page, '@teleloc 0xA9B40019 [85.0 20.5 94.0] 1 0 0 0');
  await admin.page.waitForTimeout(6000);
  const guest = await enterWorld({ createCharacter: 'Obsprobe', url: gameUrl({ cb: 'cfd-guest', env: { ...process.env, AC_ACCOUNT: OBS, AC_PASSWORD: OBS } }) } as never);
  guest.page.on('console', (m) => { if (m.text().includes('ConfirmationRequest')) reqs.push(`guest: ${m.text()}`); });
  await guest.page.waitForTimeout(3000);
  const leader = await admin.page.evaluate('window.__ac.serverObjectManager.getObject(window.__ac.charGuid)?.name ?? ""') as string;
  const guestGuid = await guest.page.evaluate('window.__ac.charGuid') as number;
  await adminCommand(admin.page, '@teletome Obsprobe');
  await guest.page.waitForTimeout(9000);

  // ── Type 4: fellowship invite ──
  // Retail ships "Ignore Fellowship Requests" ON (CharacterSettingsModel);
  // turn it off through the options checkbox's own path.
  await guest.page.evaluate(`(() => { const ui = window.__ac.gameUI; ui.optionsSettings.ignoreFellowshipRequests = false;
    ui.callbacks.onCharacterOptionToggle?.(0x02, false); })()`);
  await guest.page.waitForTimeout(1500);
  await admin.page.evaluate('window.__ac.gameUI.callbacks.onCreateFellowship("Probers")'); // the fellowship panel's Create
  await admin.page.waitForTimeout(2500);
  console.log('select guest:', await admin.page.evaluate(`window.acDebug.select(${guestGuid})`));
  await admin.page.waitForTimeout(800);
  await admin.page.evaluate('window.__ac.gameUI.callbacks.onFellowshipRecruitSelected()'); // the panel's Recruit
  const fellowText = await waitDialog(guest.page, 10_000);
  console.log(`leader=${leader} fellowship dialog: ${JSON.stringify(fellowText)}`);
  console.log('admin chat:', JSON.stringify((await chatLines(admin.page)).slice(-6)));
  console.log('guest chat:', JSON.stringify((await chatLines(guest.page)).slice(-4)));
  await shot(guest.page, `${OUT}/fellowship-invite.png`);
  await guest.page.evaluate('window.__ac.gameUI.hideConfirmationDialog()');

  // ── Type 2: skill lower (Gem of Forgetfulness) ──
  let skillText: string | null = null;
  for (const wcid of LOWER_GEMS) {
    await adminCommand(guest.page, `@ci ${wcid}`);
    await guest.page.waitForTimeout(2500);
    // "+<name> has created <Gem> (0x8000035D) in their inventory."
    const made = (await chatLines(guest.page)).reverse().find((l) => /has created .*\(0x[0-9A-F]+\)/i.test(l));
    const gem = made ? parseInt(/\((0x[0-9A-F]+)\)/i.exec(made)![1], 16) : 0;
    if (!gem) { console.log(`gem ${wcid}: not found in inventory`); continue; }
    await guest.page.evaluate(`window.__ac.useObject(${gem})`);
    skillText = await waitDialog(guest.page, 5000);
    console.log(`gem ${wcid} (0x${gem.toString(16)}): ${JSON.stringify(skillText)} | ${JSON.stringify((await chatLines(guest.page)).slice(-2))}`);
    if (skillText !== null) break;
  }
  await shot(guest.page, `${OUT}/alter-skill.png`);
  await guest.page.evaluate('window.__ac.gameUI.hideConfirmationDialog()');
  await admin.page.evaluate('window.__ac.gameUI.callbacks.onFellowshipSteps([{ kind: "quit", disband: true }])'); // the panel's Disband
  console.log(reqs.join('\n'));
  await guest.browser.close();
  await admin.browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
