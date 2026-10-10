/**
 * Where a play daemon advertises itself: one JSON file per profile under
 * $TMPDIR/acjs-agent/, so the CLI and the MCP server of any Claude Code
 * session find a running daemon without being told its port.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface DaemonInfo {
  profile: string;
  /** eras.ts key ('eor', 'classicace-customdm', …). */
  era?: string;
  pid: number;
  /** HTTP control port (127.0.0.1 only). */
  port: number;
  account: string;
  character: string;
  url: string;
  /** The bridge child this daemon owns (0 = it uses a shared bridge). */
  bridgePid: number;
  /** The Vite this daemon serves its game snapshot from (0 = it uses a named base). */
  vitePid?: number;
  startedAt: string;
  logFile: string;
}

export const STATE_DIR = join(process.env.ACJS_AGENT_STATE_DIR ?? tmpdir(), 'acjs-agent');

export function stateFile(profile: string): string {
  return join(STATE_DIR, `${profile}.json`);
}

export function logFile(profile: string): string {
  return join(STATE_DIR, `${profile}.log`);
}

export function writeInfo(info: DaemonInfo): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(stateFile(info.profile), JSON.stringify(info, null, 2) + '\n');
}

export function readInfo(profile: string): DaemonInfo | null {
  const f = stateFile(profile);
  if (!existsSync(f)) return null;
  try {
    const info = JSON.parse(readFileSync(f, 'utf8')) as DaemonInfo;
    return pidAlive(info.pid) ? info : null;
  } catch {
    return null;
  }
}

export function clearInfo(profile: string): void {
  rmSync(stateFile(profile), { force: true });
}

/** Every live daemon (stale files are skipped). */
export function listInfos(): DaemonInfo[] {
  if (!existsSync(STATE_DIR)) return [];
  return readdirSync(STATE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readInfo(f.slice(0, -5)))
    .filter((i): i is DaemonInfo => i !== null);
}

export function pidAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Profile → account name. ACE auto-creates an account on first login, so a
 * profile gets its own account and never kicks Jake (testacjs), the GPU
 * worker (testacjs2/3) or the social probes (fxprobe1/2) off theirs.
 */
export function accountForProfile(profile: string): string {
  const slug = profile.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 14) || 'agent';
  return slug.startsWith('agent') ? slug : `agent${slug}`;
}

/** A new character's default name for a profile ("claude" → "Claude", "mage" → "Claude Mage"). */
export function defaultCharacterName(profile: string): string {
  const word = profile.replace(/[^A-Za-z]/g, '').toLowerCase() || 'agent';
  return word === 'claude' ? 'Claude' : `Claude ${word[0].toUpperCase()}${word.slice(1)}`.slice(0, 32);
}
