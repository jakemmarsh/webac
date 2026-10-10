/**
 * CORE.17.k.b.b.a.g.c — the spell bar's selection model. Retail
 * (gmSpellcastingUI::ListenToElementMessage @ 004c7ab0): a shortcut CLICK
 * selects (SpellCastSubMenu::SetSelected @ 004c5b00 — the UIItem's selected
 * overlay 0x10000342 / media 0x06004d21, the spell's name in 0x1000048b, the
 * Cast button's tooltip), a DOUBLE-CLICK casts, the Cast button 0x100000b2
 * casts the selection or raises "You must select a spell to cast" as a 0x1a
 * spew (Cast @ 004c6050), and a number key selects THEN casts
 * (RecvNotice_CastQuickslotSpell @ 004c78b0). Before: every click cast at
 * once, nothing was ever selected, 0x1000048b stayed empty, the Cast button
 * cast the tab's first shortcut.
 *
 * Live capture on the ACE stack + a retail | before | after side-by-side.
 *
 * Beats (each a whole-screen frame + a 2x crop of the spell bar):
 *   idle                    magic mode, two shortcuts, nothing selected
 *   cast-button-unselected  the Cast button with no selection
 *   click-select            one click on the first shortcut
 *   cast-button-selected    the Cast button with the selection
 *   double-click            a double-click on the second shortcut
 *   key-1                   the "Spell Slot 1" key
 *
 * Usage:
 *   npx tsx tools/capture-core17kbbagc-spellbar-selection-sidebyside.ts            # capture + compose
 *   AC_URL=http://localhost:3001/?ace&... npx tsx tools/capture-core17kbbagc-spellbar-selection-sidebyside.ts --before
 *   npx tsx tools/capture-core17kbbagc-spellbar-selection-sidebyside.ts --compose-only
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbagc');
const RETAIL = join(REPO, 'reference', 'images', 'hud', 'rawg_10.jpg');
const RETAIL_EOL = join(REPO, 'reference', 'images', 'hud', 'reddit-shutdown.jpg');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const BASE = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const BEFORE = process.argv.includes('--before');
const PREFIX = BEFORE ? 'ours-before-' : 'ours-';

interface BarState {
  /** The active tab and (after only) its selected spell id per SpellCastSubMenu::m_selectedSpellID. */
  tab: number;
  selected: number | null;
  /** The shortcut cells of the active tab: icon present, the selected overlay, the numeral media. */
  cells: Array<{ idx: number; icon: boolean; selected: boolean; numeral: string | null; name: string | null }>;
  /** 0x1000048b's text. */
  nameField: string;
  /** The Cast button's tooltip text. */
  castTooltip: string | null;
  /** onCastSpell calls so far (known-spell indices). */
  casts: number[];
  /** displayErrorText (the 0x1a spew) lines so far. */
  spew: string[];
  /** The spell bar panel's on-screen rect. */
  bar: { x: number; y: number; w: number; h: number } | null;
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
    ui.wizard.name = 'Spellbar Tester';
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

/** Hook the cast callback + the spew sink, enter magic mode, put two shortcuts on tab 0 (source string: tsx helpers). */
const SETUP_JS = `(() => {
  const ui = window.__ac.gameUI;
  window.__casts = []; window.__spew = [];
  const cb = ui.spellCallbacks || (ui.spellCallbacks = {});
  const orig = cb.onCastSpell;
  cb.onCastSpell = (i) => { window.__casts.push(i); if (orig) orig(i); };
  const origErr = ui.displayErrorText.bind(ui);
  ui.displayErrorText = (t) => { window.__spew.push(t); origErr(t); };
  // Magic mode needs a wielded caster on the ACE side; the bar's own model is
  // what is under test, so the mode is set on the HUD directly (as the
  // CORE.17.k.b.b.a.g capture did).
  ui.hud.combatMode = 8; ui.updateSpellBarVisibility();
  const tab = ui.activeSpellBarTab;
  // A fresh character knows no spells: seed two from the DAT spell table —
  // Strength Other I (1, targeted) and the first Strength Self (self bit).
  if (!ui.knownSpells || ui.knownSpells.length < 2) {
    const def = (id, sb) => ({ id, name: sb.name, desc: sb.desc, school: sb.school, level: 1, power: sb.power, manaCost: sb.baseMana, difficulty: sb.power, duration: sb.duration || 0, components: [], targetType: 0, iconId: sb.icon || undefined });
    const t = ui.spellTable;
    const a = t.spells.get(1);
    let selfId = 0;
    for (const [id, sb] of t.spells) { if ((sb.bitfield & 8) && /^Strength Self/.test(sb.name)) { selfId = id; break; } }
    const b = t.spells.get(selfId);
    ui.knownSpells = [def(1, a), def(selfId, b)];
  }
  const known = ui.knownSpells.length;
  const filled = (ui.spellBarSlots[tab] || []).filter(Boolean).length;
  if (filled === 0) ui.assignSpellToBar(0, 0);
  if (filled <= 1) ui.assignSpellToBar(1, 1);
  if (typeof ui.selectSpellShortcut === 'function') ui.selectSpellShortcut(0);   // the seed's AddFavorite selected the last one; start clean
  ui.refreshSpellBarPanel();
  return { known, tab, spells: ui.knownSpells.map((s) => s.id + ':' + s.name), filled: (ui.spellBarSlots[tab] || []).filter(Boolean).length, magic: !!(ui.spellBarPanelEl && ui.spellBarPanelEl.style.display === 'block') };
})()`;

