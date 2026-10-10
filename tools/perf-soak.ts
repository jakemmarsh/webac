/**
 * perf-soak — long-session resource soak on the real GPU (2026-09-30: Jake's
 * browser crashed from memory use on an M3 Max during normal play).
 *
 * measure-perf.ts measures one spot for a few seconds; leaks only show over
 * a session. This drives a route of teleports, and runs + turns at each
 * stop, then samples every few seconds:
 *   - JS heap (CDP Performance.getMetrics JSHeapUsedSize / JSHeapTotalSize)
 *   - main-thread busy fraction (TaskDuration delta / wall delta)
 *   - DOM nodes, event listeners (Memory.getDOMCounters)
 *   - three.js renderer.info: geometries, textures, programs, draw calls
 *   - scene object counts: server objects, scene children, active scripts
 *   - fps over the sample window (rAF deltas)
 *   - browser process-tree RSS (ps over the launched Chromium's pids)
 * and writes verification/perf/soak-<utc>.json plus a summary with per-stop
 * growth. A metric that only climbs across stops is a leak candidate.
 *
 * Session soak (2026-10-03 resource sweep, proposals 2 + 4): at every stop it
 * also plays a session, not just a route. It cycles every panel and tab
 * (retail default keys), fights a spawned monster in combat mode, and sends
 * chat. Extra counters: canvases created, canvases in the page, GPU
 * context losses (ContextHealth), and frame-time hitches per phase (p99 and
 * worst frame, frames over 50 ms). `--minutes N` repeats the route until N
 * minutes have passed (the nightly hour-long GPU run).
 *
 * Exit 2 when the docs/performance-budgets.md soak budget is breached.
 * Usage: npx tsx tools/perf-soak.ts [--stops N] [--minutes N] [--route-only] [--swiftshader]
 * Account: testacjs2 on macOS (game-session default). One live run at a time.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { resolve } from 'node:path';
import type { ConsoleMessage, Page } from 'playwright';
import { REPO, adminCommand, enterWorld, healthSignals } from './lib/game-session.ts';
import { frameStats, hostSummary, sampleHost, sessionBudgetBreaches, soakCharacterName, type FrameStats, type SampleHost } from './perf-soak-lib.ts';
import { hostContention, parsePs, processTree, type HostContention } from './gpu-queue-lib.mjs';

const args = process.argv.slice(2);
const STOPS = Number(args[args.indexOf('--stops') + 1]) || 8;
const MINUTES = args.includes('--minutes') ? Number(args[args.indexOf('--minutes') + 1]) || 0 : 0;
const SESSION = !args.includes('--route-only');
/** Retail default panel keys (KeyMap 0x14000000): inventory, attributes, skills, spellbook, components, allegiance, fellowship, world, options. */
const PANEL_KEYS = ['F12', 'F8', 'F9', 'F5', 'F6', 'F3', 'F4', 'F10', 'F11'];
/** A Drudge Skulker (weenie 7) to fight at each stop. */
const MONSTER_WCID = 7;
const MONSTER_NAME = 'Drudge Skulker';
const GPU = !args.includes('--swiftshader');
const ROUTE = ['Holtburg', 'Shoushi', 'Yaraq', 'Arwic', 'Cragstone', 'Rithwic', 'Eastham', 'Lytelthorpe', 'Zaikhal', 'Sawato', 'Tufa', 'Nanto'];

interface Sample {
  t: number; stop: string; phase: string;
  heapMB: number; heapTotalMB: number; busy: number; nodes: number; listeners: number;
  geometries: number; textures: number; programs: number; calls: number; triangles: number;
  serverObjects: number; sceneChildren: number; scripts: number; fps: number; procRssMB: number;
  canvasCreated: number; domCanvases: number; webglLost: number; canvas2dLost: number;
  frames: FrameStats;
  /** What else used the machine at this sample (hostContention). */
  host?: SampleHost;
}

