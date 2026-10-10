/**
 * CORE.17.k.b.b.a.g.d — the two tooltip carriers left from .g.a: the map's
 * house icon 0x100001ee ("Your House", root 0x10000398, p80 0) placed by
 * gmMapUI::Update @ 004a1eb0 from the HouseData position, and the 3D view's
 * immediate tooltip while an item is being dragged (RecvNotice_SmartBoxObjectFound
 * @ 004e5ad0: m_dragElement set → ResetTooltip + StartTooltipAtMouse(0.0)).
 * Live capture on the ACE stack + a before | after side-by-side.
 *
 * Beats (each a whole-screen frame + a 2x crop around the mouse):
 *   idle          the HUD over the world
 *   map-house     the map with a house position set (a cottage at Holtburg's
 *                 landblock 0xA9B4 — the fresh DB has no owned house, so the
 *                 HouseData position is injected through setMapHousePosition;
 *                 the icon must land on Holtburg's pictogram), the mouse on
 *                 the icon → "Your House" at once; the coordinate text
 *                 0x100001ef and the player marker while outside
 *   world-drag    an item dragged out of the inventory over an object in the
 *                 3D view: the object's name at the mouse at once (no 0.25 s)
 *
 * Usage:
 *   npx tsx tools/capture-core17kbbagd-map-house-drag-tooltip-sidebyside.ts            # capture + compose
 *   npx tsx tools/capture-core17kbbagd-map-house-drag-tooltip-sidebyside.ts --before   # capture the pre-fix build
 *   npx tsx tools/capture-core17kbbagd-map-house-drag-tooltip-sidebyside.ts --compose-only
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbagd');
const RETAIL_MAP = join(REPO, 'reference', 'images', 'hud', 'map-panel.jpg');
const RETAIL_TIP = join(REPO, 'reference', 'images', 'hud', 'item-stack-tooltip.jpg');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const BASE = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const BEFORE = process.argv.includes('--before');
/** Re-run the drag beat alone and merge it into the existing live-state (the sweep depends on where the camera looks). */
const DRAG_ONLY = process.argv.includes('--drag-only');
const PREFIX = BEFORE ? 'ours-before-' : 'ours-';

/** A cottage at Holtburg's landblock (0xA9B4, cell 1, 12 m into the cell): retail plots it at 42.1N, 33.3E. */
const HOUSE_POSITION = { cell: 0xA9B40001, x: 12, y: 12, z: 0, rw: 1, rx: 0, ry: 0, rz: 0 };

