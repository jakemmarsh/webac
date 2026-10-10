/**
 * CORE.17.k.b.b.a.g — the in-game hover tooltips through the retail
 * tooltip machine: live capture on the ACE stack + a retail | before | after
 * side-by-side.
 *
 * Beats (each a whole-screen frame + a 2x crop around the mouse, the
 * tooltip DOM recorded in live-state.json):
 *   inventory-item   the first occupied inventory cell hovered
 *                    (UIElement_UIItem::UpdateTooltip @ 004e1cb0:
 *                    "<stack> <plural name>" / "<name>")
 *   equip-neck       the paperdoll's neck slot hovered while empty
 *                    (gmPaperDollUI::UpdateItemSlotTooltip @ 004a4e90:
 *                    "Drag necklaces here to wear them")
 *   equip-band       the paperdoll drag band 0x100001d6 (its DAT p73)
 *   spell-slot       a spell-bar shortcut hovered in Magic mode with a spell
 *                    put in slot 1 (SpellCastSubMenu::UpdateFromPlayerModule
 *                    @ 004c6570: the spell's name)
 *   radar-blip       the nearest radar blip hovered (gmRadarUI::DrawObjects
 *                    @ 004d9380: the object's name), when one is in range
 *   expiry           the inventory tooltip after m_tooltipDuration (10 s)
 *
 * Usage:
 *   npx tsx tools/capture-core17kbbag-hud-tooltips-sidebyside.ts            # capture + compose
 *   npx tsx tools/capture-core17kbbag-hud-tooltips-sidebyside.ts --before   # capture the pre-fix build
 *   npx tsx tools/capture-core17kbbag-hud-tooltips-sidebyside.ts --compose-only
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbag');
const RETAIL = join(REPO, 'reference', 'images', 'hud', 'item-stack-tooltip.jpg');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const BASE = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const BEFORE = process.argv.includes('--before');
const PREFIX = BEFORE ? 'ours-before-' : 'ours-';

interface TipState {
  /** The DAT tooltip (after): its text, root, box, position. */
  dat: { text: string; element: string; left: number; top: number; width: number; height: number; font: string } | null;
  /** The pre-fix CSS tooltip (before): its lines and box. */
  legacy: { lines: string[]; left: number; top: number; width: number; height: number } | null;
  /** A native title attribute under the mouse (before: the paperdoll slots / spell slots). */
  title: string | null;
  /** The element under the mouse and its tooltip tag. */
  target: { tag: string; text: string | null; root: string | null } | null;
  mouse: { x: number; y: number };
}

function launch() {
  return chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
}

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
    ui.wizard.name = 'Tooltip Tester';
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

/** The tooltip DOM as it stands (source string: tsx injects helpers a closure would drag into the page). */
const STATE_JS = `((mx, my) => {
  const dat = document.querySelector('.ac-dat-tooltip');
  const datState = dat ? (() => { const r = dat.getBoundingClientRect(); const run = dat.querySelector('[data-ac-font]'); return { text: dat.dataset.acText || '', element: dat.dataset.element || '', left: r.left, top: r.top, width: r.width, height: r.height, font: run ? run.dataset.acFont : '' }; })() : null;
  let legacy = null;
  for (const d of document.body.children) {
    if (d.style && d.style.position === 'fixed' && d.style.maxWidth === '250px' && d.style.pointerEvents === 'none') {
      const r = d.getBoundingClientRect();
      legacy = { lines: Array.from(d.children).map((c) => c.textContent || ''), left: r.left, top: r.top, width: r.width, height: r.height };
    }
  }
  const under = document.elementFromPoint(mx, my);
  let titled = under; let title = null;
  while (titled) { if (titled.getAttribute && titled.getAttribute('title')) { title = titled.getAttribute('title'); break; } titled = titled.parentElement; }
  let tagged = under; let target = null;
  while (tagged) { if (tagged.dataset && (tagged.dataset.acTooltipText !== undefined || tagged.dataset.acTooltip !== undefined)) { target = { tag: tagged.tagName + (tagged.id ? '#' + tagged.id : ''), text: tagged.dataset.acTooltipText ?? null, root: tagged.dataset.acTooltipRoot ?? null }; break; } tagged = tagged.parentElement; }
  if (!target && under) target = { tag: under.tagName + (under.id ? '#' + under.id : ''), text: null, root: null };
  return { dat: datState, legacy, title, target, mouse: { x: mx, y: my } };
})`;

