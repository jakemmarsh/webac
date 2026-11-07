/**
 * BUG.second-tab-in-world-refusal — what an enter refused with "one of your
 * characters is still in the world" (CharacterError 0x0D) shows, when another
 * tab of this browser is in the world on the same server.
 *
 * Production, 2026-11-03 (DreamWeave, ACE, one player): a tab in the world,
 * then a second tab of the same browser created a character and entered. The
 * server answered every enter with 0x0D; ours retried for 75 s behind the
 * Entering World dialog with nothing saying why (the retries are meant for
 * our own character still logging out after a drop), and the player left
 * three times within 5-22 s before playing another world.
 *
 * Retail answered 0x0D with the char-select OK dialog at once
 * (gmUIFlow::RecvNotice_CharacterError @ 0047a7c0, ID_CHAR_ERROR_ENTER_GAME_
 * CHARACTER_IN_WORLD: "One of your characters is still in the world. Please
 * try again in a few minutes."). The browser-UX departure (CLAUDE.md, named
 * exceptions): after the first refusal the tab asks the other tabs of this
 * browser (AccountTabGuard.queryWorldHolders) and
 *  - a tab in the world on the same server AND account: a Yes / No offer to
 *    log that tab out and enter here (Yes asks only that tab, under the key
 *    both hold: AccountTabGuard.requestLogout);
 *  - a tab in the world on the same server under another account: a line
 *    under Entering World naming that tab's character (the server may let
 *    one of a player's characters in at a time); nothing is logged out;
 *  - no tab: a line under Entering World saying what it waits for.
 * In every case the quiet retries go on (InWorldEnterWait): the refusal may
 * be our own character still logging out after a crash, which clears on the
 * server's logout clock (ACE ~8-14 s), and a holder the player logs out by
 * hand lets the next retry in. Only a spent budget ends the enter, with
 * retail's dialog and the line for whatever this browser saw.
 *
 * A world that lets one character in per network address (World.perIpLimits
 * .characters; DreamWeave, BUG.dreamweave-per-ip-enter, 2026-11-07): every
 * webAC player shares the bridge's address, so a 0x0D there is nearly always
 * another webAC player's character, and retail's "one of your characters"
 * sent players looking for a character they never had in. There, unless the
 * enter is a resume after a drop (our own character, logging out), the line
 * under Entering World and the final dialog say another webAC player is in
 * the world (perIpInWorldStatus / perIpInWorldText). A tab of this browser in
 * the world still wins: its offer or line is the more exact answer. The
 * retries, their budget and the resume path are unchanged. A browser-UX
 * exception (CLAUDE.md, "Consistent refusals").
 *
 * Live check 2026-11-03: the first version showed the other-account line as
 * an OK dialog and stopped the retries; a tab whose own crashed character was
 * the real holder sat at character select 3+ minutes, blamed on an unrelated
 * tab, where the retries would have entered in ~14 s.
 */

import { perIpInWorldStatus, perIpInWorldText } from '../launcher/worldDirectory.js';
import type { WorldHolder } from './AccountTabGuard.js';
import type { CharacterInWorldVerdict } from './SessionLifecycle.js';

export type InWorldHolderAction =
  | { kind: 'none' }
  | { kind: 'offer-logout'; holder: WorldHolder; text: string }
  | { kind: 'other-account'; holder: WorldHolder; text: string };

function named(holder: WorldHolder): string {
  return holder.character ? `as ${holder.character}` : 'with a character';
}

/** The Yes / No offer when another tab holds this account in the world. */
export function sameAccountOfferText(holder: WorldHolder): string {
  return `This account is already in the world in another tab, ${named(holder)}.\n\nLog out that tab and enter here?`;
}

/** Retail's 0x0D text plus the line naming the other account's tab. */
export function otherAccountText(retailText: string, holder: WorldHolder): string {
  return `${retailText}\n\nAnother tab of this browser is in the world on this server ${named(holder)}. `
    + 'This server may let only one of your characters in at a time: log out in that tab, then enter again.';
}

/**
 * The action for the tabs that answered. A same-account holder wins over any
 * other (it is the one the server certainly counts); several of either kind
 * name the first.
 */
