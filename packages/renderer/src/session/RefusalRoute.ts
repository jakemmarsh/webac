/**
 * RefusalRoute — where a refusal the player can meet is shown.
 *
 * Retail's surfaces (ui/ConnectionNotices.ts has the decomp anchors):
 *  - gmUIFlow::RecvNotice_CharacterError @ 0047a7c0 queues the Disconnected
 *    UI mode (layout 0x21000002) for its account-level codes and the
 *    character-management mode with the OK dialog (0x2100003C type 3) for
 *    the rest; its `default:` shows nothing.
 *  - CPlayerSystem::Handle_AccountBooted @ 00562a70 / Handle_AccountBanned
 *    @ 00562bd0 move the flow to the Disconnected mode.
 *
 * Retail had no launcher: a refused login ended the process, and the player
 * picked a world and typed the password again in the separate launcher.
 * Ours keeps the player in the page, so the rule here (a named browser-UX
 * consistency choice, Jake 2026-10-18) is:
 *  - **Before the world** every account-level refusal (an AccountBoot or
 *    AccountBanned on login, the account-level CharacterErrors, another tab
 *    of this browser taking the account) is the OK dialog. A launcher login
 *    shows it over the launcher, where the player can fix what was refused;
 *    a URL login (dev tooling, no launcher in its flow) shows it where it is
 *    and OK relaunches the connect cycle, as the Disconnected screen's
 *    button did.
 *  - **From the world** (in it, or an automatic resume of a drop from it)
 *    retail's Disconnected screen stays.
 *  - A CharacterError outside retail's switch ends a pre-world wait with the
 *    generic "Could not enter the game" dialog over character select instead
 *    of leaving the Entering World dialog up forever; in the world it still
 *    shows nothing, as retail.
 */

import { CharacterError } from '@ac/shared';
import { characterErrorNotice, type ConnectionNotice } from '../ui/ConnectionNotices.js';

export interface RefusalContext {
  /** In the world: PlayerCreate arrived (SessionLifecycle.inWorld) or the world is running. */
  inWorld: boolean;
  /** An automatic resume of an in-world drop is under way (SessionLifecycle.resumingAfterDrop). */
  resuming: boolean;
  /** The player logged in from the launcher (not a dev URL login). */
  launcherLogin: boolean;
}

/**
 * An account-level refusal: 'disconnected' = retail's Disconnected screen
 * (from the world), 'launcher' = the OK dialog over the launcher (a launcher
 * login before the world), 'relaunch' = the OK dialog whose OK relaunches the
 * connect cycle (a URL login before the world).
 */
export type AccountRefusalRoute = 'disconnected' | 'launcher' | 'relaunch';

export function accountRefusalRoute(ctx: RefusalContext): AccountRefusalRoute {
  if (ctx.inWorld || ctx.resuming) return 'disconnected';
  return ctx.launcherLogin ? 'launcher' : 'relaunch';
}

/**
 * A CharacterError's route: 'account' (accountRefusalRoute decides the
 * surface), 'charselect' (the OK dialog over character select), or 'none'
 * (retail's `default:` in the world: nothing shown).
 */
export interface CharacterErrorRoute {
  route: 'account' | 'charselect' | 'none';
  /** The dialog / screen text. */
  text: string;
  /** The retail notice (token '' for a code outside the switch). */
  notice: ConnectionNotice;
}

/**
 * The connecting screen's line while ACE still holds the account's last
 * session (CharacterError.Logon with a timed fresh login scheduled:
 * ClientConnection.scheduleLoginRetryAfterReject, up to 40 tries). Retail
 * showed the Disconnected screen at once; ours waits, so it says for what.
 */
export function staleSessionWaitText(attempt: number, max: number): string {
  const base = 'Waiting for the server to release your last session…';
  return attempt > 0 && max > 0 ? `${base} (try ${attempt} of ${max})` : base;
}

/** The text that ends a pre-world wait for a code retail's switch does not list. */
export function genericEnterRefusalText(): string {
  return characterErrorNotice(CharacterError.EnterGameOldCharacter).text;
}

/**
 * `connecting`: the connecting screen is still up (no character list of this
 * connect yet). A refusal there has no character select to return to, so a
 * would-be char-select dialog ends the connect as an account-level refusal
 * does (an OK alone would leave Please Wait up with nothing behind it).
 */
export function characterErrorRoute(code: number, ctx: { inWorld: boolean; connecting?: boolean }): CharacterErrorRoute {
  const notice = characterErrorNotice(code);
  if (notice.surface === 'disconnected') return { route: 'account', text: notice.text, notice };
  if (notice.surface === 'none' && ctx.inWorld) return { route: 'none', text: notice.text, notice };
  const text = notice.surface === 'dialog' ? notice.text : genericEnterRefusalText();
  if (!ctx.inWorld && ctx.connecting) return { route: 'account', text, notice };
  return { route: 'charselect', text, notice };
}
