/**
 * CORE.17.k.b.b.a.g.f — the retail KeyMap DAT (portal 0x14000000 gmDefaultMap
 * + 0x14000002 DefaultMap) drives the default key bindings, and the registry
 * resolves a key through the combat mode's registered input maps
 * (ClientCombatSystem::RegisterInputMaps @ 0056aa20). Before: a hand-written
 * table (I / B / C / M / P / O / Q panels, Tab combat, NumLock autorun, S
 * back) and a flat one-key-one-command lookup in every mode.
 *
 * Live capture on the ACE stack + a DAT-table | before | after side-by-side.
 *
 * Beats (each a whole-screen frame):
 *   keyboard-movement   Options → Configure Keyboard, Movement tab
 *   keyboard-combat     the Combat tab (End = Cast Spell, Ins/PgUp power, …)
 *   keyboard-ui         the UI tab (F1 help, F3-F12 pages, E / R / T)
 *   f12-inventory       F12 pressed in the world → the inventory panel
 *   f8-attributes       F8 → the character panel on the Attributes page
 *   digit-peace         "1" out of combat → no cast (Quickslot 1)
 *   end-magic           magic mode: End casts the selected spell, "1" casts slot 1
 *   q-autorun           Q → autorun on; S → off (retail Autorun / Stop Moving)
 *
 * Usage:
 *   npx tsx tools/capture-core17kbbagf-keymap-defaults-sidebyside.ts            # capture + compose
 *   npx tsx tools/capture-core17kbbagf-keymap-defaults-sidebyside.ts --before
 *   npx tsx tools/capture-core17kbbagf-keymap-defaults-sidebyside.ts --compose-only
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
// AC_REPO lets the --before run execute a copy of this script from outside the
// (stashed) working tree.
const REPO = process.env.AC_REPO ?? resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbagf');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const BASE = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const BEFORE = process.argv.includes('--before');
const PREFIX = BEFORE ? 'ours-before-' : 'ours-';

interface KeyState {
  combatMode: number;
  activeMaps: string[] | null;
  keyboardOpen: boolean;
  keyboardTab: number | null;
  rows: Array<{ name: string; mappings: string[] }>;
  resolve: Record<string, string | null>;
  inventory: boolean;
  charPanel: boolean;
  charTab: string | null;
  autoRun: boolean | null;
  casts: number[];
  spew: string[];
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

/** Hook the cast callback + the spew sink; make sure one shortcut exists on tab 0. */
const SETUP_JS = `(() => {
  const ui = window.__ac.gameUI;
  window.__casts = []; window.__spew = [];
  const cb = ui.spellCallbacks || (ui.spellCallbacks = {});
  const orig = cb.onCastSpell;
  cb.onCastSpell = (i) => { window.__casts.push(i); if (orig) orig(i); };
  const origErr = ui.displayErrorText.bind(ui);
  ui.displayErrorText = (t) => { window.__spew.push(t); origErr(t); };
  const tab = ui.activeSpellBarTab;
  if (!ui.knownSpells || ui.knownSpells.length < 1) {
    const t = ui.spellTable;
    const a = t.spells.get(1);
    ui.knownSpells = [{ id: 1, name: a.name, desc: a.desc, school: a.school, level: 1, power: a.power, manaCost: a.baseMana, difficulty: a.power, duration: a.duration || 0, components: [], targetType: 0, iconId: a.icon || undefined }];
  }
  const filled = (ui.spellBarSlots[tab] || []).filter(Boolean).length;
  if (filled === 0) ui.assignSpellToBar(0, 0);
  return { tab, filled: (ui.spellBarSlots[tab] || []).filter(Boolean).length };
})()`;

const PROBE_KEYS = ['KeyW', 'KeyX', 'KeyS', 'KeyQ', 'KeyI', 'KeyB', 'KeyC', 'KeyM', 'KeyP', 'KeyO', 'Tab', 'Backquote', 'NumLock', 'F12', 'F8', 'F9', 'F5', 'F3', 'F11', 'F1', 'Digit1', 'End', 'Delete', 'PageDown', 'Insert', 'PageUp', 'KeyE', 'KeyR', 'KeyT', 'Home'];

