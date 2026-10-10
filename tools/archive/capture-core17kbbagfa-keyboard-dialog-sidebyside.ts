/**
 * CORE.17.k.b.b.a.g.f.a — the Keyboard Config dialog's list (layout 0x21000009)
 * as gmKeyboardUI builds it: every command behind the DAT scrollbar, one
 * header row per input map, 40 px rows with the three 100x32 Mapping buttons,
 * retail key names (GetNameFromKey @ 00687f40), the MapInstructions capture
 * dialog and the overwrite prompt. Before: 17 unscrollable 20 px rows with our
 * own labels and invented tab chrome.
 *
 * Live capture on the ACE stack + a before | after side-by-side (the "before"
 * frames are CORE.17.k.b.b.a.g.f's close captures of the same tabs).
 *
 * Beats (each a whole-screen frame):
 *   keyboard-movement    Movement tab (one "Movement" section, Left Alt+A labels)
 *   keyboard-camera      Camera tab — the "Camera" and read-only "Alternate Camera Mode" sections
 *   keyboard-combat      Combat tab — Combat / Melee / Missile / Magic Combat sections, "Page Up" / "Insert"
 *   keyboard-ui          UI tab at the top of its 103 rows
 *   keyboard-ui-scrolled the UI tab after wheel scrolling to the bottom (the last commands visible)
 *   capture-dialog       Jump's Mapping 2 clicked → the MapInstructions dialog
 *   overwrite-prompt     Autorun's Mapping 2 clicked, W pressed → the Yes / No overwrite prompt
 *   after-yes            Yes → W moved from Move Forward to Autorun
 *
 * Usage:
 *   npx tsx tools/capture-core17kbbagfa-keyboard-dialog-sidebyside.ts            # capture + compose
 *   npx tsx tools/capture-core17kbbagfa-keyboard-dialog-sidebyside.ts --compose-only
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = process.env.AC_REPO ?? resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbagfa');
const BEFORE_DIR = join(REPO, 'verification', 'core17kbbagf');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const BASE = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };

interface DialogState {
  keyboardOpen: boolean;
  keyboardTab: number | null;
  rows: number;
  sections: string[];
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  scrollbarVisible: boolean | null;
  firstRows: Array<{ name: string; labels: string[]; readonly: boolean }>;
  lastRow: string | null;
  mapDialog: string | null;
  confirm: string | null;
  tabsChrome: string[];
  mappings: Record<string, string[]>;
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
    ui.wizard.name = 'Keymap Tester';
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

const STATE_JS = `(() => {
  const ui = window.__ac.gameUI;
  const reg = ui.keybindRegistry;
  const names = new Map((reg ? reg.actions() : []).map((a) => [a.id, a.name]));
  const vp = ui.keyboardListViewport;
  const rows = vp ? Array.from(vp.querySelectorAll('[data-keybind-row]')) : [];
  const row = (el) => ({ name: el.dataset.keybindRow, labels: Array.from(el.querySelectorAll('[data-keybind-slot]')).map((c) => c.dataset.keybindLabel || ''), readonly: el.dataset.keybindReadonly === '1' });
  const h = ui.keyboardConfigHandle;
  const tabs = h ? [0x1000049c, 0x1000049e, 0x100004a0, 0x100004a2, 0x1000020e, 0x100004a4].map((id) => { const e = h.elements.get(id); return e ? (e.style.background || '') + '|' + (e.style.border || '') : 'missing'; }) : [];
  const bar = h && vp ? vp.parentElement.querySelector('[data-keybind-scrollbar]') : null;
  const md = document.getElementById('ac-keyboard-map-dialog');
  const cf = document.querySelector('.ac-dialog-plate:not(#ac-keyboard-map-dialog):not(#ac-message-dialog)');
  const lines = (el) => el ? Array.from(el.querySelectorAll('[data-ac-line]')).map((r) => r.dataset.acLine).join(' ') : null;
  const want = ['Move Forward', 'Autorun', 'Strafe Left', 'Jump'];
  const mappings = {};
  for (const [id, name] of names) if (want.includes(name)) mappings[name] = reg.getMappings(id);
  return {
    keyboardOpen: !!ui.keyboardConfigVisible, keyboardTab: ui.keyboardConfigTab == null ? null : ui.keyboardConfigTab,
    rows: rows.length, sections: vp ? Array.from(vp.querySelectorAll('[data-keybind-section]')).map((e) => e.dataset.keybindSection) : [],
    scrollTop: vp ? vp.scrollTop : 0, scrollHeight: vp ? vp.scrollHeight : 0, clientHeight: vp ? vp.clientHeight : 0,
    scrollbarVisible: bar ? bar.style.display !== 'none' : null,
    firstRows: rows.slice(0, 4).map(row), lastRow: rows.length ? rows[rows.length - 1].dataset.keybindRow : null,
    mapDialog: lines(md), confirm: lines(cf), tabsChrome: tabs, mappings,
  };
})()`;

async function state(page: Page): Promise<DialogState> { return page.evaluate(STATE_JS) as Promise<DialogState>; }
async function shoot(page: Page, name: string, screens: Record<string, { file: string; state: DialogState }>): Promise<DialogState> {
  const file = `ours-${name}.png`;
  const s = await state(page);
  await page.screenshot({ path: join(OUT, file) });
  screens[name] = { file, state: s };
  console.log(`[core17kbbagfa] ${name}: tab=${s.keyboardTab} rows=${s.rows} sections=${s.sections.join(',')} scroll=${s.scrollTop}/${s.scrollHeight}/${s.clientHeight} bar=${s.scrollbarVisible} last=${s.lastRow} map=${s.mapDialog ? 'open' : '-'} confirm=${s.confirm ? 'open' : '-'}`);
  return s;
}

/** The viewport's centre in page coordinates (the HUD is scaled; read the rect). */
async function listCenter(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(`(() => { const r = window.__ac.gameUI.keyboardListViewport.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`) as Promise<{ x: number; y: number }>;
}
async function buttonCenter(page: Page, row: string, slot: number): Promise<{ x: number; y: number }> {
  return page.evaluate(`(() => {
    const vp = window.__ac.gameUI.keyboardListViewport;
    const el = Array.from(vp.querySelectorAll('[data-keybind-row]')).find((r) => r.dataset.keybindRow === ${JSON.stringify(row)});
    const b = el.querySelector('[data-keybind-slot="${slot}"]');
    b.scrollIntoView({ block: 'nearest' });
    const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`) as Promise<{ x: number; y: number }>;
}

