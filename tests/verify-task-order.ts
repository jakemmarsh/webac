/**
 * tools/task-order-lib.mjs — the loop's pick order (prompt v4.8): tier first,
 * then age, never id lineage; plus the tier validator task-status.mjs uses.
 */
import { describe, it, expect } from 'vitest';
import {
  pickOrder, parseTier, parseStatus, parseFiled, parseCount, isUntiered, unknownStatuses, migrateStatuses, STATUSES,
  isFreshLocalClaim, LOCAL_CLAIM_TTL_MS,
} from '../tools/task-order-lib.mjs';

const task = (id: string, o: Record<string, unknown> = {}) => ({ id, status: 'todo', title: id, ...o });

describe('pickOrder', () => {
  it('a month-old tier-1 bug beats a fresh deep follow-up of a lower-numbered CORE chain', () => {
    const order = pickOrder([
      task('CORE.17.k.b.b.c.c.a.a.c.a.a.a.a.a.b', { tier: 3, filed: '2026-09-25' }),
      task('CORE.18.e', { tier: 1, filed: '2026-09-26' }),
      task('BUG.movement-pinned', { tier: 1, filed: '2026-08-23' }),
      task('BUG.sold-item', { tier: 2, filed: '2026-09-23' }),
    ]).map((t: { id: string }) => t.id);
    expect(order).toEqual(['BUG.movement-pinned', 'CORE.18.e', 'BUG.sold-item', 'CORE.17.k.b.b.c.c.a.a.c.a.a.a.a.a.b']);
  });
  it('an in-progress claim is always first; done/blocked tasks and skipped ids never appear', () => {
    const order = pickOrder([
      task('A', { tier: 1, filed: '2026-01-01' }),
      task('CLAIMED', { tier: 3, filed: '2026-09-26', status: 'in_progress' }),
      task('DONE', { tier: 1, status: 'done' }),
      task('BLOCKED', { tier: 1, status: 'blocked' }),
      task('JAKE', { tier: 1, filed: '2025-01-01' }),
    ], { skip: ['JAKE'] }).map((t: { id: string }) => t.id);
    expect(order).toEqual(['CLAIMED', 'A']);
  });
  it('untiered tasks sort as tier 2; ties keep file order', () => {
    const order = pickOrder([
      task('T3', { tier: 3, filed: '2026-01-01' }),
      task('NOTIER', { filed: '2026-05-01' }),
      task('T2a', { tier: 2, filed: '2026-05-01' }),
      task('T1', { tier: 1, filed: '2026-09-01' }),
    ]).map((t: { id: string }) => t.id);
    expect(order).toEqual(['T1', 'NOTIER', 'T2a', 'T3']);
  });
});

describe('pickOrder: missing data never jumps the queue (2026-09-26 review)', () => {
  it('a task with no filed date sorts LAST within its tier, not first', () => {
    const order = pickOrder([
      task('UNDATED', { tier: 1 }),
      task('NEW', { tier: 1, filed: '2026-09-26' }),
      task('OLD', { tier: 1, filed: '2026-08-01' }),
      task('EMPTY', { tier: 1, filed: '' }),
      task('T2', { tier: 2, filed: '2020-01-01' }),
    ]).map((t: { id: string }) => t.id);
    expect(order).toEqual(['OLD', 'NEW', 'UNDATED', 'EMPTY', 'T2']);
  });
  it('tier null and tier undefined are the same thing: both sort as tier 2 and both count as untiered', () => {
    const tasks = [
      task('NULL', { tier: null, filed: '2026-01-01' }),
      task('T2', { tier: 2, filed: '2026-02-01' }),
      task('UNDEF', { filed: '2026-03-01' }),
      task('T3', { tier: 3, filed: '2025-01-01' }),
    ];
    expect(pickOrder(tasks).map((t: { id: string }) => t.id)).toEqual(['NULL', 'T2', 'UNDEF', 'T3']);
    expect(tasks.filter(isUntiered).map((t) => t.id)).toEqual(['NULL', 'UNDEF']);
  });
});