export function inWorldHolderAction(holders: readonly WorldHolder[], retailText: string): InWorldHolderAction {
  const same = holders.find((h) => h.sameAccount);
  if (same) return { kind: 'offer-logout', holder: same, text: sameAccountOfferText(same) };
  const other = holders[0];
  if (other) return { kind: 'other-account', holder: other, text: otherAccountText(retailText, other) };
  return { kind: 'none' };
}

/** The line under Entering World while another account's tab is in the world on this server. */
export function otherAccountStatus(holder: WorldHolder): string {
  return `Another tab of this browser is in the world here ${named(holder)}. `
    + 'This server may let only one of your characters in at a time: log out in that tab.';
}

/** The final dialog's line when the player kept the same-account tab in the world (No). */
export function sameAccountFinalText(retailText: string, holder: WorldHolder): string {
  return `${retailText}\n\nThis account is in the world in another tab ${named(holder)}: log out there, then enter again.`;
}

/** The line under Entering World while a 0x0D refusal is being retried. */
export const IN_WORLD_WAIT_STATUS = 'Waiting for the server to let this character in…';

/** The line under Entering World after the other tab was asked to log out. */
export const HOLDER_LEAVING_STATUS = 'Logging out the other tab…';

/** What the tab that was asked to log out shows (the Disconnected screen; its Quit Game goes to the server select, BUG.old-tab-quit-steals-account). */
export const LOGGED_OUT_FOR_OTHER_TAB_TEXT = 'You chose to enter the world in another tab, so this tab logged out.';

/** What InWorldEnterWait needs from the page (main.ts wires SessionLifecycle, the guard, GameUI, timers). */
export interface InWorldEnterWaitDeps {
  /** SessionLifecycle.characterInWorldRefusal: counts this refusal against the budget. */
  verdict(): CharacterInWorldVerdict;
  /** SessionLifecycle.inWorldRetryDelay for the retry just granted. */
  retryDelay(): number;
  /** SessionLifecycle.inWorldRefusalCount. */
  refusalCount(): number;
  /** SessionLifecycle.enterSerial. */
  enterSerial(): number;
  /** SessionLifecycle.resumingAfterDrop: the refused character is our own, logging out after a drop. */
  resuming(): boolean;
  /** SessionLifecycle.waitingOnHolder. */
  waitingOnHolder(): boolean;
  /** SessionLifecycle.mayRetryEnterWorld. */
  mayRetry(): boolean;
  /** SessionLifecycle.noteHolderLeaving. */
  holderLeaving(): void;
  /** AccountTabGuard.queryWorldHolders for this page's key ([] without one). */
  queryHolders(): Promise<WorldHolder[]>;
  /** AccountTabGuard.requestLogout. */
  requestLogout(holder: WorldHolder): boolean;
  /** Send the enter-world request again (it re-arms retail's 110 s clock). */
  sendRetry(): void;
  /** A timer; returns its cancel. */
  schedule(fn: () => void, ms: number): () => void;
  now(): number;
  setStatus(text: string | null): void;
  /** Put the Entering World dialog back (after the question). */
  showEnteringWorld(): void;
  /** Yes / No; returns a close for the dialog. */
  confirm(text: string, onAnswer: (yes: boolean) => void): () => void;
  report?(kind: InWorldHolderAction['kind']): void;
  /**
   * The world's characters-in-the-world-per-address rule that every webAC
   * player shares (worldDirectory perIpCharacterLimit; 0 or absent = none).
   */
  charactersPerAddress?(): number;
}

/**
 * The "character still in the world" (0x0D) wait for one enter: retries on
 * the SessionLifecycle budget and cadence, the other tabs asked once per
 * enter, a status line for what this browser saw, and the final dialog's
 * text. The retries never stop for a holder: only the budget ends the enter.
 */
export class InWorldEnterWait {
  private serial = -1;
  private holder: WorldHolder | null = null;
  /** The enter under way was a resume after a drop at its first refusal: the holder is our own character. */
  private resumed = false;
  private cancelRetry: (() => void) | null = null;
  private closeOffer: (() => void) | null = null;

  constructor(private readonly deps: InWorldEnterWaitDeps) {}

  /** The tab of this browser seen in the world for the enter under way (tests / probes). */
  get seenHolder(): WorldHolder | null { return this.serial === this.deps.enterSerial() ? this.holder : null; }

