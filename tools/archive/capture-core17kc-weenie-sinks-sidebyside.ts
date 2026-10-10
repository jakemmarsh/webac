/**
 * CORE.17.k.c — live evidence that server WeenieError texts take the retail
 * sink PER CODE (spew box 0x1a / type-0 chat line / type-7 chat line / nothing)
 * instead of all landing in chat as Help-red lines.
 *
 * Drives the running stack (vite :3000, bridge :9090, ACE) with Playwright:
 *   too-busy        `@create 143` (a Chest) → acDebug.useObject three times back to back,
 *                   hoping for ACE's UseDone(YoureTooBusy 0x1d) (Player_Use.cs:156); on the
 *                   2026-09-23 run ACE answered a single UseDone(None) — the busy window is
 *                   shorter than a round trip — so the frame carries no error (kept as a beat)
 *   tell-unknown    `/tell Nobody Anywhere, hi` → GameEventWeenieError(CharacterNotAvailable)
 *                   (GameActionTell.cs:31) — a real server WeenieError
 *   chat-types      acDebug.weenieError(0x48a) "You must be a monarch to purchase this
 *                   dwelling." (type 0) + 0x587 "Olthoi cannot interact with that!" (type 7)
 *                   + 0x451 TradeClosed (no arm — nothing) through the live handler
 *   before          the pre-change delivery replayed on the same frame: every text as
 *                   gameUI.addSystemMessage(text, chatColorFor(Help)) — exactly the old call
 *
 * Writes ours-*.png / before-*.png + live-state.json and composes
 * core17kc-weenie-sinks-sidebyside.png under verification/core17kc/.
 *
 *   npx tsx tools/capture-core17kc-weenie-sinks-sidebyside.ts [--compose-only]
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kc');
const WINE = join(REPO, 'docs/images/retail-client-wine-inworld-holtburg.png');
const WEB1 = join(REPO, 'reference/images/preworld/portal-space-web1.jpg');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const URL = process.env.AC_URL ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const TAG = '[core17kc]';
const CHEST_WCID = 143;

function launch() {
  return chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
}

// Source strings for page.evaluate (tsx's `__name` helper does not exist in the page).
const ev = <T>(page: Page, src: string): Promise<T> => page.evaluate(src) as Promise<T>;

async function inWorld(page: Page): Promise<boolean> {
  return ev<boolean>(page, `(() => { const cs = window.acDebug && window.acDebug.collisionState && window.acDebug.collisionState(); return !!(cs && cs.x > 0); })()`);
}

async function driveCharacterCreate(page: Page, name: string): Promise<string> {
  return ev<string>(page, `(() => {
    const ui = window.__ac && window.__ac.gameUI;
    if (!ui || !ui.ui || ui.ui.currentScreen !== 'character-create') return 'not-at-create';
    if (!ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return 'no-hooks';
    ui.wizard.name = ${JSON.stringify(name)};
    ui.callbacks.onCharacterCreated(ui.wizard);
    return 'sent';
  })()`);
}

async function enterWorld(page: Page): Promise<void> {
  console.log(`${TAG} navigating`);
  await page.goto(`${URL}&cb=kc`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const deadline = Date.now() + 420_000; let lastReload = Date.now(); let lastCreate = 0;
  while (!(await inWorld(page))) {
    if (Date.now() > deadline) { await page.screenshot({ path: join(OUT, '_login-failed.png') }); throw new Error('never entered world'); }
    if (Date.now() - lastCreate > 15_000) {
      const r = await driveCharacterCreate(page, 'Sink Tester').catch(() => 'error');
      if (r === 'sent') { console.log(`${TAG} character creation submitted`); lastReload = Date.now(); }
      lastCreate = Date.now();
    }
    if (Date.now() - lastReload > 90_000) {
      console.log(`${TAG} not in world yet — reloading (phantom-session retry)`);
      await page.reload({ waitUntil: 'domcontentloaded' }); lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  await page.waitForTimeout(4000);
}

interface Surfaces { spewRows: string[]; chatTail: Array<{ text: string; color: string; type: number }> }
/** The spew strip's items (SpewBoxModel) and the last recorded chat lines (text + colour + text type). */
async function surfaces(page: Page): Promise<Surfaces> {
  return ev<Surfaces>(page, `(() => {
    const ui = window.__ac && window.__ac.gameUI;
    const rows = ui && ui.spewBox ? ui.spewBox.items.map((i) => i.text) : [];
    const seen = window.__chatSeen || [];
    return { spewRows: rows, chatTail: seen.slice(-6) };
  })()`);
}

