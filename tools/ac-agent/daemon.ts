/**
 * ac-agent daemon — one long-lived game session an LLM plays through.
 *
 * It owns a Chromium window (headed on the real GPU by default, so a human
 * can watch), logs into the local ACE server on the profile's own account,
 * creates a character if the account has none, and serves a tiny HTTP API on
 * 127.0.0.1 that forwards calls to the in-page agent API (`window.__acAgent`,
 * packages/renderer/src/agent/AgentApi.ts). The CLI (cli.ts) and the MCP
 * server (mcp-server.ts) are thin clients of this API; neither touches the
 * browser itself, so any number of Claude Code sessions can share one player.
 *
 *   npx tsx tools/ac-agent/daemon.ts --profile claude1 [--character "Name"]
 *       [--headless] [--base http://localhost:3000/] [--bridge ws://localhost:9090]
 *   AC_EXTRA_QUERY=datSet=<pointer url> appends page parameters (play on the production streamed DATs).
 *   npx tsx tools/ac-agent/daemon.ts --profile me --attach http://127.0.0.1:9222
 *       plays the character a human logged in themselves, in their own Chrome tab (any server,
 *       playwebac.com included; the page needs ?agent). No bridge, Vite, login or character creation,
 *       and stopping it never logs out or closes that browser.
 *
 * Usually started for you by `cli.ts start` / the MCP `ac_start` tool.
 * Docs: docs/agent-play.md.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { AT_CHAR_SELECT_JS, HOST_RESOLVER_ARGS, REMOTE_CHROMIUM, REPO, createCharacterIfNeeded, waitForWorld } from '../lib/game-session.ts';
import { READ_PAGE_STORAGE_JS, gameOriginOf, mergePageStorage, pageStorageFile, readPageStorage, restorePageStorageScript, writePageStorage, type SavedPageStorage } from './pageStorage.ts';
import { STATE_DIR, accountForProfile, clearInfo, listInfos, logFile, pickStaleSnapshots, readInfo, writeInfo } from './state.ts';
import { type AgentEra, agentEra, eraAccount } from './eras.ts';
import { CALLS_SETTLE_MS, SHUTDOWN_DEADLINE_MS, createShutdown, killTree, waitForCalls } from './shutdown.ts';
import { replyDeadlineMs, withCallDeadline } from './callDeadline.ts';
import { withStateLock } from './stateLock.ts';

/** `p`, or a rejection after `ms`. */
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms} ms`)), ms))]);

interface Args {
  profile: string;
  /** The era to play (eras.ts): end of retail by default. */
  era: AgentEra;
  eraKey: string;
  character: string;
  /** A new character's choices (the chargen's own names); unset ones come from its roll. */
  choices: { template?: string; heritage?: string; gender?: string; town?: string; seed: number; attributes?: Record<string, number>; skills?: Record<string, string> };
  account: string;
  headless: boolean;
  /** Game page origin; null = serve a snapshot of the committed tree (see ensureSnapshot). */
  base: string | null;
  bridge: string | null;
  port: number;
  /** A Chrome DevTools endpoint (http://127.0.0.1:9222): drive the game tab a human logged in there. */
  attach: string | null;
  /**
   * Attached, the character whose tab to drive (`--attach-character`): with several game tabs in one browser (a
   * stream's two characters, each logged in by the human) only the tab in the world as this character is picked.
   */
  attachCharacter: string | null;
  /** Log out after this long with no agent call, nothing Claude started still acting, and no input from a human in the
   *  window (0 = never). Never applies to an attached tab, which is the human's own login. */
  idleLogoutMs: number;
}

/**
 * The daemon log's line for a page console message, or null for one it leaves out: the client's agent trace, what it
 * sent and what the server refused. Timestamped like the daemon's own lines, so a walk's searches and stalls line up
 * with the chat log and the player's tool calls (tools/stream/dead-air.ts; untimed, the rehearsal of 2026-10-13
 * couldn't tell a 105 s "arrived" walk that stood searching from one that ran).
 */
export function pageLogLine(text: string, now: Date = new Date()): string | null {
  if (!/\[AC:Agent\]|\[AC\] Sent|WeenieError|UseDone|ServerSaveFailed|error/i.test(text) || text.startsWith('[AC:Chat]')) return null;
  return `${now.toISOString()} [page] ${text.slice(0, 300)}\n`;
}

export function parseArgs(argv: string[]): Args {
  const get = (k: string): string | undefined => {
    const i = argv.indexOf(`--${k}`);
    return i > -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
  };
  const profile = get('profile') ?? 'claude';
  const eraKey = get('era') ?? 'eor';
  const era = agentEra(eraKey);
  return {
    profile,
    era,
    eraKey: eraKey === 'end-of-retail' ? 'eor' : eraKey,
    character: get('character') ?? defaultCharacterName(profile),
    choices: {
      template: get('template'), heritage: get('heritage'), gender: get('gender'), town: get('town'),
      // A fresh appearance per agent character unless pinned (probes keep PROBE_CHARGEN_SEED).
      seed: get('seed') !== undefined ? Number(get('seed')) : Math.floor(Math.random() * 2 ** 31),
      ...(get('attributes') ? { attributes: parseAttributeChoices(get('attributes')!) } : {}),
      ...(get('skills') ? { skills: parseSkillChoices(get('skills')!) } : {}),
    },
    account: get('account') ?? eraAccount(accountForProfile(profile), era),
    headless: argv.includes('--headless'),
    base: get('base') ?? process.env.AC_BASE ?? null,
    bridge: get('bridge') ?? null,
    port: Number(get('port') ?? 0),
    attach: get('attach') ?? null,
    attachCharacter: get('attach-character') ?? null,
    idleLogoutMs: Math.max(0, Number(get('idle-logout-min') ?? process.env.AC_IDLE_LOGOUT_MIN ?? IDLE_LOGOUT_MIN)) * 60_000,
  };
}

/** Minutes an agent-started character may stand idle in the world before the daemon logs it out (Jake, 2026-10-12). */
export const IDLE_LOGOUT_MIN = 15;

/**
 * Why to log out now, or null: nothing has driven the character for `idleMs` (no agent call, no human input in the
 * window, and no walk, fight or routine Claude started still going). A character left standing in the world gets
 * killed (Jake: "you should always log out if you stop controlling them … unless I've taken over").
 */
export function idleLogoutReason(s: { now: number; lastCallAt: number; lastInputAt: number; acting: boolean; idleMs: number; attached: boolean }): string | null {
  if (s.attached || s.idleMs <= 0 || s.acting) return null;
  const since = s.now - Math.max(s.lastCallAt, s.lastInputAt);
  if (since < s.idleMs) return null;
  return `idle ${Math.round(since / 60_000)} min (no agent call, nothing Claude started still acting, no input in the window): logging out so the character isn't left standing in the world`;
}

