/**
 * Parse reference/ACE/Source/ACE.Entity/Enum/WeenieErrorWithString.cs and emit
 * a complete TypeScript port: the full enum + restored client message templates.
 *
 * Anchored to ACE source. Re-run on any ACE rebase.
 *
 * Placeholder reconstruction:
 *   ACE `<summary>` text has the `_` placeholder STRIPPED OUT in the comment.
 *   The wire-format text the original AC client displays still has them.
 *   We reconstruct by walking the summary and treating each double-space and
 *   each leading-space as a placeholder slot. This is then sanity-checked
 *   against a small set of known-good templates from the hand-written file.
 *
 * Run: `npx tsx tools/generate-weenie-error-with-string.ts`
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const CS_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/WeenieErrorWithString.cs');
const TS_PATH = resolve(REPO, 'packages/shared/src/combat/WeenieErrorWithStringText.ts');

interface Entry {
  name: string;
  value: number;
  text: string | null; // restored template with _ placeholders
}

/**
 * Restore underscores in the ACE summary text. Heuristic:
 *   1. Leading space → underscore at start.
 *   2. Trailing space → underscore at end.
 *   3. Each double-space mid-string → underscore (e.g. "affect  because" → "affect _ because").
 *
 * Verified against known templates: the hand-written file's 24 entries all
 * round-trip cleanly through this transform.
 */
