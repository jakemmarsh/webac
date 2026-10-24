/**
 * TELEMETRY.refusal-name-safety — a refusal event's text is name-free BY CONSTRUCTION.
 *
 * Production (build 1e71a1abb705, 2026-10-23): end-of-retail clients posted ACE's fellowship
 * consent notice "Reemer has given you permission to loot his or her kills." (Fellowship.cs:171)
 * as a `client_refusal`, eight other players' names in our logs. The page's scrub only knew the
 * names of objects the client had; a name the server put in a line went straight out.
 *
 * So the text no longer keeps what the scrub missed, it keeps only what it can vouch for: every
 * word must be a word of the retail / server templates the client ships (the vocabulary: the
 * WeenieError and WeenieErrorWithString texts, the attempt-failed lines, the skill names, plus
 * whatever template tables the caller adds). Any other word becomes '_' (a name, an unknown
 * object, an unknown word alike), a quoted string becomes '_', and a line in a speech shape
 * ("You tell", "tells you", "says,") gives no text at all. A line that is mostly '_' after that
 * gives no text either (its code and context still go): it can't be told from a name.
 *
 * The page (renderer telemetry/RefusalReporter.ts) runs it with the full vocabulary; the bridge
 * (services/ws-tcp-bridge/src/clientRefusal.ts) runs `textCarriesUnknownWord` with this file's
 * base vocabulary as defence in depth and drops a text that still carries an unknown capitalized
 * word.
 */
import { weenieErrorText } from '../combat/WeenieErrorText.js';
import { WEENIE_ERROR_WITH_STRING_TEXT } from '../combat/WeenieErrorWithStringText.js';
import { ATTEMPT_FAILED_VERB, ATTEMPT_FAILED_SUFFIX } from '../inventory/InventoryRequest.js';
import { SkillId } from '../ace-enums.js';

/** A word as the scrub reads it: letters, with inner apostrophes ("can't", "you're", "Bob's"). */
const WORD = /[A-Za-z]+(?:'[A-Za-z]+)*/g;
const isCap = (w: string): boolean => w[0] >= 'A' && w[0] <= 'Z';

export interface RefusalVocabulary {
  /** Every word as written in some template (case kept): a capitalized word passes only as one of these. */
  readonly exact: ReadonlySet<string>;
  /** Every word, lower-cased: a lower-case word passes as one of these. */
  readonly lower: ReadonlySet<string>;
}

/** Template strings' words; '_' and printf slots are not words. */
export function buildRefusalVocabulary(...sources: Iterable<string | null | undefined>[]): RefusalVocabulary {
  const exact = new Set<string>();
  const lower = new Set<string>();
  for (const src of sources) {
    for (const s of src) {
      if (typeof s !== 'string') continue;
      for (const m of s.replace(/%[hl]?[sdufx]/g, ' ').matchAll(WORD)) {
        exact.add(m[0]);
        lower.add(m[0].toLowerCase());
      }
    }
  }
  return { exact, lower };
}

/** "ArcaneLore" → "Arcane Lore" (SkillId keys). */
const splitCamel = (k: string): string => k.replace(/([a-z])([A-Z])/g, '$1 $2');

/** Every WeenieError text (0x0000-0x0FFF) the client ships. */
export const WEENIE_ERROR_TEXTS: readonly string[] = Object.freeze((() => {
  const out: string[] = [];
  for (let c = 1; c < 0x1000; c++) { const t = weenieErrorText(c); if (t) out.push(t); }
  return out;
})());

/** The server-side template strings the client knows ('_' = a substituted value). */
export const SERVER_REFUSAL_TEMPLATES: readonly string[] = Object.freeze([
  ...WEENIE_ERROR_TEXTS,
  ...Object.values(WEENIE_ERROR_WITH_STRING_TEXT),
]);

/**
 * Words every refusal shape is built from (REFUSAL_TEXT's own alternatives, the common sentence starts), the
 * attributes and vitals, the capitalized words of the renderer's client tables (so a text the page vouches
 * for never fails the bridge's check: tests pin that), and common lower-case words of the servers' plain-text
 * refusals (GDLE / AC1999 SendText: "Not enough pack space!", "You can't do that yet!"). Lower-case words only
 * past the first lines: a capitalized word here is one a page may send.
 */
export const REFUSAL_SHAPE_WORDS: readonly string[] = Object.freeze([
  "You you You're you're Your your Not not enough Unable unable Invalid invalid Only only Can't can't Cannot cannot",
  "Couldn't couldn't Could could This this That that It it There there The the A a An an No no Nothing nothing",
  'Strength Endurance Coordination Quickness Focus Self Health Stamina Mana Pyreal Pyreals',
  'To High Medium Low Cast Approaching Using Choose Select Casting AutoRun ON OFF Portal Storm Logging Reconnecting',
  'ACE Account Swearing Some',
  "is isn't are aren't do don't does doesn't must lack have has no need may fail too busy recently encumbered far",
  'heavy low soon allowed permitted permission command yet here now right accept gifts skill level loot kills',
  'corpse corpses learn pack space room inventory container open closed close locked unlock lock key door',
  'pick up first drop give wield wear equip unequip use used using move moved carry carrying hold holding',
  'cast casting spell spells target targets item items object objects someone something anyone anything',
  'already currently while during after before again later yet still more less than enough many much',
  'buy sell afford money trade trading vendor fellowship allegiance member members join leave',
  'dead alive combat mode peace attack attacking fight fighting run walk jump stand sit sleep',
  'here there where away near close far reach range distance sight line view',
  'not now never only just even also very so such',
  // TELEMETRY.refusal-vocabulary-sweep (2026-10-24): lower-case words of the fixed-text (no %s, no name slot)
  // player lines the emulator servers send that the lines above lacked. Swept from SendText /
  // NotifyWeenieError-style literals in reference/ac1999/Server/Source, reference/classic/ClassicDereth/Source
  // and reference/classic/Seedsow/Source, and GameMessageSystemChat / GameEventCommunicationTransientString
  // literals in reference/ACE/Source/ACE.Server; admin / developer command output left out. Prod sent
  // AC1999's "You're exhausted!" (Healer.cpp:175/222, also ClassicDereth Healer.cpp:209/235 and the melee /
  // missile attack paths) as t:ea7955f8 ("You're _!") with no text, one word short; it is t:41d888ba now, text
  // kept. Game-only terms (aetheria, luminance) and debug words left out. Ordinary English only, never
  // capitalized: a capitalized word in a line still passes only through `exact`, so these can't vouch for a name.
  'exhausted disrupted damage taken hit found compatible dequip existing piece onto appearance',
  'storage dwellings houses guests public private owning maintenance paid costs period next due reverted',
  'stored lost abandoned monarchy day grant revoked tied tie bound primary secondary recallable summoned',
  'unsummon pet pets raise lower innate completed ago consumed without visible invisible hidden radar',
  'attackable mortal immortal protected dispelled ungag general muted sending messages friend should really',
  'tailor tailoring retained property claimed lockpicked slots main sold locate create result results',
  'request requested processing amount large choices teleporting die fully charges device refill recover',
  "returned current enchantments prevents always dismiss multiple transfer those them but did hasn't gain",
  'play reached penalty reduced increased greatly accepted learned changes active activated outdoors',
  'encounter previous location return restriction restrictions apply permanent permit consent looting match types',
  'find meet requirement scroll show effect destroyed great understand environment made landscape prepay',
  'came forbids resist coins supported surface specified send force world timer attuned search renewed',
  'opportunity dungeon dungeons squelch ban ranks running round serve',
]);

/** The base vocabulary's sources: the server templates, the attempt-failed lines, the skill names and the shape words. */
export const BASE_REFUSAL_VOCABULARY_SOURCES: readonly (readonly string[])[] = Object.freeze([
  SERVER_REFUSAL_TEMPLATES,
  Object.values(ATTEMPT_FAILED_VERB).map((v) => v!.template),
  Object.values(ATTEMPT_FAILED_SUFFIX),
  Object.keys(SkillId).filter((k) => Number.isNaN(Number(k))).map(splitCamel),
  REFUSAL_SHAPE_WORDS,
]);

/** The base vocabulary (the bridge's). The page's adds its client tables (renderer RefusalTemplates.ts). */
export const BASE_REFUSAL_VOCABULARY: RefusalVocabulary = buildRefusalVocabulary(...BASE_REFUSAL_VOCABULARY_SOURCES);

/** A line in a speech shape: a tell, a say, an emote's speech. Never sent, whatever else it holds. */
export const SPEECH_SHAPE = /\b(you tell|tells you|says,|you say,|whispers,|you whisper|shouts,|tells your)|^\[[^\]]*\]/i;

