/**
 * TELEMETRY.refusal-name-keying — a refusal's code comes from its TEMPLATE, never from the names
 * substituted into it, and the event carries enough context to tell a legitimate refusal from a
 * bug (TELEMETRY.refusal-context).
 *
 * Production's first day (2026-10-23) showed one code per item: "Using the Scroll of Shock Arc IV",
 * "You must remove your Tunic to wear that", "The Leather Leggings is already being worn" and the
 * ACE transient "You must remove your Breeches to wield Pants" each made a new `c:` / `t:` code,
 * because the reporter's name scrub only knew 3D objects (not pack or worn items) and a client line
 * built from a template was hashed after substitution. Two fixes, both here:
 *
 * 1. `matchClientTemplate`: a line the client built from one of its own templates (the era's text
 *    tables: ServerSaysAttemptFailed's verb lines, AutoWearIsLegal's, ItemHolder::UseObject's for
 *    both eras, the client notices) is replaced by that template with '_' in each %s slot, whatever
 *    the name was. Text after the template's last literal (an attempt-failed suffix) is kept.
 * 2. `knownObjectNames` (main.ts's scrub): the names of every object the client knows, the pack and
 *    the paperdoll included, so a server line (a transient, a WeenieErrorWithString value, a GDLE
 *    text) loses them too.
 *
 * Context (`RefusalDetail`): the "one item at a time" lock carries the pending request's kind and
 * age; a cast refusal carries the spell's target type and where the selection is (and, with
 * nothing selected, what was selected last and how long ago it went). Closed tokens and numbers
 * only: no names, no guids.
 */
import {
  ATTEMPT_FAILED_VERB, InventoryRequest, buildRefusalVocabulary, scrubToVocabulary,
  SERVER_REFUSAL_TEMPLATES, BASE_REFUSAL_VOCABULARY_SOURCES, type RefusalVocabulary, type ScrubResult,
} from '@ac/shared';
import { PAPERDOLL_STRINGS } from '../inventory/PaperdollDragObject.js';
import {
  EOR_USE_OBJECT_RULES, AC1999_USE_OBJECT_RULES, USE_STATUS_TEMPLATES, USE_TARGET_PROMPT_TEMPLATE, type UseObjectRules,
} from '../input/UseObject.js';
import { CLIENT_NOTICES } from '../ui/ClientNotices.js';

/** A printf slot as the client's literals write them (%s, %hs, %ls). */
const SLOT = /%[hl]?s/;
const SLOT_G = /%[hl]?s/g;
const escapeRe = (p: string): string => p.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');

/** The UseObject rules' name templates (and hints) of one era. */
function useRuleTemplates(rules: UseObjectRules): string[] {
  return [rules.mustWield, rules.door, rules.dove, rules.chatHint, rules.combatAttackHint, rules.combatAffectHint]
    .filter((t): t is string => typeof t === 'string');
}

/**
 * ItemHolder::UseObject's hints that are not refusals: the peace-mode "To attack %s, click on the
 * dove icon first" (EoL .rdata 0x7e2aa0) and the 1999 client's chat / attack-button / Cast-button
 * hints (ItemHolder_UseObject @ 0x004e5ee0, Box3D_FoundObject @ 0x59f450), read from each era's
 * UseObjectRules table.
 */
export const USE_HINT_TEMPLATES: readonly string[] = Object.freeze([...new Set(
  [EOR_USE_OBJECT_RULES, AC1999_USE_OBJECT_RULES].flatMap((r) =>
    [r.dove, r.chatHint, r.combatAttackHint, r.combatAffectHint].filter((t): t is string => typeof t === 'string')),
)]);

const templateLine = (t: string): RegExp => new RegExp('^' + t.split(SLOT).map(escapeRe).join('.+') + '$');
const USE_HINT_LINES: readonly RegExp[] = USE_HINT_TEMPLATES.map(templateLine);

/** A spew line that is one of the eras' UseObject hints ("To attack Drudge Sneak, click on the dove icon first"). */
export function isUseHintNotice(text: string): boolean {
  const t = text.trim();
  return USE_HINT_LINES.some((re) => re.test(t));
}

/**
 * Prompts, not refusals: the client's target-mode prompt (UseObject.ts USE_TARGET_PROMPT_TEMPLATE, both eras;
 * production reported "Choose a target for the _" on 2026-10-23).
 */
export const TARGET_PROMPT_TEMPLATES: readonly string[] = Object.freeze([USE_TARGET_PROMPT_TEMPLATE]);
const TARGET_PROMPT_LINES: readonly RegExp[] = TARGET_PROMPT_TEMPLATES.map(templateLine);