interface TipState {
  dat: { text: string; element: string; left: number; top: number; width: number; height: number; font: string } | null;
  target: { tag: string; text: string | null; root: string | null } | null;
  mouse: { x: number; y: number };
  /** The map's house icon / player marker / coordinate text as they stand. */
  map: { house: { left: string; top: string; display: string; tex: string; tooltip: string | null; delay: string | null } | null; player: { left: string; top: string; display: string } | null; coords: string | null } | null;
  /** The drag beat: how the drag was driven and whether the machine saw it. */
  drag: { mode: string; active: boolean | null; foundName: string | null } | null;
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
    ui.wizard.name = 'House Tester';
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

/** The tooltip + map DOM as it stands (a source string: tsx would drag helpers into a closure). */
const STATE_JS = `((mx, my) => {
  const dat = document.querySelector('.ac-dat-tooltip');
  const datState = dat ? (() => { const r = dat.getBoundingClientRect(); const run = dat.querySelector('[data-ac-font]'); return { text: dat.dataset.acText || '', element: dat.dataset.element || '', left: r.left, top: r.top, width: r.width, height: r.height, font: run ? run.dataset.acFont : '' }; })() : null;
  const under = document.elementFromPoint(mx, my);
  let tagged = under; let target = null;
  while (tagged) { if (tagged.dataset && tagged.dataset.acTooltipText !== undefined) { target = { tag: tagged.tagName + (tagged.id ? '#' + tagged.id : ''), text: tagged.dataset.acTooltipText ?? null, root: tagged.dataset.acTooltipRoot ?? null }; break; } tagged = tagged.parentElement; }
  if (!target && under) target = { tag: under.tagName + (under.id ? '#' + under.id : ''), text: null, root: null };
  const ui = window.__ac && window.__ac.gameUI;
  let map = null;
  if (ui && ui.mapPanel) {
    const house = ui.mapPanel.querySelector('[data-map-house]');
    const player = ui.mapPlayerMarker || null;
    const coords = ui.mapPanel.querySelector('[data-map-coords]');
    map = {
      house: house ? { left: house.style.left, top: house.style.top, display: house.style.display, tex: house.dataset.tex || '', tooltip: house.dataset.acTooltipText ?? null, delay: house.dataset.acTooltipDelay ?? null } : null,
      player: player ? { left: player.style.left, top: player.style.top, display: player.style.display } : null,
      coords: coords ? (coords.dataset.acText ?? coords.textContent ?? '') : null,
    };
  }
  return { dat: datState, target, mouse: { x: mx, y: my }, map, drag: null };
})`;

async function tipState(page: Page, mx: number, my: number): Promise<TipState> {
  return page.evaluate(`${STATE_JS}(${mx}, ${my})`) as Promise<TipState>;
}

/** The state is read FIRST (the truth at the moment), then one full-frame screenshot (SwiftShader: ~8 s each). */
async function shoot(page: Page, name: string, mx: number, my: number, screens: Record<string, { file: string; state: TipState }>, opts: { waitForTip?: boolean; drag?: TipState['drag'] } = {}): Promise<TipState> {
  const file = `${PREFIX}${name}.png`;
  if (opts.waitForTip) {
    const t0 = Date.now();
    while (Date.now() - t0 < 4000) {
      const up = await page.evaluate(`!!document.querySelector('.ac-dat-tooltip')`).catch(() => false);
      if (up) break;
      await page.waitForTimeout(150);
    }
  }
  const state = await tipState(page, mx, my);
  if (opts.drag) state.drag = opts.drag;
  await page.screenshot({ path: join(OUT, file) });
  screens[name] = { file, state };
  console.log(`[core17kbbagd] ${name}: dat=${state.dat ? JSON.stringify(state.dat) : 'none'} target=${JSON.stringify(state.target)} map=${JSON.stringify(state.map)} drag=${JSON.stringify(state.drag)}`);
  return state;
}

async function centerOf(page: Page, js: string): Promise<{ x: number; y: number } | null> {
  return page.evaluate(`(() => { const el = (${js}); if (!el) return null; const r = el.getBoundingClientRect(); return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`) as Promise<{ x: number; y: number } | null>;
}

const HOVER_MS = 700;

async function openPanel(page: Page, js: string): Promise<void> {
  await page.evaluate(js);
  await page.waitForTimeout(1500);
}

async function captureLive(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.on('pageerror', (e) => console.log('[page error]', e.message));
  console.log(`[core17kbbagd] ${BASE}`);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await waitForWorld(page);
  console.log('[core17kbbagd] in world');
  await page.waitForTimeout(6000);
  await page.mouse.move(VIEW.width / 2, 120);
  await page.waitForTimeout(500);
  const screens: Record<string, { file: string; state: TipState }> = {};
  if (!DRAG_ONLY) await shoot(page, 'idle', VIEW.width / 2, 120, screens);

  if (!DRAG_ONLY) {
  // ── The map while inside (the fresh character starts in the Training Academy): retail hides the player icon and blanks the coordinate line ──
  await openPanel(page, `(() => { const ui = window.__ac.gameUI; if (!ui.mapPanelVisible) ui.toggleMapPanel(); })()`);
  await page.waitForTimeout(1500);
  const mapMid = await centerOf(page, `(() => { const ui = window.__ac.gameUI; return ui.mapCanvas || null; })()`);
  if (mapMid) {
    await page.mouse.move(mapMid.x, mapMid.y - 100); await page.waitForTimeout(300);
    await shoot(page, 'map-indoors', mapMid.x, mapMid.y - 100, screens);
  } else console.log('[core17kbbagd] no map canvas (indoors beat)');
  await page.evaluate(`(() => { const ui = window.__ac.gameUI; if (ui.mapPanelVisible) ui.toggleMapPanel(); })()`);
  await page.waitForTimeout(500);

  // ── Outside: @telepoi Holtburg (the world DB carries the POIs), then the map with the house position set ──
  await page.evaluate(`(() => { const ui = window.__ac.gameUI; ui.callbacks.onChatSend && ui.callbacks.onChatSend('@telepoi Holtburg'); })()`);
  console.log('[core17kbbagd] @telepoi Holtburg sent');
  await page.waitForTimeout(15_000);
  await page.mouse.move(VIEW.width / 2, 120); await page.waitForTimeout(500);
  const injected = await page.evaluate(`(() => { const ui = window.__ac.gameUI; if (typeof ui.setMapHousePosition !== 'function') return 'no-setter'; ui.setMapHousePosition(1, ${JSON.stringify(HOUSE_POSITION)}); return 'set'; })()`);
  console.log(`[core17kbbagd] house position: ${injected}`);
  await openPanel(page, `(() => { const ui = window.__ac.gameUI; if (!ui.mapPanelVisible) ui.toggleMapPanel(); })()`);
  await page.waitForTimeout(1500);
  const house = await centerOf(page, `(() => { const ui = window.__ac.gameUI; return ui.mapPanel ? ui.mapPanel.querySelector('[data-map-house]') : null; })()`);
  if (house) {
    await page.mouse.move(house.x, house.y); await page.waitForTimeout(HOVER_MS);
    await shoot(page, 'map-house', house.x, house.y, screens, { waitForTip: true });
  } else {
    // Before: no icon — hover where retail places it (Holtburg's pictogram, (21+164+4, 36+77+4) in the map block).
    const mapPt = await page.evaluate(`(() => { const ui = window.__ac.gameUI; const c = ui.mapCanvas; if (!c) return null; const r = c.getBoundingClientRect(); return { x: r.left + 166, y: r.top + 81 }; })()`) as { x: number; y: number } | null;
    if (mapPt) { await page.mouse.move(mapPt.x, mapPt.y); await page.waitForTimeout(HOVER_MS); await shoot(page, 'map-house', mapPt.x, mapPt.y, screens); }
    else console.log('[core17kbbagd] no map canvas');
  }
  await page.evaluate(`(() => { const ui = window.__ac.gameUI; if (ui.mapPanelVisible) ui.toggleMapPanel(); })()`);
  await page.waitForTimeout(500);
  }

  // ── The 3D view: find an object under the mouse (the canvas gets tagged) ──
  let found: { x: number; y: number } | null = null;
  const canvasTagged = `(() => { const c = document.querySelector('canvas'); return !!(c && c.dataset.acTooltipText); })()`;
  const sweep: Array<[number, number]> = [[0.5, 0.62], [0.5, 0.55], [0.5, 0.7], [0.45, 0.6], [0.55, 0.6], [0.5, 0.5], [0.4, 0.55], [0.6, 0.55], [0.3, 0.5], [0.7, 0.5], [0.35, 0.65], [0.65, 0.65]];
  for (let fy = 0.35; fy <= 0.8; fy += 0.09) for (let fx = 0.15; fx <= 0.85; fx += 0.07) sweep.push([fx, fy]);
  // The view after a teleport may face nothing but scenery: turn in place (the turn key) between passes.
  for (let pass = 0; pass < 6 && !found; pass++) {
    if (pass > 0) { await page.keyboard.down('ArrowLeft'); await page.waitForTimeout(650); await page.keyboard.up('ArrowLeft'); await page.waitForTimeout(400); }
    for (const [fx, fy] of sweep) {
      const x = VIEW.width * fx, y = VIEW.height * fy;
      await page.mouse.move(x, y); await page.waitForTimeout(160);
      await page.mouse.move(x + 1, y); await page.waitForTimeout(160);
      if (await page.evaluate(canvasTagged)) { found = { x: x + 1, y }; break; }
    }
  }
  if (found) {
    const foundName = await page.evaluate(`(() => { const c = document.querySelector('canvas'); return c ? (c.dataset.acTooltipText || null) : null; })()`) as string | null;
    // Let the hover tooltip lapse, then drag an item out of the inventory over the object.
    await page.mouse.move(VIEW.width / 2, 40); await page.waitForTimeout(600);
    await openPanel(page, `(() => { const ui = window.__ac.gameUI; if (!ui.inventoryPanel) ui.toggleInventory(); })()`);
    const cell = await centerOf(page, `document.querySelector('[data-inv-slot]')`);
    let mode = 'none';
    if (cell) {
      // Native HTML5 drag through Playwright's mouse (Chromium routes it as a real drag).
      await page.mouse.move(cell.x, cell.y); await page.mouse.down();
      await page.mouse.move(cell.x + 20, cell.y + 20, { steps: 5 });
      await page.mouse.move(found.x, found.y, { steps: 12 });
      await page.waitForTimeout(400);
      let active = await page.evaluate(`(() => { const ui = window.__ac.gameUI; return typeof ui.hudDragInProgress === 'function' ? ui.hudDragInProgress() : null; })()`) as boolean | null;
      mode = 'native';
      if (active !== true) {
        // Fall back to the events the browser fires during a drag, dispatched by hand.
        await page.mouse.up();
        await page.mouse.move(VIEW.width / 2, 40); await page.waitForTimeout(600);
        await openPanel(page, `(() => { const ui = window.__ac.gameUI; if (!ui.inventoryPanel) ui.toggleInventory(); })()`);
        const dispatched = await page.evaluate(`((fx, fy) => {
          const cellEl = document.querySelector('[data-inv-slot]');
          const canvas = document.querySelector('canvas');
          if (!cellEl || !canvas) return 'missing ' + (cellEl ? 'canvas' : 'cell');
          const r = cellEl.getBoundingClientRect();
          const mk = (type, x, y) => new DragEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: new DataTransfer() });
          cellEl.dispatchEvent(mk('dragstart', r.left + r.width / 2, r.top + r.height / 2));
          canvas.dispatchEvent(mk('dragover', fx - 3, fy));
          canvas.dispatchEvent(mk('dragover', fx, fy));
          return 'ok';
        })(${found.x}, ${found.y})`);
        console.log(`[core17kbbagd] synthetic drag: ${dispatched}`);
        await page.waitForTimeout(250);
        await page.evaluate(`((fx, fy) => { const canvas = document.querySelector('canvas'); if (canvas) canvas.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: fx, clientY: fy, dataTransfer: new DataTransfer() })); })(${found.x}, ${found.y})`);
        active = await page.evaluate(`(() => { const ui = window.__ac.gameUI; return typeof ui.hudDragInProgress === 'function' ? ui.hudDragInProgress() : null; })()`) as boolean | null;
        mode = 'synthetic';
      }
      // No wait: the tooltip must already be up (StartTooltipAtMouse(0.0)).
      await shoot(page, 'world-drag', found.x, found.y, screens, { drag: { mode, active, foundName } });
      if (mode === 'native') await page.mouse.up();
      else await page.evaluate(`(() => { const cellEl = document.querySelector('[data-inv-slot]'); if (cellEl) cellEl.dispatchEvent(new DragEvent('dragend', { bubbles: true })); })()`);
    } else console.log('[core17kbbagd] no inventory cell to drag');
    await page.evaluate(`(() => { const ui = window.__ac.gameUI; if (ui.inventoryPanel) ui.toggleInventory(); })()`);
  } else console.log('[core17kbbagd] no 3D object found under the sweep — the drag beat is skipped');

  const stateFile = join(OUT, BEFORE ? 'live-state-before.json' : 'live-state.json');
  const prior = DRAG_ONLY && existsSync(stateFile) ? (JSON.parse(readFileSync(stateFile, 'utf8')) as { screens: typeof screens }).screens : {};
  writeFileSync(stateFile, JSON.stringify({ screens: { ...prior, ...screens } }, null, 2));
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
  type Live = { screens: Record<string, { file: string; state: TipState }> };
  const load = (f: string): Live => existsSync(join(OUT, f)) ? JSON.parse(readFileSync(join(OUT, f), 'utf8')) as Live : { screens: {} };
  const live = load('live-state.json');
  const before = load('live-state-before.json');
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 2720, height: 900 } });
  const table = (src: Live, title: string): string => {
    const names = Object.keys(src.screens);
    if (!names.length) return '';
    const head = `<tr><th>beat</th><th>mouse</th><th>element under the mouse (tag / text / root)</th><th>DAT tooltip (text · root · box · font)</th><th>map (house icon · player marker · coordinate text)</th><th>drag (mode · active · found)</th></tr>`;
    const rows = names.map((n) => {
      const s = src.screens[n].state;
      const dat = s.dat ? `"${s.dat.text}" · ${s.dat.element} · (${s.dat.left.toFixed(0)},${s.dat.top.toFixed(0)}) ${s.dat.width.toFixed(0)}x${s.dat.height.toFixed(0)} · 0x${s.dat.font}` : '—';
      const map = s.map ? `house ${s.map.house ? `(${s.map.house.left},${s.map.house.top}) ${s.map.house.display || 'shown'} ${s.map.house.tex} "${s.map.house.tooltip ?? ''}" p80 ${s.map.house.delay ?? '—'}` : 'none'} · player ${s.map.player ? `(${s.map.player.left},${s.map.player.top}) ${s.map.player.display}` : 'none'} · coords ${s.map.coords === null ? 'no element' : `"${s.map.coords}"`}` : '—';
      const drag = s.drag ? `${s.drag.mode} · ${s.drag.active === null ? 'no flag' : s.drag.active} · ${s.drag.foundName ?? '—'}` : '—';
      return `<tr><td>${n}</td><td>(${s.mouse.x.toFixed(0)},${s.mouse.y.toFixed(0)})</td><td>${s.target ? `${s.target.tag} / ${s.target.text ?? '—'} / ${s.target.root ?? '—'}` : '—'}</td><td>${dat}</td><td>${map}</td><td>${drag}</td></tr>`;
    }).join('');
    return `<h2>${title}</h2><table>${head}${rows}</table>`;
  };
  const cropCell = (src: Live, name: string, file: string, label: string): string => {
    const s = src.screens[name]?.state;
    if (!s || !existsSync(file)) return `<div class="cell"><div class="lbl">${label}: (no capture)</div></div>`;
    const x = Math.max(0, Math.min(VIEW.width - 360, s.mouse.x - 120));
    const y = Math.max(0, Math.min(VIEW.height - 160, s.mouse.y - 80));
    return `<div class="cell"><div class="lbl">${label}</div><div style="width:720px;height:320px;border:1px solid #444;background-image:url(${dataUrl(file)});background-size:${VIEW.width * 2}px ${VIEW.height * 2}px;background-position:-${x * 2}px -${y * 2}px;image-rendering:pixelated"></div></div>`;
  };
  const beatRow = (title: string, name: string, retail?: string): string => {
    const cells = [
      ...(retail ? [frame(retail, 'retail reference', 420)] : []),
      cropCell(before, name, join(OUT, `ours-before-${name}.png`), `before — ${name} (2x crop at the mouse)`),
      cropCell(live, name, join(OUT, `ours-${name}.png`), `after — ${name} (2x crop at the mouse)`),
      frame(join(OUT, `ours-before-${name}.png`), 'before — whole screen', 560),
      frame(join(OUT, `ours-${name}.png`), 'after — whole screen', 560),
    ];
    return `<h2>${title}</h2><div class="row">${cells.join('')}</div>`;
  };
  const html = `${CSS}<h1>CORE.17.k.b.b.a.g.d — the map's house icon 0x100001ee (gmMapUI::RecvNotice_UpdateHouseData @ 004a1870 keeps the HouseData position unless the type is Apartment; Update @ 004a1eb0 plots it through PlaceMarkerOnMap @ 004a18b0 from the outside cell's landscape coordinate — x = x0 + trunc(width · (EW·10 + 1024) / 2048) − w/2, y = y0 + trunc(height · (1023 − NS·10) / 2048) − h/2 over the map's p0x1000004e–51 marker box 6..247 × 8..258 — with "Your House" (p73) as root 0x10000398 at once (p80 0); the same Update writes the coordinate text 0x100001ef "%.1f%s, %.1f%s" while outside and hides the player marker inside) and the 3D view's immediate tooltip while dragging (RecvNotice_SmartBoxObjectFound @ 004e5ad0: with UIElementManager::m_dragElement set and the cursor in the viewport, a newly found object's name is shown at once — ResetTooltip + StartTooltipAtMouse(0.0)); before: no house icon, no coordinate text, and no tooltip at all while an item is dragged over the world (the browser fires no mousemove during a native drag).</h1>
    ${beatRow('map while inside (the Training Academy) — retail: no player icon, a blank coordinate line (map-panel.jpg is such a frame); before: the marker drawn at the dungeon\'s nominal landblock, no coordinate element', 'map-indoors', RETAIL_MAP)}
    ${beatRow('map outside at Holtburg with a cottage at its landblock — retail: the 8x8 0x06004d11 icon on Holtburg\'s pictogram, "Your House" at once; the player icon and the coordinate text "42.1N, 33.3E"-style while outside; before: no icon, no text', 'map-house')}
    ${beatRow('3D view, an item dragged over an object — retail: its name at the mouse at once (no 0.25 s delay); before: nothing', 'world-drag')}
    ${frame(RETAIL_TIP, 'retail — the in-game tooltip chrome on file (reference/images/hud/item-stack-tooltip.jpg, 4x)', 400, true)}
    ${table(live, 'the DOM per beat (after, live-state.json)')}
    ${table(before, 'the DOM per beat (before, live-state-before.json)')}`;
  await page.setContent(html);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'core17kbbagd-map-house-drag-tooltip-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17kbbagd] wrote ${join(OUT, 'core17kbbagd-map-house-drag-tooltip-sidebyside.png')}`);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--compose-only')) await captureLive();
  if (!BEFORE) await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