const STATE_JS = `(() => {
  const ui = window.__ac.gameUI;
  const tab = ui.activeSpellBarTab;
  const sel = Array.isArray(ui.spellBarSelected) ? ui.spellBarSelected[tab] : null;
  const cells = [...(ui.spellBarPanelEl ? ui.spellBarPanelEl.querySelectorAll('[data-spell-slot^="' + tab + '-"]') : [])].map((c, i) => ({
    idx: i,
    icon: /url\\(/.test(c.style.background) && !/06001a97/.test(c.style.background.split(',')[0]),
    selected: c.dataset.selected === '1',
    numeral: c.dataset.shortcutNumMedia || null,
    name: c.dataset.acTooltipText || null,
  }));
  const h = ui.spellBarHandle;
  const nameEl = h && h.elements.get(0x1000048b);
  const cv = nameEl ? nameEl.querySelector('.layout-text > canvas') : null;
  const btn = h && h.elements.get(0x100000b2);
  const r = ui.spellBarPanelEl ? ui.spellBarPanelEl.getBoundingClientRect() : null;
  return { tab, selected: sel, cells, nameField: cv ? (cv.dataset.text || '') : (nameEl ? nameEl.textContent || '' : ''),
    castTooltip: btn ? (btn.dataset.acTooltipText || null) : null, casts: window.__casts.slice(), spew: window.__spew.slice(),
    bar: r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null };
})()`;
const RECT_JS = (sel: string) => `(() => { const e = ${sel}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`;
const CELL = (i: number) => RECT_JS(`window.__ac.gameUI.spellBarPanelEl.querySelector('[data-spell-slot="' + window.__ac.gameUI.activeSpellBarTab + '-${i}"]')`);
const CAST_BTN = RECT_JS(`window.__ac.gameUI.spellBarHandle.elements.get(0x100000b2)`);

async function state(page: Page): Promise<BarState> { return page.evaluate(STATE_JS) as Promise<BarState>; }
async function shoot(page: Page, name: string, screens: Record<string, { file: string; state: BarState }>): Promise<BarState> {
  const file = `${PREFIX}${name}.png`;
  const s = await state(page);
  await page.screenshot({ path: join(OUT, file) });
  screens[name] = { file, state: s };
  console.log(`[core17kbbagc] ${name}: sel=${s.selected} name="${s.nameField}" tip="${s.castTooltip}" casts=${JSON.stringify(s.casts)} spew=${JSON.stringify(s.spew)} cells=${s.cells.map((c) => `${c.icon ? 'I' : '.'}${c.selected ? '*' : ''}${c.numeral ? '#' : ''}`).join(' ')}`);
  return s;
}

