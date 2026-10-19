/**
 * Text that reaches a player from a string-table lookup.
 *
 * A string-table entry can be a bare `ID_*` token instead of text: the EoL
 * (and both Dark Majesty) client_local_English.dat store
 * ID_CHAR_ERROR_ENTER_GAME_GENERIC's entry as the literal
 * "ID_CHAR_ERROR_ENTER_GAME_OLD_CHARACTER", and a lookup whose table is not
 * loaded used to fall back to its own token (the chargen refusal dialogs).
 * Either way the player read an internal resource name. These helpers take
 * the DAT text when it is real text and the plain-English fallback otherwise.
 */

/** A string-table token rather than text: `ID_` plus identifier characters, nothing else. */
const TOKEN_RE = /^ID_[A-Za-z0-9_]+$/;

/** True when `s` is a bare `ID_*` resource token (what a player must never be shown). */
export function isStringToken(s: string | null | undefined): boolean {
  return typeof s === 'string' && TOKEN_RE.test(s.trim());
}

/**
 * The DAT text when it is real text, else `fallback`: null / undefined /
 * empty / whitespace-only and bare `ID_*` tokens all take the fallback.
 */
export function playerText(datText: string | null | undefined, fallback: string): string {
  if (typeof datText !== 'string' || datText.trim() === '' || isStringToken(datText)) return fallback;
  return datText;
}

/**
 * Retail text, then one blank line, then one plain next-step sentence (the
 * shape every refusal's hint takes). The text's trailing blanks are dropped
 * first so the gap is always exactly one blank line. No hint → the text alone.
 */
export function withNextStep(text: string, nextStep: string | null | undefined): string {
  if (!nextStep) return text;
  return `${text.replace(/\s+$/, '')}\n\n${nextStep}`;
}