async function captureLive(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.on('pageerror', (e) => console.log('[page error]', e.message));
  console.log(`[core17kbbagfa] ${BASE}`);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await waitForWorld(page);
  console.log('[core17kbbagfa] in world');
  await page.waitForTimeout(6000);
  await page.mouse.move(VIEW.width / 2, 120);
  await page.evaluate(`(() => { const a = document.activeElement; if (a && a.blur) a.blur(); })()`);
  const screens: Record<string, { file: string; state: DialogState }> = {};
  const setTab = async (cls: number): Promise<void> => {
    await page.evaluate(`(() => { const ui = window.__ac.gameUI; ui.keyboardConfigTab = ${cls}; ui.refreshKeyboardTabs(); })()`);
    await page.waitForTimeout(800);
  };

  await page.evaluate(`window.__ac.gameUI.toggleKeyboardConfigPanel()`);
  await page.waitForTimeout(1500);
  await shoot(page, 'keyboard-movement', screens);
  await setTab(2);
  await shoot(page, 'keyboard-camera', screens);
  await setTab(4);
  await shoot(page, 'keyboard-combat', screens);
  await setTab(3);
  await shoot(page, 'keyboard-ui', screens);
  // wheel over the list until the bottom. Playwright's mouse.wheel never
  // returns on the SwiftShader stack (the renderer's input ack), so the
  // wheel events are dispatched from the page at the list's centre — the
  // same WheelEvent path the live mouse takes (verify-inventory-dockfit.ts).
  const c = await listCenter(page);
  await page.mouse.move(c.x, c.y);
  await page.evaluate(`(() => {
    const vp = window.__ac.gameUI.keyboardListViewport;
    const r = vp.getBoundingClientRect();
    const target = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) || vp;
    for (let i = 0; i < 120; i++) target.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
  })()`);
  await page.waitForTimeout(800);
  await shoot(page, 'keyboard-ui-scrolled', screens);

  // the capture dialog: Jump's Mapping 2
  await setTab(1);
  let b = await buttonCenter(page, 'Jump', 1);
  await page.mouse.click(b.x, b.y);
  await page.waitForTimeout(800);
  await shoot(page, 'capture-dialog', screens);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // the overwrite prompt: Autorun's Mapping 2 ← W (Move Forward's key)
  b = await buttonCenter(page, 'Autorun', 1);
  await page.mouse.click(b.x, b.y);
  await page.waitForTimeout(600);
  await page.keyboard.press('KeyW');
  await page.waitForTimeout(800);
  await shoot(page, 'overwrite-prompt', screens);
  await page.evaluate(`(() => { const btns = Array.from(document.querySelectorAll('.ac-dialog-plate .ac-dialog-button')); const yes = btns[0]; if (yes) yes.click(); })()`);
  await page.waitForTimeout(800);
  await shoot(page, 'after-yes', screens);
  // leave the registry as it was: Cancel restores the snapshot
  await page.evaluate(`window.__ac.gameUI.closeKeyboardConfigPanel(false)`);
  await page.waitForTimeout(500);

  writeFileSync(join(OUT, 'live-state.json'), JSON.stringify({ screens }, null, 2));
  await browser.close();
}

