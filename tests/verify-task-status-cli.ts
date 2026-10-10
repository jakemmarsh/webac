/**
 * tools/task-status.mjs driven as the real CLI against a fixture tasks.json
 * (TASKS_FILE override): the status enum is enforced on set/add, `check`
 * fails on an unknown status, `migrate-status` folds "completed" into "done"
 * with a minimal diff, and --filed / -n are validated (2026-09-26 review).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(__dirname, '..', 'tools', 'task-status.mjs');
let dir: string, file: string;

const t = (id: string, status: string, extra: Record<string, unknown> = {}) =>
  ({ id, title: id, status, tier: 2, filed: '2026-09-01', ...extra });
// Canonical form: 1-space indent, no trailing newline (task-status.mjs canonical()).
const write = (tasks: unknown[]) => writeFileSync(file, JSON.stringify({ tasks }, null, 1));
const read = () => JSON.parse(readFileSync(file, 'utf8')).tasks as { id: string; status: string; filed?: string }[];
const run = (...args: string[]) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, TASKS_FILE: file }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'task-status-')); file = join(dir, 'tasks.json'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('task-status.mjs status enum', () => {
  it('set rejects an unknown status and leaves the file untouched', () => {
    write([t('A', 'todo')]);
    const before = readFileSync(file, 'utf8');
    for (const bad of ['completed', 'in-progress', 'wip']) {
      const r = run('set', 'A', bad);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/status must be one of todo, in_progress, done, blocked/);
    }
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(run('set', 'A', 'done').code).toBe(0);
    expect(read()[0].status).toBe('done');
  });
  it('add rejects an unknown --status and a malformed --filed', () => {
    write([t('A', 'todo')]);
    expect(run('add', 'B', '--title', 'b', '--tier', '2', '--status', 'completed').code).toBe(2);
    const r = run('add', 'B', '--title', 'b', '--tier', '2', '--filed', '2026-9-1');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/YYYY-MM-DD/);
    expect(read().map((x) => x.id)).toEqual(['A']);
    expect(run('add', 'B', '--title', 'b', '--tier', '2', '--filed', '2026-09-02').code).toBe(0);
    expect(read()[1]).toMatchObject({ id: 'B', status: 'todo', filed: '2026-09-02' });
  });
  it('set --filed is validated too', () => {
    write([t('A', 'todo')]);
    expect(run('set', 'A', 'todo', '--filed', 'yesterday').code).toBe(2);
    expect(read()[0].filed).toBe('2026-09-01');
  });
  it('check fails on an unknown status even when the file is canonical, and passes after migrate-status', () => {
    write([t('A', 'completed'), t('B', 'done'), t('C', 'completed'), t('D', 'todo')]);
    const bad = run('check');
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/2 task\(s\) have a status outside/);
    expect(bad.err).toMatch(/A="completed"/);

    const before = readFileSync(file, 'utf8');
    const mig = run('migrate-status');
    expect(mig.code).toBe(0);
    expect(mig.out).toMatch(/rewrote 2 task\(s\) \(2 "completed" -> "done"\)/);
    expect(read().map((x) => x.status)).toEqual(['done', 'done', 'done', 'todo']);
    // Minimal diff: only the two status lines changed.
    const a = before.split('\n'), b = readFileSync(file, 'utf8').split('\n');
    expect(b.length).toBe(a.length);
    expect(a.filter((line, i) => line !== b[i]).map((l) => l.trim())).toEqual(['"status": "completed",', '"status": "completed",']);

    expect(run('check').code).toBe(0);
    expect(run('migrate-status').out).toMatch(/rewrote 0 task\(s\)/);
  });
  it('migrate-status exits 1 naming any status it cannot map', () => {
    write([t('A', 'completed'), t('B', 'wip')]);
    const r = run('migrate-status');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/B="wip"/);
    expect(read().map((x) => x.status)).toEqual(['done', 'wip']);
  });
});

describe('task-status.mjs next', () => {
  it('-n must be a positive integer', () => {
    write([t('A', 'todo')]);
    expect(run('next', '-n', 'abc').code).toBe(2);
    expect(run('next', '-n', '0').code).toBe(2);
    expect(run('next', '-n', '1').code).toBe(0);
  });
  it('reports tier:null the same as a missing tier', () => {
    write([t('A', 'todo', { tier: null }), { id: 'B', title: 'B', status: 'todo', filed: '2026-09-01' }]);
    const r = run('next');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/2 open task\(s\) have no tier \(sorted as 2\): A, B/);
  });
});

describe('task-status.mjs set --local', () => {
  it('stamps a local claim that next skips, keeps the file canonical, and clears it on the next status change', () => {
    write([t('A', 'todo', { tier: 1 }), t('B', 'todo', { tier: 2 })]);
    expect(run('set', 'A', 'in_progress', '--local').code).toBe(0);
    const a = JSON.parse(readFileSync(file, 'utf8')).tasks[0];
    expect(a.claim.by).toBe('local');
    expect(Number.isFinite(Date.parse(a.claim.at))).toBe(true);
    expect(run('check').code).toBe(0);
    expect(run('next').out).not.toMatch(/ A /);
    expect(run('next').out).toMatch(/ B /);
    expect(run('set', 'A', 'done').code).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf8')).tasks[0].claim).toBeUndefined();
  });
});
