/**
 * CORE.17.k.b.b — live evidence for the UIElement_Text p33/p34 OUTLINE on the
 * DAT carriers that render through LayoutRenderer and the hand-built cells
 * (CORE.17.k.b.a wired the pass for the DialogFactory / Disconnected texts
 * only). Every cell below is a p33 carrier in client_local_English.dat:
 *
 *   spew     the spew-box item template 0x21000011:0x1000004a — state
 *            0x10000002 carries p33 (no p34 → RGBAColor_Black): the red
 *            "In Portal Space - Please Wait..." row, black-outlined.
 *   spellbar the spell-bar tab labels 0x21000010:0x100000a3–a9/0x100005c2
 *            (base 0x1000048f, p33) and the Cast label 0x100000b2 (p33) —
 *            LayoutRenderer.setText / auto-text carriers.
 *   journal  the journal-family text buttons (template 0x21000066:0x1000057e,
 *            p33 + p34 0xff006600 — a GREEN outline) on the contracts panel.
 *   char     the character panel level value 0x1000023b (0x2100003f:
 *            0x10000384 chain, p33) — a hand-built cell.
 *
 * `--before` writes before-*.png (run it on the pre-change build); the default
 * run writes ours-*.png + zoom crops and composes
 *   core17kbb-outline-sidebyside.png   before | after, each cell at 4x
 * under verification/core17kbb/.
 *
 * Usage: npx tsx tools/capture-core17kbb-outline-sidebyside.ts [--before] [--compose-only]
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbb');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const ZOOM = 4;
const BEFORE = process.argv.includes('--before');
const PREFIX = BEFORE ? 'before' : 'ours';
/** `--only a,b` restricts the live pass to those cells (the compose still uses every file on disk). */
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice('--only='.length).split(',').filter(Boolean);
/** CORE.17.k's pre-change portal-space capture (same viewport, same code path) stands in as the spew "before". */
const CORE17K_PORTAL_SPEW = join(REPO, 'verification', 'core17k', 'ours-portal-space-spew.png');
/** Retail: the notice in portal space, 1328x749 (reference/images/preworld). */
const RETAIL_PORTAL = join(REPO, 'reference', 'images', 'preworld', 'portal-space-web1.jpg');

interface Cell {
  name: string;
  /** What to zoom on. */
  selector: string;
  /** Page JS (a source string — see the tsx `__name` landmine) run before the capture. */
  setupJs?: string;
  /** Page JS run after the capture. */
  cleanupJs?: string;
  /** Page JS run right before EACH screenshot (a transient notice is re-raised so it is up when the frame lands). */
  refreshJs?: string;
  settleMs?: number;
  label: string;
}

