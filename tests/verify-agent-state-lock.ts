import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lockPath, tryLock, unlock, withStateLock } from '../tools/ac-agent/stateLock.ts';
import { waitForCalls } from '../tools/ac-agent/shutdown.ts';

// Stream rehearsal 2026-10-13: the supervisor started Arcanist's and Bulwark's daemons together. Both ran `git worktree
// add` + `sparse-checkout` for the same tree-<sha> (one died: "could not lock config file … config.worktree: File
// exists"), and both bound "free" bridge port 9151: Bulwark's bridge died on EADDRINUSE, his page ran on Arcanist's
// bridge, and when Arcanist's daemon stopped Bulwark dropped to character select mid wrap-up. The daemon now makes its
// snapshot and starts its bridge and Vite under a state-dir lock (tools/ac-agent/stateLock.ts).

const REPO = join(__dirname, '..');
const tmp = () => mkdtempSync(join(tmpdir(), 'acjs-lock-'));

describe('agent state lock', () => {
  it('a second caller waits for the first and then runs; the critical sections never overlap', async () => {
    const dir = tmp();
    try {
      const log: string[] = [];
      const section = (who: string) => async () => { log.push(`${who}+`); await new Promise((r) => setTimeout(r, 60)); log.push(`${who}-`); return who; };
      let waited = 0;
      const [a, b] = await Promise.all([
        withStateLock('daemon-start', section('a'), { dir, pollMs: 10 }),
        withStateLock('daemon-start', section('b'), { dir, pollMs: 10, onWait: () => waited++ }),
      ]);
      expect([a, b]).toEqual(['a', 'b']);
      expect(log).toEqual(['a+', 'a-', 'b+', 'b-']);
      expect(waited).toBe(1);
      expect(existsSync(lockPath('daemon-start', dir))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('releases on a throw, so the next caller is not stuck', async () => {
    const dir = tmp();
    try {
      await expect(withStateLock('x', () => { throw new Error('git worktree add failed'); }, { dir })).rejects.toThrow(/worktree add/);
      expect(await withStateLock('x', () => 'ok', { dir })).toBe('ok');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('takes over a lock whose owner died or is too old, but never a live one; gives up after its timeout', async () => {
    const dir = tmp();
    try {
      const now = 1_000_000;
      expect(tryLock('s', { dir, pid: 111, now: () => now, alive: () => true })).toBe(true);
      // Held by a live pid: not ours.
      expect(tryLock('s', { dir, pid: 222, now: () => now + 1000, alive: () => true })).toBe(false);
      // Its owner died: taken over.
      expect(tryLock('s', { dir, pid: 222, now: () => now + 1000, alive: (p) => p !== 111 })).toBe(true);
      expect(JSON.parse(readFileSync(join(lockPath('s', dir), 'owner.json'), 'utf8')).pid).toBe(222);
      // Too old, even if the pid looks alive (a reused pid).
      expect(tryLock('s', { dir, pid: 333, now: () => now + 10 * 60_000, alive: () => true, staleMs: 300_000 })).toBe(true);
      // Unlock only removes our own.
      unlock('s', { dir, pid: 222 });
      expect(existsSync(lockPath('s', dir))).toBe(true);
      unlock('s', { dir, pid: 333 });
      expect(existsSync(lockPath('s', dir))).toBe(false);
      // A lock dir with no owner file: fresh = someone between mkdir and write; old = a holder that died there.
      mkdirSync(lockPath('o', dir));
      expect(tryLock('o', { dir, alive: () => true })).toBe(false);
      const past = new Date(Date.now() - 60_000);
      utimesSync(lockPath('o', dir), past, past);
      expect(tryLock('o', { dir, alive: () => true })).toBe(true);
      // Waiting on a live holder times out with a clear error.
      writeFileSync(join(lockPath('o', dir), 'owner.json'), JSON.stringify({ pid: 999_999, at: Date.now() }));
      await expect(withStateLock('o', () => 1, { dir, alive: () => true, timeoutMs: 50, pollMs: 10 })).rejects.toThrow(/timed out waiting for the o lock/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('across processes: two started at once take turns (the daemons\' real case)', async () => {
    const dir = tmp();
    try {
      const script = join(dir, 'holder.mts');
      writeFileSync(script, [
        `import { appendFileSync } from 'node:fs';`,
        `import { withStateLock } from ${JSON.stringify(join(REPO, 'tools', 'ac-agent', 'stateLock.ts'))};`,
        `const [dir, who] = process.argv.slice(2);`,
        `await withStateLock('daemon-start', async () => {`,
        `  appendFileSync(dir + '/log', who + '+\\n');`,
        `  await new Promise((r) => setTimeout(r, 300));`,
        `  appendFileSync(dir + '/log', who + '-\\n');`,
        `}, { dir, pollMs: 20 });`,
      ].join('\n'));
      const run = (who: string) => new Promise<number | null>((res) => {
        const c = spawn(join(REPO, 'node_modules', '.bin', 'tsx'), [script, dir, who], { stdio: 'ignore' });
        c.on('exit', res);
      });
      expect(await Promise.all([run('a'), run('b')])).toEqual([0, 0]);
      const log = readFileSync(join(dir, 'log'), 'utf8').trim().split('\n');
      expect(log).toHaveLength(4);
      // Whoever went first finished before the other started.
      expect(log[0][0]).toBe(log[1][0]);
      expect(log[0].endsWith('+') && log[1].endsWith('-') && log[2].endsWith('+') && log[3].endsWith('-')).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);
});

describe('daemon shutdown: the player\'s last call finishes before the logout', () => {
  it('waits while calls run, up to its limit', async () => {
    let running = 2;
    const slept: number[] = [];
    const done = await waitForCalls(() => running, 10_000, async (ms) => { slept.push(ms); if (slept.length === 3) running = 0; }, 200);
    expect(done).toBe(true);
    expect(slept).toEqual([200, 200, 200]);
    // Nothing running: no wait at all.
    expect(await waitForCalls(() => 0, 10_000, async () => { throw new Error('slept'); })).toBe(true);
    // A call that never ends (a 300 s wait): give up after the limit and log out anyway.
    let n = 0;
    expect(await waitForCalls(() => 1, 1000, async () => { n++; }, 200)).toBe(false);
    expect(n).toBe(5);
  });
});