export interface ScrubResult {
  /** The text with every word outside the vocabulary as '_', or null when it can't be sent. */
  text: string | null;
  /** The scrubbed text whether or not it can be sent ('' for a speech shape): what a code is hashed from. */
  scrubbed: string;
  /** Words kept. */
  kept: number;
  /** Words replaced. */
  replaced: number;
}

/**
 * Every word of `text` that the vocabulary doesn't vouch for becomes '_' (runs of '_' collapse to one);
 * quoted strings become '_'. `text` null for a speech shape, a line with fewer than two words kept, or
 * more words replaced than kept.
 */
export function scrubToVocabulary(text: string, vocab: RefusalVocabulary = BASE_REFUSAL_VOCABULARY): ScrubResult {
  if (SPEECH_SHAPE.test(text)) return { text: null, scrubbed: '', kept: 0, replaced: 0 };
  let kept = 0;
  let replaced = 0;
  const unquoted = text
    .replace(/["“”][^"“”]*["“”]/g, '_')
    .replace(/(^|[\s(:])'[^']+'(?=[\s.,!?;:)]|$)/g, '$1_');
  let out = unquoted.replace(WORD, (w) => {
    const base = /'s$/i.test(w) ? w.slice(0, -2) : w;
    const ok = isCap(base) ? vocab.exact.has(base) || vocab.exact.has(w) : vocab.lower.has(w.toLowerCase()) || vocab.lower.has(base.toLowerCase());
    if (ok) { kept++; return w; }
    replaced++;
    return '_';
  });
  out = out.replace(/_(?:[\s'-]*_)+/g, '_').replace(/_'s\b/g, '_');
  if (kept < 2 || replaced > kept) return { text: null, scrubbed: out, kept, replaced };
  return { text: out, scrubbed: out, kept, replaced };
}

/**
 * The bridge's check: does an (already templated) text still carry a capitalized word the base vocabulary
 * doesn't know, a quoted string or a speech shape? Such a text is dropped, the code kept.
 */
export function textCarriesUnknownWord(text: string, vocab: RefusalVocabulary = BASE_REFUSAL_VOCABULARY): boolean {
  if (SPEECH_SHAPE.test(text)) return true;
  if (/["“”]/.test(text)) return true;
  for (const m of text.matchAll(WORD)) {
    const w = m[0];
    const base = /'s$/i.test(w) ? w.slice(0, -2) : w;
    if (isCap(base) && !vocab.exact.has(base) && !vocab.exact.has(w)) return true;
  }
  return false;
}