const CELLS: Cell[] = [
  {
    name: 'spew',
    // In world the HUD strip sits BEHIND the stacked vitals plate (retail
    // z-order too — CORE.17.k), so the notice is captured where retail's
    // portal-space-web1.jpg shows it: the portal-space overlay's mirror of
    // the box (mountPortalSpewBox).
    selector: '#portal-spew-box .spew-item',
    setupJs: `(() => { const d = window.acDebug; if (d && d.showPortalSpace) d.showPortalSpace(); })()`,
    // The item lives 5 s (template timer) and a SwiftShader frame with the
    // WebGL tunnel takes 7-8 s to capture (capture-core17k-spew-sidebyside.ts)
    // — keep the notice alive by re-raising it every 2 s (retail replaces an
    // identical top item, so nothing visible changes) until the shots are in.
    refreshJs: `(() => { const w = window; if (w.__spewKeep) clearInterval(w.__spewKeep); const raise = () => { const ui = w.__ac && w.__ac.gameUI; if (ui && ui.displayErrorText) ui.displayErrorText('In Portal Space - Please Wait...'); }; raise(); w.__spewKeep = setInterval(raise, 2000); })()`,
    settleMs: 1500,
    cleanupJs: `(() => { const w = window; if (w.__spewKeep) { clearInterval(w.__spewKeep); w.__spewKeep = null; } const d = w.acDebug; if (d && d.hidePortalSpace) d.hidePortalSpace(); })()`,
    label: 'spew box item 0x21000011:0x1000004a in portal space — state 0x10000002 p33 (black), colour 0x1b 0xffff0000',
  },
  {
    name: 'spellbar-tabs',
    selector: '[data-layout-id="0x21000010"] [data-element-id="0x100000a2"]',
    // The bar only shows in Magic combat mode, which ACE refuses without a
    // wielded wand (the fresh test character has none) — force the already
    // rendered bar visible; the labels are what this capture is about.
    setupJs: `(() => { const ui = window.__ac && window.__ac.gameUI; if (ui && ui.spellBarPanelEl) ui.spellBarPanelEl.style.display = 'block'; })()`,
    settleMs: 800,
    label: 'spell-bar tabs 0x21000010:0x100000a3–a9/0x100005c2 (base 0x1000048f p33, font 0x40000000) — bar forced visible (no wand)',
  },
  {
    name: 'spellbar-cast',
    selector: '[data-layout-id="0x21000010"] [data-element-id="0x100000b2"]',
    settleMs: 200,
    cleanupJs: `(() => { const ui = window.__ac && window.__ac.gameUI; if (ui && ui.spellBarPanelEl) ui.spellBarPanelEl.style.display = 'none'; })()`,
    label: 'Cast label 0x21000010:0x100000b2 (p33, base 0x21000040:0x100002cd)',
  },
  {
    name: 'journal',
    selector: '[data-layout-id="0x21000063"]',
    setupJs: `(() => { const ui = window.__ac && window.__ac.gameUI; if (ui && ui.toggleContractPanel) ui.toggleContractPanel(); })()`,
    settleMs: 1200,
    cleanupJs: `(() => { const ui = window.__ac && window.__ac.gameUI; if (ui && ui.toggleContractPanel) ui.toggleContractPanel(); })()`,
    label: 'contracts panel 0x21000063 — text buttons via template 0x21000066:0x1000057e (p33 + p34 0xff006600)',
  },
  {
    name: 'char-level',
    selector: '[data-element-id="0x1000023b"]',
    setupJs: `(() => { const b = document.getElementById('tb-char'); if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true })); })()`,
    settleMs: 1200,
    cleanupJs: `(() => { const b = document.getElementById('tb-char'); if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true })); })()`,
    label: 'character panel level value 0x1000023b (0x2100003f:0x10000384 chain, p33, font 0x40000010)',
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

async function waitForWorld(page: Page, budgetMs = 360_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  let lastReload = Date.now();
  while (Date.now() < deadline) {
    if (await inWorld(page)) return;
    if (Date.now() - lastReload > 90_000) {
      console.log('[core17kbb] not in world yet — reloading (phantom-session retry)');
      await page.reload({ waitUntil: 'domcontentloaded' });
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  await page.screenshot({ path: join(OUT, '_login-failed.png') });
  throw new Error('never entered world');
}

async function evalSrc(page: Page, src: string | undefined): Promise<void> {
  if (!src) return;
  await page.evaluate((js) => { try { (0, eval)(js); } catch (e) { console.error('[core17kbb] evalJs failed', e); } }, src);
}

/** Pixel-exact crop of the element's bounding rect (CSS px) + the rect and the outline dataset it carries. */
async function zoomCrop(page: Page, selector: string, out: string) {
  const info = await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const outlined = Array.from(el.querySelectorAll('[data-ac-outline]')).map((n) => (n as HTMLElement).dataset.acOutline);
    return { x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height), outlined };
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

async function captureLive(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.on('console', (m) => { const t = m.text(); if (t.includes('[core17kbb]')) console.log(t); });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await waitForWorld(page);
  await page.waitForTimeout(4000);
  const statePath = join(OUT, `${PREFIX}-live-state.json`);
  const state: Record<string, unknown> = existsSync(statePath) && ONLY.length
    ? JSON.parse(readFileSync(statePath, 'utf8'))
    : { at: new Date().toISOString(), mode: PREFIX, cells: {} };
  state.at = new Date().toISOString();
  for (const cell of CELLS) {
    if (ONLY.length && !ONLY.includes(cell.name)) continue;
    await evalSrc(page, cell.setupJs);
    await page.waitForTimeout(cell.settleMs ?? 500);
    if (cell.refreshJs) { await evalSrc(page, cell.refreshJs); await page.waitForTimeout(150); }
    const zoom = await zoomCrop(page, cell.selector, join(OUT, `${PREFIX}-${cell.name}-zoom.png`));
    if (cell.refreshJs) { await evalSrc(page, cell.refreshJs); await page.waitForTimeout(150); }
    await page.screenshot({ path: join(OUT, `${PREFIX}-${cell.name}.png`) });
    (state.cells as Record<string, unknown>)[cell.name] = zoom ?? { missing: cell.selector };
    console.log(`[core17kbb] ${cell.name}: ${zoom ? `${zoom.width}x${zoom.height} at (${zoom.x},${zoom.y}), outlined=${JSON.stringify(zoom.outlined)}` : 'MISSING ' + cell.selector}`);
    await evalSrc(page, cell.cleanupJs);
    await page.waitForTimeout(400);
  }
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  await browser.close();
}

function dataUrl(file: string): string {
  const ext = file.endsWith('.jpg') ? 'jpeg' : 'png';
  return `data:image/${ext};base64,${readFileSync(file).toString('base64')}`;
}

/** A CSS crop of a full-frame file at ZOOM (pixelated), for frames captured before this tool existed. */
function cropOf(file: string, rect: { x: number; y: number; width: number; height: number }, frameW: number, frameH: number, label: string): string {
  if (!existsSync(file)) return `<div class="cell"><div class="lbl">${label}: (no capture)</div></div>`;
  return `<div class="cell"><div class="lbl">${label}</div><div class="crop" style="width:${rect.width * ZOOM}px;height:${rect.height * ZOOM}px"><img src="${dataUrl(file)}" style="left:${-rect.x * ZOOM}px;top:${-rect.y * ZOOM}px;width:${frameW * ZOOM}px;height:${frameH * ZOOM}px"/></div></div>`;
}

const CSS = `<style>
  body{margin:0;background:#1a1a1a;color:#eee;font:13px/1.3 monospace;padding:10px}
  .row{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;margin-top:12px}
  .cell{display:flex;flex-direction:column;gap:4px}
  .lbl{color:#ffd;white-space:normal;max-width:760px}
  .zoom{display:block;zoom:${ZOOM};border:1px solid #444;image-rendering:pixelated}
  .crop{position:relative;overflow:hidden;border:1px solid #444}
  .crop img{position:absolute;image-rendering:pixelated}
  h1{font-size:14px;margin:0 0 8px}
</style>`;

async function compose(): Promise<void> {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1700, height: 900 } });
  const zoomed = (file: string, label: string) => existsSync(file)
    ? `<div class="cell"><div class="lbl">${label}</div><img class="zoom" src="${dataUrl(file)}"/></div>`
    : `<div class="cell"><div class="lbl">${label}: (no capture)</div></div>`;
  const oursState = existsSync(join(OUT, 'ours-live-state.json')) ? JSON.parse(readFileSync(join(OUT, 'ours-live-state.json'), 'utf8')) : { cells: {} };
  const spewClip = oursState.cells?.spew?.clip as { x: number; y: number; width: number; height: number } | undefined;
  const rows = CELLS.map((c) => `<div class="row">
      ${c.name === 'spew' && spewClip
        ? cropOf(CORE17K_PORTAL_SPEW, spewClip, VIEW.width, VIEW.height, `before — ${c.label} (the CORE.17.k close capture, same viewport / code path, cropped to the measured rect)`)
        : zoomed(join(OUT, `before-${c.name}-zoom.png`), `before — ${c.label}`)}
      ${zoomed(join(OUT, `ours-${c.name}-zoom.png`), `after — ${c.label}`)}
    </div>`).join('');
  // Retail: the same notice in portal space — the only retail frame on file
  // that shows a p33 carrier's text at native size (1328x749 capture).
  const retail = cropOf(RETAIL_PORTAL, { x: 490, y: 6, width: 220, height: 28 }, 1328, 749,
    'retail portal-space-web1.jpg — "In Portal Space - Please Wait" (spew row, template 0x1000004a: p33 black outline under the 0xffff0000 glyphs)');
  await page.setContent(`${CSS}<h1>CORE.17.k.b.b — UIElement_Text p33/p34 outline on the LayoutRenderer + hand-built carriers: before | after, ${ZOOM}x (DrawSelf @ 00467aa0 pass 0: the font's background-sheet halo tinted m_curOutlineColor)</h1>
    <div class="row">${retail}</div>${rows}`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17kbb-outline-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17kbb] wrote ${join(OUT, 'core17kbb-outline-sidebyside.png')}`);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--compose-only')) await captureLive();
  if (!BEFORE) await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
