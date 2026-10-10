/**
 * CORE.17.k.b.b.c.a — live evidence that the DAT labels GameUI used to
 * recolour by hand now draw their desc's own p27 (white) and that every tab
 * strip is driven the way `UIElement_Panel::Update @ 0046bd00` drives
 * retail's: the open tab in state 0xc (label 0xffcccccc + the open cap art),
 * every other tab in 0xb (0xff7f7f7f + the closed art).
 *
 *   magic-tabs        spellbook / components tabs 0x21000034 (spellbook-panel.jpg)
 *   options-tabs      the four options tabs 0x2100002b (options-config.jpg)
 *   social-tabs       allegiance / fellowship / friends / squelch 0x21000031 (fellowship-panel.jpg)
 *   map-tabs          map / house 0x21000027 (map-panel.jpg)
 *   contract-tabs     contracts / journal / page list 0x21000063
 *   char-tabs         attributes / skills / titles 0x2100002e (character-panel-attributes.jpg)
 *   spellbar          the spell-bar tabs 0x1000048f + the Cast button 0x21000010 (rawg_10.jpg)
 *   keyboard-buttons  the six 0x100002cd dialog buttons of 0x21000009
 *   combat-bar        Speed / Power labels 0x21000007 (rawg_02.jpg)
 *   vitae-title       the Vitae panel title 0x21000020:0x100000fe
 *   charinfo-title    the Character Information title 0x2100001a:0x100000fe
 *
 * `--before` writes before-*.png (run it on the pre-change build: git stash
 * the working changes first); the default run writes ours-*.png + zoom crops
 * and composes
 *   core17kbbca-tab-states-sidebyside.png   before | after, each cell at 2x
 * under verification/core17kbbca/.
 *
 * Usage: npx tsx tools/capture-core17kbbca-tab-states-sidebyside.ts [--before] [--compose-only] [--only=a,b]
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbca');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const ZOOM = 2;
const BEFORE = process.argv.includes('--before');
const PREFIX = BEFORE ? 'before' : 'ours';
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice('--only='.length).split(',').filter(Boolean);

const ui = (body: string): string => `(() => { const ui = window.__ac && window.__ac.gameUI; if (!ui) return; ${body} })()`;
const openIfAbsent = (layoutSel: string, toggle: string): string =>
  ui(`if (!document.querySelector('${layoutSel}')) ui.${toggle}();`);
const closeIfPresent = (layoutSel: string, toggle: string): string =>
  ui(`if (document.querySelector('${layoutSel}')) ui.${toggle}();`);

interface Cell {
  name: string;
  /** The element to crop. */
  selector: string;
  /** Crop only the top `cropH` px of the element (the tab strip). */
  cropH?: number;
  setupJs?: string;
  cleanupJs?: string;
  settleMs?: number;
  label: string;
  ref?: string;
}

const L = (id: number): string => `[data-layout-id="0x${id.toString(16)}"]`;

