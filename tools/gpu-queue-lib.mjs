// gpu-queue-lib.mjs — the decisions of the real-GPU job queue (docs/gpu-worker.md),
// split out so tests/verify-gpu-queue.ts drives them without a GPU, git or a stack.
//
// The cloud routine has no GPU (SwiftShader only). It files a job as
// verification/gpu-queue/<id>.json on main; Jake's Mac runs it with
// tools/gpu-worker.mjs (launchd) and pushes verification/gpu-results/<id>/.
// A job names a KIND and validated args only. The worker maps a kind to one
// fixed command (commandFor); nothing in a queue file is ever run as shell.

/** Job kinds: the fixed command each maps to and how long it may run. */
export const KINDS = {
  perf: { timeoutMin: 25, describe: 'measure-perf --gpu --ratchet (fps / frame time at the standard spots)' },
  'perf-soak': { timeoutMin: 40, describe: 'perf-soak (GPU): the session soak (route + panels + combat + chat), docs/performance-budgets.md; args.minutes for a long run' },
  'screen-regression': { timeoutMin: 150, describe: 'screen-regression --gpu: every screen, base vs the job sha, GPU noise floors' },
  sidebyside: { timeoutMin: 25, describe: 'sidebyside --scene on the GPU: ours next to the retail reference (judged by the routine)' },
  // Drives the real retail client too: runs only when the Mac has been idle
  // RETAIL_IDLE_SEC (it takes the screen and keyboard focus).
  'retail-ab': { timeoutMin: 90, describe: 'capture-retail-ab: retail client (Wine, GPU) and ours through the same scenes, paired + diffed' },
  // The streamed-DAT probe (published DAT set): portal-space gate hold → release
  // for cold login, teleports and warm login. Numbers for the routine to judge
  // against the handoff baselines (RELEASE.streaming-gate-real-gpu-check).
  'dat-streaming': { timeoutMin: 30, describe: 'probe-dat-streaming --gpu: portal-space gate timings (cold / teleports / warm) on the published DAT set' },
  // The streaming regression gate: one scripted geared session on whole DATs,
  // then streamed from the published set; every capture must match
  // (docs/dat-streaming.md §6.5/§6.8). The worker also queues it by itself
  // (streamingAbDue) — Jake 2026-10-06, after streaming regressions reached
  // playwebac.com because nothing ran this gate.
  'streaming-ab': { timeoutMin: 45, describe: 'streaming-ab: whole DATs vs streamed, same geared session; icons, models, text, particles must match' },
};

/** Where a streaming-ab job writes verdict.json + sheets (inside the job worktree). */
export const STREAMING_AB_OUT = 'verification/dat-streaming/ab/gpu';
/** The A/B's own account on the local ACE (it refuses testacjs*; created as admin, gear made once with @ci). */
export const STREAMING_AB_ACCOUNT = 'streamab1';
/** Paths whose change makes an automatic streaming-ab due. */
export const STREAMING_AB_PATHS = ['packages/renderer/', 'packages/dat-parser/'];
/** At most one automatic streaming-ab per this many hours. */
export const STREAMING_AB_MIN_INTERVAL_H = 6;

/**
 * Whether the worker should queue a streaming-ab by itself (its queue is empty):
 * never run before, or renderer / DAT-parser code changed since the last one
 * and that one is at least STREAMING_AB_MIN_INTERVAL_H old.
 * `last`: { sha, finishedAt } of the newest streaming-ab result, or null.
 * `changedPaths`: files changed between last.sha and origin/main (null: unknown, e.g. sha gone).
 */
export function streamingAbDue({ last, changedPaths, nowMs }) {
  if (!last) return true;
  const ageH = (nowMs - Date.parse(last.finishedAt)) / 3.6e6;
  if (!(ageH >= STREAMING_AB_MIN_INTERVAL_H)) return false;
  if (changedPaths === null) return true;
  return changedPaths.some((p) => STREAMING_AB_PATHS.some((dir) => p.startsWith(dir)));
}

