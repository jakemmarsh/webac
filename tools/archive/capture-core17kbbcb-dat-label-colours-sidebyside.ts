/**
 * CORE.17.k.b.b.c.b — live evidence that the labels GameUI draws INTO DAT
 * elements by hand (setDatLabel / bindDatSocialButton / bindDatTextButton /
 * the options footer / buildDialogButton) now draw from their descs in the
 * DAT states, the way UIElement_Text::DoFontReset @ 0046a560 +
 * UIElement_Button::UpdateState_ @ 00471cf0 draw retail's:
 *
 *   social-friends      Add / Send Tell / Remove + Friend / Status / Friend Name: (friends-panel.jpg)
 *   social-friends-pressed  the Add button held down: 0x06004c95/98/9b + the black halo
 *   social-fellowship   Create Fellowship + Fellowship Name: (fellowship-panel.jpg)
 *   social-allegiance   seeded profile: the offline patron field ghosted 0xd (allegiance-panel.jpg)
 *   options-footer      Apply / Reset / Defaults on the Config tab (options-config.jpg)
 *   contracts-journal   the journal text buttons (green / white when disabled) + black paper labels
 *   contracts-contracts Contract / Status headers + the detail labels
 *   char-attributes     the XP-meter row (character-panel-attributes.jpg)
 *   char-titles         Set as Display Title (character-panel-titles.jpg)
 *   dialog              a confirmation dialog's Yes / No
 *
 * `--before` writes before-*.png (run it on the pre-change build: git stash
 * the working changes first); the default run writes ours-*.png + zoom crops
 * and composes
 *   core17kbbcb-dat-label-colours-sidebyside.png   before | after, each cell at 2x
 * under verification/core17kbbcb/.
 *
 * Usage: npx tsx tools/capture-core17kbbcb-dat-label-colours-sidebyside.ts [--before] [--compose-only] [--only=a,b]
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbcb');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const ZOOM = 2;
const BEFORE = process.argv.includes('--before');
const PREFIX = BEFORE ? 'before' : 'ours';
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice('--only='.length).split(',').filter(Boolean);

const ui = (body: string): string => `(() => { const ui = window.__ac && window.__ac.gameUI; if (!ui) return; ${body} })()`;
const closeIfPresent = (layoutSel: string, toggle: string): string =>
  ui(`if (document.querySelector('${layoutSel}')) ui.${toggle}();`);
const openSocial = (tab: string, seed?: string): string =>
  ui(`${seed ? `ui.seedSocialTestData('${seed}');` : ''} ui.socialTab = '${tab}'; if (!ui.socialPanelVisible) ui.toggleSocialPanel(); else ui.renderSocialPanel();`);
const openContracts = (tab: string): string =>
  ui(`ui.contractTab = '${tab}'; if (!document.querySelector('${L(0x21000063)}')) ui.toggleContractPanel(); else ui.renderContractPanel();`);
const openChar = (tab: string): string =>
  ui(`ui.charPanelTab = '${tab}'; if (!document.querySelector('${L(0x2100002e)}')) ui.toggleCharPanel(); else ui.renderCharPanel();`);
const press = (elementId: number): string =>
  `(() => { const el = document.querySelector('[data-element-id="0x${elementId.toString(16)}"]'); if (el) el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); })()`;
const release = (elementId: number): string =>
  `(() => { const el = document.querySelector('[data-element-id="0x${elementId.toString(16)}"]'); if (el) { el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); el.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true })); } })()`;

interface Cell {
  name: string;
  selector: string;
  cropH?: number;
  setupJs?: string;
  cleanupJs?: string;
  settleMs?: number;
  label: string;
  ref?: string;
}

function L(id: number): string { return `[data-layout-id="0x${id.toString(16)}"]`; }

const CELLS: Cell[] = [
  {
    name: 'social-friends', selector: L(0x21000031),
    setupJs: openSocial('friends', 'friends'), cleanupJs: closeIfPresent(L(0x21000031), 'toggleSocialPanel'), settleMs: 1800,
    label: 'friends pane 0x21000031: Add 0x10000514 / Remove 0x10000515 / Send Tell 0x10000516 (0x21000040:0x100002cd) white in every DAT state; Friend / Status / Friend Name: (0x2100003f:0x10000377) white. Before: gold / dim button labels, textLight headers.',
    ref: 'friends-panel.jpg',
  },
  {
    name: 'social-friends-pressed', selector: L(0x21000031), cropH: 560,
    // Add is ghosted until the Friend Name field has text (updateAdd): type a name first, then hold it down.
    setupJs: openSocial('friends', 'friends') + `;(() => { const i = document.querySelector('.friend-name-input'); if (i) { i.value = 'Esmie'; i.dispatchEvent(new Event('input', { bubbles: true })); } })();` + press(0x10000514),
    cleanupJs: release(0x10000514) + ';' + closeIfPresent(L(0x21000031), 'toggleSocialPanel'), settleMs: 1800,
    label: 'the Add button (enabled by a typed name) held down: state 0x3 normal_pressed = the pressed plate 0x06004c95/98/9b + the p33 black halo on the white label (UIElement_Button::UpdateState_ @ 00471cf0). Before: no pressed state at all (the pressed art was the HOVER look, label gold).',
  },
  {
    name: 'social-fellowship', selector: L(0x21000031),
    setupJs: ui(`ui.setFellowshipData(null);`) + ';' + openSocial('fellowship'), cleanupJs: closeIfPresent(L(0x21000031), 'toggleSocialPanel'), settleMs: 1800,
    label: 'fellowship pane: Create Fellowship 0x10000274 white; Fellowship Name: 0x1000026e white. Before: gold / textLight.',
    ref: 'fellowship-panel.jpg',
  },
  {
    name: 'social-allegiance', selector: L(0x21000031),
    // An explicit profile (the ACE wire shape): the monarch online, the patron offline.
    setupJs: ui(`ui.setAllegianceData({ allegianceName: 'Test Allegiance', playerRank: 3, totalMembers: 2538, totalVassals: 3, isLocked: false, selfGuid: 100, members: [
        { guid: 1, parentGuid: 0, name: 'Monarch Test', level: 275, rank: 10, isOnline: true, xpProduced: 152000000 },
        { guid: 5, parentGuid: 1, name: 'Patron Test', level: 180, rank: 7, isOnline: false, xpProduced: 48200000 },
        { guid: 100, parentGuid: 5, name: 'Self Test', level: 120, rank: 3, isOnline: true, xpProduced: 1727923540 },
        { guid: 2, parentGuid: 100, name: 'Vassal Alpha', level: 150, rank: 5, isOnline: true, xpProduced: 12500000 },
        { guid: 3, parentGuid: 100, name: 'Vassal Beta', level: 96, rank: 4, isOnline: false, xpProduced: 3400000 } ] });`) + ';' + openSocial('allegiance'),
    cleanupJs: ui(`ui.setAllegianceData(null);`) + ';' + closeIfPresent(L(0x21000031), 'toggleSocialPanel'), settleMs: 1800,
    label: 'allegiance pane (seeded profile): the headers white; a field whose player is not logged in is SetState(0xd) (gmAllegianceUI::UpdateMonarchData @ 00491b40 / UpdatePatronData @ 004917c0) — its labels 0xff4c4c4c through the PassToChildren 0xd; Swear / Break / Kick white. Before: textLight / #999999 by hand, gold buttons.',
    ref: 'allegiance-panel.jpg',
  },
  {
    name: 'options-footer', selector: L(0x2100002b),
    setupJs: ui(`ui.optionsTab = 'config'; if (!document.querySelector('${L(0x2100002b)}')) ui.toggleOptionsPanel(); else ui.renderOptionsPanel();`),
    cleanupJs: closeIfPresent(L(0x2100002b), 'toggleOptionsPanel'), settleMs: 1800,
    label: 'options Config tab: Apply / Reset / Defaults 0x100001fc/fd/fe (0x100002cd) white on the normal plate. Before: gold labels, the pressed plate on hover.',
    ref: 'options-config.jpg',
  },
  {
    name: 'contracts-journal', selector: L(0x21000063),
    setupJs: openContracts('journal'), cleanupJs: closeIfPresent(L(0x21000063), 'toggleContractPanel'), settleMs: 1800,
    label: 'journal pane: the text buttons (0x21000066:0x1000057e) 0xff00ff7f, a disabled one WHITE (the template\'s 0xd), the dark-green outline; the paper labels black (their own p27). Before: disabled = textDim.',
  },
  {
    name: 'contracts-contracts', selector: L(0x21000063),
    setupJs: openContracts('contracts'), cleanupJs: closeIfPresent(L(0x21000063), 'toggleContractPanel'), settleMs: 1800,
    label: 'contracts pane: Contract / Status header text buttons green; Status: / Contact: / Contact Location: / Quest Location: / Timed: white; the values yellow from their own p27.',
  },
  {
    name: 'char-attributes', selector: L(0x2100002e),
    setupJs: openChar('attributes'), cleanupJs: closeIfPresent(L(0x2100002e), 'toggleCharPanel'), settleMs: 1800,
    label: 'character panel Attributes: "XP for next level:" + the value (0x2100003f:0x10000376, 16 px) WHITE over the dark track as in character-panel-attributes.jpg. Before: black by hand.',
    ref: 'character-panel-attributes.jpg',
  },
  {
    name: 'char-titles', selector: L(0x2100002e),
    setupJs: openChar('titles'), cleanupJs: closeIfPresent(L(0x2100002e), 'toggleCharPanel'), settleMs: 1800,
    label: 'character panel Titles: Set as Display Title 0x10000535 (0x100002cd, default state 0xd until a title is selected) white; the labels white.',
    ref: 'character-panel-titles.jpg',
  },
  {
    name: 'dialog', selector: '.ac-dialog-plate',
    setupJs: ui(`ui.showConfirmationDialog('Do you wish to log out?', () => {});`),
    cleanupJs: `(() => { const b = document.querySelectorAll('.ac-dialog-button'); if (b[1]) b[1].click(); })()`, settleMs: 1200,
    label: 'a confirmation dialog: Yes / No from the 0x21000040:0x100002cd template — white, 18 px 0x40000001. Before: textLight in the 16 px UI font.',
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
      console.log('[core17kbbcb] not in world yet — reloading (phantom-session retry)');
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
  await page.evaluate((js) => { try { (0, eval)(js); } catch (e) { console.error('[core17kbbcb] evalJs failed', e); } }, src);
}

/** Pixel-exact crop of the element's bounding rect + the labels (colour / font / state) it carries. */
async function zoomCrop(page: Page, cell: Cell, out: string) {
  const info = await page.evaluate(({ sel, cropH }) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const labels = Array.from(el.querySelectorAll('.layout-text > *, .ac-dialog-button canvas, .ac-dialog-button span')).slice(0, 60).map((n) => {
      const h = n as HTMLElement;
      const parent = h.closest('[data-element-id]') as HTMLElement | null;
      const canvas = h.matches('canvas') ? h as HTMLCanvasElement : h.querySelector('canvas');
      return {
        el: parent?.dataset.elementId, state: h.dataset.acState ?? parent?.dataset.acState,
        desc: h.dataset.acDesc, font: canvas?.dataset.acFont ?? h.dataset.acFont,
        text: h.textContent || canvas?.dataset.acFullText || '',
        colour: h.style.color, outline: h.dataset.acOutline,
        slices: parent ? Array.from(parent.querySelectorAll(':scope > [data-tex]')).map((s) => (s as HTMLElement).getAttribute('data-tex')) : [],
      };
    }).filter((l) => l.text);
    return { x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: cropH ? Math.min(cropH, Math.ceil(r.height)) : Math.ceil(r.height), labels };
  }, { sel: cell.selector, cropH: cell.cropH });
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
    for (const c of Array.from(root.querySelectorAll('.layout-text canvas, .ac-dialog-button canvas')).slice(0, 40)) {
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

async function captureLive(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.on('console', (m) => { const t = m.text(); if (t.includes('[core17kbbcb]')) console.log(t); });
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
    const zoom = await zoomCrop(page, cell, join(OUT, `${PREFIX}-${cell.name}-zoom.png`));
    const colours = await labelColours(page, cell.selector);
    await page.screenshot({ path: join(OUT, `${PREFIX}-${cell.name}.png`) });
    (state.cells as Record<string, unknown>)[cell.name] = zoom ? { ...zoom, colours } : { missing: cell.selector };
    console.log(`[core17kbbcb] ${cell.name}: ${zoom ? `${zoom.width}x${zoom.height} at (${zoom.x},${zoom.y}) colours=${JSON.stringify(colours)}` : 'MISSING ' + cell.selector}`);
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
  .row{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;margin-top:12px;border-top:1px solid #333;padding-top:8px}
  .cell{display:flex;flex-direction:column;gap:4px}
  .lbl{color:#ffd;white-space:normal;max-width:640px}
  .zoom{display:block;zoom:${ZOOM};border:1px solid #444;image-rendering:pixelated}
  .ref{display:block;border:1px solid #444;max-height:600px}
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
      ${img(join(OUT, `before-${c.name}-zoom.png`), `before — ${c.label}`, 'ref')}
      ${img(join(OUT, `ours-${c.name}-zoom.png`), `after — ${c.label}`, 'ref')}
      ${c.ref ? img(join(REPO, 'reference', 'images', 'hud', c.ref), `retail — ${c.ref}`, 'ref') : ''}
    </div>`).join('');
  await page.setContent(`${CSS}<h1>CORE.17.k.b.b.c.b — the labels GameUI draws into DAT elements draw from their descs in the DAT states: before | after</h1>
    <p>Reference: the DAT (the 0x21000040:0x100002cd button family white in 0x1 / 0x2 / 0x3 / 0xd with the same art in 0x1 and 0x2; the 0x2100003f:0x10000375/76/77 labels white, 0xff4c4c4c in 0xd; the 0x21000066:0x1000057e text buttons green / yellow / red / white), UIElement_Text::DoFontReset @ 0046a560, UIElement_Button::UpdateState_ @ 00471cf0, gmAllegianceUI::UpdateMonarchData @ 00491b40; the retail frames on the right.</p>
    ${rows}`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17kbbcb-dat-label-colours-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17kbbcb] wrote ${join(OUT, 'core17kbbcb-dat-label-colours-sidebyside.png')}`);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--compose-only')) await captureLive();
  if (!BEFORE) await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