const CELLS: Cell[] = [
  {
    name: 'magic-tabs', selector: L(0x21000034), cropH: 60,
    setupJs: openIfAbsent(L(0x21000034), 'toggleMagicPanel'), cleanupJs: closeIfPresent(L(0x21000034), 'toggleMagicPanel'), settleMs: 1800,
    label: 'spellbook tabs 0x100002a9 / 0x100002aa (0x2100004d:0x1000043a): open 0xc = cap art 0x06005d92/94/96 + 0xffcccccc, closed 0xb = 93/95/97 + 0xff7f7f7f. Before: 0x06004cbe/bf overlay, gold / dim labels.',
    ref: 'spellbook-panel.jpg',
  },
  {
    name: 'magic-footer', selector: L(0x21000034),
    setupJs: openIfAbsent(L(0x21000034), 'toggleMagicPanel'), cleanupJs: closeIfPresent(L(0x21000034), 'toggleMagicPanel'), settleMs: 1200,
    label: 'the whole magic panel: Schools: / Levels: (0x10000376 base), the radio labels (0x21000044:0x10000329) and Delete (0x10000377 base) are white in the DAT. Before: gold / dim.',
    ref: 'spellbook-panel.jpg',
  },
  {
    name: 'options-tabs', selector: L(0x2100002b), cropH: 60,
    setupJs: openIfAbsent(L(0x2100002b), 'toggleOptionsPanel'), cleanupJs: closeIfPresent(L(0x2100002b), 'toggleOptionsPanel'), settleMs: 1800,
    label: 'options tabs 0x1000020d/0e/0x1000050b/0x1000020f: the open tab bright (0xffcccccc) on the open cap art, the rest grey (0xff7f7f7f). Before: 0x06004cbe/bf overlay, gold / dim labels.',
    ref: 'options-config.jpg',
  },
  {
    name: 'social-tabs', selector: L(0x21000031), cropH: 60,
    setupJs: openIfAbsent(L(0x21000031), 'toggleSocialPanel'), cleanupJs: closeIfPresent(L(0x21000031), 'toggleSocialPanel'), settleMs: 1800,
    label: 'social tabs 0x1000028c/8e/0x10000512/0x1000053b: DAT cap art + 0xffcccccc / 0xff7f7f7f. Before: hand-drawn CSS border / raised-tab chrome, gold / dim labels.',
    ref: 'fellowship-panel.jpg',
  },
  {
    name: 'social-fellowship', selector: L(0x21000031),
    setupJs: ui(`ui.socialTab = 'fellowship'; if (!document.querySelector('${L(0x21000031)}')) ui.toggleSocialPanel(); else ui.renderSocialPanel();`),
    cleanupJs: closeIfPresent(L(0x21000031), 'toggleSocialPanel'), settleMs: 1800,
    label: 'the whole fellowship pane: the four option rows 0x10000270–73 (0x21000044:0x1000032b, font 0x40000002) white. Before: textLight.',
    ref: 'fellowship-panel.jpg',
  },
  {
    name: 'map-tabs', selector: L(0x21000027), cropH: 60,
    setupJs: openIfAbsent(L(0x21000027), 'toggleMapPanel'), cleanupJs: closeIfPresent(L(0x21000027), 'toggleMapPanel'), settleMs: 1800,
    label: 'map / house tabs 0x100001f3 / 0x100001f4: DAT cap art + 0xffcccccc / 0xff7f7f7f. Before: 0x06004cbe/bf overlay, gold / dim labels.',
    ref: 'map-panel.jpg',
  },
  {
    name: 'contract-tabs', selector: L(0x21000063), cropH: 60,
    setupJs: openIfAbsent(L(0x21000063), 'toggleContractPanel'), cleanupJs: closeIfPresent(L(0x21000063), 'toggleContractPanel'), settleMs: 1800,
    label: 'contracts / journal / page list tabs: the same DAT states (the cap art was already the DAT\'s via paintTabCapSlices). Before: gold / dim labels.',
  },
  {
    name: 'char-tabs', selector: L(0x2100002e), cropH: 60,
    setupJs: openIfAbsent(L(0x2100002e), 'toggleCharPanel'), cleanupJs: closeIfPresent(L(0x2100002e), 'toggleCharPanel'), settleMs: 1800,
    label: 'character panel tabs 0x10000228 / 0x10000229 / 0x10000538: DAT cap art + 0xffcccccc / 0xff7f7f7f from their own desc text. Before: 0x06004cbe/bf overlay + hand-appended gold / dim labels.',
    ref: 'character-panel-attributes.jpg',
  },
  {
    name: 'spellbar', selector: '[data-element-id="0x100000a2"]',
    // The spell bar shows in magic mode only (updateSpellBarVisibility); it is a
    // bare render() with no data-layout-id on the root, so crop its 800x60 tab
    // host 0x100000a2.
    setupJs: ui(`ui.hud.combatMode = 8; ui.updateSpellBarVisibility(); ui.refreshSpellBarPanel();`),
    cleanupJs: '(() => { if (window.acDebug && window.acDebug.combatMode) window.acDebug.combatMode("peace"); })()',
    settleMs: 2500,
    label: 'spell bar 0x21000010: the tabs 0x1000048f in 0xc (0x06005eb8 + 0xffcccccc) / 0xb (0x06005eb9 + 0xff7f7f7f); the Cast button white (0x100002cd family). Before: the same textures by hand with gold / textMed labels, Cast in gold.',
    ref: 'rawg_10.jpg',
  },
  {
    name: 'keyboard-buttons', selector: L(0x21000009),
    setupJs: ui(`if (!document.querySelector('${L(0x21000009)}')) ui.toggleKeyboardConfigPanel();`),
    cleanupJs: ui(`if (document.querySelector('${L(0x21000009)}')) ui.closeKeyboardConfigPanel(false);`), settleMs: 2000,
    label: 'Keyboard Config: Load File… / Save As… / Defaults / Revert / OK / Cancel white (0x21000040:0x100002cd, font 0x40000001). Before: gold.',
    ref: 'options-config.jpg',
  },
  {
    name: 'combat-bar', selector: L(0x21000007),
    setupJs: '(() => { if (window.acDebug && window.acDebug.combatMode) window.acDebug.combatMode("melee"); })()',
    cleanupJs: '(() => { if (window.acDebug && window.acDebug.combatMode) window.acDebug.combatMode("peace"); })()', settleMs: 3000,
    label: 'combat bar 0x21000007: Speed / Power (0x2100003f:0x10000375 base, font 0x40000002) white. Before: textLight.',
    ref: 'rawg_02.jpg',
  },
  {
    name: 'vitae-title', selector: L(0x21000020), cropH: 40,
    setupJs: openIfAbsent(L(0x21000020), 'toggleVitaePanel'), cleanupJs: closeIfPresent(L(0x21000020), 'toggleVitaePanel'), settleMs: 1500,
    label: 'Vitae panel title 0x100000fe (0x2100003f:0x10000377, font 0x40000001) white. Before: textLight.',
  },
  {
    name: 'charinfo-title', selector: L(0x2100001a), cropH: 40,
    setupJs: openIfAbsent(L(0x2100001a), 'toggleCharacterInfoTextPanel'), cleanupJs: closeIfPresent(L(0x2100001a), 'toggleCharacterInfoTextPanel'), settleMs: 1500,
    label: 'Character Information title 0x100000fe (0x2100001a — the loot / examine / book / enchantments panels share it) white. Before: textLight / gold.',
    ref: 'examine-helm.jpg',
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
      console.log('[core17kbbca] not in world yet — reloading (phantom-session retry)');
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
  await page.evaluate((js) => { try { (0, eval)(js); } catch (e) { console.error('[core17kbbca] evalJs failed', e); } }, src);
}

/** Pixel-exact crop of the element's bounding rect + the labels (colour / font / state) it carries. */
async function zoomCrop(page: Page, cell: Cell, out: string) {
  const info = await page.evaluate(({ sel, cropH }) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const labels = Array.from(el.querySelectorAll('[data-ac-state], .layout-text > *')).slice(0, 40).map((n) => {
      const h = n as HTMLElement;
      const parent = h.closest('[data-element-id]') as HTMLElement | null;
      const canvas = h.matches('canvas') ? h as HTMLCanvasElement : h.querySelector('canvas');
      return {
        el: parent?.dataset.elementId, state: h.dataset.acState ?? parent?.dataset.acState,
        font: canvas?.dataset.acFont ?? h.dataset.acFont, text: h.textContent || canvas?.dataset.acFullText || '',
        bg: parent ? (parent.style.backgroundImage || '').replace(/^url\("?data:[^"]{0,24}.*$/, (m) => m.slice(0, 40) + '…') : '',
      };
    }).filter((l) => l.state || l.text);
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

/** Sample the label colours: the brightest opaque pixel of each tab-strip canvas, read back from the page. */
async function labelColours(page: Page, selector: string): Promise<Array<{ el?: string; state?: string; colour: string }>> {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel) as HTMLElement | null;
    if (!root) return [];
    const out: Array<{ el?: string; state?: string; colour: string }> = [];
    for (const c of Array.from(root.querySelectorAll('.layout-text canvas')).slice(0, 24)) {
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
      out.push({ el: parent?.dataset.elementId, state: parent?.dataset.acState ?? canvas.parentElement?.dataset.acState, colour });
    }
    return out;
  }, selector);
}

