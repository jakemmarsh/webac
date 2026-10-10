/**
 * CORE.17.k.b.b.c.c.a — live evidence that the World panel's House page is
 * gmHouseUI's text listbox and the slumlord dialog no longer carries the
 * Profile / Access / Rent tabs:
 *
 *   world-house-no-house      the House tab clicked on the live ACE stack (the test character owns no house — the 0x226 HouseStatus):
 *                             "You do not currently own a house." + the purchase-wait row on the 0x21000025 leather, House 0xc / Map 0xb
 *   world-house-owned-unpaid  acDebug.testHousePage(): an owned cottage 5 days into an UNPAID period — the seven rows, the yellow warning
 *   world-house-owned-paid    acDebug.testHousePage(true): the period paid — the green prepaid line, "next due" a period later
 *   world-map-after-house     the Map tab clicked back: the map page restored, Map 0xc / House 0xb
 *   slumlord-dialog           the slumlord dialog with a seeded HouseProfile: the dwelling facts + costs + tray, no tabs
 *
 * `--before` writes before-*.png (run it on the pre-change sources: git
 * checkout 21b8e73 -- packages/renderer/src/ui/GameUI.ts
 * packages/renderer/src/main.ts packages/renderer/src/ui/ClientNotices.ts,
 * then restore); the default run writes ours-*.png + zoom crops and composes
 *   core17kbbcca-house-page-sidebyside.png   before | after | retail
 * under verification/core17kbbcca/.
 *
 * Usage: npx tsx tools/capture-core17kbbcca-house-page-sidebyside.ts [--before] [--compose-only] [--only=a,b]
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbcca');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const ZOOM = 2;
const BEFORE = process.argv.includes('--before');
const PREFIX = BEFORE ? 'before' : 'ours';
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice('--only='.length).split(',').filter(Boolean);

const ui = (body: string): string => `(() => { const ui = window.__ac && window.__ac.gameUI; if (!ui) return; ${body} })()`;
function L(id: number): string { return `[data-layout-id="0x${id.toString(16)}"]`; }
const WORLD = L(0x21000027);
const openWorld = ui(`if (!document.querySelector('${WORLD}')) ui.toggleMapPanel();`);
const closeWorld = ui(`if (document.querySelector('${WORLD}')) ui.toggleMapPanel();`);
const houseTab = ui(`if (ui.openWorldPanelTab) ui.openWorldPanelTab('house'); else { const t = document.querySelector('[data-map-tab="House"]'); if (t) t.dispatchEvent(new MouseEvent('click', { bubbles: true })); }`);
const mapTab = ui(`if (ui.openWorldPanelTab) ui.openWorldPanelTab('map'); else { const t = document.querySelector('[data-map-tab="Map"]'); if (t) t.dispatchEvent(new MouseEvent('click', { bubbles: true })); }`);
const clearHouse = ui(`if (ui.clearHouseData) ui.clearHouseData();`);
const PROFILE = `{ dwellingId: 0x7200016e, bitmask: 1, houseType: 1, typeName: 'Cottage', ownerName: '', ownerId: 0, maintenanceFree: false, slumlordGuid: 0x80000123,
  minLevel: 20, maxLevel: -1, minAllegRank: -1, maxAllegRank: -1,
  buy: [{ name: 'Pyreal', pluralName: 'Pyreals', num: 38000, paid: 0, weenieId: 273 }, { name: 'Writ of Refuge', pluralName: 'Writs of Refuge', num: 5, paid: 2, weenieId: 15269 }],
  rent: [{ name: 'Pyreal', pluralName: 'Pyreals', num: 1000, paid: 0, weenieId: 273 }] }`;
const seedSlumlordAfter = ui(`ui.setHouseData({ profile: ${PROFILE} }); ui.showSlumlordPanel();`);
const seedSlumlordBefore = ui(`ui.setHouseData({ summary: { houseType: 1, typeName: 'Cottage', ownerName: '', maintenanceFree: false, buyTimeUnix: 0, rentTimeUnix: 0, nextRentTimeUnix: 0, position: null, slumlordGuid: 0x80000123, ownerId: 0 }, profile: ${PROFILE} }); ui.showHousePanel();`);
const seedHouseBefore = ui(`const now = Math.floor(Date.now() / 1000); ui.setHouseData({ summary: { houseType: 1, typeName: 'Cottage', ownerName: '+TestChar', maintenanceFree: false, buyTimeUnix: now - 60 * 86400, rentTimeUnix: now - 5 * 86400, nextRentTimeUnix: now + 25 * 86400, position: { cell: 0xA9B40001, x: 12, y: 12, z: 0, rw: 1, rx: 0, ry: 0, rz: 0 }, slumlordGuid: 0x80000001, ownerId: 0x50000000 }, rentPayments: [{ name: 'Pyreal', pluralName: 'Pyreals', num: 10000, paid: 7500, weenieId: 273 }, { name: 'Olthoi Pincer', pluralName: 'Olthoi Pincers', num: 5, paid: 5, weenieId: 9501 }] });`);

interface Cell {
  name: string;
  selector: string;
  setupJs?: string;
  cleanupJs?: string;
  /** the pre-change build's equivalents (the old API) — used by --before */
  beforeSelector?: string;
  beforeSetupJs?: string;
  beforeCleanupJs?: string;
  settleMs?: number;
  label: string;
  ref?: string;
}