/**
 * "strength=10, endurance=100, coordination=100" → { strength: 10, … } in that order (the order they are
 * set and locked in). Names are the chargen's: strength, endurance, coordination, quickness, focus, self.
 */
export function parseAttributeChoices(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of text.split(/[,;]/).map((p) => p.trim()).filter(Boolean)) {
    const m = /^([a-z]+)\s*[=:]\s*(\d+)$/i.exec(part);
    if (!m) throw new Error(`attributes: "${part}" is not name=value`);
    out[m[1].toLowerCase()] = Number(m[2]);
  }
  return out;
}

/** "Weapon Tinkering=specialized; Armor Tinkering=trained" → { 'Weapon Tinkering': 'specialized', … }. */
export function parseSkillChoices(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of text.split(/[,;]/).map((p) => p.trim()).filter(Boolean)) {
    const m = /^(.+?)\s*[=:]\s*(speciali[sz]ed|spec|trained|train|untrained|untrain)$/i.exec(part);
    if (!m) throw new Error(`skills: "${part}" is not "Skill Name=specialized|trained|untrained"`);
    out[m[1].trim()] = m[2].toLowerCase();
  }
  return out;
}

/** A pronounceable default name (ACE names: letters, spaces, ' and -; 3–32 chars). */
import { defaultCharacterName } from './state.ts';
export { defaultCharacterName };

/**
 * The game tab to drive in an attached browser: the one with the agent API on, else any game page. With `want` (a
 * character name) only the tab in the world as that character (`names[i]`, the API's self().name, null before
 * entering) is taken, so two daemons attached to one Chrome drive two tabs, never the same one; until the human has
 * entered with that character there is none.
 */
export function pickGameTab<T extends { url(): string }>(pages: T[], hasApi: boolean[], names: Array<string | null> = [], want: string | null = null): T | null {
  if (want) {
    const w = want.trim().toLowerCase();
    const i = names.findIndex((n, k) => hasApi[k] && !!n && n.trim().toLowerCase() === w);
    return i > -1 ? pages[i] : null;
  }
  const i = hasApi.findIndex(Boolean);
  if (i > -1) return pages[i];
  return pages.find((p) => /playwebac\.com|[?&](ace|agent)(=|&|$)/.test(p.url())) ?? null;
}

/** Ports other local sessions hold (see docs/agent-play.md); the daemon's bridge skips them. */
const RESERVED_PORTS = new Set([9090, 9096, 9097, 9098, 9099, 9101]);

/**
 * Free on IPv4 AND IPv6 loopback: Vite listens on `localhost`, which macOS resolves to ::1, so a port
 * that is free on 127.0.0.1 can still be another session's Vite, and `http://localhost:<port>/` would
 * then load that session's (older) game (2026-10-09: two daemons on 3127).
 */
