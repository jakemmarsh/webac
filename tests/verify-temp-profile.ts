/**
 * Per-run browser profiles never outlive their run (2026-10-12: 129 leaked
 * live-drive profiles, 41 GB, filled the shared Mac's disk), and the stale
 * sweep never deletes a live session's profile. Also the ac-agent snapshot
 * tree pruning (57 trees, 2.9 GB, never pruned).
 */
import { describe, expect, it, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OWNER_FILE, createRunProfile, pickStaleProfiles, sweepStaleProfiles } from '../tools/lib/temp-profile.ts';
import { pickStaleSnapshots } from '../tools/ac-agent/state.ts';

const H = 3600_000;
/** A pid that has exited (a child we ran to completion). */
const deadPid = (): number => spawnSync(process.execPath, ['-e', '0']).pid!;

describe('pickStaleProfiles', () => {
  const alive = new Set([100, 200]);
  const isAlive = (pid: number): boolean => alive.has(pid);

  it('deletes a dead owner\'s profile at any age and never a live owner\'s', () => {
    const picked = pickStaleProfiles([
      { name: 'p-dead-young', ownerPid: 300, ageMs: 1000 },
      { name: 'p-dead-old', ownerPid: 301, ageMs: 100 * H },
      { name: 'p-live-old', ownerPid: 100, ageMs: 100 * H },
      { name: 'p-live-young', ownerPid: 200, ageMs: 10 },
    ], isAlive);
    expect(picked.sort()).toEqual(['p-dead-old', 'p-dead-young']);
  });

  it('a profile with no recorded owner goes only once older than the cutoff', () => {
    const picked = pickStaleProfiles([
      { name: 'legacy-old', ageMs: 7 * H },
      { name: 'legacy-new', ageMs: 5 * H },
      { name: 'just-made', ageMs: 0 },
    ], isAlive, { unownedMaxAgeMs: 6 * H });
    expect(picked).toEqual(['legacy-old']);
  });

  it('never its own process\'s profile, even if the liveness check says dead', () => {
    expect(pickStaleProfiles([{ name: 'mine', ownerPid: 42, ageMs: 100 * H }], () => false, { selfPid: 42 })).toEqual([]);
  });

  it('ignores a malformed owner pid (treated as unowned)', () => {
    expect(pickStaleProfiles([{ name: 'bad', ownerPid: 0, ageMs: 1000 }], () => false)).toEqual([]);
    expect(pickStaleProfiles([{ name: 'bad', ownerPid: 0, ageMs: 100 * H }], () => false)).toEqual(['bad']);
  });
});