const CELLS: Cell[] = [
  {
    name: 'world-house-no-house', selector: WORLD,
    setupJs: openWorld + ';' + houseTab, cleanupJs: mapTab, settleMs: 1800,
    beforeSetupJs: openWorld + ';' + houseTab, beforeCleanupJs: closeWorld,
    label: 'the House tab on the live stack (no house owned — the 0x226 HouseStatus dropped the HouseData): the 0x21000025 leather page with the list 0x100001e6 rows "You do not currently own a house." + "You may buy another house immediately." in the 0x100001e7 desc (0x40000000, white), House in 0xc / Map in 0xb. Before: the tab was inert (a console notice) and the map page stayed.',
    ref: 'map-panel.jpg',
  },
  {
    name: 'world-house-owned-unpaid', selector: WORLD,
    setupJs: ui(`window.acDebug.testHousePage(false);`), cleanupJs: clearHouse + ';' + mapTab, settleMs: 1800,
    beforeSetupJs: openWorld + ';' + seedHouseBefore + ';' + ui(`ui.toggleHousePanel();`), beforeCleanupJs: ui(`ui.hideHousePanel();`) + ';' + closeWorld,
    label: 'an owned cottage 5 days into an UNPAID period (acDebug.testHousePage): the purchase price, "Rent:" paid/due, "Bought:", the two maintenance dates, "Location: 42.1N, 33.3E", the RentNotPaid warning in p27 entry 2 (yellow), the purchase-wait row. Before: the hand Profile / Access / Rent panel at (0,28) with Type / Owner / Maintenance / Purchased / Last paid / Next due rows.',
    ref: 'map-panel.jpg',
  },
  {
    name: 'world-house-owned-paid', selector: WORLD,
    setupJs: ui(`window.acDebug.testHousePage(true);`), cleanupJs: clearHouse + ';' + mapTab, settleMs: 1800,
    beforeSetupJs: openWorld + ';' + seedHouseBefore + ';' + ui(`ui.houseTab = 'rent'; ui.toggleHousePanel();`), beforeCleanupJs: ui(`ui.houseTab = 'profile'; ui.hideHousePanel();`) + ';' + closeWorld,
    label: 'the same house with the period PAID: "Rent: 10000/10000 Pyreals, 5/5 Olthoi Pincers", "Maintenance is next due" a period later, the RentPaid line in entry 1 (green). Before: the Rent tab\'s "Pyreals 7500 / 10000" rows.',
  },
  {
    name: 'world-map-after-house', selector: WORLD,
    setupJs: houseTab + ';' + mapTab, cleanupJs: closeWorld, settleMs: 1500,
    beforeSetupJs: openWorld, beforeCleanupJs: closeWorld,
    label: 'the Map tab clicked back from the House page: UIElement_Panel::Update restores the map pair (Map 0xc / House 0xb, the parchment page alone).',
    ref: 'map-panel.jpg',
  },
  {
    name: 'slumlord-dialog', selector: '[data-slumlord-panel]',
    setupJs: seedSlumlordAfter, cleanupJs: ui(`ui.hideSlumlordPanel();`), settleMs: 1200,
    beforeSetupJs: seedSlumlordBefore, beforeCleanupJs: ui(`ui.hideHousePanel();`),
    label: 'the slumlord dialog (a seeded HouseProfile: an unowned cottage, level 20, 38,000 Pyreals + 5 Writs, rent 1,000): the dwelling facts, the requirements, the costs and the payment tray — no Profile / Access / Rent tab strip (retail gmSlumlordUI 0x2100000e has Buy / Rent pages only; its DAT layout is the follow-up CORE.17.k.b.b.c.c.a.a).',
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
  await page.evaluate((js) => { try { (0, eval)(js); } catch (e) { console.error('[core17kbbcca] evalJs failed', e); } }, src);
}

/** Pixel-exact crop of the element's bounding rect + the rows / tabs it carries. */
async function zoomCrop(page: Page, selector: string, out: string) {
  const info = await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const rows = Array.from(el.querySelectorAll('[data-house-row]')).map((row) => {
      const h = row as HTMLElement;
      const runs = Array.from(h.children) as HTMLElement[];
      return {
        colorIndex: h.dataset.houseRow, width: h.style.width, marginBottom: h.style.marginBottom,
        text: runs.map((n) => n.textContent || n.dataset.acFullText || '').join('\\n'),
        desc: runs[0]?.dataset.acDesc, font: runs[0]?.dataset.acFont, colour: runs[0]?.style.color,
      };
    });
    const tabs = Array.from(el.querySelectorAll('[data-map-tab]')).map((t) => {
      const h = t as HTMLElement;
      return { tab: h.dataset.mapTab, el: h.dataset.elementId, state: h.dataset.acState };
    });
    const panes = [0x100001f6, 0x100001f7].map((id) => {
      const p = el.querySelector(`[data-element-id="0x${id.toString(16)}"]`) as HTMLElement | null;
      return { id: id.toString(16), display: p?.style.display ?? 'missing' };
    });
    const oldTabs = Array.from(el.querySelectorAll('span')).map((s) => s.textContent).filter((t) => t === 'Profile' || t === 'Access' || t === 'Rent');
    return { x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height), rows, tabs, panes, oldTabs };
  }, selector);
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