export async function portFree(port: number): Promise<boolean> {
  const on = (host: string): Promise<boolean> => new Promise((res) => {
    const s = createNetServer();
    s.once('error', (e: NodeJS.ErrnoException) => res(e.code === 'EADDRNOTAVAIL' || e.code === 'EAFNOSUPPORT'));
    s.listen(port, host, () => s.close(() => res(true)));
  });
  return (await on('127.0.0.1')) && (await on('::1'));
}

async function freePort(from: number): Promise<number> {
  for (let p = from; p < from + 200; p++) if (!RESERVED_PORTS.has(p) && (await portFree(p))) return p;
  throw new Error(`no free port from ${from}`);
}

/**
 * A snapshot of the repo's committed HEAD in its own sparse worktree under
 * STATE_DIR, served by its own Vite. Other sessions saving files in their
 * trees reload their Vite pages; a play session on a snapshot never
 * reloads under the player. Reused per commit; node_modules / dat are
 * symlinked from the repo (docs/remote-agent-ops.md worktree recipe).
 */
export function snapshotDir(sha: string): string {
  return join(STATE_DIR, `tree-${sha.slice(0, 12)}`);
}

/**
 * Where a snapshot links `name` (node_modules, dat) from: the checkout
 * itself, else the main checkout behind it. A fresh `git worktree add`
 * has neither, and a snapshot without node_modules can't start Vite.
 */
