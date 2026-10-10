/**
 * CORE.17.k.c.a.a.b — live evidence that a vendor Sell / Buy records
 * IR_SHOP_EVENT on the vendor (gmVendorUI's four send sites), that between the
 * send and the vendor's answer every inventory request refuses client-side with
 * IsPlayerReadyToMakeInventoryRequest @ 0058d050's line "You can only move or
 * use one item at a time" (nothing sent), that the vendor's VendorInfo answer
 * (gmVendorUI::OpenVendor @ 004c4ba0's RecordResponse) releases it, and that a
 * transaction ACE refuses is released by the 0x00A0 instead, silently.
 *
 * Drives the running stack (vite :3000, bridge :9090, ACE) with Playwright:
 *   open      @telepoi holtburg, stand next to the nearest vendor, the real
 *             approach-then-Use → ACE's ApproachVendor → the bar open
 *   pending   in ONE synchronous evaluate: a REAL Sell of a sellable item (the
 *             bar's own onSell → GameAction Sell, IR_SHOP_EVENT recorded on the
 *             vendor) then immediately a drop of another item + a Use of the
 *             vendor → both refused: the line on the strip, the GameAction
 *             sequence unchanged, the item still carried
 *   released  ACE answers the Sell with ApproachVendor (VendorInfo) → the
 *             pending shop event clears → the same drop goes out (sequence +1)
 *   refused   a REAL Sell of an item the vendor does not buy → ACE's
 *             VerifySellItems empties the list → InventoryServerSaveFailed
 *             (the player's guid, code None) → the pending shop event clears
 *             with NO line (IR_SHOP_EVENT has no verb, None no suffix)
 *   before    the pre-change client recorded nothing for a transaction: the
 *             strip stays empty and the drop during the window went out
 *
 * Writes ours-*.png / before-*.png + live-state.json and composes
 * core17kcaab-vendor-shop-event-sidebyside.png under verification/core17kcaab/.
 *
 *   npx tsx tools/capture-core17kcaab-vendor-shop-event-sidebyside.ts [--compose-only]
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kcaab');
const WINE = join(REPO, 'docs/images/retail-client-wine-inworld-holtburg.png');
const WEB1 = join(REPO, 'reference/images/preworld/portal-space-web1.jpg');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const URL = process.env.AC_URL ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const TAG = '[core17kcaab]';
const PENDING_LINE = 'You can only move or use one item at a time';
const VENDOR_FLAG = 0x200; // ObjectDescriptionFlag.Vendor
const SHOP_EVENT = 8; // InventoryRequest.ShopEvent

function launch() {
  return chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
}

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
  await page.goto(`${URL}&cb=kcaab`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const deadline = Date.now() + 420_000; let lastReload = Date.now(); let lastCreate = 0;
  while (!(await inWorld(page))) {
    if (Date.now() > deadline) { await page.screenshot({ path: join(OUT, '_login-failed.png') }); throw new Error('never entered world'); }
    if (Date.now() - lastCreate > 15_000) {
      const r = await driveCharacterCreate(page, 'Shop Tester').catch(() => 'error');
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

interface Surfaces { spewRows: string[]; pending: unknown; refusal: string | null; seq: number; vendorVisible: boolean }
async function surfaces(page: Page): Promise<Surfaces> {
  return ev<Surfaces>(page, `(() => {
    const ui = window.__ac && window.__ac.gameUI;
    const rows = ui && ui.spewBox ? ui.spewBox.items.map((i) => i.text) : [];
    const d = window.acDebug;
    return { spewRows: rows, pending: d.inventoryRequest(), refusal: d.inventoryRequestRefusal(), seq: d.gameActionSequence(), vendorVisible: !!(ui && ui.isVendorVisible) };
  })()`);
}

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

async function waitFor(page: Page, pred: string, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await ev<boolean>(page, pred)) return true;
    await page.waitForTimeout(200);
  }
  return false;
}

interface Obj { guid: number; name: string; objectDescFlags: number; horiz: number; useRadius: number; acPos: { landblock: number; x: number; y: number; z: number } | null }
interface Item { id: number; name: string; stackSize: number; ct: number; isContainer: boolean }

async function captureLive(): Promise<void> {
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120_000);
  page.on('dialog', (d) => void d.dismiss());
  const events: string[] = [];
  page.on('console', (msg) => {
    const t = msg.text();
    if (/refused|ApproachVendor|InventoryServerSaveFailed|Sent Sell|Sent Buy|Sent DropItem|Sent Use|InventoryPut|InventoryRemoveObject|shop event/.test(t)) events.push(t.slice(0, 220));
    if (/\[AC\]|rror/.test(t)) console.log(`  [page] ${t.slice(0, 160)}`);
  });
  await enterWorld(page);
  await ev(page, `window.__ac && window.__ac.skybox && window.__ac.skybox.setWeatherEnabled && window.__ac.skybox.setWeatherEnabled(false)`);
  await ev(page, `window.acDebug.freezeTimeOfDay && window.acDebug.freezeTimeOfDay(0.5)`);
  await ev(page, `window.acDebug.admin('@telepoi holtburg')`);
  await page.waitForTimeout(12_000);
  await page.waitForFunction(() => !document.getElementById('portal-spew-box'), undefined, { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(6000);
  const state: Record<string, unknown> = { url: URL, events };
  const charGuid = await ev<number>(page, `window.__ac.charGuid`);
  state.charGuid = charGuid;

  // ── the nearest loaded vendor; stand 2.5 m from it and Use it (the real approach path) ──
  const objs = await ev<Obj[]>(page, `(() => {
    const dbg = window.acDebug; const cs = dbg.collisionState();
    return dbg.getObjects().filter((o) => o.pos).map((o) => {
      const p = dbg.objectAcPosition ? dbg.objectAcPosition(o.guid) : null;
      return { guid: o.guid, name: o.name, objectDescFlags: o.objectDescFlags, horiz: Math.hypot(o.pos.x - cs.x, o.pos.z - cs.z), useRadius: p ? p.useRadius : -1, acPos: p ? p.position : null };
    }).sort((a, b) => a.horiz - b.horiz);
  })()`);
  // Nearest-first; a vendor whose merchandise excludes everything we carry
  // (the Grocer buys food only) is closed again and the next one tried.
  const vendors = objs.filter((o) => (o.objectDescFlags & VENDOR_FLAG) !== 0);
  if (!vendors.length) throw new Error('no vendor among the loaded objects at Holtburg');
  let vendor: Obj | null = null;
  let sellable: Array<{ guid: number; name: string; price: number }> = [];
  let open: Surfaces | null = null;
  const tried: Array<{ name: string; opened: boolean; sellable: string[] }> = [];
  for (const cand of vendors.slice(0, 5)) {
    console.log(`${TAG} vendor candidate: ${cand.name} 0x${cand.guid.toString(16)} at ${cand.horiz.toFixed(1)} m, useRadius ${cand.useRadius}`);
    if (cand.acPos) {
      await ev(page, `window.acDebug.tele(${cand.acPos.landblock}, ${(cand.acPos.x + 2.5).toFixed(2)}, ${cand.acPos.y.toFixed(2)}, ${cand.acPos.z.toFixed(2)})`);
      await page.waitForTimeout(7000);
    }
    events.length = 0;
    await ev(page, `window.acDebug.useObject(${cand.guid})`);
    const opened = await waitFor(page, `(() => { const ui = window.__ac.gameUI; return !!ui.isVendorVisible; })()`, 30_000);
    await page.waitForTimeout(1500);
    const list = opened ? await ev<Array<{ guid: number; name: string; price: number }>>(page, `window.__ac.gameUI.vendorData.sellItems.map((i) => ({ guid: i.guid, name: i.name, price: i.price }))`) : [];
    tried.push({ name: cand.name, opened, sellable: list.map((i) => i.name) });
    if (opened && list.length) { vendor = cand; sellable = list; open = await surfaces(page); state.open = { opened, ...open, events: [...events] }; break; }
    await ev(page, `(() => { const ui = window.__ac.gameUI; if (ui.isVendorVisible) ui.hideVendorWindow(); })()`);
    await page.waitForTimeout(1000);
  }
  state.vendorsTried = tried;
  if (!vendor || !open) throw new Error(`no vendor buys anything we carry: ${JSON.stringify(tried)}`);
  console.log(`${TAG} vendor: ${vendor.name} 0x${vendor.guid.toString(16)} open pending=${JSON.stringify(open.pending)} (the plain approach records nothing)`);
  state.vendor = vendor;

  // ── the items: one the vendor buys (from the bar's own sell list), one it does not, one to drop ──
  const inv = await ev<Item[]>(page, `window.__ac.playerState.inventory.getAll().map((i) => ({ id: i.id, name: i.name, stackSize: i.stackSize, ct: i.containerType || 0, isContainer: !!i.isContainer }))`);
  const plain = inv.filter((i) => !i.isContainer && !i.ct && !/pack|sack|bag/i.test(i.name));
  const S = sellable.find((s) => plain.some((p) => p.id === s.guid && p.stackSize <= 1));
  const D = plain.find((p) => p.id !== S?.guid && p.stackSize <= 1 && !/favor|letter|token/i.test(p.name));
  const U = plain.find((p) => p.id !== S?.guid && p.id !== D?.id && !sellable.some((s) => s.guid === p.id));
  state.items = { S, D, U, inventory: inv.map((i) => i.name), sellable: sellable.map((s) => s.name) };
  console.log(`${TAG} sell=${S?.name} drop=${D?.name} unsellable=${U?.name}`);
  if (!S || !D) throw new Error(`need a sellable item and a droppable item: ${JSON.stringify(state.items)}`);

  // ── before: the strip with nothing pending (the old client recorded nothing for a transaction) ──
  state.before = await surfaces(page);
  await shot(page, 'before-empty-strip.png', []);

  // ── pending: a REAL Sell (IR_SHOP_EVENT on the vendor) then immediately a drop + a Use — one synchronous evaluate ──
  events.length = 0;
  const gate = await ev<Record<string, unknown>>(page, `(() => {
    const d = window.acDebug; const ui = window.__ac.gameUI;
    const seq0 = d.gameActionSequence();
    ui.vendorCallbacks.onSell(${S.guid}, 1);
    const seqAfterSell = d.gameActionSequence();
    const pending = d.inventoryRequest();
    const refusal = d.inventoryRequestRefusal();
    const dropSent = d.dropInventoryItem(${D.id});
    const useSent = d.useObject(${vendor.guid});
    const seqAfter = d.gameActionSequence();
    const rows = ui.spewBox.items.map((i) => i.text);
    const dStillCarried = !!window.__ac.playerState.inventory.getItem(${D.id});
    return { seq0, seqAfterSell, pending, refusal, dropSent, useSent, seqAfter, rows, dStillCarried };
  })()`);
  console.log(`${TAG} gate: ${JSON.stringify(gate)}`);
  state.gate = { ...gate, events: [...events] };
  await shot(page, 'ours-pending-refused.png', [PENDING_LINE]);

  // ── released: ACE's ApproachVendor (VendorInfo) for the same vendor clears the shop event; the same drop goes out ──
  const released = await waitFor(page, `(() => window.acDebug.inventoryRequest() === null)()`, 15_000);
  const afterRelease = await surfaces(page);
  const sSold = !(await ev<boolean>(page, `!!window.__ac.playerState.inventory.getItem(${S.guid})`));
  events.length = 0;
  const drop2 = await ev<Record<string, unknown>>(page, `(() => { const d = window.acDebug; const seq0 = d.gameActionSequence(); const sent = d.dropInventoryItem(${D.id}); return { seq0, sent, seq1: d.gameActionSequence(), pending: d.inventoryRequest() }; })()`);
  const dOnGround = await waitFor(page, `(() => window.acDebug.inventoryRequest() === null && !!window.acDebug.getObjects().find((o) => o.guid === ${D.id}))()`, 15_000);
  console.log(`${TAG} released=${released} sold=${sSold} drop D: ${JSON.stringify(drop2)} dOnGround=${dOnGround}`);
  state.released = { released, sSold, afterRelease, drop2, dOnGround, events: [...events] };
  await shot(page, 'ours-released.png', []);
  await page.waitForTimeout(9000); // let the refused row age out

  // ── refused: a REAL Sell of an item the vendor does not buy → ACE's 0x00A0 (player guid, None) clears it silently ──
  if (U) {
    events.length = 0;
    const rej = await ev<Record<string, unknown>>(page, `(() => {
      const d = window.acDebug; const ui = window.__ac.gameUI;
      const seq0 = d.gameActionSequence();
      ui.vendorCallbacks.onSell(${U.id}, 1);
      return { seq0, seq1: d.gameActionSequence(), pending: d.inventoryRequest(), rows: ui.spewBox.items.map((i) => i.text) };
    })()`);
    const rejCleared = await waitFor(page, `(() => window.acDebug.inventoryRequest() === null)()`, 15_000);
    await page.waitForTimeout(800);
    const afterRej = await surfaces(page);
    const uStillCarried = await ev<boolean>(page, `!!window.__ac.playerState.inventory.getItem(${U.id})`);
    console.log(`${TAG} refused sell: ${JSON.stringify(rej)} cleared=${rejCleared} rows=${JSON.stringify(afterRej.spewRows)} uStillCarried=${uStillCarried}`);
    state.refused = { ...rej, rejCleared, afterRej, uStillCarried, events: [...events] };
    await shot(page, 'ours-refused-silent.png', []);
  }

  // put D back
  await ev(page, `window.acDebug.putInPack(${D.id}, ${charGuid})`);
  await page.waitForTimeout(2000);
  writeFileSync(join(OUT, 'live-state.json'), JSON.stringify(state, null, 2));
  await browser.close();
}

interface Panel { file: string; label: string; x: number; y: number; w: number; h: number }
const CSS = `<style>body{margin:0;background:#111;color:#ddd;font:13px/1.35 system-ui}h1{font-size:15px;margin:8px 10px}.row{display:flex;gap:8px;padding:0 8px}.cell{background:#000;flex:1}.lbl{font-size:11px;color:#bbb;padding:3px 4px;min-height:58px}.full img{width:100%}</style>`;
const dataUrl = (f: string) => `data:image/${f.endsWith('.jpg') ? 'jpeg' : 'png'};base64,${readFileSync(f).toString('base64')}`;
const cropCell = (p: Panel, scale: number) =>
  `<div class="cell"><div class="lbl">${p.label}</div><div style="width:${p.w * scale}px;height:${p.h * scale}px;overflow:hidden;position:relative"><img src="${dataUrl(p.file)}" style="position:absolute;left:${-p.x * scale}px;top:${-p.y * scale}px;transform-origin:0 0;transform:scale(${scale})"/></div></div>`;

async function compose(): Promise<void> {
  const PENDING = join(OUT, 'ours-pending-refused.png');
  const RELEASED = join(OUT, 'ours-released.png');
  const BEFORE = join(OUT, 'before-empty-strip.png');
  const REFUSED = join(OUT, 'ours-refused-silent.png');
  for (const f of [WINE, WEB1, PENDING, RELEASED, BEFORE]) if (!existsSync(f)) throw new Error(`missing ${f}`);
  const st = JSON.parse(readFileSync(join(OUT, 'live-state.json'), 'utf8')) as {
    vendor?: Obj; items?: { S?: { name: string }; D?: Item; U?: Item };
    gate?: { seq0: number; seqAfterSell: number; seqAfter: number; pending: { objectId: number; request: number } | null; rows: string[] };
    released?: { released: boolean; sSold: boolean; drop2: { seq0: number; seq1: number; sent: boolean }; dOnGround: boolean };
    refused?: { seq0: number; seq1: number; rejCleared: boolean; afterRej: Surfaces; uStillCarried: boolean };
  };
  const v = st.vendor?.name ?? 'the vendor', s = st.items?.S?.name ?? 'S', d = st.items?.D?.name ?? 'D', u = st.items?.U?.name ?? 'U';
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 2700, height: 1500 } });
  const top: Panel[] = [
    { file: WEB1, label: 'retail (portal-space-web1.jpg): a text-type-0x1a notice = red, centred, in the spew strip 20px under the top of the 3D view — the sink IsPlayerReadyToMakeInventoryRequest @ 0058d050 uses', x: 364, y: 0, w: 600, h: 60 },
    { file: BEFORE, label: `ours BEFORE: a Sell / Buy recorded nothing, so a drop during the vendor's answer window printed nothing and went out`, x: 484, y: 0, w: 600, h: 60 },
    { file: PENDING, label: `ours AFTER: the REAL Sell of the ${s} to ${v} (seq ${st.gate?.seq0} → ${st.gate?.seqAfterSell}) recorded IR_SHOP_EVENT on the vendor 0x${(st.gate?.pending?.objectId ?? 0).toString(16)} → dropping the ${d} and using the vendor both refused: "${PENDING_LINE}", seq still ${st.gate?.seqAfter}; ACE's ApproachVendor released it (${st.released?.released}) → the same drop went out (seq ${st.released?.drop2.seq0} → ${st.released?.drop2.seq1})`, x: 484, y: 0, w: 600, h: 60 },
  ];
  const refusedRow = existsSync(REFUSED) && st.refused ? `<div style="height:12px"></div>
    <h1>a transaction ACE refuses (the ${u}, not in ${v}'s merchandise): InventoryServerSaveFailed(player guid, None) resolves the pending vendor, prints nothing, clears (2x crops)</h1>
    <div class="row">${[
      { file: WEB1, label: 'retail strip (same crop)', x: 364, y: 0, w: 600, h: 60 },
      { file: REFUSED, label: `ours AFTER: Sell of the ${u} (seq ${st.refused.seq0} → ${st.refused.seq1}) → 0x00A0 → pending cleared (${st.refused.rejCleared}), strip rows ${JSON.stringify(st.refused.afterRej.spewRows)}, the ${u} still carried (${st.refused.uStillCarried})`, x: 484, y: 0, w: 600, h: 60 },
    ].map((p) => cropCell(p, 2)).join('')}</div>` : '';
  await page.setContent(`${CSS}<h1>CORE.17.k.c.a.a.b — a vendor Sell / Buy records IR_SHOP_EVENT on the vendor: until the vendor answers, every inventory request is refused with the "one item at a time" line (2x crops, top band)</h1>
    <div class="row">${top.map((p) => cropCell(p, 2)).join('')}</div>
    ${refusedRow}
    <div style="height:12px"></div>
    <h1>whole screen: retail EoL client (Wine 1024x768) | ours before | ours after — the vendor bar open, the refused drop during the answer window | ours after the answer (1568x775)</h1>
    <div class="row full">
      <div class="cell"><div class="lbl">retail EoL client under Wine</div><img src="${dataUrl(WINE)}"/></div>
      <div class="cell"><div class="lbl">ours BEFORE (the bar open, nothing pending; the old client never printed this line for a transaction)</div><img src="${dataUrl(BEFORE)}"/></div>
      <div class="cell"><div class="lbl">ours AFTER (the refused drop during the real pending Sell)</div><img src="${dataUrl(PENDING)}"/></div>
      <div class="cell"><div class="lbl">ours AFTER the vendor's answer (the ${s} sold: ${st.released?.sSold}; the ${d} dropped for real: ${st.released?.dOnGround})</div><img src="${dataUrl(RELEASED)}"/></div>
    </div>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17kcaab-vendor-shop-event-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`${TAG} wrote ${join(OUT, 'core17kcaab-vendor-shop-event-sidebyside.png')}`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  if (!process.argv.includes('--compose-only')) await captureLive();
  await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
