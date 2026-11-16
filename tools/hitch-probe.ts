/**
 * hitch-probe — attribute frame hitches to code. Records a CDP CPU profile, every
 * Long Animation Frame and every long task while the game runs, then names the
 * functions that held the main thread inside each one.
 *
 * Two modes:
 *
 *  - Session (default): perf-soak's phases (arrive, run 10 s, cycle panels, fight,
 *    chat, idle) at one or more POIs; prints each long frame's functions.
 *
 *  - Run (`--run SECS`, PERF.run-hitches 2026-11-15): the way a player meets the
 *    landblock-loading hitches. At each stop: teleport (unthrottled) and settle, then
 *    under `--throttle N` (CDP CPU throttling, a stand-in for a slow laptop CPU):
 *      steady  `--steady SECS` of running in a tight circle (W+D) where everything is
 *              already loaded: the per-frame cost with nothing loading;
 *      run     SECS of running straight on `--yaw DEG` (0 = north), crossing
 *              landblocks; the probe turns 90° when the character stops moving.
 *    For each phase it reports long-task ms per minute (the same PerformanceObserver
 *    'longtask' sum the first_minute telemetry sends as longTaskMs), the worst task,
 *    frame mean / p95 from rAF, frameStep's own phase split (__ac.framePhases), the
 *    whole phase's self time by area (tools/lib/profile-area.ts), and the functions
 *    (inclusive + self) that ran inside long tasks, summed, per minute.
 *
 * SwiftShader makes GPU-bound frames slow everywhere: use --gpu for frame numbers.
 * Usage: npx tsx tools/hitch-probe.ts [--stops Arwic,Cragstone] [--min-ms 100] [--gpu]
 *          [--run 60 --steady 20 --yaw 90 --throttle 4] [--draw-distance 3] [--pin-adapt]
 *          [--eval 'js run once after arrival (A/B toggles)'] [--tag name]
 *   --draw-distance N  set Landscape Draw Distance (the reporter's adaptive steps had it at 3).
 *   --pin-adapt        stop dynamic resolution from changing ratio / distance during the
 *                      measured phases (A/B runs need the same load on both sides).
 * Production streams DATs: pass AC_URL with &datSet=<pointer> (docs/perf-pass-2026-11-15.md).
 * Writes verification/perf/hitch-<utc>[-tag].json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from 'playwright';
import { REPO, adminCommand, enterWorld } from './lib/game-session.ts';
import { profileArea } from './lib/profile-area.ts';

const args = process.argv.slice(2);
const arg = (n: string) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : undefined; };
const STOPS = (arg('stops') ?? 'Arwic').split(',');
const MIN_MS = Number(arg('min-ms') ?? 100);
const RUN_SECS = arg('run') ? Number(arg('run')) : 0;
const STEADY_SECS = Number(arg('steady') ?? 20);
const YAW_DEG = Number(arg('yaw') ?? 90);
const THROTTLE = Number(arg('throttle') ?? 1);
const DRAW_DISTANCE = arg('draw-distance') ? Number(arg('draw-distance')) : null;
const PIN_ADAPT = args.includes('--pin-adapt');
const EVAL = arg('eval');
const TAG = arg('tag');
const SETTLE_MS = Number(arg('settle-ms') ?? 20000);
/** A teleport command to use instead of `@telepoi <stop>` (e.g. a dungeon cell: '@teleloc 0x8602023A [60 -20 0.005] 1 0 0 0'). */
const START = arg('start');
/** Throttle from the teleport on, so the arrival's object builds run at the slow CPU too (measured as the `arrive` phase). */
const THROTTLE_ARRIVE = args.includes('--throttle-arrive');
const PANEL_KEYS = ['F12', 'F8', 'F9', 'F5', 'F6', 'F3', 'F4', 'F10', 'F11'];

const { browser, page } = await enterWorld({ gpu: args.includes('--gpu') });
const cdp = await page.context().newCDPSession(page);

async function settleTeleport(p: Page, cmd: string, settleMs = 4000): Promise<void> {
  let done = false;
  const f = (m: { text(): string }) => { if (/Sent LoginComplete/.test(m.text())) done = true; };
  p.on('console', f);
  await adminCommand(p, cmd);
  for (let i = 0; i < 120 && !done; i++) await p.waitForTimeout(500);
  p.off('console', f);
  await p.waitForTimeout(settleMs);
}