/** Sample the row label colours: the brightest opaque pixel of each row's first canvas. */
async function rowColours(page: Page, selector: string): Promise<Array<{ colorIndex?: string; text: string; colour: string }>> {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel) as HTMLElement | null;
    if (!root) return [];
    const out: Array<{ colorIndex?: string; text: string; colour: string }> = [];
    for (const row of Array.from(root.querySelectorAll('[data-house-row]'))) {
      const canvas = row.querySelector('canvas') as HTMLCanvasElement | null;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx || canvas.width === 0 || canvas.height === 0) continue;
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let best = 0; let colour = '';
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 200) continue;
        const lum = d[i] + d[i + 1] + d[i + 2];
        if (lum > best) { best = lum; colour = '#' + [d[i], d[i + 1], d[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join(''); }
      }
      out.push({ colorIndex: (row as HTMLElement).dataset.houseRow, text: canvas.dataset.acFullText ?? '', colour });
    }
    return out;
  }, selector);
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
    const colours = await rowColours(page, selector);
    await page.screenshot({ path: join(OUT, `${PREFIX}-${cell.name}.png`) });
    (state.cells as Record<string, unknown>)[cell.name] = zoom ? { ...zoom, colours } : { missing: selector };
    console.log(`[core17kbbcca] ${cell.name}: ${zoom ? `${zoom.width}x${zoom.height} at (${zoom.x},${zoom.y}) tabs=${JSON.stringify(zoom.tabs)} panes=${JSON.stringify(zoom.panes)} oldTabs=${JSON.stringify(zoom.oldTabs)} rows=${JSON.stringify(zoom.rows)} colours=${JSON.stringify(colours)}` : 'MISSING ' + selector}`);
    await evalSrc(page, cleanup);
    await page.waitForTimeout(400);
  }
}