async function captureLive(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.on('pageerror', (e) => console.log('[page error]', e.message));
  console.log(`[core17kbbagc] ${BASE}`);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await waitForWorld(page);
  console.log('[core17kbbagc] in world');
  await page.waitForTimeout(6000);
  const setup = await page.evaluate(SETUP_JS);
  console.log(`[core17kbbagc] setup: ${JSON.stringify(setup)}`);
  await page.waitForTimeout(1500);
  await page.mouse.move(VIEW.width / 2, 120);
  await page.waitForTimeout(400);
  const screens: Record<string, { file: string; state: BarState }> = {};
  await shoot(page, 'idle', screens);

  const clickAt = async (js: string, kind: 'click' | 'dblclick'): Promise<boolean> => {
    const p = await page.evaluate(js) as { x: number; y: number } | null;
    if (!p) return false;
    if (kind === 'click') await page.mouse.click(p.x, p.y);
    else await page.mouse.dblclick(p.x, p.y);
    await page.mouse.move(p.x, p.y + 1);   // the hover tooltip machine's own timing
    await page.waitForTimeout(600);
    return true;
  };

  if (await clickAt(CAST_BTN, 'click')) await shoot(page, 'cast-button-unselected', screens);
  if (await clickAt(CELL(0), 'click')) await shoot(page, 'click-select', screens);
  if (await clickAt(CAST_BTN, 'click')) await shoot(page, 'cast-button-selected', screens);
  if (await clickAt(CELL(1), 'dblclick')) await shoot(page, 'double-click', screens);
  await page.mouse.move(VIEW.width / 2, 120);
  await page.keyboard.press('Digit1');
  await page.waitForTimeout(600);
  await shoot(page, 'key-1', screens);

  writeFileSync(join(OUT, BEFORE ? 'live-state-before.json' : 'live-state.json'), JSON.stringify({ setup, screens }, null, 2));
  await browser.close();
}

function dataUrl(file: string): string {
  const ext = file.endsWith('.webp') ? 'webp' : file.endsWith('.jpg') ? 'jpeg' : 'png';
  return `data:image/${ext};base64,${readFileSync(file).toString('base64')}`;
}
function frame(file: string, label: string, width = 520): string {
  return existsSync(file)
    ? `<div class="cell"><div class="lbl">${label}</div><img src="${dataUrl(file)}" style="width:${width}px;border:1px solid #444"/></div>`
    : `<div class="cell"><div class="lbl">${label}: (no capture)</div></div>`;
}
/** A 2x crop of a region of a whole-screen frame. */
function crop(file: string, label: string, x: number, y: number, w: number, h: number): string {
  if (!existsSync(file)) return `<div class="cell"><div class="lbl">${label}: (no capture)</div></div>`;
  return `<div class="cell"><div class="lbl">${label}</div><div style="width:${w * 2}px;height:${h * 2}px;border:1px solid #444;background-image:url(${dataUrl(file)});background-size:${VIEW.width * 2}px ${VIEW.height * 2}px;background-position:-${x * 2}px -${y * 2}px;image-rendering:pixelated"></div></div>`;
}

const CSS = `<style>
  body{margin:0;background:#1a1a1a;color:#eee;font:13px/1.3 monospace;padding:10px}
  .row{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;margin-top:12px}
  .cell{display:flex;flex-direction:column;gap:4px}
  .lbl{color:#ffd;white-space:normal;max-width:900px}
  h1{font-size:14px;margin:0 0 8px}
  h2{font-size:13px;margin:14px 0 0;color:#9cf}
  table{border-collapse:collapse;margin-top:8px} td,th{border:1px solid #444;padding:2px 6px;text-align:left;vertical-align:top;max-width:520px;word-break:break-all} th{color:#9cf}
</style>`;