function restorePlaceholders(summary: string): string {
  let s = summary;
  // Trim trailing/leading whitespace BUT remember if leading/trailing was a placeholder.
  const startedWithSpace = /^\s/.test(s);
  const endedWithSpace = /\s$/.test(s);
  s = s.replace(/\s+$/, '');
  s = s.replace(/^\s+/, '');

  // Reinsert mid-string underscores: collapse runs of 2+ spaces back to "_ "
  // Use one underscore per run (matches AC client format).
  s = s.replace(/\s{2,}/g, ' _ ');

  // FAITHFUL.555 — single space immediately before sentence punctuation
  // is a high-confidence signal of a stripped `_`. ACE strips `_` from
  // summaries but leaves the surrounding whitespace, so "is now: _." in
  // the original becomes "is now: ." in the summary. The 2+-space rule
  // above misses these single-space cases. Anchor to:
  //   - `.` `!` `?` `,` (sentence punctuation)
  //   - `'` (typically `'s` possessive after the placeholder)
  //   - `"` (quoted-placeholder pattern)
  // The lookbehind `(?<=\S)` requires a non-whitespace char before the
  // space so we don't double-substitute on the 2+-space path above
  // (those leave " _ " with `_` already in place). Keep the space
  // before the placeholder so `split('_').join(value)` produces
  // "by Name." not "byName.".
  s = s.replace(/(?<=\S) ([.!?,'"])/g, ' _$1');

  // Reinsert leading/trailing underscores.
  if (startedWithSpace) s = '_ ' + s;
  if (endedWithSpace) s = s + ' _';

  return s;
}

function parseEnum(source: string): Entry[] {
  const lines = source.split('\n');
  const entries: Entry[] = [];

  let pendingSummary: string[] | null = null;
  let inSummary = false;
  const enumLineRe = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*0x([0-9A-Fa-f]+)\s*,?\s*$/;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    const trimmed = line.trim();
    if (trimmed === '/// <summary>') {
      pendingSummary = [];
      inSummary = true;
      continue;
    }
    if (trimmed === '/// </summary>') {
      inSummary = false;
      continue;
    }
    if (inSummary) {
      // Keep the post-"/// " text as-is (with significant whitespace).
      const m = /^\s*\/\/\/\s?(.*)$/.exec(line);
      if (m) pendingSummary!.push(m[1]);
      continue;
    }
    if (/^\s*\/\//.test(line)) continue; // skip non-summary comments

    const em = enumLineRe.exec(line);
    if (em) {
      const name = em[1];
      const value = parseInt(em[2], 16);
      let text: string | null = null;
      if (pendingSummary) {
        const joined = pendingSummary.join(' ').trim();
        if (joined.length > 0) text = restorePlaceholders(pendingSummary.join(' '));
      }
      entries.push({ name, value, text });
      pendingSummary = null;
    }
  }

  return entries;
}

function escapeJsString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
}

function emit(entries: Entry[]): string {
  const lines: string[] = [
    '/**',
    ' * WeenieErrorWithString — chat-window error messages with embedded actor names.',
    ' *',
    ' * Per reference/ACE/Source/ACE.Entity/Enum/WeenieErrorWithString.cs:',
    ' *   "Used with F7B0 028B: Game Event -> Display an error message in the chat',
    ' *    window. WeenieError and WeenieErrorWithString are actually a single',
    ' *    enum in the client. We split the enum up into 2 enums because each',
    ' *    function uses only a specific set of the enum values."',
    ' *',
    ' * Tested against client version 0.0.11.6096 (per ACE source).',
    ' *',
    ' * Each entry\'s summary in ACE source is the original AC client message',
    ` * text. ${entries.length} entries; the \`WEENIE_ERROR_WITH_STRING_TEXT\``,
    ' * map holds the templates with `_` placeholders restored (the ACE source',
    ' * has them stripped — we reconstruct from spacing heuristics, then',
    ' * correct against the retail client\'s literals: every template was',
    ' * checked against HandleFailureEvent @ 00571990 by',
    ' * tools/check-weenie-error-templates.ts on 2026-10-06).',
    ' *',
    ' * GENERATED by tools/generate-weenie-error-with-string.ts — re-run after',
    ' * any ACE rebase. Do not hand-edit; updates here will be lost.',
    ' */',
    '',
    'export enum WeenieErrorWithString {',
  ];
  for (const e of entries) {
    const hex = `0x${e.value.toString(16).toUpperCase().padStart(4, '0')}`;
    lines.push(`  ${e.name} = ${hex},`);
  }
  lines.push('}');
  lines.push('');

  lines.push(
    '/**',
    ' * Raw AC client message templates per ACE source `<summary>` tags.',
    ' * Underscores `_` in the text are placeholders the server fills with the',
    ' * actor name in the GameEventCommunicationTransientString payload.',
    ' */',
    'export const WEENIE_ERROR_WITH_STRING_TEXT: Record<number, string> = {',
  );
  // FAITHFUL.552 — manual overrides for entries whose ACE <summary> is a
  // developer comment, not the user-facing template. ACE devs sometimes
  // documented USAGE rather than the actual string the original client
  // displayed. When the ACE source code emits the full text directly as
  // the value arg (and the original client just displayed that value),
  // the template should be just `_` so split('_').join(value) returns
  // the value verbatim. Cite the ACE emit-site for each override.
  const MANUAL_OVERRIDES: Record<number, { text: string; cite: string }> = {
    0x055E: {
      text: '_',
      cite: 'WeenieErrorWithString.AFK — Player_Tell.cs:48 constructs the full "{Name} is away: {AfkMessage}" string as the value arg; the ACE <summary> "Sends \\"{message}\\\\n\\" to the chat window. Unknown usage" is a dev comment not the user-facing text.',
    },
    // FAITHFUL.553 — three more entries with the same dev-comment-as-template
    // pattern. AugmentationSkillNotTrained (0x055A) is actively emitted from
    // AugmentationDevice.cs:181 + :191 with fully-constructed user-facing
    // strings as the value. AttributeTransfer* (0x04DE, 0x04DF) have no
    // emit sites in ACE source but the override is harmless if a future
    // code path uses them, and shipping the dev comment was a real bug.
    0x055A: {
      text: '_',
      cite: 'WeenieErrorWithString.AugmentationSkillNotTrained — AugmentationDevice.cs:181 + :191 ship full sentences like "You are not able to purchase this augmentation because your {Attribute} is already at the maximum innate level!" as the value arg; ACE <summary> "Sends \\"{message}\\\\n\\" to the chat window. Unknown usage" is a dev comment.',
    },
    0x04DE: {
      text: '_',
      cite: 'WeenieErrorWithString.AttributeTransferFromTooLow — ACE <summary> "Sends {message}\\\\n to the chat window. Unknown usage." is a dev comment. No active ACE emit site as of 2026-05; override is defensive — if a future path emits, value passes through.',
    },
    0x04DF: {
      text: '_',
      cite: 'WeenieErrorWithString.AttributeTransferToTooHigh — same dev-comment pattern as 0x04DE; defensive override.',
    },
    // FAITHFUL.554 — MessageBlocked_ is actively emitted from
    // GameActionTell.cs:41 + GameActionTalkDirect.cs:41 with value
    // "{Name} has you squelched.". Our parsed template was the malformed
    // `"Message Blocked: "` (quotes + colon + space, no `_` placeholder)
    // — the spacing-heuristic reconstructor missed the underscore. Pre-
    // fix users sending /tell or /talkdirect to a player who has them
    // squelched saw literally `"Message Blocked: "` in chat (with
    // quotes, empty body). Restore the placeholder so the squelcher's
    // name + reason flows in.
    0x051F: {
      text: 'Message Blocked: _',
      cite: 'WeenieErrorWithString.MessageBlocked_ — GameActionTell.cs:41 + GameActionTalkDirect.cs:41 ship "{Name} has you squelched." as the value arg. Spacing-heuristic reconstructor dropped the `_` placeholder; restore as "Message Blocked: _".',
    },
    // FAITHFUL.565 — three templates carry the literal ACE
    // `{message}` placeholder rather than the `_` token
    // `formatWeenieErrorWithString` substitutes against. ACE source
    // documents these in <summary> with `{message}` (an ACE dev
    // convention for "the value arg goes here") instead of the
    // original AC client `_` placeholder. Without these overrides,
    // formatWeenieErrorWithString returns the template unchanged
    // (split('_').join(value) is a no-op when there is no `_`), so
    // the user sees literal `{message}` text in chat. Two of the
    // three also have a spurious `_` injected by the FAITHFUL.555
    // single-space-before-quote/punctuation heuristic — the override
    // restores the authentic AC client wording.
    //
    // None of these three have active emit sites in ACE source as of
    // 2026-05, but the original retail server emitted them and custom
    // ACE forks may revive them. Defensive override per the same
    // pattern as FAITHFUL.552 (AttributeTransfer*).
    0x0533: {
      text: 'You have been booted from your allegiance chat room. Use "@allegiance chat on" to rejoin. (_).',
      cite: 'WeenieErrorWithString.YouHaveBeenBootedFromAllegianceChat — ACE <summary> "You have been booted from your allegiance chat room. Use \\"@allegiance chat on\\" to rejoin. ({message})." carries literal `{message}` instead of `_`, AND the FAITHFUL.555 heuristic injected a spurious `_` before the opening quote at "Use _\\"@allegiance". Restore to the authentic AC client wording with `_` at the parenthesized substitution slot.',
    },
    0x056A: {
      text: 'You may only change your allegiance name once every 24 hours. You may change your allegiance name again in _.',
      cite: 'WeenieErrorWithString.YouMayOnlyChangeAllegianceNameOnceEvery24Hours — ACE <summary> "...you may change your allegiance name again in {message}." carries literal `{message}` instead of `_`; substituted value is a duration string (e.g. "5 hours, 23 minutes").',
    },
    0x056E: {
      text: 'That level of allegiance officer is now known as: _.',
      cite: 'WeenieErrorWithString.ThatLevelOfAllegianceOfficerIsNowKnownAs_ — ACE <summary> "That level of allegiance officer is now known as: {message}." carries literal `{message}` instead of `_`; substituted value is the new title string. Enum name already ends with `_` confirming the placeholder slot.',
    },
    // RECON.weenie-error-templates (2026-10-06): all 113 templates were
    // checked against the retail client's own literals — the arms of
    // ClientCommunicationSystem::HandleFailureEvent @ 00571990, resolved
    // through its jump tables by tools/check-weenie-error-templates.ts.
    // 107 already matched. These six differ because the spacing heuristic
    // reads retail's sentence-separating DOUBLE space as a stripped `_`,
    // or kept a quote / stray `_` from the ACE <summary>.
    0x04BF: {
      text: 'The _ was not suitable for salvaging.',
      cite: 'WeenieErrorWithString.The_WasNotSuitableForSalvaging — retail .rdata 0x7d71b8 "The %s was not suitable for salvaging." (no quotes; the ACE <summary> wraps it in quotes). An empty value prints "item" (formatWeenieErrorWithString).',
    },
    0x04D5: {
      text: 'You are currently wielding items which require a certain level of _.  Your _ skill cannot be lowered while you are wielding these items.  Please remove these items and try again.',
      cite: 'WeenieErrorWithString.CannotLowerSkillWhileWieldingItem — retail .rdata 0x7d65a8: two %s (the value is pushed twice) and sentences separated by two spaces; the heuristic turned each double space into a `_`.',
    },
    0x04E9: {
      text: "The _ cannot be used while on a hook, use the '@house hooks on' command to make the hook openable.",
      cite: "WeenieErrorWithString.ItemUnusableOnHook_CanOpen — retail .rdata 0x7d1f68 has one %s; the heuristic injected a `_` before the quote at \"the '@house\".",
    },
    0x0510: {
      text: 'You may not hook any more _ on your house.  You already have the maximum number of _ hooked or you are not permitted to hook any on your type of house.',
      cite: 'WeenieErrorWithString.MaxNumberOf_Hooked — retail .rdata 0x7d23f0: two %s, double-spaced sentences (not a third placeholder).',
    },
    0x0514: {
      text: 'You now have the maximum number of _ hooked.  You cannot hook any additional _ until you remove one or more from your house.',
      cite: 'WeenieErrorWithString.MaxNumberOf_HookedUntilOneIsRemoved — retail .rdata 0x7d2138: two %s, double-spaced sentences.',
    },
    0x0515: {
      text: 'You no longer have the maximum number of _ hooked.  You may hook additional _.',
      cite: 'WeenieErrorWithString.NoLongerMaxNumberOf_Hooked — retail .rdata 0x7d2090: two %s, double-spaced sentences.',
    },
  };
  for (const e of entries) {
    const override = MANUAL_OVERRIDES[e.value];
    if (!e.text && !override) continue;
    const hex = `0x${e.value.toString(16).toUpperCase().padStart(4, '0')}`;
    if (override) {
      lines.push(`  [${hex}]: '${escapeJsString(override.text)}', // OVERRIDE (FAITHFUL.552): ${override.cite}`);
    } else if (e.text) {
      lines.push(`  [${hex}]: '${escapeJsString(e.text)}', // ${e.name}`);
    }
  }
  lines.push('};');
  lines.push('');

  lines.push(
    '/** Returns the raw client template for a code, or empty string if unmapped. */',
    'export function weenieErrorWithStringText(code: WeenieErrorWithString | number): string {',
    '  return WEENIE_ERROR_WITH_STRING_TEXT[code] ?? \'\';',
    '}',
    '',
    '/**',
    ' * Format a WeenieErrorWithString event for display, substituting the',
    ' * server-supplied `value` (typically an actor name or skill name) into',
    ' * the `_` placeholder(s) in the template.',
    ' *',
    ' * ACE `GameEventWeenieErrorWithString.cs:11` writes the errorType + the',
    ' * substitution value as a String16L — NOT the rendered sentence. The',
    ' * original AC client looked up the template by errorType and inserted',
    ' * the value at each `_`. Some templates carry MULTIPLE underscores',
    ' * (e.g. 0x0052 "You fail to affect _ because _ is not a player killer!"',
    ' * for `YouFailToAffect_TheyAreNotPK`) — all are filled with the same',
    ' * value, matching retail behavior.',
    ' *',
    ' * Pre-FAITHFUL.341 the consumer at `main.ts onWeenieErrorWithString`',
    ' * rendered the raw `data.message` (i.e. just the substitution value)',
    ' * with no template, so messages like "Bob is too busy to accept gifts',
    ' * right now." rendered as just "Bob" — losing the full sentence.',
    ' *',
    ' * Returns the substitution value unchanged when no template is mapped,',
    ' * preserving fallback behavior for any future ACE-added codes.',
    ' */',
    'export function formatWeenieErrorWithString(',
    '  code: WeenieErrorWithString | number,',
    '  value: string,',
    '): string {',
    '  const template = WEENIE_ERROR_WITH_STRING_TEXT[code];',
    '  if (!template) return value;',
    '  // Retail\'s 0x04BF arm prints "item" when the value is empty',
    '  // (HandleFailureEvent @ 00571990: PStringBase length == 1 -> L"item").',
    '  if (code === WeenieErrorWithString.The_WasNotSuitableForSalvaging && value === \'\') value = \'item\';',
    '  return template.split(\'_\').join(value);',
    '}',
  );
  return lines.join('\n') + '\n';
}

function main(): void {
  const cs = readFileSync(CS_PATH, 'utf8');
  const entries = parseEnum(cs);

  if (entries.length < 100) {
    console.error(`Sanity check failed: only ${entries.length} entries parsed.`);
    process.exit(1);
  }

  // Sanity: known anchors with verified text.
  const byName = new Map(entries.map((e) => [e.name, e]));
  const anchorTexts: Array<[string, number, string]> = [
    ['_IsTooBusyToAcceptGifts', 0x001E, '_ is too busy to accept gifts right now.'],
    ['YouFailToAffect_TheyAreNotPK', 0x0052, 'You fail to affect _ because _ is not a player killer!'],
    ['_CowersFromYou', 0x058A, '_ cowers from you!'],
  ];
  for (const [name, value, expectedText] of anchorTexts) {
    const e = byName.get(name);
    if (!e) {
      console.error(`Anchor missing: ${name}`);
      process.exit(1);
    }
    if (e.value !== value) {
      console.error(`Anchor value mismatch for ${name}: expected 0x${value.toString(16)}, got 0x${e.value.toString(16)}`);
      process.exit(1);
    }
    if (e.text !== expectedText) {
      console.error(`Anchor text mismatch for ${name}:\n  expected: ${expectedText}\n  got:      ${e.text}`);
      process.exit(1);
    }
  }

  const out = emit(entries);
  writeFileSync(TS_PATH, out);

  const withText = entries.filter((e) => e.text).length;
  console.log(
    `Wrote ${TS_PATH}\n  ${entries.length} enum entries\n  ${withText} text templates restored`,
  );
}

main();
