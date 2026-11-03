/**
 * The server's no to a fellowship or allegiance request, as the agent reads it from the lines that answer it.
 *
 * ac_fellowship action=recruit printed "asked Claude Yak to join. They have 30 s to accept…" and then the server's
 * refusal under it ("Claude Yak is already a member of a Fellowship.", "… is not accepting fellowship requests."),
 * a claim the refusal contradicted (2026-11-02, AC1999). A request's result now reads its reply lines through
 * {@link socialRefusalLines} first, and a refusal replaces the claim.
 *
 * Three sources of wording, one per era's path to the screen:
 * - End of retail and Dark Majesty (ACE, ClassicACE, GDL): the client's own failure switch texts for the codes the
 *   server answers the request with (@ac/shared weenieErrorText / WEENIE_ERROR_WITH_STRING_TEXT; ACE
 *   Player_Fellowship.FellowshipRecruit, Fellowship.AddFellowshipMember, Player_Allegiance.SwearAllegiance), and the
 *   chat lines ACE sends itself ("{Name} is already a member of a Fellowship.", "{Name} is busy.", "{Name} declines
 *   your invite", "{Name} is not accepting fellowship requests.").
 * - AC1999: the 1999 client's failure switch (ui/FailureEventText1999.ts: "You charged too far!", "You're too busy!",
 *   "Unable to move to object!" …) and the lines the client adds for the codes that switch left silent
 *   (ui/SocialRefusalLines1999.ts, BUG.ac1999-fellow-recruit-silent).
 * - A fallback for wording none of those has (a server's own chat): declined / refuse / cannot / not accepting / ignoring.
 *
 * Every one of those reaches the agent as a chat event (GameUI.displayErrorText copies status-line text to
 * addSystemMessage, which feeds AgentApi.pushChat). Someone's words (say, tell, emote) are never a refusal; a channel
 * line is one only in a known wording with no speaker (ACE sends some on the Fellowship channel).
 */
import { WEENIE_ERROR_WITH_STRING_TEXT, weenieErrorText } from '@ac/shared';
import { FAILURE_EVENT_TEXT_1999 } from '../ui/FailureEventText1999.js';
import { SOCIAL_REFUSAL_LINES_1999 } from '../ui/SocialRefusalLines1999.js';

/** The requests whose answers are read here: a recruit, an oath, a break, and the fellowship pane's other buttons. */
export type SocialRequest = 'recruit' | 'swear' | 'break' | 'fellowship';

/** Codes that refuse any request that has the server walk you to someone or that it can be too busy for. */
const APPROACH_CODES = [0x1d, 0x23, 0x36, 0x37, 0x38, 0x39, 0x3d];

/** WeenieError codes the server answers each request with when it refuses (ACE / GDL / the AC1999 server). */
export const SOCIAL_REFUSAL_CODES: Readonly<Record<SocialRequest, readonly number[]>> = Object.freeze({
  // FellowshipIgnoringRequests, FellowshipMaxDistanceExceeded, FellowshipMember (1999), YouMustBeLeaderOfFellowship,
  // YourFellowshipIsFull, FellowshipDeclined, LockedFellowshipCannotRecruitYou, FellowshipIsLocked, OlthoiCannotJoinFellowship.
  recruit: [...APPROACH_CODES, 0x417, 0x419, 0x41a, 0x41d, 0x41e, 0x4db, 0x519, 0x528, 0x58b],
  // YouveAlreadySwornAllegiance, CantSwearAllegianceInsufficientXp, AllegianceIgnoringRequests, AllegianceIllegalLevel,
  // AllegiancePatronBusy, YourOfferOfAllegianceWasIgnored, CannotSwearAllegianceWhileOwningMansion, MissileOutOfRange
  // (the 1999 server's "too far"), OlthoiCannotJoinAllegiance.
  swear: [...APPROACH_CODES, 0x40b, 0x40c, 0x40d, 0x410, 0x412, 0x48e, 0x4e7, 0x550, 0x58c],
  // YouAreNotInAllegiance, ThatPersonIsNotInYourAllegiance, CantBreakFromPatronNotInAllegiance.
  break: [0x414, 0x494, 0x495],
  // YoureTooBusy, YouMustBeLeaderOfFellowship, FellowshipNameIsNotPermitted, YouDoNotBelongToAFellowship,
  // FellowshipIsLocked, OlthoiCannotJoinFellowship.
  fellowship: [0x1d, 0x41d, 0x41e, 0x41f, 0x50f, 0x528, 0x58b],
});

