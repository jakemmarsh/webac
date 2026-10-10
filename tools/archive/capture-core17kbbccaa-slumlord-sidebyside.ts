/**
 * CORE.17.k.b.b.c.c.a.a — live evidence that the slumlord dialog is
 * gmSlumlordUI's layout 0x2100000e (the 800x110 Buy / Maintenance panel at
 * the top of the screen) and no longer the hand-built 300x600 dialog:
 *
 *   slumlord-buy-unowned       acDebug.testSlumlordPanel(): an unowned cottage — the Buy page (Buy 0xc / Maintenance 0xb),
 *                              "38000 Pyreals, 5 Writs of Refuge" in the requirements text, "Owner: None", the Buy button in 0xd
 *   slumlord-buy-staged        acDebug.testSlumlordPanel(false, true): the full purchase staged — six UIElement_UIItem cells
 *                              in the 555x32 list, the Buy button lit (state 1)
 *   slumlord-buy-confirm       the Buy button clicked: MakeBuyHouseConfirmationDialog's 30-day text in the Yes / No dialog
 *   slumlord-maintenance-owned acDebug.testSlumlordPanel(true, true): an owned cottage on its Maintenance page — "200/1000
 *                              Pyreals", "Owner: Someone", one staged cell, the Maintenance button lit
 *   slumlord-maintenance-empty acDebug.testSlumlordPanel(true) + the Maintenance tab: nothing staged, the button in 0xd
 *
 * `--before` writes before-*.png (run it on the pre-change sources: git
 * checkout ece1b6a -- packages/renderer/src/ui/GameUI.ts
 * packages/renderer/src/main.ts packages/renderer/src/ui/LayoutRenderer.ts,
 * then restore); the default run writes ours-*.png + zoom crops and composes
 *   core17kbbccaa-slumlord-sidebyside.png   before | after (+ the DAT anchor)
 * under verification/core17kbbccaa/.
 *
 * Usage: npx tsx tools/capture-core17kbbccaa-slumlord-sidebyside.ts [--before] [--compose-only] [--only=a,b]
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbccaa');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const ZOOM = 2;
const BEFORE = process.argv.includes('--before');
const PREFIX = BEFORE ? 'before' : 'ours';
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice('--only='.length).split(',').filter(Boolean);

const ui = (body: string): string => `(() => { const ui = window.__ac && window.__ac.gameUI; if (!ui) return; ${body} })()`;
const PANEL = '[data-slumlord-panel]';
const PROFILE = (owned: boolean) => `{ dwellingId: 0x7200016e, bitmask: 1, houseType: 1, typeName: 'Cottage', ownerName: ${owned ? "'Someone'" : "''"}, ownerId: ${owned ? '0x50000001' : '0'}, maintenanceFree: false, slumlordGuid: 0x80000123,
  minLevel: -1, maxLevel: -1, minAllegRank: -1, maxAllegRank: -1,
  buy: [{ name: 'Pyreal', pluralName: 'Pyreals', num: 38000, paid: 0, weenieId: 273 }, { name: 'Writ of Refuge', pluralName: 'Writs of Refuge', num: 5, paid: 0, weenieId: 15269 }],
  rent: [{ name: 'Pyreal', pluralName: 'Pyreals', num: 1000, paid: ${owned ? 200 : 0}, weenieId: 273 }] }`;
const seedBefore = (owned: boolean, stage: boolean) => ui(`ui.setHouseData({ profile: ${PROFILE(owned)} }); ui.showSlumlordPanel();`
  + (stage ? ` ui.addHousePaymentItem(${owned ? "'rent'" : "'buy'"}, { guid: 0x40000001, name: 'Pyreal', weenieClassId: 273, itemType: 0, stackSize: ${owned ? 800 : 38000}, value: 0 });`
    + (owned ? '' : ` for (let i = 0; i < 5; i++) ui.addHousePaymentItem('buy', { guid: 0x40000010 + i, name: 'Writ of Refuge', weenieClassId: 15269, itemType: 0, stackSize: 1, value: 0 });`) : ''));
const hide = ui(`ui.hideSlumlordPanel(); if (ui.hideConfirmationDialog) ui.hideConfirmationDialog();`);
const clickEl = (id: number) => `(() => { const el = document.querySelector('${PANEL} [data-element-id="0x${id.toString(16)}"]'); if (!el) return; el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); el.dispatchEvent(new MouseEvent('click', { bubbles: true })); })()`;

interface Cell {
  name: string;
  selector: string;
  setupJs?: string;
  cleanupJs?: string;
  beforeSelector?: string;
  beforeSetupJs?: string;
  beforeCleanupJs?: string;
  settleMs?: number;
  /** also capture this selector's crop (the confirmation dialog) */
  extraSelector?: string;
  label: string;
}