async function tipState(page: Page, mx: number, my: number): Promise<TipState> {
  return page.evaluate(`${STATE_JS}(${mx}, ${my})`) as Promise<TipState>;
}

/**
 * SwiftShader timing: a screenshot of the WebGL page takes ~8.5 s and the
 * render loop starves timers, so the tooltip's 0.25 s → 10 s life can fall
 * between two screenshots. The state is read FIRST (the truth at the hover
 * moment), then one full-frame screenshot; the 2x crop is cut from that
 * frame in compose() rather than taken as a second, later screenshot.
 */
async function shoot(page: Page, name: string, mx: number, my: number, screens: Record<string, { file: string; crop: string; state: TipState }>, opts: { waitForTip?: boolean } = {}): Promise<TipState> {
  const file = `${PREFIX}${name}.png`;
  if (opts.waitForTip !== false) {
    // Poll for the machine to fire (the delay is 0.25 s; the starved timer can take longer).
    const t0 = Date.now();
    while (Date.now() - t0 < 4000) {
      const up = await page.evaluate(`!!document.querySelector('.ac-dat-tooltip') || Array.from(document.body.children).some((d) => d.style && d.style.maxWidth === '250px' && d.style.position === 'fixed')`).catch(() => false);
      if (up) break;
      await page.waitForTimeout(150);
    }
  }
  const state = await tipState(page, mx, my);
  await page.screenshot({ path: join(OUT, file) });
  screens[name] = { file, crop: `${PREFIX}${name}-crop.png`, state };
  console.log(`[core17kbbag] ${name}: dat=${state.dat ? JSON.stringify(state.dat) : 'none'} legacy=${state.legacy ? JSON.stringify(state.legacy.lines) : 'none'} title=${state.title ?? 'none'} target=${JSON.stringify(state.target)}`);
  return state;
}

/** Centre of the first element matching `js` (a page-side expression yielding an Element or null). */
async function centerOf(page: Page, js: string): Promise<{ x: number; y: number } | null> {
  return page.evaluate(`(() => { const el = (${js}); if (!el) return null; const r = el.getBoundingClientRect(); return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`) as Promise<{ x: number; y: number } | null>;
}

const HOVER_MS = 700; // > the 350 ms legacy delay and > retail's 0.25 s
const DEFAULT_DURATION_MS = 10_000; // UIElementManager's m_tooltipDuration

