/**
 * CORE.17.k.c.a.a — live evidence that a second inventory request made while
 * the first is unanswered is refused client-side with
 * IsPlayerReadyToMakeInventoryRequest @ 0058d050's 0x1a line "You can only move
 * or use one item at a time" (nothing sent), that the server's answer releases
 * the gate, and that an attack in progress refuses with "You cannot move or use
 * an item while attacking".
 *
 * Drives the running stack (vite :3000, bridge :9090, ACE) with Playwright:
 *   pending   drop item A (REAL DropItem → ACE answers 0x019A) so A is a ground
 *             object; then in ONE synchronous evaluate: pick A back up (REAL
 *             PutItemInContainer, IR_PICK_UP recorded) and immediately drop item B
 *             + Use A → both refused: the line on the strip, the GameAction
 *             sequence unchanged, B still carried
 *   released  wait for ACE's 0x0022 for A (the pending request clears) → the same
 *             drop of B goes out (sequence +1) and ACE answers 0x019A
 *   attacking acDebug.attackInProgress(true) (HandleCommenceAttackEvent's flag —
 *             ACE only sends CombatCommenceAttack for an auto-repeat swing) → a
 *             drop is refused with the attacking line; (false) releases it
 *   before    the pre-change client sent every request: the strip stays empty
 *
 * Writes ours-*.png / before-*.png + live-state.json and composes
 * core17kcaa-request-gate-sidebyside.png under verification/core17kcaa/.
 *
 *   npx tsx tools/capture-core17kcaa-request-gate-sidebyside.ts [--compose-only]
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kcaa');
const WINE = join(REPO, 'docs/images/retail-client-wine-inworld-holtburg.png');
const WEB1 = join(REPO, 'reference/images/preworld/portal-space-web1.jpg');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const URL = process.env.AC_URL ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const TAG = '[core17kcaa]';
const PENDING_LINE = 'You can only move or use one item at a time';
const ATTACKING_LINE = 'You cannot move or use an item while attacking';

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
  await page.goto(`${URL}&cb=kcaa`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const deadline = Date.now() + 420_000; let lastReload = Date.now(); let lastCreate = 0;
  while (!(await inWorld(page))) {
    if (Date.now() > deadline) { await page.screenshot({ path: join(OUT, '_login-failed.png') }); throw new Error('never entered world'); }
    if (Date.now() - lastCreate > 15_000) {
      const r = await driveCharacterCreate(page, 'Gate Tester').catch(() => 'error');
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

interface Surfaces { spewRows: string[]; pending: unknown; refusal: string | null; seq: number; attacking: boolean }
async function surfaces(page: Page): Promise<Surfaces> {
  return ev<Surfaces>(page, `(() => {
    const ui = window.__ac && window.__ac.gameUI;
    const rows = ui && ui.spewBox ? ui.spewBox.items.map((i) => i.text) : [];
    const d = window.acDebug;
    return { spewRows: rows, pending: d.inventoryRequest(), refusal: d.inventoryRequestRefusal(), seq: d.gameActionSequence(), attacking: d.attackInProgress() };
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

interface Item { id: number; name: string; stackSize: number; ct: number; isContainer: boolean }

async function captureLive(): Promise<void> {
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120_000);
  page.on('dialog', (d) => void d.dismiss());
  const events: string[] = [];
  page.on('console', (msg) => {
    const t = msg.text();
    if (/refused|InventoryPut|InventoryServerSaveFailed|Sent DropItem|Sent PutItemInContainer|Sent Use|InventoryRemoveObject/.test(t)) events.push(t.slice(0, 220));
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

  const items = await ev<Item[]>(page, `window.__ac.playerState.inventory.getAll().map((i) => ({ id: i.id, name: i.name, stackSize: i.stackSize, ct: i.containerType || 0, isContainer: !!i.isContainer }))`);
  const plain = items.filter((i) => !i.isContainer && !i.ct && !/pack|sack|bag/i.test(i.name) && !/favor|letter|token/i.test(i.name));
  const [A, B] = plain;
  state.items = { A, B, all: items.map((i) => i.name) };
  if (!A || !B) throw new Error(`need two plain items, have ${JSON.stringify(plain.map((i) => i.name))}`);

  // ── before: the strip as it is with nothing pending (the old client printed nothing for a second request) ──
  state.before = await surfaces(page);
  await shot(page, 'before-empty-strip.png', []);

  // ── step 1: drop A for real so it becomes a ground object ──
  events.length = 0;
  const drop1 = await ev<{ sent: boolean; s: Surfaces }>(page, `(() => { const sent = window.acDebug.dropInventoryItem(${A.id}); const d = window.acDebug; return { sent, s: { spewRows: [], pending: d.inventoryRequest(), refusal: d.inventoryRequestRefusal(), seq: d.gameActionSequence(), attacking: d.attackInProgress() } }; })()`);
  console.log(`${TAG} drop A: ${JSON.stringify(drop1)}`);
  const aOnGround = await waitFor(page, `(() => window.acDebug.inventoryRequest() === null && !!window.acDebug.getObjects().find((o) => o.guid === ${A.id}))()`, 15_000);
  state.dropA = { ...drop1, aOnGround, events: [...events] };
  await page.waitForTimeout(1500);

  // ── step 2: pick A up (REAL, pending) and immediately try B + a Use — synchronous, one evaluate ──
  events.length = 0;
  const gate = await ev<Record<string, unknown>>(page, `(() => {
    const d = window.acDebug;
    const seq0 = d.gameActionSequence();
    const pickSent = d.putInPack(${A.id}, ${charGuid});
    const seqAfterPick = d.gameActionSequence();
    const pending = d.inventoryRequest();
    const refusalBefore = d.inventoryRequestRefusal();
    const dropSent = d.dropInventoryItem(${B.id});
    const useSent = d.useObject(${A.id});
    const seqAfter = d.gameActionSequence();
    const ui = window.__ac.gameUI;
    const rows = ui.spewBox.items.map((i) => i.text);
    const bStillCarried = !!window.__ac.playerState.inventory.getItem(${B.id});
    return { seq0, pickSent, seqAfterPick, pending, refusalBefore, dropSent, useSent, seqAfter, rows, bStillCarried };
  })()`);
  console.log(`${TAG} gate: ${JSON.stringify(gate)}`);
  state.gate = { ...gate, events: [...events] };
  await shot(page, 'ours-pending-refused.png', [PENDING_LINE]);

  // ── step 3: ACE's 0x0022 for A releases the gate; the same drop of B now goes out ──
  const released = await waitFor(page, `(() => window.acDebug.inventoryRequest() === null)()`, 15_000);
  const afterRelease = await surfaces(page);
  events.length = 0;
  const drop2 = await ev<Record<string, unknown>>(page, `(() => { const d = window.acDebug; const seq0 = d.gameActionSequence(); const sent = d.dropInventoryItem(${B.id}); return { seq0, sent, seq1: d.gameActionSequence(), pending: d.inventoryRequest() }; })()`);
  const bOnGround = await waitFor(page, `(() => window.acDebug.inventoryRequest() === null && !!window.acDebug.getObjects().find((o) => o.guid === ${B.id}))()`, 15_000);
  console.log(`${TAG} released=${released} drop B: ${JSON.stringify(drop2)} bOnGround=${bOnGround}`);
  state.released = { released, afterRelease, drop2, bOnGround, events: [...events] };
  await page.waitForTimeout(9000); // let the refused row age out

  // ── step 4: attacking — HandleCommenceAttackEvent's flag, then a request ──
  events.length = 0;
  const attack = await ev<Record<string, unknown>>(page, `(() => {
    const d = window.acDebug;
    d.attackInProgress(true);
    const seq0 = d.gameActionSequence();
    const pickSent = d.putInPack(${B.id}, ${charGuid});
    const seq1 = d.gameActionSequence();
    const refusal = d.inventoryRequestRefusal();
    const rows = window.__ac.gameUI.spewBox.items.map((i) => i.text);
    return { seq0, pickSent, seq1, refusal, rows };
  })()`);
  console.log(`${TAG} attacking: ${JSON.stringify(attack)}`);
  state.attacking = { ...attack, events: [...events] };
  await shot(page, 'ours-attacking-refused.png', [ATTACKING_LINE]);
  // AttackDone clears it; the pick of B then goes out and ACE answers
  events.length = 0;
  const done = await ev<Record<string, unknown>>(page, `(() => { const d = window.acDebug; d.attackInProgress(false); const seq0 = d.gameActionSequence(); const sent = d.putInPack(${B.id}, ${charGuid}); return { seq0, sent, seq1: d.gameActionSequence(), pending: d.inventoryRequest() }; })()`);
  const bBack = await waitFor(page, `(() => window.acDebug.inventoryRequest() === null && !!window.__ac.playerState.inventory.getItem(${B.id}))()`, 15_000);
  console.log(`${TAG} attack done: ${JSON.stringify(done)} bBack=${bBack}`);
  state.attackDone = { done, bBack, events: [...events] };

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
  const ATTACK = join(OUT, 'ours-attacking-refused.png');
  const BEFORE = join(OUT, 'before-empty-strip.png');
  for (const f of [WINE, WEB1, PENDING, ATTACK, BEFORE]) if (!existsSync(f)) throw new Error(`missing ${f}`);
  const st = JSON.parse(readFileSync(join(OUT, 'live-state.json'), 'utf8')) as {
    items?: { A: Item; B: Item }; gate?: { rows: string[]; seqAfterPick: number; seqAfter: number; pending: unknown };
    released?: { released: boolean; drop2: { seq0: number; seq1: number; sent: boolean } }; attacking?: { rows: string[]; seq0: number; seq1: number };
  };
  const a = st.items?.A.name ?? 'A', b = st.items?.B.name ?? 'B';
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 2700, height: 1500 } });
  const top: Panel[] = [
    { file: WEB1, label: 'retail (portal-space-web1.jpg): a text-type-0x1a notice = red, centred, in the spew strip 20px under the top of the 3D view — the sink IsPlayerReadyToMakeInventoryRequest @ 0058d050 uses (ECM_UI::SendNotice_DisplayStringInfo(0x1a))', x: 364, y: 0, w: 600, h: 60 },
    { file: BEFORE, label: `ours BEFORE: a second request while the first was unanswered printed nothing and went out anyway (every drop / pick / wield / use was sent)`, x: 484, y: 0, w: 600, h: 60 },
    { file: PENDING, label: `ours AFTER: the REAL pick-up of the ${a} pending (IR_PICK_UP, seq ${st.gate?.seqAfterPick}) → dropping the ${b} and using the ${a} both refused: "${PENDING_LINE}", GameAction seq still ${st.gate?.seqAfter}; released by ACE's 0x0022 (${st.released?.released}) → the same drop went out (seq ${st.released?.drop2.seq0} → ${st.released?.drop2.seq1})`, x: 484, y: 0, w: 600, h: 60 },
  ];
  const second: Panel[] = [
    { file: WEB1, label: 'retail strip (same crop) for the second beat', x: 364, y: 0, w: 600, h: 60 },
    { file: BEFORE, label: 'ours BEFORE: an inventory request during a swing was sent (no client gate at all)', x: 484, y: 0, w: 600, h: 60 },
    { file: ATTACK, label: `ours AFTER: attackInProgress set (HandleCommenceAttackEvent @ 0056ad20's flag) → the pick of the ${b} refused: "${ATTACKING_LINE}", seq ${st.attacking?.seq0} → ${st.attacking?.seq1}; HandleAttackDoneEvent's clear let it through and ACE answered`, x: 484, y: 0, w: 600, h: 60 },
  ];
  await page.setContent(`${CSS}<h1>CORE.17.k.c.a.a — a second inventory request while one is pending is refused client-side with the "one item at a time" line and nothing is sent (2x crops, top band)</h1>
    <div class="row">${top.map((p) => cropCell(p, 2)).join('')}</div>
    <div style="height:12px"></div>
    <h1>an attack in progress: the attacking line (2x crops)</h1>
    <div class="row">${second.map((p) => cropCell(p, 2)).join('')}</div>
    <div style="height:12px"></div>
    <h1>whole screen: retail EoL client (Wine 1024x768) | ours before | ours after (1568x775)</h1>
    <div class="row full">
      <div class="cell"><div class="lbl">retail EoL client under Wine</div><img src="${dataUrl(WINE)}"/></div>
      <div class="cell"><div class="lbl">ours BEFORE (nothing pending; the old client never printed this line)</div><img src="${dataUrl(BEFORE)}"/></div>
      <div class="cell"><div class="lbl">ours AFTER (the refused second request during the real pending pick-up)</div><img src="${dataUrl(PENDING)}"/></div>
    </div>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17kcaa-request-gate-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`${TAG} wrote ${join(OUT, 'core17kcaa-request-gate-sidebyside.png')}`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  if (!process.argv.includes('--compose-only')) await captureLive();
  await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
