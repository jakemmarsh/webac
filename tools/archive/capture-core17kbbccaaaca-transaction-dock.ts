/**
 * CORE.17.k.b.b.c.c.a.a.c.a — live evidence that the vendor (gmVendorUI
 * 0x21000012), ground-container (gmExternalContainerUI 0x21000008), salvage
 * (gmSalvageUI 0x2100000c) and trade (gmSecureTradeUI 0x2100000d) panels are
 * hosted in the EoL bottom transaction dock — HUD 0x21000005 slot 0x100005fd
 * (0,400) 610x120 → 0x2100006d:0x100005fb, slots 0x10000062 / 5d / 5e / 5f at
 * (5,5) 600x110 — and that the dock shows ONE of them at a time
 * (gmEnvPanelUI::RecvNotice_SetPanelVisibility @ 004cc760).
 *
 * Driven on the live ACE stack in Holtburg: the character is teleported into
 * the grocer's building (landblock 0xA9B4 cell 0x016A), where
 *   vendor      the real Holtburg grocer 0x7A9B4024 is Used — ACE's
 *               ApproachVendor opens the vendor bar
 *   container   the real chest 0x7A9B401D beside him is Used — ACE's
 *               ViewContents opens the container strip; the vendor is
 *               displaced (closed) by the dock
 *   salvage     an Ust (wcid 20646, @ci) double-clicked through the real
 *               inventory handler — the salvage panel; the chest is
 *               displaced (its close goes to the server)
 *   trade       acDebug.testTrade() (a second character to trade with is not
 *               available on this stack): the real GameUI trade panel,
 *               displacing the salvage panel
 *
 * `--before` writes before-*.png (run it with the pre-fix GameUI.ts checked
 * out: `git stash push packages/renderer/src/ui/GameUI.ts`, run, `git stash
 * pop`); the default run writes ours-*.png + zoom crops + the element rects
 * (ours-live-state.json) and composes
 *   core17kbbccaaaca-transaction-dock-sidebyside.png   before | after (whole screen)
 * under verification/core17kbbccaaaca/.
 *
 * Usage: npx tsx tools/capture-core17kbbccaaaca-transaction-dock.ts [--before] [--compose-only]
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbccaaaca');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const ZOOM = 2;
const BEFORE = process.argv.includes('--before');
const PREFIX = BEFORE ? 'before' : 'ours';
const GROCER = 0x7A9B4024;
const CHEST = 0x7A9B401D;
const UST_WCID = 20646;
const TELEPORT = '@teleloc 0xA9B4016A [77.4 36.2 94.01] 1 0 0 0';
const TAG = '[core17kbbccaaaca]';

type Kind = 'vendor' | 'container' | 'salvage' | 'trade';
interface Cell { name: Kind; label: string; open: (page: Page) => Promise<void> }

/* eslint-disable @typescript-eslint/no-explicit-any */
const CELLS: Cell[] = [
  { name: 'vendor', label: 'the real Holtburg grocer 0x7A9B4024 Used: ACE ApproachVendor opens gmVendorUI',
    open: (page) => page.evaluate((g) => (window as any).__ac?.useObject?.(g), GROCER) },
  { name: 'container', label: 'the real chest 0x7A9B401D Used: ACE ViewContents opens gmExternalContainerUI (the vendor displaced)',
    open: (page) => page.evaluate((g) => (window as any).__ac?.useObject?.(g), CHEST) },
  { name: 'salvage', label: 'an Ust double-clicked through the inventory handler: gmSalvageUI (the chest displaced)',
    open: async (page) => {
      await page.evaluate((cmd) => (window as any).acDebug?.admin?.(cmd), `@ci ${UST_WCID}`);
      await page.waitForTimeout(3000);
      const idx = await page.evaluate(() => {
        const ui = (window as any).__ac?.gameUI;
        const items = ui?.inventoryItems ?? [];
        const i = items.findIndex((it: any) => ((it.itemType ?? 0) & 0x20000000) !== 0 || /^ust$/i.test(it.name ?? ''));
        return { i, n: items.length, names: items.slice(-6).map((it: any) => `${it.name}:${(it.itemType ?? 0).toString(16)}`) };
      }).then((r) => { console.log(`${TAG} Ust inventory index ${r.i} of ${r.n}; last: ${r.names.join(', ')}`); return r.i; });
      await page.evaluate((i) => (window as any).__ac?.gameUI?.dragCallbacks?.onDoubleClickItem?.(i), idx);
    } },
  { name: 'trade', label: 'acDebug.testTrade() — the real GameUI trade panel (no second character to trade with): gmSecureTradeUI (the salvage panel displaced)',
    open: (page) => page.evaluate(() => (window as any).acDebug?.testTrade?.()) },
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

/** The open panel's host rect, which panels are open, and the vitals / shortcut-bar rects it must not cover. */
async function probe(page: Page, kind: Kind) {
  return page.evaluate((k) => {
    const rect = (e: Element | null) => {
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const ui = (window as any).__ac?.gameUI;
    const hostOf: Record<string, HTMLElement | null> = {
      vendor: ui?.vendorWrapper ?? null, container: ui?.containerPanel ?? null,
      salvage: ui?.salvagePanel ?? null, trade: ui?.tradePanel ?? null,
    };
    const host = hostOf[k];
    const docks = Array.from(document.querySelectorAll('[data-dock="0x2100006d"]')).map((h) => (h as HTMLElement).dataset.dockPanel);
    const byId = (id: number) => host?.querySelector(`[data-element-id="0x${id.toString(16)}"]`) ?? null;
    const slotIds: Record<string, number> = { vendor: 0x10000062, container: 0x1000005d, salvage: 0x1000005e, trade: 0x1000005f };
    const vitals = document.querySelector('#hud-vitals');
    const shortcuts = document.querySelector('#hud-toolbar-window');
    const overlap = (a: ReturnType<typeof rect>, b: ReturnType<typeof rect>) =>
      !!(a && b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h);
    const p = rect(host);
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      panel: p,
      panelBottomGap: p ? window.innerHeight - (p.y + p.h) : null,
      panelCentreOffset: p ? Math.round(p.x + p.w / 2 - window.innerWidth / 2) : null,
      slot: rect(byId(slotIds[k])),
      frameCorner: rect(byId(0x1000066b)),
      dockPanel: ui?.transactionDockPanel ?? null,
      dockHosts: docks,
      open: {
        vendor: !!ui?.isVendorVisible, container: !!ui?.isContainerOpen,
        salvage: !!ui?.isSalvageOpen, trade: !!ui?.tradePanel,
      },
      vendorName: ui?.vendorData?.name ?? null,
      vendorItems: ui?.vendorData?.buyItems?.length ?? 0,
      containerGuid: ui?.openContainerGuid ?? 0,
      vitals: rect(vitals), shortcuts: rect(shortcuts),
      coversVitals: overlap(p, rect(vitals)), coversShortcuts: overlap(p, rect(shortcuts)),
    };
  }, kind);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function captureLive(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  // tsx (esbuild keepNames) wraps the named arrows inside page.evaluate in __name(); give the page one.
  await page.addInitScript('window.__name = (f) => f;');
  page.on('dialog', (d) => void d.dismiss());
  page.on('console', (m) => { const t = m.text(); if (t.includes(TAG) || /Vendor|ViewContents|container|Salvage|trade/i.test(t)) console.log(t.slice(0, 240)); });
  const state: Record<string, unknown> = { at: new Date().toISOString(), mode: PREFIX, cells: {} };

  console.log(`${TAG} navigating`);
  await page.goto(`${URL}&cb=kbbccaaaca`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const deadline = Date.now() + 360_000; let lastReload = Date.now();
  while (!(await inWorld(page))) {
    if (Date.now() > deadline) { await page.screenshot({ path: join(OUT, '_login-failed.png') }); throw new Error('never entered world'); }
    if (Date.now() - lastReload > 90_000) {
      console.log(`${TAG} not in world yet — reloading (phantom-session retry)`);
      await page.reload({ waitUntil: 'domcontentloaded' }); lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  console.log(`${TAG} in world`);
  await page.waitForTimeout(4000);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await page.evaluate((cmd) => (window as any).acDebug?.admin?.(cmd), TELEPORT);
  await page.waitForTimeout(10000);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await page.evaluate(() => (window as any).acDebug?.freezeTimeOfDay?.(0.5));
  await page.screenshot({ path: join(OUT, `${PREFIX}-closed.png`) });

  for (const cell of CELLS) {
    console.log(`${TAG} opening ${cell.name}`);
    await cell.open(page);
    await page.waitForTimeout(3500);
    const info = await probe(page, cell.name);
    (state.cells as Record<string, unknown>)[cell.name] = info;
    console.log(`${TAG} ${cell.name}: ${JSON.stringify(info)}`);
    await page.screenshot({ path: join(OUT, `${PREFIX}-${cell.name}.png`) });
    if (info.panel && info.panel.w > 0) {
      const pad = 8;
      const x = Math.max(0, info.panel.x - pad); const y = Math.max(0, info.panel.y - pad);
      await page.screenshot({ path: join(OUT, `${PREFIX}-${cell.name}-zoom.png`), clip: {
        x, y, width: Math.min(VIEW.width - x, info.panel.w + 2 * pad), height: Math.min(VIEW.height - y, info.panel.h + 2 * pad) } });
    }
  }
  writeFileSync(join(OUT, `${PREFIX}-live-state.json`), JSON.stringify(state, null, 2));
  await browser.close();
}

function dataUrl(file: string): string {
  return `data:image/png;base64,${readFileSync(file).toString('base64')}`;
}

async function compose(): Promise<void> {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1800, height: 900 } });
  const img = (file: string, label: string, cls = 'full') => existsSync(file)
    ? `<div class="cell"><div class="lbl">${label}</div><img class="${cls}" src="${dataUrl(file)}"/></div>`
    : `<div class="cell"><div class="lbl">${label}: (no capture)</div></div>`;
  const rows = CELLS.map((c) => `<div class="row">
      ${img(join(OUT, `before-${c.name}.png`), `before — ${c.label}: the panel on its own, 800 wide`)}
      ${img(join(OUT, `ours-${c.name}.png`), `after — ${c.label}: in the 0x2100006d dock (HUD slot 0x100005fd, 610x120 centred, 80 px above the bottom)`)}
    </div>
    <div class="row">${img(join(OUT, `ours-${c.name}-zoom.png`), `after (zoom ×${ZOOM}) — the dock frame, the ${c.name} panel reflowed 800 → 600`, 'zoom')}</div>`).join('');
  await page.setContent(`<style>
    body{margin:0;background:#1a1a1a;color:#eee;font:13px/1.3 monospace;padding:10px}
    .row{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;margin-top:12px;border-top:1px solid #333;padding-top:8px}
    .cell{display:flex;flex-direction:column;gap:4px}
    .lbl{color:#ffd;max-width:860px}
    .zoom{display:block;zoom:${ZOOM};border:1px solid #444;image-rendering:pixelated}
    .full{display:block;border:1px solid #444;width:860px}
    h1{font-size:14px;margin:0 0 8px} p{max-width:1760px;color:#ccc;margin:4px 0}
  </style>
  <h1>CORE.17.k.b.b.c.c.a.a.c.a — the vendor / container / salvage / trade panels in the EoL bottom transaction dock: before | after (whole screen, the live ACE stack in Holtburg)</h1>
  <p>DAT anchor: HUD 0x21000005 slot 0x100005fd (0,400) 610x120 edges L3 T2 R3 B1 → base 0x2100006d:0x100005fb (gmFloatyEnvPanelUI); slots 0x10000062 (vendor) / 0x1000005d (container) / 0x1000005e (salvage) / 0x1000005f (trade) (5,5) 600x110. One panel at a time — gmEnvPanelUI::RecvNotice_SetPanelVisibility @ 004cc760: each row's panel displaced the previous one.</p>
  ${rows}`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17kbbccaaaca-transaction-dock-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`${TAG} wrote ${join(OUT, 'core17kbbccaaaca-transaction-dock-sidebyside.png')}`);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--compose-only')) await captureLive();
  if (!BEFORE) await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
