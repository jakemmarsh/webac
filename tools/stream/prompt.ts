/**
 * What each player session is told: the shared brief plus its personality (the appended system prompt), the segment's
 * opening message (journal, last report, partner, time), and the supervisor's later messages (keep going, wrap up,
 * the stream is ending). Information a player has, never play decisions (Jake: no hardcoded behaviour).
 */
import type { AgentItem } from '../../packages/renderer/src/agent/types.ts';
import { emptySlotsText, gearView, hasGearData } from '../../packages/renderer/src/agent/gear.ts';
import type { CharacterConfig } from './config.ts';
import { type KnownSpell, type TableSpell, spellGaps } from './spellGaps.ts';

/** Tools a player has no use for (the supervisor starts and stops sessions) or that aren't for one character. */
const NOT_FOR_PLAYERS = new Set(['start', 'stop', 'sessions', 'enter_world', 'status', 'click', 'trace', 'keys']);

/** The agent CLI's tool names for the brief's {{TOOLS}} (the list `./ac help` would print, without its 14 KB of descriptions). */
export function playerToolNames(names: readonly string[]): string {
  return names.map((n) => n.replace(/^ac_/, '')).filter((n) => !NOT_FOR_PLAYERS.has(n)).join(', ');
}

export function fillBrief(brief: string, c: CharacterConfig, partner: string, tools = ''): string {
  return brief.replaceAll('{{CHARACTER}}', c.character).replaceAll('{{PROFILE}}', c.profile).replaceAll('{{PARTNER}}', partner).replaceAll('{{TOOLS}}', tools);
}

/** The appended system prompt: the brief, then who this character is. */
export function systemPrompt(brief: string, c: CharacterConfig, partner: string, tools = ''): string {
  const parts = [fillBrief(brief, c, partner, tools).trim()];
  if (c.personality.trim()) parts.push(`**Your character: ${c.character}.**\n${c.personality.trim()}`);
  return parts.join('\n\n');
}

const clock = (ms: number): string => new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

/** The opening user message of a segment. */
export function segmentOpening(s: {
  c: CharacterConfig;
  partner: string;
  segment: number;
  nowMs: number;
  playMinutes: number;
  journal: string;
  lastReport: string | null;
  /** readinessBrief() for the character, or null. */
  readiness?: string | null;
}): string {
  const lines = [
    `[supervisor] Segment ${s.segment} of the stream starts now (${clock(s.nowMs)}). You are ${s.c.character} (profile ${s.c.profile}), in the world now; ${s.partner} is playing too.`,
    `Play until I tell you to wrap up, in about ${Math.round(s.playMinutes)} minutes. Start with \`./ac observe max=10\` and \`./ac character\`, set your \`goal\`, then find your partner.`,
  ];
  if (s.segment === 1 && s.c.startNotes.trim()) lines.push('', s.c.startNotes.trim());
  if (s.c.goal?.trim()) lines.push('', `The plan for now: ${s.c.goal.trim()}`);
  if (s.readiness?.trim()) lines.push('', s.readiness.trim());
  lines.push('', 'Your journal:', s.journal.trim() || '(empty)');
  if (s.lastReport?.trim()) lines.push('', 'What you wrote at the end of your last segment:', clipReport(s.lastReport));
  return lines.join('\n');
}

/**
 * The gaps in what the character wears, from its inventory (agent/gear.ts): bare body parts, parts with clothing and no
 * armor, pack items that would fill an empty slot, and worn pieces never appraised. Empty when there is nothing to say
 * (gear complete, or a tab too old to say where items go). Facts only: what to do about them is the player's call.
 */
export function gearGaps(items: readonly AgentItem[] | null): string[] {
  if (!items || !hasGearData(items)) return [];
  const v = gearView(items);
  const out: string[] = [];
  if (v.emptyParts.length) out.push(`- gear: nothing worn: ${emptySlotsText(v.emptyParts)}`);
  if (v.clothingOnly.length) out.push(`- gear: clothing only, no armor over it: ${v.clothingOnly.join(', ')}`);
  if (v.packFills.length) out.push(`- gear: in your pack, would fill an empty slot: ${v.packFills.map((f) => `${f.items.join(' or ')} (${f.slot})`).join('; ')}`);
  if (v.unknownArmor.length) {
    const n = v.unknownArmor.length;
    out.push(`- gear: ${n} worn piece${n === 1 ? '' : 's'} with unknown armor level (${v.unknownArmor.join(', ')}): appraise to compare`);
  }
  return out;
}