const CELLS: Cell[] = [
  {
    name: 'slumlord-buy-unowned', selector: PANEL,
    setupJs: 'window.acDebug.testSlumlordPanel(false, false)', cleanupJs: hide, settleMs: 1500,
    beforeSetupJs: seedBefore(false, false), beforeCleanupJs: hide,
    label: 'an unowned cottage (acDebug.testSlumlordPanel): the 800x110 bar at (0,0) on the 0x06004cc2 leather, the Buy tab in 0xc / Maintenance in 0xb, the requirements text 0x10000091 "38000 Pyreals, 5 Writs of Refuge" (HouseProfile::ComposeText), "Owner: None" in 0x10000093, the empty 555x32 list, the Buy button 0x10000094 in 0xd (0x06002346). Before: the hand-built 300x600 dialog at (0,28) with Type / Owner / Maintenance rows, "Purchase Requirements", the cost lists and a dashed tray.',
  },
  {
    name: 'slumlord-buy-staged', selector: PANEL,
    setupJs: 'window.acDebug.testSlumlordPanel(false, true)', cleanupJs: hide, settleMs: 1500,
    beforeSetupJs: seedBefore(false, true), beforeCleanupJs: hide,
    label: 'the full purchase staged (38,000 pyreals + five writs): six UIElement_UIItem cells in the Buy list, HouseProfile::IsPaidInFull(Buy_House) → the Buy button in state 1 (0x06002344). Before: the staged rows in the dashed tray and the green "Buy House" box.',
  },
  {
    name: 'slumlord-buy-confirm', selector: PANEL, extraSelector: '.ac-dialog-text',
    setupJs: 'window.acDebug.testSlumlordPanel(false, true);' + clickEl(0x10000094), cleanupJs: hide, settleMs: 1500,
    beforeSetupJs: seedBefore(false, true), beforeCleanupJs: hide,
    label: 'the Buy button clicked on a landscape house: MakeBuyHouseConfirmationDialog @ 004c90b0 — "When you buy a landscape house like this one, you are restricted from buying another for 30 days. Are you sure you want to buy this house?" in the Yes / No dialog. Before: no confirmation — the click sent BuyHouse at once.',
  },
  {
    name: 'slumlord-maintenance-owned', selector: PANEL,
    setupJs: 'window.acDebug.testSlumlordPanel(true, true)', cleanupJs: hide, settleMs: 1500,
    beforeSetupJs: seedBefore(true, true), beforeCleanupJs: hide,
    label: 'an owned cottage on its Maintenance page (the tab clicked: Maintenance 0xc / Buy 0xb): "200/1000 Pyreals" (HouseProfile::ComposeText2), "Owner: Someone", one staged pyreal cell, the Maintenance button 0x1000009b in state 1 (0x06002347). Before: the "Rent Cost (per period)" list with the tray and "Pay Rent".',
  },
  {
    name: 'slumlord-maintenance-empty', selector: PANEL,
    setupJs: 'window.acDebug.testSlumlordPanel(true, false);' + ui(`ui.openSlumlordTab('rent');`), cleanupJs: hide, settleMs: 1500,
    beforeSetupJs: seedBefore(true, false), beforeCleanupJs: hide,
    label: 'the same owned cottage with nothing staged: UpdateButtons keeps the Maintenance button in 0xd (0x06002349) until the Rent list holds an item.',
  },
];

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

async function evalSrc(page: Page, src: string | undefined): Promise<void> {
  if (!src) return;
  await page.evaluate((js) => { try { (0, eval)(js); } catch (e) { console.error('[core17kbbccaa] evalJs failed', e); } }, src);
}

