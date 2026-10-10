#!/usr/bin/env node
/**
 * Retail-match scorecard CLI (tools/scorecard-lib.mjs, verification/scorecard.json).
 *
 *   node tools/scorecard.mjs                 # the summary line + every screen
 *   node tools/scorecard.mjs due             # what to judge next (unassessed, then >21 days old)
 *   node tools/scorecard.mjs judge <id> match|close|off --evidence <path> [--gaps T1,T2] [--notes ".."]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dueForJudging, judge, summarize } from './scorecard-lib.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = resolve(REPO, 'verification', 'scorecard.json');
const card = JSON.parse(readFileSync(FILE, 'utf8'));
const today = new Date().toISOString().slice(0, 10);
const [cmd, id, verdict, ...rest] = process.argv.slice(2);

if (!cmd) {
  console.log(summarize(card).line);
  for (const s of card.screens) console.log(`  ${s.verdict.padEnd(10)} T${s.tier} ${s.id.padEnd(22)} ${s.judged ?? '—'}  ${s.name}${s.gaps?.length ? `  [${s.gaps.join(', ')}]` : ''}`);
} else if (cmd === 'due') {
  const due = dueForJudging(card, today);
  console.log(`${summarize(card).line}\n${due.length} due for judging:`);
  for (const s of due.slice(0, 10)) console.log(`  T${s.tier} ${s.id} (${s.verdict}${s.judged ? `, judged ${s.judged}` : ''}) — captures: ${s.captures.join(', ') || '(live flow)'}; retail: ${s.retail.join(', ') || '(retail client A/B)'}`);
} else if (cmd === 'judge') {
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--evidence') flags.evidence = rest[++i];
    else if (rest[i] === '--gaps') flags.gaps = rest[++i].split(',').map((x) => x.trim()).filter(Boolean);
    else if (rest[i] === '--notes') flags.notes = rest[++i];
  }
  // Reality checks: gap ids must be real (and open for close/off) tasks, and
  // the evidence path must exist (relative paths resolve from the repo root).
  const tasks = JSON.parse(readFileSync(resolve(REPO, 'tasks.json'), 'utf8')).tasks;
  const exists = (p) => existsSync(resolve(REPO, p));
  try { judge(card, id, verdict, { ...flags, today, tasks, exists }); } catch (e) { console.error(`scorecard: ${e.message}`); process.exit(2); }
  writeFileSync(FILE, `${JSON.stringify(card, null, 1)}\n`);
  console.log(`scorecard: ${id} -> ${verdict}\n${summarize(card).line}`);
} else {
  console.error('usage: scorecard.mjs [due | judge <id> match|close|off --evidence <path> [--gaps a,b] [--notes ..]]'); process.exit(2);
}
