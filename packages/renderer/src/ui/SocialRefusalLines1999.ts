/**
 * BUG.ac1999-fellow-recruit-silent (2026-11-02) — one plain line for the AC1999 server's fellowship and
 * allegiance refusals that the 1999 client printed nothing for.
 *
 * The AC1999 server answers a refused FELLOW_RECRUIT (0xA5) or SwearAllegiance with a bare 0x1C
 * AttemptFailed code (FellowshipManager::Recruit, AllegianceManager::TrySwearAllegiance). The 1999
 * client's failure switch, UI_HandleFailureEvent @ 0x004ccd10 (ui/FailureEventText1999.ts), has no
 * arm for five of those codes, and neither has end of retail's (ClientCommunicationSystem::
 * HandleFailureEvent @ 00571990): the press did nothing a player could see. On prod a 1999 player
 * pressed Recruit about 25 times in under a minute against WERROR_FELLOWSHIP_MEMBER (0x41A) with
 * nothing on screen.
 *
 * A departure from 1999 (docs/ac1999-support.md, "Failure codes"): each code gets one line, only when
 * it answers the action that draws it (a recruit or a swear sent in the last few seconds), so the
 * same code from any other request keeps 1999's silence. The wording is the line ACE sends for the
 * same refusal (no era's DAT or client has one): Fellowship.cs AddFellowshipMember "{Name} is
 * already a member of a Fellowship.", Player_Fellowship.cs FellowshipRecruit "{Name} is not accepting
 * fellowship requests.", Player_Allegiance.cs "{Name} is busy." / "{Name} is not accepting allegiance
 * requests."; the out-of-range swear (WERROR_MISSILE_OUT_OF_RANGE 0x550) is end of retail's own
 * literal for that code ("Out of Range!"). The lines go to the status line (our spew), where the 1999
 * client's own fellowship refusals go (FellowPanel_RecruitObject @ 0x00535670).
 *
 * WERROR_FELLOWSHIP_LOCKED_RECRUITEE (0x519) reaches the player someone tried to recruit into a locked
 * fellowship, with no action of theirs; it takes end of retail's text and chat line (decomp
 * HandleFailureEvent arm 0x519, type 0).
 *
 * Not here, because a line already shows: WERROR_FELLOWSHIP_SQUELCHED / WERROR_ALLEGIANCE_SQUELCHED
 * (the server says those in chat itself), WERROR_FELLOWSHIP_LOCKED_RECRUITER and the other 0x28B
 * WithString codes (end of retail's switch), and every code the 1999 switch has an arm for
 * (0x1D busy, 0x38 no object, 0x3D "You charged too far!", 0x41D not leader, 0x41E full, 0x40B,
 * 0x40C).
 */
import { WEENIE_ERROR_TEXT_TYPE_CHAT, WEENIE_ERROR_TEXT_TYPE_SPEW } from '@ac/shared';
import type { FailureEventArm } from './FailureEventText1999.js';

/** The request a refusal answers. */
export type SocialAction = 'recruit' | 'swear';

/** One line: its AddTextToScroll type, the text with the target's name ('%s'), and the text without it. */
export interface SocialRefusalLine {
  readonly type: number;
  readonly named: string;
  readonly generic: string;
}

/** code → line for each action, plus `any`: the lines no request of the player's draws. */
export interface SocialRefusalTable {
  readonly byAction: ReadonlyMap<SocialAction, ReadonlyMap<number, SocialRefusalLine>>;
  readonly any: ReadonlyMap<number, SocialRefusalLine>;
}

/** How long after a recruit / swear its refusal is still taken as that request's answer. */
export const SOCIAL_REFUSAL_WINDOW_MS = 5000;

const line = (type: number, named: string, generic: string = named): SocialRefusalLine => Object.freeze({ type, named, generic });
const spew = (named: string, generic?: string): SocialRefusalLine => line(WEENIE_ERROR_TEXT_TYPE_SPEW, named, generic);