await page.evaluate(`(() => { window.__loaf = []; window.__lt = []; window.__phase = 'start'; window.__frames = []; window.__fp = []; window.__pos = [];
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__loaf.push({ phase: window.__phase, start: e.startTime, dur: e.duration, block: e.blockingDuration,
    render: e.renderStart, style: e.styleAndLayoutStart,
    scripts: (e.scripts || []).map((s) => ({ inv: s.invoker, type: s.invokerType, fn: s.sourceFunctionName, url: (s.sourceURL || '').replace(/^.*\\/(src|deps)\\//, '$1/').replace(/\\?.*$/, ''), pos: s.sourceCharPosition, dur: s.duration })) }); })
    .observe({ type: 'long-animation-frame', buffered: false });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push({ phase: window.__phase, start: e.startTime, dur: e.duration }); })
    .observe({ type: 'longtask', buffered: false });
  // Every animation frame's interval, and frameStep's phase split for each frame it ran (telemetry/MainThreadCost.ts).
  let last = -1, lastFp = -1;
  requestAnimationFrame(function tick(t) {
    if (last >= 0) window.__frames.push({ phase: window.__phase, t, d: t - last });
    last = t;
    const fp = window.__ac && window.__ac.framePhases;
    if (fp && fp.frames !== lastFp) { if (lastFp >= 0) window.__fp.push({ phase: window.__phase, ms: Array.from(fp.frameMs) }); lastFp = fp.frames; }
    requestAnimationFrame(tick);
  });
  setInterval(() => { const c = window.acDebug && window.acDebug.collisionState && window.acDebug.collisionState(); if (c) window.__pos.push({ phase: window.__phase, t: performance.now(), x: c.x, z: c.z }); }, 500);
  // Program churn: every WebGLProgram three.js creates or releases, by phase.
  window.__progs = []; let known = new Map();
  const scan = () => { const r = window.__ac.sceneManager.renderer; const now = new Map((r.info.programs || []).map((p) => [p.id, p]));
    for (const [id, p] of now) if (!known.has(id)) window.__progs.push({ phase: window.__phase, t: performance.now(), op: '+', id, name: p.name, key: p.cacheKey.length > 400 ? p.cacheKey.slice(0, 400) + '…' : p.cacheKey });
    for (const [id, p] of known) if (!now.has(id)) window.__progs.push({ phase: window.__phase, t: performance.now(), op: '-', id, name: p.name, key: p.cacheKey.length > 400 ? p.cacheKey.slice(0, 400) + '…' : p.cacheKey });
    known = now; };
  scan(); setInterval(scan, 50); })()`);

const phase = (name: string) => page.evaluate(`window.__phase = ${JSON.stringify(name)}`);
const phaseTimes = new Map<string, { t0: number; t1: number }>();
async function timed(name: string, fn: () => Promise<void>): Promise<void> {
  await phase(name);
  const t0 = await page.evaluate('performance.now()') as number;
  await fn();
  const t1 = await page.evaluate('performance.now()') as number;
  phaseTimes.set(name, { t0, t1 });
}
const setYaw = (deg: number) => page.evaluate(`window.acDebug.setPlayerYaw(${(deg * Math.PI) / 180})`);

await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
const t0Page = await page.evaluate('performance.now()') as number;
await cdp.send('Profiler.start');
const t1Page = await page.evaluate('performance.now()') as number;