/** Teleport destinations probe-dat-streaming knows (its ALL table). */
export const DAT_STREAMING_TELEPORTS = ['holtburg', 'holtburg-dungeon', 'shoushi'];

/** Seconds without keyboard/mouse input before a retail-ab job may start (Jake, 2026-10-02: "only when idle"). */
export const RETAIL_IDLE_SEC = 600;
/** capture-retail-ab exit code: the user touched the machine or the client lost focus mid-run; leave the job queued. */
export const RETAIL_INTERRUPTED_EXIT = 4;

export const QUEUE_DIR = 'verification/gpu-queue';
export const RESULTS_DIR = 'verification/gpu-results';
/** Result evidence images copied per job (diff PNGs, side-by-side sheets). */
export const MAX_ARTIFACT_IMAGES = 12;
/** Where a dat-streaming job's probe writes result.json + screenshots (inside the job worktree). */
export const DAT_STREAMING_OUT = 'verification/dat-streaming/gpu';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,100}$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;
const TASK_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
/** Capture / scene names: letters, digits, . _ - / and a trailing * (screen-regression prefix match). */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}\*?$/;

function nameList(v, field, errors) {
  if (v === undefined) return;
  if (!Array.isArray(v) || v.length > 40) { errors.push(`${field} must be an array of ≤40 names`); return; }
  for (const n of v) if (typeof n !== 'string' || !NAME_RE.test(n)) errors.push(`${field}: bad name ${JSON.stringify(n)}`);
}

/** Every reason `job` must not run (empty = valid). */
export function validateJob(job) {
  const errors = [];
  if (!job || typeof job !== 'object') return ['job is not an object'];
  if (typeof job.id !== 'string' || !ID_RE.test(job.id)) errors.push('bad id');
  if (!Object.hasOwn(KINDS, job.kind)) errors.push(`unknown kind ${JSON.stringify(job.kind)}`);
  if (typeof job.sha !== 'string' || !SHA_RE.test(job.sha)) errors.push('sha must be a hex commit id');
  if (job.task !== undefined && (typeof job.task !== 'string' || !TASK_RE.test(job.task))) errors.push('bad task id');
  if (typeof job.requestedAt !== 'string' || Number.isNaN(Date.parse(job.requestedAt))) errors.push('requestedAt must be an ISO time');
  const a = job.args ?? {};
  if (typeof a !== 'object' || Array.isArray(a)) { errors.push('args must be an object'); return errors; }
  const allowed = { perf: [], 'perf-soak': ['stops', 'minutes'], 'screen-regression': ['base', 'ui', 'expect', 'names'], sidebyside: ['scenes'], 'retail-ab': ['scenes', 'side'], 'dat-streaming': ['teleports'], 'streaming-ab': [] }[job.kind] ?? [];
  for (const k of Object.keys(a)) if (!allowed.includes(k)) errors.push(`arg ${k} not allowed for ${job.kind}`);
  if (job.kind === 'perf-soak' && a.stops !== undefined && !(Number.isInteger(a.stops) && a.stops >= 1 && a.stops <= 12)) errors.push('stops must be 1..12');
  if (job.kind === 'perf-soak' && a.minutes !== undefined && !(Number.isInteger(a.minutes) && a.minutes >= 1 && a.minutes <= 90)) errors.push('minutes must be 1..90');
  if (job.kind === 'screen-regression') {
    if (typeof a.base !== 'string' || !SHA_RE.test(a.base)) errors.push('screen-regression needs args.base (hex commit id)');
    if (a.ui !== undefined && typeof a.ui !== 'boolean') errors.push('ui must be boolean');
    nameList(a.expect, 'expect', errors);
    nameList(a.names, 'names', errors);
  }
  if (job.kind === 'sidebyside') {
    nameList(a.scenes, 'scenes', errors);
    if (!Array.isArray(a.scenes) || a.scenes.length === 0) errors.push('sidebyside needs args.scenes');
  }
  if (job.kind === 'retail-ab') {
    nameList(a.scenes, 'scenes', errors);
    if (a.side !== undefined && !['both', 'retail', 'ours'].includes(a.side)) errors.push('side must be both|retail|ours');
  }
  if (job.kind === 'dat-streaming' && a.teleports !== undefined) {
    if (!Array.isArray(a.teleports) || a.teleports.length === 0 || a.teleports.length > 2 || !a.teleports.every((t) => DAT_STREAMING_TELEPORTS.includes(t))) {
      errors.push(`teleports must be 1–2 of ${DAT_STREAMING_TELEPORTS.join('|')}`);
    }
  }
  return errors;
}

