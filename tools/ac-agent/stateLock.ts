/**
 * A cross-process lock in the agent state dir: an exclusive `mkdir` with the owner's pid inside.
 *
 * Two daemons started at once (the stream supervisor starts Arcanist and Bulwark together) both ran `git worktree add`
 * + `sparse-checkout` for the same tree-<sha>, and one died on "could not lock config file … config.worktree: File
 * exists"; both also picked the same "free" bridge port, so one page ran on the other daemon's bridge and dropped to
 * character select when that daemon stopped (stream rehearsal, 2026-10-13). The daemon now makes its snapshot and
 * picks and binds its ports under this lock: the second waits, then finds the tree made and the port taken.
 *
 * A lock whose owner is gone (its pid is dead, or it is older than `staleMs`) is taken over.
 */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR, pidAlive } from './state.ts';

export interface LockOptions {
  /** Directory the lock lives in (default: the agent state dir). */
  dir?: string;
  /** Give up waiting after this long (ms). */
  timeoutMs?: number;
  /** A lock held longer than this is stale whoever holds it (ms). */
  staleMs?: number;
  /** Poll interval while waiting (ms). */
  pollMs?: number;
  /** This process's pid (tests stand in another). */
  pid?: number;
  now?: () => number;
  /** Is this pid alive (tests replace it). */
  alive?: (pid: number) => boolean;
  /** Told once when the lock is busy and we wait. */
  onWait?: (owner: LockOwner | null) => void;
}

export interface LockOwner { pid: number; at: number; what?: string }

export const LOCK_TIMEOUT_MS = 180_000;
export const LOCK_STALE_MS = 300_000;

export function lockPath(name: string, dir = STATE_DIR): string {
  return join(dir, `${name}.lock`);
}

/** A lock dir with no owner file older than this was left by a holder that died between mkdir and write. */
export const OWNERLESS_STALE_MS = 10_000;

function ageMs(path: string): number {
  try { return Date.now() - statSync(path).mtimeMs; } catch { return 0; }
}

function readOwner(path: string): LockOwner | null {
  try { return JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')) as LockOwner; } catch { return null; }
}

/** Try once: true when this process now holds `name`. A stale lock (dead owner, or too old) is cleared first. */
export function tryLock(name: string, o: LockOptions = {}): boolean {
  const dir = o.dir ?? STATE_DIR;
  const path = lockPath(name, dir);
  const now = (o.now ?? Date.now)();
  const pid = o.pid ?? process.pid;
  mkdirSync(dir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(path);
      writeFileSync(join(path, 'owner.json'), JSON.stringify({ pid, at: now, what: name } satisfies LockOwner) + '\n');
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const owner = readOwner(path);
    // No owner file: the holder is between its mkdir and its write, or died there (stale after a few seconds).
    const stale = owner
      ? !(o.alive ?? pidAlive)(owner.pid) || now - owner.at > (o.staleMs ?? LOCK_STALE_MS)
      : ageMs(path) > OWNERLESS_STALE_MS;
    if (!stale) return false;
    rmSync(path, { recursive: true, force: true });
  }
  return false;
}

export function unlock(name: string, o: Pick<LockOptions, 'dir' | 'pid'> = {}): void {
  const path = lockPath(name, o.dir ?? STATE_DIR);
  const owner = readOwner(path);
  // Only our own lock: a stale one we waited out may already belong to someone else.
  if (owner && owner.pid !== (o.pid ?? process.pid)) return;
  rmSync(path, { recursive: true, force: true });
}

/** Run `fn` holding `name`; waits (polling) while another live process holds it. */
export async function withStateLock<T>(name: string, fn: () => Promise<T> | T, o: LockOptions = {}): Promise<T> {
  const now = o.now ?? Date.now;
  const start = now();
  let told = false;
  while (!tryLock(name, o)) {
    if (!told) { told = true; o.onWait?.(readOwner(lockPath(name, o.dir ?? STATE_DIR))); }
    if (now() - start > (o.timeoutMs ?? LOCK_TIMEOUT_MS)) throw new Error(`timed out waiting for the ${name} lock (${lockPath(name, o.dir ?? STATE_DIR)})`);
    await new Promise((r) => setTimeout(r, o.pollMs ?? 250));
  }
  try {
    return await fn();
  } finally {
    unlock(name, o);
  }
}
