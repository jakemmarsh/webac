/**
 * Client side of the ac-agent daemon: find (or start) the daemon for a
 * profile and call it. Shared by cli.ts and mcp-server.ts.
 */
import { spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type DaemonInfo, accountForProfile, listInfos, logFile, readInfo, STATE_DIR } from './state.ts';
import { agentEra, eraAccount } from './eras.ts';
import { defaultCharacterName } from './state.ts';
import type { AgentVitals } from '../../packages/renderer/src/agent/types.ts';

// The repo root (game-session.ts has the same; importing it would load Playwright, which the bridge doesn't carry).
// Worked out only when a daemon is started: the bridge bundles this module as CommonJS, where import.meta is empty.
const repoRoot = (): string => resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
import { mkdirSync } from 'node:fs';

export const DEFAULT_PROFILE = process.env.AC_AGENT_PROFILE ?? 'claude';

export interface StartOptions {
  profile?: string;
  character?: string;
  headless?: boolean;
  base?: string;
  bridge?: string;
  /** A new character's choices by the chargen's names (profession, heritage, gender, starting town) and appearance seed. */
  template?: string;
  heritage?: string;
  gender?: string;
  town?: string;
  seed?: number;
  /** "strength=10, endurance=100, …" and "Weapon Tinkering=specialized; …" for a NEW character. */
  attributes?: string;
  skills?: string;
  /** eras.ts key; the default profile becomes claude-<era> so each era is its own session. */
  era?: string;
  /** How long to wait for world entry (first login + character creation can take ~1–3 min). */
  timeoutMs?: number;
  /**
   * Play the character you logged in yourself: a Chrome DevTools endpoint, or 'chrome' to use (and
   * open if needed) the agent Chrome on 127.0.0.1:9222 at https://playwebac.com/?agent.
   */
  attach?: string;
  /** Attached: drive only the tab in the world as this character (several game tabs in one Chrome, e.g. a stream's two). */
  attachCharacter?: string;
}

export const AGENT_CHROME_PORT = 9222;
export const AGENT_CHROME_PROFILE = join(homedir(), '.acjs-agent', 'chrome');
const CHROME_APP = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/**
 * Your own Chrome with remote debugging on, in its own profile (Chrome refuses remote debugging on
 * the default one), opened at the game with the agent API on. You log in there yourself; the
 * password never reaches the agent. Reused while it runs; the profile keeps the game's caches.
 */
export async function ensureAgentChrome(url = 'https://playwebac.com/?agent'): Promise<string> {
  const endpoint = `http://127.0.0.1:${AGENT_CHROME_PORT}`;
  const up = (): Promise<boolean> => fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok).catch(() => false);
  if (await up()) return endpoint;
  if (!existsSync(CHROME_APP)) throw new Error(`Google Chrome not found at ${CHROME_APP}; start any Chrome with --remote-debugging-port and pass attach=<its endpoint>`);
  mkdirSync(AGENT_CHROME_PROFILE, { recursive: true });
  spawn(CHROME_APP, [`--remote-debugging-port=${AGENT_CHROME_PORT}`, `--user-data-dir=${AGENT_CHROME_PROFILE}`, '--no-first-run', '--no-default-browser-check', url], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 60; i++) {
    if (await up()) return endpoint;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Chrome did not open its DevTools port ${AGENT_CHROME_PORT}`);
}

async function http(info: DaemonInfo, path: string, payload?: unknown, timeoutMs = 180_000): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res.json();
}

/**
 * The live daemon for a profile; with no profile named (no argument, no
 * AC_AGENT_PROFILE) and exactly one daemon running, that one. A named profile
 * never falls back: the one running daemon is often another session's, and
 * `stop` on it ended that session's player (2026-10-12).
 */
export function findDaemon(profile?: string, envProfile: string | undefined = process.env.AC_AGENT_PROFILE): DaemonInfo | null {
  if (profile) return readInfo(profile);
  if (envProfile) return readInfo(envProfile);
  const own = readInfo(DEFAULT_PROFILE);
  if (own) return own;
  const all = listInfos();
  return all.length === 1 ? all[0] : null;
}

/**
 * Why a daemon that just exited failed, from the log lines it wrote: its last `Error: …` line, else the last
 * Playwright-style `page.goto: …` line (those print without the prefix), else null.
 */
export function daemonExitReason(log: string): string | null {
  const lines = log.split('\n').reverse();
  const err = lines.find((l) => /^Error: /.test(l));
  if (err) return err.slice(7);
  return lines.find((l) => /^[a-z]\w*\.\w+: \S/.test(l)) ?? null;
}

export async function startDaemon(opts: StartOptions = {}): Promise<{ info: DaemonInfo; started: boolean }> {
  const era = opts.era && opts.era !== 'eor' ? opts.era : undefined;
  const base = opts.profile ?? DEFAULT_PROFILE;
  const profile = opts.profile ?? (opts.attach ? 'me' : era ? `${DEFAULT_PROFILE}-${era}` : DEFAULT_PROFILE);
  const existing = readInfo(profile);
  if (existing) return { info: existing, started: false };
  const args = ['tsx', 'tools/ac-agent/daemon.ts', '--profile', profile];
  if (opts.attach) args.push('--attach', opts.attach === 'chrome' ? await ensureAgentChrome() : opts.attach);
  if (opts.attach && opts.attachCharacter) args.push('--attach-character', opts.attachCharacter);
  // The character and account come from the base profile, not the era-suffixed session name.
  args.push('--character', opts.character ?? defaultCharacterName(base));
  args.push('--account', eraAccount(accountForProfile(base), agentEra(era)));
  if (opts.headless) args.push('--headless');
  if (opts.base) args.push('--base', opts.base);
  if (opts.bridge) args.push('--bridge', opts.bridge);
  if (era) args.push('--era', era);
  for (const k of ['template', 'heritage', 'gender', 'town', 'seed', 'attributes', 'skills'] as const) if (opts[k] !== undefined) args.push(`--${k}`, String(opts[k]));
  mkdirSync(STATE_DIR, { recursive: true });
  // Only this start's lines explain its failure; the log keeps every earlier run's errors.
  const logStart = existsSync(logFile(profile)) ? statSync(logFile(profile)).size : 0;
  const out = openSync(logFile(profile), 'a');
  const child = spawn('npx', args, { cwd: repoRoot(), detached: true, stdio: ['ignore', out, out] });
  child.unref();
  const deadline = Date.now() + (opts.timeoutMs ?? 300_000);
  while (Date.now() < deadline) {
    const info = readInfo(profile);
    if (info) {
      const st = await http(info, '/status', undefined, 5000).catch(() => null);
      if (st?.ready) return { info, started: true };
      // Attached, you log in yourself: hand back once the tab is found, in world or not.
      if (st?.attached) {
        // You log in yourself: give an already-entered tab a moment to be seen, then hand back either way.
        for (let i = 0; i < 5 && !(await http(info, '/status', undefined, 5000).catch(() => null))?.ready; i++) await new Promise((r) => setTimeout(r, 1000));
        return { info: readInfo(profile) ?? info, started: true };
      }
    }
    if (child.exitCode !== null) {
      // The daemon's own last error (e.g. the server refused the character's name) says more than its exit code.
      const why = daemonExitReason(readFileSync(logFile(profile)).subarray(logStart).toString('utf8'));
      throw new Error(`${why ? `${why} — ` : ''}daemon exited (code ${child.exitCode}); see ${logFile(profile)}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`daemon for "${profile}" not in world after ${Math.round((opts.timeoutMs ?? 300_000) / 1000)} s; see ${logFile(profile)}`);
}