/**
 * The fixed command for a job, run inside a worktree checked out at job.sha.
 * `url` is the worker's own Vite for that worktree (perf, perf-soak,
 * sidebyside); screen-regression starts its own two Vite servers.
 */
export function commandFor(job, { url, account = 'testacjs2' }) {
  const a = job.args ?? {};
  const env = { AC_GPU: '1', ACJS_ACCOUNT: account, AC_ACCOUNT: account };
  const base = url.split('?')[0];
  switch (job.kind) {
    case 'perf':
      return { argv: ['npx', 'tsx', 'tools/measure-perf.ts', '--gpu', '--ratchet'], env: { ...env, AC_URL: `${base}?ace&bridge=ws://localhost:9090&account=${account}&password=${account}&cb=gpuworker` } };
    case 'perf-soak':
      return { argv: ['npx', 'tsx', 'tools/perf-soak.ts', '--stops', String(a.stops ?? 8), ...(a.minutes ? ['--minutes', String(a.minutes)] : [])], env: { ...env, AC_BASE: base } };
    case 'screen-regression':
      return {
        argv: ['npx', 'tsx', 'tools/screen-regression.ts', '--gpu', '--base', a.base,
          ...(a.ui ? ['--ui'] : []), ...(a.expect?.length ? ['--expect', a.expect.join(',')] : []), ...(a.names ?? [])],
        env,
      };
    case 'sidebyside':
      return { argv: ['npx', 'tsx', 'tools/sidebyside.ts', ...a.scenes.flatMap((s) => ['--scene', s])], env: { ...env, AC_BASE: base } };
    case 'retail-ab':
      // Both sides log in as the A/B character (retail-ab-scenes.ts ACCOUNT), not the worker's account.
      return {
        argv: ['npx', 'tsx', 'tools/capture-retail-ab.ts', '--gpu', '--side', a.side ?? 'both', ...(a.scenes?.length ? ['--scenes', a.scenes.join(',')] : [])],
        env: { AC_GPU: '1', AC_BASE: base },
      };
    case 'dat-streaming':
      return {
        argv: ['npx', 'tsx', 'tools/probe-dat-streaming.ts', '--gpu', '--out', DAT_STREAMING_OUT, '--teleports', (a.teleports ?? ['holtburg', 'shoushi']).join(',')],
        env: { ...env, AC_BASE: base },
      };
    case 'streaming-ab':
      // Its own account and the worker's bridge (the worker runs only when nobody is playing).
      return {
        argv: ['npx', 'tsx', 'tools/streaming-ab.ts', '--out', STREAMING_AB_OUT],
        env: { AC_BASE: base, AC_BRIDGE: 'ws://localhost:9090', AC_ACCOUNT: STREAMING_AB_ACCOUNT },
      };
    default:
      throw new Error(`no command for kind ${job.kind}`);
  }
}

/**
 * Verdict from the tool's own exit code. pass / fail are the tool's budget or
 * ratchet; `review` means evidence for the routine to judge (side-by-sides);
 * error = the run itself broke; timeout = killed at KINDS[kind].timeoutMin.
 */