/** RSS of `rootPid` and its descendants, MB (0 when ps fails or the pid is gone). */
function processTreeRssMB(rootPid: number | undefined): number {
  if (!rootPid) return 0;
  try {
    const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' }).trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
    const rss = new Map(rows.map(([pid, , r]) => [pid, r]));
    let total = 0;
    for (const p of processTree(rows.map(([pid, ppid]) => ({ pid, ppid, pcpu: 0, command: '' })), rootPid)) total += rss.get(p) ?? 0;
    return Math.round(total / 1024);
  } catch { return 0; }
}

/** Everything else using the machine now: other browsers, the retail client, the load average. */
function hostNow(ownRoot: number | undefined): HostContention | undefined {
  try {
    return hostContention(parsePs(execFileSync('ps', ['-axo', 'pid=,ppid=,pcpu=,command='], { encoding: 'utf8' })), { load1: loadavg()[0], cpus: cpus().length, ownRoot });
  } catch { return undefined; }
}

async function settleTeleport(page: Page, cmd: string): Promise<void> {
  let done = false;
  const f = (m: ConsoleMessage) => { if (/Sent LoginComplete/.test(m.text())) done = true; };
  page.on('console', f);
  await adminCommand(page, cmd);
  for (let i = 0; i < 120 && !done; i++) await page.waitForTimeout(500);
  page.off('console', f);
  await page.waitForTimeout(4000);
}

// A dedicated probe account on a fresh DB has no character yet.
const { browser, page } = await enterWorld({ gpu: GPU, createCharacter: soakCharacterName(process.env.AC_ACCOUNT) });
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
// Our own browser process, asked of the browser itself. Picking "the"
// Playwright Chromium out of ps measured another session's browser whenever
// one ran beside the soak (PERF.gpu-soak-hitch-ee124a12: 1061 MB, then 0 once it quit).
const browserPid = await browser.newBrowserCDPSession()
  .then((s) => s.send('SystemInfo.getProcessInfo'))
  .then((r) => (r.processInfo as Array<{ type: string; id: number }>).find((p) => p.type === 'browser')?.id)
  .catch(() => undefined);
await page.evaluate(`(() => { window.__soakFrames = []; let last = performance.now(); const tick = (t) => { window.__soakFrames.push(t - last); last = t; requestAnimationFrame(tick); }; requestAnimationFrame(tick);
  window.__soakCanvases = 0; const ce = document.createElement.bind(document);
  document.createElement = (t, ...a) => { if (String(t).toLowerCase() === 'canvas') window.__soakCanvases++; return ce(t, ...a); }; })()`);

const samples: Sample[] = [];
let lastTask = 0, lastWall = 0;
async function sample(stop: string, phase: string): Promise<void> {
  const m = (await cdp.send('Performance.getMetrics')).metrics as Array<{ name: string; value: number }>;
  const get = (n: string) => m.find((x) => x.name === n)?.value ?? 0;
  const dom = await cdp.send('Memory.getDOMCounters').catch(() => ({ nodes: 0, jsEventListeners: 0 })) as { nodes: number; jsEventListeners: number };
  const task = get('TaskDuration'), wall = get('Timestamp');
  const busy = lastWall ? (task - lastTask) / Math.max(1e-6, wall - lastWall) : 0;
  lastTask = task; lastWall = wall;
  const s = JSON.parse(await page.evaluate(`(() => { const a = window.__ac; const r = a.sceneManager.renderer; const f = window.__soakFrames.splice(0); const avg = f.length ? f.reduce((x, y) => x + y, 0) / f.length : 0;
    return JSON.stringify({ geometries: r.info.memory.geometries, textures: r.info.memory.textures, programs: (r.info.programs || []).length, calls: r.info.render.calls, triangles: r.info.render.triangles,
      serverObjects: a.serverObjectManager.getAllObjects().size, sceneChildren: a.sceneManager.scene.children.length, scripts: a.physicsScriptPlayer ? a.physicsScriptPlayer.activeCount : -1, fps: avg ? 1000 / avg : 0,
      canvasCreated: window.__soakCanvases || 0, domCanvases: [...document.querySelectorAll('canvas')].filter((c) => !c.closest('#hud-chat')).length, frameMs: f }); })()`) as string);
  const health = await healthSignals(page);
  const { frameMs, ...rest } = s;
  samples.push({ t: Math.round(wall), stop, phase, heapMB: +(get('JSHeapUsedSize') / 1048576).toFixed(1), heapTotalMB: +(get('JSHeapTotalSize') / 1048576).toFixed(1), busy: +busy.toFixed(2),
    nodes: dom.nodes, listeners: dom.jsEventListeners, ...rest, fps: +s.fps.toFixed(1), procRssMB: processTreeRssMB(browserPid),
    webglLost: health.webglLost, canvas2dLost: health.canvas2dLost, frames: frameStats(frameMs as number[]), host: sampleHost(hostNow(browserPid)) });
}

