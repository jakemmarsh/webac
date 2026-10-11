/**
 * What the server's reply to one of the macro's casts says (AgentApi.cast's
 * message: a head line, then the chat lines that followed the cast). VTank
 * counts a cast only on its success line and treats a resist, a fizzle or no
 * answer at all as not landed, so the spell is tried again (MOSS
 * SpellCastTracker / CombatResultText, DebuffScheduler.Observe; facts only).
 *
 * The wording is the same on every server we support:
 * - success: "You cast {spell} on {target}" with an optional ", refreshing …",
 *   ", surpassing …" or ", but it is surpassed by …" (ACE
 *   WorldObject_Magic.CreateEnchantment; GDLE / AC1999 and ClassicDereth
 *   SpellcastingManager_Effects.cpp; ClassicACE the same as ACE).
 *   An item buff cast on yourself is redirected to each worn piece, one line
 *   per piece naming it (ACE TryCastSpell_WithRedirects).
 * - resist: "{target} resists your spell" (ACE WorldObject_Magic.TryResistSpell;
 *   AC1999 SpellcastingManager_Effects.cpp:606/653; ClassicDereth / Seedsow the same).
 * - immune: "You fail to affect {target} with {spell}" (ACE Player_Magic NonProjectileMagicImmune).
 * - components: WeenieError 0x0400 "You don't have all the components for this
 *   spell." (ACE Player_Magic.HasComponentsForSpell; AC1999 WERROR_MAGIC_MISSING_COMPONENTS),
 *   or the client's own pre-check "You do not have all of this spell's components".
 */
import type { AgentResult } from '../types.ts';

/** The server (or the client's pre-check) refused a cast for missing components. */
export const COMPONENTS_MISSING = /don't have all the components|do not have all of this spell's components/i;

/** Reply lines that mean the spell did not take on its target. */
export const CAST_NOT_LANDED = /resists your spell|you fail to affect|is an invalid target|fizzle|don't have|do not have|can't|cannot|not enough|unable|refuse|too busy|out of range/i;

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The chat lines of a cast result (its head line dropped), trimmed. */
export function castReplyLines(res: AgentResult): string[] {
  return res.message.split('\n').slice(1).map((l) => l.trim()).filter(Boolean);
}

/** Whether the server confirmed `spellName` went on: its "You cast …" line, and no resist / failure line. */
export function castConfirmed(res: AgentResult, spellName: string): boolean {
  if (!res.ok) return false;
  const lines = castReplyLines(res);
  if (lines.some((l) => CAST_NOT_LANDED.test(l))) return false;
  const re = new RegExp(`^You cast ${esc(spellName)}(?: on |\\b)`, 'i');
  return lines.some((l) => re.test(l));
}

/**
 * The targets the server named in its success lines for `spellName` ("You
 * cast Acid Bane on Leather Coat, refreshing Acid Bane" → "Leather Coat");
 * "yourself" is left out.
 */
export function castTargetsNamed(res: AgentResult, spellName: string): string[] {
  if (!res.ok) return [];
  const re = new RegExp(`^You cast ${esc(spellName)} on (.+?)(?:, (?:refreshing|surpassing|but it is surpassed by) .*)?\\.?$`, 'i');
  const out: string[] = [];
  for (const l of castReplyLines(res)) {
    const m = re.exec(l);
    if (m && !/^yourself$/i.test(m[1])) out.push(m[1]);
  }
  return out;
}