/** 0x28B WithString codes ('_' is the name). */
const WITH_STRING_CODES: Readonly<Record<SocialRequest, readonly number[]>> = Object.freeze({
  // LockedFellowshipCannotRecruit_.
  recruit: [0x518],
  // _CannotHaveAnyMoreVassals, YouAreBannedFromAllegiance, YouCannotSwearAllegiance_AllegianceOf_IsLocked.
  swear: [0x416, 0x53f, 0x577],
  break: [],
  fellowship: [],
});

/** The chat lines ACE sends itself ('_' is the name). */
const SERVER_CHAT: Readonly<Record<SocialRequest, readonly string[]>> = Object.freeze({
  recruit: [
    '_ is not accepting fellowship requests.', // Player_Fellowship.FellowshipRecruit
    '_ is already a member of a Fellowship.', // Fellowship.AddFellowshipMember
    '_ is busy.', // ... the recruit is mid-confirmation
    '_ declines your invite', // ... said no to the dialog
    "The Olthoi's hunger for destruction is too great to understand a request for fellowship.",
  ],
  swear: [],
  break: [],
  fellowship: ["You can't dismiss yourself from the fellowship", '_ is not a member of the fellowship!'],
});

/** Words a server's own refusal uses that no table above has. */
const FALLBACK = /\b(declined?|declines|refuses?d?|cannot|can't|not accepting|ignoring|ignored)\b/i;

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** "Name is busy." → /^(.+?) is busy[.!]?$/i: the template's own words, any name, trailing stop optional. */
const templateRe = (t: string): RegExp => {
  const body = t.trim().replace(/[.!]+$/, '');
  return new RegExp(`^${body.split(/_|%s/).map(escape).join('.+?')}[.!]?$`, 'i');
};

const PATTERNS = new Map<SocialRequest, RegExp[]>();
function patterns(req: SocialRequest): RegExp[] {
  let out = PATTERNS.get(req);
  if (out) return out;
  const texts = new Set<string>();
  for (const code of SOCIAL_REFUSAL_CODES[req]) {
    const eor = weenieErrorText(code);
    if (eor) texts.add(eor);
    const old = FAILURE_EVENT_TEXT_1999.get(code);
    if (old) texts.add(old.text);
  }
  for (const code of WITH_STRING_CODES[req]) { const t = WEENIE_ERROR_WITH_STRING_TEXT[code]; if (t) texts.add(t); }
  for (const t of SERVER_CHAT[req]) texts.add(t);
  const lines1999 = req === 'recruit' || req === 'swear' ? SOCIAL_REFUSAL_LINES_1999.byAction.get(req) : undefined;
  for (const l of [...(lines1999?.values() ?? []), ...SOCIAL_REFUSAL_LINES_1999.any.values()]) { texts.add(l.named); texts.add(l.generic); }
  out = [...texts].map(templateRe);
  PATTERNS.set(req, out);
  return out;
}

/**
 * Is `line` (a reply line, "(kind) " prefix off) the server refusing `req`? `templatesOnly`: only the known wordings,
 * not the fallback words (for a line on a chat channel, where ACE puts "{Name} is not accepting fellowship requests."
 * but where a fellow's own "I cannot wait" goes too).
 */
export function isSocialRefusal(line: string, req: SocialRequest, templatesOnly = false): boolean {
  const t = line.trim();
  if (!t) return false;
  return patterns(req).some((re) => re.test(t)) || (!templatesOnly && FALLBACK.test(t));
}

/** The refusals among `lines`, in order. */
export function socialRefusalLines(lines: readonly string[], req: SocialRequest): string[] {
  return lines.filter((l) => isSocialRefusal(l, req));
}

/** A refusal code with no line the agent saw, said in end of retail's words (or named). */
export function isSocialRefusalCode(code: number, req: SocialRequest): boolean {
  return SOCIAL_REFUSAL_CODES[req].includes(code);
}