/** A line that is a target-mode prompt ("Choose a target for the Healing Kit"). */
export function isTargetPromptNotice(text: string): boolean {
  const t = text.trim();
  return TARGET_PROMPT_LINES.some((re) => re.test(t));
}

/**
 * TELEMETRY.refusal-name-safety — server lines that are notices, not refusals, though their wording has a
 * refusal's words ("permission", "does not", "don't"): the whole loot-consent family, read from the servers'
 * own senders (%s = a player's name; production 2026-10-23 logged eight players' names from these, some of
 * them two words, "Ming Masun does not have permission to loot your kills."):
 * - ACE / ClassicACE Entity/Fellowship.cs (the fellowship's loot sharing): 171 / 174 grant, 301 / 325 "no
 *   longer", 335 / 366 "lost permission", 336 / 367 "does not have permission to loot your kills" (also the
 *   answer to the consent-list query).
 * - ACE WorldObjects/Player_Death.cs (/consent, /permit: 750-892): grant, already, always, revoke, the
 *   list ("You have permissions to loot a corpse from these players:" and one name a line), the empty
 *   list ("You do not have permission to loot anyone's corpse."), clear, remove. ClassicACE the same.
 * - GDLE (ClassicDereth / Seedsow Player.cpp 4513-4558, /consent): list, remove, clear.
 * tests/verify-refusal-name-safety.ts scans those sources (when present) for every consent line and checks
 * each is here or a real refusal ("You do not have permission to loot that corpse!" stays a refusal;
 * "%s is not accepting corpse looting permissions from other players." stays one too, name scrubbed).
 */
export const SERVER_TEXT_NOTICE_TEMPLATES: readonly string[] = Object.freeze([
  // Fellowship.cs
  '%s has given you permission to loot his or her kills.',
  "You no longer have permission to loot anyone else's kills.",
  'You have lost permission to loot the kills of %s.',
  '%s does not have permission to loot your kills.',
  // Player_Death.cs
  'You already have permission to loot your corpse.',
  '%s already has permission to loot your corpse.',
  '%s has given you permission to loot one of his or her corpses. This permission will last one hour.',
  'You have given permission to %s to loot one of your corpses. This permission will last one hour.',
  'You always have permission to loot your corpse.',
  "%s doesn't have permission to loot your corpse.",
  '%s has revoked permission to loot one of his or her corpses.',
  "%s's permission to loot your corpse has been revoked.",
  "You do not have permission to loot anyone's corpse.",
  'You have permissions to loot a corpse from these players:%s',
  'You have cleared your consent list. Players will have to permit you again to allow you access to their corpse.',
  "You don't have permission to loot %s's corpse.",
  "You have removed your permissions to loot %s's corpse.",
  // GDLE Player.cpp
  'You have corpse looting permission from:%s',
  "You don't have corpse looting permission from %s.",
  'You have removed the corpse looting permission of %s.',
  "You don't have any corpse consent to clear!",
  // TELEMETRY.refusal-trade-notices — the trade's progress transients (0x02EB), ACE WorldObjects/Player_Trade.cs:
  // HandleActionAcceptTrade 204 (to you) / 212 (to the partner, your name), both accepted 229-230. ClassicACE the
  // same. "Trade confirmation failed..." (HandleActionDeclineTrade 314 / 321) stays a refusal: ACE also sends it
  // when FinalizeTrade's inventory check fails (VerifyTrade_Inventory), as are the busy / encumbered / pack-space
  // lines (353-354, 421-422) and "You cannot trade that!" (142).
  'You have accepted the offer',
  '%s has accepted the offer',
  'The items are being traded',
]);
/** Whole-line, across newlines (the consent list is one message, a name a line); a trailing slot may be empty. */
const noticeLine = (t: string): RegExp => new RegExp('^' + t.split('%s').map(escapeRe).join('[\\s\\S]*') + '\\s*$');
const SERVER_TEXT_NOTICE_LINES: readonly RegExp[] = SERVER_TEXT_NOTICE_TEMPLATES.map(noticeLine);

/** A server line that is a known notice (SERVER_TEXT_NOTICE_TEMPLATES) or a target-mode prompt. */
export function isServerTextNotice(text: string): boolean {
  const t = text.trim();
  return SERVER_TEXT_NOTICE_LINES.some((re) => re.test(t)) || isTargetPromptNotice(t);
}

/**
 * Every client line template with a name slot, from the tables the client builds those lines from
 * (both eras). Templates without a slot need no entry: their text is already the template.
 */