/** The AC1999 server's codes (Server/Source/PhatSDK/GameEnums.h), numbered as it sends them. */
export const WERROR_1999 = Object.freeze({
  ALLEGIANCE_IGNORING_REQUESTS: 0x40d,
  ALLEGIANCE_PATRON_BUSY: 0x412,
  FELLOWSHIP_IGNORING_REQUESTS: 0x417,
  FELLOWSHIP_MEMBER: 0x41a,
  FELLOWSHIP_LOCKED_RECRUITEE: 0x519,
  MISSILE_OUT_OF_RANGE: 0x550,
});

export const SOCIAL_REFUSAL_LINES_1999: SocialRefusalTable = Object.freeze({
  byAction: new Map<SocialAction, ReadonlyMap<number, SocialRefusalLine>>([
    ['recruit', new Map([
      // FellowshipManager::Recruit: the recruit already belongs to a fellowship.
      [WERROR_1999.FELLOWSHIP_MEMBER, spew('%s is already a member of a Fellowship.', 'That person is already a member of a Fellowship.')],
      // ... or ignores fellowship requests (IgnoreFellowshipRequests_CharacterOption).
      [WERROR_1999.FELLOWSHIP_IGNORING_REQUESTS, spew('%s is not accepting fellowship requests.', 'That person is not accepting fellowship requests.')],
    ])],
    ['swear', new Map([
      // AllegianceManager::TrySwearAllegiance: the patron is busy, ignores allegiance requests, or is 4 m or more away.
      [WERROR_1999.ALLEGIANCE_PATRON_BUSY, spew('%s is busy.', 'That person is busy.')],
      [WERROR_1999.ALLEGIANCE_IGNORING_REQUESTS, spew('%s is not accepting allegiance requests.', 'That person is not accepting allegiance requests.')],
      [WERROR_1999.MISSILE_OUT_OF_RANGE, spew('Out of Range!')],
    ])],
  ]),
  any: new Map([
    [WERROR_1999.FELLOWSHIP_LOCKED_RECRUITEE, line(WEENIE_ERROR_TEXT_TYPE_CHAT, 'The fellowship is locked, you were not added to the fellowship.')],
  ]),
});

/** Every line with a name slot (the refusal telemetry keys them by template, the name never leaves). */
export function socialRefusalNameTemplates(table: SocialRefusalTable = SOCIAL_REFUSAL_LINES_1999): string[] {
  const out = new Set<string>();
  for (const m of [...table.byAction.values(), table.any]) for (const l of m.values()) if (l.named.includes('%s')) out.add(l.named);
  return [...out];
}

/** The line to show and its name-free template ('_' for the name). */
export interface SocialRefusalShown {
  readonly arm: FailureEventArm;
  readonly template: string;
}

/**
 * The last recruit / swear the player sent and its target. A refusal code arriving within
 * SOCIAL_REFUSAL_WINDOW_MS takes that action's line. Not consumed by a match: rapid presses send
 * several requests whose refusals arrive after the next send, and each should still read.
 */
export class SocialRefusalMemo {
  private last: { action: SocialAction; guid: number; at: number } | null = null;

  constructor(private readonly table: SocialRefusalTable) {}

  /** A recruit / swear went to the server. */
  note(action: SocialAction, guid: number, now: number): void {
    this.last = { action, guid: guid >>> 0, at: now };
  }

  /** Session end: nothing is pending any more. */
  clear(): void {
    this.last = null;
  }

  /** The line for `code`, or null when this code from this moment keeps the era's silence. */
  lineFor(code: number, now: number, nameOf: (guid: number) => string | null | undefined): SocialRefusalShown | null {
    const any = this.table.any.get(code);
    if (any) return shown(any, null);
    const l = this.last;
    if (!l || now - l.at > SOCIAL_REFUSAL_WINDOW_MS || now < l.at) return null;
    const hit = this.table.byAction.get(l.action)?.get(code);
    if (!hit) return null;
    const name = (nameOf(l.guid) ?? '').trim();
    return shown(hit, name || null);
  }
}

function shown(l: SocialRefusalLine, name: string | null): SocialRefusalShown {
  if (!l.named.includes('%s')) return { arm: Object.freeze({ type: l.type, text: l.named }), template: l.named };
  return {
    arm: Object.freeze({ type: l.type, text: name ? l.named.replace('%s', name) : l.generic }),
    template: name ? l.named.replace('%s', '_') : l.generic,
  };
}
