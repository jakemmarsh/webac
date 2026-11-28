/**
 * BUG.visible-close-1001-read-as-drop — a VISIBLE in-world tab whose session
 * socket closes with 1001 "going away" must not read its own leaving as a drop.
 *
 * Production 2026-11-28 (trace 1d154c28689f45d7): Firefox closing a visible
 * tab closed the game WebSocket with 1001 about 300 ms BEFORE pagehide, and the
 * page reported world_left `disconnected` and began a resume. Playwright's own
 * page.close() / navigation does not reproduce that order, so the default mode
 * forces it: the page connects through a WebSocket relay here that closes the
 * page's socket with 1001 on cue, and the page then leaves LEAVE_AFTER_MS (300)
 * later. pagehide must win (the "before pagehide" line, no drop handled).
 *
 *   AC_BASE=http://localhost:<vite>/ AC_ACCOUNT=testacjs3 npx tsx tools/probe-visible-close.ts [firefox|chromium] [relay1001|stay1001|close|navigate]
 *
 * relay1001 (default): 1001 from the relay, then the page leaves → PASS when held and no drop handled.
 * stay1001: 1001 from the relay and the page stays (our bridge's shutdown close) → PASS when the
 *   drop is handled after the hold and the session resumes into the world.
 * close / navigate: Playwright's own tab close / about:blank, no relay (must stay clean).
 * Throwaway browser context; nothing is left on disk.
 */
import { firefox, chromium } from 'playwright';
import { WebSocketServer, WebSocket } from 'ws';
import { gameUrl } from './lib/game-session.js';

const which = process.argv[2] === 'chromium' ? 'chromium' : 'firefox';
const mode = process.argv[3] ?? 'relay1001';
const BRIDGE = process.env.AC_BRIDGE ?? 'ws://localhost:9090';
const RELAY_PORT = Number(process.env.RELAY_PORT ?? 9392);
const LEAVE_AFTER_MS = Number(process.env.LEAVE_AFTER_MS ?? 300);
const useRelay = mode === 'relay1001' || mode === 'stay1001';

const pageSockets = new Set<WebSocket>();
let relay: WebSocketServer | null = null;
if (useRelay) {
  relay = new WebSocketServer({ port: RELAY_PORT, host: '127.0.0.1' });
  relay.on('connection', (client, req) => {
    const upstream = new WebSocket(`${BRIDGE}${req.url ?? '/'}`);
    const queued: Array<{ data: unknown; binary: boolean }> = [];
    pageSockets.add(client);
    upstream.on('open', () => { for (const q of queued.splice(0)) upstream.send(q.data as Buffer, { binary: q.binary }); });
    client.on('message', (data, binary) => { if (upstream.readyState === WebSocket.OPEN) upstream.send(data as Buffer, { binary }); else queued.push({ data, binary }); });
    upstream.on('message', (data, binary) => { if (client.readyState === WebSocket.OPEN) client.send(data as Buffer, { binary }); });
    const end = (): void => { pageSockets.delete(client); try { client.close(); } catch { /* */ } try { upstream.close(); } catch { /* */ } };
    client.on('close', end); upstream.on('close', end); client.on('error', end); upstream.on('error', end);
  });
  process.env.AC_BRIDGE = `ws://localhost:${RELAY_PORT}`;
}

const type = which === 'chromium' ? chromium : firefox;
const browser = await type.launch({ headless: false });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const lines: string[] = [];
page.on('console', (m) => lines.push(m.text()));
const url = gameUrl({ cb: `visible-close-${which}` });
console.log(`[probe] ${which} ${mode} → ${url.replace(/password=[^&]*/, 'password=…')}`);
await page.goto(url, { waitUntil: 'load' });

const inGame = (): Promise<boolean> => page.evaluate("!!(window.__ac && window.__ac.gameUI && window.__ac.gameUI.ui && window.__ac.gameUI.ui.currentScreen === 'game' && !window.__ac.gameUI.connectingScreenShown)").catch(() => false) as Promise<boolean>;
const waitGame = async (ms: number): Promise<boolean> => { const end = Date.now() + ms; while (Date.now() < end) { if (await inGame()) return true; await page.waitForTimeout(1000); } return false; };
if (!(await waitGame(240_000))) {
  const screen = await page.evaluate("window.__ac?.gameUI?.ui?.currentScreen ?? 'no __ac'").catch((e) => String(e));
  console.log(`RESULT no world (screen ${screen})`);
  await browser.close(); relay?.close(); process.exit(2);
}
await page.waitForTimeout(8000);
const vis = await page.evaluate('document.visibilityState');
console.log(`[probe] in the world, tab ${vis}; ${mode}`);
const mark = lines.length;
const show = (from: number): void => { for (const l of lines.slice(from)) if (/socket closed|pagehide|Disconnected|resum|going|session ended|WebSocket connected|character list|unexpected/i.test(l)) console.log(`  page: ${l.slice(0, 220)}`); };

let pass = false;
if (mode === 'relay1001') {
  for (const s of pageSockets) s.close(1001);
  await page.waitForTimeout(LEAVE_AFTER_MS);
  const handledBefore = lines.slice(mark).some((l) => /\[AC\] ACE: Disconnected|resuming|WebSocket connected to bridge/i.test(l));
  await page.goto('about:blank');
  await new Promise((r) => setTimeout(r, 2500));
  show(mark);
  const held = lines.slice(mark).some((l) => /before pagehide: the page was going/.test(l));
  const handled = handledBefore || lines.slice(mark).some((l) => /\[AC\] ACE: Disconnected|resuming|WebSocket connected to bridge/i.test(l));
  pass = held && !handled;
  console.log(`RESULT visible-close ${which} relay1001 held_1001=${held} drop_handled=${handled} => ${pass ? 'PASS' : 'FAIL'}`);
} else if (mode === 'stay1001') {
  const t0 = Date.now();
  for (const s of pageSockets) s.close(1001);
  await page.waitForTimeout(1000);
  const earlyHandled = lines.slice(mark).some((l) => /\[AC\] ACE: Disconnected/i.test(l));
  // The resume: a new connection reaches its character list again, then the page is back in the world.
  const relists = (): number => lines.slice(mark).filter((l) => /Got character list/i.test(l)).length;
  let back = false;
  const until = Date.now() + 60_000;
  while (Date.now() < until && !back) { await page.waitForTimeout(1000); back = relists() > 0 && (await inGame()); }
  show(mark);
  const disconnectedScreen = lines.slice(mark).some((l) => /Disconnected screen/i.test(l));
  pass = !earlyHandled && back && !disconnectedScreen;
  console.log(`RESULT visible-close ${which} stay1001 held_past_1s=${!earlyHandled} resumed_into_world=${back} disconnected_screen=${disconnectedScreen} in ${Math.round((Date.now() - t0) / 1000)} s => ${pass ? 'PASS' : 'FAIL'}`);
} else {
  if (mode === 'close') await page.close({ runBeforeUnload: false });
  else await page.goto('about:blank');
  await new Promise((r) => setTimeout(r, 2500));
  show(mark);
  const handled = lines.slice(mark).some((l) => /\[AC\] ACE: Disconnected|resuming|WebSocket connected to bridge/i.test(l));
  pass = !handled;
  console.log(`RESULT visible-close ${which} ${mode} drop_handled=${handled} => ${pass ? 'PASS' : 'FAIL'}`);
}
await browser.close().catch(() => {});
relay?.close();
process.exit(pass ? 0 : 1);
