/**
 * tools/archive-progress.mjs (OPS.progress-md-archive): splits progress.md
 * into docs/progress-archive/YYYY-MM.md by each `## ` entry's heading date,
 * undated entries to undated.md in original order, and keeps the last 14 days
 * live. Exercised on fixtures through the real CLI and the exported planner;
 * never on the real progress.md.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { headingDate, splitEntries, planArchive, minusDays, UNDATED } from '../tools/archive-progress.mjs';

const CLI = resolve(__dirname, '..', 'tools', 'archive-progress.mjs');

// Every heading format actually used in progress.md, deliberately out of order.
const FIXTURE = [
  '# ACJS Progress Log',
  '',
  'Each loop iteration appends a summary here. This provides context for fresh iterations.',
  '',
  '## 2026-09-20 — RECENT.B: newer entry',
  'body B',
  '',
  '## 2026-08-21 — OLD.AUG1: august',
  'body aug1',
  '```md',
  '## 2026-01-01 — not a heading, inside a fence',
  '```',
  '',
  '## Iteration Log',
  '',
  '### F0.a — undated sub-entry',
  'undated body 1',
  '',
  '## 2026-09-26T21:40:00Z — TODAY.T: ISO timestamp heading',
  'body T',
  '',
  '## 2026-08-11c (standing 2h cron cycle) — OLD.AUG0: lettered date',
  'body aug0',
  '### nested sub-heading stays with its entry',
  '',
  '## 2026-09-13 00:45Z — EDGE.IN: exactly 13 days old (kept)',
  '',
  '## 2026-09-12 — EDGE.OUT: exactly 14 days old (archived)',
  '',
  '## 2026-03-19 — OLD.MAR: march',
  '',
  '## Session totals (FAITHFUL.89-100)',
  'undated body 2',
  '',
  '## 2026-09-14 (cont.) — RECENT.A: older than B but after it in the file',
  'body A',
].join('\n');

describe('archive-progress: parsing', () => {
  it('dates a heading by its first valid YYYY-MM-DD in every format progress.md uses', () => {
    expect(headingDate('## 2026-09-26 — X')).toBe('2026-09-26');
    expect(headingDate('## 2026-08-11c (standing 2h cron cycle) — X')).toBe('2026-08-11');
    expect(headingDate('## 2026-09-26T21:40:00Z — X')).toBe('2026-09-26');
    expect(headingDate('## 2026-06-12 (cont.) — X')).toBe('2026-06-12');
    expect(headingDate('## Iteration Log')).toBeNull();
    expect(headingDate('## FAITHFUL.1234-5678-9999 — X')).toBeNull();
  });
  it('splits at top-level `## ` only: ### stays with its entry, fenced ## is not a heading', () => {
    const { preamble, entries } = splitEntries(FIXTURE);
    expect(preamble).toMatch(/^# ACJS Progress Log/);
    expect(entries.map((e) => e.date)).toEqual([
      '2026-09-20', '2026-08-21', null, '2026-09-26', '2026-08-11', '2026-09-13', '2026-09-12', '2026-03-19', null, '2026-09-14',
    ]);
    expect(entries[1].text).toContain('## 2026-01-01 — not a heading, inside a fence');
    expect(entries[4].text).toContain('### nested sub-heading stays with its entry');
  });
  it('keeps date > today - 14 days, archives the rest by month, undated in original order', () => {
    expect(minusDays('2026-09-26', 14)).toBe('2026-09-12');
    expect(minusDays('2026-03-01', 1)).toBe('2026-02-28');
    const { keep, archive } = planArchive(splitEntries(FIXTURE).entries, { today: '2026-09-26' });
    const ids = (es: { heading: string }[]) => es.map((e) => /— ([A-Z.0-9]+)/.exec(e.heading)?.[1] ?? e.heading);
    // Live entries are re-sorted chronologically (stable).
    expect(ids(keep)).toEqual(['EDGE.IN', 'RECENT.A', 'RECENT.B', 'TODAY.T']);
    expect([...archive.keys()].sort()).toEqual(['2026-03', '2026-08', '2026-09', UNDATED]);
    expect(ids(archive.get('2026-08')!)).toEqual(['OLD.AUG0', 'OLD.AUG1']);
    expect(ids(archive.get('2026-09')!)).toEqual(['EDGE.OUT']);
    expect(archive.get(UNDATED)!.map((e) => e.heading)).toEqual(['## Iteration Log', '## Session totals (FAITHFUL.89-100)']);
  });
});

describe('archive-progress: CLI on a fixture', () => {
  let dir: string;
  const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'archive-progress-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const nonBlank = (s: string) => s.split('\n').filter((l) => l.trim() !== '');

  it('writes month files + undated.md, a short live file pointing at the archive, and loses no line', () => {
    const file = join(dir, 'progress.md');
    const out = join(dir, 'docs', 'progress-archive');
    writeFileSync(file, FIXTURE);
    const r = run('--today', '2026-09-26', '--file', file, '--out-dir', out);
    expect(r.status).toBe(0);
    expect(readdirSync(out).sort()).toEqual(['2026-03.md', '2026-08.md', '2026-09.md', 'undated.md']);

    const live = readFileSync(file, 'utf8');
    expect(live).toMatch(/NOT the full history/);
    expect(live).toContain('docs/progress-archive/');
    expect(live).not.toMatch(/provides context for fresh iterations/);
    expect(live.indexOf('EDGE.IN')).toBeLessThan(live.indexOf('RECENT.A'));
    expect(live.indexOf('RECENT.A')).toBeLessThan(live.indexOf('RECENT.B'));
    expect(live).not.toContain('OLD.AUG');

    const aug = readFileSync(join(out, '2026-08.md'), 'utf8');
    expect(aug.indexOf('OLD.AUG0')).toBeLessThan(aug.indexOf('OLD.AUG1'));
    expect(aug).toContain('body aug0');
    expect(readFileSync(join(out, 'undated.md'), 'utf8')).toMatch(/Iteration Log[\s\S]*Session totals/);

    // Every non-blank line of every entry survives exactly once (only the preamble is replaced).
    const before = nonBlank(FIXTURE).filter((l) => !/^# ACJS Progress Log$|^Each loop iteration/.test(l)).sort();
    const headerLine = (l: string) => /^# ACJS Progress Log|^This file holds|^at the end\. It is NOT|^`[^`]*\/` \(|^Search the archive|^Task claims go|^Entries from progress\.md|^early 2026|^`tools\/archive-progress\.mjs`|^Archived by/.test(l);
    const after = [live, ...readdirSync(out).map((f) => readFileSync(join(out, f), 'utf8'))]
      .flatMap(nonBlank).filter((l) => !headerLine(l)).sort();
    expect(after).toEqual(before);
  });

  it('is idempotent and merges later runs into existing month files chronologically', () => {
    const file = join(dir, 'progress.md');
    const out = join(dir, 'archive');
    writeFileSync(file, FIXTURE);
    expect(run('--today', '2026-09-26', '--file', file, '--out-dir', out).status).toBe(0);
    const snapshot = () => Object.fromEntries([file, ...readdirSync(out).map((f) => join(out, f))].map((p) => [p, readFileSync(p, 'utf8')]));
    const first = snapshot();
    expect(run('--today', '2026-09-26', '--file', file, '--out-dir', out).status).toBe(0);
    expect(snapshot()).toEqual(first);

    // Two weeks later the kept September entries age out and merge into 2026-09.md by date.
    expect(run('--today', '2026-10-15', '--file', file, '--out-dir', out).status).toBe(0);
    const sep = readFileSync(join(out, '2026-09.md'), 'utf8');
    const order = ['EDGE.OUT', 'EDGE.IN', 'RECENT.A', 'RECENT.B', 'TODAY.T'].map((id) => sep.indexOf(id));
    expect(order.every((x) => x >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(readFileSync(file, 'utf8')).not.toMatch(/^## /m);
  });

  it('--dry-run writes nothing; bad --today is rejected', () => {
    const file = join(dir, 'progress.md');
    const out = join(dir, 'archive');
    writeFileSync(file, FIXTURE);
    const r = run('--dry-run', '--today', '2026-09-26', '--file', file, '--out-dir', out);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/4 entries kept .* 6 moved/);
    expect(existsSync(out)).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(FIXTURE);
    expect(run('--today', '26-09-2026', '--file', file, '--out-dir', out).status).toBe(2);
  });
});
