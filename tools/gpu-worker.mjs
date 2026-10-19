#!/usr/bin/env node
// gpu-worker — runs queued real-GPU jobs on Jake's Mac (docs/gpu-worker.md).
//
// launchd (tools/install-gpu-worker.sh) runs this every 30 min through
// tools/gpu-worker.sh. Each wake:
//   1. guards: nobody playing (a game connection through the ws-tcp-bridge
//      AND input in the last PLAYING_IDLE_SEC; jobs use their own accounts,
//      so an AFK tab doesn't block), battery above
//      MIN_BATTERY_PCT when unplugged, at
//      least GPU_WORKER_MIN_FREE_GB (8) available, and the shared GPU lock
//      (~/Library/Caches/acjs/gpu.lock, also taken by local-gpu-perf.sh);
//      perf / perf-soak jobs also wait (up to CONTENTION_MAX_WAIT_H) while
//      another Playwright browser, the retail client or a load above
//      CONTENDED_LOAD_PER_CPU shares the Mac (hostContention; result.json `host`)
//   2. fetch origin/main; the oldest verification/gpu-queue/<id>.json without
//      a verification/gpu-results/<id>/ is the job
//   3. check out job.sha in .claude/worktrees/gpu-worker, bring the stack up
//      (Docker ACE + DB, the bridge, a Vite on :3191 for that worktree)
//   4. run commandFor(job) (tools/gpu-queue-lib.mjs: a fixed command per
//      kind, never shell from the queue) with timeoutMinFor(job)
//   5. write result.json + evidence into a worktree at origin/main
//      (.claude/worktrees/gpu-results), commit, push (rebase-retry)
// then repeats while the guards hold, up to GPU_WORKER_MAX_JOBS (2) jobs.
//
//   node tools/gpu-worker.mjs [--dry-run] [--now]
//     --dry-run: guards + pick, no run.  --now: run while the Mac is in use
//     (skips only the someone-is-playing check; retail-ab still waits for idle).
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync, openSync, closeSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus, homedir, hostname, loadavg } from 'node:os';
import {
  KINDS, QUEUE_DIR, RESULTS_DIR, MAX_ARTIFACT_IMAGES, RETAIL_INTERRUPTED_EXIT, DAT_STREAMING_OUT, STREAMING_AB_OUT, retailAbSheetScenes,
  streamingAbDue, newJobId,
  machineBlockedReason, pickRunnable, playingReason, parsePs, hostContention, timeoutMinFor, validateJob, commandFor, verdictFor, pendingJobs, resultIdFor, parseRegressionReport,
} from './gpu-queue-lib.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const JOB_WT = join(REPO, '.claude/worktrees/gpu-worker');
const RES_WT = join(REPO, '.claude/worktrees/gpu-results');
const LOG_DIR = join(homedir(), 'Library/Logs/acjs/gpu-worker');
const LOCK = join(homedir(), 'Library/Caches/acjs/gpu.lock');
const VITE_PORT = 3191;
const BRIDGE_PORT = 9090;
const MAX_JOBS = Number(process.env.GPU_WORKER_MAX_JOBS ?? 2);
const MIN_FREE_GB = Number(process.env.GPU_WORKER_MIN_FREE_GB ?? 8);
const DRY = process.argv.includes('--dry-run');
// --now: Jake asked for the queue to run while he uses the Mac. Skips only the
// someone-is-playing check. retail-ab still waits for idle (it takes the screen).
const NOW = process.argv.includes('--now');