for (const stop of STOPS) {
  if (RUN_SECS > 0) {
    if (DRAW_DISTANCE !== null) await page.evaluate(`window.__ac.setLandscapeDrawDistance(${DRAW_DISTANCE})`);
    if (EVAL) await page.evaluate(EVAL);
    if (THROTTLE > 1 && THROTTLE_ARRIVE) await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
    await timed(`${stop}:arrive`, async () => {
      await settleTeleport(page, START ?? '@telepoi ' + stop, 2000);
      await page.waitForTimeout(SETTLE_MS);
    });
    await phase(`${stop}:settled`);
    await page.mouse.click(780, 250);
    if (THROTTLE > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
    if (PIN_ADAPT) await page.evaluate(`(() => { const d = window.__ac.sceneManager.dynamicResolution; if (d && !d.__pinned) { d.__pinned = true; d.frame = () => {}; } })()`);
    await timed(`${stop}:steady`, async () => {
      await page.keyboard.down('KeyW'); await page.keyboard.down('KeyD');
      await page.waitForTimeout(STEADY_SECS * 1000);
      await page.keyboard.up('KeyD'); await page.keyboard.up('KeyW');
    });
    await setYaw(YAW_DEG); await page.waitForTimeout(1500);
    await timed(`${stop}:run`, async () => {
      await page.keyboard.down('KeyW');
      let yaw = YAW_DEG; let prev: { x: number; z: number } | null = null;
      const end = Date.now() + RUN_SECS * 1000;
      while (Date.now() < end) {
        await page.waitForTimeout(2000);
        const c = await page.evaluate('window.acDebug.collisionState()') as { x: number; z: number };
        // Stuck against a wall / cliff: turn a quarter and keep going.
        if (prev && Math.hypot(c.x - prev.x, c.z - prev.z) < 4) { yaw = (yaw + 90) % 360; await setYaw(yaw); }
        prev = c;
      }
      await page.keyboard.up('KeyW');
    });
    if (THROTTLE > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    continue;
  }
  await phase(`${stop}:arrive`); await settleTeleport(page, '@telepoi ' + stop);
  await phase(`${stop}:running`);
  await page.mouse.click(780, 250);
  await page.keyboard.down('KeyW'); await page.keyboard.down('KeyD');
  await page.waitForTimeout(10000);
  await page.keyboard.up('KeyD'); await page.keyboard.up('KeyW');
  await phase(`${stop}:ui`);
  for (const key of PANEL_KEYS) { await page.keyboard.press(key); await page.waitForTimeout(600); await page.keyboard.press(key); await page.waitForTimeout(250); }
  await phase(`${stop}:combat`);
  await adminCommand(page, '@create 7'); await page.waitForTimeout(3000);
  await page.keyboard.press('Quote'); await page.waitForTimeout(500);
  await page.keyboard.press('Backquote');
  for (let k = 0; k < 3; k++) { await page.keyboard.press('PageDown'); await page.waitForTimeout(2500); }
  await page.keyboard.press('Backquote'); await page.waitForTimeout(1500);
  await phase(`${stop}:chat`);
  for (let i = 0; i < 15; i++) { await adminCommand(page, `soak chat ${i} the quick brown fox jumps over the lazy dog`); await page.waitForTimeout(80); }
  await phase(`${stop}:idle`); await page.waitForTimeout(3000);
}

type ProfileNode = { id: number; parent?: number; children?: number[]; callFrame: { functionName: string; url: string; lineNumber: number } };
const { profile } = await cdp.send('Profiler.stop') as { profile: { startTime: number; nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] } };
const progs = await page.evaluate('window.__progs') as Array<{ phase: string; t: number; op: string; id: number; name: string; key: string }>;
const loaf = await page.evaluate('window.__loaf') as Array<{ phase: string; start: number; dur: number; block: number; scripts: Array<{ inv: string; type: string; fn: string; url: string; dur: number }> }>;
const lt = await page.evaluate('window.__lt') as Array<{ phase: string; start: number; dur: number }>;
const frames = await page.evaluate('window.__frames') as Array<{ phase: string; t: number; d: number }>;
const fps = await page.evaluate('window.__fp') as Array<{ phase: string; ms: number[] }>;
const pos = await page.evaluate('window.__pos') as Array<{ phase: string; t: number; x: number; z: number }>;
const pageUrl = page.url().replace(/password=[^&]*/, 'password=…');
await browser.close();

// Profile time (µs since its own start) → page time: Profiler.start landed between t0Page and t1Page.
const pageAt0 = (t0Page + t1Page) / 2;
const parent = new Map<number, number>();
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const label = (id: number) => { const f = byId.get(id)!.callFrame; return `${f.functionName || '(anon)'} ${f.url.replace(/^.*\/(src|deps)\//, '$1/').replace(/\?.*$/, '')}:${f.lineNumber + 1}`; };
const times: number[] = []; let acc = 0;
for (const d of profile.timeDeltas) { acc += d; times.push(pageAt0 + acc / 1000); }
const sampleMs = (i: number) => (profile.timeDeltas[i + 1] ?? 500) / 1000;

/** Inclusive + self time by function over the samples inside any of the windows. */
function attribute(windows: Array<{ start: number; dur: number }>): { incl: Map<string, number>; self: Map<string, number>; area: Map<string, number> } {
  const incl = new Map<string, number>(); const self = new Map<string, number>(); const area = new Map<string, number>();
  const ws = [...windows].sort((a, b) => a.start - b.start);
  let w = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const t = times[i];
    while (w < ws.length && ws[w].start + ws[w].dur < t) w++;
    if (w >= ws.length) break;
    if (t < ws[w].start) continue;
    const dt = sampleMs(i);
    const leaf = profile.samples[i];
    self.set(label(leaf), (self.get(label(leaf)) ?? 0) + dt);
    const a = profileArea(byId.get(leaf)!.callFrame);
    area.set(a, (area.get(a) ?? 0) + dt);
    const seen = new Set<string>();
    for (let id: number | undefined = leaf; id !== undefined; id = parent.get(id)) { const l = label(id); if (seen.has(l)) continue; seen.add(l); incl.set(l, (incl.get(l) ?? 0) + dt); }
  }
  return { incl, self, area };
}
const top = (m: Map<string, number>, n: number, scale = 1) => [...m.entries()].filter(([k]) => !/^\(root\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${(v * scale).toFixed(0).padStart(6)} ms  ${k}`);
const pct = (a: number[], p: number) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

const FRAME_PHASES = ['nav', 'tags', 'agent', 'routine', 'ub', 'mag', 'physics', 'sweep', 'anim', 'sync', 'camera', 'fx', 'stream', 'hud', 'lod', 'warmup', 'render'];
const summaries: Record<string, unknown>[] = [];
if (RUN_SECS > 0) {
  for (const [name, { t0, t1 }] of phaseTimes) {
    const mins = (t1 - t0) / 60000;
    const tasks = lt.filter((e) => e.phase === name);
    const ltMs = tasks.reduce((s, e) => s + e.dur, 0);
    const fr = frames.filter((f) => f.phase === name).map((f) => f.d);
    const fpRows = fps.filter((f) => f.phase === name);
    const phaseMean = FRAME_PHASES.map((_, i) => fpRows.length ? fpRows.reduce((s, r) => s + (r.ms[i] ?? 0), 0) / fpRows.length : 0);
    const work = fpRows.map((r) => r.ms.reduce((s, v) => s + v, 0));
    const p = pos.filter((q) => q.phase === name);
    const blocks = new Set(p.map((q) => `${Math.floor(q.x / 192)},${Math.floor(q.z / 192)}`));
    let dist = 0; for (let i = 1; i < p.length; i++) dist += Math.hypot(p[i].x - p[i - 1].x, p[i].z - p[i - 1].z);
    const inTasks = attribute(tasks);
    const whole = attribute([{ start: t0, dur: t1 - t0 }]);
    const perMin = 1 / mins;
    const s = {
      phase: name, secs: +((t1 - t0) / 1000).toFixed(1), throttle: THROTTLE,
      longTaskMsPerMin: Math.round(ltMs * perMin), longTaskMsTotal: Math.round(ltMs), longTasks: tasks.length, worstTaskMs: Math.round(Math.max(0, ...tasks.map((e) => e.dur))),
      tasksOver100: tasks.filter((e) => e.dur >= 100).length, tasksOver250: tasks.filter((e) => e.dur >= 250).length,
      frames: fr.length, frameMean: +(fr.reduce((a, b) => a + b, 0) / Math.max(1, fr.length)).toFixed(1), frameP50: +pct(fr, 0.5).toFixed(1), frameP95: +pct(fr, 0.95).toFixed(1), frameMax: Math.round(Math.max(0, ...fr)),
      frameStepMean: +(work.reduce((a, b) => a + b, 0) / Math.max(1, work.length)).toFixed(2), frameStepP95: +pct(work, 0.95).toFixed(2),
      frameStepPhases: Object.fromEntries(FRAME_PHASES.map((n, i) => [n, +phaseMean[i].toFixed(2)]).filter(([, v]) => (v as number) >= 0.05)),
      landblocksVisited: blocks.size, metres: Math.round(dist),
      wholeByAreaMsPerMin: Object.fromEntries([...whole.area.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round(v * perMin)])),
      wholeSelfTop: top(whole.self, 25, perMin), wholeInclTop: top(whole.incl, 40, perMin),
      longTaskByAreaMsPerMin: Object.fromEntries([...inTasks.area.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round(v * perMin)])),
      longTaskSelfTop: top(inTasks.self, 30, perMin), longTaskInclTop: top(inTasks.incl, 60, perMin),
    };
    summaries.push(s);
    console.log(`\n##### ${name}: ${s.secs}s @${THROTTLE}x  longTask ${s.longTaskMsPerMin} ms/min (${s.longTasks} tasks, worst ${s.worstTaskMs} ms, >=100: ${s.tasksOver100}, >=250: ${s.tasksOver250})  frame mean ${s.frameMean} p95 ${s.frameP95} max ${s.frameMax}  frameStep mean ${s.frameStepMean} p95 ${s.frameStepP95}  blocks ${s.landblocksVisited} / ${s.metres} m`);
    console.log('  frameStep phases (mean ms/frame):', JSON.stringify(s.frameStepPhases));
    console.log('  whole phase by area (ms/min):', JSON.stringify(s.wholeByAreaMsPerMin));
    console.log('  long tasks by area (ms/min):', JSON.stringify(s.longTaskByAreaMsPerMin));
    console.log('  long tasks inclusive (ms/min):'); for (const l of s.longTaskInclTop.slice(0, 45)) console.log('   ', l);
    console.log('  long tasks self (ms/min):'); for (const l of s.longTaskSelfTop.slice(0, 20)) console.log('   ', l);
    console.log('  whole phase self (ms/min):'); for (const l of s.wholeSelfTop.slice(0, 20)) console.log('   ', l);
  }
}

