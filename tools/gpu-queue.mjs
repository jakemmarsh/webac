#!/usr/bin/env node
// gpu-queue — file and read real-GPU jobs (docs/gpu-worker.md).
//
//   node tools/gpu-queue.mjs request --kind perf-soak --task REND.foo [--sha <commit>] [--stops 8] [--minutes 60]
//   node tools/gpu-queue.mjs request --kind screen-regression --task VISUAL.x --base <commit> [--ui] [--expect a,b*] [--names n1,n2]
//   node tools/gpu-queue.mjs request --kind sidebyside --task VISUAL.x --scenes inventory,chat
//   node tools/gpu-queue.mjs request --kind perf --task PERF.y
//   node tools/gpu-queue.mjs request --kind dat-streaming --task RELEASE.x [--teleports holtburg,shoushi]
//   node tools/gpu-queue.mjs request --kind retail-ab --task VISUAL.x [--scenes holtburg,inventory] [--side both|retail|ours]
//   node tools/gpu-queue.mjs status                 pending jobs + the newest results
//   node tools/gpu-queue.mjs results [--since ISO] [--json]   results finished after --since
//   node tools/gpu-queue.mjs next --json            the oldest pending job (the worker's pick)
//
// `request` writes verification/gpu-queue/<id>.json (default sha = HEAD) and
// prints the id; commit and push it with the task's other changes. Both
// directories are CI-ignored (verification/**/*.json, *.png).
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { KINDS, QUEUE_DIR, RESULTS_DIR, validateJob, pendingJobs, newJobId } from './gpu-queue-lib.mjs';

const ROOT = process.env.GPU_QUEUE_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const [cmd, ...rest] = process.argv.slice(2);
const opt = (n) => { const i = rest.indexOf(`--${n}`); return i > -1 ? rest[i + 1] : undefined; };
const flag = (n) => rest.includes(`--${n}`);
const list = (n) => opt(n)?.split(',').map((s) => s.trim()).filter(Boolean);

export function readJobs(root = ROOT) {
  const dir = join(root, QUEUE_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    // _file: the queue file's own name, so even a job with a missing or bad
    // id can be closed with a result directory named after it.
    try { return { ...JSON.parse(readFileSync(join(dir, f), 'utf8')), _file: f.slice(0, -5) }; } catch { return { _file: f.slice(0, -5), requestedAt: '1970-01-01T00:00:00Z' }; }
  }).filter(Boolean);
}
export function readResults(root = ROOT) {
  const dir = join(root, RESULTS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((d) => {
    try { return JSON.parse(readFileSync(join(dir, d, 'result.json'), 'utf8')); } catch { return null; }
  }).filter(Boolean).sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt));
}

function line(r) {
  return `${r.verdict.padEnd(7)} ${r.kind.padEnd(17)} ${(r.task ?? '-').padEnd(40)} ${r.sha.slice(0, 8)} ${r.finishedAt}  ${RESULTS_DIR}/${r.id}/  ${r.headline ?? ''}`;
}

if (cmd === 'request') {
  const kind = opt('kind');
  const sha = opt('sha') ?? execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const args = {};
  if (kind === 'perf-soak' && opt('stops')) args.stops = Number(opt('stops'));
  if (kind === 'perf-soak' && opt('minutes')) args.minutes = Number(opt('minutes'));
  if (kind === 'screen-regression') {
    args.base = opt('base');
    if (flag('ui')) args.ui = true;
    if (list('expect')) args.expect = list('expect');
    if (list('names')) args.names = list('names');
  }
  if (kind === 'sidebyside') args.scenes = list('scenes');
  if (kind === 'dat-streaming' && list('teleports')) args.teleports = list('teleports');
  if (kind === 'retail-ab') {
    if (list('scenes')) args.scenes = list('scenes');
    if (opt('side')) args.side = opt('side');
  }
  const job = { kind, sha, task: opt('task'), args, requestedAt: new Date().toISOString(), requestedBy: opt('by') ?? 'routine' };
  if (!job.task) delete job.task;
  job.id = newJobId(job);
  const errors = validateJob(job);
  if (errors.length) { console.error(`gpu-queue: invalid job: ${errors.join('; ')}`); process.exit(1); }
  mkdirSync(join(ROOT, QUEUE_DIR), { recursive: true });
  writeFileSync(join(ROOT, QUEUE_DIR, `${job.id}.json`), JSON.stringify(job, null, 1) + '\n');
  console.log(job.id);
} else if (cmd === 'status') {
  const results = readResults();
  const pending = pendingJobs(readJobs(), results.map((r) => r.id));
  console.log(`pending (${pending.length}):`);
  for (const j of pending) console.log(`  ${j.kind.padEnd(17)} ${(j.task ?? '-').padEnd(40)} ${j.sha.slice(0, 8)} requested ${j.requestedAt}  ${j.id}`);
  console.log(`results (newest ${Math.min(10, results.length)} of ${results.length}):`);
  for (const r of results.slice(0, 10)) console.log('  ' + line(r));
} else if (cmd === 'results') {
  const since = opt('since') ? Date.parse(opt('since')) : 0;
  const rs = readResults().filter((r) => Date.parse(r.finishedAt) > since);
  if (flag('json')) console.log(JSON.stringify(rs, null, 1));
  else for (const r of rs) console.log(line(r));
} else if (cmd === 'next') {
  const results = readResults();
  // The oldest pending job, valid or not: the worker closes an invalid one
  // with an `error` result (its `errors`) so it never sits in the queue.
  const job = pendingJobs(readJobs(), results.map((r) => r.id))[0] ?? null;
  const next = job && { ...job, errors: validateJob(job) };
  console.log(flag('json') ? JSON.stringify(next) : next ? next.id : '');
} else {
  console.log(`usage: gpu-queue.mjs request|status|results|next  (kinds: ${Object.keys(KINDS).join(', ')})`);
  process.exit(cmd ? 1 : 0);
}