function dataUrl(file: string): string {
  const ext = file.endsWith('.webp') ? 'webp' : file.endsWith('.jpg') ? 'jpeg' : 'png';
  return `data:image/${ext};base64,${readFileSync(file).toString('base64')}`;
}
function frame(file: string, label: string, width = 640): string {
  return existsSync(file)
    ? `<div class="cell"><div class="lbl">${label}</div><img src="${dataUrl(file)}" style="width:${width}px;border:1px solid #444"/></div>`
    : `<div class="cell"><div class="lbl">${label}: (no capture)</div></div>`;
}

const CSS = `<style>
  body{margin:0;background:#1a1a1a;color:#eee;font:13px/1.3 monospace;padding:10px}
  .row{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;margin-top:12px}
  .cell{display:flex;flex-direction:column;gap:4px}
  .lbl{color:#ffd;white-space:normal;max-width:900px}
  h1{font-size:14px;margin:0 0 8px}
  h2{font-size:13px;margin:14px 0 0;color:#9cf}
  table{border-collapse:collapse;margin-top:8px} td,th{border:1px solid #444;padding:2px 6px;text-align:left;vertical-align:top;max-width:560px;word-break:break-all} th{color:#9cf}
</style>`;

async function compose(): Promise<void> {
  type Live = { screens: Record<string, { file: string; state: DialogState }> };
  const live: Live = existsSync(join(OUT, 'live-state.json')) ? JSON.parse(readFileSync(join(OUT, 'live-state.json'), 'utf8')) as Live : { screens: {} };
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 2000, height: 900 } });
  const beatRow = (title: string, name: string, before?: string): string => {
    const cells = [
      before ? frame(join(BEFORE_DIR, before), `before — ${before} (CORE.17.k.b.b.a.g.f close)`, 640) : '',
      frame(join(OUT, `ours-${name}.png`), `after — ${name}`, 640),
    ];
    return `<h2>${title}</h2><div class="row">${cells.join('')}</div>`;
  };
  const stateTable = (): string => {
    const names = Object.keys(live.screens);
    if (!names.length) return '';
    const head = '<tr><th>beat</th><th>tab</th><th>rows</th><th>sections</th><th>scrollTop / scrollHeight / clientHeight</th><th>bar shown</th><th>first rows (labels)</th><th>last row</th><th>map dialog</th><th>confirm</th><th>tab chrome</th><th>mappings</th></tr>';
    const rows = names.map((n) => {
      const s = live.screens[n].state;
      return `<tr><td>${n}</td><td>${s.keyboardTab}</td><td>${s.rows}</td><td>${s.sections.join(' ')}</td><td>${s.scrollTop} / ${s.scrollHeight} / ${s.clientHeight}</td><td>${s.scrollbarVisible}</td><td>${s.firstRows.map((r) => `${r.name}${r.readonly ? ' (ro)' : ''}: [${r.labels.join(' | ')}]`).join('<br>')}</td><td>${s.lastRow ?? '—'}</td><td>${s.mapDialog ?? '—'}</td><td>${s.confirm ?? '—'}</td><td>${s.tabsChrome.join(' ; ')}</td><td>${Object.entries(s.mappings).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('<br>')}</td></tr>`;
    }).join('');
    return `<h2>the live state per beat (live-state.json)</h2><table>${head}${rows}</table>`;
  };
  const html = `${CSS}<h1>CORE.17.k.b.b.a.g.f.a — the Keyboard Config dialog list as gmKeyboardUI::InitOptions @ 004dd8b0 builds it (layout 0x21000009 template 0x100004a7: the 570x345 UIElement_ListBox 0x10000025 with its p114 scrollbar 0x10000026, one 0x1000002e header row per input map, 0x1000002f rows of 40 px with the three 100x32 Mapping buttons on the 0x100002cd art, labels per CInputManager_WIN32::GetNameFromKey @ 00687f40, the MapInstructions capture dialog and the OpenOverwriteBindingDialog @ 00488bf0 prompt). Before: 17 unscrollable 20 px rows, our own key labels, invented tab caps. No retail screenshot of this dialog exists in the corpus — the DAT layout + the decompiled client are the reference.</h1>
    ${beatRow('Movement tab — retail: one "Movement" header, 14 rows at 40 px, W / Up, Left Alt+A (before: 20 px rows, Alt+A, invented tab chrome)', 'keyboard-movement', 'ours-keyboard-movement.png')}
    ${beatRow('Camera tab — retail: "Camera" (12 rows) then "Alternate Camera Mode" (10 rows, the DAT arrow keys, read-only)', 'keyboard-camera')}
    ${beatRow('Combat tab — retail: Combat / Melee Combat / Missile Combat / Magic Combat headers, Insert / Page Up / Delete / End / Page Down, all 32 rows behind the scrollbar (before: cut at Spell Slot 6, Ins / PgUp / Del / PgDn)', 'keyboard-combat', 'ours-keyboard-combat.png')}
    ${beatRow('UI tab — retail: Chat / Toggle Chat Entry / Quickslots / Item Selection / UI headers, 103 rows behind the proportional scrollbar (before: cut at ~17)', 'keyboard-ui', 'ours-keyboard-ui.png')}
    ${beatRow('UI tab after wheel-scrolling to the bottom — the last UI commands visible, the thumb at the bottom of its track', 'keyboard-ui-scrolled')}
    ${beatRow('Jump\'s Mapping 2 clicked — retail: the DialogFactory type-2 MapInstructions dialog ("The next key you press … \'Jump\' action … Press the ESC key to cancel.") (before: an inline "press a key…" cell)', 'capture-dialog')}
    ${beatRow('Autorun\'s Mapping 2 clicked, W pressed — retail: "\'W\' is currently bound to \'Move Forward\'. Do you wish to erase that binding?" (before: W stolen silently)', 'overwrite-prompt')}
    ${beatRow('Yes — W moves from Move Forward to Autorun', 'after-yes')}
    ${stateTable()}`;
  await page.setContent(html);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'core17kbbagfa-keyboard-dialog-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17kbbagfa] wrote ${join(OUT, 'core17kbbagfa-keyboard-dialog-sidebyside.png')}`);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--compose-only')) await captureLive();
  await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