async function captureLive(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.on('pageerror', (e) => console.log('[page error]', e.message));
  console.log(`[core17kbbag] ${BASE}`);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await waitForWorld(page);
  console.log('[core17kbbag] in world');
  await page.waitForTimeout(6000);
  // Park the mouse in the sky first so nothing is hovered.
  await page.mouse.move(VIEW.width / 2, 120);
  await page.waitForTimeout(500);
  const screens: Record<string, { file: string; crop: string; state: TipState }> = {};
  await shoot(page, 'idle', VIEW.width / 2, 120, screens, { waitForTip: false });

  // ── The inventory panel ──
  await page.evaluate(`(() => { const ui = window.__ac.gameUI; if (!ui.inventoryPanel) ui.toggleInventory(); })()`);
  await page.waitForTimeout(1500);
  const invCellJs = `(() => { const ui = window.__ac.gameUI; const panel = ui.inventoryPanel; if (!panel) return null;
    const cells = Array.from(panel.querySelectorAll('div')).filter((d) => d.style.width === '32px' && d.style.height === '32px' && d.style.cursor === 'pointer' && d.getAttribute('draggable') === 'true' && d.style.position === 'relative');
    return cells[0] || null; })()`;
  const inv = await centerOf(page, invCellJs);
  if (inv) {
    await page.mouse.move(inv.x, inv.y);
    await page.waitForTimeout(HOVER_MS);
    await shoot(page, 'inventory-item', inv.x, inv.y, screens);
    // The item under the mouse, for the text table.
    const item = await page.evaluate(`(() => { const ui = window.__ac.gameUI; const it = ui.inventoryItems && ui.inventoryItems[0]; return it ? { name: it.name, pluralName: it.pluralName, stackSize: it.stackSize } : null; })()`);
    console.log(`[core17kbbag] first inventory item: ${JSON.stringify(item)}`);
    writeFileSync(join(OUT, `${PREFIX}inventory-item.json`), JSON.stringify(item, null, 2));
  } else {
    console.log('[core17kbbag] no occupied inventory cell found');
  }

  // ── The paperdoll neck slot (empty on a fresh character) + the drag band ──
  const neckJs = `(() => { const ui = window.__ac.gameUI; const h = ui.inventoryPanelHandle; const pd = h && h.elements.get(0x100001cd); if (!pd) return null;
    const slots = Array.from(pd.children).filter((d) => d.style.width === '32px' && d.style.left === '8px' && d.style.top === '8px'); return slots[0] || null; })()`;
  const neck = await centerOf(page, neckJs);
  if (neck) {
    await page.mouse.move(neck.x, neck.y);
    await page.waitForTimeout(HOVER_MS);
    await shoot(page, 'equip-neck', neck.x, neck.y, screens);
  }
  const bandJs = `(() => { const ui = window.__ac.gameUI; const h = ui.inventoryPanelHandle; const pd = h && h.elements.get(0x100001cd); if (!pd) return null;
    const bands = Array.from(pd.children).filter((d) => d.style.width === '100px' && d.style.height === '214px'); return bands[0] || null; })()`;
  const band = await centerOf(page, bandJs);
  if (band) {
    // The band covers the 3D figure; hover its lower third so the frame shows the figure too.
    const by = band.y + 60;
    await page.mouse.move(band.x, by);
    await page.waitForTimeout(HOVER_MS);
    await shoot(page, 'equip-band', band.x, by, screens);
  }

  // ── Expiry: hold on the inventory cell for > 10 s ──
  if (inv) {
    await page.mouse.move(inv.x, inv.y);
    // Wait for the machine to show it (the starved timer can lag the 0.25 s), THEN the duration.
    const t0 = Date.now(); let shownAt = -1;
    while (Date.now() - t0 < 8000) {
      const s = await tipState(page, inv.x, inv.y);
      if (s.dat || s.legacy) { shownAt = Date.now() - t0; break; }
      await page.waitForTimeout(150);
    }
    // SwiftShader starves timers by whole frames (seconds), so the hold carries
    // a 4 s margin past m_tooltipDuration — the tooltip must be gone by then.
    console.log(`[core17kbbag] expiry: shown after ${shownAt} ms (−1 = never within 8 s); now holding ${DEFAULT_DURATION_MS + 4000} ms`);
    await page.waitForTimeout(DEFAULT_DURATION_MS + 4000);
    await shoot(page, 'inventory-item-after-10s', inv.x, inv.y, screens, { waitForTip: false });
  }

  // ── The spell bar: Magic mode + a spell in slot 1 of the active tab ──
  await page.evaluate(`(() => { const ui = window.__ac.gameUI;
    ui.hud.combatMode = 8; ui.updateSpellBarVisibility();
    const tab = ui.activeSpellBarTab; if (!ui.spellBarSlots[tab][0]) ui.spellBarSlots[tab][0] = { id: 1, name: 'Strength Other I', school: 1, level: 1, power: 10, manaCost: 10, difficulty: 10, duration: 1800, components: [], iconId: 0 };
    ui.refreshSpellBarPanel(); })()`);
  await page.waitForTimeout(800);
  const slotJs = `document.querySelector('[data-spell-slot$="-0"]:not([style*="display: none"])')`;
  const slot = await centerOf(page, `(() => { const ui = window.__ac.gameUI; return document.querySelector('[data-spell-slot="' + ui.activeSpellBarTab + '-0"]'); })()`);
  void slotJs;
  if (slot) {
    await page.mouse.move(slot.x, slot.y);
    await page.waitForTimeout(HOVER_MS);
    await shoot(page, 'spell-slot', slot.x, slot.y, screens);
  } else {
    console.log('[core17kbbag] no spell-bar slot found');
  }

  // ── The radar: the nearest blip, if any object is in range ──
  const blip = await page.evaluate(`(() => { const ui = window.__ac.gameUI; ui.drawRadar && ui.drawRadar(); const hits = ui.radarBlipHits || []; const c = document.getElementById('radar-canvas'); if (!c || !hits.length) return null;
    const r = c.getBoundingClientRect(); const sx = r.width / c.width, sy = r.height / c.height;
    const named = hits.filter((h) => h.name); if (!named.length) return null; const h = named[0];
    return { x: r.left + (h.x + 0.5) * sx, y: r.top + (h.y + 0.5) * sy, name: h.name, hits: hits.length }; })()`) as { x: number; y: number; name: string; hits: number } | null;
  if (blip) {
    console.log(`[core17kbbag] radar blip "${blip.name}" at (${blip.x.toFixed(1)}, ${blip.y.toFixed(1)}) of ${blip.hits}`);
    await page.mouse.move(blip.x, blip.y);
    await page.waitForTimeout(HOVER_MS);
    await shoot(page, 'radar-blip', blip.x, blip.y, screens);
    // Off the blip: the tooltip goes (ClearTooltip when nothing is under the mouse).
    await page.mouse.move(blip.x + 30, blip.y + 30);
    await page.waitForTimeout(300);
    await shoot(page, 'radar-off-blip', blip.x + 30, blip.y + 30, screens, { waitForTip: false });
  } else {
    console.log('[core17kbbag] no named radar blip in range — beat skipped');
  }

  writeFileSync(join(OUT, BEFORE ? 'live-state-before.json' : 'live-state.json'), JSON.stringify({ screens }, null, 2));
  await browser.close();
}

