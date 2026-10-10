/**
 * The retail-match scorecard (verification/scorecard.json): the fixed list
 * of screens and flows a player meets, each judged "would a retail player
 * notice a difference at a glance?". Filing more tasks can't move it, only
 * making screens match can. That makes it the convergence number that
 * tasks.json counts never were (Jake, 2026-09-26).
 *
 * verdicts: match (a retail player would not notice), close (one or two
 * noticeable differences, all filed as tasks), off (obviously wrong),
 * unassessed. Each verdict carries the date, evidence (side-by-side path)
 * and the open task ids behind any gap.
 */

export const VERDICTS = ['match', 'close', 'off', 'unassessed'];
export const STALE_DAYS = 21;

export function summarize(card) {
  const counts = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
  for (const s of card.screens) counts[s.verdict] = (counts[s.verdict] ?? 0) + 1;
  const total = card.screens.length;
  return { total, ...counts, line: `retail-match scorecard: ${counts.match}/${total} match · ${counts.close} close · ${counts.off} off · ${counts.unassessed} unassessed` };
}

/** Screens to judge next: unassessed first (tier order), then stalest judged beyond STALE_DAYS. */
export function dueForJudging(card, today, staleDays = STALE_DAYS) {
  const age = (d) => (d ? (Date.parse(today) - Date.parse(d)) / 86_400_000 : Infinity);
  return card.screens
    .filter((s) => s.verdict === 'unassessed' || age(s.judged) > staleDays)
    .sort((a, b) => (a.verdict === 'unassessed') === (b.verdict === 'unassessed')
      ? (a.tier - b.tier) || (age(b.judged) - age(a.judged))
      : a.verdict === 'unassessed' ? -1 : 1);
}

/** Closed task statuses ("completed" is the legacy spelling of "done"). */
const CLOSED = new Set(['done', 'completed']);

/**
 * Record a verdict. `tasks` (the tasks.json task list) and `exists` (a path
 * predicate) are the reality checks the CLI always passes: every --gaps id
 * must be a real task, and for close/off it must still be OPEN, because a
 * gap pinned to a closed or mistyped id is a difference nobody is working on;
 * the --evidence side-by-side must exist on disk.
 */
export function judge(card, id, verdict, { evidence = '', gaps = [], notes = '', today, tasks, exists }) {
  if (!VERDICTS.includes(verdict) || verdict === 'unassessed') throw new Error(`verdict must be match|close|off (got ${verdict})`);
  const s = card.screens.find((x) => x.id === id);
  if (!s) throw new Error(`no scorecard screen ${id}`);
  if (verdict !== 'match' && gaps.length === 0) throw new Error(`a ${verdict} verdict needs --gaps <task ids> (every difference is filed)`);
  if (!evidence) throw new Error('a verdict needs --evidence <side-by-side path>');
  if (exists && !exists(evidence)) throw new Error(`--evidence ${evidence} does not exist`);
  if (tasks) {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const missing = gaps.filter((g) => !byId.has(g));
    if (missing.length) throw new Error(`--gaps id(s) not in tasks.json: ${missing.join(', ')}`);
    if (verdict !== 'match') {
      const closed = gaps.filter((g) => CLOSED.has(byId.get(g).status));
      if (closed.length) throw new Error(`--gaps id(s) already closed (a ${verdict} gap must be an open task): ${closed.join(', ')}`);
    }
  }
  Object.assign(s, { verdict, judged: today, evidence, gaps, notes });
  return s;
}
