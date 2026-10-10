/**
 * hitch-probe — attribute frame hitches to code. Runs perf-soak's session
 * phases (arrive, run, cycle panels, fight, chat, idle) at one or more POIs
 * while recording a CDP CPU profile and every Long Animation Frame, then for
 * each long frame prints the functions that held the main thread inside it
 * (inclusive time from the profile samples in that window).
 * SwiftShader makes GPU-bound frames slow everywhere, so judge JS time in the
 * window (the listed functions), not the frame length itself.
 * Usage: npx tsx tools/hitch-probe.ts [--stops Arwic,Cragstone] [--min-ms 100] [--gpu]
 * Writes verification/perf/hitch-<utc>.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from 'playwright';
import { REPO, adminCommand, enterWorld } from './lib/game-session.ts';

const args = process.argv.slice(2);
const arg = (n: string) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : undefined; };
const STOPS = (arg('stops') ?? 'Arwic').split(',');
const MIN_MS = Number(arg('min-ms') ?? 100);
const PANEL_KEYS = ['F12', 'F8', 'F9', 'F5', 'F6', 'F3', 'F4', 'F10', 'F11'];

const { browser, page } = await enterWorld({ gpu: args.includes('--gpu') });
const cdp = await page.context().newCDPSession(page);

async function settleTeleport(p: Page, cmd: string): Promise<void> {
  let done = false;
  const f = (m: { text(): string }) => { if (/Sent LoginComplete/.test(m.text())) done = true; };
  p.on('console', f);
  await adminCommand(p, cmd);
  for (let i = 0; i < 120 && !done; i++) await p.waitForTimeout(500);
  p.off('console', f);
  await p.waitForTimeout(4000);
}

await page.evaluate(`(() => { window.__loaf = []; window.__phase = 'start';
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__loaf.push({ phase: window.__phase, start: e.startTime, dur: e.duration, block: e.blockingDuration,
    render: e.renderStart, style: e.styleAndLayoutStart,
    scripts: (e.scripts || []).map((s) => ({ inv: s.invoker, type: s.invokerType, fn: s.sourceFunctionName, url: (s.sourceURL || '').replace(/^.*\\/(src|deps)\\//, '$1/').replace(/\\?.*$/, ''), pos: s.sourceCharPosition, dur: s.duration })) }); })
    .observe({ type: 'long-animation-frame', buffered: false });
  // Program churn: every WebGLProgram three.js creates or releases, by phase.
  window.__progs = []; let known = new Map();
  const scan = () => { const r = window.__ac.sceneManager.renderer; const now = new Map((r.info.programs || []).map((p) => [p.id, p]));
    for (const [id, p] of now) if (!known.has(id)) window.__progs.push({ phase: window.__phase, t: performance.now(), op: '+', id, name: p.name, key: p.cacheKey.length > 400 ? p.cacheKey.slice(0, 400) + '…' : p.cacheKey });
    for (const [id, p] of known) if (!now.has(id)) window.__progs.push({ phase: window.__phase, t: performance.now(), op: '-', id, name: p.name, key: p.cacheKey.length > 400 ? p.cacheKey.slice(0, 400) + '…' : p.cacheKey });
    known = now; };
  scan(); setInterval(scan, 50); })()`);

const phase = (name: string) => page.evaluate(`window.__phase = ${JSON.stringify(name)}`);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
const t0Page = await page.evaluate('performance.now()') as number;
await cdp.send('Profiler.start');
const t1Page = await page.evaluate('performance.now()') as number;

for (const stop of STOPS) {
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

const { profile } = await cdp.send('Profiler.stop') as { profile: { startTime: number; nodes: Array<{ id: number; parent?: number; children?: number[]; callFrame: { functionName: string; url: string; lineNumber: number } }>; samples: number[]; timeDeltas: number[] } };
const progs = await page.evaluate('window.__progs') as Array<{ phase: string; t: number; op: string; id: number; name: string; key: string }>;
const loaf = await page.evaluate('window.__loaf') as Array<{ phase: string; start: number; dur: number; block: number; scripts: Array<{ inv: string; type: string; fn: string; url: string; dur: number }> }>;
await browser.close();

// Profile time (µs since its own start) → page time: Profiler.start landed between t0Page and t1Page.
const pageAt0 = (t0Page + t1Page) / 2;
const parent = new Map<number, number>();
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const label = (id: number) => { const f = byId.get(id)!.callFrame; return `${f.functionName || '(anon)'} ${f.url.replace(/^.*\/(src|deps)\//, '$1/').replace(/\?.*$/, '')}:${f.lineNumber + 1}`; };
const times: number[] = []; let acc = 0;
for (const d of profile.timeDeltas) { acc += d; times.push(pageAt0 + acc / 1000); }

const long = loaf.filter((e) => e.dur >= MIN_MS);
const report = long.map((e) => {
  const incl = new Map<string, number>(); const self = new Map<string, number>();
  for (let i = 0; i < profile.samples.length; i++) {
    if (times[i] < e.start || times[i] > e.start + e.dur) continue;
    const dt = (profile.timeDeltas[i + 1] ?? 500) / 1000;
    const leaf = profile.samples[i];
    self.set(label(leaf), (self.get(label(leaf)) ?? 0) + dt);
    const seen = new Set<string>();
    for (let id: number | undefined = leaf; id !== undefined; id = parent.get(id)) { const l = label(id); if (seen.has(l)) continue; seen.add(l); incl.set(l, (incl.get(l) ?? 0) + dt); }
  }
  const top = (m: Map<string, number>, n: number) => [...m.entries()].filter(([k]) => !/^\(root\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${v.toFixed(0).padStart(5)} ms  ${k}`);
  return { phase: e.phase, start: Math.round(e.start), dur: Math.round(e.dur), block: Math.round(e.block), scripts: e.scripts.filter((s) => s.dur > 5).map((s) => `${Math.round(s.dur)}ms ${s.type} ${s.inv} ${s.fn} ${s.url}`), self: top(self, 8), incl: top(incl, 18) };
});
for (const r of report) {
  console.log(`\n=== ${r.phase}  frame ${r.dur} ms (blocking ${r.block}) @${r.start}`);
  for (const s of r.scripts) console.log('  script', s);
  console.log('  self:'); for (const s of r.self) console.log('   ', s);
  console.log('  inclusive:'); for (const s of r.incl) console.log('   ', s);
}
const perPhase = new Map<string, { n: number; max: number }>();
for (const e of loaf) { const p = perPhase.get(e.phase) ?? { n: 0, max: 0 }; if (e.dur >= MIN_MS) p.n++; p.max = Math.max(p.max, e.dur); perPhase.set(e.phase, p); }
console.log('\nprogram churn:'); for (const p of progs) console.log(`  ${p.phase.padEnd(22)} ${p.op} #${p.id} ${p.name}  @${Math.round(p.t)}`);
console.log('\nlong frames per phase (>= ' + MIN_MS + ' ms):'); for (const [k, v] of perPhase) console.log(`  ${k.padEnd(22)} ${v.n}  max ${Math.round(v.max)} ms`);
mkdirSync(resolve(REPO, 'verification/perf'), { recursive: true });
const file = resolve(REPO, `verification/perf/hitch-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify({ stops: STOPS, minMs: MIN_MS, report, progs }, null, 1) + '\n');
console.log('wrote', file);