const STATE_JS = `(() => {
  const ui = window.__ac.gameUI;
  const reg = ui.keybindRegistry;
  const names = new Map((reg ? reg.actions() : []).map((a) => [a.id, a.name]));
  const resolve = {};
  for (const k of ${JSON.stringify(PROBE_KEYS)}) { const id = reg ? reg.resolve(k) : null; resolve[k] = id == null ? null : (names.get(id) || ('0x' + id.toString(16))); }
  const rows = [];
  const h = ui.keyboardConfigHandle;
  if (h && ui.keyboardConfigVisible) {
    const list = h.root.querySelectorAll('[data-keybind-row]');
    for (const el of list) rows.push({ name: el.dataset.keybindRow, mappings: Array.from(el.querySelectorAll('[data-keybind-slot]')).map((c) => c.dataset.keybindLabel || '') });
  }
  const cc = window.__ac.cameraController;
  return { combatMode: ui.hud.combatMode, activeMaps: reg && reg.getActiveInputMaps ? reg.getActiveInputMaps().map((m) => '0x' + m.toString(16)) : null,
    keyboardOpen: !!ui.keyboardConfigVisible, keyboardTab: ui.keyboardConfigTab == null ? null : ui.keyboardConfigTab, rows, resolve,
    inventory: !!ui.inventoryVisible, charPanel: !!ui.charPanelVisible, charTab: ui.charPanelTab || null,
    autoRun: cc ? !!cc.autoRun : null, casts: (window.__casts || []).slice(), spew: (window.__spew || []).slice() };
})()`;

async function state(page: Page): Promise<KeyState> { return page.evaluate(STATE_JS) as Promise<KeyState>; }
async function shoot(page: Page, name: string, screens: Record<string, { file: string; state: KeyState }>): Promise<KeyState> {
  const file = `${PREFIX}${name}.png`;
  const s = await state(page);
  await page.screenshot({ path: join(OUT, file) });
  screens[name] = { file, state: s };
  console.log(`[core17kbbagf] ${name}: mode=${s.combatMode} kb=${s.keyboardOpen}/${s.keyboardTab} rows=${s.rows.length} inv=${s.inventory} char=${s.charPanel}/${s.charTab} autorun=${s.autoRun} casts=${JSON.stringify(s.casts)} spew=${JSON.stringify(s.spew)}`);
  return s;
}

