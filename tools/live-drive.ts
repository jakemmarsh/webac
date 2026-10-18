/**
 * Drive a real game page step by step from the shell, the way a player
 * would: a long-lived browser (persistent profile, so OPFS caches survive
 * era reloads like a player's) behind a tiny localhost control server.
 * Built for playing a deployed page (https://playwebac.com), where URL login
 * and ?agent are off: you log in through the launcher with clicks and keys.
 *
 *   npx tsx tools/live-drive.ts serve [--url https://playwebac.com/] [--gpu] [--out dir] [--port 9477] [--throttle kbit/s] [--profile dir] [--viewport WxH] [--cursor]
 *   npx tsx tools/live-drive.ts shot [name]            → prints the PNG path
 *   npx tsx tools/live-drive.ts click <x> <y> [right|double]
 *   npx tsx tools/live-drive.ts drag <x0> <y0> <x1> <y1>
 *   npx tsx tools/live-drive.ts key <Key> [holdMs]     (Playwright key names: w, Enter, F2, Shift+Tab…)
 *   npx tsx tools/live-drive.ts type <text>
 *   npx tsx tools/live-drive.ts eval <js>              (page.evaluate; result JSON-stringified)
 *   npx tsx tools/live-drive.ts fill <css selector> <text>
 *   npx tsx tools/live-drive.ts objects               (the client server-object table via CDP; works on production)
 *   npx tsx tools/live-drive.ts goto <url>
 *   npx tsx tools/live-drive.ts resize <w> <h>          (the viewport, as a window resize)
 *   npx tsx tools/live-drive.ts log [pattern] [n]      (last n console lines, regex-filtered)
 *   npx tsx tools/live-drive.ts move <x> <y> [ms]      (glide the mouse there over ms, default 400, as a hand would)
 *   npx tsx tools/live-drive.ts record start|stop [name] (a CDP screencast → <out>/<name>.mp4, 30 fps; see below)
 *   npx tsx tools/live-drive.ts stop
 *
 * Recording (for videos): serve with `--viewport 1920x1080 --cursor` so the capture is full HD and
 * shows a drawn mouse pointer with a ring on each click (headless Chrome paints no cursor). `record
 * start` streams screencast frames (JPEG q92) with their timestamps; `record stop` encodes them with
 * ffmpeg at their real timing to a constant 30 fps H.264 file and prints its path.
 *
 * window.__ldLongTasks lists main-thread long tasks (≥ 50 ms) since the page started.
 *
 * One live session at a time (CLAUDE.md machine safety): `serve` refuses to
 * start when its port is taken. The console log is <out>/console.log.
 *
 * The browser profile is a fresh $TMPDIR/live-drive-profile-* per run and is
 * DELETED when the server stops (`stop`, Ctrl-C / SIGTERM, the browser
 * closing, any exit); profiles left by a crashed run are swept at the next
 * `serve` (tools/lib/temp-profile.ts). Each one fills with the game's OPFS
 * DAT cache (up to ~2.4 GB): 129 leaked ones filled the Mac's disk on
 * 2026-10-12. To keep a warm DAT cache between runs on purpose, pass
 * `--profile <dir>`: that directory is reused and never deleted (pick one
 * fixed path and remove it when done, not a new one per run).
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { createRunProfile } from './lib/temp-profile.js';
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
  const vp = opt('viewport', '');
  const viewport = /^\d+x\d+$/.test(vp) ? { width: Number(vp.split('x')[0]), height: Number(vp.split('x')[1]) } : { ...DEFAULT_VIEWPORT };
  const persist = opt('profile', '');
  if (persist) mkdirSync(persist, { recursive: true });
  const profile = createRunProfile('live-drive-profile-', { persistDir: persist || undefined, tool: 'live-drive' });
  const ctx = await chromium.launchPersistentContext(profile.dir, {
    headless: true,
    // The cloud container's preinstalled Chromium (the game-session recipe); Playwright's own may be absent.
    ...(gpu ? { channel: 'chromium', args: GPU_ARGS } : { args: SWIFTSHADER_ARGS, ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}) }),
    viewport,
  });
  profile.setCloser(() => ctx.close());
  // The browser going away (crash, killed, closed) ends the server and takes the temp profile with it.
  let stopping = false;
  const shutdown = async (code: number): Promise<never> => {
    stopping = true;
    await profile.dispose();
    process.exit(code);
  };
  ctx.on('close', () => { if (!stopping) { console.error('live-drive: the browser closed; stopping'); void shutdown(1); } });
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
  // --cursor: draw the pointer (headless Chrome paints none), with a ring on each press, for recordings.
  if (args.includes('--cursor')) {
    await ctx.addInitScript(() => {
      const add = (): void => {
        const c = document.createElement('div');
        c.id = '__ldCursor';
        c.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px)';
        c.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M2 1 L2 17 L6.5 13 L9.5 20 L12.5 18.7 L9.6 12 L15.5 12 Z" fill="#fff" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/></svg>';
        document.documentElement.appendChild(c);
        type At = { clientX: number; clientY: number };
        addEventListener('mousemove', (ev) => { const e = ev as unknown as At; c.style.transform = `translate(${e.clientX - 2}px,${e.clientY - 1}px)`; }, true);
        addEventListener('mousedown', (ev) => {
          const e = ev as unknown as At;
          const r = document.createElement('div');
          r.style.cssText = `position:fixed;left:${e.clientX - 18}px;top:${e.clientY - 18}px;width:36px;height:36px;border-radius:50%;border:3px solid #ffd76a;z-index:2147483646;pointer-events:none;transition:transform .35s ease-out,opacity .35s ease-out;transform:scale(.4);opacity:1`;
          document.documentElement.appendChild(r);
          requestAnimationFrame(() => { r.style.transform = 'scale(1.3)'; r.style.opacity = '0'; });
          setTimeout(() => r.remove(), 450);
        }, true);
      };
      if (document.documentElement) add(); else addEventListener('DOMContentLoaded', add);
    });
  }
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
  let mouse = { x: 0, y: 0 };
  let rec: { name: string; dir: string; frames: Array<{ f: string; t: number }>; cdp: import('playwright').CDPSession; size: { width: number; height: number } } | null = null;

  const run = async (op: string, a: string[]): Promise<string> => {
    switch (op) {
      case 'shot': {
        const f = join(out, `${String(++shots).padStart(3, '0')}-${a[0] ?? 'shot'}.png`);
        await page.screenshot({ path: f, timeout: 60_000 });
        return f;
      }
      case 'move': {
        const [x, y, ms] = [Number(a[0]), Number(a[1]), Number(a[2] ?? 400)];
        const steps = Math.max(1, Math.round(ms / 16));
        const from = { ...mouse };
        for (let i = 1; i <= steps; i++) {
          const k = i / steps, e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
          await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
          await page.waitForTimeout(16);
        }
        mouse = { x, y };
        return 'ok';
      }
      case 'record': {
        if (a[0] === 'start') {
          if (rec) throw new Error(`already recording ${rec.name}`);
          const name = a[1] ?? `rec-${Date.now()}`;
          const dir = join(out, `${name}-frames`);
          mkdirSync(dir, { recursive: true });
          const cdp = await ctx.newCDPSession(page);
          // The size now, not at launch: `resize` (e.g. 1080x1920 for a vertical take) changes it.
          const size = page.viewportSize() ?? viewport;
          const r = { name, dir, frames: [] as Array<{ f: string; t: number }>, cdp, size };
          cdp.on('Page.screencastFrame', (fr: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
            const f = join(dir, `${String(r.frames.length).padStart(6, '0')}.jpg`);
            writeFileSync(f, Buffer.from(fr.data, 'base64'));
            r.frames.push({ f, t: fr.metadata.timestamp ?? Date.now() / 1000 });
            void cdp.send('Page.screencastFrameAck', { sessionId: fr.sessionId }).catch(() => {});
          });
          await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: size.width, maxHeight: size.height, everyNthFrame: 1 });
          rec = r;
          return `recording ${name}`;
        }
        if (!rec) throw new Error('not recording');
        const r = rec;
        rec = null;
        await r.cdp.send('Page.stopScreencast');
        await r.cdp.detach();
        if (r.frames.length === 0) throw new Error('no frames captured');
        // The concat demuxer with each frame's real on-screen duration; the screencast only sends a
        // frame when the page repaints, so a still screen is one long frame, not a gap.
        const list = r.frames.map((fr, i) => {
          const next = r.frames[i + 1]?.t ?? fr.t + 1 / 30;
          return `file '${fr.f}'\nduration ${Math.max(0.001, next - fr.t).toFixed(4)}`;
        }).join('\n') + `\nfile '${r.frames[r.frames.length - 1].f}'\n`;
        const listFile = join(r.dir, 'frames.txt');
        writeFileSync(listFile, list);
        const mp4 = join(out, `${r.name}.mp4`);
        const ff = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile,
          '-vf', `fps=30,scale=${r.size.width}:${r.size.height}:flags=lanczos,format=yuv420p`, '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', mp4]);
        if (ff.status !== 0) throw new Error(`ffmpeg failed: ${ff.stderr}`);
        return `${mp4} (${r.frames.length} frames, ${(r.frames[r.frames.length - 1].t - r.frames[0].t).toFixed(1)} s)`;
      }
      case 'click': {
        const [x, y] = [Number(a[0]), Number(a[1])];
        mouse = { x, y };
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
      // A window resize as the browser delivers one (the page's resize event, new innerWidth / innerHeight).
      case 'resize': await page.setViewportSize({ width: Number(a[0]), height: Number(a[1]) }); return 'ok';
      case 'log': {
        if (!existsSync(LOG)) return '';
        const re = a[0] ? new RegExp(a[0]) : null;
        const lines = readFileSync(LOG, 'utf8').split('\n').filter((l) => l && (!re || re.test(l)));
        return lines.slice(-Number(a[1] ?? 40)).join('\n');
      }
      case 'stop': setTimeout(() => void shutdown(0), 100); return 'stopping';
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
  }).listen(port, '127.0.0.1', () => console.log(`live-drive on :${port} → ${url} (${gpu ? 'GPU' : 'SwiftShader'}), out ${out}, profile ${profile.dir}${profile.temporary ? ' (deleted at stop)' : ' (kept)'}`));
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