const log = (...a) => console.log(`[gpu-worker ${new Date().toISOString()}]`, ...a);
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const git = (args, cwd = REPO) => sh('git', ['-C', cwd, ...args]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── guards ──────────────────────────────────────────────────────────────
function bridgeSessions() {
  try { return sh('lsof', ['-nP', `-iTCP:${BRIDGE_PORT}`, '-sTCP:ESTABLISHED', '-Fn']).split('\n').filter((l) => l.startsWith('n')).length; } catch { return 0; }
}
/** AC or battery, and the charge (null on a Mac without a battery). */
function power() {
  try {
    const out = sh('pmset', ['-g', 'batt']);
    const pct = /(\d+)%/.exec(out);
    return { ac: /AC Power/.test(out), batteryPct: pct ? Number(pct[1]) : null };
  } catch { return { ac: true, batteryPct: null }; }
}
/** Other browsers, the retail client and the load average (timing jobs wait for a quiet Mac). */
function contention() {
  try { return hostContention(parsePs(sh('ps', ['-axo', 'pid=,ppid=,pcpu=,command='])), { load1: loadavg()[0], cpus: cpus().length }); } catch { return undefined; }
}
const machineState = () => ({ ...power(), idleSec: hidIdleSeconds(), contention: contention(), nowMs: Date.now() });
const powerLabel = (st) => (st.ac ? 'AC' : `battery ${st.batteryPct ?? '?'}%`);
function availableGb() {
  try {
    const out = sh('vm_stat', []);
    const page = Number(/page size of (\d+) bytes/.exec(out)?.[1] ?? 16384);
    const pages = (n) => Number(new RegExp(`${n}:\\s+(\\d+)`).exec(out)?.[1] ?? 0);
    return ((pages('Pages free') + pages('Pages inactive') + pages('Pages speculative') + pages('Pages purgeable')) * page) / 1024 ** 3;
  } catch { return Infinity; }
}
/** Seconds since the last keyboard/mouse input (IOHIDSystem HIDIdleTime, ns). */
function hidIdleSeconds() {
  try { return Number(/"HIDIdleTime" = (\d+)/.exec(sh('ioreg', ['-c', 'IOHIDSystem', '-d', '4']))?.[1] ?? 0) / 1e9; } catch { return 0; }
}
/** Why not to start a job now, or null. */
function blocked() {
  // An open game tab blocks only while the Mac is in use (playingReason).
  const playing = NOW ? null : playingReason(bridgeSessions(), hidIdleSeconds());
  if (playing) return playing;
  const pw = machineBlockedReason(machineState());
  if (pw) return pw;
  const gb = availableGb();
  if (gb < MIN_FREE_GB) return `only ${gb.toFixed(1)} GB available (need ${MIN_FREE_GB})`;
  return null;
}
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function takeLock() {
  mkdirSync(dirname(LOCK), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try { const fd = openSync(LOCK, 'wx'); writeFileSync(fd, `${process.pid} gpu-worker\n`); closeSync(fd); return true; } catch {
      let text = '';
      try { text = readFileSync(LOCK, 'utf8'); } catch { continue; } // vanished: retry
      const pid = Number(text.split(' ')[0]);
      // An empty lock is another taker between create and write: held, not
      // stale (deleting it ran a job on top of a live probe, 2026-10-03).
      if (!text.trim() || (pid && pidAlive(pid))) return false;
      rmSync(LOCK, { force: true }); // stale: its pid is dead
    }
  }
  return false;
}
const dropLock = () => { try { if (readFileSync(LOCK, 'utf8').startsWith(`${process.pid} `)) rmSync(LOCK); } catch { /* gone */ } };

// ── queue on origin/main (read without checking anything out) ─────────────
function remoteQueue() {
  const names = (dir, dirs) => { try { return git(['ls-tree', ...(dirs ? ['-d'] : []), '--name-only', `origin/main:${dir}`]).split('\n').filter(Boolean); } catch { return []; } };
  const done = names(RESULTS_DIR, true);
  const jobs = names(QUEUE_DIR, false).filter((f) => f.endsWith('.json')).map((f) => {
    const _file = f.slice(0, -5);
    try { return { ...JSON.parse(git(['show', `origin/main:${QUEUE_DIR}/${f}`])), _file }; } catch { return { _file, requestedAt: '1970-01-01T00:00:00Z' }; }
  });
  return pendingJobs(jobs, done);
}

/**
 * The automatic streaming regression gate (Jake, 2026-10-06): with nothing
 * queued, run streaming-ab on origin/main when renderer / DAT-parser code
 * changed since the last streaming-ab result and that one is old enough
 * (gpu-queue-lib streamingAbDue). The job is not a queue file; its result
 * lands in verification/gpu-results like any other.
 */
function autoStreamingAbJob() {
  let last = null;
  try {
    const dirs = git(['ls-tree', '-d', '--name-only', `origin/main:${RESULTS_DIR}`]).split('\n').filter((d) => d.includes('-streaming-ab-'));
    for (const d of dirs) {
      try {
        const r = JSON.parse(git(['show', `origin/main:${RESULTS_DIR}/${d}/result.json`]));
        if (r.kind === 'streaming-ab' && r.finishedAt && (!last || r.finishedAt > last.finishedAt)) last = { sha: r.sha, finishedAt: r.finishedAt };
      } catch { /* unreadable result */ }
    }
  } catch { /* no results yet */ }
  const head = git(['rev-parse', 'origin/main']);
  let changedPaths = null;
  if (last) { try { changedPaths = git(['diff', '--name-only', last.sha, head]).split('\n').filter(Boolean); } catch { changedPaths = null; } }
  if (!streamingAbDue({ last, changedPaths, nowMs: Date.now() })) return null;
  const job = { kind: 'streaming-ab', sha: head.slice(0, 12), task: 'AUTO.streaming-ab', args: {}, requestedAt: new Date().toISOString(), requestedBy: 'gpu-worker (auto)' };
  return { ...job, id: newJobId(job) };
}

// ── worktrees + stack ─────────────────────────────────────────────────────
function worktreeAt(dir, ref) {
  if (!existsSync(dir)) git(['worktree', 'add', '-q', '--detach', dir, ref]);
  git(['checkout', '-q', '--force', '--detach', ref], dir);
  git(['clean', '-fdxq', '--', 'verification'], dir);
  for (const rel of ['node_modules', 'dat', 'reference']) if (!existsSync(join(dir, rel))) symlinkSync(join(REPO, rel), join(dir, rel));
  for (const group of ['packages', 'services']) {
    for (const p of readdirSync(join(REPO, group))) {
      const nm = join(REPO, group, p, 'node_modules');
      if (existsSync(nm) && existsSync(join(dir, group, p)) && !existsSync(join(dir, group, p, 'node_modules'))) symlinkSync(nm, join(dir, group, p, 'node_modules'));
    }
  }
}
const children = [];
async function stackUp(needVite) {
  try { sh('docker', ['info']); } catch {
    sh('open', ['-ga', 'Docker']);
    for (let i = 0; i < 90; i++) { try { sh('docker', ['info']); break; } catch { await sleep(2000); } }
  }
  for (const c of ['ace-db', 'ace-server']) {
    try { sh('docker', ['start', c]); } catch { /* already */ }
    for (let i = 0; i < 90; i++) { try { if (sh('docker', ['inspect', '-f', '{{.State.Health.Status}}', c]) === 'healthy') break; } catch { /* starting */ } await sleep(2000); }
  }
  let listening = false;
  try { sh('lsof', ['-iTCP:' + BRIDGE_PORT, '-sTCP:LISTEN']); listening = true; } catch { /* not up */ }
  if (!listening) {
    children.push(spawn('npx', ['tsx', 'services/ws-tcp-bridge/src/bridge.ts'], { cwd: JOB_WT, detached: true, stdio: 'ignore' }));
    await sleep(4000);
  }
  if (needVite) {
    // No HMR socket: its close (a lid closing mid-job) would reload the job's page (tools/lib/vite-no-reload.ts).
    children.push(spawn('npx', ['vite', '--port', String(VITE_PORT), '--strictPort'], { cwd: JOB_WT, detached: true, stdio: 'ignore', env: { ...process.env, ACJS_VITE_NO_RELOAD: '1' } }));
    for (let i = 0; i < 60; i++) { try { sh('curl', ['-sf', '-o', '/dev/null', `http://localhost:${VITE_PORT}/`]); break; } catch { await sleep(2000); } }
  }
}
function stackDown() {
  for (const c of children.splice(0)) { try { process.kill(-c.pid, 'SIGTERM'); } catch { /* gone */ } }
}

// ── run ───────────────────────────────────────────────────────────────────
function runJob(job, logFile) {
  const { argv, env } = commandFor(job, { url: `http://localhost:${VITE_PORT}/` });
  const fd = openSync(logFile, 'a');
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: JOB_WT, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', fd, fd] });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } }, timeoutMinFor(job) * 60_000);
    child.on('exit', (code) => { clearTimeout(timer); closeSync(fd); resolve({ code: code ?? -1, timedOut }); });
  });
}

