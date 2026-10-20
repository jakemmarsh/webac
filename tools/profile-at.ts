/**
 * CPU-profile the client standing at a place: logs in (URL login, dev Vite),
 * enters the world, optionally runs a chat command to get there (an admin's
 * `@teleto Arwic`), waits for the area to load, then records a CDP CPU
 * profile and the frame intervals for --seconds, and prints the frame
 * stats and the top functions by self time.
 *
 *   npx tsx tools/profile-at.ts --url 'http://localhost:<vite>/?ace&bridge=ws://localhost:9090&account=…&password=…&datSet=<prod set>' \
 *     --cmd '@teleto Arwic' [--settle 25] [--seconds 20] [--top 30] [--out dir]
 *
 * Real GPU (Playwright's chromium channel, ANGLE Metal on macOS). Writes the
 * raw .cpuprofile to --out for Chrome DevTools' Performance panel.
 * Used for PERF.slow-first-minute-diagnostics (2026-10-20).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createRunProfile } from './lib/temp-profile.js';
import { GPU_ARGS, DEFAULT_VIEWPORT } from './lib/game-session.js';

const args = process.argv.slice(2);
const opt = (n: string, d = ''): string => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] ?? d : d; };
const url = opt('url');
const cmd = opt('cmd');
const settle = Number(opt('settle', '25'));
const seconds = Number(opt('seconds', '20'));
const top = Number(opt('top', '30'));
const out = opt('out', '.');
const cpuThrottle = Number(opt('cpu-throttle', '0'));
const netKbps = Number(opt('net-kbps', '0'));
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
if (!url) { console.error('--url required'); process.exit(2); }

const profile = createRunProfile('profile-at-', { tool: 'profile-at' });
const ctx = await chromium.launchPersistentContext(profile.dir, { headless: true, channel: 'chromium', args: GPU_ARGS, viewport: { ...DEFAULT_VIEWPORT } });
profile.setCloser(() => ctx.close());
try {
  const page = ctx.pages()[0] ?? await ctx.newPage();
  page.on('console', (m) => { const t = m.text(); if ((/error|Error/.test(t) && !/favicon/.test(t)) || /gate|could not be downloaded|portal space|Entering world|PlayerCreate/i.test(t)) console.log('[page ' + stamp() + ']', t.slice(0, 160)); });
  // A slow link: from the first request (cold profile), or with --throttle-after-entry once in the world.
  const throttle = async () => {
    const ncdp = await ctx.newCDPSession(page);
    await ncdp.send('Network.enable');
    await ncdp.send('Network.emulateNetworkConditions', { offline: false, latency: 80, downloadThroughput: netKbps * 1024, uploadThroughput: 64 * 1024 });
    console.log('network throttle ' + netKbps + ' KB/s at', stamp());
  };
  const throttleAfterEntry = args.includes('--throttle-after-entry');
  if (netKbps > 0 && !throttleAfterEntry) await throttle();
  await page.goto(url, { waitUntil: 'commit', timeout: 120_000 });
  await page.waitForFunction(() => (window as unknown as { __ac?: { gameUI?: { uiManager?: { currentScreen?: string } } } }).__ac?.gameUI?.uiManager?.currentScreen === 'game', null, { timeout: 900_000, polling: 1000 });
  console.log('in game at', stamp());
  const renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl!.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });
  console.log('renderer:', renderer);
  if (!args.includes('--from-entry')) await page.waitForTimeout(8000);
  const preWait = Number(opt('pre-wait', '0'));
  if (preWait > 0) await page.waitForTimeout(preWait * 1000);
  if (netKbps > 0 && throttleAfterEntry) await throttle();
  if (cmd) {
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await page.keyboard.type(cmd, { delay: 20 });
    await page.keyboard.press('Enter');
    console.log('sent:', cmd, 'at', stamp());
  }
  // During the settle: when portal space ends, and whether the data-failed notice shows.
  for (let i = 0, wasCovering = null as null | boolean, failed = false; i < settle; i++) {
    const st = await page.evaluate(`(() => { const g = window.__ac?.gameUI; return { covering: !!g?.portalSpaceCovering, failed: document.body.innerText.includes('could not be downloaded') }; })()`) as { covering: boolean; failed: boolean };
    if (st.covering !== wasCovering) { console.log('portal space ' + (st.covering ? 'covering' : 'clear') + ' at', stamp()); wasCovering = st.covering; }
    if (st.failed && !failed) { console.log('DATA-FAILED notice at', stamp()); failed = true; }
    await page.waitForTimeout(1000);
  }

  // A string, not a function: tsx's __name helper does not exist in the page.
  await page.evaluate(`(() => {
    window.__pf = []; window.__pfOn = true;
    let last = performance.now();
    const tick = (t) => { window.__pf.push(t - last); last = t; if (window.__pfOn) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  })()`);
  const cdp = await ctx.newCDPSession(page);
  if (cpuThrottle > 1) { await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle }); console.log('cpu throttle x' + cpuThrottle); }
  // The world buffer's pixel ratio (canvas.width / CSS width) over time: dynamic resolution's steps.
  await page.evaluate(`(() => { window.__rs = []; const c = [...document.querySelectorAll('canvas')].sort((a,b)=>b.width*b.height-a.width*a.height)[0];
    const t0 = performance.now(); window.__rsT = setInterval(() => window.__rs.push([Math.round((performance.now()-t0)/1000), +(c.width / c.clientWidth).toFixed(2)]), 2000); })()`);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  await cdp.send('Profiler.start');
  await page.waitForTimeout(seconds * 1000);
  const { profile: prof } = await cdp.send('Profiler.stop') as { profile: { nodes: Array<{ id: number; callFrame: { functionName: string; url: string; lineNumber: number }; hitCount?: number; children?: number[] }>; samples: number[]; timeDeltas: number[]; startTime: number; endTime: number } };
  const frames = await page.evaluate('(() => { window.__pfOn = false; return window.__pf; })()') as number[];

  const rs = await page.evaluate('(() => { clearInterval(window.__rsT); return window.__rs; })()') as Array<[number, number]>;
  console.log('pixel ratio over time (s:ratio):', rs.map(([t, r]) => `${t}:${r}`).join(' '));
  mkdirSync(out, { recursive: true });
  const shot = join(out, `profile-${Date.now()}.png`);
  await page.screenshot({ path: shot });
  console.log('screenshot:', shot);
  const file = join(out, `profile-${Date.now()}.cpuprofile`);
  writeFileSync(file, JSON.stringify(prof));

  const s = [...frames].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]?.toFixed(1);
  console.log(`frames: ${frames.length} in ${seconds}s (${(frames.length / seconds).toFixed(1)} fps)  median ${q(0.5)} ms  p95 ${q(0.95)} ms  max ${s[s.length - 1]?.toFixed(0)} ms`);

  // Self time per function (sample count × mean interval).
  const totalUs = prof.endTime - prof.startTime;
  const byId = new Map(prof.nodes.map((n) => [n.id, n]));
  const hits = new Map<number, number>();
  for (const id of prof.samples) hits.set(id, (hits.get(id) ?? 0) + 1);
  const usPerSample = totalUs / Math.max(1, prof.samples.length);
  const agg = new Map<string, number>();
  for (const [id, n] of hits) {
    const node = byId.get(id)!; const cf = node.callFrame;
    const key = `${cf.functionName || '(anonymous)'}  ${cf.url.replace(/^.*\/src\//, 'src/').replace(/\?.*$/, '')}:${cf.lineNumber + 1}`;
    agg.set(key, (agg.get(key) ?? 0) + n * usPerSample);
  }
  const idle = [...agg].filter(([k]) => /^\((idle|program|garbage collector)\)/.test(k)).map(([k, v]) => `${k.split(' ')[0]} ${(v / 1000).toFixed(0)}ms`).join('  ');
  console.log(`profile ${(totalUs / 1e6).toFixed(1)} s; ${idle}`);
  console.log(`top ${top} by self time:`);
  for (const [k, v] of [...agg].filter(([k]) => !/^\((idle|program|garbage collector)\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, top)) {
    console.log(`${(v / 1000).toFixed(0).padStart(7)} ms  ${(100 * v / totalUs).toFixed(1).padStart(5)}%  ${k}`);
  }
  console.log('cpuprofile:', file);
} finally {
  await profile.dispose();
}