export const CLIENT_LINE_TEMPLATES: readonly string[] = Object.freeze([...new Set([
  ...Object.values(ATTEMPT_FAILED_VERB).map((v) => v!.template),
  ...Object.values(PAPERDOLL_STRINGS),
  ...useRuleTemplates(EOR_USE_OBJECT_RULES),
  ...useRuleTemplates(AC1999_USE_OBJECT_RULES),
  ...Object.values(USE_STATUS_TEMPLATES),
  // ItemHolder::UseObject @ 00588a80's inline literals (UseObject.ts decideUseObject).
  'You cannot use the %s because you are trading it',
  'Choose a target for the %s',
  'Select your target before using the %s',
  'The %s cannot be used',
  ...Object.values(CLIENT_NOTICES).map((n) => n.text),
].filter((t) => typeof t === 'string' && SLOT.test(t)))]);

interface CompiledTemplate { re: RegExp; out: string; literal: number }

function compile(t: string): CompiledTemplate {
  const parts = t.split(SLOT);
  const endsInSlot = parts[parts.length - 1] === '';
  let src = '^';
  parts.forEach((p, i) => {
    src += escapeRe(p);
    if (i < parts.length - 1) src += i === parts.length - 2 && endsInSlot ? '(.+)$' : '(.+?)';
  });
  return { re: new RegExp(src), out: t.replace(SLOT_G, '_'), literal: parts.join('').length };
}

/** Longest literal first, so "Using the %s on %s"-style forms win over their prefixes. */
const COMPILED: readonly CompiledTemplate[] = CLIENT_LINE_TEMPLATES.map(compile).sort((a, b) => b.literal - a.literal);

/**
 * TELEMETRY.refusal-name-safety — the server's own templates with a value slot ('_' in the WeenieError and
 * WeenieErrorWithString texts), as client templates: a server text that is one of them (GDLE and the AC1999
 * server send several as plain text, "Bob is too busy to accept gifts right now.") keys by the template.
 * A template that is only a slot (0x055E AFK '_') is left out: it would match every line.
 */
export const SERVER_LINE_TEMPLATES: readonly string[] = Object.freeze([...new Set(SERVER_REFUSAL_TEMPLATES
  .filter((t) => t.includes('_') && (t.replace(/_/g, '').match(/[A-Za-z]+/g) ?? []).length >= 2)
  .map((t) => t.replace(/_/g, '%s')))]);
const SERVER_COMPILED: readonly CompiledTemplate[] = SERVER_LINE_TEMPLATES.map(compile).sort((a, b) => b.literal - a.literal);

/** A server text keyed by the server template it came from ('_' in each slot); unchanged when none matches. */
export function matchServerTemplate(text: string): string {
  return matchClientTemplate(text, SERVER_COMPILED);
}

/**
 * The client template `text` was built from, with '_' in every slot and anything after the
 * template's end kept ("The Pants can't be wielded - you're too busy" → "The _ can't be wielded -
 * you're too busy"); the text unchanged when no template matches.
 */
export function matchClientTemplate(text: string, templates: readonly CompiledTemplate[] = COMPILED): string {
  for (const c of templates) {
    const m = c.re.exec(text);
    if (m) return c.out + text.slice(m[0].length);
  }
  return text;
}

/** The same, against a caller's own template list (tests, other tables). */
export function matchTemplates(text: string, templates: readonly string[]): string {
  return matchClientTemplate(text, templates.map(compile).sort((a, b) => b.literal - a.literal));
}

/**
 * TELEMETRY.refusal-name-safety — every word a refusal's text may carry: the shared base (the WeenieError and
 * WeenieErrorWithString texts, the attempt-failed lines, the skill names) plus every client table above (the
 * client line templates, the client notices, the paperdoll strings, both eras' UseObject rules) and the
 * spew notices' own words. A word outside it leaves as '_' (RefusalTextSafety.scrubToVocabulary).
 */
export const REFUSAL_VOCABULARY: RefusalVocabulary = buildRefusalVocabulary(
  ...BASE_REFUSAL_VOCABULARY_SOURCES,
  SERVER_TEXT_NOTICE_TEMPLATES,
  CLIENT_LINE_TEMPLATES,
  Object.values(CLIENT_NOTICES).map((n) => n.text),
  Object.values(PAPERDOLL_STRINGS),
  useRuleTemplates(EOR_USE_OBJECT_RULES),
  useRuleTemplates(AC1999_USE_OBJECT_RULES),
);

/**
 * A subject that leads a refusal ("Reemer is too busy to accept gifts right now.", "The Drudge Sneak cannot be
 * …"): a run of capitalized words before a refusal predicate. Whatever it is, it leaves as '_'.
 */
