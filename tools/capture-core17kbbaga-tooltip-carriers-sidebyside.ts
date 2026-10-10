/**
 * CORE.17.k.b.b.a.g.a — the remaining retail tooltip carriers through the
 * HUD tooltip machine: live capture on the ACE stack + a before | after
 * side-by-side (retail references where one exists).
 *
 * Beats (each a whole-screen frame + a 2x crop around the mouse):
 *   char-attr-row    the character panel's Strength row hovered
 *                    (AttributeInfoRegion @ 004f1530: InqAttributeDescription)
 *   char-vital-row   the Health row (Attribute2ndInfoRegion @ 004f1680)
 *   char-skill-row   a skills-tab row (SkillInfoRegion::GetTooltip @ 004f1fe0:
 *                    formula + "\n" + description)
 *   slots-gem        the paperdoll "Slots" gem (its p73, root 0x10000397)
 *   map-town         Holtburg's pictogram on the map (gmMapUI::AddMapNote,
 *                    root 0x10000398 in font 0x40000015, no delay)
 *   cast-button      the spell bar's Cast button 0x100000b2 in Magic mode
 *                    (UpdateCastButtonTooltip @ 004c6a30)
 *   world-hover      an object in the 3D view under the mouse
 *                    (UIElement_SmartBoxWrapper::RecvNotice_SmartBoxObjectFound)
 *
 * Usage:
 *   npx tsx tools/capture-core17kbbaga-tooltip-carriers-sidebyside.ts            # capture + compose
 *   npx tsx tools/capture-core17kbbaga-tooltip-carriers-sidebyside.ts --before   # capture the pre-fix build
 *   npx tsx tools/capture-core17kbbaga-tooltip-carriers-sidebyside.ts --compose-only
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbaga');
const RETAIL = join(REPO, 'reference', 'images', 'hud', 'item-stack-tooltip.jpg');
const RETAIL_CHAR = join(REPO, 'reference', 'images', 'hud', 'character-panel-attributes.jpg');
const RETAIL_MAP = join(REPO, 'reference', 'images', 'hud', 'map-panel.jpg');
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
    ui.wizard.name = 'Carrier Tester';
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
  console.log(`[core17kbbaga] ${name}: dat=${state.dat ? JSON.stringify(state.dat) : 'none'} legacy=${state.legacy ? JSON.stringify(state.legacy.lines) : 'none'} title=${state.title ?? 'none'} target=${JSON.stringify(state.target)}`);
  return state;
}

/** Centre of the first element matching `js` (a page-side expression yielding an Element or null). */
async function centerOf(page: Page, js: string): Promise<{ x: number; y: number } | null> {
  return page.evaluate(`(() => { const el = (${js}); if (!el) return null; const r = el.getBoundingClientRect(); return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`) as Promise<{ x: number; y: number } | null>;
}

const HOVER_MS = 700; // > the 350 ms legacy delay and > retail's 0.25 s
const DEFAULT_DURATION_MS = 10_000; // UIElementManager's m_tooltipDuration


async function openPanel(page: Page, js: string): Promise<void> {
  await page.evaluate(js);
  await page.waitForTimeout(1500);
}

/** The overhead name label (before: the client's hover / selected label; gone since CORE.17.k.b.b.a.g.b — null). */
async function overheadLabel(page: Page): Promise<{ shown: boolean; text: string } | null> {
  return page.evaluate(`(() => { const c = document.getElementById('name-labels'); if (!c) return null; const l = c.firstElementChild; if (!l) return null; return { shown: l.style.display !== 'none', text: l.textContent || '' }; })()`) as Promise<{ shown: boolean; text: string } | null>;
}

