#!/usr/bin/env node
/**
 * Archive progress.md by month (OPS.progress-md-archive, 2026-09-26).
 *
 * progress.md had grown to ~33k lines / 5 MB, larger than any context
 * window, and it was not chronological (merge resolutions and the early
 * "Iteration Log" put 2026-03 entries after 2026-08 ones), so "read the tail"
 * did not even yield the latest work. This tool:
 *
 *   - splits the file into entries at every level-2 `## ` heading (a `## `
 *     inside a ``` fence is not a heading; `###` sub-entries stay with the
 *     `## ` entry they sit under),
 *   - dates each entry by the first YYYY-MM-DD in its heading (the formats in
 *     use: `## 2026-09-26 — X`, `## 2026-08-11c (standing 2h cron cycle) — X`,
 *     `## 2026-09-26T21:40:00Z — X`, `## 2026-06-12 (cont.) — X`),
 *   - keeps entries from the last `--keep-days` days (default 14) in
 *     progress.md, sorted by date (stable, so same-day entries keep file order),
 *   - moves older entries into docs/progress-archive/YYYY-MM.md (merged with
 *     whatever that month file already holds, sorted by date, stable), and
 *   - moves entries whose heading has no parseable date into
 *     docs/progress-archive/undated.md in their original order.
 *
 * Text before the first `## ` (the title + blurb) is replaced by LIVE_HEADER,
 * which points at the archive. Re-running is idempotent: once the old entries
 * are gone from progress.md there is nothing further to move.
 *
 *   node tools/archive-progress.mjs [--dry-run] [--today YYYY-MM-DD] [--keep-days 14]
 *                                   [--file progress.md] [--out-dir docs/progress-archive]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const UNDATED = 'undated';

/** First valid YYYY-MM-DD in a heading line, or null. */
export function headingDate(line) {
  for (const m of line.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)) {
    const [, y, mo, d] = m.map(Number);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 2000) return m[0];
  }
  return null;
}

/**
 * Split markdown text into { preamble, entries[] }; each entry is
 * { heading, date, text } where text runs from its `## ` line up to (not
 * including) the next top-level `## ` line and always ends with a newline.
 */
export function splitEntries(text) {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const preamble = [];
  const entries = [];
  let cur = null;
  let fence = null; // the fence marker (``` or ~~~) we are inside, if any
  for (const line of lines) {
    const f = /^\s*(```|~~~)/.exec(line);
    if (f) fence = fence === null ? f[1] : (fence === f[1] ? null : fence);
    if (fence === null && !f && /^## /.test(line)) {
      cur = { heading: line, date: headingDate(line), lines: [line] };
      entries.push(cur);
    } else if (cur) cur.lines.push(line);
    else preamble.push(line);
  }
  return {
    preamble: preamble.length ? `${preamble.join('\n')}\n` : '',
    entries: entries.map(({ heading, date, lines: l }) => ({ heading, date, text: `${l.join('\n')}\n` })),
  };
}

/** Stable sort by date (ascending); entries compare by YYYY-MM-DD only. */
function byDate(entries) {
  return entries.map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.date === b.e.date ? a.i - b.i : a.e.date < b.e.date ? -1 : 1))
    .map(({ e }) => e);
}

/** Subtract `days` from a YYYY-MM-DD, returning YYYY-MM-DD (UTC). */
export function minusDays(ymd, days) {
  const t = Date.parse(`${ymd}T00:00:00Z`) - days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Decide where every entry goes. Returns { keep: entries[], archive: Map<bucket, entries[]> }
 * where bucket is 'YYYY-MM' or UNDATED. An entry is kept when its date is
 * within the last `keepDays` days: date > today - keepDays (so keepDays=14 on
 * 2026-09-26 keeps 2026-09-13 .. 2026-09-26). Entries dated after `today`
 * (clock skew / typos) are kept rather than archived.
 */
export function planArchive(entries, { today, keepDays = 14 }) {
  const cutoff = minusDays(today, keepDays);
  const keep = [];
  const archive = new Map();
  const put = (bucket, e) => { if (!archive.has(bucket)) archive.set(bucket, []); archive.get(bucket).push(e); };
  for (const e of entries) {
    if (e.date === null) put(UNDATED, e);
    else if (e.date > cutoff) keep.push(e);
    else put(e.date.slice(0, 7), e);
  }
  for (const [k, v] of archive) if (k !== UNDATED) archive.set(k, byDate(v));
  return { keep: byDate(keep), archive };
}

export function archiveHeader(bucket) {
  return bucket === UNDATED
    ? '# ACJS Progress Log — undated entries\n\n' +
      'Entries from progress.md whose `## ` heading carried no YYYY-MM-DD date (mostly the\n' +
      'early 2026-03..05 iteration log), in their original file order. Archived by\n' +
      '`tools/archive-progress.mjs`; the live log is `progress.md`.\n\n'
    : `# ACJS Progress Log — ${bucket}\n\n` +
      `Entries from progress.md dated ${bucket}, sorted by date (same-day entries keep file order).\n` +
      'Archived by `tools/archive-progress.mjs`; the live log is `progress.md`.\n\n';
}

export function liveHeader(archiveRel, buckets, keepDays) {
  const months = buckets.filter((b) => b !== UNDATED).sort();
  const list = months.length
    ? `${months.map((m) => `\`${m}.md\``).join(', ')}${buckets.includes(UNDATED) ? ', plus `undated.md`' : ''}`
    : '(none yet)';
  return '# ACJS Progress Log\n\n' +
    `This file holds only the last ~${keepDays} days of entries, oldest first; append new entries\n` +
    'at the end. It is NOT the full history: older entries are archived by month in\n' +
    `\`${archiveRel}/\` (${list}) by \`node tools/archive-progress.mjs\`.\n` +
    'Search the archive (`grep -rn <id> ' + archiveRel + '/`) when you need the history of a task.\n' +
    'Task claims go in tasks.json only; do not add a progress.md entry for a claim.\n\n';
}

