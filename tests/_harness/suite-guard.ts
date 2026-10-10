/**
 * Vitest globalSetup: one test run per machine, and only with memory to spare.
 *
 * 2026-09-30: seven subagents plus the lead each ran the full suite at once.
 * One run at vitest's default worker count peaks around 21 GB RSS, so the
 * machine (36 GB) ran out of memory and crashed. Every vitest invocation in
 * this repo passes through here, whatever the checkout (worktrees included):
 *
 * 1. A machine-wide lock (a directory created atomically under /tmp). A second
 *    run waits for the first to finish and says so. A lock whose owner PID is
 *    gone is taken over.
 * 2. A free-memory gate: the run waits until at least ACJS_TEST_MIN_FREE_GB
 *    (default 8, or 30% of RAM if smaller) is available (macOS vm_stat free+inactive+speculative+
 *    purgeable, Linux MemAvailable). After ACJS_TEST_MEM_WAIT_MIN minutes
 *    (default 10) it fails with a clear message instead of starting.
 *
 * Both are skipped on CI (CI=true: one job per VM) and with ACJS_TEST_LOCK=0. The worker cap and per-worker heap limit live in vitest.config.ts.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { join } from 'node:path';

const LOCK_DIR = process.platform === 'win32' ? join(process.env.TEMP ?? '.', 'acjs-vitest.lock') : '/tmp/acjs-vitest.lock';
const OWNER = join(LOCK_DIR, 'owner.json');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Bytes the OS could hand a new process right now. */
export function availableMemoryBytes(): number {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('vm_stat', { encoding: 'utf8' });
      const page = Number(/page size of (\d+) bytes/.exec(out)?.[1] ?? 16384);
      const pages = (name: string) => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(out)?.[1] ?? 0);
      return (pages('Pages free') + pages('Pages inactive') + pages('Pages speculative') + pages('Pages purgeable')) * page;
    }
    if (process.platform === 'linux') {
      const kb = Number(/MemAvailable:\s+(\d+) kB/.exec(readFileSync('/proc/meminfo', 'utf8'))?.[1]);
      if (kb) return kb * 1024;
    }
  } catch { /* fall through */ }
  return freemem();
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

function readOwner(): { pid: number; cwd: string; started: string } | null {
  try { return JSON.parse(readFileSync(OWNER, 'utf8')); } catch { return null; }
}

/** An ownerless lock dir this old is an orphan (owner.json is written right after mkdir). */
export const ORPHAN_LOCK_MS = 30_000;

function lockAgeMs(): number {
  try { return Date.now() - statSync(LOCK_DIR).mtimeMs; } catch { return 0; }
}

function tryAcquire(): boolean {
  try {
    mkdirSync(LOCK_DIR);
  } catch {
    const owner = readOwner();
    // Owner gone (crashed run), or the dir was created but owner.json never
    // written (the run died in between): an ownerless lock older than
    // ORPHAN_LOCK_MS is reclaimed. Without that, every later suite waited
    // forever behind an empty lock dir (2026-10-10).
    if ((owner && !pidAlive(owner.pid)) || (!owner && lockAgeMs() > ORPHAN_LOCK_MS)) {
      rmSync(LOCK_DIR, { recursive: true, force: true });
      return tryAcquire();
    }
    return false;
  }
  writeFileSync(OWNER, JSON.stringify({ pid: process.pid, cwd: process.cwd(), started: new Date().toISOString() }));
  return true;
}

function release(): void {
  if (readOwner()?.pid === process.pid) rmSync(LOCK_DIR, { recursive: true, force: true });
}

export default async function setup(): Promise<() => void> {
  const onCi = !!process.env.CI && process.env.CI !== 'false';
  if (process.env.ACJS_TEST_LOCK === '0' || onCi) return () => {};

  let waited = 0;
  while (!tryAcquire()) {
    if (waited % 15000 === 0) {
      const o = readOwner();
      console.log(`[suite-guard] another vitest run holds ${LOCK_DIR} (pid ${o?.pid ?? '?'}, ${o?.cwd ?? '?'}, since ${o?.started ?? '?'}); waiting…`);
    }
    await sleep(1000);
    waited += 1000;
  }
  const onExit = () => release();
  process.once('exit', onExit);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { release(); process.exit(130); });

  // Default: 8 GB, or 30% of RAM on a smaller machine (the cloud container).
  const minFree = process.env.ACJS_TEST_MIN_FREE_GB
    ? Number(process.env.ACJS_TEST_MIN_FREE_GB) * 1024 ** 3
    : Math.min(8 * 1024 ** 3, 0.3 * totalmem());
  const deadline = Date.now() + Number(process.env.ACJS_TEST_MEM_WAIT_MIN ?? 10) * 60_000;
  let lastLog = 0;
  for (;;) {
    const avail = availableMemoryBytes();
    if (avail >= minFree) break;
    if (Date.now() > deadline) {
      release();
      throw new Error(`[suite-guard] only ${(avail / 1024 ** 3).toFixed(1)} GB available (need ${(minFree / 1024 ** 3).toFixed(0)} GB); not starting the test run. Close something or set ACJS_TEST_MIN_FREE_GB.`);
    }
    if (Date.now() - lastLog > 15000) {
      console.log(`[suite-guard] ${(avail / 1024 ** 3).toFixed(1)} GB available, waiting for ${(minFree / 1024 ** 3).toFixed(0)} GB…`);
      lastLog = Date.now();
    }
    await sleep(2000);
  }

  return () => { process.removeListener('exit', onExit); release(); };
}

export const SUITE_LOCK_DIR = LOCK_DIR;
export const suiteLockHeld = (): boolean => existsSync(LOCK_DIR);
