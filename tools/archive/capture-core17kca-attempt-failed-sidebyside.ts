/**
 * CORE.17.k.c.a — live evidence that a refused inventory request prints
 * ACCWeenieObject::ServerSaysAttemptFailed's own 0x1a line (the verb by the
 * pending request + the object's name + the per-code suffix) ahead of the
 * code's HandleFailureEvent arm, and that a vendor reject prints nothing.
 *
 * Drives the running stack (vite :3000, bridge :9090, ACE) with Playwright:
 *   closed-chest   `@create 143` (a Chest, closed) → acDebug.putInPack(<a carried item>, chest):
 *                  the REAL PutItemInContainer goes out through sendGameAction (recording
 *                  IR_PUT_IN_CONTAINER), ACE Player_Inventory.cs:883 answers 0x00A0
 *                  TheContainerIsClosed (0x3ee) → "The <item> can't be put in the container
 *                  - the container is closed" AND "The container is closed!" on the strip
 *   wield-replay   acDebug.recordInventoryRequest(item, 7) + inventoryServerSaveFailed(item,
 *                  0x468 SkillTooLow) through the live handler → "The <item> can't be wielded"
 *                  (no suffix, no arm — the ACE Player_Inventory.cs:1660 wieldError shape)
 *   vendor-none    inventoryServerSaveFailed(<player guid>, 0) — Player_Commerce.cs:48-49's
 *                  shape — through the live handler → nothing on the strip, nothing in chat
 *   before         the pre-change delivery replayed on the same frame: only the code's arm
 *                  ("The container is closed!") and the FAITHFUL.550 vendor chat line
 *
 * Writes ours-*.png / before-*.png + live-state.json and composes
 * core17kca-attempt-failed-sidebyside.png under verification/core17kca/.
 *
 *   npx tsx tools/capture-core17kca-attempt-failed-sidebyside.ts [--compose-only]
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kca');
const WINE = join(REPO, 'docs/images/retail-client-wine-inworld-holtburg.png');
const WEB1 = join(REPO, 'reference/images/preworld/portal-space-web1.jpg');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const URL = process.env.AC_URL ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const TAG = '[core17kca]';
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
  await page.goto(`${URL}&cb=kca`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const deadline = Date.now() + 420_000; let lastReload = Date.now(); let lastCreate = 0;
  while (!(await inWorld(page))) {
    if (Date.now() > deadline) { await page.screenshot({ path: join(OUT, '_login-failed.png') }); throw new Error('never entered world'); }
    if (Date.now() - lastCreate > 15_000) {
      const r = await driveCharacterCreate(page, 'Attempt Tester').catch(() => 'error');
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

interface Surfaces { spewRows: string[]; chatTail: Array<{ text: string; color: string; type: number }>; pending: unknown }
/** The spew strip's items (SpewBoxModel), the last recorded chat lines and the pending inventory request. */
async function surfaces(page: Page): Promise<Surfaces> {
  return ev<Surfaces>(page, `(() => {
    const ui = window.__ac && window.__ac.gameUI;
    const rows = ui && ui.spewBox ? ui.spewBox.items.map((i) => i.text) : [];
    const seen = window.__chatSeen || [];
    return { spewRows: rows, chatTail: seen.slice(-6), pending: window.acDebug.inventoryRequest() };
  })()`);
}

/** Record every addSystemMessage (text / colour / type) — the AC-font chat rows are canvases with no textContent. */
const installChatRecorder = (page: Page) => ev(page, `(() => {
  const ui = window.__ac.gameUI; if (window.__chatSeen) return;
  window.__chatSeen = [];
  const orig = ui.addSystemMessage.bind(ui);
  ui.addSystemMessage = (text, color, type) => { window.__chatSeen.push({ text, color: color || '', type: type == null ? 0 : type }); return orig(text, color, type); };
})()`);

/** Keep spew rows alive across a 7-8 s SwiftShader screenshot (retail replaces an identical top item). */
const keepAlive = (page: Page, texts: string[]) => ev(page, `(() => {
  const w = window; if (w.__spewKeep) { clearInterval(w.__spewKeep); w.__spewKeep = null; }
  const texts = ${JSON.stringify(texts)};
  if (texts.length) w.__spewKeep = setInterval(() => { const ui = w.__ac && w.__ac.gameUI; if (ui) for (const t of texts) ui.spewNotice(t); }, 2000);
})()`);

