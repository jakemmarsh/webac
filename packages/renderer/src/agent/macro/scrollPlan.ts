/**
 * VirindiTank's ReadUnknownScrolls and the VTClassic Read action
 * (docs/vtank-parity-gaps.md §3.4). Facts from MOSS (openac-mosstank
 * ReadScrollRule / ScrollReading, read for facts only; no code copied):
 *
 * - looting takes a scroll no rule took when ReadUnknownScrolls is on, it
 *   teaches a spell you don't know, and your skill in the spell's school
 *   reaches its difficulty less 15;
 * - a .utl rule with the Read action (VTClassic action 4) takes its item; a
 *   scroll so taken is read under the same test;
 * - reading is a step of its own, later, not part of the pickup: the scroll
 *   is used, and is done with once it is gone (learned, "The scroll is
 *   destroyed.") or the spell is known. A scroll the server refuses ("You are
 *   not skilled enough in …", "You are not trained in …", AC1999's Arcane Lore
 *   floor) is kept unread rather than tried again and again.
 *
 * Each era's server decides what can be learned; the test here only avoids
 * picking up what plainly can't be.
 */

/** ITEM_TYPE Writable (ACE ItemType): scrolls and books. */
export const ITEM_TYPE_WRITABLE = 0x00002000;

/** Magic school (the spell table's) → its skill id. */
export const SCHOOL_SKILL: Record<number, number> = { 1: 34, 2: 33, 3: 32, 4: 31, 5: 43 };

/** The spell a scroll teaches: its examination's spell, else "Scroll of <spell>"; null for anything else. */
export function scrollSpell(item: { name: string; itemType?: number }, props?: { spells?: string[] } | null): string | null {
  if (item.itemType && !(item.itemType & ITEM_TYPE_WRITABLE)) return null;
  const s = props?.spells?.[0];
  if (s) return s;
  const m = /^Scroll of (.+)$/i.exec(item.name);
  return m ? m[1] : null;
}

export interface ScrollContext {
  /** Names of the spells you know (any case). */
  known: ReadonlySet<string>;
  /** The spell table by name: its school and difficulty. */
  spell(name: string): { school: number; power: number } | null;
  /** Your skill, buffed. */
  skill(id: number): number | null;
}

/** VTank's test: unknown to you, in the spell table, and your school skill at least its difficulty − 15. */
export function canReadScroll(spellName: string, ctx: ScrollContext): boolean {
  const lower = spellName.toLowerCase();
  for (const k of ctx.known) if (k.toLowerCase() === lower) return false;
  const sp = ctx.spell(spellName);
  if (!sp) return false;
  const id = SCHOOL_SKILL[sp.school];
  if (id === undefined) return false;
  const have = ctx.skill(id);
  return have !== null && sp.power - 15 <= have;
}

/** A server line refusing a read (ACE Scroll.ActOnUse, the AC1999 server's Scroll.cpp). */
export function isScrollRefusal(line: string): boolean {
  return /^You are not (trained in|skilled enough in) /.test(line) || /^You do not have enough Arcane Lore/.test(line) || /^You already know that spell!/.test(line);
}