export function sharedDirFor(repo: string, name: string): string | null {
  if (existsSync(join(repo, name))) return join(repo, name);
  const r = spawnSync('git', ['-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
  const main = r.status === 0 ? dirname(r.stdout.trim()) : '';
  return main && existsSync(join(main, name)) ? join(main, name) : null;
}

function ensureSnapshot(say: (s: string) => void): string {
  const sha = spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  if (!sha) throw new Error('git rev-parse HEAD failed');
  const dir = snapshotDir(sha);
  const linkShared = (): void => {
    for (const l of ['node_modules', 'dat']) {
      const from = sharedDirFor(REPO, l);
      if (from && !existsSync(join(dir, l))) symlinkSync(from, join(dir, l));
    }
  };
  if (existsSync(join(dir, 'package.json'))) {
    // A tree made from a checkout without its own node_modules (an older daemon) has none: repair it.
    linkShared();
    // Marks it recently used, so a concurrent prune (pickStaleSnapshots' grace) leaves it alone.
    try { const now = new Date(); utimesSync(dir, now, now); } catch { /* best effort */ }
  } else {
    say(`creating game snapshot of ${sha.slice(0, 12)} in ${dir}`);
    const git = (...a: string[]): void => {
      const r = spawnSync('git', a, { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
    };
    // A tree a crashed start left half made (no package.json): remove it, or `worktree add` refuses the path.
    if (existsSync(dir)) {
      if (spawnSync('git', ['-C', REPO, 'worktree', 'remove', '--force', dir]).status !== 0) rmSync(dir, { recursive: true, force: true });
      spawnSync('git', ['-C', REPO, 'worktree', 'prune']);
    }
    git('-C', REPO, 'worktree', 'add', '--no-checkout', '--detach', dir, sha);
    // CI's sparse pattern: no verification images (~50 MB instead of ~3.6 GB).
    git('-C', dir, 'sparse-checkout', 'set', '--no-cone', '/*', '!/verification/**/*.png', '!/verification/**/*.jpg', '!/verification/**/*.jpeg', '!/verification/**/*.html', '!/verification/**/*.webm', '!/verification/**/*.gif');
    git('-C', dir, 'checkout', '-q');
    linkShared();
  }
  pruneSnapshots(dir, say);
  return dir;
}

/** The working directory of a live process (lsof), or null. */
function processCwd(pid: number): string | null {
  const r = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
  const line = r.status === 0 ? r.stdout.split('\n').find((l) => l.startsWith('n')) : undefined;
  return line ? line.slice(1) : null;
}

/**
 * Remove snapshot trees no live daemon serves, keeping the newest few
 * (pickStaleSnapshots). A live daemon whose tree can't be told (an older
 * daemon with no `snapshot` field and an unreadable Vite cwd) stops the prune.
 */
function pruneSnapshots(current: string, say: (s: string) => void): void {
  const inUse = new Set<string>([basename(current)]);
  for (const info of listInfos()) {
    const dir = info.snapshot ?? (info.vitePid ? processCwd(info.vitePid) : null);
    if (dir) inUse.add(basename(dir));
    else if (info.vitePid) return;
  }
  const now = Date.now();
  const trees = readdirSync(STATE_DIR).filter((n) => n.startsWith('tree-')).flatMap((name) => {
    try { return [{ name, ageMs: now - statSync(join(STATE_DIR, name)).mtimeMs }]; } catch { return []; }
  });
  const stale = pickStaleSnapshots(trees, inUse);
  for (const name of stale) {
    const dir = join(STATE_DIR, name);
    if (spawnSync('git', ['-C', REPO, 'worktree', 'remove', '--force', dir]).status !== 0) rmSync(dir, { recursive: true, force: true });
  }
  if (stale.length) {
    spawnSync('git', ['-C', REPO, 'worktree', 'prune']);
    say(`removed ${stale.length} old game snapshot(s) no daemon serves`);
  }
}

/** The account's access level on its era's server; -1 when it doesn't exist yet (or the DB isn't reachable). */
export function accountAccessLevel(account: string, era: AgentEra): number {
  if (!/^[a-z0-9]+$/.test(account)) throw new Error(`bad account name ${account}`);
  if (!era.access) return -1;
  const a = era.access;
  const r = spawnSync('docker', ['exec', a.container, ...a.client, `SELECT ${a.column} FROM ${a.table} WHERE ${a.nameColumn}='${account}'`], { encoding: 'utf8' });
  const v = r.status === 0 ? r.stdout.trim() : '';
  return v === '' ? -1 : Number(v);
}

/** Demote to the era's player level. Takes effect at the next login. */
export function setPlayerAccess(account: string, era: AgentEra): boolean {
  if (!/^[a-z0-9]+$/.test(account)) throw new Error(`bad account name ${account}`);
  if (!era.access) return true;
  const a = era.access;
  const r = spawnSync('docker', ['exec', a.container, ...a.client, `UPDATE ${a.table} SET ${a.column}=${a.player} WHERE ${a.nameColumn}='${account}'`], { encoding: 'utf8' });
  return r.status === 0 && accountAccessLevel(account, era) === a.player;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const log = logFile(args.profile);
  mkdirSync(dirname(log), { recursive: true });
  const storageFile = pageStorageFile(STATE_DIR, args.profile);
  const say = (s: string): void => {
    const line = `${new Date().toISOString()} ${s}`;
    // Started by the CLI, stdout is the log itself: write it once. Run by hand, echo to the terminal too.
    appendFileSync(log, line + '\n');
    if (process.stdout.isTTY) console.log(line);
  };

  // ── Bridge, snapshot and Vite: under the state dir's start lock (tools/ac-agent/stateLock.ts) ──
  // Two daemons started together (a stream's pair) otherwise race: both `git worktree add` the same tree, and both
  // take the same "free" port, so one page runs on the other's bridge and drops when that daemon stops (2026-10-13).
  // (Typed with `as`: the start below assigns them inside a closure, which TypeScript's narrowing doesn't see.)
  let bridgeChild = null as ChildProcess | null;
  let bridge = args.bridge;
  let viteChild = null as ChildProcess | null;
  let base = args.base;
  let snapshot = null as string | null;
  const needStart = (!bridge || !base) && !args.attach;
  const startLocked = async (): Promise<void> => {
    if (!bridge && !args.attach) {
      // Our own child on a free port unless one was named. A port someone else bound meanwhile kills the child
      // (EADDRINUSE): then the next port, never a "bridge started" on a port that is another process's bridge.
      for (let from = 9127, tries = 0; ; tries++) {
        const port = await freePort(from);
        // Pinned to this era's local server; BRIDGE_ERA selects AC1999's session protocol (and labels the others).
        const child = spawn('npx', ['tsx', 'services/ws-tcp-bridge/src/bridge.ts', String(port), '127.0.0.1', String(args.era.ports[0]), String(args.era.ports[1])], {
          cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
          env: { ...process.env, ...(args.era.bridgeEra ? { BRIDGE_ERA: args.era.bridgeEra } : {}) },
        });
        child.stdout?.on('data', (d) => appendFileSync(log, `[bridge] ${d}`));
        child.stderr?.on('data', (d) => appendFileSync(log, `[bridge] ${d}`));
        for (let i = 0; i < 60 && child.exitCode === null && (await portFree(port)); i++) await new Promise((r) => setTimeout(r, 500));
        if (child.exitCode === null && child.signalCode === null) {
          bridgeChild = child;
          bridge = `ws://localhost:${port}`;
          say(`bridge started on ${bridge} (pid ${child.pid})`);
          break;
        }
        say(`bridge on ${port} exited (code ${child.exitCode}): trying the next port`);
        if (tries >= 4) throw new Error('the bridge would not start (see the [bridge] lines in this log)');
        from = port + 1;
      }
    }

    // ── Game page: a named origin, or our own Vite on a snapshot of HEAD ──
    if (!base && !args.attach) {
      const dir = ensureSnapshot(say);
      snapshot = dir;
      const port = await freePort(3127);
      // HMR off: a page whose Vite went away (its daemon stopped) would otherwise poll and reload into
      // whatever Vite comes back on that port, dropping the player mid-session (acjs-ea, 1999 run).
      const cfg = join(dir, 'vite.agent.config.mjs');
      writeFileSync(cfg, "import base from './vite.config.ts';\nexport default async (env) => { const c = typeof base === 'function' ? await base(env) : base; return { ...c, server: { ...(c.server ?? {}), hmr: false } }; };\n");
      viteChild = spawn('npx', ['vite', '--config', cfg, '--port', String(port), '--strictPort'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      viteChild.stdout?.on('data', (d) => appendFileSync(log, `[vite] ${d}`));
      viteChild.stderr?.on('data', (d) => appendFileSync(log, `[vite] ${d}`));
      base = `http://localhost:${port}/`;
      for (let i = 0; i < 120; i++) {
        if (await fetch(base, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok).catch(() => false)) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      if (viteChild.exitCode !== null) throw new Error(`Vite exited (code ${viteChild.exitCode}) on port ${port}; see the [vite] lines in this log`);
      say(`game snapshot served on ${base} (pid ${viteChild.pid})`);
    }
  };
  if (needStart) {
    try {
      await withStateLock('daemon-start', startLocked, { onWait: (o) => say(`waiting for another daemon's start${o ? ` (pid ${o.pid})` : ''}`) });
    } catch (e) {
      // A half start (the bridge up, Vite not): end what we started before the error ends us.
      for (const c of [bridgeChild, viteChild]) if (c) await killTree(c, 2000, (pid, sig) => process.kill(pid, sig)).catch(() => {});
      throw e;
    }
  }
  // A base may carry its own query (e.g. ?datSet=<production set> to play on the streamed DATs).
  let url = args.attach ?? `${base}${base!.includes('?') ? '&' : '?'}ace&agent&bridge=${bridge}&account=${encodeURIComponent(args.account)}&password=${encodeURIComponent(args.account)}${args.era.id ? `&era=${args.era.id}` : ''}${process.env.AC_EXTRA_QUERY ? `&${process.env.AC_EXTRA_QUERY}` : ''}`;

  // ── Browser: headed on the real GPU (watchable), or headless GPU; or the human's own, attached ──
  let browser: Browser;
  let page: Page;
  if (args.attach) {
    browser = await chromium.connectOverCDP(args.attach);
    let found: Page | null = null;
    for (let i = 0; i < 600 && !found; i++) {
      const pages = browser.contexts().flatMap((c) => c.pages());
      const hasApi = await Promise.all(pages.map((p) => p.evaluate('!!window.__acAgent').catch(() => false) as Promise<boolean>));
      const names = args.attachCharacter
        ? await Promise.all(pages.map((p) => p.evaluate('(() => { const a = window.__acAgent; const me = a && a.self && a.self(); return me ? me.name : null; })()').catch(() => null) as Promise<string | null>))
        : [];
      found = pickGameTab(pages, hasApi, names, args.attachCharacter);
      if (!found) {
        if (i === 0) say(args.attachCharacter ? `no game tab in ${args.attach} is in the world as "${args.attachCharacter}" yet: log in and enter with that character in a tab at https://playwebac.com/?agent` : `no game tab in ${args.attach} yet: open https://playwebac.com/?agent there`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (!found) throw new Error(`no game tab in ${args.attach} after 20 min`);
    page = found;
    url = page.url();
    say(`attached to ${url}`);
  } else {
    browser = await chromium.launch({
      headless: args.headless,
      // The cloud container's preinstalled Chromium (a pinned Playwright may expect another build).
      ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : args.headless ? { channel: 'chromium' } : {}),
      args: ['--ignore-gpu-blocklist', `--window-size=1290,860`, ...HOST_RESOLVER_ARGS],
    });
    page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
    // A human's own keys, clicks and wheel in this window (trusted events; the agent drives the game through its API,
    // not DOM input) keep the idle logout away: they may have taken over.
    await page.addInitScript(() => {
      const mark = (e: Event): void => { if (e.isTrusted) (window as unknown as { __acLastHumanInput?: number }).__acLastHumanInput = Date.now(); };
      for (const t of ['keydown', 'mousedown', 'wheel', 'touchstart']) window.addEventListener(t, mark, { capture: true, passive: true });
    });
    // The human's own tab answers its own dialogs.
    page.on('dialog', (d) => void d.dismiss());
    // The agent API's memory (creatures seen only buffing you, remembered places) from the last launch: this
    // context's localStorage starts empty (pageStorage.ts).
    const saved = readPageStorage(storageFile);
    // For this launch's game origin too: Vite's port moves from launch to launch (pageStorage.ts).
    const gameOrigin = gameOriginOf(url);
    if (saved) { await page.addInitScript({ content: restorePageStorageScript(saved, gameOrigin) }); say(`restoring ${saved.items.length} agent memory entr${saved.items.length === 1 ? 'y' : 'ies'} saved on ${saved.origin}${gameOrigin && gameOrigin !== saved.origin ? ` into ${gameOrigin}` : ''}`); }
  }
  page.setDefaultTimeout(120_000);
  page.on('crash', () => say('PAGE CRASHED'));
  // The client's own trace of what it sent and what the server refused: the first place to look when an action "did nothing".
  // The server's answer to a character create it refused (the client shows the retail error dialog): stop and say why.
  let createRefused: string | null = null;
  page.on('console', (m) => { const r = /Character creation failed \(code \d+\): (.*)/.exec(m.text()); if (r) createRefused = r[1]; });
  page.on('console', (m) => { const line = pageLogLine(m.text()); if (line) appendFileSync(log, line); });
  // Every chat line and centre notice the player saw (theirs included), timestamped, beside the log: what was said.
  const chatLog = log.replace(/\.log$/, '.chat.log');
  page.on('console', (m) => { const t = m.text(); if (t.startsWith('[AC:Chat] ')) appendFileSync(chatLog, `${new Date().toISOString()} ${t.slice(10)}\n`); });

  let ready = false;
  let entering: Promise<void> | null = null;
  // No cheating (Jake, 2026-10-06): an agent plays as a plain player. Local
  // ACE auto-creates accounts at DefaultAccessLevel 5 (admin), so demote the
  // account before its character exists (an admin's character gets a "+"
  // name) and log in again so the session carries the new level.
  // (GDL and the 1999 server create accounts at a basic level already: era.access is null there.)
  let accessChecked = !!args.attach || !args.era.access || accountAccessLevel(args.account, args.era) === args.era.access.player;
  if (!accessChecked && accountAccessLevel(args.account, args.era) > 0 && setPlayerAccess(args.account, args.era)) { accessChecked = true; say(`demoted ${args.account} to player access`); }
  const makeCharacter = createCharacterIfNeeded(args.character, args.choices);
  let character = args.character;
  /** Attached: the human logs in and enters; wait for them (the API's self() is null until then). */
  const awaitHuman = async (): Promise<void> => {
    ready = false;
    let warned = false;
    for (;;) {
      const st = await page.evaluate('(() => { const a = window.__acAgent; if (!a) return { api: false }; const me = a.self && a.self(); return { api: true, name: me ? me.name : null }; })()')
        .catch(() => ({ api: false })) as { api: boolean; name?: string | null };
      // Attached for one named character (a stream's two tabs): another character entered in this tab is not ours.
      if (st.name && args.attachCharacter && st.name.toLowerCase() !== args.attachCharacter.toLowerCase()) {
        if (!warned) { say(`this tab is in the world as "${st.name}", not "${args.attachCharacter}": waiting for ${args.attachCharacter}`); warned = true; }
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      if (st.name) { character = st.name; break; }
      // The API loads with the world; before that only the address says whether it will.
      if (!st.api && !warned && !/[?&]agent(=|&|$)/.test(page.url())) { say(`the tab has no ?agent in its address, so the agent API won't load: reload it at ${page.url().split('?')[0]}?agent`); warned = true; }
      await new Promise((r) => setTimeout(r, 2000));
    }
    ready = true;
    say(`in world as "${character}" (attached)`);
    writeInfo({ ...readInfo(args.profile)!, character });
  };
  const enter = async (): Promise<void> => {
    if (args.attach) return awaitHuman();
    ready = false;
    say(`entering world as ${args.account} / "${args.character}"`);
    const ok = await waitForWorld(page, {
      timeoutMs: 360_000, url, reloadVia: 'goto',
      // Streamed DATs: a cold boot reaches char select in ~35 s and chargen waits 1-3 min for the
      // world packs, so the 60 s phantom-session reload restarted it forever (2026-10-08).
      ...(/(^|&)datSet=/.test(process.env.AC_EXTRA_QUERY ?? '') ? { reloadEveryMs: 240_000 } : {}),
      onPoll: async (p) => {
        // No character until the account is known to be a player one: a create sent while it is still
        // an admin (or before the server has made the account) is lost to the demotion's re-login.
        if (!accessChecked && accountAccessLevel(args.account, args.era) < 0) return;
        if (!accessChecked && accountAccessLevel(args.account, args.era) > (args.era.access?.player ?? 0)) {
          if (!setPlayerAccess(args.account, args.era)) throw new Error(`could not demote ${args.account} to player access (docker exec ${args.era.access?.container} failed)`);
          accessChecked = true;
          say(`new account ${args.account} demoted to player access; logging in again`);
          await p.goto(url, { waitUntil: 'domcontentloaded' });
          return;
        }
        if (createRefused) throw new Error(`the server refused to create "${args.character}": ${createRefused}`);
        await makeCharacter(p);
      },
      log: say,
    });
    if (!ok) throw new Error('never entered the world');
    await page.waitForFunction('!!window.__acAgent', undefined, { timeout: 30_000 });
    // The account's real character (an existing one keeps its own name, not the profile's default),
    // so the journal and status name who is actually playing.
    const real = await page.evaluate('(() => { const a = window.__acAgent; const me = a && a.self && a.self(); return me ? me.name : null; })()').catch(() => null) as string | null;
    if (real && real !== character) {
      say(`playing "${real}" (the account's character)`);
      character = real;
      if (readInfo(args.profile)) writeInfo({ ...readInfo(args.profile)!, character });
    }
    ready = true;
    say('in world');
  };
  if (!args.attach) {
    // A new page's own first about:blank can land after our goto starts and cancel it (seen 2026-10-12): go again.
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch((e: Error) => {
      if (!/interrupted by another navigation/.test(e.message)) throw e;
      say('first navigation was cancelled by the new tab\'s blank page; loading again');
      return page.goto(url, { waitUntil: 'domcontentloaded' });
    });
    entering = enter().finally(() => { entering = null; });
    await entering;
  }
  // A dev-server reload (another session saved a file) re-runs the login on its own; wait it out.
  let notice: string | null = null;
  page.on('load', () => {
    if (entering) return;
    say('page reloaded — waiting for re-entry');
    notice = 'The game page reloaded (a file changed under its dev server, or the connection dropped). You have re-entered the world: any running walk/attack/loot was cancelled and event numbers restarted. Observe before acting.';
    entering = enter().catch((e) => say(`re-entry failed: ${e}`)).finally(() => { entering = null; });
  });

  // ── Control API ──
  const body = (req: IncomingMessage): Promise<any> => new Promise((res) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => { try { res(s ? JSON.parse(s) : {}); } catch { res({}); } });
  });
  const send = (res: ServerResponse, code: number, obj: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  // The agent API's memory, kept for the next launch (pageStorage.ts): every minute, and at shutdown.
  const saveStorage = async (): Promise<void> => {
    if (args.attach) return;
    const got = await withTimeout(page.evaluate(READ_PAGE_STORAGE_JS) as Promise<SavedPageStorage | null>, 3000).catch(() => null);
    if (got && /^https?:/.test(got.origin)) { try { writePageStorage(storageFile, mergePageStorage(readPageStorage(storageFile), { origin: got.origin, items: got.items })); } catch { /* state dir unwritable */ } }
  };
  const storageTimer = setInterval(() => void saveStorage(), 60_000);
  // tools/ac-agent/shutdown.ts: a deadline, a second signal ends it at once, children killed as process groups.
  const shutdown = createShutdown({
    say,
    // The orderly part may first let a running agent call finish (waitForCalls).
    deadlineMs: SHUTDOWN_DEADLINE_MS + CALLS_SETTLE_MS,
    children: () => [bridgeChild, viteChild],
    exit: (code) => process.exit(code),
    steps: async () => {
      clearInfo(args.profile);
      if (args.attach) {
        // The human's own session and browser: leave both as they are and only let go of the tab.
        say('detached; the game and browser stay as they were');
        return;
      }
      server.close();
      clearInterval(storageTimer);
      await saveStorage();
      // The player's last action (a goodbye, a note) finishes first; then the logout.
      if (inFlight > 0 && !(await waitForCalls(() => inFlight))) say(`${inFlight} agent call(s) still running after ${CALLS_SETTLE_MS / 1000} s: logging out anyway`);
      // A real logout, waited out: ACE saves the character (position included) only when its logout
      // completes and the client is back at character select; closing the window first loses the session's progress.
      await withTimeout(page.evaluate('window.__acAgent && window.__acAgent.logout && window.__acAgent.logout()'), 5000).catch(() => {});
      for (let i = 0; i < 40; i++) {
        if (await withTimeout(page.evaluate(AT_CHAR_SELECT_JS), 2000).catch(() => false)) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      await new Promise((r) => setTimeout(r, 1000));
      // Playwright's close can wait forever on a browser that stopped answering (2026-10-12).
      await withTimeout(browser.close(), 10_000).catch(() => say('the browser did not close in 10 s; leaving it to the exit'));
    },
  });

  let lastCallAt = Date.now();
  /** Agent calls (/call) being answered now: a shutdown lets them finish before it logs out. */
  let inFlight = 0;
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/status') {
        return send(res, 200, { ready, attached: !!args.attach, profile: args.profile, account: args.attach ? 'own-login' : args.account, character, url, busy: inFlight });
      }
      // The character at a glance for a stream overlay (tools/stream/): read-only, and not an agent call, so polling it
      // neither eats the agent's chat (observe would) nor holds off the idle logout.
      if (req.method === 'GET' && req.url === '/vitals') {
        if (!ready || entering) return send(res, 200, { ok: true, result: null });
        const v = await withTimeout(page.evaluate('(() => { const a = window.__acAgent; return a && a.vitals ? a.vitals() : null; })()'), 5000).catch(() => null);
        return send(res, 200, { ok: true, result: v });
      }
      if (req.method === 'POST' && req.url === '/call') {
        lastCallAt = Date.now();
        inFlight++;
        try {
          const { method, args: callArgs = [], timeoutMs = 120_000, replyMs } = await body(req);
          const run = async (): Promise<unknown> => {
            if (entering && args.attach) {
              // The human is still logging in: say so soon instead of holding the call for minutes.
              await Promise.race([entering, new Promise((r) => setTimeout(r, Math.min(timeoutMs, 15_000)))]);
              if (!ready) throw new Error('nobody is in the world in that tab yet: the human logs in and enters with their character there; try again in a minute');
            }
            if (entering) await entering;
            // tools/ac-agent/callDeadline.ts: answered within the HTTP client's patience; a long walk goes on.
            return withCallDeadline(
              page.evaluate(([m, a]) => {
                const api = (window as any).__acAgent;
                if (!api) throw new Error('agent API not loaded (page still entering the world?)');
                if (typeof api[m as string] !== 'function') throw new Error(`unknown agent method: ${m}`);
                return api[m as string](...(a as unknown[]));
              }, [method, callArgs] as const),
              method, timeoutMs, replyDeadlineMs(method, replyMs),
            );
          };
          let result: unknown;
          try {
            result = await run();
          } catch (e) {
            // A reload under the call: wait for the re-entry (the load handler starts it) and run it once more.
            if (!/Execution context was destroyed|agent API not loaded|navigat/i.test(String((e as Error)?.message ?? e))) throw e;
            for (let i = 0; i < 20 && !entering && !ready; i++) await new Promise((r) => setTimeout(r, 500));
            result = await run();
          }
          const n = notice;
          notice = null;
          return send(res, 200, { ok: true, result, ...(n ? { notice: n } : {}) });
        } finally {
          inFlight--;
        }
      }
      if (req.method === 'POST' && req.url === '/screenshot') {
        const buf = await page.screenshot({ type: 'jpeg', quality: 70 });
        return send(res, 200, { ok: true, jpegBase64: buf.toString('base64') });
      }
      if (req.method === 'POST' && req.url === '/click') {
        lastCallAt = Date.now();
        // A mouse click on the game window at a screenshot position: the player's own input path.
        const { x, y, button = 'left', modifiers = [], toX, toY, text } = await body(req);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return send(res, 200, { ok: false, error: 'x and y (screenshot pixels) are required' });
        // Held keys for the click (Ctrl+click on a VVS eye, Shift+click): pressed before, released after.
        const held = (Array.isArray(modifiers) ? modifiers : []).map((m: string) => ({ ctrl: 'Control', control: 'Control', shift: 'Shift', alt: 'Alt' } as Record<string, string>)[String(m).toLowerCase()]).filter((k): k is string => !!k);
        for (const k of held) await page.keyboard.down(k);
        const btn = button === 'right' ? 'right' : 'left';
        try {
          if (Number.isFinite(toX) && Number.isFinite(toY)) {
            // A drag (moving a window or the VVS bar): press at (x, y), move in steps, release at (toX, toY).
            await page.mouse.move(Number(x), Number(y));
            await page.mouse.down({ button: btn });
            await page.mouse.move(Number(toX), Number(toY), { steps: 10 });
            await page.mouse.up({ button: btn });
          } else await page.mouse.click(Number(x), Number(y), { button: btn });
        } finally { for (const k of held.reverse()) await page.keyboard.up(k); }
        // Then type into what the click focused (a text box), with the real keyboard: \n presses Enter.
        if (typeof text === 'string' && text.length) for (const [i, part] of text.split('\n').entries()) { if (i > 0) await page.keyboard.press('Enter'); if (part) await page.keyboard.type(part, { delay: 15 }); }
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && req.url === '/shutdown') {
        send(res, 200, { ok: true });
        void shutdown('requested');
        return;
      }
      send(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      send(res, 200, { ok: false, error: String((e as Error)?.message ?? e) });
    }
  });
  await new Promise<void>((r) => server.listen(args.port, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  writeInfo({
    profile: args.profile, era: args.eraKey, pid: process.pid, port, account: args.attach ? 'own-login' : args.account, character, url,
    bridgePid: bridgeChild?.pid ?? 0, vitePid: viteChild?.pid ?? 0, snapshot: snapshot ?? undefined, startedAt: new Date().toISOString(), logFile: log,
  });
  say(`control API on http://127.0.0.1:${port} (state ${STATE_DIR})`);
  if (args.attach) {
    entering = enter().finally(() => { entering = null; });
    await entering;
  }

  if (!args.attach && args.idleLogoutMs > 0) {
    const timer = setInterval(() => {
      void (async () => {
        if (!ready) return;
        const st = await withTimeout(page.evaluate('(() => { const a = window.__acAgent; const x = a && a.acting ? a.acting() : null; return { input: window.__acLastHumanInput || 0, acting: !!(x && (x.task || x.routine)) }; })()'), 5000).catch(() => null) as { input: number; acting: boolean } | null;
        if (!st) return;
        const why = idleLogoutReason({ now: Date.now(), lastCallAt, lastInputAt: st.input, acting: st.acting, idleMs: args.idleLogoutMs, attached: false });
        if (why) { clearInterval(timer); say(why); void shutdown('idle'); }
      })();
    }, 30_000);
    timer.unref();
  }
  browser.on('disconnected', () => void shutdown('browser closed'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

if (process.argv[1] && /daemon\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
