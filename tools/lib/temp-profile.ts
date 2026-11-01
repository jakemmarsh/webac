/**
 * Per-run browser profiles that never outlive their run.
 *
 * A persistent Chromium profile holds the game's OPFS DAT cache (up to
 * ~2.4 GB). On 2026-10-12 the shared Mac's disk was down to ~100 MB free:
 * live-drive made a new `live-drive-profile-*` under $TMPDIR on every `serve`
 * and never removed it (129 of them, 41 GB). The rule (docs/verification-workflows.md,
 * "Temp profiles and disk hygiene"):
 *
 *   - a per-run profile is deleted when the run ends: normal exit, `stop`,
 *     SIGINT / SIGTERM / SIGHUP, an uncaught error, or the browser closing;
 *   - each one records its owner pid (OWNER_FILE), and every new run first
 *     sweeps same-prefix profiles whose owner is dead (a crash or SIGKILL
 *     skipped the cleanup), never one whose owner is alive;
 *   - a profile meant to persist (a warm DAT cache on purpose) is a fixed,
 *     caller-named directory that is reused, not one new directory per run.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Written into each per-run profile: `{ pid, startedAt, tool }`. */
export const OWNER_FILE = '.acjs-profile-owner.json';

/** A profile with no owner file (made before owners were recorded) is swept once it is this old. */
export const DEFAULT_UNOWNED_MAX_AGE_MS = 6 * 3600_000;

export interface ProfileDirInfo {
  name: string;
  /** The owner pid from OWNER_FILE; undefined when the file is missing or unreadable. */
  ownerPid?: number;
  /** now − the directory's mtime. */
  ageMs: number;
}

/**
 * Which profile directories to delete (pure). A recorded owner decides: dead
 * → delete, alive → keep, whatever the age (a pid reused by an unrelated
 * process only ever keeps a directory, never deletes a live one). With no
 * owner recorded, only age can tell: delete once older than `unownedMaxAgeMs`.
 */
export function pickStaleProfiles(
  dirs: readonly ProfileDirInfo[],
  isAlive: (pid: number) => boolean,
  opts: { unownedMaxAgeMs?: number; selfPid?: number } = {},
): string[] {
  const maxAge = opts.unownedMaxAgeMs ?? DEFAULT_UNOWNED_MAX_AGE_MS;
  return dirs.filter((d) => {
    if (d.ownerPid !== undefined && Number.isInteger(d.ownerPid) && d.ownerPid > 0) {
      if (d.ownerPid === opts.selfPid) return false;
      return !isAlive(d.ownerPid);
    }
    return d.ageMs > maxAge;
  }).map((d) => d.name);
}

