/**
 * CORE.17.k.b.b.c.c — live evidence that the hand-built cells sitting ON DAT
 * elements now draw from the elements' own descs and states:
 *
 *   char-attributes-idle       the "Character / Level" caption 0x1000023a + the prompt footer (character-panel-attributes.jpg)
 *   char-attributes-selected   Strength selected: the button footer 0x10000241's own children — title runs, lines, the raise buttons' DAT 0x1 / 0xd art
 *   char-skills-trained        a trained skill selected (character-panel-skills.jpg)
 *   char-skills-untrained      an untrained skill selected: the credits footer, the +10 button SetVisible(0)
 *   chargen-heritage           the progress tabs = the master's own 0x21000039 buttons: Heritage in state 6, the rest in 1 (char-create-race-ref1.webp)
 *   chargen-summary-via-tab    the Summary tab clicked from Heritage (SetProgressState: no gate) — Summary 6, Heritage 1
 *
 * `--before` writes before-*.png (run it on the pre-change build: git stash
 * the working changes first); the default run writes ours-*.png + zoom crops
 * and composes
 *   core17kbbcc-native-cells-sidebyside.png   before | after | retail
 * under verification/core17kbbcc/.
 *
 * Usage: npx tsx tools/capture-core17kbbcc-native-cells-sidebyside.ts [--before] [--compose-only] [--only=a,b] [--skip-chargen] [--skip-world]
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbcc');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const ZOOM = 2;
const BEFORE = process.argv.includes('--before');
const PREFIX = BEFORE ? 'before' : 'ours';
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice('--only='.length).split(',').filter(Boolean);
const SKIP_CHARGEN = process.argv.includes('--skip-chargen');
const SKIP_WORLD = process.argv.includes('--skip-world');

const ui = (body: string): string => `(() => { const ui = window.__ac && window.__ac.gameUI; if (!ui) return; ${body} })()`;
function L(id: number): string { return `[data-layout-id="0x${id.toString(16)}"]`; }
const openChar = (tab: string): string =>
  ui(`ui.charPanelTab = '${tab}'; if (!document.querySelector('${L(0x2100002e)}')) ui.toggleCharPanel(); else ui.renderCharPanel();`);
const closeChar = ui(`if (document.querySelector('${L(0x2100002e)}')) ui.toggleCharPanel();`);

interface Cell {
  name: string;
  phase: 'world' | 'chargen';
  selector: string;
  setupJs?: string;
  cleanupJs?: string;
  settleMs?: number;
  label: string;
  ref?: string;
}

const CELLS: Cell[] = [
  {
    name: 'char-attributes-idle', phase: 'world', selector: L(0x2100002e),
    setupJs: ui(`ui.selectedStatRow = null;`) + ';' + openChar('attributes'), cleanupJs: closeChar, settleMs: 1800,
    label: '"Character / Level" 0x1000023a drawn from its desc (0x40000000, white, centred) + the prompt footer lines at their DAT x (p35 = 0). Before: renderACText white by hand, the lines padded 5 px.',
    ref: 'character-panel-attributes.jpg',
  },
  {
    name: 'char-attributes-selected', phase: 'world', selector: L(0x2100002e),
    setupJs: openChar('attributes') + ';' + ui(`ui.selectedStatRow = { kind: 'attribute', id: 1 }; ui.renderCharPanel();`),
    cleanupJs: ui(`ui.selectedStatRow = null;`) + ';' + closeChar, settleMs: 1800,
    label: 'Strength selected: the button footer 0x10000241\'s OWN children — the title 0x1000024e as name + value runs (0x40000004; the value in p27 entry 0 / 1 buffed / 2 debuffed), the lines 0x10000242–45 white near / far, the raise buttons 0x10000246 / 0x100005eb in their DAT 0x1 / 0xd art. Before: hand boxes at the coordinates, AC_COLORS.white + hand-picked textures.',
    ref: 'character-panel-attributes.jpg',
  },
  {
    name: 'char-skills-trained', phase: 'world', selector: L(0x2100002e),
    setupJs: openChar('skills') + ';' + ui(`const s = ui.charInfo.skills.find((k) => k.status === 'Specialized') ?? ui.charInfo.skills.find((k) => k.status === 'Trained'); if (s) { ui.selectedSkillId = s.id; ui.renderCharPanel(); }`),
    cleanupJs: ui(`ui.selectedSkillId = null;`) + ';' + closeChar, settleMs: 1800,
    label: 'a trained / specialized skill selected: the same DAT footer children on the skills page (0x2100002d). (The test character may have none — then the prompt footer shows.)',
    ref: 'character-panel-skills.jpg',
  },
  {
    name: 'char-skills-untrained', phase: 'world', selector: L(0x2100002e),
    setupJs: openChar('skills') + ';' + ui(`const s = ui.charInfo.skills.find((k) => k.status === 'Untrained') ?? ui.charInfo.skills.find((k) => k.status === 'Unusable'); if (s) { ui.selectedSkillId = s.id; ui.renderCharPanel(); }`),
    cleanupJs: ui(`ui.selectedSkillId = null;`) + ';' + closeChar, settleMs: 1800,
    label: 'an untrained skill selected: "Skill Credits To Train" / "Skill Credits Available:" through the DAT children, the +10 button SetVisible(0) (DisplaySelectionFooter_Untrained @ 0049b350).',
    ref: 'character-panel-skills.jpg',
  },
  {
    name: 'chargen-heritage', phase: 'chargen', selector: '[data-element-id="0x100003ce"]',
    settleMs: 1500,
    label: 'the progress tabs are the master\'s own 0x21000039 buttons (30 px 0x4000000f): Heritage in state 6 (0xfff5cd6a), the rest in state 1 (0xff956a4a), no page ghosted. Before: hand divs, the open one 1.3x in goldLight, the rest textDim at 35% opacity and inert.',
    ref: 'preworld/char-create-race-ref1.webp',
  },
  {
    name: 'chargen-summary-via-tab', phase: 'chargen', selector: '[data-element-id="0x100003ce"]',
    setupJs: `(() => { const el = document.querySelector('[data-element-id="0x100003f4"]'); if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true })); })()`,
    cleanupJs: `(() => { const el = document.querySelector('[data-element-id="0x100003ef"]'); if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true })); })()`,
    settleMs: 1500,
    label: 'the Summary tab clicked from Heritage: SetProgressState(SUMMARY) with no gate — Summary in state 6, Heritage back in 1. Before: the pages ahead were inert (no click).',
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

async function waitFor(page: Page, js: string, budgetMs: number, reloadEveryMs = 90_000): Promise<boolean> {
  const t0 = Date.now(); let lastReload = t0;
  while (Date.now() - t0 < budgetMs) {
    if (await page.evaluate(js).catch(() => false)) return true;
    if (Date.now() - lastReload > reloadEveryMs) {
      console.log('[core17kbbcc] still waiting — reloading (phantom-session retry)');
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      lastReload = Date.now();
    }
    await page.waitForTimeout(2500);
  }
  return false;
}

async function evalSrc(page: Page, src: string | undefined): Promise<void> {
  if (!src) return;
  await page.evaluate((js) => { try { (0, eval)(js); } catch (e) { console.error('[core17kbbcc] evalJs failed', e); } }, src);
}

/** Pixel-exact crop of the element's bounding rect + the labels (colour / font / state) it carries. */
async function zoomCrop(page: Page, cell: Cell, out: string) {
  const info = await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const labels = Array.from(el.querySelectorAll('.layout-text > *, .step-tab canvas, .step-tab span')).slice(0, 80).map((n) => {
      const h = n as HTMLElement;
      const parent = h.closest('[data-element-id]') as HTMLElement | null;
      return {
        el: parent?.dataset.elementId, state: h.dataset.acState ?? parent?.dataset.acState,
        desc: h.dataset.acDesc, font: h.dataset.acFont, colorIndex: h.dataset.acColorIndex,
        text: h.textContent || h.dataset.acFullText || '',
        colour: h.style.color,
      };
    }).filter((l) => l.text);
    const buttons = Array.from(el.querySelectorAll('[data-raise-button]')).map((b) => {
      const h = b as HTMLElement;
      return { id: h.getAttribute('data-raise-button'), state: h.dataset.acState, tex: h.getAttribute('data-tex'), display: h.style.display };
    });
    const tabs = Array.from(el.querySelectorAll('.step-tab')).map((t) => {
      const h = t as HTMLElement;
      return { el: h.dataset.elementId, step: h.dataset.step, state: h.dataset.acState, opacity: h.style.opacity, tooltip: h.dataset.acTooltip };
    });
    return { x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height), labels, buttons, tabs };
  }, cell.selector);
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