/** Record every addSystemMessage (text / colour / type) — the AC-font chat rows are canvases with no textContent. */
const installChatRecorder = (page: Page) => ev(page, `(() => {
  const ui = window.__ac.gameUI; if (window.__chatSeen) return;
  window.__chatSeen = [];
  const orig = ui.addSystemMessage.bind(ui);
  ui.addSystemMessage = (text, color, type) => { window.__chatSeen.push({ text, color: color || '', type: type == null ? 0 : type }); return orig(text, color, type); };
})()`);

/** Keep a spew row alive across a 7-8 s SwiftShader screenshot (retail replaces an identical top item). */
const keepAlive = (page: Page, text: string | null) => ev(page, `(() => {
  const w = window; if (w.__spewKeep) { clearInterval(w.__spewKeep); w.__spewKeep = null; }
  if (${JSON.stringify(text)}) w.__spewKeep = setInterval(() => w.__ac && w.__ac.gameUI && w.__ac.gameUI.spewNotice(${JSON.stringify(text)}), 2000);
})()`);

async function shot(page: Page, file: string, keep: string | null): Promise<void> {
  await keepAlive(page, keep);
  const t = Date.now();
  await page.screenshot({ path: join(OUT, file) });
  await keepAlive(page, null);
  console.log(`${TAG} ${file} (${Date.now() - t} ms)`);
}