/** Pixel-exact crop of the element's bounding rect + the panel's state. */
async function zoomCrop(page: Page, selector: string, out: string) {
  // A source STRING: tsx/esbuild injects a `__name` helper for named
  // functions inside page.evaluate bodies that does not exist in the page
  // (docs/remote-agent-ops.md, 2026-08-19).
  const info = await page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const q = (id) => el.querySelector('[data-element-id="0x' + id.toString(16) + '"]');
    const state = (id) => (q(id) && q(id).dataset.acState) || null;
    const text = (id) => {
      const n = q(id);
      if (!n) return null;
      const runs = Array.from(n.querySelectorAll('[data-ac-run-text], span'));
      return runs.map((c) => c.dataset.acRunText || c.textContent || '').filter(Boolean).join('\\n') || n.textContent || '';
    };
    const font = (id) => { const n = q(id); const f = n && n.querySelector('[data-ac-font]'); return (f && f.dataset.acFont) || null; };
    const display = (id) => (q(id) ? q(id).style.display : 'missing');
    const cells = (id) => (q(id) ? q(id).querySelectorAll('[data-item-cell], [data-slumlord-item]').length : 0);
    return {
      x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height),
      panel: el.dataset.panel || null,
      tabs: { buy: state(0x1000008e), rent: state(0x1000008f) },
      pages: { buy: display(0x10000090), rent: display(0x10000097) },
      buttons: { buy: state(0x10000094), rent: state(0x1000009b) },
      texts: { buyReq: text(0x10000091), buyOwner: text(0x10000093), rentReq: text(0x10000098), rentOwner: text(0x1000009a) },
      fonts: { buyReq: font(0x10000091), buyOwner: font(0x10000093) },
      lists: { buy: cells(0x10000095), rent: cells(0x1000009c) },
      oldLabels: Array.from(el.querySelectorAll('canvas')).map((c) => c.dataset.acFullText || '').filter((t) => /Purchase Requirements|Purchase Cost|Rent Cost|Drag payment|Type:/.test(t)),
    };
  })()`) as null | { x: number; y: number; width: number; height: number; panel: string | null; tabs: unknown; pages: unknown; buttons: unknown; texts: unknown; fonts: unknown; lists: unknown; oldLabels: string[] };
  if (!info || info.width === 0 || info.height === 0) return null;
  const pad = 6;
  const clip = {
    x: Math.max(0, info.x - pad), y: Math.max(0, info.y - pad),
    width: Math.min(VIEW.width - Math.max(0, info.x - pad), info.width + 2 * pad),
    height: Math.min(VIEW.height - Math.max(0, info.y - pad), info.height + 2 * pad),
  };
  await page.screenshot({ path: out, clip });
  return { ...info, clip };
}

async function dialogText(page: Page): Promise<string | null> {
  return page.evaluate(`(() => {
    const t = document.querySelector('.ac-dialog-text');
    if (!t) return null;
    const runs = Array.from(t.querySelectorAll('[data-ac-run-text]'));
    return runs.map((c) => c.dataset.acRunText || '').join(' ').trim() || t.textContent || '';
  })()`) as Promise<string | null>;
}

async function runCells(page: Page, state: Record<string, unknown>): Promise<void> {
  for (const cell of CELLS) {
    if (ONLY.length && !ONLY.includes(cell.name)) continue;
    const setup = BEFORE ? (cell.beforeSetupJs ?? cell.setupJs) : cell.setupJs;
    const cleanup = BEFORE ? (cell.beforeCleanupJs ?? cell.cleanupJs) : cell.cleanupJs;
    const selector = BEFORE ? (cell.beforeSelector ?? cell.selector) : cell.selector;
    await evalSrc(page, setup);
    await page.waitForTimeout(cell.settleMs ?? 500);
    const zoom = await zoomCrop(page, selector, join(OUT, `${PREFIX}-${cell.name}-zoom.png`));
    const dialog = cell.extraSelector ? await dialogText(page) : null;
    await page.screenshot({ path: join(OUT, `${PREFIX}-${cell.name}.png`) });
    (state.cells as Record<string, unknown>)[cell.name] = zoom ? { ...zoom, dialog } : { missing: selector, dialog };
    console.log(`[core17kbbccaa] ${cell.name}: ${zoom ? `${zoom.width}x${zoom.height} at (${zoom.x},${zoom.y}) panel=${zoom.panel} tabs=${JSON.stringify(zoom.tabs)} pages=${JSON.stringify(zoom.pages)} buttons=${JSON.stringify(zoom.buttons)} texts=${JSON.stringify(zoom.texts)} fonts=${JSON.stringify(zoom.fonts)} lists=${JSON.stringify(zoom.lists)} old=${JSON.stringify(zoom.oldLabels)}` : 'MISSING ' + selector} dialog=${JSON.stringify(dialog)}`);
    await evalSrc(page, cleanup);
    await page.waitForTimeout(400);
  }
}

async function captureLive(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.on('dialog', (d) => void d.dismiss());
  page.on('console', (m) => { const t = m.text(); if (t.includes('[core17kbbccaa]') || t.includes('Error') || t.includes('error')) console.log(t); });
  page.on('pageerror', (e) => console.log('[core17kbbccaa] pageerror', e.message));
  const statePath = join(OUT, `${PREFIX}-live-state.json`);
  const state: Record<string, unknown> = existsSync(statePath) && ONLY.length
    ? JSON.parse(readFileSync(statePath, 'utf8'))
    : { at: new Date().toISOString(), mode: PREFIX, cells: {} };
  state.at = new Date().toISOString();

  console.log('[core17kbbccaa] world: navigating');
  await page.goto(`${URL}&cb=kbbccaa`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const deadline = Date.now() + 360_000; let lastReload = Date.now();
  while (!(await inWorld(page))) {
    if (Date.now() > deadline) { await page.screenshot({ path: join(OUT, '_login-failed.png') }); throw new Error('never entered world'); }
    if (Date.now() - lastReload > 90_000) {
      console.log('[core17kbbccaa] not in world yet — reloading (phantom-session retry)');
      await page.reload({ waitUntil: 'domcontentloaded' }); lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  await page.waitForTimeout(4000);
  await page.evaluate(() => (window as any).acDebug?.admin?.('@telepoi holtburg'));
  await page.waitForTimeout(4000);
  await page.evaluate(() => (window as any).acDebug?.freezeTimeOfDay?.(0.5));
  await page.waitForTimeout(800);
  await runCells(page, state);
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  await browser.close();
}

function dataUrl(file: string): string {
  const ext = file.endsWith('.jpg') ? 'jpeg' : file.endsWith('.webp') ? 'webp' : 'png';
  return `data:image/${ext};base64,${readFileSync(file).toString('base64')}`;
}

const CSS = `<style>
  body{margin:0;background:#1a1a1a;color:#eee;font:13px/1.3 monospace;padding:10px}
  .row{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;margin-top:12px;border-top:1px solid #333;padding-top:8px}
  .cell{display:flex;flex-direction:column;gap:4px}
  .lbl{color:#ffd;white-space:normal;max-width:820px}
  .zoom{display:block;zoom:${ZOOM};border:1px solid #444;image-rendering:pixelated}
  .frame{display:block;border:1px solid #444;max-width:820px}
  h1{font-size:14px;margin:0 0 8px}
  p{max-width:1700px;color:#ccc;margin:4px 0}
</style>`;

async function compose(): Promise<void> {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1900, height: 900 } });
  const img = (file: string, label: string, cls = 'zoom') => existsSync(file)
    ? `<div class="cell"><div class="lbl">${label}</div><img class="${cls}" src="${dataUrl(file)}"/></div>`
    : `<div class="cell"><div class="lbl">${label}: (no capture)</div></div>`;
  const rows = CELLS.map((c) => `<div class="row">
      ${img(join(OUT, `before-${c.name}.png`), `before (full frame — the hand dialog at (0,28)) — ${c.label}`, 'frame')}
      ${img(join(OUT, `ours-${c.name}.png`), `after (full frame — the 800x110 bar at (0,0)) — ${c.label}`, 'frame')}
      ${img(join(OUT, `ours-${c.name}-zoom.png`), `after — the panel at 2x`)}
    </div>`).join('');
  await page.setContent(`${CSS}<h1>CORE.17.k.b.b.c.c.a.a — the slumlord dialog is gmSlumlordUI's layout 0x2100000e: before | after</h1>
    <p>Reference: gmSlumlordUI @ 004c7df0 (PostInit @ 004c82c0, RefreshHouse @ 004c8b20, UpdateButtons @ 004c7fe0, ListenToElementMessage @ 004c94b0, MakeBuyHouseConfirmationDialog @ 004c90b0, MakeRentPaymentByProxyConfirmationDialog @ 004c92b0, MakePayment @ 004c8940); the resolved 0x2100000e (root 0x1000008c (0,0) 800x110, p46 pairs Buy 0x1000008e→0x10000090 (p50 default) / Maintenance 0x1000008f→0x10000097, the requirements texts 245x87, the owner texts 150x16, the 94x22 buttons with state art 0x06002344/45/46 and 0x06002347/48/49, the 555x32 item lists + 555x16 scrollbars, close 0x1000009e). No retail screenshot of this panel exists in reference/images (the wikis are unreachable from the cloud container) — the DAT + decomp are the anchor.</p>
    ${rows}`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17kbbccaa-slumlord-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17kbbccaa] wrote ${join(OUT, 'core17kbbccaa-slumlord-sidebyside.png')}`);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--compose-only')) await captureLive();
  if (!BEFORE) await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