async function captureLive(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.on('pageerror', (e) => console.log('[page error]', e.message));
  console.log(`[core17kbbagf] ${BASE}`);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await waitForWorld(page);
  console.log('[core17kbbagf] in world');
  await page.waitForTimeout(6000);
  const setup = await page.evaluate(SETUP_JS);
  console.log(`[core17kbbagf] setup: ${JSON.stringify(setup)}`);
  await page.waitForTimeout(1000);
  await page.mouse.move(VIEW.width / 2, 120);
  // keep the keyboard focus on the document (not the chat input)
  await page.evaluate(`(() => { const a = document.activeElement; if (a && a.blur) a.blur(); })()`);
  const screens: Record<string, { file: string; state: KeyState }> = {};

  // ── the Keyboard Config dialog, three tabs ──
  await page.evaluate(`window.__ac.gameUI.toggleKeyboardConfigPanel()`);
  await page.waitForTimeout(1200);
  await shoot(page, 'keyboard-movement', screens);
  for (const [tab, cls] of [['combat', 4], ['ui', 3]] as const) {
    await page.evaluate(`(() => { const ui = window.__ac.gameUI; ui.keyboardConfigTab = ${cls}; ui.refreshKeyboardTabs(); })()`);
    await page.waitForTimeout(800);
    await shoot(page, `keyboard-${tab}`, screens);
  }
  await page.evaluate(`window.__ac.gameUI.closeKeyboardConfigPanel(false)`);
  await page.waitForTimeout(600);

  // ── F12 / F8 in the world ──
  await page.keyboard.press('F12');
  await page.waitForTimeout(1200);
  await shoot(page, 'f12-inventory', screens);
  await page.keyboard.press('F12');
  await page.waitForTimeout(600);
  await page.keyboard.press('F8');
  await page.waitForTimeout(1200);
  await shoot(page, 'f8-attributes', screens);
  await page.keyboard.press('F8');
  await page.waitForTimeout(600);

  // ── the digits out of combat: no cast ──
  await page.keyboard.press('Digit1');
  await page.waitForTimeout(800);
  await shoot(page, 'digit-peace', screens);

  // ── magic mode: End casts the selection, "1" casts slot 1 ──
  await page.evaluate(`(() => { const ui = window.__ac.gameUI; ui.hud.combatMode = 8; ui.updateSpellBarVisibility(); if (ui.selectSpellShortcut) ui.selectSpellShortcut(0); ui.refreshSpellBarPanel && ui.refreshSpellBarPanel(); })()`);
  await page.waitForTimeout(1200);
  await page.keyboard.press('End');
  await page.waitForTimeout(800);
  await page.keyboard.press('Digit1');
  await page.waitForTimeout(800);
  await shoot(page, 'end-magic', screens);
  await page.evaluate(`(() => { const ui = window.__ac.gameUI; ui.hud.combatMode = 1; ui.updateSpellBarVisibility(); })()`);
  await page.waitForTimeout(600);

  // ── Q autorun on, S stop ──
  await page.keyboard.press('KeyQ');
  await page.waitForTimeout(700);
  const q = await state(page);
  await page.keyboard.press('KeyS');
  await page.waitForTimeout(700);
  const s = await shoot(page, 'q-autorun', screens);
  console.log(`[core17kbbagf] autorun after Q=${q.autoRun} after S=${s.autoRun}`);
  screens['q-autorun'].state = { ...s, autoRun: q.autoRun, spew: [...s.spew, `autorun after Q: ${q.autoRun}; after S: ${s.autoRun}`] };

  writeFileSync(join(OUT, BEFORE ? 'live-state-before.json' : 'live-state.json'), JSON.stringify({ setup, screens }, null, 2));
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
  type Live = { setup?: unknown; screens: Record<string, { file: string; state: KeyState }> };
  const load = (f: string): Live => existsSync(join(OUT, f)) ? JSON.parse(readFileSync(join(OUT, f), 'utf8')) as Live : { screens: {} };
  const live = load('live-state.json');
  const before = load('live-state-before.json');
  // the DAT truth, straight from the baked table
  const gen = await import(resolve(REPO, 'packages/renderer/src/input/KeybindDefaults.generated.ts')) as { RETAIL_DEFAULT_KEYBINDS: Record<number, string[]> };
  const acts = await import(resolve(REPO, 'packages/renderer/src/input/KeybindActions.generated.ts')) as { KEYBIND_ACTIONS: Array<{ id: number; name: string; cls: number }> };
  const reg = await import(resolve(REPO, 'packages/renderer/src/input/KeybindRegistry.ts')) as { codeToLabel: (c: string | null) => string };
  const datRows = (cls: number) => acts.KEYBIND_ACTIONS.filter((a) => a.cls === cls && gen.RETAIL_DEFAULT_KEYBINDS[a.id])
    .map((a) => `<tr><td>${a.name}</td><td>${gen.RETAIL_DEFAULT_KEYBINDS[a.id].map((c) => reg.codeToLabel(c)).join(' / ')}</td></tr>`).join('');
  const datTable = (title: string, cls: number) => `<div class="cell"><div class="lbl">${title}</div><table><tr><th>command (ActionMap)</th><th>gmDefaultMap / DefaultMap keys</th></tr>${datRows(cls)}</table></div>`;
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 2800, height: 900 } });
  const resolveTable = (src: Live, title: string): string => {
    const names = Object.keys(src.screens);
    if (!names.length) return '';
    const keys = PROBE_KEYS;
    const head = `<tr><th>beat</th><th>mode</th><th>active maps</th>${keys.map((k) => `<th>${k}</th>`).join('')}<th>inv</th><th>char</th><th>autorun</th><th>casts</th><th>spew</th></tr>`;
    const rows = names.map((n) => {
      const s = src.screens[n].state;
      return `<tr><td>${n}</td><td>${s.combatMode}</td><td>${s.activeMaps ? s.activeMaps.join(' ') : '—'}</td>${keys.map((k) => `<td>${s.resolve[k] ?? '—'}</td>`).join('')}<td>${s.inventory}</td><td>${s.charPanel}/${s.charTab}</td><td>${s.autoRun}</td><td>${JSON.stringify(s.casts)}</td><td>${s.spew.join(' | ') || '—'}</td></tr>`;
    }).join('');
    return `<h2>${title}</h2><table>${head}${rows}</table>`;
  };
  const beatRow = (title: string, name: string): string => {
    const cells = [
      frame(join(OUT, `ours-before-${name}.png`), `before — ${name}`, 640),
      frame(join(OUT, `ours-${name}.png`), `after — ${name}`, 640),
    ];
    return `<h2>${title}</h2><div class="row">${cells.join('')}</div>`;
  };
  const html = `${CSS}<h1>CORE.17.k.b.b.a.g.f — the retail KeyMap DAT (portal 0x14000000 "gmDefaultMap" + 0x14000002 "DefaultMap", CMasterInputMap::Serialize @ 0068fce0) drives the default key bindings, resolved through the combat mode's registered input maps (ClientCombatSystem::RegisterInputMaps @ 0056aa20; CPlayerSystem / ClientUISystem / gmMainChatUI for the always-on maps). Before: a hand-written table (I / B / C / M / P / O / Q panels, Tab combat, NumLock autorun, S back) and a flat lookup with no mode. No retail screenshot of the Keyboard Config dialog exists in the corpus — the retail reference is the DAT table itself, printed beside each tab.</h1>
    <div class="row">${datTable('retail reference — the DAT: Movement (class 1)', 1)}${datTable('retail reference — the DAT: Combat (class 4)', 4)}${datTable('retail reference — the DAT: UI (class 3)', 3)}</div>
    ${beatRow('Configure Keyboard, Movement tab — retail: W/Up, X/Down, A/Left, D/Right, Z + Alt+A + Alt+Left, C + Alt+D + Alt+Right, Space, Q, Shift, S, Y/G/H/B; before: W/Up, S/Down, A, D, Z, C, Space, NumLock, Shift', 'keyboard-movement')}
    ${beatRow('the Combat tab — retail: ` toggle, Ins/PgUp power, Del/End/PgDn attack height, End cast, Del/PgDn prev/next spell, Ins/PgUp prev/next tab, Ctrl+ first/last, 1-9 spell slots, 10-12 unbound; before: `/Tab toggle, 1-9 only', 'keyboard-combat')}
    ${beatRow('the UI tab — retail: E examine, R use, T split stack, F1 help, F3/F4 allegiance/fellowship, F5/F6 spellbook/components, F8/F9 attributes/skills, F10 world, F11 options, F12 inventory, Home last attacker, Alt+1-4 floaty chat; before: I/B/C/P/M/O/Q/E/U/Home/Enter', 'keyboard-ui')}
    ${beatRow('F12 in the world — retail: the inventory panel; before: nothing (I did)', 'f12-inventory')}
    ${beatRow('F8 — retail: the character panel on the Attributes page; before: nothing (B did, on whatever page was last)', 'f8-attributes')}
    ${beatRow('"1" out of combat — retail: Quickslot 1 (no spell); before: cast slot 1 in any mode', 'digit-peace')}
    ${beatRow('magic mode: End then "1" — retail: End casts the selection, "1" casts slot 1 (the 0x10000005 map registered); before: End nothing, "1" cast', 'end-magic')}
    ${beatRow('Q then S — retail: Q autorun on (0x30), S Stop Moving (0x2b, TurnOffRunLock); before: Q opened the quest log, NumLock autorun, S walked backward', 'q-autorun')}
    ${resolveTable(live, 'the registry per beat (after, live-state.json) — what each probe key resolves to')}
    ${resolveTable(before, 'the registry per beat (before, live-state-before.json)')}`;
  await page.setContent(html);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'core17kbbagf-keymap-defaults-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17kbbagf] wrote ${join(OUT, 'core17kbbagf-keymap-defaults-sidebyside.png')}`);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--compose-only')) await captureLive();
  if (!BEFORE) await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