const long = loaf.filter((e) => e.dur >= MIN_MS);
const report = long.map((e) => {
  const { incl, self } = attribute([e]);
  return { phase: e.phase, start: Math.round(e.start), dur: Math.round(e.dur), block: Math.round(e.block), scripts: e.scripts.filter((s) => s.dur > 5).map((s) => `${Math.round(s.dur)}ms ${s.type} ${s.inv} ${s.fn} ${s.url}`), self: top(self, 8), incl: top(incl, 18) };
});
if (RUN_SECS === 0) {
  for (const r of report) {
    console.log(`\n=== ${r.phase}  frame ${r.dur} ms (blocking ${r.block}) @${r.start}`);
    for (const s of r.scripts) console.log('  script', s);
    console.log('  self:'); for (const s of r.self) console.log('   ', s);
    console.log('  inclusive:'); for (const s of r.incl) console.log('   ', s);
  }
}
const perPhase = new Map<string, { n: number; max: number }>();
for (const e of loaf) { const p = perPhase.get(e.phase) ?? { n: 0, max: 0 }; if (e.dur >= MIN_MS) p.n++; p.max = Math.max(p.max, e.dur); perPhase.set(e.phase, p); }
console.log('\nprogram churn:'); for (const p of progs.filter((q) => !/:arrive$|^start$/.test(q.phase))) console.log(`  ${p.phase.padEnd(22)} ${p.op} #${p.id} ${p.name}  @${Math.round(p.t)}`);
console.log('\nlong frames per phase (>= ' + MIN_MS + ' ms):'); for (const [k, v] of perPhase) console.log(`  ${k.padEnd(22)} ${v.n}  max ${Math.round(v.max)} ms`);
mkdirSync(resolve(REPO, 'verification/perf'), { recursive: true });
const file = resolve(REPO, `verification/perf/hitch-${new Date().toISOString().replace(/[:.]/g, '-')}${TAG ? '-' + TAG : ''}.json`);
writeFileSync(file, JSON.stringify({ stops: STOPS, minMs: MIN_MS, run: RUN_SECS, steady: STEADY_SECS, yaw: YAW_DEG, throttle: THROTTLE, drawDistance: DRAW_DISTANCE, pinAdapt: PIN_ADAPT, eval: EVAL ?? null, url: pageUrl, summaries, path: pos.filter((q, i) => i % 4 === 0).map((q) => ({ phase: q.phase, t: Math.round(q.t), x: Math.round(q.x), z: Math.round(q.z) })), longTasks: lt.map((e) => ({ phase: e.phase, start: Math.round(e.start), dur: Math.round(e.dur) })), report, progs }, null, 1) + '\n');
console.log('wrote', file);