async function captureLive(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.on('console', (m) => { const t = m.text(); if (t.includes('[core17kbbca]')) console.log(t); });
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
    console.log(`[core17kbbca] ${cell.name}: ${zoom ? `${zoom.width}x${zoom.height} at (${zoom.x},${zoom.y}) colours=${JSON.stringify(colours)}` : 'MISSING ' + cell.selector}`);
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
  .ref{display:block;border:1px solid #444;max-height:420px}
  h1{font-size:14px;margin:0 0 8px}
  p{max-width:1500px;color:#ccc;margin:4px 0}
</style>`;

async function compose(): Promise<void> {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1900, height: 900 } });
  const img = (file: string, label: string, cls = 'zoom') => existsSync(file)
    ? `<div class="cell"><div class="lbl">${label}</div><img class="${cls}" src="${dataUrl(file)}"/></div>`
    : `<div class="cell"><div class="lbl">${label}: (no capture)</div></div>`;
  const rows = CELLS.map((c) => {
    const big = !c.cropH;
    return `<div class="row">
      ${img(join(OUT, `before-${c.name}-zoom.png`), `before — ${c.label}`, big ? 'ref' : 'zoom')}
      ${img(join(OUT, `ours-${c.name}-zoom.png`), `after — ${c.label}`, big ? 'ref' : 'zoom')}
      ${c.ref ? img(join(REPO, 'reference', 'images', 'hud', c.ref), `retail — ${c.ref}`, 'ref') : ''}
    </div>`;
  }).join('');
  await page.setContent(`${CSS}<h1>CORE.17.k.b.b.c.a — DAT labels in their desc's own p27; tab strips in UIElement_Panel::Update's 0xc open / 0xb closed states: before | after, ${ZOOM}x</h1>
    <p>Reference: the DAT (p27 entry 0 of every carrier = white; the tab bases' 0xb / 0xc states = 0xff7f7f7f / 0xffcccccc + the cap art) and UIElement_Panel::Update @ 0046bd00 (the open tab SetState(0xc), every other SetState(0xb)); the retail frames on the right.</p>
    ${rows}`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17kbbca-tab-states-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17kbbca] wrote ${join(OUT, 'core17kbbca-tab-states-sidebyside.png')}`);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--compose-only')) await captureLive();
  if (!BEFORE) await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