async function compose(): Promise<void> {
  type Live = { setup?: unknown; screens: Record<string, { file: string; state: BarState }> };
  const load = (f: string): Live => existsSync(join(OUT, f)) ? JSON.parse(readFileSync(join(OUT, f), 'utf8')) as Live : { screens: {} };
  const live = load('live-state.json');
  const before = load('live-state-before.json');
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 2720, height: 900 } });
  const table = (src: Live, title: string): string => {
    const names = Object.keys(src.screens);
    if (!names.length) return '';
    const head = `<tr><th>beat</th><th>selected</th><th>0x1000048b</th><th>Cast tooltip</th><th>casts (known-spell idx)</th><th>0x1a spew</th><th>cells (I icon · * selected · # numeral)</th></tr>`;
    const rows = names.map((n) => {
      const s = src.screens[n].state;
      return `<tr><td>${n}</td><td>${s.selected ?? '—'}</td><td>"${s.nameField}"</td><td>${s.castTooltip ?? '—'}</td><td>${JSON.stringify(s.casts)}</td><td>${s.spew.join(' | ') || '—'}</td><td>${s.cells.map((c) => `${c.icon ? 'I' : '.'}${c.selected ? '*' : ''}${c.numeral ? '#' : ''}`).join(' ')}</td></tr>`;
    }).join('');
    return `<h2>${title}</h2><table>${head}${rows}</table>`;
  };
  const barCrop = (src: Live, name: string, file: string, label: string): string => {
    const b = src.screens[name]?.state.bar;
    if (!b) return `<div class="cell"><div class="lbl">${label}: (no capture)</div></div>`;
    return crop(file, label, Math.max(0, b.x - 10), Math.max(0, b.y - 10), Math.min(820, b.w + 20), Math.min(120, b.h + 40));
  };
  const beatRow = (title: string, name: string): string => {
    const cells = [
      barCrop(before, name, join(OUT, `ours-before-${name}.png`), `before — ${name} (2x)`),
      barCrop(live, name, join(OUT, `ours-${name}.png`), `after — ${name} (2x)`),
      frame(join(OUT, `ours-before-${name}.png`), 'before — whole screen', 520),
      frame(join(OUT, `ours-${name}.png`), 'after — whole screen', 520),
    ];
    return `<h2>${title}</h2><div class="row">${cells.join('')}</div>`;
  };
  const html = `${CSS}<h1>CORE.17.k.b.b.a.g.c — the spell bar's selection model. Retail (gmSpellcastingUI::ListenToElementMessage @ 004c7ab0): a shortcut click SELECTS (SpellCastSubMenu::SetSelected @ 004c5b00 — the UIItem's selected overlay 0x10000342 media 0x06004d21, the name in 0x1000048b, the Cast button's tooltip), a double-click casts, the Cast button 0x100000b2 casts the selection or raises "You must select a spell to cast" (Cast @ 004c6050, 0x1a spew), a number key selects then casts (RecvNotice_CastQuickslotSpell @ 004c78b0); the shortcuts are UIItems of template 0x10000341 at 32 px pitch (list 0x100000b6 at (23,2) 639x32) with the DAT corner numerals (0x060019ed+n) and one trailing empty slot (0x060010fa+n). Before: every click cast at once, nothing was ever selected, 0x1000048b stayed empty, the Cast button cast the tab's first shortcut, the slots were nine 36 px cells with drawn digits.</h1>
    <div class="row">${frame(RETAIL, 'retail reference — reference/images/hud/rawg_10.jpg: the 8th shortcut selected (the overlay), "CAST Strength Self VI" on the button, corner numerals 1-9, no numerals beyond', 700)}${frame(RETAIL_EOL, 'retail reference (EoL layout, ACE) — reference/images/hud/reddit-shutdown.jpg: an empty tab shows one trailing empty slot with the engraved "1" (0x060010fa) then the bar background, "Cast" at right', 700)}</div>
    ${beatRow('idle — magic mode, two shortcuts on tab I, nothing selected', 'idle')}
    ${beatRow('the Cast button with nothing selected — retail: "You must select a spell to cast" (0x1a); before: cast the first shortcut', 'cast-button-unselected')}
    ${beatRow('one click on the first shortcut — retail: selected (the overlay, the name in 0x1000048b, "CAST …" / "You must select a target for …" on the button); before: a cast', 'click-select')}
    ${beatRow('the Cast button with the selection — retail: casts it (or the target notice); before: the first shortcut again', 'cast-button-selected')}
    ${beatRow('a double-click on the second shortcut — retail: selects it and casts; before: two casts, no selection', 'double-click')}
    ${beatRow('the Spell Slot 1 key — retail: selects the first shortcut and casts it; before: a cast, no selection', 'key-1')}
    ${table(live, 'the bar state per beat (after, live-state.json)')}
    ${table(before, 'the bar state per beat (before, live-state-before.json)')}`;
  await page.setContent(html);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'core17kbbagc-spellbar-selection-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17kbbagc] wrote ${join(OUT, 'core17kbbagc-spellbar-selection-sidebyside.png')}`);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--compose-only')) await captureLive();
  if (!BEFORE) await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
