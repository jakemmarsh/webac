/**
 * screen-regression — the standing all-screens regression pass.
 *
 * Captures EVERY screen (pre-world flow, whole-screen scenes, every HUD panel)
 * from two builds in the same environment, the BASE (before the task's work)
 * and HEAD, then pixel-diffs each pair. A capture that changed but was not
 * declared with --expect is a candidate regression. A declared capture that
 * did not change means the intended change may not have landed.
 *
 *   npx tsx tools/screen-regression.ts [--base <ref>] [--expect inventory,social-*] [names…]
 *
 *   --base    commit to compare against. Default: the newest "…: claim" commit in
 *             the last 20 (the loop's pre-work state), else HEAD~1.
 *   --expect  captures this task is MEANT to change (exact names or prefix*).
 *   --ui      pre-world flow + HUD panels only (skips the 46 world scenes;
 *             ~7 min a side instead of ~12). Use for UI-only tasks; run the
 *             full pass whenever renderer/world/streaming code changed.
 *   names…    optional capture-name filters, passed through to the capture tool.
 *   --gpu     capture both sides on the real GPU (headless, local Mac only;
 *             AC_GPU=1 to the capture tool). Its noise floors live in
 *             verification/screen-regression-noise.gpu.json so GPU and
 *             SwiftShader calibrations never overwrite each other; run
 *             --gpu --calibrate once before trusting --gpu judgments.
 *   --keep    keep the base worktree (debugging).
 *   --compare-only  skip both captures and diff the base/ and head/ already on
 *             disk (e.g. after re-running one side's capture-ui-screens.ts by
 *             hand when its page load timed out).
 *   --calibrate  base = HEAD (same code both sides); records each capture's
 *             observed noise {ratio, largest cluster, date, renderer} in
 *             verification/screen-regression-noise.json (committed;
 *             thresholds read it). A capture's entry is REPLACED when it
 *             came from another date or renderer (same-day repeats keep the
 *             max). Re-run after adding captures or changing the renderer.
 *
 * Judging: a capture is changed when its frame-wide changed ratio OR its
 * largest connected changed region (px) exceeds its floor, so a whole-panel
 * change fails even in a scene whose frame-wide noise is high. Each scene is
 * also captured as a HUD-only layer (`scenes/<name>.hud`, world canvas
 * hidden) judged at panel strictness.
 *
 * Era: ACJS_ERA=<era id> (e.g. classicace-customdm, classic-dereth) captures a
 * classic era: the client loads with ?era=<id>, ACJS_BRIDGE names that era's
 * bridge (default ws://localhost:9090), and the output and noise floors are
 * kept per era (verification/screen-regression-<era>/,
 * screen-regression-noise.<era>.json), so a classic run never touches the
 * end-of-retail baseline. tools/screen-regression-eras.sh runs every era.
 *
 * Account: testacjs by default. Set ACJS_ACCOUNT (+ ACJS_PASSWORD, default =
 * the account name) to capture on another account, e.g. ACJS_ACCOUNT=testacjs2
 * while someone is playing on testacjs locally (ACE boots the older login, so
 * a capture on a live account kicks the player and the two fight).
 *
 * Requires ACE + the ws-tcp-bridge on :9090 (the usual stack). Starts its own
 * Vite servers on two free ports (base, head), so an existing :3000 dev
 * server is left alone. Both builds are captured by HEAD's
 * capture-ui-screens.ts (--out, --no-world), so the driver is identical.
 * Output: verification/screen-regression/{base,head,diff}/ + report.md
 * (gitignored). Exit 1 when there are unexpected changes.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import {
  acquireRunLock,
  BROKEN_CAPTURE_RATIO, clusterThresholdFor, diffPair, formatReport, judge, kindFor, mergeNoise, thresholdFor,
  type CaptureKind, type NoiseFloor, type PairDiff,
} from './screen-regression-lib.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ERA = process.env.ACJS_ERA ?? '';
const BRIDGE = process.env.ACJS_BRIDGE ?? 'ws://localhost:9090';
const OUT = join(ROOT, 'verification', ERA ? `screen-regression-${ERA}` : 'screen-regression');
const args = process.argv.slice(2);
// `--help` used to fall through to a real full run (a cloud cycle lost one,
// 2026-10-01): print this file's header comment instead.
if (args.includes('--help') || args.includes('-h')) {
  const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  console.log((/\/\*\*([\s\S]*?)\*\//.exec(src)?.[1] ?? '').replace(/^ \* ?/gm, '').trim());
  process.exit(0);
}
const flag = (n: string) => { const i = args.indexOf(n); return i > -1 ? args[i + 1] : undefined; };
const KEEP = args.includes('--keep');
const ACCOUNT = encodeURIComponent(process.env.ACJS_ACCOUNT ?? 'testacjs');
const PASSWORD = encodeURIComponent(process.env.ACJS_PASSWORD ?? process.env.ACJS_ACCOUNT ?? 'testacjs');
const COMPARE_ONLY = args.includes('--compare-only');
const UI_ONLY = args.includes('--ui');
const CALIBRATE = args.includes('--calibrate');
const GPU = args.includes('--gpu');
const NOISE_FILE = join(ROOT, 'verification',
  `screen-regression-noise${ERA ? `.${ERA}` : ''}${GPU ? '.gpu' : ''}.json`);
const expect = (flag('--expect') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const filters = args.filter((a, i) => !a.startsWith('--') && !['--base', '--expect'].includes(args[i - 1]));

const git = (...a: string[]) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();

function defaultBase(): string {
  const log = git('log', '-20', '--format=%H %s').split('\n');
  const claim = log.find((l) => /: claim( \[skip-tests\])?$/.test(l));
  return claim ? claim.split(' ')[0] : git('rev-parse', 'HEAD~1');
}

async function waitHttp(url: string, ms = 120_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${url}`);
}

function startVite(cwd: string, port: number): ChildProcess {
  // No HMR socket: its close (a lid closing mid-run) would reload a page mid-capture (tools/lib/vite-no-reload.ts).
  const p = spawn('npx', ['vite', '--port', String(port), '--strictPort'], { cwd, stdio: 'ignore', detached: true, env: { ...process.env, ACJS_VITE_NO_RELOAD: '1' } });
  return p;
}

/** A port nothing is listening on right now (the OS picks it). */
function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolvePort(port));
    });
  });
}

