/**
 * probe-allegiance-login — DECOMP.allegiance-login-lines live check.
 * gmAllegianceUI::RecvNotice_AllegianceLogin @ 00492220: a guid found in the
 * allegiance data prints "<name> is logged in." / "<name> has logged out."
 * (type 0); anything else prints nothing.
 *
 * Two sessions: testacjs (admin, the patron) and the plain character
 * (AC_OBSERVER, default testacjs2 / Obsprobe). The patron turns on
 * "Show Allegiance Logons" (CharacterOption 0x18, off in ACE's defaults,
 * which gates ACE HandleAllegianceOnLogin/Logout), the guest swears to the
 * patron and the patron answers Yes. The guest then logs out and back in,
 * and the patron's chat is read after each. Finally the guest breaks
 * allegiance. Screenshots to verification/allegiance-login/.
 *
 * Usage: npx tsx tools/probe-allegiance-login.ts
 */
import { mkdirSync } from 'node:fs';
import type { Page } from 'playwright';
import { enterWorld, adminCommand, shot, gameUrl } from './lib/game-session.js';
const OUT = 'verification/allegiance-login';
const OBS = process.env.AC_OBSERVER ?? 'testacjs2';
const GUEST_NAME = 'Obsprobe';

const chatLines = (page: Page): Promise<{ text: string; cls: string }[]> => page.evaluate(`(() => { const c = document.getElementById('chat-messages');
  return c ? [...c.children].map((e) => ({ text: ((e.dataset && e.dataset.chatText) || e.textContent || '').trim(), cls: e.className + ' ' + (e.dataset.chatType || '') })) : []; })()`) as Promise<{ text: string; cls: string }[]>;

const guestUrl = (cb: string): string => gameUrl({ cb, env: { ...process.env, AC_ACCOUNT: OBS, AC_PASSWORD: OBS } });

async function waitLine(page: Page, re: RegExp, ms: number): Promise<{ text: string; cls: string } | null> {
  for (let t = 0; t < ms; t += 500) {
    const hit = (await chatLines(page)).find((l) => re.test(l.text));
    if (hit) return hit;
    await page.waitForTimeout(500);
  }
  return null;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const admin = await enterWorld({ consoleFilter: /Allegiance/, url: gameUrl({ cb: 'alg-admin', env: { ...process.env, AC_ACCOUNT: 'testacjs', AC_PASSWORD: 'testacjs' } }) } as never);
  await admin.page.waitForTimeout(3000);
  await adminCommand(admin.page, '@teleloc 0xA9B40019 [85.0 20.5 94.0] 1 0 0 0');
  await admin.page.waitForTimeout(6000);
  // DisplayAllegianceLogonNotifications_PlayerOption (0x18) through the options checkbox's own path.
  await admin.page.evaluate('window.__ac.gameUI.callbacks.onCharacterOptionToggle?.(0x18, true)');
  const patronGuid = await admin.page.evaluate('window.__ac.charGuid') as number;

  let guest = await enterWorld({ createCharacter: GUEST_NAME, consoleFilter: /Allegiance/, url: guestUrl('alg-guest') } as never);
  await guest.page.waitForTimeout(3000);
  const guestGuid = await guest.page.evaluate('window.__ac.charGuid') as number;
  await adminCommand(admin.page, `@teletome ${GUEST_NAME}`);
  await guest.page.waitForTimeout(9000);

  // Guest swears to the patron; the patron answers the type-1 dialog Yes.
  console.log('guest select patron:', await guest.page.evaluate(`window.acDebug.select(${patronGuid})`));
  await guest.page.waitForTimeout(800);
  await guest.page.evaluate(`window.__ac.gameUI.callbacks.onAllegianceSwear(${patronGuid})`); // the panel's Swear (no retail chat command)
  for (let t = 0; t < 10_000 && !(await admin.page.evaluate('!!document.querySelector(".ac-dialog-button")')); t += 500) await admin.page.waitForTimeout(500);
  await admin.page.locator('.ac-dialog-button').first().click();
  await admin.page.waitForTimeout(5000);
  const members = await admin.page.evaluate(`(() => { const i = window.__ac.gameUI.allegianceInfo; return i ? i.members.map((m) => m.name + ':0x' + (m.guid >>> 0).toString(16)) : null; })()`);
  console.log('patron allegiance members:', JSON.stringify(members), 'guest guid 0x' + (guestGuid >>> 0).toString(16));

  // Logout → "Obsprobe has logged out."
  await guest.browser.close();
  const out = await waitLine(admin.page, new RegExp(`^${GUEST_NAME} has logged out\\.$`), 30_000);
  console.log('logout line:', JSON.stringify(out));
  await shot(admin.page, `${OUT}/logged-out.png`);

  // Login → "Obsprobe is logged in."
  await admin.page.waitForTimeout(8000);
  guest = await enterWorld({ url: guestUrl('alg-guest2') } as never);
  const inn = await waitLine(admin.page, new RegExp(`^${GUEST_NAME} is logged in\\.$`), 30_000);
  console.log('login line:', JSON.stringify(inn));
  await shot(admin.page, `${OUT}/logged-in.png`);
  console.log('patron chat tail:', JSON.stringify((await chatLines(admin.page)).slice(-8).map((l) => l.text)));

  // Clean up: the guest breaks allegiance.
  await guest.page.waitForTimeout(3000);
  await guest.page.evaluate(`window.acDebug.select(${patronGuid})`);
  await guest.page.waitForTimeout(800);
  await guest.page.evaluate(`window.__ac.gameUI.callbacks.onAllegianceBreak(${patronGuid})`); // the panel's Break
  await guest.page.waitForTimeout(3000);
  console.log('guest chat tail:', JSON.stringify((await chatLines(guest.page)).slice(-4).map((l) => l.text)));
  await guest.browser.close();
  await admin.browser.close();
  console.log(out && inn ? 'PASS' : 'FAIL');
}
main().catch((e) => { console.error(e); process.exit(1); });