async function captureLive(): Promise<void> {
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120_000);
  page.on('dialog', (d) => void d.dismiss());
  const events: string[] = [];
  page.on('console', (msg) => {
    const t = msg.text();
    if (/\[WeenieError\]|\[AC\] UseDone|TradeFailure|InventoryServerSaveFailed|WeenieErrorWithString/.test(t)) events.push(t.slice(0, 200));
    if (/\[AC\]|rror/.test(t)) console.log(`  [page] ${t.slice(0, 160)}`);
  });
  await enterWorld(page);
  await ev(page, `window.__ac && window.__ac.skybox && window.__ac.skybox.setWeatherEnabled && window.__ac.skybox.setWeatherEnabled(false)`);
  await ev(page, `window.acDebug.freezeTimeOfDay && window.acDebug.freezeTimeOfDay(0.5)`);
  await ev(page, `window.acDebug.admin('@telepoi holtburg')`);
  await page.waitForTimeout(12_000);
  await page.waitForFunction(() => !document.getElementById('portal-spew-box'), undefined, { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(6000); // let the login / portal notices expire
  await installChatRecorder(page);
  const state: Record<string, unknown> = { url: URL, events };

  // ── too-busy: the real UseDone(YoureTooBusy) from ACE ──
  const before = new Set(await ev<number[]>(page, `window.acDebug.getObjects().map((o) => o.guid)`));
  await ev(page, `window.acDebug.admin('@create ${CHEST_WCID}')`);
  let chest: { guid: number; name: string } | null = null;
  for (let i = 0; i < 15 && !chest; i++) {
    await page.waitForTimeout(1000);
    const fresh = await ev<Array<{ guid: number; name: string }>>(page, `window.acDebug.getObjects()`);
    chest = fresh.find((o) => !before.has(o.guid) && /chest/i.test(o.name)) ?? null;
  }
  state.chest = chest;
  if (chest) {
    events.length = 0;
    const sent = await ev<boolean[]>(page, `[window.acDebug.useObject(${chest.guid}), window.acDebug.useObject(${chest.guid}), window.acDebug.useObject(${chest.guid})]`);
    state.useSent = sent;
    const t0 = Date.now();
    let s: Surfaces = { spewRows: [], chatTail: [] };
    while (Date.now() - t0 < 8000) {
      s = await surfaces(page);
      if (s.spewRows.some((r) => /too busy/.test(r))) break;
      await page.waitForTimeout(250);
    }
    state.tooBusy = { ms: Date.now() - t0, ...s, events: [...events] };
    console.log(`${TAG} too-busy: spew=${JSON.stringify(s.spewRows)} chat tail=${JSON.stringify(s.chatTail.slice(-2))} events=${JSON.stringify(events)}`);
    const busyRow = s.spewRows.find((r) => /too busy/.test(r)) ?? null;
    if (busyRow) await page.waitForTimeout(3500); // let the chest's own use notice / the first row age out
    await shot(page, 'ours-too-busy.png', busyRow);
  } else {
    console.log(`${TAG} @create ${CHEST_WCID} produced no object — too-busy beat skipped`);
  }

  // ── tell-unknown: the real WeenieError(CharacterNotAvailable) from ACE ──
  await page.waitForTimeout(6000);
  events.length = 0;
  await ev(page, `window.acDebug.sendChat('/tell Nobody Anywhere, hello')`);
  {
    const t0 = Date.now();
    let s: Surfaces = { spewRows: [], chatTail: [] };
    while (Date.now() - t0 < 8000) {
      s = await surfaces(page);
      if (events.some((e) => /WeenieError/.test(e))) { await page.waitForTimeout(300); s = await surfaces(page); break; }
      await page.waitForTimeout(250);
    }
    state.tellUnknown = { ms: Date.now() - t0, ...s, events: [...events] };
    console.log(`${TAG} tell-unknown: spew=${JSON.stringify(s.spewRows)} chat tail=${JSON.stringify(s.chatTail.slice(-2))} events=${JSON.stringify(events)}`);
  }

  // ── chat-types: 0x48a (type 0), 0x587 (type 7), 0x451 (no arm) through the live handler ──
  await page.waitForTimeout(6000);
  await ev(page, `window.acDebug.weenieError(0x48a); window.acDebug.weenieError(0x587); window.acDebug.weenieError(0x451); window.acDebug.weenieError(0x2a)`);
  await page.waitForTimeout(400);
  const after = await surfaces(page);
  state.chatTypes = after;
  console.log(`${TAG} chat-types: spew=${JSON.stringify(after.spewRows)} chat tail=${JSON.stringify(after.chatTail.slice(-3))}`);
  await shot(page, 'ours-chat-types.png', after.spewRows.find((r) => /encumbered/.test(r)) ?? null);

  // ── before: the pre-change delivery (every text a Help-red chat line) replayed on the same frame ──
  await page.waitForTimeout(6000);
  await ev(page, `(() => {
    const ui = window.__ac.gameUI; const help = '#b70000';
    for (const t of ["You're too busy!", 'You must be a monarch to purchase this dwelling.', 'Olthoi cannot interact with that!', 'Trade closed.', 'You are too encumbered to carry that!']) ui.addSystemMessage(t, help);
  })()`);
  await page.waitForTimeout(400);
  state.before = await surfaces(page);
  await shot(page, 'before-replayed.png', null);

  writeFileSync(join(OUT, 'live-state.json'), JSON.stringify(state, null, 2));
  await browser.close();
}

interface Panel { file: string; label: string; x: number; y: number; w: number; h: number }
const CSS = `<style>body{margin:0;background:#111;color:#ddd;font:13px/1.35 system-ui}h1{font-size:15px;margin:8px 10px}.row{display:flex;gap:8px;padding:0 8px}.cell{background:#000;flex:1}.lbl{font-size:11px;color:#bbb;padding:3px 4px;min-height:44px}.full img{width:100%}</style>`;
const dataUrl = (f: string) => `data:image/${f.endsWith('.jpg') ? 'jpeg' : 'png'};base64,${readFileSync(f).toString('base64')}`;
const cropCell = (p: Panel, scale: number) =>
  `<div class="cell"><div class="lbl">${p.label}</div><div style="width:${p.w * scale}px;height:${p.h * scale}px;overflow:hidden;position:relative"><img src="${dataUrl(p.file)}" style="position:absolute;left:${-p.x * scale}px;top:${-p.y * scale}px;transform-origin:0 0;transform:scale(${scale})"/></div></div>`;

async function compose(): Promise<void> {
  const TOO_BUSY = join(OUT, 'ours-too-busy.png');
  const TYPES = join(OUT, 'ours-chat-types.png');
  const BEFORE = join(OUT, 'before-replayed.png');
  for (const f of [WINE, WEB1, TYPES, BEFORE]) if (!existsSync(f)) throw new Error(`missing ${f}`);
  void TOO_BUSY;
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 2700, height: 1500 } });
  const top: Panel[] = [
    { file: WEB1, label: 'retail (portal-space-web1.jpg): a text-type-0x1a notice = red, centred, in the spew strip 20px under the top of the 3D view — the sink retail uses for "You\'re too busy!" / "You are too encumbered to carry that!" (HandleFailureEvent arms :359987 / :360033)', x: 364, y: 0, w: 600, h: 60 },
    { file: BEFORE, label: 'ours BEFORE (the old call replayed): every WeenieError text was a Help-red CHAT line — the strip stays empty', x: 484, y: 0, w: 600, h: 60 },
    { file: TYPES, label: 'ours AFTER: 0x2a "You are too encumbered to carry that!" through the live onWeenieError → the spew strip, behind the vitals plate as retail z-order (kept alive for the shot); the REAL server-sent 0x52b "That person is not available now." (/tell to an unknown name) landed on the same strip — live-state.json tellUnknown', x: 484, y: 0, w: 600, h: 60 },
  ];
  const chat: Panel[] = [
    { file: WINE, label: 'retail EoL client (Wine): the chat log — type-0 lines green, type-7 (Magic) light blue', x: 0, y: 660, w: 430, h: 108 },
    { file: BEFORE, label: 'ours BEFORE: "You\'re too busy!", "You must be a monarch…", "Olthoi cannot…", "Trade closed.", "You are too encumbered…" all in chat, all Help red', x: 0, y: 670, w: 430, h: 105 },
    { file: TYPES, label: 'ours AFTER: "You must be a monarch…" type 0 (green) + "Olthoi cannot interact with that!" type 7 (light blue) in chat; TradeClosed printed nowhere; "You are too encumbered…" on the strip', x: 0, y: 670, w: 430, h: 105 },
  ];
  await page.setContent(`${CSS}<h1>CORE.17.k.c — server WeenieError texts take the retail sink per code: the spew strip (2x crops, top band)</h1>
    <div class="row">${top.map((p) => cropCell(p, 2)).join('')}</div>
    <div style="height:12px"></div>
    <h1>the chat log (3x crops, bottom-left)</h1>
    <div class="row">${chat.map((p) => cropCell(p, 3)).join('')}</div>
    <div style="height:12px"></div>
    <h1>whole screen: retail EoL client (Wine 1024x768) | ours before | ours after (1568x775)</h1>
    <div class="row full">
      <div class="cell"><div class="lbl">retail EoL client under Wine</div><img src="${dataUrl(WINE)}"/></div>
      <div class="cell"><div class="lbl">ours BEFORE (replayed)</div><img src="${dataUrl(BEFORE)}"/></div>
      <div class="cell"><div class="lbl">ours AFTER (chat-types beat)</div><img src="${dataUrl(TYPES)}"/></div>
    </div>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17kc-weenie-sinks-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`${TAG} wrote ${join(OUT, 'core17kc-weenie-sinks-sidebyside.png')}`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  if (!process.argv.includes('--compose-only')) await captureLive();
  await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
