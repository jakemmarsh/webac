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
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