export function verdictFor(kind, exitCode, timedOut = false) {
  if (timedOut) return 'timeout';
  if (kind === 'perf') return exitCode === 0 ? 'pass' : exitCode === 2 ? 'fail' : 'error';
  if (kind === 'perf-soak') return exitCode === 0 ? 'pass' : exitCode === 2 ? 'fail' : 'error';
  if (kind === 'screen-regression') return exitCode === 0 ? 'pass' : exitCode === 1 ? 'fail' : 'error';
  if (kind === 'sidebyside') return exitCode === 0 ? 'review' : 'error';
  if (kind === 'retail-ab') return exitCode === 0 ? 'review' : exitCode === RETAIL_INTERRUPTED_EXIT ? 'interrupted' : 'error';
  if (kind === 'dat-streaming') return exitCode === 0 ? 'review' : 'error';
  if (kind === 'streaming-ab') return exitCode === 0 ? 'pass' : exitCode === 1 ? 'fail' : 'error';
  return 'error';
}

/**
 * Below this battery charge (unplugged), no job starts: a screen regression
 * runs up to 2.5 h, and Chrome's Energy Saver (default: at 20% or lower)
 * caps frame rates, which would corrupt fps results. Above it, battery is
 * fine: headless Chromium measured 120 fps unplugged at 100% (2026-10-03).
 */
export const MIN_BATTERY_PCT = 30;

/**
 * Why `job` must not start under the Mac's current state, or null. Every kind
 * runs on battery (Jake, 2026-10-03; the battery floor is machine-wide).
 * `retail-ab` needs RETAIL_IDLE_SEC without input, because it takes the screen.
 * `state`: { ac: boolean, batteryPct: number | null, idleSec: number }.
 */
export function jobBlockedReason(job, state) {
  // Only a run that drives the real retail window takes the screen; `side: ours` is headless.
  if (job.kind === 'retail-ab' && (job.args?.side ?? 'both') !== 'ours' && state.idleSec < RETAIL_IDLE_SEC) {
    return `Mac in use (idle ${Math.round(state.idleSec)} s, need ${RETAIL_IDLE_SEC})`;
  }
  // Frame times measured beside another browser, the retail client or a busy
  // CPU are the other work's numbers, not ours (PERF.gpu-soak-hitch-ee124a12).
  // After CONTENTION_MAX_WAIT_H the job runs anyway; the soak marks it CONTENDED.
  if (TIMING_KINDS.has(job.kind) && state.contention?.reason) {
    const waitedH = state.nowMs !== undefined && job.requestedAt ? (state.nowMs - Date.parse(job.requestedAt)) / 3.6e6 : 0;
    if (!(waitedH >= CONTENTION_MAX_WAIT_H)) return `host busy: ${state.contention.reason} (timing jobs wait up to ${CONTENTION_MAX_WAIT_H} h for a quiet Mac)`;
  }
  return null;
}

/** Kinds whose verdict is a frame time: they need the Mac to themselves. */
export const TIMING_KINDS = new Set(['perf', 'perf-soak', 'dat-streaming']);
/** Hours a timing job waits for a quiet Mac before it runs regardless (and is marked contended). */
export const CONTENTION_MAX_WAIT_H = 6;
/** 1-minute load average per logical CPU above which the host counts as busy. */
export const CONTENDED_LOAD_PER_CPU = 0.5;

/**
 * `ps -axo pid=,ppid=,pcpu=,command=` rows. Lines that don't parse are dropped.
 * @returns {{ pid: number, ppid: number, pcpu: number, command: string }[]}
 */
export function parsePs(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pcpu: Number(m[3]), command: m[4] });
  }
  return rows;
}

/** Pids of `root` and everything under it. */
export function processTree(rows, root) {
  const kids = new Map();
  for (const r of rows) { if (!kids.has(r.ppid)) kids.set(r.ppid, []); kids.get(r.ppid).push(r.pid); }
  const out = new Set(); const stack = root ? [root] : [];
  while (stack.length) { const p = stack.pop(); if (out.has(p)) continue; out.add(p); stack.push(...(kids.get(p) ?? [])); }
  return out;
}

/**
 * Root pid of every Playwright-launched Chromium: the process carrying a
 * throwaway profile dir whose parent does not. Its renderer/GPU children carry
 * the same dir, so only roots are counted.
 */