export function pidAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the pid exists but belongs to someone else, so it is alive.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readOwner(dir: string): number | undefined {
  try {
    const pid = (JSON.parse(readFileSync(join(dir, OWNER_FILE), 'utf8')) as { pid?: unknown }).pid;
    return typeof pid === 'number' ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Delete `<parent>/<prefix>*` profiles left by dead runs. Returns the paths removed. */
export function sweepStaleProfiles(prefix: string, opts: { parent?: string; unownedMaxAgeMs?: number; now?: number } = {}): string[] {
  const parent = opts.parent ?? tmpdir();
  const now = opts.now ?? Date.now();
  let names: string[];
  try { names = readdirSync(parent).filter((n) => n.startsWith(prefix)); } catch { return []; }
  const infos: ProfileDirInfo[] = [];
  for (const name of names) {
    const p = join(parent, name);
    try {
      const st = statSync(p);
      if (!st.isDirectory()) continue;
      infos.push({ name, ownerPid: readOwner(p), ageMs: now - st.mtimeMs });
    } catch { /* vanished */ }
  }
  const removed: string[] = [];
  for (const name of pickStaleProfiles(infos, pidAlive, { unownedMaxAgeMs: opts.unownedMaxAgeMs, selfPid: process.pid })) {
    const p = join(parent, name);
    try { rmSync(p, { recursive: true, force: true }); removed.push(p); } catch { /* in use or gone */ }
  }
  return removed;
}

/**
 * Google Chrome's leftover code-sign clones (macOS).
 *
 * On each launch, Chrome copies its app bundle to
 * `$DARWIN_USER_TEMP_DIR/../X/com.google.Chrome.code_sign_clone/code_sign_clone.XXXXXX`
 * and deletes it on a normal quit. A Chrome that is killed or crashes, as
 * the agent and stream Chromes often are, leaves its copy behind. On
 * 2026-11-01, 40 orphans (`du` 86 GB, 16 GB actually freed: APFS clones share
 * blocks until a Chrome update rewrites the app) helped fill the Mac's disk
 * to 757 MB free.
 *
 * A running Chrome makes its clone after the process starts, so a clone born
 * before the oldest running Chrome started belongs to no live Chrome. With no
 * Chrome running, every clone is an orphan. Clones under `minAgeMs` are always
 * kept (a launch in progress).
 */
export const CODE_SIGN_CLONE_MIN_AGE_MS = 10 * 60_000;

export function pickOrphanedCodeSignClones(
  clones: readonly { name: string; bornMs: number }[],
  chromeStartsMs: readonly number[],
  now: number,
  minAgeMs = CODE_SIGN_CLONE_MIN_AGE_MS,
): string[] {
  const oldestStart = chromeStartsMs.length ? Math.min(...chromeStartsMs) : Infinity;
  return clones
    .filter((c) => now - c.bornMs > minAgeMs && c.bornMs < oldestStart)
    .map((c) => c.name);
}

/** Start times of running Google Chrome main processes (helpers excluded), from `ps -axo lstart=,args=`. */
export function parseChromeStarts(psOutput: string): number[] {
  const out: number[] = [];
  for (const line of psOutput.split('\n')) {
    // `Sun Nov  1 14:18:17 2026 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --flags`
    const m = /^\s*(\w{3} \w{3} +\d+ [\d:]+ \d{4}) (.*)$/.exec(line);
    if (!m || !/\/Google Chrome\.app\/Contents\/MacOS\/Google Chrome(?: |$)/.test(m[2])) continue;
    const t = Date.parse(m[1].replace(/ +/g, ' '));
    if (Number.isFinite(t)) out.push(t);
  }
  return out;
}

/** `$DARWIN_USER_TEMP_DIR/../X/com.google.Chrome.code_sign_clone`, or null off macOS. Not tmpdir(): sessions override TMPDIR. */
export function chromeCodeSignCloneDir(): string | null {
  if (process.platform !== 'darwin') return null;
  const r = spawnSync('getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' });
  const t = r.status === 0 ? r.stdout.trim().replace(/\/$/, '') : '';
  return t ? join(dirname(t), 'X', 'com.google.Chrome.code_sign_clone') : null;
}

/** Delete orphaned Chrome code-sign clones. Returns the paths removed; never throws. */
export function sweepChromeCodeSignClones(opts: { dir?: string | null; psOutput?: string; now?: number } = {}): string[] {
  const dir = opts.dir === undefined ? chromeCodeSignCloneDir() : opts.dir;
  if (!dir) return [];
  let names: string[];
  try { names = readdirSync(dir).filter((n) => n.startsWith('code_sign_clone.')); } catch { return []; }
  if (!names.length) return [];
  const ps = opts.psOutput ?? spawnSync('ps', ['-axo', 'lstart=,args='], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const psText = typeof ps === 'string' ? ps : ps.status === 0 ? ps.stdout : null;
  if (psText === null) return []; // can't see running Chromes: delete nothing
  const clones: { name: string; bornMs: number }[] = [];
  for (const name of names) {
    try { clones.push({ name, bornMs: statSync(join(dir, name)).birthtimeMs }); } catch { /* vanished */ }
  }
  const removed: string[] = [];
  for (const name of pickOrphanedCodeSignClones(clones, parseChromeStarts(psText), opts.now ?? Date.now())) {
    const p = join(dir, name);
    try { rmSync(p, { recursive: true, force: true }); removed.push(p); } catch { /* best effort */ }
  }
  return removed;
}

export interface TempProfile {
  dir: string;
  /** False for a caller-named profile that persists on purpose. */
  temporary: boolean;
  /** Close the browser (if registered), delete a temporary profile and drop its exit hooks. Idempotent. */
  dispose(): Promise<void>;
  /** The browser to close before the directory is removed on a signal. */
  setCloser(close: () => Promise<unknown>): void;
}

/**
 * A browser profile for one run. With `persistDir` the caller's directory is
 * used as is and kept (it should be a fixed, reused path). Otherwise a fresh
 * `$TMPDIR/<prefix>XXXXXX` is made, stale ones from dead runs are swept first,
 * and it is removed on exit, on SIGINT / SIGTERM / SIGHUP and on an uncaught
 * error. Call dispose() on the normal path after closing the browser.
 */
export function createRunProfile(
  prefix: string,
  opts: { persistDir?: string; tool?: string; quiet?: boolean; parent?: string } = {},
): TempProfile {
  const clones = sweepChromeCodeSignClones();
  if (clones.length && !opts.quiet) console.error(`[temp-profile] removed ${clones.length} orphaned Chrome code-sign clone(s)`);
  let closer: (() => Promise<unknown>) | null = null;
  const closeBrowser = async (): Promise<void> => {
    if (closer) { const c = closer; closer = null; await c().catch(() => {}); }
  };
  if (opts.persistDir) {
    return { dir: opts.persistDir, temporary: false, setCloser: (c) => { closer = c; }, dispose: closeBrowser };
  }
  const parent = opts.parent ?? tmpdir();
  const swept = sweepStaleProfiles(prefix, { parent });
  if (swept.length && !opts.quiet) console.error(`[temp-profile] removed ${swept.length} stale ${prefix}* profile(s) left by dead runs`);
  const dir = mkdtempSync(join(parent, prefix));
  writeFileSync(join(dir, OWNER_FILE), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), tool: opts.tool ?? prefix }) + '\n');
  let removed = false;
  const removeNow = (): void => {
    if (removed) return;
    removed = true;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  const onSignal = (sig: NodeJS.Signals): void => {
    const code = sig === 'SIGINT' ? 130 : sig === 'SIGHUP' ? 129 : 143;
    // Never hang on a wedged browser: remove after 5 s regardless.
    void Promise.race([closeBrowser(), new Promise((r) => setTimeout(r, 5000))]).then(() => { removeNow(); process.exit(code); });
  };
  const onFatal = (e: unknown): void => { console.error(e); removeNow(); process.exit(1); };
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  process.once('exit', removeNow);
  for (const s of signals) process.once(s, onSignal);
  process.once('uncaughtException', onFatal);
  return {
    dir,
    temporary: true,
    setCloser: (c) => { closer = c; },
    dispose: async () => {
      await closeBrowser();
      removeNow();
      process.off('exit', removeNow);
      for (const s of signals) process.off(s, onSignal);
      process.off('uncaughtException', onFatal);
    },
  };
}