describe('sweepStaleProfiles / createRunProfile on real directories', () => {
  let parent = '';
  afterEach(() => { if (parent) rmSync(parent, { recursive: true, force: true }); });

  const makeProfile = (name: string, owner?: number, ageMs = 0): string => {
    const d = join(parent, name);
    mkdirSync(join(d, 'Default', 'File System'), { recursive: true });
    writeFileSync(join(d, 'Default', 'File System', 'blob'), 'x'.repeat(1024));
    if (owner !== undefined) writeFileSync(join(d, OWNER_FILE), JSON.stringify({ pid: owner }));
    if (ageMs) { const t = new Date(Date.now() - ageMs); utimesSync(d, t, t); }
    return d;
  };

  it('removes dead-owner and old unowned profiles of the prefix only', () => {
    parent = mkdtempSync(join(tmpdir(), 'acjs-tp-test-'));
    const dead = makeProfile('live-drive-profile-dead', deadPid());
    const live = makeProfile('live-drive-profile-live', process.ppid, 100 * H);
    const legacy = makeProfile('live-drive-profile-legacy', undefined, 30 * H);
    const fresh = makeProfile('live-drive-profile-fresh');
    const other = makeProfile('acjs-other-dead', deadPid());
    const removed = sweepStaleProfiles('live-drive-profile-', { parent });
    expect(removed.sort()).toEqual([dead, legacy].sort());
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });

  it('a run profile records its owner, sweeps dead ones first, and dispose closes the browser, removes it and drops its hooks', async () => {
    parent = mkdtempSync(join(tmpdir(), 'acjs-tp-test-'));
    const leaked = makeProfile('acjs-tp-run-leaked', deadPid());
    const before = { exit: process.listenerCount('exit'), sigint: process.listenerCount('SIGINT'), unc: process.listenerCount('uncaughtException') };
    const p = createRunProfile('acjs-tp-run-', { parent, quiet: true });
    expect(existsSync(leaked)).toBe(false);
    expect(p.temporary).toBe(true);
    expect(JSON.parse(readFileSync(join(p.dir, OWNER_FILE), 'utf8')).pid).toBe(process.pid);
    // A second run in the same process sees the first as live (its own pid) and leaves it alone.
    expect(sweepStaleProfiles('acjs-tp-run-', { parent })).toEqual([]);
    let closed = 0;
    p.setCloser(async () => { closed++; });
    await p.dispose();
    await p.dispose();
    expect(closed).toBe(1);
    expect(existsSync(p.dir)).toBe(false);
    expect({ exit: process.listenerCount('exit'), sigint: process.listenerCount('SIGINT'), unc: process.listenerCount('uncaughtException') }).toEqual(before);
  });

  it('a caller-named persistent profile is kept; dispose only closes the browser', async () => {
    parent = mkdtempSync(join(tmpdir(), 'acjs-tp-test-'));
    const keep = join(parent, 'warm');
    mkdirSync(keep);
    const p = createRunProfile('acjs-tp-run-', { persistDir: keep });
    let closed = 0;
    p.setCloser(async () => { closed++; });
    await p.dispose();
    expect(p.temporary).toBe(false);
    expect(closed).toBe(1);
    expect(existsSync(keep)).toBe(true);
  });

  it('a run killed with SIGKILL leaves a profile the next run sweeps', () => {
    parent = mkdtempSync(join(tmpdir(), 'acjs-tp-test-'));
    // A child makes a run profile and is SIGKILLed before any cleanup can run.
    const mod = join(__dirname, '../tools/lib/temp-profile.ts');
    const child = spawnSync(process.execPath, ['--import', 'tsx', '-e',
      `const { createRunProfile } = await import(${JSON.stringify(mod)}); const p = createRunProfile('acjs-tp-kill-', { parent: ${JSON.stringify(parent)}, quiet: true }); console.log(p.dir); process.kill(process.pid, 'SIGKILL');`,
    ], { encoding: 'utf8', input: '' });
    const leftover = child.stdout.trim();
    expect(child.signal).toBe('SIGKILL');
    expect(existsSync(leftover)).toBe(true);
    expect(sweepStaleProfiles('acjs-tp-kill-', { parent })).toEqual([leftover]);
    expect(existsSync(leftover)).toBe(false);
  });
});

describe('pickStaleSnapshots (ac-agent game snapshot trees)', () => {
  const trees = [
    { name: 'tree-a', ageMs: 1 * H },
    { name: 'tree-b', ageMs: 2 * H },
    { name: 'tree-c', ageMs: 3 * H },
    { name: 'tree-d', ageMs: 50 * H },
    { name: 'tree-e', ageMs: 80 * H },
    { name: 'tree-f', ageMs: 0.5 * H },
  ];

  it('keeps the newest few and any a live daemon serves; removes the rest', () => {
    expect(pickStaleSnapshots(trees, new Set(['tree-e']), { keepNewest: 3, graceMs: 0 }).sort()).toEqual(['tree-c', 'tree-d']);
  });

  it('never removes one touched within the grace window', () => {
    expect(pickStaleSnapshots(trees, new Set(), { keepNewest: 0, graceMs: 2.5 * H }).sort()).toEqual(['tree-c', 'tree-d', 'tree-e']);
  });
});
