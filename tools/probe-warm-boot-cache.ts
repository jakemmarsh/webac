/**
 * probe-warm-boot-cache — PERF.cache-read-slower-than-network: how long a
 * streamed boot takes from the OPFS object cache (warm) against downloading
 * the same set (cold), under the conditions players hit.
 *
 * One per-run headless Chromium profile (createRunProfile; deleted at exit):
 *   cold          fresh profile: downloads the set and fills the object cache
 *   warm          reload: everything from the cache
 *   warm-cpuN     reload with CDP CPU throttling N× (--cpu N, default 6)
 *   warm-slowdisk reload with the object cache's reads delayed (?cacheReadDelayMs=…,
 *                 dev only: a stand-in for a disk that takes seconds per object,
 *                 like the 4 GB Windows laptop of 2026-11-04 whose 24 MB world
 *                 pack read took 19 s)
 *   warm-slowdisk-nohedge  the same with the hedge off (?noCacheHedge: the store before the fix)
 *   warm-slowdisk-net      the stalled disk on a --mbps link (the hedge's download is throttled too)
 *   net           ?nocache at --mbps (default 20) Mbit/s: the same bytes from the network
 * Each run prints the boot's own line (`[AC:DatStream] set …: phases {…}`):
 * total ms, worldCacheMs, cacheReadMs / cacheReadMaxMs, and (after the fix)
 * the hedged reads.
 *
 * Usage (your own Vite; no bridge is needed, the boot ends at the launcher):
 *   AC_BASE=http://localhost:3391/ npx tsx tools/probe-warm-boot-cache.ts [--set <pointer>] [--runs cold,warm,warm-cpu,warm-slowdisk,net]
 *     [--cpu 6] [--mbps 20] [--disk-delay-ms 15000] [--disk-min-bytes 1048576]
 */
import { chromium, type BrowserContext } from 'playwright';
import { createRunProfile } from './lib/temp-profile.js';

const argv = process.argv.slice(2);
const opt = (f: string, d: string): string => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
const BASE = process.env.AC_BASE ?? 'http://localhost:3391/';
const SET = opt('--set', 'https://dats.playwebac.com/v1/sets/eol-p2072-c982-h497-l994.json');
const RUNS = opt('--runs', 'cold,warm,warm-cpu,warm-slowdisk,net').split(',');
const CPU = Number(opt('--cpu', '6'));
const MBPS = Number(opt('--mbps', '20'));
const DISK_DELAY_MS = Number(opt('--disk-delay-ms', '15000'));
/** --disk-min-bytes B: only reads of B bytes or more stall (10000000: just the 18.6 MB worldLand pack, as 2026-11-04). */
const DISK_MIN = `&cacheReadDelayMinBytes=${Number(opt('--disk-min-bytes', String(1 << 20)))}`;

async function boot(ctx: BrowserContext, label: string, query: string, setup?: (cdp: import('playwright').CDPSession) => Promise<void>): Promise<void> {
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  if (setup) await setup(cdp);
  const t0 = Date.now();
  const line = new Promise<string>((resolve) => {
    page.on('console', (m) => { const t = m.text(); if (t.startsWith('[AC:DatStream] set ')) resolve(t); });
  });
  await page.goto(`${BASE}?datSet=${encodeURIComponent(SET)}${query}`);
  const got = await Promise.race([line, new Promise<string>((r) => setTimeout(() => r('TIMEOUT'), 240_000))]);
  const wall = Date.now() - t0;
  const m = /resident in (\d+) ms.*?(?:in (\d+) ms \(warm profile\)|continue in the background); phases (\{.*\})/.exec(got);
  const phases = m ? JSON.parse(m[3]) as Record<string, number> : {};
  // Wait for the world packs too on a cold / network boot (what the warm boot awaits before resolving).
  const worldMs = await page.evaluate(`(async () => { const t = performance.now(); const d = window.__datStream; if (d) await d.worldPacks.catch(() => {}); return Math.round(performance.now()); })()`).catch(() => -1);
  const pick = (k: string): string => (phases[k] !== undefined ? `${k}=${phases[k]}` : '');
  console.log(`${label.padEnd(14)} boot=${m?.[1] ?? '?'}ms worldCache=${m?.[2] ?? '-'}ms worldPacksAt=${worldMs}ms wall=${wall}ms ${['cacheReadMs', 'cacheReadMaxMs', 'cacheMisses', 'hedges', 'hedgeWins', 'inflateMs', 'dirMs'].map(pick).filter(Boolean).join(' ')}`);
  if (got === 'TIMEOUT') console.log('  (no boot line in 240 s)');
  if (process.env.PROBE_VERBOSE) console.log('  ' + got);
  // Let the object cache's writes of what this boot downloaded land before the page goes (a player stays on the page).
  await page.waitForTimeout(Number(process.env.PROBE_SETTLE_MS ?? 8000));
  await page.close();
}

async function main(): Promise<void> {
  const profile = createRunProfile('probe-warm-boot-cache');
  const ctx = await chromium.launchPersistentContext(profile.dir, { headless: true, channel: 'chromium', viewport: { width: 1280, height: 800 } });
  profile.setCloser(() => ctx.close());
  try {
    for (const run of RUNS) {
      if (run === 'cold' || run === 'warm') await boot(ctx, run, '');
      else if (run === 'warm-cpu') await boot(ctx, `warm-cpu${CPU}x`, '', (cdp) => cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU }).then(() => undefined));
      else if (run === 'warm-slowdisk') await boot(ctx, 'warm-slowdisk', `&cacheReadDelayMs=${DISK_DELAY_MS}${DISK_MIN}`);
      // The same stalled disk with the hedge off (the store before PERF.cache-read-slower-than-network).
      else if (run === 'warm-slowdisk-nohedge') await boot(ctx, 'slowdisk-nohedge', `&cacheReadDelayMs=${DISK_DELAY_MS}${DISK_MIN}&noCacheHedge`);
      else if (run === 'warm-slowdisk-net') {
        await boot(ctx, `slowdisk-${MBPS}mbps`, `&cacheReadDelayMs=${DISK_DELAY_MS}${DISK_MIN}`, async (cdp) => {
          await cdp.send('Network.enable');
          await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 40, downloadThroughput: MBPS * 125_000, uploadThroughput: MBPS * 31_250 });
        });
      }
      else if (run === 'net') {
        await boot(ctx, `net${MBPS}mbps`, '&nocache&noCacheHedge', async (cdp) => {
          await cdp.send('Network.enable');
          await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 40, downloadThroughput: MBPS * 125_000, uploadThroughput: MBPS * 31_250 });
        });
      }
    }
  } finally {
    await profile.dispose();
  }
}

void main();
