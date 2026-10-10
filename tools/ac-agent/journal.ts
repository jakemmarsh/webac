/**
 * A character's journal: what an agent player keeps between sessions
 * (docs/agent-play.md "What makes it play"). One JSON file per
 * era / account / character under ~/.acjs-agent/journals (outside $TMPDIR,
 * which the OS clears), written only by the agent's own notes — never game
 * state the client doesn't show.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const NOTE_KINDS = ['goal', 'done', 'place', 'person', 'event', 'idea'] as const;
export type NoteKind = typeof NOTE_KINDS[number];

export interface JournalNote { at: string; kind: NoteKind; text: string; where?: string }
export interface Journal { character: string; account: string; era: string; notes: JournalNote[] }

export const JOURNAL_DIR = process.env.ACJS_AGENT_JOURNAL_DIR ?? join(homedir(), '.acjs-agent', 'journals');

const safe = (s: string): string => s.replace(/[^A-Za-z0-9 '_-]/g, '_').trim() || '_';

export function journalPath(era: string, account: string, character: string): string {
  return join(JOURNAL_DIR, safe(era), safe(account), `${safe(character)}.json`);
}

export function loadJournal(era: string, account: string, character: string): Journal {
  const f = journalPath(era, account, character);
  if (existsSync(f)) {
    try { return JSON.parse(readFileSync(f, 'utf8')) as Journal; } catch { /* fall through to a fresh one */ }
  }
  return { character, account, era, notes: [] };
}

export function saveJournal(j: Journal): void {
  const f = journalPath(j.era, j.account, j.character);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
}

/** Add a note. A "done" note closes the open goal it describes (openGoals), so goals stay current. */
export function addNote(j: Journal, kind: NoteKind, text: string, where?: string, now = new Date()): Journal {
  const note: JournalNote = { at: now.toISOString(), kind, text: text.trim(), ...(where ? { where } : {}) };
  j.notes.push(note);
  return j;
}

/** A note's significant words: 4+ letters, lower case (so "Get the Blacksmith his bellows" → blacksmith, bellows). */
const words = (t: string): string[] => (t.toLowerCase().match(/[a-z0-9']{4,}/g) ?? []);

/**
 * Goals not yet marked done: a later "done" note closes a goal when it holds
 * at least two thirds of the goal's significant words (people paraphrase:
 * "got the blacksmith his bellows" closes "Get the Blacksmith his bellows").
 */
export function openGoals(j: Journal): JournalNote[] {
  return j.notes.filter((g, gi) => {
    if (g.kind !== 'goal') return false;
    const need = words(g.text);
    if (!need.length) return true;
    return !j.notes.slice(gi + 1).some((d) => {
      if (d.kind !== 'done') return false;
      const have = new Set(words(d.text));
      return need.filter((w) => have.has(w)).length / need.length >= 2 / 3;
    });
  });
}

/** The journal as an agent reads it at the start of a session: open goals, then the latest of each kind. */
export function formatJournal(j: Journal, perKind = 6): string {
  if (!j.notes.length) return `(${j.character}'s journal is empty: note goals, places, people and events as you play)`;
  const out = [`${j.character}'s journal (${j.notes.length} notes, since ${j.notes[0].at.slice(0, 10)}):`];
  const goals = openGoals(j);
  out.push(goals.length ? 'open goals:' : 'open goals: none');
  for (const g of goals) out.push(`  - ${g.text}`);
  for (const kind of ['event', 'place', 'person', 'done', 'idea'] as const) {
    const list = j.notes.filter((n) => n.kind === kind).slice(-perKind);
    if (!list.length) continue;
    out.push(`${kind}s (latest ${list.length}):`);
    for (const n of list) out.push(`  - ${n.at.slice(0, 16).replace('T', ' ')}  ${n.text}${n.where ? `  @ ${n.where}` : ''}`);
  }
  return out.join('\n');
}