const newest = (dir, re) => {
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).filter((n) => re.test(n)).map((n) => join(dir, n)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  return f ?? null;
};
const logTail = (file) => {
  try { return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() && !/^\s*\[page\]/.test(l)).slice(-30); } catch { return []; }
};

/** Evidence + summary fields for result.json, copying files into `out`. */
function collect(job, out, logFile, startedAt) {
  const r = { artifacts: [], renderer: null, headline: null };
  const keep = (src, name = basename(src)) => { if (src && existsSync(src)) { copyFileSync(src, join(out, name)); r.artifacts.push(name); } };
  const tail = logTail(logFile);
  if (job.kind === 'perf') {
    const f = newest(join(JOB_WT, 'verification/perf'), /^perf-.*\.json$/);
    keep(f);
    if (f) { const d = JSON.parse(readFileSync(f, 'utf8')); r.renderer = d.renderer ?? null; r.headline = d.ratchetVerdict ? `ratchet: ${d.ratchetVerdict}` : null; }
  } else if (job.kind === 'perf-soak') {
    const f = newest(join(JOB_WT, 'verification/perf'), /^soak-.*\.json$/);
    keep(f);
    if (f) r.renderer = JSON.parse(readFileSync(f, 'utf8')).renderer ?? null;
    r.headline = tail.filter((l) => /soak budget|SOAK BUDGET|running fps|HOST CONTENDED/.test(l)).join(' · ') || null;
  } else if (job.kind === 'screen-regression') {
    const rep = join(JOB_WT, 'verification/screen-regression/report.md');
    keep(rep);
    if (existsSync(rep)) {
      const { headline, changed } = parseRegressionReport(readFileSync(rep, 'utf8'));
      r.headline = headline || null;
      r.changed = changed;
      for (const name of changed.slice(0, MAX_ARTIFACT_IMAGES)) keep(join(JOB_WT, 'verification/screen-regression/diff', `${name}.png`), `diff__${name.replace(/\//g, '__')}.png`);
    }
    try { r.renderer = JSON.parse(readFileSync(join(JOB_WT, 'verification/screen-regression/head/manifest.json'), 'utf8')).renderer ?? null; } catch { /* none */ }
  } else if (job.kind === 'sidebyside') {
    for (const s of job.args.scenes.slice(0, MAX_ARTIFACT_IMAGES)) keep(join(JOB_WT, 'verification/sidebyside', s, `${s}-sidebyside.png`), `sidebyside__${s}.png`);
    r.headline = `${r.artifacts.length} side-by-side sheet(s) for the routine to judge`;
  } else if (job.kind === 'retail-ab') {
    const dir = join(JOB_WT, 'verification/retail-ab');
    // The job worktree keeps earlier runs' output: publish only what this job wrote.
    const sinceMs = Date.parse(startedAt);
    const mtimeMs = (p) => { try { return statSync(p).mtimeMs; } catch { return undefined; } };
    if ((mtimeMs(join(dir, 'report.md')) ?? -Infinity) >= sinceMs) keep(join(dir, 'report.md'));
    const available = existsSync(dir) ? readdirSync(dir).filter((n) => existsSync(join(dir, n, 'sheet.png'))) : [];
    const scenes = retailAbSheetScenes(job, available, { sinceMs, mtimeMs: (s) => mtimeMs(join(dir, s, 'sheet.png')) });
    for (const s of scenes) { keep(join(dir, s, 'sheet.png'), `sheet__${s}.png`); keep(join(dir, s, 'meta.json'), `meta__${s}.json`); }
    r.renderer = 'mac-gpu';
    r.headline = `${scenes.length} retail A/B sheet(s) for the routine to judge`;
  } else if (job.kind === 'streaming-ab') {
    const dir = join(JOB_WT, STREAMING_AB_OUT);
    keep(join(dir, 'verdict.json'));
    let v = null;
    try { v = JSON.parse(readFileSync(join(dir, 'verdict.json'), 'utf8')); } catch { /* the run broke before the verdict */ }
    // Failing captures' sheets first, then the rest, up to the image cap.
    const failed = new Set((v?.failures ?? []).map((f) => String(f).split(':')[0]));
    const sheets = existsSync(dir) ? readdirSync(dir).filter((n) => /^sheet-.*\.png$/.test(n)) : [];
    sheets.sort((a, b) => Number(!failed.has(a.slice(6, -4))) - Number(!failed.has(b.slice(6, -4))));
    for (const png of sheets.slice(0, MAX_ARTIFACT_IMAGES)) keep(join(dir, png));
    r.headline = v ? `${v.verdict} ${v.captures.length - failed.size}/${v.captures.length} captures${v.failures.length ? ': ' + v.failures.join('; ') : ''}` : null;
  } else if (job.kind === 'dat-streaming') {
    const dir = join(JOB_WT, DAT_STREAMING_OUT);
    keep(join(dir, 'result.json'), 'dat-streaming.json');
    for (const png of existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.png')).slice(0, MAX_ARTIFACT_IMAGES) : []) keep(join(dir, png));
    try { const d = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')); r.renderer = d.renderer ?? null; r.headline = d.headline ?? null; } catch { /* the probe failed before writing */ }
    r.headline ??= tail.filter((l) => /^gate: /.test(l)).pop() ?? null;
  }
  r.logTail = tail;
  return r;
}

function publish(id, write, message) {
  git(['fetch', '-q', 'origin', 'main']);
  worktreeAt(RES_WT, 'origin/main');
  const out = join(RES_WT, RESULTS_DIR, id);
  mkdirSync(out, { recursive: true });
  write(out);
  git(['add', '--', RESULTS_DIR], RES_WT);
  git(['commit', '-q', '-m', message], RES_WT);
  for (let i = 0; i < 3; i++) {
    try { git(['push', '-q', 'origin', 'HEAD:main'], RES_WT); log(`pushed ${git(['rev-parse', '--short', 'HEAD'], RES_WT)}`); return true; } catch {
      try { git(['fetch', '-q', 'origin', 'main'], RES_WT); git(['rebase', '-q', 'origin/main'], RES_WT); } catch { try { git(['rebase', '--abort'], RES_WT); } catch { /* none */ } break; }
    }
  }
  const keepBranch = `gpu-results-unpushed-${id}`;
  try { git(['branch', '-f', keepBranch, 'HEAD'], RES_WT); } catch { /* ignore */ }
  log(`*** PUSH FAILED — result kept on branch ${keepBranch}`);
  return false;
}

async function main() {
  mkdirSync(LOG_DIR, { recursive: true });
  const why = blocked();
  if (why) { log(`skip: ${why}`); return; }
  if (!takeLock()) { log('skip: another GPU job holds the lock'); return; }
  process.on('exit', () => { stackDown(); dropLock(); });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));
  for (let n = 0; n < MAX_JOBS; n++) {
    git(['fetch', '-q', 'origin', 'main']);
    const queue = remoteQueue();
    if (!queue.length) {
      const auto = autoStreamingAbJob();
      if (!auto) { log('queue empty'); return; }
      log(`queue empty: automatic streaming-ab on ${auto.sha.slice(0, 8)}`);
      queue.push(auto);
    }
    const state = machineState();
    const { job, skipped } = pickRunnable(queue, state);
    for (const why of skipped) log(`passed over ${why}`);
    if (!job) { log(`nothing runnable now (${powerLabel(state)})`); return; }
    const id = resultIdFor(job);
    const errors = validateJob(job);
    log(`job ${id} (${job.kind ?? '?'} ${job.task ?? ''} @ ${String(job.sha ?? '').slice(0, 8)})${errors.length ? ' INVALID: ' + errors.join('; ') : ''}`);
    if (DRY) return;
    const startedAt = new Date().toISOString();
    if (errors.length) {
      publish(id, (out) => writeFileSync(join(out, 'result.json'), JSON.stringify({ id, task: job.task ?? null, kind: job.kind ?? null, sha: job.sha ?? null, verdict: 'error', errors, startedAt, finishedAt: new Date().toISOString(), worker: hostname() }, null, 1) + '\n'),
        `GPU: ${id} — invalid job, closed with an error result [skip-tests]`);
      continue;
    }
    const logFile = join(LOG_DIR, `${id}.log`);
    let code = -1, timedOut = false, setupError = null;
    try {
      git(['fetch', '-q', 'origin', job.sha]);
    } catch { /* a sha on main is already fetched */ }
    try {
      worktreeAt(JOB_WT, job.sha);
      await stackUp(job.kind !== 'screen-regression');
      const again = blocked();
      if (again) { log(`skip before running: ${again}`); return; } // someone logged in during bring-up; retry next wake
      ({ code, timedOut } = await runJob(job, logFile));
    } catch (e) {
      setupError = String(e?.message ?? e).slice(0, 400);
    } finally {
      stackDown();
    }
    if (job.kind === 'retail-ab' && !setupError && code === RETAIL_INTERRUPTED_EXIT) {
      // Someone used the Mac (or the client lost focus) mid-run: retry next idle wake.
      log(`interrupted: ${id} stays queued`);
      return;
    }
    const verdict = setupError ? 'error' : verdictFor(job.kind, code, timedOut);
    const finishedAt = new Date().toISOString();
    publish(id, (out) => {
      const c = collect(job, out, logFile, startedAt);
      const result = {
        id, task: job.task ?? null, kind: job.kind, sha: job.sha, args: job.args ?? {}, requestedAt: job.requestedAt, requestedBy: job.requestedBy ?? null,
        startedAt, finishedAt, durationSec: Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000),
        exitCode: code, timedOut, verdict, ...(setupError ? { setupError } : {}), worker: hostname(), power: powerLabel(state), ...(state.contention ? { host: state.contention } : {}), ...c,
      };
      writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 1) + '\n');
      log(`result ${verdict} (exit ${code}${timedOut ? ', timed out' : ''}) ${c.headline ?? ''}`);
    }, `GPU: ${job.kind} for ${job.task ?? job.sha.slice(0, 8)} @ ${job.sha.slice(0, 8)} — ${verdict} [skip-tests]\n\nRun by tools/gpu-worker.mjs on the dev Mac (real GPU). Result: ${RESULTS_DIR}/${id}/result.json`);
    const why2 = blocked();
    if (why2) { log(`stop: ${why2}`); return; }
  }
}

main().catch((e) => { log('FAILED', e?.stack ?? e); process.exitCode = 1; });
