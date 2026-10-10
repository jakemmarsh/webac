/**
 * measure-bandwidth — per-player bridge bandwidth in a quiet and a busy scene
 * (RELEASE.bandwidth-busy-town), to budget the hosted bridge's egress.
 *
 *   npx tsx tools/measure-bandwidth.ts --bridge ws://localhost:9093 [--base http://localhost:3077/]
 *       [--idle 60] [--busy 180] [--gpu] acct1 acct2 …
 *
 * --base must be the Vite dev server or a VITE_ACJS_URL_OVERRIDES=1 build
 * (`VITE_ACJS_URL_OVERRIDES=1 npx vite build --outDir <dir>` + `vite preview`):
 * the clients log in from the URL, which a deployed build ignores
 * (packages/renderer/src/config/urlOverrides.ts).
 * Use a bridge of your own (any port) pinned to the local ACE, so its
 * /metrics counters see only these clients:
 *   npx tsx services/ws-tcp-bridge/src/bridge.ts 9093 127.0.0.1 9000 9001
 * The accounts must be admin accounts with a character (password = account
 * name): every client @telepoi's to Holtburg; the first spawns monsters and
 * @smite all's them at the end. Don't run it during a screen regression
 * (its scenes are in Holtburg).
 *
 * Phases: idle (everyone standing in Holtburg), then busy (20 wandering and
 * 6 aggressive drudges spawned, every client walking a loop and talking
 * every 10 s). For each phase it reads the bridge's byte counters
 * (ws_in browser→bridge, udp_out bridge→server, udp_in server→bridge,
 * ws_out bridge→browser) before and after and prints bytes/s per player
 * and the hosting egress (udp_out + ws_out) per player-hour.
 */
import { launchBrowser, waitForWorld } from './lib/game-session.ts';
import type { Page } from 'playwright';

const argv = process.argv.slice(2);
const flag = (name: string, dflt: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const BRIDGE = flag('--bridge', 'ws://localhost:9093');
const BASE = flag('--base', 'http://localhost:3077/');
const IDLE_S = Number(flag('--idle', '60'));
const BUSY_S = Number(flag('--busy', '180'));
const GPU = argv.includes('--gpu');
const accounts = argv.filter((a, i) => !a.startsWith('--') && !['--bridge', '--base', '--idle', '--busy'].includes(argv[i - 1]));
if (accounts.length === 0) { console.error('usage: measure-bandwidth.ts --bridge ws://… acct1 acct2 …'); process.exit(2); }

const metricsUrl = BRIDGE.replace(/^ws/, 'http').replace(/\/connect.*$/, '').replace(/\/$/, '') + '/metrics?format=json';
type Bytes = { ws_in: number; udp_out: number; udp_in: number; ws_out: number };
async function bytes(): Promise<Bytes> { return ((await (await fetch(metricsUrl)).json()) as { bytes: Bytes }).bytes; }
const log = (s: string) => console.log(`[bw ${new Date().toISOString().slice(11, 19)}] ${s}`);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const say = (page: Page, text: string) => page.evaluate((t) => (window as unknown as { acDebug: { sendChat(t: string): void } }).acDebug.sendChat(t), text);

function report(name: string, before: Bytes, after: Bytes, seconds: number, players: number) {
  const d = (k: keyof Bytes) => (after[k] - before[k]) / seconds / players;
  const egress = d('udp_out') + d('ws_out');
  log(`${name}: per player ${(d('ws_out') / 1024).toFixed(2)} KB/s to browser, ${(d('ws_in') / 1024).toFixed(2)} KB/s from browser; `
    + `egress ${(egress / 1024).toFixed(2)} KB/s = ${(egress * 3600 / 1024 / 1024).toFixed(1)} MB per player-hour`);
  return { phase: name, seconds, players, perPlayerBytesPerSec: { toBrowser: d('ws_out'), fromBrowser: d('ws_in'), egress } };
}

const browser = await launchBrowser({ gpu: GPU });
const pages: Page[] = [];
try {
  for (const acct of accounts) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(`${BASE}?debug&ace&bridge=${encodeURIComponent(BRIDGE)}&account=${acct}&password=${acct}`);
    if (!(await waitForWorld(page, { timeoutMs: 240_000 }))) throw new Error(`${acct}: never reached the world`);
    log(`${acct} in world`);
    await say(page, '@telepoi holtburg');
    pages.push(page);
  }
  await sleep(20_000);

  const results = [];
  let b0 = await bytes();
  await sleep(IDLE_S * 1000);
  let b1 = await bytes();
  results.push(report('idle (Holtburg, standing)', b0, b1, IDLE_S, pages.length));

  await say(pages[0], '@create drudgeskulker-noaggro 20');
  await say(pages[0], '@create drudgeskulker 6');
  b0 = await bytes();
  const t0 = Date.now();
  let tick = 0;
  while (Date.now() - t0 < BUSY_S * 1000) {
    await Promise.all(pages.map(async (page, i) => {
      await page.keyboard.down('w');
      await sleep(1500 + i * 200);
      await page.keyboard.up('w');
      await page.keyboard.down(i % 2 ? 'a' : 'd');
      await sleep(400);
      await page.keyboard.up(i % 2 ? 'a' : 'd');
      if (tick % 4 === i % 4) await say(page, `bandwidth probe ${tick}`);
    }));
    tick++;
  }
  b1 = await bytes();
  results.push(report('busy (26 drudges, all walking + chatting)', b0, b1, (Date.now() - t0) / 1000, pages.length));
  console.log(JSON.stringify({ bridge: BRIDGE, players: pages.length, results }, null, 2));
} finally {
  // Leave Holtburg as we found it: kill the spawned drudges (ACE @smite all, in range).
  if (pages[0]) await say(pages[0], '@smite all').catch(() => {});
  await sleep(2000);
  await browser.close();
}