/** Wait for OUR Vite on `port`: fail if the process died (e.g. the port was taken). */
async function waitOwnVite(p: ChildProcess, port: number): Promise<void> {
  await waitHttp(`http://localhost:${port}/`);
  if (p.exitCode !== null) throw new Error(`vite on :${port} exited (code ${p.exitCode}) — something else answers that port`);
}

function stop(p: ChildProcess | undefined): void {
  if (p?.pid) { try { process.kill(-p.pid, 'SIGTERM'); } catch { /* gone */ } }
}

function capture(port: number, outDir: string): void {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const url = `http://localhost:${port}/?ace&bridge=${BRIDGE}&account=${ACCOUNT}&password=${PASSWORD}&cb=regress`
    + (ERA ? `&era=${encodeURIComponent(ERA)}` : '');
  console.log(`[regress] capturing :${port} → ${relative(ROOT, outDir)}`);
  execFileSync('npx', ['tsx', join(ROOT, 'tools', 'capture-ui-screens.ts'), '--out', outDir, '--no-world', ...(UI_ONLY ? ['--panels'] : []), ...filters], {
    cwd: ROOT, stdio: 'inherit', env: { ...process.env, AC_URL: url, ...(GPU ? { AC_GPU: '1' } : {}) },
  });
}

function listPngs(dir: string): Map<string, { kind: CaptureKind; file: string }> {
  const m = new Map<string, { kind: CaptureKind; file: string }>();
  const add = (sub: '' | 'preworld' | 'scenes') => {
    const d = join(dir, sub);
    if (!existsSync(d)) return;
    for (const f of readdirSync(d)) {
      if (!f.endsWith('.png') || f.startsWith('_')) continue;
      const base = f.slice(0, -4);
      m.set(`${sub ? `${sub}/` : ''}${base}`, { kind: kindFor(sub, base), file: join(d, f) });
    }
  };
  add(''); add('preworld'); add('scenes');
  return m;
}

