/**
 * CORE.17.k.b — live evidence that a lost connection, a CharacterError and a
 * client-side connection failure reach their retail surfaces:
 *
 *   A. server drops a live session → the Disconnected SCREEN (layout
 *      0x21000002, "The connection to the server has been lost!", Quit Game)
 *      — simulated the way the client's network layer would see it: the
 *      character is logged off + the Disconnect flag sent (so ACE's session
 *      state stays clean) and the WebSocket is then closed underneath
 *      ClientConnection without disconnect() — a non-deliberate close of a
 *      socket that had opened (ClientNet::RemoveConnection's ServerDied).
 *      Quit Game → the connecting screen → the login sequence → in world.
 *   B. a real ACE CharacterError: at char select (after /logoff) a
 *      CharacterEnterWorld (0xF657) with a bogus guid makes ACE reply
 *      CharacterError.EnterGameCharacterNotOwned (CharacterHandler.cs:219)
 *      → the DialogFactory type-3 OK dialog "You do not own this character."
 *      over the char-select screen; OK closes it.
 *   C. the bridge cannot be reached (bridge=ws://localhost:9099) → the same
 *      OK dialog with ID_NetError_CantSocket over the connecting screen.
 *
 * Writes ours-*.png + live-state.json under verification/core17kb/ and composes
 *   core17kb-disconnected-sidebyside.png  DAT ground truth (backdrop 0x06005d3f
 *                                         + layout 0x21000002 boxes) | ours
 *   core17kb-charerror-sidebyside.png     retail Wine char-select | ours + OK dialog
 *   core17kb-neterror-sidebyside.png      retail connecting ref | ours + CantSocket
 *
 * CORE.17.k.b.a adds a zoomed crop of each text cell (ours-*-zoom.png, the
 * element rectangle at 4x, pixelated) and
 *   core17kba-outline-sidebyside.png     before (the pre-CORE.17.k.b.a captures,
 *                                         before-core17kba-*.png) | after, zoomed
 * so the p33/p34 outline pass (the font's background-sheet halo tinted
 * 0xff110f07) is visible next to the plain glyphs it replaces.
 *
 * Usage: npx tsx tools/capture-core17kb-disconnect-sidebyside.ts [--compose-only]
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kb');
const WINE_CHARSEL = join(REPO, 'docs/images/retail-client-wine-charselect.png');
const CONNECTING_REF = join(REPO, 'reference/images/preworld/login-connecting-ref1.png');
const BACKDROP = join(OUT, 'dat-0x06005d3f.jpg');
const DISC = join(OUT, 'ours-disconnected.png');
const QUIT = join(OUT, 'ours-after-quit-game.png');
const BACK = join(OUT, 'ours-back-in-world.png');
const CHARERR = join(OUT, 'ours-charerror-dialog.png');
const NETERR = join(OUT, 'ours-neterror-dialog.png');
const STATE = join(OUT, 'live-state.json');
const BEFORE_DISC = join(OUT, 'before-core17kba-disconnected.png');
const BEFORE_CHARERR = join(OUT, 'before-core17kba-charerror-dialog.png');
const BEFORE_NETERR = join(OUT, 'before-core17kba-neterror-dialog.png');
const ZOOM = 4;

/**
 * CORE.17.k.b.a — a pixel-exact crop of one text cell: the element's own
 * bounding rect in CSS pixels (the pre-world screens scale the 800x600 layout
 * to the viewport, so the rect is measured, not computed).
 */
async function zoomCrop(page: Page, selector: string, out: string): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const rect = await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height) };
  }, selector);
  if (!rect || rect.width === 0 || rect.height === 0) return null;
  await page.screenshot({ path: out, clip: rect });
  return rect;
}
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const BAD_URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9099&account=testacjs&password=testacjs';
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

