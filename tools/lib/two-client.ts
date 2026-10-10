/**
 * two-client — two live game sessions side by side (HARNESS.two-client-social-flows).
 *
 * Multi-player flows (tells, squelch, fellowship, allegiance, trade, PK) need a
 * second real player; before this each probe hand-rolled its own pair of
 * sessions. `openTwoClients()` logs both in, brings them together and returns
 * a `Client` per side with the reads every social probe wants.
 *
 * Accounts default to fxprobe1 (Fxprobe) and fxprobe2 (Fxprobetwo): not Jake's
 * (testacjs) and not the GPU worker's (testacjs2 / testacjs3, whose jobs would
 * boot a probe logged in on them). Both are admin accounts,
 * which @teleloc / @teletome need. Override with AC_CLIENT_A / AC_CLIENT_B
 * (account name; password = account) and AC_CLIENT_A_CHAR / AC_CLIENT_B_CHAR
 * (character to create on an empty account). AC_BRIDGE etc. apply to both,
 * e.g. AC_BRIDGE=ws://localhost:9091 for an impaired bridge.
 */
import type { Browser, Page } from 'playwright';
import { adminCommand, enterWorld, gameUrl } from './game-session.ts';

export interface Client {
  label: 'A' | 'B';
  account: string;
  browser: Browser;
  page: Page;
  guid: number;
  name: string;
}

/** Holtburg, beside the lifestone: open ground, no monsters (probe-trade-by-use's spot). */
export const MEET_LOC = '0xA9B40019 [85.0 20.5 94.0] 1 0 0 0';

export const chatLines = (page: Page): Promise<string[]> => page.evaluate(`(() => { const c = document.getElementById('chat-messages');
  return c ? [...c.children].map((e) => ((e.dataset && e.dataset.chatText) || e.textContent || '').trim()) : []; })()`) as Promise<string[]>;

/**
 * How long a probe waits for the answer to one action over a lossy link
 * (NET.impaired-tell-trade-tail). A lone lost action is resent only on the
 * server's NAK, as retail does (RecipientData::ProcessNaks @ 00547010; no
 * resend timer), and ACE NAKs a client gap only once a packet two past it
 * arrives (NetworkSession.cs desiredSeq + 2), which the ~3 s keepalives
 * supply: ~6 s plus a round trip, ~9 s more if the NAK or the resend is lost
 * too. Waits poll, so a clean link still answers in a second.
 */
export const LINK_WAIT_MS = 20_000;

/** Poll until a chat line matches, or give up after `ms`. Returns the line or null. */
export async function waitChat(page: Page, re: RegExp, ms = LINK_WAIT_MS): Promise<string | null> {
  for (let t = 0; t <= ms; t += 400) {
    const hit = (await chatLines(page)).find((l) => re.test(l));
    if (hit) return hit;
    await page.waitForTimeout(400);
  }
  return null;
}

/**
 * Type a line into the chat box and press Enter, as a player does. Not
 * acDebug.sendChat: that calls GameUI's onChatSend directly and skips the
 * chat input's capture-phase keydown listener, where the client-side
 * /-commands (/squelch, /unsquelch, …) live.
 */
export async function say(page: Page, text: string): Promise<void> {
  await page.fill('#chat-input', text);
  await page.press('#chat-input', 'Enter');
}

/**
 * The open confirmation dialog's text, or null when none is up. The text is
 * drawn to a canvas (DAT font), so read the per-line data-ac-line runs
 * (buildTemplateTextCell), not its textContent.
 */
export function dialogText(page: Page): Promise<string | null> {
  return page.evaluate(`(() => { const d = window.__ac.gameUI.confirmationDialog;
    if (!d) return null; const t = d.querySelector('.ac-dialog-text'); if (!t) return '';
    return [...t.querySelectorAll('[data-ac-line]')].map((r) => r.dataset.acLine).join(' ') || t.textContent || ''; })()`) as Promise<string | null>;
}

export async function waitDialog(page: Page, ms = LINK_WAIT_MS): Promise<string | null> {
  for (let t = 0; t <= ms; t += 400) {
    const s = await dialogText(page);
    if (s !== null) return s;
    await page.waitForTimeout(400);
  }
  return null;
}

/** Click the dialog's Yes (left) or No (right) button with the real mouse. */
export async function answerDialog(page: Page, yes: boolean): Promise<boolean> {
  const at = await page.evaluate(`(() => { const d = window.__ac.gameUI.confirmationDialog; if (!d) return null;
    const btns = [...d.querySelectorAll('.ac-dialog-button')]
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    const b = btns[${yes ? 0 : 'btns.length - 1'}]; if (!b) return null; const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`) as { x: number; y: number } | null;
  if (!at) return false;
  await page.mouse.click(at.x, at.y);
  return true;
}

/** Whether `guid` is a known object in this client's world. */
export function sees(page: Page, guid: number): Promise<boolean> {
  return page.evaluate(`!!window.__ac.serverObjectManager.getObject(${guid})`) as Promise<boolean>;
}

async function openClient(label: 'A' | 'B', account: string, character: string, cb: string): Promise<Client> {
  const s = await enterWorld({
    createCharacter: character,
    url: gameUrl({ cb, env: { ...process.env, AC_ACCOUNT: account, AC_PASSWORD: account } }),
  } as never);
  await s.page.waitForTimeout(3000);
  const guid = await s.page.evaluate('window.__ac.charGuid') as number;
  const name = await s.page.evaluate('window.__ac.playerState.name') as string;
  if (!name) throw new Error(`client ${label} (${account}) entered the world without a character name`);
  return { label, account, browser: s.browser, page: s.page, guid, name };
}

/**
 * Log both clients in and stand B next to A at MEET_LOC. Sequential logins:
 * two simultaneous ones contend for ACE's login queue for no gain.
 */
export async function openTwoClients(tag: string, env: NodeJS.ProcessEnv = process.env): Promise<{ a: Client; b: Client; close: () => Promise<void> }> {
  const accA = env.AC_CLIENT_A ?? 'fxprobe1';
  const accB = env.AC_CLIENT_B ?? 'fxprobe2';
  const a = await openClient('A', accA, env.AC_CLIENT_A_CHAR ?? 'Fxprobe', `${tag}-a`);
  await adminCommand(a.page, `@teleloc ${MEET_LOC}`);
  await a.page.waitForTimeout(6000);
  const b = await openClient('B', accB, env.AC_CLIENT_B_CHAR ?? 'Fxprobetwo', `${tag}-b`);
  await adminCommand(a.page, `@teletome ${b.name}`);
  await b.page.waitForTimeout(9000);
  const close = async (): Promise<void> => {
    await b.browser.close().catch(() => {});
    await a.browser.close().catch(() => {});
  };
  return { a, b, close };
}
