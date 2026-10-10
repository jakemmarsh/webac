/**
 * CORE.17.k.a — live evidence that client-authored notices reach their retail
 * sinks: validation failures → the spew box (DisplayStringInfo 0x1a), state
 * confirmations → a plain chat line (type 0), non-retail command echoes →
 * the developer console only.
 *
 * Drives the running stack (vite :3000, bridge :9090, ACE) with Playwright,
 * logs in like tools/capture-ui-screens.ts, then types real commands into the
 * main chat entry (#chat-input + Enter — the same path a player uses):
 *   /tell Bogus hi      → spew "Use comma after the name for targeted chat."
 *                         (DoTell @ 363430, 0x1a); chat log untouched
 *   /friends bogus      → spew "Invalid friends command specified."
 *                         (DoFriends @ 367119, 0x1a)
 *   /clear              → chat emptied, NO notice anywhere (DoClear @ 356590);
 *                         "[AC] Chat cleared." in the console only
 *   /afk … /afk         → chat "You are now set to away-from-keyboard." /
 *                         "You are no longer set to away-from-keyboard."
 *                         (@ 367940/367945, type 0) — server round-trip
 * Shoots ours-tell-usage-spew.png (the /tell failure in the strip) and
 * ours-afk-chat.png (the AFK confirmation in the log), writes live-state.json
 * (spew items / chat lines / console lines after every step) and composes
 *   core17ka-spew-sidebyside.png   retail portal-space-web1.jpg top band |
 *                                  ours /tell failure top band (2x)
 *   core17ka-chat-sidebyside.png   retail Wine chat | ours after /afk (3x)
 *   core17ka-fullscreen-sidebyside.png  retail Wine frame | ours /tell | ours /afk
 *
 * Usage: npx tsx tools/capture-core17ka-notices-sidebyside.ts [--compose-only]
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17ka');
const WINE = join(REPO, 'docs/images/retail-client-wine-inworld-holtburg.png');
const WEB1 = join(REPO, 'reference/images/preworld/portal-space-web1.jpg');
const TELL = join(OUT, 'ours-tell-usage-spew.png');
const AFK = join(OUT, 'ours-afk-chat.png');
const STATE = join(OUT, 'live-state.json');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };

function launch() {
  return chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
}

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as unknown as { acDebug?: { collisionState?: () => { x: number } } }).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

interface Snapshot {
  step: string;
  spewItems: string[];
  hudRows: number;
  chatLines: string[];
  consoleAc: string[];
}

async function snapshot(page: Page, step: string, consoleAc: string[]): Promise<Snapshot> {
  const s = await page.evaluate(() => {
    const w = window as any;
    const items: { text: string }[] = w.__ac?.gameUI?.spewBox?.items ?? [];
    const chat = document.getElementById('chat-messages');
    return {
      spewItems: items.map((i) => i.text),
      hudRows: document.querySelectorAll('#hud-spew-box .spew-item').length,
      chatLines: chat ? [...chat.children].map((c) => (c.textContent ?? '').trim()) : [],
    };
  });
  const snap = { step, ...s, consoleAc: [...consoleAc] };
  console.log(`[core17ka] ${step}: spew=${JSON.stringify(snap.spewItems)} rows=${snap.hudRows} chat=${JSON.stringify(snap.chatLines)} console=${JSON.stringify(snap.consoleAc)}`);
  return snap;
}

async function send(page: Page, cmd: string): Promise<void> {
  await page.focus('#chat-input');
  await page.fill('#chat-input', cmd);
  await page.keyboard.press('Enter');
}

async function captureLive(): Promise<void> {
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', (d) => void d.dismiss());
  const consoleAc: string[] = [];
  page.on('console', (msg) => {
    const t = msg.text();
    if (/^\[AC\] (Chat cleared|Logging off|Reconnecting|Cancelling attack|UI layout)/.test(t)) consoleAc.push(t);
    if (/error|Error/.test(t)) console.log(`  [page] ${t.slice(0, 160)}`);
  });
  console.log(`[core17ka] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (Date.now() - lastReload > 60_000) {
      console.log('[core17ka] not in world yet — reloading (phantom-session retry)');
      await page.reload({ waitUntil: 'domcontentloaded' });
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) {
    await page.screenshot({ path: join(OUT, '_login-failed.png') });
    await browser.close();
    throw new Error('never entered world — see _login-failed.png');
  }
  console.log('[core17ka] in world; letting the login notices expire');
  await page.waitForTimeout(9000);
  await page.evaluate(() => (window as any).__ac?.skybox?.setWeatherEnabled?.(false));
  await page.evaluate((t) => (window as any).acDebug?.freezeTimeOfDay?.(t), 0.5);

  const snaps: Snapshot[] = [];
  snaps.push(await snapshot(page, 'baseline', consoleAc));
  const baselineChat = snaps[0].chatLines;

  // 1. /tell without the comma → DoTell's 0x1a line in the strip.
  await send(page, '/tell Bogus hi');
  await page.waitForTimeout(400);
  snaps.push(await snapshot(page, 'after /tell Bogus hi', consoleAc));
  // A SwiftShader screenshot costs 7-8 s, longer than the 5 s item timer:
  // keep the row alive by re-raising the identical text through the same
  // path (retail replaces an identical top item, nothing visible changes).
  const keepAlive = (on: boolean, text: string) => page.evaluate(([flag, t]) => {
    const w = window as any;
    if (w.__spewKeep) { clearInterval(w.__spewKeep); w.__spewKeep = null; }
    if (flag) w.__spewKeep = setInterval(() => w.__ac?.gameUI?.spewNotice?.(t), 2000);
  }, [on, text] as const);
  await keepAlive(true, 'Use comma after the name for targeted chat.');
  const s1 = Date.now();
  await page.screenshot({ path: TELL });
  console.log(`[core17ka] ${TELL} (screenshot took ${Date.now() - s1} ms)`);
  await keepAlive(false, '');
  await page.waitForFunction(() => ((window as any).__ac?.gameUI?.spewBox?.items?.length ?? 0) === 0, undefined, { timeout: 15000 }).catch(() => {});

  // 2. /friends with a bad sub-command → DoFriends' 0x1a line.
  await send(page, '/friends bogus');
  await page.waitForTimeout(400);
  snaps.push(await snapshot(page, 'after /friends bogus', consoleAc));
  await page.waitForFunction(() => ((window as any).__ac?.gameUI?.spewBox?.items?.length ?? 0) === 0, undefined, { timeout: 15000 }).catch(() => {});

  // 3. /clear → the log empties and nothing is printed anywhere but the console.
  await send(page, '/clear');
  await page.waitForTimeout(400);
  snaps.push(await snapshot(page, 'after /clear', consoleAc));

  // 4. /afk → server round-trip → type-0 chat confirmation.
  await send(page, '/afk');
  const afkOn = await page.waitForFunction(() => {
    const chat = document.getElementById('chat-messages');
    return !!chat && [...chat.children].some((c) => (c.textContent ?? '').includes('You are now set to away-from-keyboard.'));
  }, undefined, { timeout: 10000 }).then(() => true).catch(() => false);
  console.log(`[core17ka] AFK confirmation arrived in chat: ${afkOn}`);
  snaps.push(await snapshot(page, 'after /afk', consoleAc));
  const s2 = Date.now();
  await page.screenshot({ path: AFK });
  console.log(`[core17ka] ${AFK} (screenshot took ${Date.now() - s2} ms)`);
  await send(page, '/afk');
  await page.waitForFunction(() => {
    const chat = document.getElementById('chat-messages');
    return !!chat && [...chat.children].some((c) => (c.textContent ?? '').includes('You are no longer set to away-from-keyboard.'));
  }, undefined, { timeout: 10000 }).catch(() => {});
  snaps.push(await snapshot(page, 'after second /afk', consoleAc));

  writeFileSync(STATE, JSON.stringify({ url: URL, view: VIEW, baselineChat, snapshots: snaps }, null, 2));
  console.log(`[core17ka] wrote ${STATE}`);
  await browser.close();
}

interface Panel { file: string; label: string; x: number; y: number; w: number; h: number }

function dataUrl(file: string): string {
  const ext = file.endsWith('.jpg') ? 'jpeg' : 'png';
  return `data:image/${ext};base64,${readFileSync(file).toString('base64')}`;
}

function cropCell(p: Panel, zoom: number): string {
  return `<div class="cell"><div class="lbl">${p.label}</div>
    <div class="clip" style="width:${p.w * zoom}px;height:${p.h * zoom}px">
      <img src="${dataUrl(p.file)}" style="position:absolute;left:${-p.x * zoom}px;top:${-p.y * zoom}px;transform-origin:0 0;transform:scale(${zoom});image-rendering:pixelated"/>
    </div></div>`;
}

const CSS = `<style>
  body{margin:0;background:#1a1a1a;color:#eee;font:13px/1.3 monospace;padding:10px}
  .row{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap}
  .cell{display:flex;flex-direction:column;gap:4px}
  .lbl{color:#ffd;white-space:normal;max-width:900px}
  .clip{position:relative;overflow:hidden;background:#000;border:1px solid #444}
  .full img{display:block;width:780px;height:auto;border:1px solid #444}
  h1{font-size:14px;margin:0 0 8px}
</style>`;

async function compose(): Promise<void> {
  for (const f of [WINE, WEB1, TELL, AFK]) {
    if (!existsSync(f)) throw new Error(`missing ${f}`);
  }
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 2700, height: 1200 } });

  const spew: Panel[] = [
    { file: WEB1, label: 'retail (portal-space-web1.jpg, 1328x749): a DisplayStringInfo(0x1a) notice — red, centred in the spew box, top band of the 3D view', x: 364, y: 0, w: 600, h: 60 },
    { file: TELL, label: 'ours: "/tell Bogus hi" (no comma) → DoTell @ 363430 raises "Use comma after the name for targeted chat." at 0x1a → the same spew box; nothing in chat', x: 484, y: 0, w: 600, h: 60 },
  ];
  await page.setContent(`${CSS}<h1>CORE.17.k.a — a client validation failure: retail spew box vs ours (2x crops of the top band)</h1>
    <div class="row">${spew.map((p) => cropCell(p, 2)).join('')}</div>
    <div style="height:12px"></div>
    <div class="row full">
      <div class="cell"><div class="lbl">retail portal-space-web1.jpg (the spew box in use)</div><img src="${dataUrl(WEB1)}"/></div>
      <div class="cell"><div class="lbl">ours — after "/tell Bogus hi": the failure sits in the strip, the chat log is unchanged</div><img src="${dataUrl(TELL)}"/></div>
    </div>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17ka-spew-sidebyside.png'), fullPage: true });

  const chat: Panel[] = [
    { file: WINE, label: 'retail EoL client (Wine, 1024x768) at Holtburg: chat carries server text only', x: 0, y: 660, w: 430, h: 108 },
    { file: TELL, label: 'ours after "/tell Bogus hi": no usage line in the log (it went to the spew box)', x: 0, y: 670, w: 430, h: 105 },
    { file: AFK, label: 'ours after "/clear" then "/afk": the type-0 state confirmation "You are now set to away-from-keyboard." @ 367940 is the only line', x: 0, y: 670, w: 430, h: 105 },
  ];
  await page.setContent(`${CSS}<h1>CORE.17.k.a — main chat log: retail vs ours after a validation failure and after a state confirmation (3x crops, bottom-left)</h1>
    <div class="row">${chat.map((p) => cropCell(p, 3)).join('')}</div>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17ka-chat-sidebyside.png'), fullPage: true });

  await page.setContent(`${CSS}<h1>CORE.17.k.a — whole screen: retail EoL client (Wine 1024x768) | ours after /tell (spew) | ours after /afk (chat) (1568x775)</h1>
    <div class="row full">
      <div class="cell"><div class="lbl">retail EoL client under Wine</div><img src="${dataUrl(WINE)}"/></div>
      <div class="cell"><div class="lbl">ours — /tell usage failure in the spew box</div><img src="${dataUrl(TELL)}"/></div>
      <div class="cell"><div class="lbl">ours — /afk confirmation in chat</div><img src="${dataUrl(AFK)}"/></div>
    </div>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17ka-fullscreen-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17ka] wrote side-by-sides to ${OUT}`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  if (!process.argv.includes('--compose-only')) await captureLive();
  await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
