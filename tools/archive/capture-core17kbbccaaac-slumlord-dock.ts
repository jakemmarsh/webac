/**
 * CORE.17.k.b.b.c.c.a.a.c — live evidence that the slumlord dialog
 * (gmSlumlordUI, layout 0x2100000e) is hosted in the EoL bottom transaction
 * dock — HUD 0x21000005 slot 0x100005fd (0,400) 610x120, edges L3 T2 R3 B1,
 * based on 0x2100006d:0x100005fb, whose slot 0x10000060 (5,5) 600x110 bases
 * 0x2100000e:0x1000008c — and no longer across the top of the screen over
 * the vitals and the shortcut bar.
 *
 * Driven by a REAL slumlord on the live ACE stack: the character is
 * teleported beside the cottage slumlord 0x73B9C051 (ace_world
 * landblock_instance, landblock 0x3B9C) and Uses it — ACE SlumLord.ActOnUse
 * answers with GameEventHouseProfile, which opens the dialog.
 *
 *   slumlord-buy     the dialog as the live HouseProfile opens it (the Buy page)
 *   slumlord-maint   the Maintenance tab clicked
 *
 * `--before` writes before-*.png (run it with the pre-fix GameUI.ts checked
 * out: `git stash push packages/renderer/src/ui/GameUI.ts`, run, `git stash
 * pop`); the default run writes ours-*.png + zoom crops + the element rects
 * (ours-live-state.json) and composes
 *   core17kbbccaaac-slumlord-dock-sidebyside.png   before | after (whole screen)
 * under verification/core17kbbccaaac/.
 *
 * Usage: npx tsx tools/capture-core17kbbccaaac-slumlord-dock.ts [--before] [--compose-only]
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbccaaac');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const ZOOM = 2;
const BEFORE = process.argv.includes('--before');
const PREFIX = BEFORE ? 'before' : 'ours';
const SLUMLORD_GUID = 0x73B9C051;
const TELEPORT = '@teleloc 0x3B9C0032 [151.4 37.5 50.5] 1 0 0 0';
const PANEL = '[data-slumlord-panel]';
const TAG = '[core17kbbccaaac]';

const clickEl = (id: number): string => `(() => { const e = document.querySelector('${PANEL} [data-element-id="0x${id.toString(16)}"]'); if (!e) return; for (const t of ['mousedown', 'mouseup', 'click']) e.dispatchEvent(new MouseEvent(t, { bubbles: true })); })()`;

interface Cell { name: string; setupJs?: string; settleMs?: number; label: string }
const CELLS: Cell[] = [
  { name: 'slumlord-buy', settleMs: 800,
    label: 'the real cottage slumlord 0x73B9C051 Used on the live server: its HouseProfile opens gmSlumlordUI 0x2100000e on the Buy page' },
  { name: 'slumlord-maint', setupJs: clickEl(0x1000008f), settleMs: 700,
    label: 'the Maintenance tab clicked (the ComposeText2 page)' },
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

/** The panel's rect, the vitals / shortcut-bar rects it must not cover, and the dialog's own state. */
async function probe(page: Page) {
  return page.evaluate((sel) => {
    const rect = (e: Element | null) => {
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const panel = document.querySelector(sel) as HTMLElement | null;
    const id = (n: number) => panel?.querySelector(`[data-element-id="0x${n.toString(16)}"]`) as HTMLElement | null;
    const vitals = document.querySelector('#hud-vitals');
    const shortcuts = document.querySelector('#hud-toolbar-window');
    const overlap = (a: ReturnType<typeof rect>, b: ReturnType<typeof rect>) =>
      !!(a && b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h);
    const p = rect(panel);
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      panel: p,
      panelBottomGap: p ? window.innerHeight - (p.y + p.h) : null,
      panelCentreOffset: p ? Math.round(p.x + p.w / 2 - window.innerWidth / 2) : null,
      slot: rect(id(0x10000060)),
      dock: panel?.dataset.dock ?? null,
      vitals: rect(vitals), shortcuts: rect(shortcuts),
      coversVitals: overlap(p, rect(vitals)), coversShortcuts: overlap(p, rect(shortcuts)),
      buyReq: (id(0x10000091)?.textContent ?? '').trim(),
      rentReq: (id(0x10000098)?.textContent ?? '').trim(),
      owner: (id(0x10000093)?.textContent ?? '').trim(),
      tabs: { buy: id(0x1000008e)?.dataset.acState ?? null, rent: id(0x1000008f)?.dataset.acState ?? null },
      buttons: { buy: id(0x10000094)?.dataset.acState ?? null, rent: id(0x1000009b)?.dataset.acState ?? null },
    };
  }, PANEL);
}

