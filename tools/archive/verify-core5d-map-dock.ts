/**
 * CORE.5.d live verification — the world/map panel is a DOCK PANEL, not a
 * (500,0) full-height overlay.
 *
 * Retail determination (see the CORE.5.d notes + renderMapPanel comments):
 * dock body 0x10000180's page slot 0x1000018c ((0,0) 300x362, L1T1R1B1)
 * bases 0x21000027/0x100001f2 in BOTH HUD families (classic dock column
 * 0x21000017 body at abs (500,148) AND the EoL floaty panels window
 * 0x2100006e), the tab strip stays at the SLOT top (T1/B2), and the map
 * content block 0x100001ea is T3/B3 = vertically centered in the pane.
 *
 * Asserts at 1920x1080 + 1568x775: panel docked below the radar / above
 * the toolbar / right-pinned; tab strip 25px at the panel top (no overlap
 * with radar, vitals cluster, or indicators strip); pane parchment spans
 * tab-bottom → panel-bottom with the scroll edge strips pinned top+bottom;
 * content block 330px, vertically centered in the pane. Then composes the
 * side-by-side sheet vs retail reference/images/hud/map-panel.jpg.
 *
 * Usage: npx tsx tools/verify-core5d-map-dock.ts
 * Requires: vite (:3000), ws-tcp-bridge (:9090), ACE stack.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=core5d';
const OUT = join(REPO, 'verification', 'core5d-map-dock');
const VIEWPORTS = [
  { width: 1920, height: 1080, name: '1920x1080' },
  { width: 1568, height: 775, name: '1568x775' },
];
const DOCK_TOP = 140; // CORE.5.b.b — EoL floaty radar bottom (120x140 at y=0)
const TOOLBAR_H = 122;

async function inWorld(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const dbg = (window as unknown as { acDebug?: { collisionState?: () => { x: number } } }).acDebug;
      const cs = dbg?.collisionState?.();
      return !!(cs && cs.x > 0);
    });
  } catch { return false; }
}
function drive(page: Page): Promise<string> {
  return page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    if (!ui || !ui.ui || ui.ui.currentScreen !== 'character-create') return 'not-at-create';
    if (!ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return 'no-hooks';
    ui.wizard.name = 'Map Dock Tester';
    ui.callbacks.onCharacterCreated(ui.wizard);
    return 'sent';
  })()`) as Promise<string>;
}
async function waitForWorld(page: Page): Promise<void> {
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) return;
    if (!createSent) {
      let created = 'not-at-create';
      try { created = await drive(page); } catch { /* nav mid-probe */ }
      if (created !== 'not-at-create') { createSent = true; lastReload = Date.now(); }
    }
    if (Date.now() - lastReload > 60_000) {
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* retry */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  throw new Error('never entered world');
}