/** Open and close every panel with its retail default key. */
async function cyclePanels(): Promise<void> {
  for (const key of PANEL_KEYS) {
    await page.keyboard.press(key); await page.waitForTimeout(600);
    await page.keyboard.press(key); await page.waitForTimeout(250);
  }
}

/** The newest dynamic object with this name (a spawn of ours), or null. */
const findSpawn = (name: string): Promise<number | null> => page.evaluate(`(() => { const o = (window.acDebug.getObjects() || []).filter((x) => x.name === ${JSON.stringify(name)} && x.guid >= 0x80000000);
  return o.length ? o[o.length - 1].guid : null; })()`) as Promise<number | null>;

/** Delete a spawn exactly: select + identify its guid (ACE's @delete acts on the last identified object), then @delete. */
async function removeSpawn(guid: number): Promise<void> {
  await page.evaluate(`window.acDebug.select(${guid}); window.__ac.identifyObject(${guid});`);
  await page.waitForTimeout(1200);
  await adminCommand(page, '@delete');
  await page.waitForTimeout(1200);
}

/** Spawn a monster, select it, fight in combat mode for a while, then leave combat and delete it. */
async function fightMonster(stop: string): Promise<void> {
  await adminCommand(page, `@create ${MONSTER_WCID}`);
  await page.waitForTimeout(3000);
  await page.keyboard.press('Quote');        // Select Closest Monster
  await page.waitForTimeout(500);
  await page.keyboard.press('Backquote');    // Toggle Combat Mode
  for (let k = 0; k < 3; k++) {
    await page.keyboard.press('PageDown');   // High attack (melee) / next spell; either exercises combat
    await page.waitForTimeout(2500);
    await sample(stop, 'combat');
  }
  await page.keyboard.press('Backquote');
  await page.waitForTimeout(1500);
  for (let g = await findSpawn(MONSTER_NAME); g !== null; g = await findSpawn(MONSTER_NAME)) await removeSpawn(g);
}

async function sendChat(n: number): Promise<void> {
  for (let i = 0; i < n; i++) { await adminCommand(page, `soak chat ${i} the quick brown fox jumps over the lazy dog`); await page.waitForTimeout(80); }
}

await sample('start', 'idle');
const started = Date.now();
let visited = 0;
for (let cycle = 0; cycle === 0 || (MINUTES > 0 && Date.now() - started < MINUTES * 60_000); cycle++) {
  for (let i = 0; i < STOPS; i++) {
    const stop = ROUTE[i % ROUTE.length];
    await settleTeleport(page, '@telepoi ' + stop);
    await sample(stop, 'arrived');
    await page.mouse.click(780, 250);
    await page.keyboard.down('KeyW'); await page.keyboard.down('KeyD');
    for (let k = 0; k < 4; k++) { await page.waitForTimeout(2500); await sample(stop, 'running'); }
    await page.keyboard.up('KeyD'); await page.keyboard.up('KeyW');
    if (SESSION) {
      await cyclePanels(); await sample(stop, 'ui');
      await fightMonster(stop);
      await sendChat(15); await sample(stop, 'chat');
    }
    await page.waitForTimeout(2000); await sample(stop, 'idle');
    visited++;
    if (MINUTES > 0 && Date.now() - started >= MINUTES * 60_000) break;
  }
}
// Return to the first stop so the end is compared like for like (each town
// legitimately holds different content), let the resource sweep run, then
// force a GC so only retained memory remains.
await settleTeleport(page, '@telepoi ' + ROUTE[0]);
// Objects that left with the old cells are kept 25 s (CObjectMaint's destruction
// timer, ServerObjectManager.updateObjectMaint) — wait them out.
await page.waitForTimeout(28000);
await page.evaluate('window.__ac.sweepUnusedResources && window.__ac.sweepUnusedResources()');
await cdp.send('HeapProfiler.collectGarbage').catch(() => {});
await page.waitForTimeout(2000); await sample('end', 'after-gc');