// Kept here, not in callDeadline.ts: the bridge image copies client.ts, and callDeadline.ts imports the renderer's
// claudeControl.ts, which the image doesn't (tests/verify-bridge-docker-inputs.ts).
/** AC_AGENT_REPLY_S as the replyMs a /call carries, or undefined (the daemon's own deadline). */
export function replyMsFromEnv(env: string | undefined = process.env.AC_AGENT_REPLY_S): number | undefined {
  const n = Number(env);
  return env && Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : undefined;
}

export class AgentClient {
  /** The daemon's last "the session reloaded" notice, consumed by the tool that prints it. */
  notice: string | null = null;

  constructor(readonly info: DaemonInfo) {}

  async call<T = any>(method: string, args: unknown[] = [], timeoutMs = 120_000): Promise<T> {
    // AC_AGENT_REPLY_S (a stream player's wrapper sets it): an acting call answers "still in progress" by then.
    const replyMs = replyMsFromEnv();
    const r = await http(this.info, '/call', { method, args, timeoutMs, ...(replyMs ? { replyMs } : {}) }, timeoutMs + 10_000);
    if (r.notice) this.notice = r.notice;
    if (!r.ok) throw new Error(r.error ?? 'call failed');
    return r.result as T;
  }

  /** Click the game window at screenshot pixel (x, y). */
  async click(x: number, y: number, button: 'left' | 'right' = 'left', modifiers: string[] = [], to?: { x: number; y: number }, text?: string): Promise<void> {
    const r = await http(this.info, '/click', { x, y, button, modifiers, ...(to ? { toX: to.x, toY: to.y } : {}), ...(text ? { text } : {}) });
    if (!r.ok) throw new Error(r.error ?? 'click failed');
  }

  async screenshot(): Promise<string> {
    const r = await http(this.info, '/screenshot', {});
    if (!r.ok) throw new Error(r.error ?? 'screenshot failed');
    return r.jpegBase64 as string;
  }

  async status(): Promise<any> {
    return http(this.info, '/status', undefined, 5000);
  }

  /**
   * The character at a glance (vitals, level, XP, where, task, goal), or null outside the world. Read-only and not
   * an agent call: it never takes the agent's chat (observe does) and never holds off the daemon's idle logout.
   */
  async vitals(): Promise<AgentVitals | null> {
    const r = await http(this.info, '/vitals', undefined, 8000);
    return r?.ok ? (r.result as AgentVitals | null) : null;
  }

  async shutdown(): Promise<void> {
    await http(this.info, '/shutdown', {}, 10_000).catch(() => {});
  }
}

export function requireClient(profile?: string): AgentClient {
  const info = findDaemon(profile);
  if (!info) {
    const running = listInfos().map((i) => i.profile);
    throw new Error(running.length
      ? `no daemon for profile "${profile ?? DEFAULT_PROFILE}"; running: ${running.join(', ')} (pass --profile / profile)`
      : 'no game session running — start one first (cli: `start`, MCP: ac_start)');
  }
  return new AgentClient(info);
}