async function shot(page: Page, file: string, keep: string[]): Promise<void> {
  await keepAlive(page, keep);
  const t = Date.now();
  await page.screenshot({ path: join(OUT, file) });
  await keepAlive(page, []);
  console.log(`${TAG} ${file} (${Date.now() - t} ms)`);
}

interface Item { id: number; name: string; stackSize: number }

async function captureLive(): Promise<void> {
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120_000);
  page.on('dialog', (d) => void d.dismiss());
  const events: string[] = [];
  page.on('console', (msg) => {
    const t = msg.text();
    if (/InventoryServerSaveFailed|\[WeenieError\]|WeenieErrorWithString|InventoryPut/.test(t)) events.push(t.slice(0, 220));
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
  const charGuid = await ev<number>(page, `window.__ac.charGuid`);
  state.charGuid = charGuid;

  // ── closed-chest: the REAL 0x00A0 TheContainerIsClosed from ACE ──
  const before = new Set(await ev<number[]>(page, `window.acDebug.getObjects().map((o) => o.guid)`));
  await ev(page, `window.acDebug.admin('@create ${CHEST_WCID}')`);
  let chest: { guid: number; name: string } | null = null;
  for (let i = 0; i < 15 && !chest; i++) {
    await page.waitForTimeout(1000);
    const fresh = await ev<Array<{ guid: number; name: string }>>(page, `window.acDebug.getObjects()`);
    chest = fresh.find((o) => !before.has(o.guid) && /chest/i.test(o.name)) ?? null;
  }
  state.chest = chest;
  const items = await ev<Item[]>(page, `window.__ac.playerState.inventory.getAll().map((i) => ({ id: i.id, name: i.name, stackSize: i.stackSize, ct: i.containerType || 0, isContainer: !!i.isContainer }))`);
  // ACE Player_Inventory.cs:870 answers AttunedItem (no suffix) for an attuned item BEFORE the
  // closed-container check @ :883 — a fresh character's Blackmoor's Favor did exactly that on
  // the first run — so try the plain items first and keep the first that draws the 0x3ee line.
  const candidates = (items as Array<Item & { ct: number; isContainer: boolean }>)
    .filter((i) => !i.isContainer && !i.ct && !/pack|sack|bag/i.test(i.name))
    .sort((a, b) => Number(/favor|letter|token|note|scroll|gem/i.test(a.name)) - Number(/favor|letter|token|note|scroll|gem/i.test(b.name)));
  state.candidates = candidates.map((i) => i.name);
  let item: Item | null = null;
  let chestRows: string[] = [];
  const tries: unknown[] = [];
  if (chest) {
    for (const cand of candidates.slice(0, 4)) {
      events.length = 0;
      const pendingBefore = await ev(page, `window.acDebug.inventoryRequest()`);
      const sent = await ev<boolean>(page, `window.acDebug.putInPack(${cand.id}, ${chest.guid})`);
      const pendingAfterSend = await ev(page, `window.acDebug.inventoryRequest()`);
      const t0 = Date.now();
      let s: Surfaces = { spewRows: [], chatTail: [], pending: null };
      while (Date.now() - t0 < 10_000) {
        s = await surfaces(page);
        if (s.spewRows.some((r) => /can't be put in the container/.test(r))) { await page.waitForTimeout(300); s = await surfaces(page); break; }
        await page.waitForTimeout(250);
      }
      const rec = { item: cand, sent, pendingBefore, pendingAfterSend, ms: Date.now() - t0, ...s, events: [...events] };
      tries.push(rec);
      console.log(`${TAG} closed-chest[${cand.name}]: sent=${sent} pendingAfterSend=${JSON.stringify(pendingAfterSend)} spew=${JSON.stringify(s.spewRows)} pending=${JSON.stringify(s.pending)} events=${JSON.stringify(events)}`);
      item = cand;
      chestRows = s.spewRows.filter((r) => /container/.test(r));
      if (s.spewRows.some((r) => /the container is closed$/.test(r))) break;
      await page.waitForTimeout(8000); // let the rows age out before the next candidate
    }
    state.closedChest = tries[tries.length - 1];
    state.closedChestTries = tries;
    state.item = item;
    await shot(page, 'ours-closed-chest.png', chestRows);
  } else {
    item = candidates[0] ?? null;
    state.item = item;
    console.log(`${TAG} closed-chest beat skipped (no chest)`);
  }

  // ── wield-replay: a refused wield (Player_Inventory.cs:1660 shape) through the live handler ──
  await page.waitForTimeout(9000);
  if (item) {
    events.length = 0;
    await ev(page, `window.acDebug.recordInventoryRequest(${item.id}, 7); window.acDebug.inventoryServerSaveFailed(${item.id}, 0x468)`);
    await page.waitForTimeout(400);
    const s = await surfaces(page);
    state.wieldReplay = { ...s, events: [...events] };
    console.log(`${TAG} wield-replay: spew=${JSON.stringify(s.spewRows)} pending=${JSON.stringify(s.pending)}`);
    await shot(page, 'ours-wield-replay.png', s.spewRows.filter((r) => /wielded/.test(r)));
  }

  // ── vendor-none: Player_Commerce.cs:48-49's shape (the player's guid, code None) through the live handler ──
  await page.waitForTimeout(9000);
  {
    const chatBefore = (await surfaces(page)).chatTail.length;
    events.length = 0;
    await ev(page, `window.acDebug.inventoryServerSaveFailed(${charGuid}, 0)`);
    await page.waitForTimeout(400);
    const s = await surfaces(page);
    const chatSeen = await ev<number>(page, `(window.__chatSeen || []).length`);
    state.vendorNone = { ...s, chatLinesAdded: chatSeen - chatBefore, events: [...events] };
    console.log(`${TAG} vendor-none: spew=${JSON.stringify(s.spewRows)} chat tail=${JSON.stringify(s.chatTail.slice(-2))} events=${JSON.stringify(events)}`);
  }

  // ── before: the pre-change delivery replayed on the same frame ──
  await page.waitForTimeout(3000);
  await ev(page, `(() => {
    const ui = window.__ac.gameUI;
    ui.displayErrorText('The container is closed!');
    ui.addSystemMessage('The vendor cannot complete that transaction. Check your coin or what the vendor accepts.', '#b70000');
  })()`);
  await page.waitForTimeout(400);
  state.before = await surfaces(page);
  await shot(page, 'before-replayed.png', ['The container is closed!']);

  writeFileSync(join(OUT, 'live-state.json'), JSON.stringify(state, null, 2));
  await browser.close();
}

interface Panel { file: string; label: string; x: number; y: number; w: number; h: number }
const CSS = `<style>body{margin:0;background:#111;color:#ddd;font:13px/1.35 system-ui}h1{font-size:15px;margin:8px 10px}.row{display:flex;gap:8px;padding:0 8px}.cell{background:#000;flex:1}.lbl{font-size:11px;color:#bbb;padding:3px 4px;min-height:58px}.full img{width:100%}</style>`;
const dataUrl = (f: string) => `data:image/${f.endsWith('.jpg') ? 'jpeg' : 'png'};base64,${readFileSync(f).toString('base64')}`;
const cropCell = (p: Panel, scale: number) =>
  `<div class="cell"><div class="lbl">${p.label}</div><div style="width:${p.w * scale}px;height:${p.h * scale}px;overflow:hidden;position:relative"><img src="${dataUrl(p.file)}" style="position:absolute;left:${-p.x * scale}px;top:${-p.y * scale}px;transform-origin:0 0;transform:scale(${scale})"/></div></div>`;

async function compose(): Promise<void> {
  const CHEST = join(OUT, 'ours-closed-chest.png');
  const WIELD = join(OUT, 'ours-wield-replay.png');
  const BEFORE = join(OUT, 'before-replayed.png');
  for (const f of [WINE, WEB1, CHEST, WIELD, BEFORE]) if (!existsSync(f)) throw new Error(`missing ${f}`);
  const st = JSON.parse(readFileSync(join(OUT, 'live-state.json'), 'utf8')) as { item?: Item | null; closedChest?: { spewRows: string[] }; wieldReplay?: { spewRows: string[] } };
  const itemName = st.item?.name ?? 'item';
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 2700, height: 1600 } });
  const top: Panel[] = [
    { file: WEB1, label: 'retail (portal-space-web1.jpg): a text-type-0x1a notice = red, centred, in the spew strip 20px under the top of the 3D view — the sink ServerSaysAttemptFailed @ 0058eae0 uses (ECM_UI::SendNotice_DisplayStringInfo(0x1a))', x: 364, y: 0, w: 600, h: 60 },
    { file: BEFORE, label: 'ours BEFORE (replayed): a carried item put into a closed chest showed only the code\'s own arm "The container is closed!" — no "The … can\'t be put in the container - the container is closed"; a vendor reject printed a made-up Help-red chat line', x: 484, y: 0, w: 600, h: 60 },
    { file: CHEST, label: `ours AFTER (the REAL 0x00A0 0x3ee from ACE Player_Inventory.cs:883 after acDebug.putInPack → a closed @create 143 chest): "The ${itemName} can't be put in the container - the container is closed" + "The container is closed!" — strip rows ${JSON.stringify(st.closedChest?.spewRows ?? [])}`, x: 484, y: 0, w: 600, h: 60 },
  ];
  const second: Panel[] = [
    { file: WEB1, label: 'retail strip (same crop) for the second beat', x: 364, y: 0, w: 600, h: 60 },
    { file: BEFORE, label: 'ours BEFORE: a refused wield (SkillTooLow has no HandleFailureEvent arm) printed nothing at all', x: 484, y: 0, w: 600, h: 60 },
    { file: WIELD, label: `ours AFTER (IR_WIELD recorded + 0x00A0 SkillTooLow through the live handler — the ACE Player_Inventory.cs:1660 wieldError shape): "The ${itemName} can't be wielded" — strip rows ${JSON.stringify(st.wieldReplay?.spewRows ?? [])}`, x: 484, y: 0, w: 600, h: 60 },
  ];
  const chat: Panel[] = [
    { file: WINE, label: 'retail EoL client (Wine): the chat log — no line for a refused inventory request (the 0x1a strip only)', x: 0, y: 660, w: 430, h: 108 },
    { file: BEFORE, label: 'ours BEFORE: the FAITHFUL.550 "The vendor cannot complete that transaction…" Help-red chat line (no retail arm)', x: 0, y: 670, w: 430, h: 105 },
    { file: CHEST, label: 'ours AFTER: nothing in chat for either beat; the vendor-None shape (live-state.json vendorNone) printed nothing anywhere', x: 0, y: 670, w: 430, h: 105 },
  ];
  await page.setContent(`${CSS}<h1>CORE.17.k.c.a — a refused inventory request prints ServerSaysAttemptFailed's verb + name + suffix line, then the code's own arm (2x crops, top band)</h1>
    <div class="row">${top.map((p) => cropCell(p, 2)).join('')}</div>
    <div style="height:12px"></div>
    <h1>a refused wield: the bare verb line (2x crops)</h1>
    <div class="row">${second.map((p) => cropCell(p, 2)).join('')}</div>
    <div style="height:12px"></div>
    <h1>the chat log (3x crops, bottom-left)</h1>
    <div class="row">${chat.map((p) => cropCell(p, 3)).join('')}</div>
    <div style="height:12px"></div>
    <h1>whole screen: retail EoL client (Wine 1024x768) | ours before | ours after (1568x775)</h1>
    <div class="row full">
      <div class="cell"><div class="lbl">retail EoL client under Wine</div><img src="${dataUrl(WINE)}"/></div>
      <div class="cell"><div class="lbl">ours BEFORE (replayed)</div><img src="${dataUrl(BEFORE)}"/></div>
      <div class="cell"><div class="lbl">ours AFTER (closed-chest beat)</div><img src="${dataUrl(CHEST)}"/></div>
    </div>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17kca-attempt-failed-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`${TAG} wrote ${join(OUT, 'core17kca-attempt-failed-sidebyside.png')}`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  if (!process.argv.includes('--compose-only')) await captureLive();
  await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