/** Compute every file write without touching disk. Returns Map<path, content>. */
export function buildArchive({ text, today, keepDays = 14, outDir, archiveRel, readExisting = () => null }) {
  const { entries } = splitEntries(text);
  const { keep, archive } = planArchive(entries, { today, keepDays });
  const writes = new Map();
  const buckets = new Set([...archive.keys()]);
  for (const [bucket, moved] of archive) {
    const path = join(outDir, `${bucket}.md`);
    const prior = readExisting(path);
    const priorEntries = prior ? splitEntries(prior).entries : [];
    // Month files merge by date; undated keeps arrival order (old first).
    const all = bucket === UNDATED ? [...priorEntries, ...moved] : byDate([...priorEntries, ...moved]);
    writes.set(path, archiveHeader(bucket) + all.map((e) => e.text.replace(/\n*$/, '\n\n')).join('').replace(/\n+$/, '\n'));
  }
  return { writes, keep, archive, buckets, liveText: (allBuckets) =>
    liveHeader(archiveRel, allBuckets, keepDays) + keep.map((e) => e.text.replace(/\n*$/, '\n\n')).join('').replace(/\n+$/, '\n') };
}

function main(argv) {
  const opt = { dryRun: false, today: new Date().toISOString().slice(0, 10), keepDays: 14, file: 'progress.md', outDir: 'docs/progress-archive' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opt.dryRun = true;
    else if (a === '--today') opt.today = argv[++i];
    else if (a === '--keep-days') opt.keepDays = Number(argv[++i]);
    else if (a === '--file') opt.file = argv[++i];
    else if (a === '--out-dir') opt.outDir = argv[++i];
    else { console.error(`archive-progress: unknown flag ${a}`); process.exit(2); }
  }
  if (!/^\d{4}-\d\d-\d\d$/.test(opt.today) || Number.isNaN(Date.parse(opt.today))) { console.error(`archive-progress: --today must be YYYY-MM-DD (got ${opt.today})`); process.exit(2); }
  if (!Number.isInteger(opt.keepDays) || opt.keepDays < 1) { console.error('archive-progress: --keep-days must be a positive integer'); process.exit(2); }
  const file = resolve(REPO, opt.file);
  const outDir = resolve(REPO, opt.outDir);
  const archiveRel = relative(dirname(file), outDir) || '.';
  const text = readFileSync(file, 'utf8');
  const res = buildArchive({ text, today: opt.today, keepDays: opt.keepDays, outDir, archiveRel,
    readExisting: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null) });
  const existing = existsSync(outDir) ? readdirSync(outDir).filter((f) => /^(\d{4}-\d\d|undated)\.md$/.test(f)).map((f) => f.slice(0, -3)) : [];
  const allBuckets = [...new Set([...existing, ...res.buckets])];
  const live = res.liveText(allBuckets);
  const moved = [...res.archive.values()].reduce((n, v) => n + v.length, 0);
  console.log(`archive-progress: ${res.keep.length} entr${res.keep.length === 1 ? 'y' : 'ies'} kept (> ${minusDays(opt.today, opt.keepDays)}), ${moved} moved:`);
  for (const [bucket, v] of [...res.archive].sort()) console.log(`  ${bucket}.md  +${v.length}`);
  if (opt.dryRun) { console.log('archive-progress: --dry-run, nothing written'); return; }
  mkdirSync(outDir, { recursive: true });
  for (const [p, content] of res.writes) writeFileSync(p, content);
  writeFileSync(file, live);
  console.log(`archive-progress: wrote ${relative(REPO, file)} (${live.split('\n').length} lines) + ${res.writes.size} archive file(s)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
