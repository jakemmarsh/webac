/**
 * What each player session is told: the shared brief plus its personality (the appended system prompt), the segment's
 * opening message (journal, last report, partner, time), and the supervisor's later messages (keep going, wrap up,
 * the stream is ending). Information a player has, never play decisions (Jake: no hardcoded behaviour).
 */
import type { CharacterConfig } from './config.ts';

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
}): string {
  const lines = [
    `[supervisor] Segment ${s.segment} of the stream starts now (${clock(s.nowMs)}). You are ${s.c.character} (profile ${s.c.profile}), in the world now; ${s.partner} is playing too.`,
    `Play until I tell you to wrap up, in about ${Math.round(s.playMinutes)} minutes. Start with \`./ac observe max=10\` and \`./ac character\`, set your \`goal\`, then find your partner.`,
  ];
  if (s.segment === 1 && s.c.startNotes.trim()) lines.push('', s.c.startNotes.trim());
  lines.push('', 'Your journal:', s.journal.trim() || '(empty)');
  if (s.lastReport?.trim()) lines.push('', 'What you wrote at the end of your last segment:', clipReport(s.lastReport));
  return lines.join('\n');
}

export function clipReport(text: string, max = 4000): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max)}\n… (cut)`;
}

/** Sent when a player's turn ends with time left in the segment. */
export function nudgeMessage(minutesLeft: number, partner: string): string {
  return `[supervisor] The stream is still live and this segment has about ${Math.max(1, Math.round(minutesLeft))} minutes left. Keep playing: observe, check on ${partner}, and pick the next thing to do. Don't stop or write a report until I say wrap up.`;
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