export function playwrightBrowserRoots(rows) {
  const withProfile = rows.filter((r) => /playwright_chromiumdev_profile/.test(r.command));
  const pids = new Set(withProfile.map((r) => r.pid));
  return withProfile.filter((r) => !pids.has(r.ppid)).map((r) => r.pid);
}

/**
 * What else is using the Mac. `ownRoot`: our own browser (its tree is ours).
 * Counts other Playwright browsers, a running retail client (Wine acclient.exe)
 * and the 1-minute load average; `reason` is null when the host is quiet.
 * @returns {{ otherBrowsers: number, retailClients: number, load1: number, cpus: number, top: string[], reason: string | null }}
 */
export function hostContention(rows, { load1, cpus, ownRoot } = {}) {
  const own = processTree(rows, ownRoot);
  const otherBrowsers = playwrightBrowserRoots(rows).filter((p) => !own.has(p)).length;
  const retailClients = rows.filter((r) => /acclient\.exe/i.test(r.command)).length;
  const top = rows.filter((r) => !own.has(r.pid) && r.pcpu >= 20).sort((a, b) => b.pcpu - a.pcpu).slice(0, 5)
    .map((r) => `${r.pcpu.toFixed(0)}% ${r.command.split(' ')[0].split('/').pop()}`);
  const why = [];
  if (otherBrowsers) why.push(`${otherBrowsers} other Playwright browser(s)`);
  if (retailClients) why.push('the retail client is running');
  if (cpus > 0 && load1 > cpus * CONTENDED_LOAD_PER_CPU) why.push(`load ${load1.toFixed(1)} on ${cpus} cores`);
  return { otherBrowsers, retailClients, load1: +Number(load1 ?? 0).toFixed(2), cpus: cpus ?? 0, top, reason: why.length ? why.join(', ') : null };
}

/** Why no job may start at all under `state`, or null (the worker-wide battery floor). */
export function machineBlockedReason(state) {
  if (!state.ac && state.batteryPct !== null && state.batteryPct < MIN_BATTERY_PCT) return `battery at ${state.batteryPct}% (need ${MIN_BATTERY_PCT}% unplugged)`;
  return null;
}

/**
 * Seconds without keyboard/mouse input after which an open game tab no longer
 * counts as someone playing (Jake, 2026-10-03: an AFK tab blocked the queue
 * all morning). Jobs log in on their own accounts (testacjs2 / testacjs3), so
 * they never boot a player. What they'd do is share the GPU with an active game.
 */
export const PLAYING_IDLE_SEC = 600;

/** Why the queue must wait for a player, or null: game clients are connected and the Mac was used recently. */
export function playingReason(bridgeSessions, idleSec) {
  if (bridgeSessions > 0 && idleSec < PLAYING_IDLE_SEC) {
    return `${bridgeSessions} game connection(s) and the Mac used ${Math.round(idleSec)} s ago (someone is playing; waits for ${PLAYING_IDLE_SEC} s idle)`;
  }
  return null;
}

/** The oldest pending job that may start now, with the reasons the older ones were passed over. */
export function pickRunnable(pending, state) {
  const skipped = [];
  for (const job of pending) {
    const why = jobBlockedReason(job, state);
    if (!why) return { job, skipped };
    skipped.push(`${resultIdFor(job)}: ${why}`);
  }
  return { job: null, skipped };
}

/** A job's timeout in minutes: the kind's, or for a long session soak its length plus 30 (route return, GC, slack). */
export function timeoutMinFor(job) {
  const base = KINDS[job.kind]?.timeoutMin ?? 30;
  const m = job.kind === 'perf-soak' ? Number(job.args?.minutes ?? 0) : 0;
  return m > 0 ? Math.max(base, m + 30) : base;
}

/** Queued jobs with no result yet, oldest first. `jobs`: parsed queue files; `done`: result ids. */
export function pendingJobs(jobs, done) {
  const finished = new Set(done);
  return jobs
    .filter((j) => j && !finished.has(resultIdFor(j)))
    .sort((x, y) => Number(isLongJob(x)) - Number(isLongJob(y))
      || Date.parse(x.requestedAt) - Date.parse(y.requestedAt) || String(x.id).localeCompare(String(y.id)));
}

