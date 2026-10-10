/**
 * probe-dat-streaming — RELEASE.dat-streaming / RELEASE.portal-space-cell-gate
 * live measurement (docs/dat-streaming.md §6).
 *
 * One persistent headless Chromium profile (SwiftShader is fine: this measures
 * bytes and wall time, not fps):
 *   1. cold: fresh profile (empty OPFS) → char select → in world; bytes + time at each
 *   2. teleports into uncached areas (Holtburg outdoors, the Holtburg dungeon):
 *      the portal-space gate must hold the tunnel, then the arrival must have
 *      its geometry
 *   3. warm: reload in the same profile (OPFS populated) → char select → in world
 * Bytes are the DatStore's own counters (window.__datStream.store.stats) and
 * the network's encoded body sizes for the DAT host.
 *
 * Usage (your own Vite + bridge; never the shared :9090 bridge or a public server):
 *   AC_BASE=http://localhost:3217/ AC_BRIDGE=ws://localhost:9096 AC_ACCOUNT=streamprobe1 \
 *     npx tsx tools/probe-dat-streaming.ts [--set <pointer url>] [--out verification/dat-streaming/live] [--gpu]
 *
 * --edge-bust: append a per-run query to every object URL so each fetch misses
 * Cloudflare's edge cache and goes to R2 (a new player in a quiet region). An
 * A/B between two builds is only fair with it: the first run warms the edge
 * for the second (RELEASE.streaming-gate-real-gpu-check, 2026-10-06).
 *
 * --gpu (or AC_GPU=1): the real GPU instead of SwiftShader. Gate timings are
 * only meaningful there; the gpu-worker's `dat-streaming` job runs this
 * (docs/gpu-worker.md). Each gate (hold → released) is recorded in result.json
 * `gates` and printed as one `gate: …` headline line.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { firstGateSince, gateHeadline, type GateSpan } from './lib/stream-gate.js';
import { AT_CHAR_SELECT_JS, DEFAULT_VIEWPORT, GPU_ARGS, REMOTE_CHROMIUM, IN_CHARGEN_JS, IN_WORLD_JS, SWIFTSHADER_ARGS, createCharacterIfNeeded, gameUrl } from './lib/game-session.js';

const argv = process.argv.slice(2);
const opt = (f: string, d: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
const SET = opt('--set', 'https://dats.playwebac.com/v1/sets/eol-p2072-c982-h497-l994.json');
const OUT = opt('--out', 'verification/dat-streaming/live');
const CHAR = process.env.AC_CHAR_NAME ?? 'Streamprobe';
const DAT_HOST = new URL(SET).host;
/** --raw: the whole-DAT path (no datSet) as the baseline for the same flow (time only; no warm pass). */
const RAW = argv.includes('--raw');
const GPU = argv.includes('--gpu') || process.env.AC_GPU === '1';
const EDGE_BUST = argv.includes('--edge-bust');
/** --req-log: write requests.json (each DAT request's start / end / TTFB / bytes) next to result.json. */
const REQ_LOG = argv.includes('--req-log');
/** --throttle-mbps N: emulate an N Mbit/s connection for every page (0 = off). */
const THROTTLE_MBPS = Number(opt('--throttle-mbps', '0'));
const requests: Array<{ label: string; path: string; start: number; end: number; ttfb: number; bytes: number }> = [];

interface Mark {
  ms: number; netBytes: number; netObjects: number; cacheBytes: number; cacheObjects: number; misses: number; wireBytes: number;
  /** DatStore residency (RELEASE.streaming-memory-and-progress): payload bytes held, of which LRU (leaves + bundles). */
  residentBytes: number; evictableBytes: number; evictions: number;
  /** Whether the world + terrain packs were resident at this mark (they load behind char select). */
  worldPacks: boolean;
}