/** Sample the label colours: the brightest opaque pixel of each label canvas, read back from the page. */
async function labelColours(page: Page, selector: string): Promise<Array<{ el?: string; state?: string; text: string; colour: string }>> {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel) as HTMLElement | null;
    if (!root) return [];
    const out: Array<{ el?: string; state?: string; text: string; colour: string }> = [];
    for (const c of Array.from(root.querySelectorAll('.layout-text canvas, .step-tab canvas')).slice(0, 40)) {
      const canvas = c as HTMLCanvasElement;
      const ctx = canvas.getContext('2d');
      if (!ctx || canvas.width === 0 || canvas.height === 0) continue;
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let best = 0; let colour = '';
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 200) continue;
        const lum = d[i] + d[i + 1] + d[i + 2];
        if (lum > best) { best = lum; colour = '#' + [d[i], d[i + 1], d[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join(''); }
      }
      const parent = canvas.closest('[data-element-id]') as HTMLElement | null;
      out.push({ el: parent?.dataset.elementId, state: parent?.dataset.acState ?? canvas.parentElement?.dataset.acState, text: canvas.dataset.acFullText ?? '', colour });
    }
    return out;
  }, selector);
}

async function runCells(page: Page, phase: Cell['phase'], state: Record<string, unknown>): Promise<void> {
  for (const cell of CELLS) {
    if (cell.phase !== phase) continue;
    if (ONLY.length && !ONLY.includes(cell.name)) continue;
    await evalSrc(page, cell.setupJs);
    await page.waitForTimeout(cell.settleMs ?? 500);
    const zoom = await zoomCrop(page, cell, join(OUT, `${PREFIX}-${cell.name}-zoom.png`));
    const colours = await labelColours(page, cell.selector);
    await page.screenshot({ path: join(OUT, `${PREFIX}-${cell.name}.png`) });
    (state.cells as Record<string, unknown>)[cell.name] = zoom ? { ...zoom, colours } : { missing: cell.selector };
    console.log(`[core17kbbcc] ${cell.name}: ${zoom ? `${zoom.width}x${zoom.height} at (${zoom.x},${zoom.y}) labels=${JSON.stringify(zoom.labels.slice(0, 12))} buttons=${JSON.stringify(zoom.buttons)} tabs=${JSON.stringify(zoom.tabs)} colours=${JSON.stringify(colours.slice(0, 12))}` : 'MISSING ' + cell.selector}`);
    await evalSrc(page, cell.cleanupJs);
    await page.waitForTimeout(400);
  }
}

