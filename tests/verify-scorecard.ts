/**
 * tools/scorecard-lib.mjs — the retail-match scorecard: summary line, what is
 * due for judging, and the evidence/gap rules on a verdict. Also checks the
 * committed verification/scorecard.json stays well-formed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { summarize, dueForJudging, judge, VERDICTS } from '../tools/scorecard-lib.mjs';

const screen = (id: string, tier: number, verdict = 'unassessed', judged: string | null = null) =>
  ({ id, name: id, tier, captures: [], retail: [], verdict, judged, evidence: '', gaps: [] as string[], notes: '' });

describe('scorecard', () => {
  it('summarize counts verdicts into the one-line score', () => {
    const card = { screens: [screen('a', 1, 'match', '2026-09-20'), screen('b', 1, 'close', '2026-09-20'), screen('c', 2)] };
    expect(summarize(card).line).toBe('retail-match scorecard: 1/3 match · 1 close · 0 off · 1 unassessed');
  });
  it('due: unassessed first by tier, then verdicts older than 21 days (stalest first); fresh verdicts are not due', () => {
    const card = { screens: [
      screen('fresh', 1, 'match', '2026-09-20'),
      screen('stale-old', 2, 'off', '2026-08-01'),
      screen('stale-newer', 2, 'close', '2026-08-20'),
      screen('un-t2', 2), screen('un-t1', 1),
    ] };
    expect(dueForJudging(card, '2026-09-26').map((s: { id: string }) => s.id)).toEqual(['un-t1', 'un-t2', 'stale-old', 'stale-newer']);
  });
  it('judge requires evidence, and gaps (filed task ids) for anything short of match', () => {
    const card = { screens: [screen('inv', 1)] };
    expect(() => judge(card, 'inv', 'close', { evidence: 'x.png', today: '2026-09-26' })).toThrow(/needs --gaps/);
    expect(() => judge(card, 'inv', 'match', { today: '2026-09-26' })).toThrow(/needs --evidence/);
    expect(() => judge(card, 'inv', 'unassessed', { evidence: 'x', today: '2026-09-26' })).toThrow(/match\|close\|off/);
    expect(() => judge(card, 'nope', 'match', { evidence: 'x', today: '2026-09-26' })).toThrow(/no scorecard screen/);
    judge(card, 'inv', 'close', { evidence: 'verification/x/sbs.png', gaps: ['CORE.18.e'], today: '2026-09-26' });
    expect(card.screens[0]).toMatchObject({ verdict: 'close', judged: '2026-09-26', gaps: ['CORE.18.e'] });
  });
  it('judge rejects --gaps ids that are not tasks, or are already closed, for close/off verdicts', () => {
    const tasks = [
      { id: 'OPEN.1', status: 'todo' }, { id: 'CLAIMED.1', status: 'in_progress' }, { id: 'BLOCKED.1', status: 'blocked' },
      { id: 'DONE.1', status: 'done' }, { id: 'LEGACY.1', status: 'completed' },
    ];
    const exists = () => true;
    const card = { screens: [screen('inv', 1)] };
    const opts = (gaps: string[]) => ({ evidence: 'sbs.png', gaps, today: '2026-09-26', tasks, exists });
    expect(() => judge(card, 'inv', 'close', opts(['OPEN.1', 'TYPO.1']))).toThrow(/not in tasks.json: TYPO.1/);
    expect(() => judge(card, 'inv', 'off', opts(['OPEN.1', 'DONE.1']))).toThrow(/already closed.*DONE.1/);
    expect(() => judge(card, 'inv', 'close', opts(['LEGACY.1']))).toThrow(/already closed.*LEGACY.1/);
    expect(card.screens[0].verdict).toBe('unassessed');
    judge(card, 'inv', 'off', opts(['OPEN.1', 'CLAIMED.1', 'BLOCKED.1']));
    expect(card.screens[0]).toMatchObject({ verdict: 'off', gaps: ['OPEN.1', 'CLAIMED.1', 'BLOCKED.1'] });
    // A match may cite the (now closed) tasks that got it there, but they must be real ids.
    judge(card, 'inv', 'match', opts(['DONE.1']));
    expect(() => judge(card, 'inv', 'match', opts(['NOPE']))).toThrow(/not in tasks.json: NOPE/);
  });
  it('judge rejects an --evidence path that does not exist', () => {
    const card = { screens: [screen('inv', 1)] };
    const seen: string[] = [];
    const exists = (p: string) => { seen.push(p); return p === 'verification/real.png'; };
    expect(() => judge(card, 'inv', 'match', { evidence: 'verification/missing.png', today: '2026-09-26', exists })).toThrow(/does not exist/);
    expect(card.screens[0].verdict).toBe('unassessed');
    judge(card, 'inv', 'match', { evidence: 'verification/real.png', today: '2026-09-26', exists });
    expect(seen).toEqual(['verification/missing.png', 'verification/real.png']);
    expect(card.screens[0].verdict).toBe('match');
  });
  it('the committed scorecard is well-formed: unique ids, known verdicts, tiers 1-3', () => {
    const card = JSON.parse(readFileSync('verification/scorecard.json', 'utf8'));
    const ids = card.screens.map((s: { id: string }) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of card.screens) {
      expect(VERDICTS).toContain(s.verdict);
      expect([1, 2, 3]).toContain(s.tier);
      if (s.verdict !== 'unassessed') expect(s.evidence).toBeTruthy();
    }
  });
});