async function waitForWorld(page: Page, label: string, budgetMs = 360_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  let lastReload = Date.now();
  while (Date.now() < deadline) {
    if (await inWorld(page)) return;
    if (Date.now() - lastReload > 90_000) {
      console.log(`[core17kb] ${label}: not in world yet — reloading (phantom-session retry)`);
      await page.reload({ waitUntil: 'domcontentloaded' });
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  await page.screenshot({ path: join(OUT, `_login-failed-${label}.png`) });
  throw new Error(`${label}: never entered world`);
}

interface Snap {
  step: string;
  /** Every chat text appended since the hook was installed (GameUI callbacks.onChatLine, the /logging sniffer). */
  chatTexts: string[];
  screen: string | null;
  disconnectedText: string | null;
  quitLabel: string | null;
  dialogText: string | null;
  dialogOk: string | null;
  charselMode: string | null;
  chatLines: string[];
  hudVisible: boolean;
  consoleAc: string[];
}

// A source STRING, not a function: under tsx, esbuild decorates named
// function bindings inside page.evaluate with a `__name` helper the page
// does not have (docs/remote-agent-ops.md, measure-perf landmine).
const SNAPSHOT_SRC = `(() => {
  const chat = document.getElementById('chat-messages');
  const hud = document.getElementById('game-hud');
  const w = window;
  const txt = (sel) => { const el = document.querySelector(sel); return el ? (el.textContent || '').trim() : null; };
  const cs = document.querySelector('#charsel-inner');
  const chatTexts = Array.isArray(w.__chatTexts) ? w.__chatTexts.slice() : [];
  return {
    chatTexts,
    screen: (w.__ac && w.__ac.gameUI && w.__ac.gameUI.uiManager && w.__ac.gameUI.uiManager.currentScreen) || null,
    disconnectedText: txt('#disconnected-text'),
    quitLabel: txt('#disconnected-quit'),
    dialogText: txt('.ac-message-dialog-text'),
    dialogOk: txt('#ac-message-dialog-ok'),
    charselMode: cs ? (cs.dataset.mode || null) : null,
    chatLines: chat ? Array.from(chat.children).map((c) => (c.textContent || '').trim()) : [],
    hudVisible: !!hud && getComputedStyle(hud).display !== 'none',
  };
})()`;

async function snapshot(page: Page, step: string, consoleAc: string[]): Promise<Snap> {
  const s = await page.evaluate(SNAPSHOT_SRC) as Omit<Snap, 'step' | 'consoleAc'>;
  const snap: Snap = { step, ...s, consoleAc: [...consoleAc] };
  console.log(`[core17kb] ${step}: screen=${snap.screen} disc="${snap.disconnectedText}" quit="${snap.quitLabel}" dialog="${snap.dialogText}" ok="${snap.dialogOk}" charsel=${snap.charselMode} chat=${snap.chatLines.length} texts=${snap.chatTexts.length} hud=${snap.hudVisible}`);
  return snap;
}

async function send(page: Page, cmd: string): Promise<void> {
  await page.focus('#chat-input');
  await page.fill('#chat-input', cmd);
  await page.keyboard.press('Enter');
}

const OLD_CHAT_LINES = /Disconnected from ACE server|Could not reach the ACE server|ACE error:|Reconnecting to ACE server in|Previous session still closing/;

async function captureLive(): Promise<void> {
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', (d) => void d.dismiss());
  const consoleAc: string[] = [];
  page.on('console', (msg) => {
    const t = msg.text();
    if (/^\[AC\] (ACE: (Disconnected|ServerDied|CharacterError|connection failure|account still)|Reconnecting|Account still)/.test(t)) consoleAc.push(t);
  });
  console.log(`[core17kb] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await waitForWorld(page, 'initial');
  console.log('[core17kb] in world; letting the login notices expire');
  await page.waitForTimeout(9000);
  await page.evaluate(() => (window as any).__ac?.skybox?.setWeatherEnabled?.(false));
  await page.evaluate((t) => (window as any).acDebug?.freezeTimeOfDay?.(t), 0.5);

  // Chat rows are AC-font canvases (no textContent): record every appended
  // chat text through GameUI's onChatLine sniffer hook instead.
  await page.evaluate(`(() => {
    const w = window; const ui = w.__ac && w.__ac.gameUI; if (!ui || !ui.callbacks) return;
    w.__chatTexts = []; const prev = ui.callbacks.onChatLine;
    ui.callbacks.onChatLine = (t) => { w.__chatTexts.push(t); if (prev) prev(t); };
  })()`);
  const snaps: Snap[] = [];
  snaps.push(await snapshot(page, 'baseline in world', consoleAc));

  // ── A. the server drops the live session ─────────────────────────────
  await page.evaluate(() => {
    const conn = (window as any).__aceConnection;
    conn.sendCharacterLogOff();
    conn.sendPacket(0x00008000, new Uint8Array(0)); // PacketHeaderFlags.Disconnect — ACE's session ends cleanly
    setTimeout(() => conn.ws?.close(), 400); // the socket goes away WITHOUT disconnect(): a non-deliberate close
  });
  await page.waitForSelector('#disconnected-inner', { timeout: 20000 });
  await page.waitForTimeout(800);
  snaps.push(await snapshot(page, 'after the server dropped the session', consoleAc));
  const t1 = Date.now();
  await page.screenshot({ path: DISC });
  console.log(`[core17kb] ${DISC} (${Date.now() - t1} ms)`);
  const discRect = await zoomCrop(page, '#disconnected-text', join(OUT, 'ours-disconnected-zoom.png'));
  const discOutline = await page.evaluate(() => {
    const cell = document.querySelector('#disconnected-text [data-ac-outline]') as HTMLElement | null;
    const run = document.querySelector('#disconnected-text canvas[data-ac-outline]') as HTMLElement | null;
    return { cell: cell?.dataset.acOutline ?? null, color: cell?.dataset.acColor ?? null, canvasRun: !!run, marginLeft: run?.style.marginLeft ?? null };
  });
  console.log(`[core17kba] Disconnected text rect ${JSON.stringify(discRect)} outline ${JSON.stringify(discOutline)}`);
  if (discOutline.cell !== '#110f07' || !discOutline.canvasRun) throw new Error('Disconnected text is not drawn with the p33/p34 outline pass: ' + JSON.stringify(discOutline));

  // Quit Game → the connect cycle (retail: epilogue → exit → relaunch).
  await page.click('#disconnected-quit');
  await page.waitForSelector('#charsel-inner', { timeout: 20000 });
  await page.waitForTimeout(300);
  snaps.push(await snapshot(page, 'after Quit Game', consoleAc));
  await page.screenshot({ path: QUIT });
  await waitForWorld(page, 'after-quit', 240_000);
  await page.waitForTimeout(9000);
  await page.evaluate(() => (window as any).__ac?.skybox?.setWeatherEnabled?.(false));
  await page.evaluate((t) => (window as any).acDebug?.freezeTimeOfDay?.(t), 0.5);
  const back = await snapshot(page, 'back in world after the relaunch', consoleAc);
  snaps.push(back);
  await page.screenshot({ path: BACK });
  if (back.chatTexts.some((l) => OLD_CHAT_LINES.test(l))) throw new Error('an old connection chat line survived: ' + JSON.stringify(back.chatTexts));
  console.log(`[core17kb] chat texts appended across drop → Quit Game → relaunch: ${JSON.stringify(back.chatTexts)}`);

  // ── B. a real ACE CharacterError at char select ──────────────────────
  await send(page, '/logoff');
  // The char-select DOM from the earlier connect cycle persists hidden, so
  // wait for the HUD to actually go away (ACE's logoff completes, the fresh
  // CharacterList arrives and the session is back in AuthConnected —
  // Session.cs:279), not for the mode attribute.
  await page.waitForFunction(() => {
    const hud = document.getElementById('game-hud');
    return !!hud && getComputedStyle(hud).display === 'none';
  }, undefined, { timeout: 90000 });
  await page.waitForTimeout(2500);
  snaps.push(await snapshot(page, 'at char select after /logoff', consoleAc));
  await page.evaluate(() => {
    const conn = (window as any).__aceConnection;
    const account: string = (window as any).__aceAccount;
    const bytes = new TextEncoder().encode(account);
    const padded = (2 + bytes.length + 3) & ~3;
    const msg = new Uint8Array(4 + 4 + padded);
    const v = new DataView(msg.buffer);
    v.setUint32(0, 0xF657, true);      // CharacterEnterWorld
    v.setUint32(4, 0xDEADBEEF, true);  // a guid not on this account
    v.setUint16(8, bytes.length, true);
    msg.set(bytes, 10);
    conn.sendMessage(msg, (window as any).__GameMessageGroup.UIQueue);
  });
  await page.waitForSelector('#ac-message-dialog', { timeout: 20000 });
  await page.waitForTimeout(500);
  snaps.push(await snapshot(page, 'after ACE replied CharacterError.EnterGameCharacterNotOwned', consoleAc));
  await page.screenshot({ path: CHARERR });
  const dlgRect = await zoomCrop(page, '#ac-message-dialog', join(OUT, 'ours-charerror-dialog-zoom.png'));
  const dlgOutline = await page.evaluate(() => {
    const cell = document.querySelector('.ac-message-dialog-text') as HTMLElement | null;
    const runs = [...document.querySelectorAll('.ac-message-dialog-text canvas[data-ac-outline]')] as HTMLElement[];
    return { cell: cell?.dataset.acOutline ?? null, color: cell?.dataset.acColor ?? null, lines: cell?.dataset.acLines ?? null, runs: runs.length, lefts: runs.map((r) => r.style.left) };
  });
  console.log(`[core17kba] OK dialog rect ${JSON.stringify(dlgRect)} outline ${JSON.stringify(dlgOutline)}`);
  if (dlgOutline.cell !== '#110f07' || dlgOutline.color !== '#fff7cc' || dlgOutline.runs === 0) throw new Error('dialog text is not the outlined cream instance style: ' + JSON.stringify(dlgOutline));
  await page.click('#ac-message-dialog-ok');
  await page.waitForTimeout(300);
  const afterOk = await snapshot(page, 'after OK', consoleAc);
  snaps.push(afterOk);
  if (afterOk.chatTexts.some((l) => OLD_CHAT_LINES.test(l) || /do not own/i.test(l))) throw new Error('a connection/CharacterError chat line was printed: ' + JSON.stringify(afterOk.chatTexts));
  console.log(`[core17kb] chat texts appended across /logoff → CharacterError → OK: ${JSON.stringify(afterOk.chatTexts)}`);
  await page.evaluate(() => (window as any).__aceConnection.disconnect());
  await page.close();

  // ── C. the bridge cannot be reached ──────────────────────────────────
  const page2 = await browser.newPage({ viewport: VIEW });
  page2.setDefaultTimeout(120000);
  const consoleAc2: string[] = [];
  page2.on('console', (msg) => {
    const t = msg.text();
    if (/^\[AC\] ACE: (Disconnected|ServerDied|connection failure)/.test(t)) consoleAc2.push(t);
  });
  console.log(`[core17kb] navigating ${BAD_URL}`);
  await page2.goto(BAD_URL, { waitUntil: 'domcontentloaded' });
  await page2.waitForSelector('#ac-message-dialog', { timeout: 180000 });
  await page2.waitForTimeout(500);
  snaps.push(await snapshot(page2, 'bridge unreachable', consoleAc2));
  await page2.screenshot({ path: NETERR });
  const netRect = await zoomCrop(page2, '#ac-message-dialog', join(OUT, 'ours-neterror-dialog-zoom.png'));
  await page2.close();

  writeFileSync(STATE, JSON.stringify({ url: URL, badUrl: BAD_URL, view: VIEW, snapshots: snaps, rects: { disconnected: discRect, dialog: dlgRect, neterror: netRect } }, null, 2));
  console.log(`[core17kb] wrote ${STATE}`);
  await browser.close();
}

function dataUrl(file: string): string {
  const ext = file.endsWith('.jpg') ? 'jpeg' : 'png';
  return `data:image/${ext};base64,${readFileSync(file).toString('base64')}`;
}

const CSS = `<style>
  body{margin:0;background:#1a1a1a;color:#eee;font:13px/1.3 monospace;padding:10px}
  .row{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap}
  .cell{display:flex;flex-direction:column;gap:4px}
  .lbl{color:#ffd;white-space:normal;max-width:800px}
  .full img{display:block;width:800px;height:auto;border:1px solid #444}
  .dat{position:relative;width:800px;height:600px;border:1px solid #444;overflow:hidden}
  .dat img{position:absolute;left:0;top:0;width:800px;height:600px}
  .box{position:absolute;box-sizing:border-box}
  h1{font-size:14px;margin:0 0 8px}
</style>`;

async function compose(): Promise<void> {
  for (const f of [BACKDROP, DISC, CHARERR, NETERR, WINE_CHARSEL, CONNECTING_REF]) {
    if (!existsSync(f)) throw new Error(`missing ${f}`);
  }
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1700, height: 900 } });

  // DAT ground truth for the Disconnected screen: the 800x600 backdrop with
  // the layout 0x21000002 element rectangles drawn at their DAT positions.
  const dat = `<div class="dat"><img src="${dataUrl(BACKDROP)}"/>
    <div class="box" style="left:430px;top:115px;width:290px;height:205px;background:rgba(0,0,0,0.41);outline:1px dashed #ff0"></div>
    <div class="box" style="left:445px;top:130px;width:260px;height:126px;outline:1px dashed #0ff"></div>
    <div class="box" style="left:525px;top:273px;width:100px;height:32px;outline:1px dashed #f0f"></div>
    <div style="position:absolute;left:445px;top:330px;color:#ff0;font:11px monospace">yellow: plate 0x10000333 (430,115) 290x205 tex 0x06004cc0 · cyan: text 0x10000417 (15,15) 260x126 · magenta: button 0x10000418 (95,158) 100x32 "Quit Game"</div>
  </div>`;
  await page.setContent(`${CSS}<h1>CORE.17.k.b — the Disconnected screen (gmDisconnectedUI, layout 0x21000002): DAT ground truth | ours after the server dropped the session (1568x775 → 800 wide)</h1>
    <div class="row full">
      <div class="cell"><div class="lbl">DAT: backdrop 0x06005d3f + element rectangles of layout 0x21000002 (no retail screenshot of this screen survives; the layout IS the reference)</div>${dat}</div>
      <div class="cell"><div class="lbl">ours: "The connection to the server has been lost!" (string 0x646eb64) in the plate, "Quit Game" (string 105320788) — no chat log, no HUD</div><img src="${dataUrl(DISC)}"/></div>
    </div>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17kb-disconnected-sidebyside.png'), fullPage: true });

  await page.setContent(`${CSS}<h1>CORE.17.k.b — a CharacterError at char select: retail EoL client (Wine) char-select | ours after ACE's EnterGameCharacterNotOwned → DialogFactory type-3 OK dialog</h1>
    <div class="row full">
      <div class="cell"><div class="lbl">retail EoL client under Wine (1024x768): the char-select screen the dialog opens over</div><img src="${dataUrl(WINE_CHARSEL)}"/></div>
      <div class="cell"><div class="lbl">ours: "You do not own this character." (ID_CHAR_ERROR_ENTER_GAME_CHARACTER_NOT_OWNED, 0x23000002) in the 400x95 plate with the single OK button at x=160</div><img src="${dataUrl(CHARERR)}"/></div>
    </div>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17kb-charerror-sidebyside.png'), fullPage: true });

  await page.setContent(`${CSS}<h1>CORE.17.k.b — a client-side connection failure: retail connecting screen | ours with the bridge unreachable → ID_NetError_CantSocket in the OK dialog (retail: PopupError's native box)</h1>
    <div class="row full">
      <div class="cell"><div class="lbl">retail connecting reference (login-connecting-ref1.png)</div><img src="${dataUrl(CONNECTING_REF)}"/></div>
      <div class="cell"><div class="lbl">ours: "Couldn't create local socket.  Make sure you have a working network." (0x23000010) over the connecting screen; OK relaunches the connect cycle</div><img src="${dataUrl(NETERR)}"/></div>
    </div>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17kb-neterror-sidebyside.png'), fullPage: true });

  // CORE.17.k.b.a — before | after, zoomed on the text cells. The "before"
  // crops come from the pre-CORE.17.k.b.a full-frame captures at the same
  // viewport, cropped to the same measured rects with CSS.
  const zoomFile = (name: string) => join(OUT, name);
  const rects = JSON.parse(readFileSync(STATE, 'utf8')).rects ?? {};
  const cropBefore = (file: string, rect: { x: number; y: number; width: number; height: number } | undefined, label: string) => rect && existsSync(file)
    ? `<div class="cell"><div class="lbl">${label}</div><div class="crop" style="width:${rect.width * ZOOM}px;height:${rect.height * ZOOM}px"><img src="${dataUrl(file)}" style="left:${-rect.x * ZOOM}px;top:${-rect.y * ZOOM}px;width:${VIEW.width * ZOOM}px;height:${VIEW.height * ZOOM}px"/></div></div>`
    : `<div class="cell"><div class="lbl">${label}: (no before capture)</div></div>`;
  const zoomed = (file: string, label: string) => existsSync(zoomFile(file))
    ? `<div class="cell"><div class="lbl">${label}</div><img class="zoom" src="${dataUrl(zoomFile(file))}"/></div>`
    : `<div class="cell"><div class="lbl">${label}: missing</div></div>`;
  await page.setContent(`${CSS}<style>.crop{position:relative;overflow:hidden;border:1px solid #444}.crop img,.zoom{image-rendering:pixelated}.crop img{position:absolute}.zoom{display:block;zoom:${ZOOM};border:1px solid #444}</style>
    <h1>CORE.17.k.b.a — UIElement_Text p33/p34 (SetOutline + m_curOutlineColor 0xff110f07): before (CORE.17.k.b close) | after, ${ZOOM}x</h1>
    <div class="row">
      ${cropBefore(BEFORE_DISC, rects.disconnected, 'before: Disconnected text 0x10000417 — plain cream glyphs')}
      ${zoomed('ours-disconnected-zoom.png', 'after: the same cell — DrawSelf pass 0 blits each glyph\'s halo from font 0x40000001\'s background sheet 0x06005ee8 tinted 0xff110f07, pass 1 the cream glyph')}
    </div>
    <div class="row" style="margin-top:12px">
      ${cropBefore(BEFORE_CHARERR, rects.dialog, 'before: type-3 OK dialog — grey 0xffcccccc top-left (the 0x10000371 template)')}
      ${zoomed('ours-charerror-dialog-zoom.png', 'after: the 0x3e instance — cream 0xfffff7cc, centred / top-anchored (p20=1 / p21=4), outlined')}
    </div>
    <div class="row" style="margin-top:12px">
      ${cropBefore(BEFORE_NETERR, rects.neterror, 'before: NetError OK dialog over the connecting screen')}
      ${zoomed('ours-neterror-dialog-zoom.png', 'after: the same dialog')}
    </div>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17kba-outline-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17kb] wrote side-by-sides to ${OUT}`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  if (!process.argv.includes('--compose-only')) await captureLive();
  await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