async function captureLive(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.on('dialog', (d) => void d.dismiss());
  page.on('console', (m) => { const t = m.text(); if (t.includes('[core17kbbcc]')) console.log(t); });
  const statePath = join(OUT, `${PREFIX}-live-state.json`);
  const state: Record<string, unknown> = existsSync(statePath) && (ONLY.length || SKIP_CHARGEN || SKIP_WORLD)
    ? JSON.parse(readFileSync(statePath, 'utf8'))
    : { at: new Date().toISOString(), mode: PREFIX, cells: {} };
  state.at = new Date().toISOString();

  if (!SKIP_CHARGEN && CELLS.some((c) => c.phase === 'chargen' && (!ONLY.length || ONLY.includes(c.name)))) {
    console.log('[core17kbbcc] chargen: navigating (autoenter=false)');
    await page.goto(`${URL}&autoenter=false&cb=kbbcc`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    const up = await waitFor(page, `document.getElementById('charsel-inner')?.dataset.mode === 'select'`, 360_000);
    if (!up) { await page.screenshot({ path: join(OUT, '_charsel-failed.png') }); throw new Error('character select never appeared'); }
    await page.waitForTimeout(1500);
    await page.evaluate(`(() => { const el = document.getElementById('btn-create-character'); if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true })); })()`);
    await page.waitForFunction(() => document.getElementById('chargen-root') !== null, undefined, { timeout: 15_000 });
    await page.waitForTimeout(1800);
    await runCells(page, 'chargen', state);
    await page.evaluate(`(() => { const el = document.getElementById('btn-cancel'); if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true })); })()`);
    await page.waitForTimeout(500);
  }

  if (!SKIP_WORLD && CELLS.some((c) => c.phase === 'world' && (!ONLY.length || ONLY.includes(c.name)))) {
    console.log('[core17kbbcc] world: navigating');
    await page.goto(`${URL}&cb=kbbcc2`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    const deadline = Date.now() + 360_000; let lastReload = Date.now();
    while (!(await inWorld(page))) {
      if (Date.now() > deadline) { await page.screenshot({ path: join(OUT, '_login-failed.png') }); throw new Error('never entered world'); }
      if (Date.now() - lastReload > 90_000) {
        console.log('[core17kbbcc] not in world yet — reloading (phantom-session retry)');
        await page.reload({ waitUntil: 'domcontentloaded' }); lastReload = Date.now();
      }
      await page.waitForTimeout(3000);
    }
    await page.waitForTimeout(4000);
    await runCells(page, 'world', state);
  }
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
  const rows = CELLS.map((c) => `<div class="row">
      ${img(join(OUT, `before-${c.name}-zoom.png`), `before — ${c.label}`, c.phase === 'chargen' ? 'ref' : 'zoom')}
      ${img(join(OUT, `ours-${c.name}-zoom.png`), `after — ${c.label}`, c.phase === 'chargen' ? 'ref' : 'zoom')}
      ${c.ref ? img(join(REPO, 'reference', 'images', c.ref.includes('/') ? c.ref : `hud/${c.ref}`), `retail — ${c.ref}`, 'ref') : ''}
    </div>`).join('');
  await page.setContent(`${CSS}<h1>CORE.17.k.b.b.c.c — the hand-built cells on DAT elements draw from their descs and states: before | after | retail</h1>
    <p>Reference: gmStatManagementUI::GetFooter* @ 004f0170+, gmAttributeUI::DisplaySelectionFooter_Attribute @ 0049d280 (SetTextWithFont + AppendTextWithFont into the title's p27 [white, green, red, cyan]; SetState(1) / (0xd) on the raise buttons), gmCharGenMainUI::SetProgressState @ 004e7a10 (SetState(1) x6, SetState(6) on the open page's tab), UIElement_Button::SetState @ 00471da0 / UpdateState_ @ 00471cf0, the resolved descs of 0x2100002c/d and 0x21000039.</p>
    ${rows}`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17kbbcc-native-cells-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17kbbcc] wrote ${join(OUT, 'core17kbbcc-native-cells-sidebyside.png')}`);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--compose-only')) await captureLive();
  if (!BEFORE) await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
