/**
 * perf-profile — where the main thread's time and the browser's memory go
 * while the game runs (real GPU). Records a CDP CPU profile of N seconds of
 * running + turning outdoors, prints the top self-time functions (by source
 * file:function), and a per-process RSS breakdown of the launched Chromium
 * (browser / GPU / renderer), plus the renderer's JS heap and ArrayBuffer
 * external memory. Writes verification/perf/profile-<utc>.json.
 * Usage: npx tsx tools/perf-profile.ts [--secs 6] [--swiftshader]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO, adminCommand, enterWorld } from './lib/game-session.ts';
const args = process.argv.slice(2);
const SECS = Number(args[args.indexOf('--secs') + 1]) || 6;
const { browser, page } = await enterWorld({ gpu: !args.includes('--swiftshader') });
let done = false; page.on('console', (m) => { if (/Sent LoginComplete/.test(m.text())) done = true; });
await adminCommand(page, '@telepoi Holtburg'); for (let i = 0; i < 90 && !done; i++) await page.waitForTimeout(500); await page.waitForTimeout(5000);
const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
await page.mouse.click(780, 250);
await cdp.send('Profiler.start');
await page.keyboard.down('KeyW'); await page.keyboard.down('KeyD');
await page.waitForTimeout(SECS * 1000);
await page.keyboard.up('KeyD'); await page.keyboard.up('KeyW');
const { profile } = await cdp.send('Profiler.stop') as { profile: { nodes: Array<{ id: number; callFrame: { functionName: string; url: string; lineNumber: number } }>; samples: number[]; timeDeltas: number[] } };
const self = new Map<number, number>();
profile.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)));
const total = [...self.values()].reduce((a, b) => a + b, 0);
const byFn = new Map<string, number>();
for (const n of profile.nodes) {
  const t = self.get(n.id); if (!t) continue;
  const f = n.callFrame; const file = f.url.replace(/^.*\/(src|deps)\//, '$1/').replace(/\?.*$/, '');
  const key = `${f.functionName || '(anon)'}  ${file}:${f.lineNumber + 1}`;
  byFn.set(key, (byFn.get(key) ?? 0) + t);
}
const top = [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, t]) => ({ fn: k, pct: +(100 * t / total).toFixed(1) }));
const heap = await cdp.send('Runtime.getHeapUsage') as { usedSize: number; totalSize: number; embedderHeapUsedSize?: number; backingStorageSize?: number };
const procs = (() => { try {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,command='], { encoding: 'utf8' }).trim().split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)).filter((m): m is RegExpMatchArray => !!m);
  const pw = rows.filter((m) => /playwright_chromiumdev_profile|chromium-\d+\/chrome-mac/.test(m[4]) && /Chrom/.test(m[4]));
  return pw.map((m) => ({ type: (/--type=([a-z-]+)/.exec(m[4])?.[1] ?? 'browser'), rssMB: Math.round(Number(m[3]) / 1024) })).sort((a, b) => b.rssMB - a.rssMB).slice(0, 8);
} catch { return []; } })();
const out = { secs: SECS, top, heapMB: { used: +(heap.usedSize / 1048576).toFixed(0), total: +(heap.totalSize / 1048576).toFixed(0), backingStore: heap.backingStorageSize ? +(heap.backingStorageSize / 1048576).toFixed(0) : null }, processes: procs };
mkdirSync(resolve(REPO, 'verification/perf'), { recursive: true });
const file = resolve(REPO, `verification/perf/profile-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
console.log(JSON.stringify(out, null, 1)); console.log('wrote', file);
await browser.close();