/** WebGL renderer string capture-ui-screens.ts recorded in a manifest. */
function captureRenderer(dir: string): string {
  for (const f of [join(dir, 'manifest.json'), join(dir, 'scenes', 'manifest.json'), join(dir, 'preworld', 'manifest.json')]) {
    if (!existsSync(f)) continue;
    try { const r = JSON.parse(readFileSync(f, 'utf8')).renderer; if (typeof r === 'string' && r) return r; } catch { /* next */ }
  }
  return 'unknown';
}

async function main(): Promise<void> {
  if (!COMPARE_ONLY) {
    mkdirSync(OUT, { recursive: true });
    const lockFile = join(OUT, '.run.lock');
    const lock = acquireRunLock(existsSync(lockFile) ? readFileSync(lockFile, 'utf8') : null, process.pid, (pid) => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    });
    if (!lock) {
      console.error(`[regress] another screen-regression run (pid ${readFileSync(lockFile, 'utf8').trim()}) is capturing — both would log into the shared ACE account; wait for it.`);
      process.exit(3);
    }
    writeFileSync(lockFile, String(lock.holder));
    process.on('exit', () => { try { if (readFileSync(lockFile, 'utf8').trim() === String(process.pid)) rmSync(lockFile); } catch { /* gone */ } });
  }
  const baseRef = CALIBRATE ? 'HEAD' : flag('--base') ?? defaultBase();
  const noise: NoiseFloor = existsSync(NOISE_FILE) ? JSON.parse(readFileSync(NOISE_FILE, 'utf8')) : {};
  const baseSha = git('rev-parse', baseRef);
  const headSha = git('rev-parse', 'HEAD');
  if (git('status', '--porcelain', '--untracked-files=no')) {
    console.log('[regress] note: HEAD side includes uncommitted changes in the working tree');
  }
  console.log(`[regress] base ${baseSha.slice(0, 8)} vs head ${headSha.slice(0, 8)} (working tree)`);

  if (!COMPARE_ONLY) await captureBoth(baseSha);
  compareAndReport(baseSha, headSha, noise);
}

/** Whether the base commit's package-lock.json differs from HEAD's working tree. */
function baseLockDiffers(baseSha: string): boolean {
  let base = '';
  try {
    base = execFileSync('git', ['show', `${baseSha}:package-lock.json`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch { return false; }
  const head = existsSync(join(ROOT, 'package-lock.json')) ? readFileSync(join(ROOT, 'package-lock.json'), 'utf8') : '';
  return base.trim() !== head.trim();
}

async function captureBoth(baseSha: string): Promise<void> {
  // Base build: a detached worktree sharing this checkout's deps and DATs.
  const wt = join(tmpdir(), `acjs-regress-${baseSha.slice(0, 8)}-${process.pid}`);
  git('worktree', 'add', '--detach', '-f', wt, baseSha);
  const link = (rel: string) => {
    const src = join(ROOT, rel);
    if (existsSync(src) && !existsSync(join(wt, rel))) { mkdirSync(dirname(join(wt, rel)), { recursive: true }); symlinkSync(src, join(wt, rel)); }
  };
  link('dat'); link('reference');
  // A base with a different lockfile (a dependency upgrade, e.g. three r160 →
  // r186) must render with ITS deps: sharing HEAD's node_modules would make
  // both sides the new version and hide every change the upgrade causes.
  if (baseLockDiffers(baseSha)) {
    console.log('[regress] base package-lock.json differs from HEAD — npm ci in the base worktree (own node_modules)');
    execFileSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: wt, stdio: 'inherit' });
  } else {
    link('node_modules');
    for (const pkgDir of ['packages', 'services']) {
      for (const p of readdirSync(join(ROOT, pkgDir))) link(join(pkgDir, p, 'node_modules'));
    }
  }

  let baseVite: ChildProcess | undefined;
  let headVite: ChildProcess | undefined;
  const cleanup = () => {
    stop(baseVite); stop(headVite);
    if (!KEEP) { try { git('worktree', 'remove', '--force', wt); } catch { rmSync(wt, { recursive: true, force: true }); } }
  };
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });
  try {
    const basePort = await freePort();
    const headPort = await freePort();
    baseVite = startVite(wt, basePort);
    headVite = startVite(ROOT, headPort);
    await waitOwnVite(baseVite, basePort);
    await waitOwnVite(headVite, headPort);
    capture(basePort, join(OUT, 'base'));
    capture(headPort, join(OUT, 'head'));
  } finally {
    cleanup();
  }
}