describe('status / filed / count validators', () => {
  it('the status enum is exactly todo, in_progress, done, blocked', () => {
    expect(STATUSES).toEqual(['todo', 'in_progress', 'done', 'blocked']);
    for (const ok of STATUSES) expect(parseStatus(ok)).toBe(ok);
    for (const bad of ['completed', 'in-progress', 'Done', '', undefined]) expect(() => parseStatus(bad)).toThrow(/status must be one of/);
  });
  it('filed must be a real YYYY-MM-DD date', () => {
    expect(parseFiled('2026-09-26')).toBe('2026-09-26');
    for (const bad of ['2026-9-26', '26-09-2026', '2026-13-01', '2026-02-30', 'today', '', undefined]) {
      expect(() => parseFiled(bad)).toThrow(/YYYY-MM-DD/);
    }
  });
  it('-n must be a positive integer', () => {
    expect(parseCount('7')).toBe(7);
    for (const bad of ['abc', '0', '-3', '2.5', '']) expect(() => parseCount(bad)).toThrow(/positive integer/);
  });
  it('unknownStatuses flags anything outside the enum; migrateStatuses folds "completed" into "done" and counts it', () => {
    const tasks = [task('A', { status: 'completed' }), task('B', { status: 'done' }), task('C', { status: 'completed' }), task('D', { status: 'wip' })];
    expect(unknownStatuses(tasks)).toEqual([{ id: 'A', status: 'completed' }, { id: 'C', status: 'completed' }, { id: 'D', status: 'wip' }]);
    expect(migrateStatuses(tasks)).toEqual({ completed: 2 });
    expect(tasks.map((t) => t.status)).toEqual(['done', 'done', 'done', 'wip']);
    expect(unknownStatuses(tasks)).toEqual([{ id: 'D', status: 'wip' }]);
    expect(migrateStatuses(tasks)).toEqual({});
  });
});

describe('parseTier', () => {
  it('accepts 1-3 only', () => {
    expect(parseTier('1')).toBe(1);
    expect(parseTier(3)).toBe(3);
    for (const bad of ['0', '4', 'high', '']) expect(() => parseTier(bad)).toThrow(/tier must be 1, 2 or 3/);
  });
});

describe('pickOrder: local (Jake-machine) claims run in parallel with the loop', () => {
  const now = Date.parse('2026-09-27T12:00:00Z');
  const at = (minsAgo: number) => new Date(now - minsAgo * 60_000).toISOString();
  it('a fresh local claim is hidden, so the loop picks the next task instead of standing down', () => {
    const tasks = [
      task('LOCAL', { status: 'in_progress', tier: 1, filed: '2026-09-01', claim: { by: 'local', at: at(10) } }),
      task('NEXT', { tier: 1, filed: '2026-09-02' }),
    ];
    expect(pickOrder(tasks, { now }).map((t) => t.id)).toEqual(['NEXT']);
    expect(isFreshLocalClaim(tasks[0], now)).toBe(true);
  });
  it('a stale local claim surfaces again as a claim (takeover); a cloud claim is never hidden', () => {
    const stale = task('STALE', { status: 'in_progress', tier: 1, claim: { by: 'local', at: at(LOCAL_CLAIM_TTL_MS / 60_000 + 1) } });
    const cloud = task('CLOUD', { status: 'in_progress', tier: 2 });
    expect(pickOrder([task('T', { tier: 1 }), stale, cloud], { now }).map((t) => t.id)).toEqual(['STALE', 'CLOUD', 'T']);
  });
  it('a malformed claim time is not treated as fresh', () => {
    expect(isFreshLocalClaim(task('X', { status: 'in_progress', claim: { by: 'local', at: 'nope' } }), now)).toBe(false);
  });
});
