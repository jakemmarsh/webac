/**
 * Which skill a spell raises or lowers, and what each skill's spell line is called, from the spell table itself (the
 * portal DAT's SpellTable 0x0E00000E: each spell's name and description). Retail names many lines after something other
 * than their skill: Melee Defense is Invulnerability, Missile Defense Impregnability, Magic Defense Magic Resistance,
 * Run Sprint, Loyalty Fealty, Heavy Weapons Heavy Weapon Mastery. "Melee Defense Other" answered "you don't know a spell
 * matching" (Arcanist, 2026-10-18), with Invulnerability Other V in her book.
 */

/** "Increases the target's Melee Defense skill by 20 points." → { skill: 'Melee Defense', raises: true }; null for any other. */
export function spellSkillMod(desc: string): { skill: string; raises: boolean } | null {
  const m = /^(Increases|Decreases|Raises|Lowers)\s+the\s+(?:target's|caster's)\s+(.+?)\s+skill\b/i.exec(desc.trim());
  if (!m) return null;
  return { skill: m[2].replace(/_/g, ' ').trim(), raises: /^(increases|raises)$/i.test(m[1]) };
}

/** A name's words without "Self" / "Other", the level (I–VIII, 1–8) and a leading "Aura of", as written. */
export function spellLineName(name: string): { line: string; side: 'self' | 'other' | null } {
  let words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length > 1 && /^([IVX]+|[1-8])$/.test(words[words.length - 1])) words = words.slice(0, -1);
  const side = words.some((w) => /^self$/i.test(w)) ? 'self' : words.some((w) => /^other$/i.test(w)) ? 'other' : null;
  words = words.filter((w) => !/^(self|other)$/i.test(w));
  if (words.length > 2 && /^aura$/i.test(words[0]) && /^of$/i.test(words[1])) words = words.slice(2);
  return { line: words.join(' '), side };
}

/** A skill's name as a player types it, for comparing: lower case, "defence" as "defense", one space, no trailing "s". */
export function skillKey(s: string): string {
  return s.toLowerCase().replace(/_/g, ' ').replace(/defence/g, 'defense').replace(/\s+/g, ' ').trim().replace(/s$/, '');
}

/**
 * Each skill's castable spell line (one that comes as Self and Other, levelled), by skillKey: the line that raises it
 * most often in the table (Invulnerability for Melee Defense, not the cantrips "Major Invulnerability" or the item
 * "Aura of Defense"). Only lines whose name differs from the skill's: the rest need no pointing to.
 */
export function skillSpellLines(spells: Iterable<{ name: string; desc: string }>): Map<string, { skill: string; line: string }> {
  const counts = new Map<string, { skill: string; lines: Map<string, number> }>();
  for (const s of spells) {
    const mod = spellSkillMod(s.desc);
    if (!mod?.raises) continue;
    const { line, side } = spellLineName(s.name);
    if (!side || !line) continue;
    const k = skillKey(mod.skill);
    const e = counts.get(k) ?? { skill: mod.skill, lines: new Map<string, number>() };
    counts.set(k, e);
    e.lines.set(line, (e.lines.get(line) ?? 0) + 1);
  }
  const out = new Map<string, { skill: string; line: string }>();
  for (const [k, e] of counts) {
    const best = [...e.lines].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (best && skillKey(best[0]) !== k) out.set(k, { skill: e.skill, line: best[0] });
  }
  return out;
}