function compareAndReport(baseSha: string, headSha: string, noise: NoiseFloor): void {
  const base = listPngs(join(OUT, 'base'));
  const head = listPngs(join(OUT, 'head'));
  const diffDir = join(OUT, 'diff');
  rmSync(diffDir, { recursive: true, force: true });
  mkdirSync(diffDir, { recursive: true });
  const diffs: PairDiff[] = [];
  for (const name of new Set([...base.keys(), ...head.keys()])) {
    const b = base.get(name), h = head.get(name);
    const kind = (b ?? h)!.kind;
    const threshold = CALIBRATE ? 0 : thresholdFor(name, kind, noise);
    const clusterFloor = CALIBRATE ? 0 : clusterThresholdFor(name, kind, noise);
    const d = diffPair(name, kind, b ? readFileSync(b.file) : null, h ? readFileSync(h.file) : null, threshold, clusterFloor);
    if (d.diffPng) {
      const f = join(diffDir, `${name}.png`);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, d.diffPng);
    }
    diffs.push(d);
  }
  diffs.sort((x, y) => y.ratio - x.ratio);
  if (CALIBRATE) {
    const run = { date: new Date().toISOString().slice(0, 10), renderer: captureRenderer(join(OUT, 'head')) };
    const merged = mergeNoise(noise, diffs, run);
    writeFileSync(NOISE_FILE, `${JSON.stringify(merged, null, 1)}\n`);
    const broken = diffs.filter((d) => d.ratio > BROKEN_CAPTURE_RATIO);
    for (const d of broken) console.log(`[regress] BROKEN capture, not recorded as noise: ${d.name} ${(d.ratio * 100).toFixed(1)}% — compare base/ and head/`);
    const noisy = diffs.filter((d) => (d.ratio > thresholdFor(d.name, d.kind) || d.largestCluster > clusterThresholdFor(d.name, d.kind))
      && d.ratio <= BROKEN_CAPTURE_RATIO);
    console.log(`[regress] calibration (${run.date}, ${run.renderer}): ${diffs.length} captures; ${noisy.length} noisier than their kind default → ${relative(ROOT, NOISE_FILE)}`);
    for (const d of noisy) console.log(`  ${d.name}: ${(d.ratio * 100).toFixed(3)}%, largest cluster ${d.largestCluster} px`);
    process.exit(0);
  }
  const verdict = judge(diffs, expect);
  const report = formatReport(verdict, baseSha.slice(0, 8), `${headSha.slice(0, 8)}+wt`);
  writeFileSync(join(OUT, 'report.md'), report);
  console.log(`\n${report}\n[regress] base/, head/, diff/ and report.md in ${relative(ROOT, OUT)}/`);
  process.exit(verdict.unexpected.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
