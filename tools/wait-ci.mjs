#!/usr/bin/env node
// wait-ci — wait for the CI verdict on a pushed commit (docs/remote-agent-ops.md).
//
//   node tools/wait-ci.mjs [<sha>=HEAD] [--timeout-min 25] [--repo owner/name]
//
// Exit 0 = CI passed on a run covering <sha>, 1 = it failed (fix main before
// anything else), 2 = no verdict (no run yet, every covering run cancelled,
// or the timeout) — then `bash tools/ci-local.sh --ci-shape` is the gate.
//
// Why a tool (2026-10-01): a routine cycle spent ~31 min in a hand-rolled
// loop polling "the newest run on main", which never matched once another
// commit landed. With cancel-in-progress, a newer push cancels the run for
// <sha>, and the verdict comes from the newest run whose head CONTAINS <sha>
// (gpu-queue-lib ciRunFor).
import { execFileSync } from 'node:child_process';
import { ciRunFor } from './gpu-queue-lib.mjs';
import { loadCiFilters, pushTriggers } from './ci-path-filter-lib.mjs';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : undefined; };
const positional = args.filter((a, i) => !a.startsWith('--') && !['--timeout-min', '--repo'].includes(args[i - 1]));
const sh = (cmd, a) => execFileSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sha = sh('git', ['rev-parse', positional[0] ?? 'HEAD']);
const timeoutMs = Number(opt('timeout-min') ?? 25) * 60_000;
const repo = opt('repo') ?? (() => {
  const url = sh('git', ['remote', 'get-url', 'origin']);
  return /github\.com[:/](.+?)(?:\.git)?$/.exec(url)?.[1] ?? '';
})();
const contains = (head, s) => {
  try { execFileSync('git', ['merge-base', '--is-ancestor', s, head], { stdio: 'ignore' }); return true; } catch { return false; }
};

// A commit touching only CI-ignored paths (tasks.json, progress.md, docs,
// verification evidence) gets no run of its own; don't wait out the timeout.
const touched = sh('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', sha]).split('\n').filter(Boolean);
const { push: pushPaths } = loadCiFilters();
const expectsRun = !pushPaths || pushTriggers(pushPaths, touched);

const t0 = Date.now();
let last = '';
for (;;) {
  let runs = [];
  try {
    sh('git', ['fetch', '-q', 'origin', 'main']);
    runs = JSON.parse(sh('gh', ['run', 'list', '-R', repo, '-b', 'main', '-L', '30', '--json', 'databaseId,headSha,status,conclusion,displayTitle']));
  } catch (e) { console.error(`wait-ci: listing runs failed: ${String(e.message).split('\n')[0]}`); }
  const { run, state } = ciRunFor(runs, sha, contains);
  const msg = run ? `run ${run.databaseId} (${run.headSha.slice(0, 8)}${run.headSha.startsWith(sha.slice(0, 8)) ? '' : `, covers ${sha.slice(0, 8)}`}) ${run.status}${run.conclusion ? ' ' + run.conclusion : ''}` : `no run for ${sha.slice(0, 8)} yet`;
  if (msg !== last) { console.log(`wait-ci: ${msg}`); last = msg; }
  if (state === 'missing' && !expectsRun && Date.now() - t0 > 60_000) {
    console.log(`wait-ci: ${sha.slice(0, 8)} touches only CI-ignored paths and no run started — nothing to wait for`);
    process.exit(0);
  }
  if (state === 'done') {
    if (run.conclusion === 'success') process.exit(0);
    if (run.conclusion === 'cancelled' || run.conclusion === 'skipped') { console.log('wait-ci: no verdict (cancelled) — gate with bash tools/ci-local.sh --ci-shape'); process.exit(2); }
    console.log(`wait-ci: CI ${run.conclusion} — fix main first: gh run view ${run.databaseId} --log-failed`);
    process.exit(1);
  }
  if (Date.now() - t0 > timeoutMs) { console.log('wait-ci: timed out without a verdict — gate with bash tools/ci-local.sh --ci-shape'); process.exit(2); }
  await new Promise((r) => setTimeout(r, 20_000));
}