async function captureLive(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  // tsx (esbuild keepNames) wraps the named arrows inside page.evaluate in __name(); give the page one.
  await page.addInitScript('window.__name = (f) => f;');
  page.on('dialog', (d) => void d.dismiss());
  page.on('console', (m) => { const t = m.text(); if (t.includes(TAG) || t.includes('HouseProfile')) console.log(t); });
  const state: Record<string, unknown> = { at: new Date().toISOString(), mode: PREFIX, cells: {} };

  console.log(`${TAG} navigating`);
  await page.goto(`${URL}&cb=kbbccaaac`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const deadline = Date.now() + 360_000; let lastReload = Date.now();
  while (!(await inWorld(page))) {
    if (Date.now() > deadline) { await page.screenshot({ path: join(OUT, '_login-failed.png') }); throw new Error('never entered world'); }
    if (Date.now() - lastReload > 90_000) {
      console.log(`${TAG} not in world yet — reloading (phantom-session retry)`);
      await page.reload({ waitUntil: 'domcontentloaded' }); lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  await page.waitForTimeout(4000);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await page.evaluate((cmd) => (window as any).acDebug?.admin?.(cmd), TELEPORT);
  await page.waitForTimeout(9000);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await page.evaluate(() => (window as any).acDebug?.freezeTimeOfDay?.(0.5));
  await page.screenshot({ path: join(OUT, `${PREFIX}-closed.png`) });
  // Use the real slumlord — ACE answers with GameEventHouseProfile.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await page.evaluate((g) => (window as any).__ac?.useObject?.(g), SLUMLORD_GUID);
  const opened = await page.waitForSelector(PANEL, { timeout: 20_000 }).then(() => true).catch(() => false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state.liveProfile = await page.evaluate(() => (window as any).__ac?.gameUI?.getHouseData?.().profile ?? null);
  state.opened = opened;
  console.log(`${TAG} dialog opened by the live HouseProfile: ${opened}; profile=${JSON.stringify(state.liveProfile)}`);
  await page.waitForTimeout(1500);

  for (const cell of CELLS) {
    if (cell.setupJs) await page.evaluate((js) => { try { (0, eval)(js); } catch (e) { console.error('eval failed', e); } }, cell.setupJs);
    await page.waitForTimeout(cell.settleMs ?? 500);
    const info = await probe(page);
    (state.cells as Record<string, unknown>)[cell.name] = info;
    console.log(`${TAG} ${cell.name}: ${JSON.stringify(info)}`);
    await page.screenshot({ path: join(OUT, `${PREFIX}-${cell.name}.png`) });
    if (info.panel) {
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
      ${img(join(OUT, `before-${c.name}.png`), `before — ${c.label}: layout 0x2100000e at the HUD root's (0,0), over the vitals and the shortcut bar`)}
      ${img(join(OUT, `ours-${c.name}.png`), `after — ${c.label}: in the 0x2100006d dock (HUD slot 0x100005fd, 610x120 centred, 80 px above the bottom)`)}
    </div>
    <div class="row">${img(join(OUT, `ours-${c.name}-zoom.png`), `after (zoom ×${ZOOM}) — the dock frame, the panel in slot 0x10000060 reflowed 800 → 600`, 'zoom')}</div>`).join('');
  await page.setContent(`<style>
    body{margin:0;background:#1a1a1a;color:#eee;font:13px/1.3 monospace;padding:10px}
    .row{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;margin-top:12px;border-top:1px solid #333;padding-top:8px}
    .cell{display:flex;flex-direction:column;gap:4px}
    .lbl{color:#ffd;max-width:860px}
    .zoom{display:block;zoom:${ZOOM};border:1px solid #444;image-rendering:pixelated}
    .full{display:block;border:1px solid #444;width:860px}
    h1{font-size:14px;margin:0 0 8px} p{max-width:1760px;color:#ccc;margin:4px 0}
  </style>
  <h1>CORE.17.k.b.b.c.c.a.a.c — the slumlord dialog in the EoL bottom transaction dock: before | after (whole screen, a real slumlord Used on the live ACE stack)</h1>
  <p>DAT anchor: HUD 0x21000005 slot 0x100005fd (0,400) 610x120 edges L3 T2 R3 B1 → base 0x2100006d:0x100005fb; dock slot 0x10000060 (5,5) 600x110 → base 0x2100000e:0x1000008c. No retail screenshot of this dialog exists in reference/images; the DAT host chain is the reference.</p>
  ${rows}`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17kbbccaaac-slumlord-dock-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`${TAG} wrote ${join(OUT, 'core17kbbccaaac-slumlord-dock-sidebyside.png')}`);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--compose-only')) await captureLive();
  if (!BEFORE) await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
