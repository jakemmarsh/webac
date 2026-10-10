/**
 * Drive a real game page step by step from the shell, the way a player
 * would: a long-lived browser (persistent profile, so OPFS caches survive
 * era reloads like a player's) behind a tiny localhost control server.
 * Built for playing a deployed page (https://playwebac.com), where URL login
 * and ?agent are off: you log in through the launcher with clicks and keys.
 *
 *   npx tsx tools/live-drive.ts serve [--url https://playwebac.com/] [--gpu] [--out dir] [--port 9477] [--throttle kbit/s]
 *   npx tsx tools/live-drive.ts shot [name]            → prints the PNG path
 *   npx tsx tools/live-drive.ts click <x> <y> [right|double]
 *   npx tsx tools/live-drive.ts drag <x0> <y0> <x1> <y1>
 *   npx tsx tools/live-drive.ts key <Key> [holdMs]     (Playwright key names: w, Enter, F2, Shift+Tab…)
 *   npx tsx tools/live-drive.ts type <text>
 *   npx tsx tools/live-drive.ts eval <js>              (page.evaluate; result JSON-stringified)
 *   npx tsx tools/live-drive.ts fill <css selector> <text>
 *   npx tsx tools/live-drive.ts objects               (the client server-object table via CDP; works on production)
 *   npx tsx tools/live-drive.ts goto <url>
 *   npx tsx tools/live-drive.ts log [pattern] [n]      (last n console lines, regex-filtered)
 *   npx tsx tools/live-drive.ts stop
 *
 * window.__ldLongTasks lists main-thread long tasks (≥ 50 ms) since the page started.
 *
 * One live session at a time (CLAUDE.md machine safety): `serve` refuses to
 * start when its port is taken. The console log is <out>/console.log.
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { GPU_ARGS, SWIFTSHADER_ARGS, DEFAULT_VIEWPORT, REMOTE_CHROMIUM } from './lib/game-session.js';

const args = process.argv.slice(2);
const opt = (name: string, dflt: string): string => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] ?? dflt : dflt; };
const port = Number(opt('port', process.env.LIVE_DRIVE_PORT ?? '9477'));

async function serve(): Promise<void> {
  const url = opt('url', 'https://playwebac.com/');
  const out = opt('out', mkdtempSync(join(tmpdir(), 'live-drive-')));
  mkdirSync(out, { recursive: true });
  const LOG = join(out, 'console.log');
  const gpu = args.includes('--gpu');
  const profile = mkdtempSync(join(tmpdir(), 'live-drive-profile-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: true,
    // The cloud container's preinstalled Chromium (the game-session recipe); Playwright's own may be absent.
    ...(gpu ? { channel: 'chromium', args: GPU_ARGS } : { args: SWIFTSHADER_ARGS, ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}) }),
    viewport: { ...DEFAULT_VIEWPORT },
  });
  // Long tasks (main-thread stalls ≥ 50 ms) from the first script on: window.__ldLongTasks, read with
  // eval, e.g. to tell a network wait from a blocked main thread next to performance resource timings.
  await ctx.addInitScript(() => {
    const w = window as unknown as { __ldLongTasks: Array<{ start: number; dur: number }> };
    w.__ldLongTasks = [];
    try { performance.setResourceTimingBufferSize(20000); } catch { /* ignore */ }
    try {
      new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__ldLongTasks.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) }); })
        .observe({ type: 'longtask', buffered: true });
    } catch { /* no longtask support */ }
  });
  const page: Page = ctx.pages()[0] ?? await ctx.newPage();
  page.setDefaultTimeout(60_000);
  // --throttle <kbit/s>: Chrome's network emulation (both directions, 40 ms latency), e.g. to reproduce
  // a slow first visit where the streamed DATs and the boot's own reads share a thin link.
  const throttle = Number(opt('throttle', '0'));
  if (throttle > 0) {
    const cdp = await ctx.newCDPSession(page);
    const bps = (throttle * 1000) / 8;
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 40, downloadThroughput: bps, uploadThroughput: bps });
  }
  page.on('dialog', (d) => void d.dismiss());
  page.on('console', (m) => appendFileSync(LOG, `[${new Date().toISOString().slice(11, 23)}] ${m.type()} ${m.text()}\n`));
  page.on('response', (r) => { if (r.status() >= 400) appendFileSync(LOG, `[${new Date().toISOString().slice(11, 23)}] HTTP ${r.status()} ${r.url()}\n`); });
  page.on('pageerror', (e) => appendFileSync(LOG, `[${new Date().toISOString().slice(11, 23)}] PAGEERROR ${e.message}\n`));
  await page.goto(url, { waitUntil: 'commit', timeout: 120_000 });
  let shots = 0;

  const run = async (op: string, a: string[]): Promise<string> => {
    switch (op) {
      case 'shot': {
        const f = join(out, `${String(++shots).padStart(3, '0')}-${a[0] ?? 'shot'}.png`);
        await page.screenshot({ path: f, timeout: 60_000 });
        return f;
      }
      case 'click': {
        const [x, y] = [Number(a[0]), Number(a[1])];
        if (a[2] === 'double') await page.mouse.dblclick(x, y);
        else await page.mouse.click(x, y, { button: a[2] === 'right' ? 'right' : 'left' });
        return 'ok';
      }
      case 'drag': {
        const [x0, y0, x1, y1] = a.map(Number);
        await page.mouse.move(x0, y0);
        await page.mouse.down();
        for (let i = 1; i <= 10; i++) await page.mouse.move(x0 + ((x1 - x0) * i) / 10, y0 + ((y1 - y0) * i) / 10);
        await page.mouse.up();
        return 'ok';
      }
      case 'key': {
        const hold = Number(a[1] ?? 0);
        if (hold > 0) {
          const keys = a[0].split('+');
          for (const k of keys) await page.keyboard.down(k);
          await page.waitForTimeout(hold);
          for (const k of keys.reverse()) await page.keyboard.up(k);
        } else await page.keyboard.press(a[0]);
        return 'ok';
      }
      case 'type': await page.keyboard.type(a.join(' '), { delay: 30 }); return 'ok';
      case 'fill': await page.locator(a[0]).first().fill(a.slice(1).join(' ')); return 'ok';
      case 'eval': {
        const r = await page.evaluate(a.join(' '));
        return typeof r === 'string' ? r : JSON.stringify(r);
      }
      case 'objects': {
        // The client's server-object table on a page with no debug globals (production): every live
        // Map whose values look like ServerObjects (numeric guid + objCellId key), found through CDP
        // Runtime.queryObjects. Prints guid / name / cell / lostCell per object, largest table first.
        const cdp = await ctx.newCDPSession(page);
        try {
          const proto = await cdp.send('Runtime.evaluate', { expression: 'Map.prototype' });
          const maps = await cdp.send('Runtime.queryObjects', { prototypeObjectId: proto.result.objectId! });
          const r = await cdp.send('Runtime.callFunctionOn', {
            objectId: maps.objects.objectId!,
            returnByValue: true,
            functionDeclaration: `function () {
              const hex = (n) => '0x' + ((n ?? 0) >>> 0).toString(16);
              return this.filter((m) => { for (const v of m.values()) return !!v && typeof v === 'object' && typeof v.guid === 'number' && 'objCellId' in v; return false; })
                .sort((a, b) => b.size - a.size)
                .map((m) => [...m.values()].map((o) => hex(o.guid) + ' ' + JSON.stringify(o.name) + ' cell=' + hex(o.objCellId) + (o.lostCell ? ' LOST' : '')));
            }`,
          });
          return JSON.stringify(r.result.value, null, 1);
        } finally { await cdp.detach(); }
      }
      case 'goto': await page.goto(a[0], { waitUntil: 'commit', timeout: 120_000 }); return 'ok';
      case 'log': {
        if (!existsSync(LOG)) return '';
        const re = a[0] ? new RegExp(a[0]) : null;
        const lines = readFileSync(LOG, 'utf8').split('\n').filter((l) => l && (!re || re.test(l)));
        return lines.slice(-Number(a[1] ?? 40)).join('\n');
      }
      case 'stop': setTimeout(() => void ctx.close().then(() => process.exit(0)), 100); return 'stopping';
      default: throw new Error(`unknown op ${op}`);
    }
  };

  createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { op, args: a } = JSON.parse(body || '{}') as { op: string; args: string[] };
      run(op, a ?? []).then(
        (r) => { res.writeHead(200); res.end(r); },
        (e) => { res.writeHead(500); res.end(String(e?.message ?? e)); },
      );
    });
  }).listen(port, '127.0.0.1', () => console.log(`live-drive on :${port} → ${url} (${gpu ? 'GPU' : 'SwiftShader'}), out ${out}`));
}

async function client(op: string, a: string[]): Promise<void> {
  const r = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: JSON.stringify({ op, args: a }) });
  const t = await r.text();
  console.log(t);
  if (!r.ok) process.exitCode = 1;
}

const [cmd, ...rest] = args;
if (cmd === 'serve') await serve();
else if (cmd) await client(cmd, rest);
else console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
