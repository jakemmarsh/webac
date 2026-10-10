/**
 * CORE.17.k.b.b.c — live evidence that a DAT label draws with its desc's OWN
 * font (p26) and colour (p27): `UIElement_Text::DoFontReset @ 0046a560` takes
 * entry 0 of the font list through Font::Get and entry 0 of the colour table;
 * ours drew every LayoutRenderer label with the 0x40000000 UI font and the
 * caller's colour.
 *
 *   char-level        the character panel's level value 0x1000023b
 *                     (0x2100003f:0x10000384 chain): font 0x40000010 (36 px
 *                     numerals) in 0xfffff27f with the black halo — before: the
 *                     16 px UI font scaled 1.8x in white.
 *   char-panel        the whole Attributes pane (its hand-bound labels are
 *                     unchanged; the level value is the difference).
 *   floaty-title      floaty chat window 1's title 0x100004d9 (0x2100005b:
 *                     0x100004f7 → 0x2100003f:0x10000375): font 0x40000002
 *                     (14 px) in white — before: the UI font in white.
 *   keyboard-ok       the Keyboard Config OK button 0x21000009:0x1000002c
 *                     (0x21000040:0x100002cd → 0x100002bc chain): font
 *                     0x40000001 (18 px) in white — before: the UI font in
 *                     the caller's gold.
 *
 * `--before` writes before-*.png (run it on the pre-change build: git stash
 * the working changes first); the default run writes ours-*.png + zoom crops
 * and composes
 *   core17kbbc-desc-font-sidebyside.png   before | after, each cell at 3x
 * under verification/core17kbbc/.
 *
 * Usage: npx tsx tools/capture-core17kbbc-desc-font-sidebyside.ts [--before] [--compose-only] [--only=a,b]
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbc');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const ZOOM = 3;
const BEFORE = process.argv.includes('--before');
const PREFIX = BEFORE ? 'before' : 'ours';
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice('--only='.length).split(',').filter(Boolean);

const CHAR_PANEL_SEL = '[data-layout-id="0x2100002e"]';
const LEVEL_SEL = '[data-element-id="0x1000023b"]';
const FLOATY_TITLE_SEL = '[data-floaty-chat="1"] [data-element-id="0x100004d9"], [data-floaty-index="1"] [data-element-id="0x100004d9"]';
const OK_SEL = '[data-layout-id="0x21000009"] [data-element-id="0x1000002c"]';

const OPEN_CHAR = `(() => { const ui = window.__ac && window.__ac.gameUI; if (!ui) return; if (!document.querySelector('${CHAR_PANEL_SEL}')) ui.toggleCharPanel ? ui.toggleCharPanel() : (ui.toggleCharacterPanel && ui.toggleCharacterPanel()); })()`;
const CLOSE_CHAR = `(() => { const ui = window.__ac && window.__ac.gameUI; if (!ui) return; if (document.querySelector('${CHAR_PANEL_SEL}')) ui.toggleCharPanel ? ui.toggleCharPanel() : (ui.toggleCharacterPanel && ui.toggleCharacterPanel()); })()`;
const OPEN_FLOATY = `(() => { const ui = window.__ac && window.__ac.gameUI; if (ui && ui.toggleFloatyChatWindow) ui.toggleFloatyChatWindow(1, true); })()`;
const CLOSE_FLOATY = `(() => { const ui = window.__ac && window.__ac.gameUI; if (ui && ui.toggleFloatyChatWindow) ui.toggleFloatyChatWindow(1, false); })()`;
const OPEN_KEYBOARD = `(() => { const ui = window.__ac && window.__ac.gameUI; if (!ui) return; if (!document.querySelector('[data-layout-id="0x21000009"]')) ui.toggleKeyboardConfigPanel(); ui.keyboardConfigTab = 0; ui.refreshKeyboardTabs(); })()`;
const CLOSE_KEYBOARD = `(() => { const ui = window.__ac && window.__ac.gameUI; if (ui && document.querySelector('[data-layout-id="0x21000009"]')) ui.closeKeyboardConfigPanel(false); })()`;

interface Cell {
  name: string;
  selector: string;
  setupJs?: string;
  cleanupJs?: string;
  settleMs?: number;
  label: string;
}

const CELLS: Cell[] = [
  {
    name: 'char-level',
    selector: LEVEL_SEL,
    setupJs: OPEN_CHAR,
    settleMs: 1800,
    label: 'character panel level value 0x1000023b (0x2100003f:0x10000384 chain) — DAT: font 0x40000010 (36 px numerals), 0xfffff27f, p33 → black halo. Before: the 16 px UI font at 1.8x in white.',
  },
  {
    name: 'char-panel',
    selector: CHAR_PANEL_SEL,
    setupJs: OPEN_CHAR,
    cleanupJs: CLOSE_CHAR,
    settleMs: 600,
    label: 'the whole Attributes pane (reddit-shutdown.jpg / character-panel-attributes.jpg: the big cream level numeral at the top right)',
  },
  {
    name: 'floaty-title',
    selector: FLOATY_TITLE_SEL,
    setupJs: OPEN_FLOATY,
    cleanupJs: CLOSE_FLOATY,
    settleMs: 1200,
    label: 'floaty chat window 1 title 0x100004d9 (0x2100005b:0x100004f7 → 0x2100003f:0x10000375) — DAT: font 0x40000002 (14 px), white, no outline. Before: the UI font.',
  },
  {
    name: 'keyboard-ok',
    selector: OK_SEL,
    setupJs: OPEN_KEYBOARD,
    cleanupJs: CLOSE_KEYBOARD,
    settleMs: 1500,
    label: 'Keyboard Config OK 0x21000009:0x1000002c (0x21000040:0x100002cd → 0x100002bc chain) — DAT: font 0x40000001 (18 px), white. Before: the UI font in the caller\'s gold.',
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
      console.log('[core17kbbc] not in world yet — reloading (phantom-session retry)');
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
  await page.evaluate((js) => { try { (0, eval)(js); } catch (e) { console.error('[core17kbbc] evalJs failed', e); } }, src);
}

/** Pixel-exact crop of the element's bounding rect + the font / outline dataset its label carries. */
async function zoomCrop(page: Page, selector: string, out: string) {
  const info = await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const labels = Array.from(el.querySelectorAll('.layout-text > *, [data-ac-font]')).slice(0, 6).map((n) => {
      const h = n as HTMLElement;
      return { tag: h.tagName.toLowerCase(), font: h.dataset.acFont, outline: h.dataset.acOutline, text: h.textContent || h.dataset.acFullText || '', w: (h as HTMLCanvasElement).width, hgt: (h as HTMLCanvasElement).height };
    });
    return { x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height), labels };
  }, selector);
  if (!info || info.width === 0 || info.height === 0) return null;
  const pad = 8;
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
  page.on('console', (m) => { const t = m.text(); if (t.includes('[core17kbbc]')) console.log(t); });
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
    const zoom = await zoomCrop(page, cell.selector, join(OUT, `${PREFIX}-${cell.name}-zoom.png`));
    await page.screenshot({ path: join(OUT, `${PREFIX}-${cell.name}.png`) });
    (state.cells as Record<string, unknown>)[cell.name] = zoom ?? { missing: cell.selector };
    console.log(`[core17kbbc] ${cell.name}: ${zoom ? `${zoom.width}x${zoom.height} at (${zoom.x},${zoom.y}) labels=${JSON.stringify(zoom.labels)}` : 'MISSING ' + cell.selector}`);
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