function dataUrl(file: string): string {
  const ext = file.endsWith('.webp') ? 'webp' : file.endsWith('.jpg') ? 'jpeg' : 'png';
  return `data:image/${ext};base64,${readFileSync(file).toString('base64')}`;
}
function frame(file: string, label: string, width = 520, pixelated = false): string {
  return existsSync(file)
    ? `<div class="cell"><div class="lbl">${label}</div><img src="${dataUrl(file)}" style="width:${width}px;border:1px solid #444${pixelated ? ';image-rendering:pixelated' : ''}"/></div>`
    : `<div class="cell"><div class="lbl">${label}: (no capture)</div></div>`;
}

const CSS = `<style>
  body{margin:0;background:#1a1a1a;color:#eee;font:13px/1.3 monospace;padding:10px}
  .row{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;margin-top:12px}
  .cell{display:flex;flex-direction:column;gap:4px}
  .lbl{color:#ffd;white-space:normal;max-width:720px}
  h1{font-size:14px;margin:0 0 8px}
  h2{font-size:13px;margin:14px 0 0;color:#9cf}
  table{border-collapse:collapse;margin-top:8px} td,th{border:1px solid #444;padding:2px 6px;text-align:left;vertical-align:top;max-width:520px;word-break:break-all} th{color:#9cf}
</style>`;