  /** The Yes / No offer is up (tests / probes). */
  get offerOpen(): boolean { return this.closeOffer !== null; }

  /** A 0x0D refusal of the enter under way: what main.ts does next ('dialog': show finalText). */
  onRefusal(): CharacterInWorldVerdict {
    const verdict = this.deps.verdict();
    if (verdict === 'ignore') return verdict;
    if (this.serial !== this.deps.enterSerial()) {
      this.serial = this.deps.enterSerial();
      this.holder = null;
      this.resumed = this.deps.resuming();
    }
    if (verdict === 'dialog') {
      this.clearTimers();
      return verdict;
    }
    const delay = this.deps.retryDelay();
    const first = this.deps.refusalCount() === 1 && !this.deps.waitingOnHolder();
    if (first) this.deps.setStatus(this.sharedLimit() > 0 ? perIpInWorldStatus(this.sharedLimit()) : IN_WORLD_WAIT_STATUS);
    if (first && !this.deps.resuming()) this.ask();
    this.retryIn(delay);
    return verdict;
  }

  /** The world arrived, or the enter ended another way: nothing more to wait on. */
  end(): void {
    this.clearTimers();
  }

  /** The final dialog's text: retail's notice, or retail's text and the line for the tab seen in the world. */
  finalText(noticeText: string, retailText: string): string {
    const holder = this.seenHolder;
    if (!holder) {
      // A per-address world: the holder no tab of this browser explains is another webAC player.
      const shared = this.sharedLimit();
      return shared > 0 ? perIpInWorldText(shared) : noticeText;
    }
    return holder.sameAccount ? sameAccountFinalText(retailText, holder) : otherAccountText(retailText, holder);
  }

  /** The shared per-address character rule for the enter under way (0: none, or a resume of our own character). */
  private sharedLimit(): number {
    if (this.serial === this.deps.enterSerial() && this.resumed) return 0;
    const n = this.deps.charactersPerAddress?.() ?? 0;
    return Number.isInteger(n) && n > 0 ? n : 0;
  }

  private ask(): void {
    const serial = this.serial;
    void this.deps.queryHolders().then((holders) => {
      if (serial !== this.deps.enterSerial() || !this.deps.mayRetry()) return;
      const action = inWorldHolderAction(holders, '');
      this.deps.report?.(action.kind);
      if (action.kind === 'none') return;
      this.holder = action.holder;
      if (action.kind === 'other-account') {
        console.warn(`[AC] ACE: "still in the world" — another tab of this browser is in this world under another account (${action.holder.character ?? '?'}); retrying`);
        this.deps.setStatus(otherAccountStatus(action.holder));
        return;
      }
      console.warn(`[AC] ACE: "still in the world" — another tab of this browser holds this account in the world (${action.holder.character ?? '?'})`);
      // The retries go on under the question: No, or no answer, ends as any other wait does.
      this.closeOffer = this.deps.confirm(action.text, (yes) => {
        this.closeOffer = null;
        if (serial !== this.deps.enterSerial() || !this.deps.mayRetry()) return;
        this.deps.showEnteringWorld();
        if (yes && this.deps.requestLogout(action.holder)) {
          this.deps.holderLeaving();
          this.deps.setStatus(HOLDER_LEAVING_STATUS);
          // The holder's session closes now; its character leaves on the server's logout
          // clock (ACE ~7.7 s), which the 1 s retries wait out.
          this.retryIn(1000);
          return;
        }
        this.deps.setStatus(sameAccountStatus(action.holder));
      });
    });
  }

  private retryIn(ms: number): void {
    this.cancelRetry?.();
    this.cancelRetry = this.deps.schedule(() => {
      this.cancelRetry = null;
      if (this.deps.mayRetry()) this.deps.sendRetry();
    }, ms);
  }

  private clearTimers(): void {
    this.cancelRetry?.();
    this.cancelRetry = null;
    this.closeOffer?.();
    this.closeOffer = null;
  }
}

/** The line under Entering World after the player kept the same-account tab (No). */
export function sameAccountStatus(holder: WorldHolder): string {
  return `This account is in the world in another tab ${named(holder)}: log out there to enter here.`;
}