/**
 * A long session soak (perf-soak with `minutes`). It runs after every short job
 * so it never holds task confirmations for an hour (Jake, 2026-10-03: the daily
 * 60-minute soak blocked the statics regression behind it).
 */
export function isLongJob(job) {
  return job?.kind === 'perf-soak' && Number(job?.args?.minutes ?? 0) > 0;
}

/** The result directory name for a job: its id when valid, else its queue file name. */
export function resultIdFor(job) {
  return typeof job.id === 'string' && ID_RE.test(job.id) ? job.id : String(job._file ?? 'invalid-job');
}

/** A job id: the task (or kind), the short sha and a UTC stamp, unique per request. */
export function newJobId(job, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const tail = `-${job.kind}-${job.sha.slice(0, 8)}-${stamp}`;
  // ID_RE allows 101 characters: a long task id with a long kind
  // (screen-regression) overran it, so the task part gives way.
  const head = (job.task ?? job.kind).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, Math.min(60, 101 - tail.length));
  return `${head}${tail}`;
}

/**
 * Screen-regression report.md → the changed capture names (the UNEXPECTED
 * table) and its headline, for result.json and the diff images to keep.
 */
/**
 * The retail-ab scenes whose sheets a job publishes. capture-retail-ab keeps every earlier
 * run's scene folders, so a job that asked for some scenes publishes only those (2026-10-03:
 * two town jobs published twelve stale panel sheets and none of their towns). With
 * `written`, a sheet counts only when its mtime is at or after `sinceMs` (the job start).
 */
export function retailAbSheetScenes(job, available, written) {
  const asked = job.args?.scenes ?? [];
  // A run that dies before its report step leaves the earlier sheets in place
  // beside freshly rewritten meta.json files; publishing them paired an old
  // sheet with this job's metadata (2026-10-04). Only sheets this job wrote count.
  const fresh = written ? available.filter((s) => (written.mtimeMs(s) ?? -Infinity) >= written.sinceMs) : available;
  const scenes = asked.length ? asked.filter((s) => fresh.includes(s)) : [...fresh];
  return scenes.slice(0, MAX_ARTIFACT_IMAGES);
}

export function parseRegressionReport(md) {
  const headline = (/\*\*([^*]+)\*\*/.exec(md) ?? [])[1] ?? '';
  const changed = [];
  let inUnexpected = false;
  for (const line of md.split('\n')) {
    if (/^###\s/.test(line)) inUnexpected = /UNEXPECTED/i.test(line);
    const m = inUnexpected && /^\|\s*([^|\s][^|]*?)\s*\|/.exec(line);
    if (m && m[1] !== 'capture' && !/^-+$/.test(m[1])) changed.push(m[1]);
  }
  return { headline, changed };
}

/**
 * wait-ci: which Actions run carries the verdict for `sha` on main. Runs come
 * newest first. The run for `sha` itself wins unless it was cancelled; a
 * cancelled run (cancel-in-progress after a newer push) hands the verdict to
 * the newest run whose head contains `sha` (`contains(head, sha)`).
 * Returns { run, state } with state 'done' | 'waiting' | 'missing'.
 */
export function ciRunFor(runs, sha, contains) {
  const own = runs.find((r) => r.headSha.startsWith(sha) || sha.startsWith(r.headSha));
  if (own && !(own.status === 'completed' && own.conclusion === 'cancelled')) {
    return { run: own, state: own.status === 'completed' ? 'done' : 'waiting' };
  }
  const newer = runs.find((r) => r !== own && contains(r.headSha, sha) && !(r.status === 'completed' && r.conclusion === 'cancelled'));
  if (newer) return { run: newer, state: newer.status === 'completed' ? 'done' : 'waiting' };
  if (own) return { run: own, state: 'done' };
  return { run: null, state: 'missing' };
}