async function captureLive(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.on('dialog', (d) => void d.dismiss());
  page.on('console', (m) => { const t = m.text(); if (t.includes('[core17kbbcca]')) console.log(t); });
  const statePath = join(OUT, `${PREFIX}-live-state.json`);
  const state: Record<string, unknown> = existsSync(statePath) && ONLY.length
    ? JSON.parse(readFileSync(statePath, 'utf8'))
    : { at: new Date().toISOString(), mode: PREFIX, cells: {} };
  state.at = new Date().toISOString();

  console.log('[core17kbbcca] world: navigating');
  await page.goto(`${URL}&cb=kbbcca`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const deadline = Date.now() + 360_000; let lastReload = Date.now();
  while (!(await inWorld(page))) {
    if (Date.now() > deadline) { await page.screenshot({ path: join(OUT, '_login-failed.png') }); throw new Error('never entered world'); }
    if (Date.now() - lastReload > 90_000) {
      console.log('[core17kbbcca] not in world yet — reloading (phantom-session retry)');
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
  .lbl{color:#ffd;white-space:normal;max-width:640px}
  .zoom{display:block;zoom:${ZOOM};border:1px solid #444;image-rendering:pixelated}
  .ref{display:block;border:1px solid #444;max-height:600px;max-width:760px}
  h1{font-size:14px;margin:0 0 8px}
  p{max-width:1500px;color:#ccc;margin:4px 0}
</style>`;

async function compose(): Promise<void> {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1900, height: 900 } });
  const img = (file: string, label: string, cls = 'zoom') => existsSync(file)
    ? `<div class="cell"><div class="lbl">${label}</div><img class="${cls}" src="${dataUrl(file)}"/></div>`
    : `<div class="cell"><div class="lbl">${label}: (no capture)</div></div>`;
  // The old hand panel sat at (0,28) outside the World panel (no crop target on the before build): fall back to the full before frame.
  const before = (c: Cell): string => existsSync(join(OUT, `before-${c.name}-zoom.png`)) && !['world-house-owned-unpaid', 'world-house-owned-paid', 'slumlord-dialog'].includes(c.name)
    ? img(join(OUT, `before-${c.name}-zoom.png`), `before — ${c.label}`)
    : img(join(OUT, `before-${c.name}.png`), `before (full frame — the old panel at (0,28)) — ${c.label}`, 'ref');
  const rows = CELLS.map((c) => `<div class="row">
      ${before(c)}
      ${img(join(OUT, `ours-${c.name}-zoom.png`), `after — ${c.label}`)}
      ${c.ref ? img(join(REPO, 'reference', 'images', 'hud', c.ref), `retail — ${c.ref}`, 'ref') : ''}
    </div>`).join('');
  await page.setContent(`${CSS}<h1>CORE.17.k.b.b.c.c.a — the World panel's House page is gmHouseUI's text listbox: before | after | retail</h1>
    <p>Reference: gmHouseUI::Update @ 004a33d0 / 004a3460 (Flush + the seven Display* @ 004a2b30–004a3110 through AddHousePanelText @ 004a2810), the resolved 0x21000025 (list 0x100001e6, row template 0x100001e7 p27 [white, green, yellow]), UIElement_Panel::OpenTab @ 0046be20 / Update @ 0046bd00; gmSlumlordUI = 0x2100000e (HouseProfile only). No retail screenshot of the House page itself exists in reference/images — map-panel.jpg is the same World panel on its Map page (the tab strip + frame).</p>
    ${rows}`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17kbbcca-house-page-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17kbbcca] wrote ${join(OUT, 'core17kbbcca-house-page-sidebyside.png')}`);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--compose-only')) await captureLive();
  if (!BEFORE) await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