async function stats(page: Page): Promise<Omit<Mark, 'ms' | 'wireBytes'>> {
  return (await page.evaluate(`(() => { const d = window.__datStream; const s = d && d.store.stats;
    return s ? { netBytes: s.netBytes, netObjects: s.netObjects, cacheBytes: s.cacheBytes, cacheObjects: s.cacheObjects, misses: s.misses,
      residentBytes: s.residentBytes, evictableBytes: s.evictableBytes, evictions: s.evictions, worldPacks: !!d.worldPacksResident() } : null; })()`)) as Omit<Mark, 'ms' | 'wireBytes'>
    ?? { netBytes: 0, netObjects: 0, cacheBytes: 0, cacheObjects: 0, misses: 0, residentBytes: 0, evictableBytes: 0, evictions: 0, worldPacks: false };
}

async function isTrue(page: Page, js: string): Promise<boolean> {
  return !!(await page.evaluate(js).catch(() => false));
}

async function session(label: string, ctx: Awaited<ReturnType<typeof chromium.launchPersistentContext>>, url: string) {
  const page = await ctx.newPage();
  page.setDefaultTimeout(180_000);
  // --throttle-mbps N: a player on an N Mbit/s line (Chrome network emulation, 40 ms added latency).
  if (THROTTLE_MBPS > 0) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 40, downloadThroughput: THROTTLE_MBPS * 125_000, uploadThroughput: Math.max(1, THROTTLE_MBPS / 4) * 125_000 });
  }
  const lines: string[] = [];
  page.on('console', (m) => {
    const t = m.text();
    if (/DatStream|portal-space gate|Dungeon stream|Teleport →|Game started|DatCache|failed/i.test(t)) { lines.push(`${Date.now()} ${t}`); console.log(`  [${label}] ${t.slice(0, 220)}`); }
  });
  let wireBytes = 0;
  page.on('requestfinished', (req) => {
    if (new URL(req.url()).host !== DAT_HOST) return;
    req.sizes().then((s) => {
      wireBytes += s.responseBodySize;
      // --req-log: every DAT request's wall-clock span, to find a gate's critical path.
      if (REQ_LOG) { const t = req.timing(); requests.push({ label, path: new URL(req.url()).pathname, start: t.startTime, end: t.startTime + t.responseEnd, ttfb: t.responseStart, bytes: s.responseBodySize }); }
    }).catch(() => {});
  });
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const mark = async (): Promise<Mark> => ({ ms: Date.now() - t0, ...(await stats(page)), wireBytes });
  let charSelect: Mark | null = null;
  let world: Mark | null = null;
  const create = createCharacterIfNeeded(CHAR);
  while (Date.now() - t0 < 600_000) {
    if (!charSelect && ((await isTrue(page, AT_CHAR_SELECT_JS)) || (await isTrue(page, IN_CHARGEN_JS)))) {
      charSelect = await mark();
      // What boot awaited before the character screen (the rest of the bytes above, if any, are the world packs landing behind it).
      const boot = await page.evaluate('window.__datStream && window.__datStream.bootReport').catch(() => null) as { netBytes: number; netObjects: number; cacheBytes: number; ms: number } | null;
      (charSelect as Mark & { boot?: unknown }).boot = boot;
      console.log(`  [${label}] char select at ${charSelect.ms} ms, DAT net ${(charSelect.netBytes / 1048576).toFixed(2)} MB / ${charSelect.netObjects} objects, cache ${(charSelect.cacheBytes / 1048576).toFixed(2)} MB, misses ${charSelect.misses}, world packs ${charSelect.worldPacks ? 'resident' : 'still loading'}`
        + (boot ? `; boot awaited ${(boot.netBytes / 1048576).toFixed(2)} MB net / ${boot.netObjects} objects + ${(boot.cacheBytes / 1048576).toFixed(2)} MB cache in ${boot.ms} ms${(boot as { worldCached?: boolean }).worldCached ? ' (warm: world packs included)' : ''}` : ''));
    }
    await create(page).catch(() => {});
    if (await isTrue(page, IN_WORLD_JS)) { world = await mark(); break; }
    await page.waitForTimeout(250);
  }
  if (world) console.log(`  [${label}] in world at ${world.ms} ms, DAT net ${(world.netBytes / 1048576).toFixed(2)} MB / ${world.netObjects} objects, cache ${(world.cacheBytes / 1048576).toFixed(2)} MB, misses ${world.misses}, resident ${(world.residentBytes / 1048576).toFixed(1)} MB (LRU ${(world.evictableBytes / 1048576).toFixed(1)} MB, ${world.evictions} evictions)`);
  if (world) console.log(`  [${label}] misses by type: ${JSON.stringify(await page.evaluate('window.__datStream.store.stats.missesByType').catch(() => null))}`);
  return { page, charSelect, world, lines, mark };
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'acjs-stream-probe-'));
  const ctx = await chromium.launchPersistentContext(profile, { headless: true, viewport: DEFAULT_VIEWPORT,
    ...(GPU ? { channel: 'chromium', args: GPU_ARGS } : { args: SWIFTSHADER_ARGS,
      // Cloud containers: the remote Chromium build.
      ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}) }),
    // Cloud containers: the agent proxy for the DAT host.
    ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } } : {}) });
  if (EDGE_BUST) {
    const tag = `edgebust${Date.now().toString(36)}`;
    await ctx.route((u) => u.host === DAT_HOST && u.pathname.startsWith('/v1/o/'), (route) => route.continue({ url: `${route.request().url()}?${tag}` }));
  }
  const url = RAW ? `${gameUrl({ cb: 'dat-raw' })}&nocache` : `${gameUrl({ cb: 'dat-stream' })}&datSet=${encodeURIComponent(SET)}`;
  console.log(`probe: ${url}`);
  const result: Record<string, unknown> = { set: SET, url, date: new Date().toISOString(), gpu: GPU, edgeBust: EDGE_BUST };
  const gates: Array<[string, GateSpan | null]> = [];

  // 1. cold
  const cold = await session('cold', ctx, url);
  result.cold = { charSelect: cold.charSelect, world: cold.world };
  if (!cold.world) throw new Error('cold session never entered the world');
  result.renderer = await cold.page.evaluate(`(() => { const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info'); return gl ? gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) : null; })()`).catch(() => null);
  gates.push(['cold', firstGateSince(cold.lines, 0)]);
  await cold.page.waitForTimeout(8000);
  await cold.page.screenshot({ path: `${OUT}/cold-in-world.png` });
  result.coldSettled = await cold.mark();

  // 2. teleports into uncached areas (@teleloc; probe accounts are admin on
  //    the local ACE): Holtburg outdoors, then the Holtburg dungeon's drop cell.
  const teleports: Record<string, unknown> = {};
  // Destinations (--teleports a,b; default: the first two that are not the login landblock's).
  const ALL = {
    'holtburg': '@teleloc 0xA9B40019 [85.0 20.5 94.0] 1 0 0 0',
    'holtburg-dungeon': '@teleloc 0x01F60289 [96.7 -10.0 0.0] -0.719279 0 0 -0.694721',
    'shoushi': '@teleloc 0xDA55001D [84.8 99.0 20.0] 1 0 0 0',
  } as const;
  const loginCell = cold.lines.map((l) => /gate: holding for cell 0x([0-9a-f]{8})/.exec(l)?.[1]).find(Boolean)
    ?? (opt('--login-cell', '').replace(/^0x/, '').toLowerCase());
  const names = (opt('--teleports', '') ? opt('--teleports', '').split(',') : Object.keys(ALL)) as Array<keyof typeof ALL>;
  // --teleloc <label>=<@teleloc command>: one more destination of your own (e.g. a server's custom academy).
  const extra = opt('--teleloc', '');
  const custom = extra.includes('=') ? [[extra.slice(0, extra.indexOf('=')), 0, extra.slice(extra.indexOf('=') + 1)] as const] : [];
  const destinations = [...custom, ...names.filter((n) => !ALL[n].toLowerCase().includes(loginCell.slice(0, 4))).slice(0, 2).map((n) => [n, 0, ALL[n]] as const)];
  for (const [label, , cmd] of destinations) {
    const before = await cold.mark();
    const tpStart = Date.now();
    const tunnel: Array<{ ms: number; state: number; covering: boolean }> = [];
    await cold.page.evaluate(`window.acDebug.sendChat(${JSON.stringify(cmd)})`);
    let held: string | null = null;
    let resident: string | null = null;
    const after0 = (l: string) => Number(l.split(' ')[0]) >= tpStart;
    while (Date.now() - tpStart < 90_000) {
      const st = await cold.page.evaluate('({ state: window.__ac.gameUI.portalSpaceState, covering: window.__ac.gameUI.portalSpaceCovering })').catch(() => null) as { state: number; covering: boolean } | null;
      if (st) tunnel.push({ ms: Date.now() - tpStart, ...st });
      if (!held) {
        held = cold.lines.find((l) => /portal-space gate: holding/.test(l) && after0(l)) ?? null;
        // The tunnel mid-hold, with the power bar's "Download: done / total" (RuntimeDDDStatus).
        if (held) await cold.page.waitForTimeout(400).then(() => cold.page.screenshot({ path: `${OUT}/teleport-${label}-held.png` })).catch(() => {});
      }
      resident ??= cold.lines.find((l) => /portal-space gate: (resident|gave up)/.test(l) && after0(l)) ?? null;
      const arrived = cold.lines.some((l) => /Teleport →|Dungeon stream started/.test(l) && after0(l));
      if ((resident || arrived) && st && st.state === 0 && tunnel.some((t) => t.state !== 0)) break;
      await cold.page.waitForTimeout(150);
    }
    await cold.page.waitForTimeout(6000);
    await cold.page.screenshot({ path: `${OUT}/teleport-${label}.png` });
    const after = await cold.mark();
    const scene = await cold.page.evaluate(`(() => { const s = window.__ac.sceneManager.scene; let meshes = 0; s.traverse((o) => { if (o.isMesh || o.isInstancedMesh) meshes++; });
      const c = window.acDebug.collisionState(); return { meshes, x: Math.round(c.x), z: Math.round(c.z) }; })()`).catch((e) => String(e));
    const chat = await cold.page.evaluate(`(() => { const c = document.getElementById('chat-messages'); return c ? [...c.children].slice(-4).map((e) => (e.textContent || '').trim()) : []; })()`).catch(() => []);
    const covered = tunnel.filter((t) => t.state !== 0);
    const gate = firstGateSince(cold.lines, tpStart);
    gates.push([label, gate]);
    teleports[label] = {
      cmd, heldLine: held, residentLine: resident, gate,
      tunnelFirstMs: covered[0]?.ms ?? null, tunnelLastMs: covered[covered.length - 1]?.ms ?? null,
      netBytes: after.netBytes - before.netBytes, netObjects: after.netObjects - before.netObjects, misses: after.misses - before.misses,
      scene, chat,
    };
    console.log(`teleport ${label}: ${JSON.stringify(teleports[label])}`);
  }
  result.teleports = teleports;
  result.missesByType = await cold.page.evaluate('window.__datStream.store.stats.missesByType').catch(() => null);
  console.log(`misses by type: ${JSON.stringify(result.missesByType)}`);
  await cold.page.close();

  const finish = () => {
    result.gates = Object.fromEntries(gates);
    result.headline = gateHeadline(gates);
    console.log(`${result.headline}  [${GPU ? 'gpu' : 'swiftshader'}: ${result.renderer ?? '?'}]`);
  };
  if (RAW) { finish(); await ctx.close(); writeFileSync(`${OUT}/result.json`, JSON.stringify(result, null, 2) + '\n'); console.log(`wrote ${OUT}/result.json`); return; }
  // 3. warm: same profile (OPFS populated).
  await new Promise((r) => setTimeout(r, 8000)); // ACE's logout save
  const warm = await session('warm', ctx, url);
  result.warm = { charSelect: warm.charSelect, world: warm.world };
  gates.push(['warm', firstGateSince(warm.lines, 0)]);
  if (warm.world) {
    await warm.page.waitForTimeout(5000);
    await warm.page.screenshot({ path: `${OUT}/warm-in-world.png` });
  }
  await warm.page.close();
  await ctx.close();
  finish();
  if (REQ_LOG) writeFileSync(`${OUT}/requests.json`, JSON.stringify(requests) + "\n");
  writeFileSync(`${OUT}/result.json`, JSON.stringify(result, null, 2) + '\n');
  console.log(`wrote ${OUT}/result.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