const NAME_FIRST = /^((?:[A-Z][A-Za-z'-]*)(?: (?:[A-Z][A-Za-z'-]*|of|the|de|du|van|von|al))*) (?=(?:is|are) (?:too busy|not |unable|already|currently)|(?:cannot|can't|can not|won't|will not|may not|refuses|isn't|aren't) )/;
const NOT_A_SUBJECT = /^(You|Your|You're|This|That|It|There|The|A|An)$/;

/**
 * A line as name-free text: the server template it was built from ('_' per slot), a leading subject as '_',
 * then only the vocabulary's words (scrubToVocabulary). `text` null when that leaves too little to vouch for;
 * `scrubbed` (what a code is hashed from) is name-free either way.
 */
export function nameSafeText(text: string): ScrubResult {
  let t = matchServerTemplate(text);
  const m = NAME_FIRST.exec(t);
  if (m && !NOT_A_SUBJECT.test(m[1].split(' ')[0])) t = '_' + t.slice(m[1].length);
  return scrubToVocabulary(t, REFUSAL_VOCABULARY);
}

/** Anything with a name, as main.ts's object stores hold them. */
export interface NamedThing { name?: string | null; pluralName?: string | null }

/**
 * Every name the client knows, for the reporter's scrub: the player's own, every server object
 * (the 3D world, open containers), and every carried and worn item (the pack and paperdoll records
 * are separate from the 3D object store). Plural names too ("Leather Leggings" / a stack's plural).
 */
export function knownObjectNames(playerName: string | null | undefined, ...sources: Iterable<NamedThing>[]): string[] {
  const out: string[] = [];
  if (playerName) out.push(playerName);
  for (const src of sources) {
    for (const o of src) {
      if (!o) continue;
      if (o.name) out.push(o.name);
      if (o.pluralName) out.push(o.pluralName);
    }
  }
  return out;
}

/* ── context ─────────────────────────────────────────────────────────── */

/** The pending inventory request's kind (InventoryRequest), as a closed token. */
export const PENDING_REQUEST_TOKENS = ['merge', 'split', 'move', 'pick_up', 'put_in_container', 'drop', 'wield', 'shop_event', 'give'] as const;
export type PendingRequestToken = typeof PENDING_REQUEST_TOKENS[number];

const REQUEST_TOKEN: Readonly<Partial<Record<InventoryRequest, PendingRequestToken>>> = Object.freeze({
  [InventoryRequest.Merge]: 'merge',
  [InventoryRequest.Split]: 'split',
  [InventoryRequest.Move]: 'move',
  [InventoryRequest.PickUp]: 'pick_up',
  [InventoryRequest.PutInContainer]: 'put_in_container',
  [InventoryRequest.Drop]: 'drop',
  [InventoryRequest.Wield]: 'wield',
  [InventoryRequest.ShopEvent]: 'shop_event',
  [InventoryRequest.Give]: 'give',
});

/** Where a selected object is, from the client's point of view. */
export const SELECTION_PLACES = ['none', 'self', 'pack', 'worn', 'world', 'unknown'] as const;
export type SelectionPlace = typeof SELECTION_PLACES[number];

/** A week: the ceiling of every duration field. */
export const MAX_DETAIL_MS = 7 * 24 * 3600_000;

/** What pressed Cast (BUG.cast-flood-remaining): a keyboard binding, the mouse (bar, button, bound control), the agent API. */
export const CAST_INPUTS = ['key', 'mouse', 'agent'] as const;
export type CastInput = typeof CAST_INPUTS[number];

export interface RefusalDetail {
  /** The "one item at a time" lock: the pending request's kind. */
  pending?: PendingRequestToken;
  /** How long it had been pending. */
  pendingMs?: number;
  /** A cast refusal: the spell's formula target type (an ItemType mask; 0 = untargeted). */
  spellTargetType?: number;
  /** Where the selection is. */
  selection?: SelectionPlace;
  /** The selected object's ItemType. */
  selectionType?: number;
  /** With nothing selected: where the last selection was (as it resolves now; 'unknown' = gone). */
  prevSelection?: SelectionPlace;
  prevSelectionType?: number;
  /** With nothing selected: how long ago the selection went. */
  selectionGoneMs?: number;
  /** A cast (or its server refusal): what pressed Cast. */
  castInput?: CastInput;
  /** Since the cast press before it (absent for the page's first). */
  castGapMs?: number;
}

/** The pending-request part of the detail, from the tracker's pending record (`time` in seconds). */
export function pendingRequestDetail(pending: { request: InventoryRequest; time: number } | null, nowSec: number): RefusalDetail {
  if (!pending) return {};
  const token = REQUEST_TOKEN[pending.request];
  if (!token) return {};
  const ms = Math.round((nowSec - pending.time) * 1000);
  return Number.isFinite(ms) && ms >= 0 ? { pending: token, pendingMs: Math.min(ms, MAX_DETAIL_MS) } : { pending: token };
}

const uint = (v: unknown, max: number): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : undefined;
const pick = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined => allowed.find((a) => a === v);

/** Only the closed fields, validated (the page side; the bridge repeats it). Empty when nothing is left. */
export function cleanRefusalDetail(d: unknown): RefusalDetail {
  if (!d || typeof d !== 'object') return {};
  const b = d as Record<string, unknown>;
  const out: RefusalDetail = {
    pending: pick(b.pending, PENDING_REQUEST_TOKENS),
    pendingMs: uint(b.pendingMs, MAX_DETAIL_MS),
    spellTargetType: uint(b.spellTargetType, 0xffffffff),
    selection: pick(b.selection, SELECTION_PLACES),
    selectionType: uint(b.selectionType, 0xffffffff),
    prevSelection: pick(b.prevSelection, SELECTION_PLACES),
    prevSelectionType: uint(b.prevSelectionType, 0xffffffff),
    selectionGoneMs: uint(b.selectionGoneMs, MAX_DETAIL_MS),
    castInput: pick(b.castInput, CAST_INPUTS),
    castGapMs: uint(b.castGapMs, MAX_DETAIL_MS),
  };
  for (const k of Object.keys(out) as (keyof RefusalDetail)[]) if (out[k] === undefined) delete out[k];
  return out;
}

/** Where an object is and its ItemType, as main.ts resolves a guid. */
export interface PlacedObject { place: SelectionPlace; itemType?: number }

/**
 * The cast refusal's context: the spell's formula target type, where the selection is and its
 * ItemType; with nothing selected, where the previous selection resolves now ('unknown' once it is
 * gone, e.g. a dead creature's deleted object) and how long ago the selection changed.
 */
export function castRefusalDetail(args: {
  spellTargetType: number;
  selectedGuid: number;
  prevSelectedGuid: number;
  msSinceSelectionChange: number | null;
  placeOf: (guid: number) => PlacedObject;
}): RefusalDetail {
  const d: RefusalDetail = { spellTargetType: args.spellTargetType >>> 0 };
  const typeOf = (o: PlacedObject): number | undefined =>
    typeof o.itemType === 'number' && Number.isFinite(o.itemType) ? o.itemType >>> 0 : undefined;
  if (args.selectedGuid) {
    const o = args.placeOf(args.selectedGuid >>> 0);
    d.selection = o.place;
    const t = typeOf(o); if (t !== undefined) d.selectionType = t;
    return d;
  }
  d.selection = 'none';
  if (args.prevSelectedGuid) {
    const o = args.placeOf(args.prevSelectedGuid >>> 0);
    d.prevSelection = o.place;
    const t = typeOf(o); if (t !== undefined) d.prevSelectionType = t;
  }
  if (args.msSinceSelectionChange !== null && Number.isFinite(args.msSinceSelectionChange)) {
    d.selectionGoneMs = Math.min(MAX_DETAIL_MS, Math.max(0, Math.round(args.msSinceSelectionChange)));
  }
  return d;
}

/**
 * BUG.cast-flood-remaining — each cast press's source and cadence, for the refusal context. AC1999
 * players logged "You're too busy!" at 4-8 a second with held-key repeats already stopped; a press
 * says what made it and how long after the previous one it came, so a roll-up shows whether the
 * casts are a player's presses or something sending them on its own.
 */
export class CastPressTracker {
  private source: CastInput | null = null;
  private lastAt: number | null = null;

  constructor(private readonly now: () => number) {}

  /** Run `f` with `input` as the source of any cast press it makes (none set: the mouse, GameUI's own handlers). */
  during<T>(input: CastInput, f: () => T): T {
    const before = this.source;
    this.source = input;
    try { return f(); } finally { this.source = before; }
  }

  /** A cast press: its source and the gap since the previous one. */
  notePress(): RefusalDetail {
    const at = this.now();
    const d: RefusalDetail = { castInput: this.source ?? 'mouse' };
    if (this.lastAt !== null && Number.isFinite(at - this.lastAt)) d.castGapMs = Math.min(MAX_DETAIL_MS, Math.max(0, Math.round(at - this.lastAt)));
    this.lastAt = at;
    return d;
  }
}