const CSS = `<style>
  body{margin:0;background:#1a1a1a;color:#eee;font:13px/1.3 monospace;padding:10px}
  .row{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;margin-top:12px}
  .cell{display:flex;flex-direction:column;gap:4px}
  .lbl{color:#ffd;white-space:normal;max-width:760px}
  .zoom{display:block;zoom:${ZOOM};border:1px solid #444;image-rendering:pixelated}
  .ref{display:block;border:1px solid #444;max-width:760px}
  h1{font-size:14px;margin:0 0 8px}
  p{max-width:1500px;color:#ccc;margin:4px 0}
</style>`;

async function compose(): Promise<void> {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1700, height: 900 } });
  const zoomed = (file: string, label: string, cls = 'zoom') => existsSync(file)
    ? `<div class="cell"><div class="lbl">${label}</div><img class="${cls}" src="${dataUrl(file)}"/></div>`
    : `<div class="cell"><div class="lbl">${label}: (no capture)</div></div>`;
  const rows = CELLS.map((c) => `<div class="row">
      ${zoomed(join(OUT, `before-${c.name}-zoom.png`), `before — ${c.label}`, c.name === 'char-panel' ? 'ref' : 'zoom')}
      ${zoomed(join(OUT, `ours-${c.name}-zoom.png`), `after — ${c.label}`, c.name === 'char-panel' ? 'ref' : 'zoom')}
    </div>`).join('');
  const refs = `<div class="row">
      ${zoomed(join(REPO, 'reference', 'images', 'hud', 'character-panel-attributes.jpg'), 'retail — character-panel-attributes.jpg (the big cream level numeral, black-haloed)', 'ref')}
      ${zoomed(join(REPO, 'reference', 'images', 'hud', 'reddit-shutdown.jpg'), 'retail (EoL frame) — reddit-shutdown.jpg: "240" at the top right of the Attributes pane', 'ref')}
    </div>`;
  await page.setContent(`${CSS}<h1>CORE.17.k.b.b.c — a DAT label draws with its desc's own p26 font / p27 colour (DoFontReset @ 0046a560): before | after, ${ZOOM}x</h1>
    <p>Reference: the DAT (p26 entry 0 = the font DID, p27 entry 0 = the colour) + UIElement_Text::DoFontReset (SetFontDIDHelper(0x1a, m_curFontObj, 0) / SetFontColorHelper(0x1b, m_curFontColor, 0)); the retail frames below show the level numeral the 0x40000010 font draws.</p>
    ${rows}${refs}`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17kbbc-desc-font-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17kbbc] wrote ${join(OUT, 'core17kbbc-desc-font-sidebyside.png')}`);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--compose-only')) await captureLive();
  if (!BEFORE) await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
