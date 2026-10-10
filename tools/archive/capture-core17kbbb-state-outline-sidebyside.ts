/**
 * CORE.17.k.b.b.b — live evidence for the STATE-DRIVEN text properties: a
 * state's p33/p34 outline and p27 colour re-applied to the label when the
 * element enters that state (`UIElement::SetState @ 00464e70` OnSetAttributes
 * the old/new property diff; `UIElement_Button::UpdateState_ @ 00471cf0`
 * enters normal_pressed 0x3 while the mouse is down over the button and
 * normal_rollover 0x2 for the rollover).
 *
 *   keyboard-ok-rest      the Keyboard Config OK button 0x21000009:0x1000002c
 *                         (template 0x21000040:0x100002cd) at rest.
 *   keyboard-ok-hover     the same with the mouse over it — state 0x2
 *                         (normal_rollover) art; before the fix the renderer's
 *                         UIState had 0x2 / 0x3 swapped, so the rollover drew
 *                         the pressed art.
 *   keyboard-ok-pressed   mouse down over it — state 0x3 carries p33 (no p34 →
 *                         RGBAColor_Black): the label gains the black halo.
 *   keyboard-mapping-pressed  a 100x32 Mapping button of the list (the same
 *                         template, a hand-built buildDialogButton with a
 *                         data-ac-desc label) pressed.
 *   dialog-yes-pressed    a DialogFactory Yes / No prompt's Yes button pressed
 *                         (buildDialogButton, the 0x2100003c dialog buttons
 *                         are 0x100002cd instances).
 *
 * The presses are DOM mousedown events on the element (the handlers our
 * renderer wires — the same path a Playwright mouse press takes), held until
 * the frame lands, then released.
 *
 * `--before` writes before-*.png (run it on the pre-change build: git stash
 * the working changes first); the default run writes ours-*.png + zoom crops
 * and composes
 *   core17kbbb-state-outline-sidebyside.png   before | after, each cell at 4x
 * under verification/core17kbbb/.
 *
 * Usage: npx tsx tools/capture-core17kbbb-state-outline-sidebyside.ts [--before] [--compose-only] [--only=a,b]
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbb');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const ZOOM = 4;
const BEFORE = process.argv.includes('--before');
const PREFIX = BEFORE ? 'before' : 'ours';
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice('--only='.length).split(',').filter(Boolean);

const OK_SEL = '[data-layout-id="0x21000009"] [data-element-id="0x1000002c"]';
/** The Movement tab's "Move Forward" row, Mapping 1 (= "W") — a readable key; the Combat tab's first row is "`" (a 2x2 px glyph). */
const MAPPING_SEL = '[data-keybind-row="Move Forward"] [data-keybind-slot="0"]';
const OPEN_KEYBOARD_MOVEMENT = `(() => { const ui = window.__ac && window.__ac.gameUI; if (!ui) return; if (!document.querySelector('[data-layout-id="0x21000009"]')) ui.toggleKeyboardConfigPanel(); ui.keyboardConfigTab = 1; ui.refreshKeyboardTabs(); })()`;
const DIALOG_YES_SEL = '.ac-dialog-button';

const OPEN_KEYBOARD = `(() => { const ui = window.__ac && window.__ac.gameUI; if (!ui) return; if (!document.querySelector('[data-layout-id="0x21000009"]')) ui.toggleKeyboardConfigPanel(); ui.keyboardConfigTab = 4; ui.refreshKeyboardTabs(); })()`;
const CLOSE_KEYBOARD = `(() => { const ui = window.__ac && window.__ac.gameUI; if (ui && document.querySelector('[data-layout-id="0x21000009"]')) ui.closeKeyboardConfigPanel(false); })()`;
const mouse = (sel: string, type: string): string =>
  `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (el) el.dispatchEvent(new MouseEvent(${JSON.stringify(type)}, { bubbles: true, cancelable: true })); })()`;

interface Cell {
  name: string;
  selector: string;
  setupJs?: string;
  /** Run right before the shots (the press). */
  holdJs?: string;
  /** Run after the shots (the release). */
  releaseJs?: string;
  cleanupJs?: string;
  settleMs?: number;
  label: string;
}

