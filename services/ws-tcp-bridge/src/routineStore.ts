/**
 * AGENT.routine-data — where each account's automation routines live
 * (packages/shared/src/routines). One JSON file per server + account under
 * a directory (ACJS_ROUTINES_DIR, default ~/.acjs-agent/routines). The agent
 * tools (tools/ac-agent) read and write them directly, so Claude can
 * configure a player's routines with no game session running; the bridge
 * serves the same files to the game client at /routines (routines.ts), to a
 * session the server logged in as that account.
 *
 * Writes are validated: an invalid document is refused with its issues,
 * never stored.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { emptyRoutineDoc, validateRoutineDoc, type RoutineDoc, type RoutineIssue } from '../../../packages/shared/src/routines/index.js';

export const DEFAULT_ROUTINES_DIR = join(homedir(), '.acjs-agent', 'routines');

/** Server ids and account names as file-name parts: lower case letters, digits, '.', '-', '_'. */
export function routineKey(s: string): string {
  const k = s.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '_');
  if (!k || k === '.' || k === '..') throw new Error(`bad routine key "${s}"`);
  return k;
}

export class RoutineStore {
  constructor(readonly dir: string = process.env.ACJS_ROUTINES_DIR ?? DEFAULT_ROUTINES_DIR) {}

  path(server: string, account: string): string {
    return join(this.dir, routineKey(server), `${routineKey(account)}.json`);
  }

  /** The account's document, or a new empty one. */
  get(server: string, account: string): RoutineDoc {
    const f = this.path(server, account);
    if (!existsSync(f)) return emptyRoutineDoc(server, account);
    return JSON.parse(readFileSync(f, 'utf8')) as RoutineDoc;
  }

  /** Validate and store (atomically); returns the issues and stores nothing when there are any. */
  put(server: string, account: string, doc: unknown, now = new Date()): { ok: true; doc: RoutineDoc } | { ok: false; issues: RoutineIssue[] } {
    const issues = validateRoutineDoc(doc);
    if (issues.length) return { ok: false, issues };
    const d = doc as RoutineDoc;
    if (routineKey(d.account) !== routineKey(account) || routineKey(d.server) !== routineKey(server)) {
      return { ok: false, issues: [{ path: 'account', message: `document is for ${d.server}/${d.account}, not ${server}/${account}` }] };
    }
    const stored: RoutineDoc = { ...d, updatedAt: now.toISOString() };
    const f = this.path(server, account);
    mkdirSync(join(this.dir, routineKey(server)), { recursive: true });
    writeFileSync(`${f}.tmp`, JSON.stringify(stored, null, 2) + '\n');
    renameSync(`${f}.tmp`, f);
    return { ok: true, doc: stored };
  }

  /** Accounts with stored routines on a server. */
  accounts(server: string): string[] {
    const d = join(this.dir, routineKey(server));
    return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) : [];
  }
}