/** Healing kits, health potions and mana potions carried, by name (ACE's Healer weenies are "… Healing Kit", "… Health Kit", "Renegade Herbal Kit", "Olthoi … Healing Tissue"; its restoring potions "Potion of Healing", "Healing Tonic", "Mana Potion", "… Health Elixir", "… Mana Elixir", "… Draught"). */
export function recoveryCounts(items: readonly AgentItem[]): { kits: number; health: number; mana: number } {
  const n = { kits: 0, health: 0, mana: 0 };
  for (const it of items) {
    if (it.where === 'equipped') continue;
    const q = it.stack ?? 1;
    const name = it.name;
    if (/\b(?:Healing|Health|Herbal) Kit\b|\bHealing Tissue\b/i.test(name)) n.kits += q;
    else if (/\b(?:Potion|Tonic|Elixir|Draught)\b/i.test(name)) {
      if (/\bMana\b/i.test(name)) n.mana += q;
      else if (/\b(?:Heal|Healing|Health)\b/i.test(name)) n.health += q;
    }
  }
  return n;
}

/** Unassigned XP and skill credits from the character sheet's XP line (GameUI.agentCharacterSheet), or null. */
export function unspent(sheet: string | null): { xp: number; credits: number } | null {
  const m = sheet ? /\bXP [\d,]+ total, ([\d,]+) unassigned\b.*?; (\d+) skill credits?/.exec(sheet) : null;
  return m ? { xp: Number(m[1].replace(/,/g, '')), credits: Number(m[2]) } : null;
}

/**
 * The levels ahead that grant skill credits, from the sheet's "Next skill credits: level 23 (+1), level 26 (+1)" line
 * (GameUI.agentCharacterSheet reads it from this era's XpTable characterLevelSkillCreditList); [] when absent.
 */
export function nextCreditLevels(sheet: string | null): Array<{ level: number; credits: number }> {
  const line = sheet ? /^Next skill credits: (.+)$/m.exec(sheet) : null;
  return line ? [...line[1].matchAll(/level (\d+) \(\+(\d+)\)/g)].map((m) => ({ level: Number(m[1]), credits: Number(m[2]) })) : [];
}

/** "skill credits: 6 now; next at level 23 (+1) and 26 (+1)" (or just "6 now" when the sheet names no level ahead). */
export function creditsLine(credits: number, next: ReadonlyArray<{ level: number; credits: number }>): string {
  const at = next.map((n, i) => `${i === 0 ? 'level ' : ''}${n.level} (+${n.credits})`).join(' and ');
  return `skill credits: ${credits} now${at ? `; next at ${at}` : ''}`;
}

/**
 * The opening message's readiness block: gear gaps, unspent XP, skill credits and the levels that grant the next ones, the
 * spells each trained magic school lacks (spellGaps.ts), the healing kits and potions in the pack, and the session's deaths. Facts, a few lines; null when none of it could be read.
 */
export function readinessBrief(r: {
  items: readonly AgentItem[] | null;
  sheet: string | null;
  session: string | null;
  /** The known spells (the agent API's `spells` read) and the era's DAT spell table, for the spells line (spellGaps.ts). */
  spells?: readonly KnownSpell[] | null;
  table?: readonly TableSpell[] | null;
}): string | null {
  const out = gearGaps(r.items);
  const u = unspent(r.sheet);
  if (u) {
    out.push(`- unspent: ${u.xp.toLocaleString('en-US')} XP`);
    out.push(`- ${creditsLine(u.credits, nextCreditLevels(r.sheet))}`);
  }
  out.push(...spellGaps(r.sheet, r.spells ?? null, r.table ?? null));
  if (r.items) {
    const c = recoveryCounts(r.items);
    const pl = (k: number, one: string, many: string): string => `${k} ${k === 1 ? one : many}`;
    out.push(`- in your pack: ${pl(c.kits, 'healing kit', 'healing kits')}, ${pl(c.health, 'health potion', 'health potions')}, ${pl(c.mana, 'mana potion', 'mana potions')}`);
  }
  if (r.session) out.push(`- ${r.session}`);
  return out.length ? ['Your readiness right now (`./ac gear`, `./ac character`, `./ac inventory` for the whole picture):', ...out].join('\n') : null;
}