const renderer = await page.evaluate(`(() => { const gl = window.__ac.sceneManager.renderer.getContext(); const ext = gl.getExtension('WEBGL_debug_renderer_info'); return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown'; })()`);
const outDir = resolve(REPO, 'verification/perf'); mkdirSync(outDir, { recursive: true });
const file = resolve(outDir, `soak-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify({ renderer, stops: STOPS, visited, minutes: MINUTES, session: SESSION, samples }, null, 1) + '\n');
const first = samples[0], last = samples[samples.length - 1];
const keys: Array<keyof Sample> = ['heapMB', 'procRssMB', 'geometries', 'textures', 'programs', 'serverObjects', 'sceneChildren', 'scripts', 'nodes', 'listeners', 'domCanvases', 'canvasCreated', 'webglLost', 'canvas2dLost'];
console.log(`renderer: ${renderer}   stops: ${STOPS}   samples: ${samples.length}`);
console.log('metric'.padEnd(14) + 'start'.padStart(9) + 'max'.padStart(9) + 'end(gc)'.padStart(9) + '  per-stop idle values');
for (const k of keys) {
  const idle = samples.filter((s) => s.phase === 'idle').map((s) => s[k]);
  console.log(String(k).padEnd(14) + String(first[k]).padStart(9) + String(Math.max(...samples.map((s) => Number(s[k])))).padStart(9) + String(last[k]).padStart(9) + '  ' + idle.join(' '));
}
const run = samples.filter((s) => s.phase === 'running');
for (const phase of ['running', 'ui', 'combat', 'chat', 'arrived']) {
  const ph = samples.filter((x) => x.phase === phase);
  if (!ph.length) continue;
  const p99 = Math.max(...ph.map((x) => x.frames.p99)), worst = Math.max(...ph.map((x) => x.frames.max)), hitches = ph.reduce((a, x) => a + x.frames.over50, 0);
  console.log(`frames ${phase.padEnd(8)} worst-window p99 ${p99.toFixed(1)} ms   worst frame ${worst.toFixed(1)} ms   frames > 50 ms: ${hitches}`);
}
console.log(`running fps avg ${(run.reduce((a, s) => a + s.fps, 0) / Math.max(1, run.length)).toFixed(1)}  min ${Math.min(...run.map((s) => s.fps)).toFixed(1)}   main-thread busy avg ${(run.reduce((a, s) => a + s.busy, 0) / Math.max(1, run.length)).toFixed(2)}`);
const host = hostSummary(samples);
if (host) console.log(host);
console.log('wrote', file);
// Budget (docs/performance-budgets.md): back at the first stop after the
// sweep + GC, GPU textures and geometries within 25% of that stop's first
// visit, and process-tree RSS growth under 1 GB. Exit 2 on a breach.
// Baseline: the first stop (ROUTE[0]) after it settled — the end sample is taken there again.
const firstStop = samples.find((x) => x.stop === ROUTE[0] && x.phase === 'idle') ?? first;
const base = (k: 'textures' | 'geometries') => Math.max(first[k], firstStop[k]);
const breaches: string[] = [];
for (const k of ['textures', 'geometries'] as const) if (last[k] > base(k) * 1.25) breaches.push(`${k} ${base(k)} → ${last[k]} (> +25%)`);
if (first.procRssMB && last.procRssMB - first.procRssMB > 1024) breaches.push(`process RSS +${last.procRssMB - first.procRssMB} MB (> 1 GB)`);
breaches.push(...sessionBudgetBreaches(samples, { firstStop, last }, GPU));
await browser.close();
if (breaches.length) { console.log('SOAK BUDGET BREACHED: ' + breaches.join('; ')); process.exit(2); }
console.log('soak budget: OK');