async function captureLive(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.on('pageerror', (e) => console.log('[page error]', e.message));
  console.log(`[core17kbbaga] ${BASE}`);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await waitForWorld(page);
  console.log('[core17kbbaga] in world');
  await page.waitForTimeout(6000);
  await page.mouse.move(VIEW.width / 2, 120);
  await page.waitForTimeout(500);
  const screens: Record<string, { file: string; crop: string; state: TipState }> = {};
  await shoot(page, 'idle', VIEW.width / 2, 120, screens, { waitForTip: false });

  // ── The character panel: attributes tab ──
  await openPanel(page, `(() => { const ui = window.__ac.gameUI; ui.charPanelTab = 'attributes'; if (!ui.charPanelVisible) ui.toggleCharPanel(); else ui.renderCharPanel(); })()`);
  const attr = await centerOf(page, `document.querySelector('[data-stat-row="attr:1"]')`);
  if (attr) {
    await page.mouse.move(attr.x, attr.y); await page.waitForTimeout(HOVER_MS);
    await shoot(page, 'char-attr-row', attr.x, attr.y, screens);
  } else console.log('[core17kbbaga] no attribute row found');
  const vital = await centerOf(page, `document.querySelector('[data-stat-row="vital:1"]')`);
  if (vital) {
    await page.mouse.move(vital.x, vital.y); await page.waitForTimeout(HOVER_MS);
    await shoot(page, 'char-vital-row', vital.x, vital.y, screens);
  }
  // ── Skills tab ──
  await openPanel(page, `(() => { const ui = window.__ac.gameUI; ui.charPanelTab = 'skills'; ui.renderCharPanel(); })()`);
  const skill = await centerOf(page, `document.querySelector('[data-stat-row^="skill:"]')`);
  if (skill) {
    await page.mouse.move(skill.x, skill.y); await page.waitForTimeout(HOVER_MS);
    await shoot(page, 'char-skill-row', skill.x, skill.y, screens);
  } else console.log('[core17kbbaga] no skill row found');
  await page.evaluate(`(() => { const ui = window.__ac.gameUI; ui.charPanelTab = 'attributes'; if (ui.charPanelVisible) ui.toggleCharPanel(); })()`);
  await page.waitForTimeout(500);

  // ── The paperdoll Slots gem ──
  await openPanel(page, `(() => { const ui = window.__ac.gameUI; if (!ui.inventoryPanel) ui.toggleInventory(); })()`);
  const gem = await centerOf(page, `(() => { const ui = window.__ac.gameUI; const h = ui.inventoryPanelHandle; const pd = h && h.elements.get(0x100001cd); if (!pd) return null;
    return Array.from(pd.children).find((d) => d.style.left === '42px' && d.style.top === '190px') || null; })()`);
  if (gem) {
    await page.mouse.move(gem.x - 30, gem.y); await page.waitForTimeout(HOVER_MS);
    await shoot(page, 'slots-gem', gem.x - 30, gem.y, screens);
  } else console.log('[core17kbbaga] no Slots gem found');
  await page.evaluate(`(() => { const ui = window.__ac.gameUI; if (ui.inventoryPanel) ui.toggleInventory(); })()`);
  await page.waitForTimeout(500);

  // ── The map: Holtburg ──
  await openPanel(page, `(() => { const ui = window.__ac.gameUI; if (!ui.mapPanelVisible) ui.toggleMapPanel(); })()`);
  await page.waitForTimeout(1500);
  const town = await centerOf(page, `document.querySelector('[data-map-note="Holtburg"]')`);
  if (town) {
    await page.mouse.move(town.x, town.y); await page.waitForTimeout(HOVER_MS);
    await shoot(page, 'map-town', town.x, town.y, screens);
  } else {
    // Before: no note regions — hover where Holtburg's pictogram sits ((21+164+4, 36+77+4) in the map block).
    const mapPt = await page.evaluate(`(() => { const ui = window.__ac.gameUI; const c = ui.mapCanvas; if (!c) return null; const r = c.getBoundingClientRect(); return { x: r.left + 164 + 4.5, y: r.top + 77 + 4 }; })()`) as { x: number; y: number } | null;
    if (mapPt) { await page.mouse.move(mapPt.x, mapPt.y); await page.waitForTimeout(HOVER_MS); await shoot(page, 'map-town', mapPt.x, mapPt.y, screens, { waitForTip: false }); }
    else console.log('[core17kbbaga] no map canvas');
  }
  await page.evaluate(`(() => { const ui = window.__ac.gameUI; if (ui.mapPanelVisible) ui.toggleMapPanel(); })()`);
  await page.waitForTimeout(500);

  // ── The spell bar's Cast button in Magic mode ──
  await page.evaluate(`(() => { const ui = window.__ac.gameUI; ui.hud.combatMode = 8; ui.updateSpellBarVisibility(); ui.refreshSpellBarPanel(); })()`);
  await page.waitForTimeout(800);
  const cast = await centerOf(page, `(() => { const ui = window.__ac.gameUI; const h = ui.spellBarHandle; return h ? (h.elements.get(0x100000b2) || null) : null; })()`);
  const castOld = cast ?? await centerOf(page, `(() => { const ui = window.__ac.gameUI; const h = ui.spellBarHandle; return h ? (h.elements.get(0x100000b1) || null) : null; })()`);
  if (castOld) {
    await page.mouse.move(castOld.x, castOld.y); await page.waitForTimeout(HOVER_MS);
    await shoot(page, 'cast-button', castOld.x, castOld.y, screens);
  } else console.log('[core17kbbaga] no cast button found');
  const nameText = await page.evaluate(`(() => { const ui = window.__ac.gameUI; const h = ui.spellBarHandle; const el = h && h.elements.get(0x1000048b); return el ? (el.textContent || '') : null; })()`);
  console.log(`[core17kbbaga] spell-name text 0x1000048b: ${JSON.stringify(nameText)}`);
  await page.evaluate(`(() => { const ui = window.__ac.gameUI; ui.hud.combatMode = 1; ui.updateSpellBarVisibility(); })()`);

  // ── The 3D view: sweep for an object under the mouse (the canvas gets tagged / the label appears) ──
  let found: { x: number; y: number } | null = null;
  const canvasTagged = `(() => { const c = document.querySelector('canvas'); const t = c && c.dataset.acTooltipText; const l = document.getElementById('name-labels'); const lab = l && l.firstElementChild; return !!t || !!(lab && lab.style.display !== 'none'); })()`;
  for (const [fx, fy] of [[0.5, 0.62], [0.5, 0.55], [0.5, 0.7], [0.45, 0.6], [0.55, 0.6], [0.5, 0.5], [0.4, 0.55], [0.6, 0.55], [0.3, 0.5], [0.7, 0.5]]) {
    const x = VIEW.width * fx, y = VIEW.height * fy;
    await page.mouse.move(x, y); await page.waitForTimeout(250);
    await page.mouse.move(x + 1, y); await page.waitForTimeout(250);
    if (await page.evaluate(canvasTagged)) { found = { x: x + 1, y }; break; }
  }
  if (found) {
    await page.waitForTimeout(HOVER_MS);
    await shoot(page, 'world-hover', found.x, found.y, screens);
    const label = await overheadLabel(page);
    console.log(`[core17kbbaga] world-hover at (${found.x.toFixed(0)},${found.y.toFixed(0)}) overhead label: ${JSON.stringify(label)}`);
    writeFileSync(join(OUT, `${PREFIX}world-hover-label.json`), JSON.stringify(label));
  } else console.log('[core17kbbaga] no 3D object found under the sweep — beat skipped');

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
    const head = `<tr><th>beat</th><th>mouse</th><th>element under the mouse (tag / text / root)</th><th>DAT tooltip (text · root · box · font)</th><th>native title</th></tr>`;
    const rows = names.map((n) => {
      const s = src.screens[n].state;
      const dat = s.dat ? `"${s.dat.text.replace(/\n/g, '\\n')}" · ${s.dat.element} · (${s.dat.left.toFixed(0)},${s.dat.top.toFixed(0)}) ${s.dat.width.toFixed(0)}x${s.dat.height.toFixed(0)} · 0x${s.dat.font}` : '—';
      return `<tr><td>${n}</td><td>(${s.mouse.x.toFixed(0)},${s.mouse.y.toFixed(0)})</td><td>${s.target ? `${s.target.tag} / ${(s.target.text ?? '—').replace(/\n/g, '\\n')} / ${s.target.root ?? '—'}` : '—'}</td><td>${dat}</td><td>${s.title ?? '—'}</td></tr>`;
    }).join('');
    return `<h2>${title}</h2><table>${head}${rows}</table>`;
  };
  const cropCell = (src: Live, name: string, file: string, label: string): string => {
    const s = src.screens[name]?.state;
    if (!s || !existsSync(file)) return `<div class="cell"><div class="lbl">${label}: (no capture)</div></div>`;
    const x = Math.max(0, Math.min(VIEW.width - 360, s.mouse.x - 60));
    const y = Math.max(0, Math.min(VIEW.height - 160, s.mouse.y - 60));
    return `<div class="cell"><div class="lbl">${label}</div><div style="width:720px;height:320px;border:1px solid #444;background-image:url(${dataUrl(file)});background-size:${VIEW.width * 2}px ${VIEW.height * 2}px;background-position:-${x * 2}px -${y * 2}px;image-rendering:pixelated"></div></div>`;
  };
  const beatRow = (title: string, name: string, retail?: string): string => {
    const cells = [
      ...(retail ? [frame(retail, 'retail reference', 420)] : []),
      cropCell(before, name, join(OUT, `ours-before-${name}.png`), `before — ${name} (2x crop at the mouse)`),
      cropCell(live, name, join(OUT, `ours-${name}.png`), `after — ${name} (2x crop at the mouse)`),
      frame(join(OUT, `ours-before-${name}.png`), `before — whole screen`, 560),
      frame(join(OUT, `ours-${name}.png`), `after — whole screen`, 560),
    ];
    return `<h2>${title}</h2><div class="row">${cells.join('')}</div>`;
  };
  const html = `${CSS}<h1>CORE.17.k.b.b.a.g.a — the remaining retail SetTooltip carriers through UIElementManager's tooltip machine (the 0x21000041 roots at mouse + 32 after 0.25 s, 10 s duration): the character panel rows (AttributeInfoRegion / Attribute2ndInfoRegion / SkillInfoRegion ctors SetTooltip the whole 0x10000248 row with InqAttributeDescription / InqAttribute2ndDescription / the SkillTable formula + description), the paperdoll Slots gem (its p73 as root 0x10000397), the map's 53 town notes (gmMapUI::AddMapNote over s_rgLocations: root 0x10000398, font 0x40000015, p80 0 = no delay), the Cast button 0x100000b2 (UpdateCastButtonTooltip: "Select a spell to cast" / "You have no spells ready to cast"; the click sat on the endowment icon 0x100000b1 before, and 0x1000048b showed an invented "100% Charge" where retail shows the selected spell's name), and the 3D view (RecvNotice_SmartBoxObjectFound: the object under the mouse's name as the 0x10000395 tooltip while Show 3D Tooltips is on — before: an invented overhead label above the object's head).</h1>
    ${beatRow('character panel, Strength row — retail: "Measures your character\'s muscular power." on the row; before: nothing', 'char-attr-row', RETAIL_CHAR)}
    ${beatRow('character panel, Health row — retail: "(Endurance/2)" / "If you run out of health, you will die!" (two lines)', 'char-vital-row')}
    ${beatRow('character panel, a skill row — retail: the formula line + the SkillTable description', 'char-skill-row')}
    ${beatRow('paperdoll Slots gem — retail: its p73 help string as root 0x10000397 (before: the browser\'s native title box, if the OS drew one)', 'slots-gem')}
    ${beatRow('map, Holtburg\'s pictogram — retail: "Holtburg" at once (p80 0) in font 0x40000015; before: nothing', 'map-town', RETAIL_MAP)}
    ${beatRow('spell bar, the Cast button (Magic mode) — retail: "Select a spell to cast" / "You have no spells ready to cast"; the spell-name field 0x1000048b empty until a selection', 'cast-button')}
    ${beatRow('3D view, an object under the mouse — retail: its name in the 0x10000395 tooltip at the mouse; before: an overhead label above its head, no tooltip', 'world-hover')}
    ${frame(RETAIL, 'retail — the in-game tooltip chrome on file (reference/images/hud/item-stack-tooltip.jpg, 4x)', 400, true)}
    ${table(live, 'the tooltip DOM per beat (after, live-state.json)')}
    ${table(before, 'the tooltip DOM per beat (before, live-state-before.json)')}`;
  await page.setContent(html);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'core17kbbaga-tooltip-carriers-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17kbbaga] wrote ${join(OUT, 'core17kbbaga-tooltip-carriers-sidebyside.png')}`);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--compose-only')) await captureLive();
  if (!BEFORE) await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