async function compose(): Promise<void> {
  type Live = { screens: Record<string, { file: string; crop: string; state: TipState }> };
  const load = (f: string): Live => existsSync(join(OUT, f)) ? JSON.parse(readFileSync(join(OUT, f), 'utf8')) as Live : { screens: {} };
  const live = load('live-state.json');
  const before = load('live-state-before.json');
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 2720, height: 900 } });
  const table = (src: Live, title: string): string => {
    const names = Object.keys(src.screens);
    if (!names.length) return '';
    const head = `<tr><th>beat</th><th>mouse</th><th>element under the mouse (tag / text / root)</th><th>DAT tooltip (text · root · box · font)</th><th>legacy CSS tooltip</th><th>native title</th></tr>`;
    const rows = names.map((n) => {
      const s = src.screens[n].state;
      const dat = s.dat ? `"${s.dat.text}" · ${s.dat.element} · (${s.dat.left.toFixed(0)},${s.dat.top.toFixed(0)}) ${s.dat.width.toFixed(0)}x${s.dat.height.toFixed(0)} · 0x${s.dat.font}` : '—';
      const leg = s.legacy ? `${JSON.stringify(s.legacy.lines)} (${s.legacy.left.toFixed(0)},${s.legacy.top.toFixed(0)}) ${s.legacy.width.toFixed(0)}x${s.legacy.height.toFixed(0)}` : '—';
      return `<tr><td>${n}</td><td>(${s.mouse.x.toFixed(0)},${s.mouse.y.toFixed(0)})</td><td>${s.target ? `${s.target.tag} / ${s.target.text ?? '—'} / ${s.target.root ?? '—'}` : '—'}</td><td>${dat}</td><td>${leg}</td><td>${s.title ?? '—'}</td></tr>`;
    }).join('');
    return `<h2>${title}</h2><table>${head}${rows}</table>`;
  };
  /** A 2x crop (360x160 around the mouse) cut from the full frame — the same instant as the whole-screen shot. */
  const cropCell = (src: Live, name: string, file: string, label: string): string => {
    const s = src.screens[name]?.state;
    if (!s || !existsSync(file)) return `<div class="cell"><div class="lbl">${label}: (no capture)</div></div>`;
    const x = Math.max(0, Math.min(VIEW.width - 360, s.mouse.x - 60));
    const y = Math.max(0, Math.min(VIEW.height - 160, s.mouse.y - 40));
    return `<div class="cell"><div class="lbl">${label}</div><div style="width:720px;height:320px;border:1px solid #444;background-image:url(${dataUrl(file)});background-size:${VIEW.width * 2}px ${VIEW.height * 2}px;background-position:-${x * 2}px -${y * 2}px;image-rendering:pixelated"></div></div>`;
  };
  const beatRow = (title: string, name: string): string => {
    const cells = [
      cropCell(before, name, join(OUT, `ours-before-${name}.png`), `before — ${name} (2x crop at the mouse)`),
      cropCell(live, name, join(OUT, `ours-${name}.png`), `after — ${name} (2x crop at the mouse)`),
      frame(join(OUT, `ours-before-${name}.png`), `before — whole screen`, 560),
      frame(join(OUT, `ours-${name}.png`), `after — whole screen`, 560),
    ];
    return `<h2>${title}</h2><div class="row">${cells.join('')}</div>`;
  };
  const html = `${CSS}<h1>CORE.17.k.b.b.a.g — in-game hover tooltips through UIElementManager's tooltip machine (CheckTooltip @ 0045b6e0: 0.25 s after the last mouse move, 10 s duration, gone when the mouse enters another element) drawn as the 0x21000041 root 0x10000395 every HUD element names in p71 (fill 0x06004cc2 black at alpha 175, 1-px 0x06004cc8 gold edges, text child 0x10000396 (2,1) 26x28 in font 0x40000002 white, wrapped at 256 − margins) at mouse + 32 clamped to the display. Texts: UIElement_UIItem::UpdateTooltip @ 004e1cb0 ("&lt;stack&gt; &lt;plural&gt;" / the name — nothing else), gmPaperDollUI::UpdateItemSlotTooltip @ 004a4e90 (the per-slot "Drag … here" literals / the worn item's name), SpellCastSubMenu::UpdateFromPlayerModule @ 004c6570 (the spell's name), gmRadarUI::DrawObjects @ 004d9380 (the object under the mouse). Before: an invented 350 ms dark-navy CSS box with Value / Burden / Stack / School / Mana / Level / Difficulty / Duration / Components lines, native title tooltips on the paperdoll and spell slots, no expiry.</h1>
    <div class="row">${frame(RETAIL, 'retail — the in-game item tooltip on file (reference/images/hud/item-stack-tooltip.jpg, 4x)', 400, true)}</div>
    ${beatRow('inventory item hovered — retail: "&lt;stack&gt; &lt;plural name&gt;" on the black-at-175 plate with 1-px gold edges', 'inventory-item')}
    ${beatRow('the same cell 14 s after the tooltip appeared (m_tooltipDuration 10 s + a 4 s SwiftShader timer margin) — retail: the tooltip has expired; before: the CSS box never expired', 'inventory-item-after-10s')}
    ${beatRow('paperdoll neck slot (empty) — retail: "Drag necklaces here to wear them" (before: the browser\'s native title box, if the OS drew one)', 'equip-neck')}
    ${beatRow('paperdoll drag band 0x100001d6 — retail: its DAT p73 "Drag clothing and armor here to wear them"', 'equip-band')}
    ${beatRow('spell-bar shortcut (Magic mode) — retail: the spell\'s name only', 'spell-slot')}
    ${beatRow('radar blip — retail: the object\'s name; off the blip: ClearTooltip', 'radar-blip')}
    ${beatRow('radar, off the blip', 'radar-off-blip')}
    ${table(live, 'the tooltip DOM per beat (after, live-state.json)')}
    ${table(before, 'the tooltip DOM per beat (before, live-state-before.json)')}`;
  await page.setContent(html);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'core17kbbag-hud-tooltips-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17kbbag] wrote ${join(OUT, 'core17kbbag-hud-tooltips-sidebyside.png')}`);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--compose-only')) await captureLive();
  if (!BEFORE) await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