/** Deaths (killer names, when the chat said) and levels gained by one character since the stream session began. */
export interface SessionTally { deaths: Array<string | null>; levels: number[] }

/**
 * The session so far: each cast member's deaths with their killers and levels gained, from the feed's death and
 * level-up events since session-start. Null while nobody has died or levelled.
 */
export function sessionSoFar(cast: ReadonlyArray<{ character: string; tally: SessionTally | undefined }>): string | null {
  if (!cast.some((c) => c.tally && (c.tally.deaths.length || c.tally.levels.length))) return null;
  const parts = cast.map(({ character, tally }) => {
    const d = tally?.deaths ?? [];
    const bits = [`${d.length} death${d.length === 1 ? '' : 's'}${d.length ? ` (${d.map((k) => k ?? 'unknown').join(', ')})` : ''}`];
    const lv = tally?.levels ?? [];
    if (lv.length) {
      const now = Math.max(...lv);
      const from = Math.min(...lv) - 1;
      bits.push(`level ${from} → ${now}`);
    }
    return `${character}: ${bits.join(', ')}`;
  });
  return `deaths and levels this session: ${parts.join('; ')}`;
}

export function clipReport(text: string, max = 4000): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max)}\n… (cut)`;
}

/** Sent when a player's turn ends with time left in the segment. */
export function nudgeMessage(minutesLeft: number, partner: string): string {
  return `[supervisor] The stream is still live and this segment has about ${Math.max(1, Math.round(minutesLeft))} minutes left. Keep playing: observe, check on ${partner}, and pick the next thing to do. Don't stop or write a report until I say wrap up.`;
}

/** Sent when a player has been quiet with nothing running in the game (policy.ts quietNudge). */
export function quietMessage(quietMinutes: number): string {
  return `[supervisor] Nothing has been said or done for about ${Math.max(1, Math.round(quietMinutes))} minutes and nothing of yours is running (no walk, follow, fight or repeat cast). Say in a few words what you're doing or waiting for, then carry on. (No need to answer this while a walk or fight is running: I only ask when nothing is.)`;
}

/**
 * The end of a segment. Characters stay in the world between segments and are logged out when the stream stops, and
 * one left mid-fight woke up dead or under attack (rehearsal 2026-10-13): so finish the fight and stand somewhere safe
 * before the report. The session (and any logout) ends only after the report, or the wrap-up time.
 */
export function wrapUpMessage(minutes: number): string {
  return [
    `[supervisor] Wrap up now: you have about ${Math.max(1, Math.round(minutes))} minutes, in this order.`,
    "1. Finish the fight you are in (don't start a new one) and get somewhere safe: nothing attacking you, not in the middle of a dungeon pack or next to a spawn; a town, a lifestone or a cleared dead end. If you can't win, run there.",
    '2. Check with `./ac observe max=5` that nothing is on you.',
    '3. `./ac note kind=goal text=…` for next time (where you are, what is safe or dangerous there, what you were about to do), and `./ac goal text=…` the same plan in one line.',
    '4. Say a short goodbye line in /f.',
    "5. Then, after every command has answered, write your report as your final message. Don't `stop`: your character waits in the world for the next segment.",
  ].join('\n');
}

export function streamEndingMessage(seconds: number): string {
  return [
    `[supervisor] The stream is ending: you have ${Math.max(10, Math.round(seconds))} seconds.`,
    'Finish or leave the fight you are in and step away from danger (I log you out after your report, and a character logged out mid-fight is still in that fight next time),',
    "`./ac note kind=goal text=…` where you are and what's next, say goodbye in /f, then write a short report as your final message once every command has answered. Don't `stop`.",
  ].join(' ');
}

/** A stream-json input line carrying one user message. */
export function userLine(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';
}