interface RectInfo { x: number; y: number; w: number; h: number; }
const failures: string[] = [];
function check(name: string, cond: boolean, detail: string): void {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name} — ${detail}`);
  if (!cond) failures.push(`${name}: ${detail}`);
}

/** Rect of a map-panel layout element via the live PanelHandle. */
async function elemRect(page: Page, elementId: number): Promise<RectInfo | null> {
  return page.evaluate((id) => {
    const ui = (window as unknown as {
      __ac?: { gameUI?: { mapPanelHandle?: { elements: Map<number, HTMLElement> } } };
    }).__ac?.gameUI;
    const el = ui?.mapPanelHandle?.elements?.get(id);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, elementId);
}
async function rectOf(page: Page, selector: string): Promise<RectInfo | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el || el.style.display === 'none') return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, selector);
}
function overlaps(a: RectInfo | null, b: RectInfo | null): boolean {
  if (!a || !b) return false;
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

async function auditViewport(page: Page, vw: number, vh: number, name: string): Promise<void> {
  console.log(`\n=== viewport ${name} ===`);
  await page.setViewportSize({ width: vw, height: vh });
  await page.waitForTimeout(1500);

  // (Re)open the map panel fresh at this viewport so the dock reflow runs
  // against the current slot height.
  await page.evaluate(() => {
    const ui = (window as unknown as { __ac?: { gameUI?: { mapPanelVisible?: boolean; toggleMapPanel?: () => void } } }).__ac?.gameUI;
    if (!ui) return;
    if (ui.mapPanelVisible) ui.toggleMapPanel?.();
    ui.toggleMapPanel?.();
  });
  await page.waitForTimeout(1200);

  const panel = await rectOf(page, '[data-panel="0x21000027"]');
  const slotH = vh - DOCK_TOP - TOOLBAR_H;
  check('panel-docked', !!panel
    && Math.abs(panel.y - DOCK_TOP) < 2
    && Math.abs((panel.x + panel.w) - vw) < 4
    && Math.abs(panel.w - 300) < 2
    && Math.abs(panel.h - slotH) < 3,
    `panel=${JSON.stringify(panel)} expected 300x${slotH} at (right-pinned, y=${DOCK_TOP})`);

  // Tab strip at the panel TOP (retail: slot top, T1/B2 edges).
  const mapTab = await elemRect(page, 0x100001f3);
  const houseTab = await elemRect(page, 0x100001f4);
  check('tab-strip-at-panel-top', !!panel && !!mapTab && !!houseTab
    && Math.abs(mapTab.y - panel.y) < 2 && Math.abs(mapTab.h - 25) < 2
    && Math.abs(houseTab.y - panel.y) < 2,
    `mapTab=${JSON.stringify(mapTab)} houseTab=${JSON.stringify(houseTab)} vs panel top ${panel?.y}`);

  // No overlap with the top HUD row articles (the CORE.5.d defect).
  const radar = await rectOf(page, '#hud-radar');
  const vitals = await rectOf(page, '#hud-vitals');
  const indicators = await rectOf(page, '#hud-indicators');
  check('no-overlap-radar', !!panel && !overlaps(panel, radar),
    `panel=${JSON.stringify(panel)} radar=${JSON.stringify(radar)}`);
  if (vitals) check('no-overlap-vitals-cluster', !overlaps(panel, vitals), `vitals=${JSON.stringify(vitals)}`);
  if (indicators) check('no-overlap-indicators', !overlaps(panel, indicators), `indicators=${JSON.stringify(indicators)}`);
  const toolbar = await rectOf(page, '#hud-toolbar');
  check('above-toolbar', !!panel && !!toolbar && panel.y + panel.h <= toolbar.y + 2,
    `panel bottom ${panel ? panel.y + panel.h : '-'} vs toolbar top ${toolbar?.y}`);

  // Pane spans tab-bottom → panel bottom; the DAT-authored scroll chrome
  // (base 0x21000019/0x10000116 subtree) paints the parchment: center
  // 0x10000110 → 0x0600126f, top 0x10000117 → 0x06001273 (pinned to pane
  // top), bottom 0x1000011a → 0x06001270 (riding the reflowed bottom).
  // The inactive House pane 0x100001f7 (dark leather 0x06004cc2) must be
  // HIDDEN or it paints over the whole map pane.
  const paneInfo = await page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    const els = ui && ui.mapPanelHandle && ui.mapPanelHandle.elements;
    const pane = els && els.get(0x100001f6);
    if (!pane) return null;
    const r = pane.getBoundingClientRect();
    const rectOf = (id) => {
      const el = els.get(id);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height, hasImg: (el.style.backgroundImage || '').includes('url') };
    };
    const house = els.get(0x100001f7);
    return {
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      center: rectOf(0x10000110), top: rectOf(0x10000117), bottom: rectOf(0x1000011a),
      houseHidden: !!house && house.style.display === 'none',
      invented: (pane.style.backgroundImage || '').includes('url'),
    };
  })()`) as {
    rect: RectInfo; center: (RectInfo & { hasImg: boolean }) | null;
    top: (RectInfo & { hasImg: boolean }) | null; bottom: (RectInfo & { hasImg: boolean }) | null;
    houseHidden: boolean; invented: boolean;
  } | null;
  check('pane-spans-slot', !!paneInfo && !!panel
    && Math.abs(paneInfo.rect.y - (panel.y + 25)) < 2
    && Math.abs(paneInfo.rect.h - (panel.h - 25)) < 3,
    `pane=${JSON.stringify(paneInfo?.rect)} vs panel ${JSON.stringify(panel)}`);
  check('dat-scroll-chrome', !!paneInfo
    && !!paneInfo.center?.hasImg && !!paneInfo.top?.hasImg && !!paneInfo.bottom?.hasImg
    && !paneInfo.invented
    && Math.abs(paneInfo.top!.y - paneInfo.rect.y) < 2
    && Math.abs((paneInfo.bottom!.y + paneInfo.bottom!.h) - (paneInfo.rect.y + paneInfo.rect.h)) < 2,
    `center=${JSON.stringify(paneInfo?.center)} top=${JSON.stringify(paneInfo?.top)} bottom=${JSON.stringify(paneInfo?.bottom)} invented=${paneInfo?.invented}`);
  check('house-pane-hidden', !!paneInfo && paneInfo.houseHidden, `houseHidden=${paneInfo?.houseHidden}`);

  // Content block: 330 tall, vertically centered in the pane (T3/B3).
  const block = await elemRect(page, 0x100001ea);
  if (paneInfo && block) {
    const expectedTop = paneInfo.rect.y + Math.floor(paneInfo.rect.h / 2) - Math.floor(330 / 2);
    check('content-block-centered', Math.abs(block.h - 330) < 2 && Math.abs(block.y - expectedTop) < 3,
      `block=${JSON.stringify(block)} expected 330 tall at y≈${expectedTop} (pane center)`);
  } else {
    check('content-block-centered', false, `block=${JSON.stringify(block)} paneInfo=${JSON.stringify(paneInfo?.rect)}`);
  }

  await page.screenshot({ path: join(OUT, `map-docked-${name}.png`) });
  if (panel) {
    await page.screenshot({
      path: join(OUT, `map-panel-crop-${name}.png`),
      clip: { x: Math.max(0, panel.x - 2), y: Math.max(0, panel.y - 2), width: panel.w + 4, height: panel.h + 4 },
    });
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: true, args: ['--enable-unsafe-swiftshader', '--no-sandbox'],
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const page = await browser.newPage({ viewport: VIEWPORTS[0] });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  console.log('waiting for world entry...');
  await waitForWorld(page);
  console.log('in world; settling...');
  await page.waitForTimeout(5000);

  for (const v of VIEWPORTS) await auditViewport(page, v.width, v.height, v.name);

  // Side-by-side sheet vs the retail reference.
  const b64 = (p: string, mime: string): string => `data:${mime};base64,${readFileSync(p).toString('base64')}`;
  const refPath = join(REPO, 'reference/images/hud/map-panel.jpg');
  const ourPath = join(OUT, 'map-panel-crop-1920x1080.png');
  if (existsSync(refPath) && existsSync(ourPath)) {
    const sheet = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    await sheet.setContent(`<!doctype html><body style="margin:0;background:#222;display:flex;gap:8px;align-items:flex-start;font-family:monospace;color:#fff">
      <figure style="margin:4px"><figcaption>RETAIL map-panel.jpg</figcaption><img src="${b64(refPath, 'image/jpeg')}" style="max-height:840px"></figure>
      <figure style="margin:4px"><figcaption>OURS docked world panel (1080p crop)</figcaption><img src="${b64(ourPath, 'image/png')}" style="max-height:840px"></figure>
    </body>`);
    await sheet.waitForTimeout(400);
    await sheet.screenshot({ path: join(OUT, 'side-by-side-map.png'), fullPage: true });
    await sheet.close();
    console.log('[sxs] wrote side-by-side-map.png');
  }

  await browser.close();
  console.log(failures.length === 0
    ? '\nALL CHECKS PASSED'
    : `\n${failures.length} CHECKS FAILED:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(failures.length === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