const CELLS: Cell[] = [
  {
    name: 'keyboard-ok-rest',
    selector: OK_SEL,
    setupJs: OPEN_KEYBOARD,
    settleMs: 1500,
    label: 'Keyboard Config OK 0x21000009:0x1000002c (template 0x21000040:0x100002cd) — at rest (state 0x1: no p33)',
  },
  {
    name: 'keyboard-ok-hover',
    selector: OK_SEL,
    setupJs: OPEN_KEYBOARD,
    holdJs: mouse(OK_SEL, 'mouseenter'),
    releaseJs: mouse(OK_SEL, 'mouseleave'),
    settleMs: 600,
    label: 'the same, mouse over — normal_rollover 0x2 (the slices\' 0x2 art = the normal plate; before: the swapped UIState drew state 0x3 on hover, invisible here because the button element itself carries no image media)',
  },
  {
    name: 'keyboard-ok-pressed',
    selector: OK_SEL,
    setupJs: OPEN_KEYBOARD,
    holdJs: mouse(OK_SEL, 'mousedown'),
    releaseJs: mouse(OK_SEL, 'mouseup') + ';' + mouse(OK_SEL, 'mouseleave'),
    settleMs: 600,
    label: 'the same, mouse down — normal_pressed 0x3 carries p33 → black halo on the label, and the state passes to the three plate slices 0x100002ce/cf/d0 (PassToChildren) whose own 0x3 art is the depressed plate 0x06004c95/98/9b (before: no halo, and the plate never depressed — the renderer swapped media on the button element only)',
  },
  {
    name: 'keyboard-mapping-pressed',
    selector: MAPPING_SEL,
    setupJs: OPEN_KEYBOARD_MOVEMENT,
    holdJs: mouse(MAPPING_SEL, 'mousedown'),
    releaseJs: mouse(MAPPING_SEL, 'mouseup'),
    settleMs: 600,
    cleanupJs: CLOSE_KEYBOARD,
    label: 'the Movement tab\'s "Move Forward" Mapping 1 button ("W"; row template 0x1000002f:0x10000030, 0x100002cd family, buildDialogButton + data-ac-desc label) pressed — state 0x3 halo from its own desc',
  },
  {
    name: 'dialog-yes-pressed',
    selector: DIALOG_YES_SEL,
    setupJs: `(() => { const ui = window.__ac && window.__ac.gameUI; if (ui && ui.showConfirmationDialog) ui.showConfirmationDialog("'W' is currently bound to 'Move Forward'. Do you wish to erase that binding?", () => {}); })()`,
    holdJs: mouse(DIALOG_YES_SEL, 'mousedown'),
    releaseJs: mouse(DIALOG_YES_SEL, 'mouseup'),
    settleMs: 900,
    cleanupJs: `(() => { const b = document.querySelectorAll('.ac-dialog-button'); const no = b[1] || b[0]; if (no) no.dispatchEvent(new MouseEvent('click', { bubbles: true })); })()`,
    label: 'DialogFactory Yes button (0x2100003c dialog buttons = 0x100002cd instances, buildDialogButton) pressed — black halo (before: pressed plate only)',
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
      console.log('[core17kbbb] not in world yet — reloading (phantom-session retry)');
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
  await page.evaluate((js) => { try { (0, eval)(js); } catch (e) { console.error('[core17kbbb] evalJs failed', e); } }, src);
}

/** Pixel-exact crop of the element's bounding rect + the outline / state dataset it carries. */
async function zoomCrop(page: Page, selector: string, out: string) {
  const info = await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const outlined = Array.from(el.querySelectorAll('[data-ac-outline]')).map((n) => (n as HTMLElement).dataset.acOutline);
    const state = (el.querySelector('.layout-text') as HTMLElement | null)?.dataset.acState
      ?? (el.querySelector('[data-ac-state]') as HTMLElement | null)?.dataset.acState;
    const bg = el.style.backgroundImage ? el.style.backgroundImage.slice(0, 40) : '';
    const tex = Array.from(el.querySelectorAll('[data-tex]')).map((n) => n.getAttribute('data-tex'));
    return { x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height), outlined, state, bg, tex };
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
  page.on('console', (m) => { const t = m.text(); if (t.includes('[core17kbbb]')) console.log(t); });
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
    await evalSrc(page, cell.holdJs);
    await page.waitForTimeout(250);
    const zoom = await zoomCrop(page, cell.selector, join(OUT, `${PREFIX}-${cell.name}-zoom.png`));
    await page.screenshot({ path: join(OUT, `${PREFIX}-${cell.name}.png`) });
    await evalSrc(page, cell.releaseJs);
    (state.cells as Record<string, unknown>)[cell.name] = zoom ?? { missing: cell.selector };
    console.log(`[core17kbbb] ${cell.name}: ${zoom ? `${zoom.width}x${zoom.height} at (${zoom.x},${zoom.y}), state=${zoom.state} outlined=${JSON.stringify(zoom.outlined)} tex=${JSON.stringify(zoom.tex)} bg=${zoom.bg}` : 'MISSING ' + cell.selector}`);
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
  h1{font-size:14px;margin:0 0 8px}
  p{max-width:1500px;color:#ccc;margin:4px 0}
</style>`;

async function compose(): Promise<void> {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1700, height: 900 } });
  const zoomed = (file: string, label: string) => existsSync(file)
    ? `<div class="cell"><div class="lbl">${label}</div><img class="zoom" src="${dataUrl(file)}"/></div>`
    : `<div class="cell"><div class="lbl">${label}: (no capture)</div></div>`;
  const rows = CELLS.map((c) => `<div class="row">
      ${zoomed(join(OUT, `before-${c.name}-zoom.png`), `before — ${c.label}`)}
      ${zoomed(join(OUT, `ours-${c.name}-zoom.png`), `after — ${c.label}`)}
    </div>`).join('');
  await page.setContent(`${CSS}<h1>CORE.17.k.b.b.b — state-driven text properties (p33 outline / p27 colour re-applied on SetState): before | after, ${ZOOM}x</h1>
    <p>No retail screenshot shows a dialog button mid-press; the reference is the DAT (0x21000040:0x100002cd state 0x3: p33 = true, no p34 → RGBAColor_Black) + UIElement::SetState @ 00464e70 (OnSetAttribute over the old/new property diff) + UIElement_Button::UpdateState_ @ 00471cf0 (0x3 while the mouse is down over the button, 0x2 rollover).</p>
    ${rows}`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17kbbb-state-outline-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17kbbb] wrote ${join(OUT, 'core17kbbb-state-outline-sidebyside.png')}`);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--compose-only')) await captureLive();
  if (!BEFORE) await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
