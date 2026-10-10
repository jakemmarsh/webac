/**
 * CORE.17.k — live capture + side-by-side evidence for the spew box and the
 * cleaned-up chat log.
 *
 * Drives the running stack (vite :3000, bridge :9090, ACE) with Playwright:
 * logs in like tools/capture-ui-screens.ts, teleports with the admin
 * command (@telepoi holtburg) so the client raises the retail portal-space
 * notice, and shoots
 *   ours-portal-space-spew.png   the tunnel with the red notice — shot via the
 *                                acDebug.showPortalSpace hook (the same path
 *                                the teleport takes) because a SwiftShader
 *                                screenshot (7-8 s) outlives the real overlay
 *   ours-after-teleport-spew.png back in the world, notice re-raised through
 *                                the same path so the HUD-hosted copy shows
 * Then composes (no browser driving) from verification/core17k/:
 *   core17k-spew-sidebyside.png   retail portal-space-web1.jpg | ours in portal
 *                                 space | ours just after (2x top-band crops)
 *   core17k-chat-sidebyside.png   retail Wine chat crop | ours BEFORE | ours
 *                                 AFTER (3x), from the hud-idle-over-world scenes
 *   core17k-fullscreen-sidebyside.png  retail Wine frame | ours before | ours after
 *
 * Usage: npx tsx tools/capture-core17k-spew-sidebyside.ts [--compose-only]
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17k');
const WINE = join(REPO, 'docs/images/retail-client-wine-inworld-holtburg.png');
const WEB1 = join(REPO, 'reference/images/preworld/portal-space-web1.jpg');
const BEFORE = join(OUT, 'before-hud-idle-over-world.png');
const AFTER = join(OUT, 'after-hud-idle-over-world.png');
const PORTAL = join(OUT, 'ours-portal-space-spew.png');
const LANDED = join(OUT, 'ours-after-teleport-spew.png');
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

async function captureLive(): Promise<void> {
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', (d) => void d.dismiss());
  page.on('console', (msg) => {
    const t = msg.text();
    if (/\[AC\]|error|Error/.test(t)) console.log(`  [page] ${t.slice(0, 160)}`);
  });
  console.log(`[core17k] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (Date.now() - lastReload > 60_000) {
      console.log('[core17k] not in world yet — reloading (phantom-session retry)');
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
  console.log('[core17k] in world; letting the login notices expire');
  await page.waitForTimeout(9000);
  await page.evaluate(() => (window as any).__ac?.skybox?.setWeatherEnabled?.(false));
  await page.evaluate((t) => (window as any).acDebug?.freezeTimeOfDay?.(t), 0.5);

  // Teleport → BeginTeleportAnimation equivalent → spew notice + portal space.
  const t0 = Date.now();
  await page.evaluate((cmd) => (window as any).acDebug?.admin?.(cmd), '@telepoi holtburg');
  // The server's teleport lands 0.3–3 s later; poll for the overlay-hosted
  // strip (#portal-spew-box) and shoot as soon as it is up.
  // (Rows are AC-font canvases — no textContent — so count children.)
  const overlayUp = await page.waitForFunction(
    () => (document.getElementById('portal-spew-box')?.children.length ?? 0) > 0, undefined, { timeout: 10000 },
  ).then(() => true).catch(() => false);
  console.log(`[core17k] portal overlay + notice up: ${overlayUp} after ${Date.now() - t0} ms`);
  // A SwiftShader screenshot of this page costs 7-8 s — longer than the
  // overlay's 3 s hold + fade after a real teleport — so the teleport frame
  // only lands by luck. Wait the teleport out, then run the SAME
  // showPortalSpace path through the debug hook (it raises the notice and
  // holds the overlay until hidePortalSpace) and shoot that.
  await page.waitForFunction(() => !document.getElementById('portal-spew-box'), undefined, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(600);
  await page.evaluate(() => (window as any).acDebug?.showPortalSpace?.());
  await page.waitForFunction(
    () => (document.getElementById('portal-spew-box')?.children.length ?? 0) > 0, undefined, { timeout: 5000 },
  ).catch(() => {});
  await page.waitForTimeout(300);
  // The frame is grabbed late inside the 7-8 s screenshot, after the 5 s
  // item timer: keep the notice alive by re-raising it every 2 s through the
  // same path (retail replaces an identical top item, so nothing visible
  // changes) and stop once the shot is written.
  const keepAlive = (on: boolean) => page.evaluate((flag) => {
    const w = window as any;
    if (w.__spewKeep) { clearInterval(w.__spewKeep); w.__spewKeep = null; }
    if (flag) w.__spewKeep = setInterval(() => w.__ac?.gameUI?.displayErrorText?.('In Portal Space - Please Wait...'), 2000);
  }, on);
  await keepAlive(true);
  const s1 = Date.now();
  await page.screenshot({ path: PORTAL });
  console.log(`[core17k] ${PORTAL} (screenshot took ${Date.now() - s1} ms)`);
  await keepAlive(false);
  await page.evaluate(() => (window as any).acDebug?.hidePortalSpace?.());
  await page.waitForTimeout(800);
  // Landed frame: re-raise the notice through the same retail path
  // (DisplayStringInfo 0x1a) so the frame shows the HUD-hosted strip.
  const reraised = await page.evaluate(() => {
    const ui = (window as any).__ac?.gameUI;
    if (!ui?.displayErrorText) return false;
    ui.displayErrorText('In Portal Space - Please Wait...');
    return true;
  });
  const rowsBefore = await page.evaluate(() => document.querySelectorAll('#hud-spew-box .spew-item').length);
  console.log(`[core17k] re-raised through displayErrorText: ${reraised}; HUD strip rows before the shot: ${rowsBefore}`);
  await keepAlive(true);
  const s2 = Date.now();
  await page.screenshot({ path: LANDED });
  console.log(`[core17k] ${LANDED} (screenshot took ${Date.now() - s2} ms)`);
  await keepAlive(false);
  const state = await page.evaluate(() => {
    const rows = document.querySelectorAll('#hud-spew-box .spew-item').length;
    const chat = document.getElementById('chat-messages');
    const chatLines = chat ? [...chat.children].map((c) => (c.textContent ?? '').trim()) : null;
    const link = document.getElementById('hud-indicator-connection');
    return { rows, chatLines, linkState: link?.getAttribute('data-link-state') ?? null };
  });
  console.log(`[core17k] spew rows: ${JSON.stringify(state.rows)}`);
  console.log(`[core17k] chat lines: ${JSON.stringify(state.chatLines)}`);
  console.log(`[core17k] link state: ${state.linkState}`);
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
  for (const f of [WINE, WEB1, BEFORE, AFTER, PORTAL, LANDED]) {
    if (!existsSync(f)) throw new Error(`missing ${f}`);
  }
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 2700, height: 1200 } });

  // Top band of each frame: the spew strip sits 20px below the top of the 3D
  // view, centred. Retail web1 is 1328x749; ours 1568x775.
  const spew: Panel[] = [
    { file: WEB1, label: 'retail (portal-space-web1.jpg, 1328x749): "In Portal Space - Please Wait" red, centred, top band', x: 364, y: 0, w: 600, h: 60 },
    { file: PORTAL, label: 'ours: showPortalSpace (the teleport path) with the spew notice — layout 0x21000011 mirrored onto the overlay', x: 484, y: 0, w: 600, h: 60 },
    { file: LANDED, label: 'ours after landing (notice re-raised for the frame): the HUD-hosted strip sits BEHIND the stacked vitals plate — retail order too (UIRegion::AddChild sorts DESCENDING zLevel, 3D-view root 0x10000037 z9999 = furthest back); chat untouched', x: 484, y: 0, w: 600, h: 60 },
  ];
  await page.setContent(`${CSS}<h1>CORE.17.k — the portal-space notice: retail spew box vs ours (2x crops of the top band)</h1>
    <div class="row">${spew.map((p) => cropCell(p, 2)).join('')}</div>
    <div style="height:12px"></div>
    <div class="row full">
      <div class="cell"><div class="lbl">retail portal-space-web1.jpg</div><img src="${dataUrl(WEB1)}"/></div>
      <div class="cell"><div class="lbl">ours — portal space with notice</div><img src="${dataUrl(PORTAL)}"/></div>
      <div class="cell"><div class="lbl">ours — landed (notice behind the vitals plate, as retail z-order)</div><img src="${dataUrl(LANDED)}"/></div>
    </div>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17k-spew-sidebyside.png'), fullPage: true });

  const chat: Panel[] = [
    { file: WINE, label: 'retail EoL client (Wine, 1024x768) fresh login at Holtburg: chat = server welcome only', x: 0, y: 660, w: 430, h: 108 },
    { file: BEFORE, label: 'ours BEFORE (hud-idle-over-world): "In Portal Space" x3 + "Entering dungeon at landblock" — client text in the log', x: 0, y: 670, w: 430, h: 105 },
    { file: AFTER, label: 'ours AFTER: chat = server welcome only, identical line set to retail', x: 0, y: 670, w: 430, h: 105 },
  ];
  await page.setContent(`${CSS}<h1>CORE.17.k — main chat log after login + @telepoi: retail vs ours before/after (3x crops, bottom-left)</h1>
    <div class="row">${chat.map((p) => cropCell(p, 3)).join('')}</div>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17k-chat-sidebyside.png'), fullPage: true });

  await page.setContent(`${CSS}<h1>CORE.17.k — whole screen: retail EoL client (Wine 1024x768) | ours before | ours after (1568x775)</h1>
    <div class="row full">
      <div class="cell"><div class="lbl">retail EoL client under Wine</div><img src="${dataUrl(WINE)}"/></div>
      <div class="cell"><div class="lbl">ours BEFORE</div><img src="${dataUrl(BEFORE)}"/></div>
      <div class="cell"><div class="lbl">ours AFTER</div><img src="${dataUrl(AFTER)}"/></div>
    </div>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17k-fullscreen-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17k] wrote side-by-sides to ${OUT}`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  if (!process.argv.includes('--compose-only')) await captureLive();
  await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
