/**
 * probe-settings-persistence — live round-trip audit of every per-player
 * setting surface against the local ACE stack (headless Playwright).
 *
 * Retail ground truth (decompiled EoL client):
 *   SERVER (the PlayerModule, follows the character): CharacterOptions1/2,
 *     the GameplayOptions blob (every floaty window's x/y/w/h/visible/title
 *     — chat windows 2-5, main chat 8, panels window 9, toolbar 10, vitals
 *     11/17, indicators 12, power bar 13, radar 14 — the chat filters and
 *     the two chat opacities), spell favorites, item shortcuts, desired
 *     components. CPlayerModule::UseTime ships a dirty module 480 s after
 *     the first change; CPlayerSystem::LogOffCharacter @ 00563520 and
 *     PlayerOptionPage::SaveCurrentValues (Apply) call SaveToServer first.
 *   LOCAL (the machine): key map, graphics/sound (Config tab), UI state.
 *
 * Flow (one browser, one context at a time — ACE allows one session per
 * account):
 *   A  fresh context: baseline, then change every surface through the real
 *      UI (option rows, sliders, drag bars, a pack→toolbar drag, spell-bar
 *      assign, Keyboard-config registry commit, Config slider). The LAST
 *      change is a window drag, followed IMMEDIATELY by the indicator-strip
 *      logout (no 480 s wait) → character select → Enter (same page).
 *   B1 same page after the relog: everything should match A.
 *   B2 fresh context ("another device"): server surfaces must match A;
 *      local ones are expected to be back at their defaults.
 *   C  in B2, drag the main chat again and close the TAB at once (no
 *      logout); a fresh context D then checks that the pagehide flush
 *      landed.
 *
 *   AC_BASE=http://localhost:3471/ AC_BRIDGE=ws://localhost:9098 \
 *     AC_ACCOUNT=persistprobe1 npx tsx tools/probe-settings-persistence.ts
 *
 * Report → verification/settings-persistence/report.json (+ screenshots).
 * Never point it at testacjs / testacjs2 / testacjs3 (Jake's and the GPU
 * soak's accounts): it rewrites the character's options.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import {
  DEFAULT_VIEWPORT, REPO, adminCommand, attachCrashAlarms, createCharacterIfNeeded, gameUrl, launchBrowser,
  readAc, waitFor, waitForWorld, IN_WORLD_JS,
} from './lib/game-session.js';

const OUT = join(REPO, 'verification', 'settings-persistence');
const TAG = '[settings-persistence]';
const CHAR_NAME = 'Persist Probe';
/** Spells @addspell'd for the spell-bar check (Strength Self I, Flame Bolt I). */
const SPELLS = [2, 27];
/** Character-page toggles flipped in session A (all CharacterOptions1/2 bits). */
const OPTION_KEYS = ['sideBySideVitals', 'showCoordinatesByTheRadar', 'displayTimestamps', 'autoTarget', 'useChargeAttack'];
/** A main-chat channel checkbox (Chat tab, part of the window-8 filter 0x1000007f). */
const CHAT_FILTER_KEY_PREFIX = 'chatMainWindow';
/** A spell-component wcid for the desired-components (fill comps) check. */
const LEAD_SCARAB = 691;
/** "Another, smaller screen" for the restore-clamp check. */
const SMALL_VIEWPORT = { width: 1024, height: 640 } as const;

type Snapshot = Record<string, unknown>;

/** Every observable setting, read from the live client. */
const SNAPSHOT_JS = `(() => {
  const ui = ac.gameUI, s = ui.optionsSettings;
  const rect = (el) => el ? { x: parseInt(el.style.left), y: parseInt(el.style.top), w: el.offsetWidth, h: el.offsetHeight, shown: el.style.display !== 'none' } : null;
  const floaty1 = (ui.floatyChatInstances || []).find((i) => i.def.index === 1);
  const chatKeys = Object.keys(s).filter((k) => k.startsWith('${CHAT_FILTER_KEY_PREFIX}')).sort();
  const reg = ui.keybindRegistry;
  const act = reg && reg.actions()[0];
  return {
    options: Object.fromEntries(${JSON.stringify(OPTION_KEYS)}.map((k) => [k, !!s[k]])),
    vitalsCluster: ui.vitalsContainer ? ui.vitalsContainer.dataset.vitalsCluster || null : null,
    chatOpacity: { inactive: s.chatInactiveOpacity, active: s.chatActiveOpacity, inactiveSet: !!s.chatInactiveOpacitySet },
    chatFilter: { key: chatKeys[0], on: !!s[chatKeys[0]] },
    mainChat: ui.mainChatRect ? ui.mainChatRect() : null,
    floatyChat1: floaty1 ? { open: !!floaty1.open, x: parseInt(floaty1.panelEl.style.left), y: parseInt(floaty1.panelEl.style.top) } : null,
    radar: ui.radarContainer ? { x: parseInt(ui.radarContainer.style.left), y: parseInt(ui.radarContainer.style.top), right: ui.radarContainer.style.right } : null,
    panelsWindow: (() => { const f = document.querySelector('[data-panels-window-frame]'); return f ? rect(f.parentElement) : null; })(),
    toolbar: (() => { const t = document.getElementById('hud-toolbar-window'); return t ? { x: t.offsetLeft, y: t.offsetTop } : null; })(),
    desiredComps: ui.desiredComps ? [...ui.desiredComps.entries()].sort((a, b) => a[0] - b[0]) : null,
    shortcuts: dbg.toolbarShortcuts(),
    spellBar0: (ui.spellBarSlots && ui.spellBarSlots[0] || []).filter(Boolean).map((sp) => sp.id),
    keybind: act ? { id: act.id, mappings: reg.getMappings(act.id) } : null,
    config: { alignCameraToSlope: !!s.alignCameraToSlope },
    localStorageKeys: Object.keys(localStorage).sort(),
  };
})()`;

async function snapshot(page: Page): Promise<Snapshot> {
  // The panels window only exists while a panel shows: open the inventory.
  await readAc(page, '(() => { if (!ac.gameUI.inventoryVisible) ac.gameUI.toggleInventory(); return 0; })()');
  await page.waitForTimeout(1500);
  const snap = await readAc<Snapshot>(page, SNAPSHOT_JS);
  await readAc(page, '(() => { if (ac.gameUI.inventoryVisible) ac.gameUI.toggleInventory(); return 0; })()');
  await page.waitForTimeout(300);
  return snap;
}

/**
 * Centers of the visible move-cursor drag bars inside `containerJs` (screen
 * px), only those actually on top at their center (elementFromPoint), so a
 * bar under another window is skipped.
 */
async function dragBarPoints(page: Page, containerJs: string): Promise<Array<{ x: number; y: number }>> {
  return readAc(page, `(() => {
    const c = ${containerJs};
    if (!c) return [];
    const bars = [...c.querySelectorAll('[data-element-id], #radar-drag-button')].filter((e) => e.style.cursor === 'move');
    const out = [];
    for (const b of bars) {
      const r = b.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      const top = document.elementFromPoint(x, y);
      if (top && (top === b || b.contains(top))) out.push({ x, y });
    }
    return out;
  })()`);
}

/** Drag the window by (dx, dy) screen px through its first working drag bar; true once it moved. */
async function dragBy(page: Page, containerJs: string, dx: number, dy: number, what: string): Promise<boolean> {
  const pos = () => readAc<string>(page, `(() => { const c = ${containerJs}; return c ? JSON.stringify(c.getBoundingClientRect()) : ''; })()`);
  for (const p of (await dragBarPoints(page, containerJs)).slice(0, 4)) {
    const before = await pos();
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(p.x + (dx * i) / 8, p.y + (dy * i) / 8);
    await page.mouse.up();
    await page.waitForTimeout(400);
    if ((await pos()) !== before) return true;
  }
  console.log(`${TAG} could not drag ${what}`);
  return false;
}

async function clickRow(page: Page, key: string): Promise<boolean> {
  return readAc(page, `(() => { const r = document.querySelector('.option-toggle-row[data-option-key="${key}"]');
    if (!r) return false; r.scrollIntoView({ block: 'center' }); r.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);
}

async function openOptionsTab(page: Page, tab: string): Promise<void> {
  await readAc(page, '(() => { if (!ac.gameUI.optionsPanelVisible) ac.gameUI.toggleOptionsPanel(); return 0; })()');
  await page.waitForTimeout(600);
  await readAc(page, `(() => { const t = document.querySelector('[data-options-tab="${tab}"]'); if (t) t.dispatchEvent(new MouseEvent('click', { bubbles: true })); return 0; })()`);
  await page.waitForTimeout(800);
}

async function closeOptions(page: Page): Promise<void> {
  await readAc(page, '(() => { if (ac.gameUI.optionsPanelVisible) ac.gameUI.toggleOptionsPanel(); return 0; })()');
  await page.waitForTimeout(400);
}

/** Mouse-down on a slider track at `fraction` of its width. */
/**
 * Drag a window's top-left to one of two target spots (screen px): the
 * first unless it already sits there, so every run makes a real change
 * whatever an earlier run left on the server. The targets never overlap.
 */
async function dragTo(page: Page, containerJs: string, targets: [[number, number], [number, number]], what: string): Promise<boolean> {
  const r = await readAc<{ x: number; y: number } | null>(page, `(() => { const c = ${containerJs}; if (!c) return null; const b = c.getBoundingClientRect(); return { x: b.x, y: b.y }; })()`);
  if (!r) { console.log(`${TAG} no ${what}`); return false; }
  const near = (t: [number, number]) => Math.abs(r.x - t[0]) < 20 && Math.abs(r.y - t[1]) < 20;
  const [tx, ty] = near(targets[0]) ? targets[1] : targets[0];
  return dragBy(page, containerJs, tx - r.x, ty - r.y, what);
}

async function setSlider(page: Page, selectorJs: string, fraction: number): Promise<boolean> {
  const r = await readAc<{ x: number; y: number; w: number; h: number } | null>(page, `(() => { const t = ${selectorJs};
    if (!t) return null; t.scrollIntoView({ block: 'center' }); const b = t.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; })()`);
  if (!r) return false;
  await page.mouse.click(r.x + r.w * fraction, r.y + r.h / 2);
  await page.waitForTimeout(300);
  return true;
}

async function newPage(browser: Browser, viewport: { width: number; height: number } = DEFAULT_VIEWPORT): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.setDefaultTimeout(120_000);
  page.on('dialog', (d) => void d.dismiss());
  attachCrashAlarms(page);
  return { ctx, page };
}

async function login(page: Page, url: string, logs: string[]): Promise<void> {
  page.on('console', (m) => {
    const t = m.text();
    if (/PlayerDesc|chat-window|Chat-window|Item-shortcut|SetCharacterOptions|ShortCut|SpellFavorite|CharacterOption|LogOff/i.test(t)) logs.push(t.slice(0, 240));
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const ok = await waitForWorld(page, { url, onPoll: createCharacterIfNeeded(CHAR_NAME) });
  if (!ok) throw new Error(`${TAG} never entered world`);
  await page.waitForTimeout(8000);
}

/** The indicator-strip logout X, then Enter from character select (same page). */
async function logoutAndReenter(page: Page): Promise<void> {
  await readAc(page, '(ac.gameUI.callbacks.onLogout(), 0)');
  if (!(await waitFor(page, "window.__ac.gameUI.ui.currentScreen === 'character-select'", { timeoutMs: 120_000, reloadEveryMs: 0 }))) {
    throw new Error(`${TAG} logout never reached character select`);
  }
  await page.waitForTimeout(4000);
  await page.click('[data-ac-press="21000004:100003a2"]');
  if (!(await waitFor(page, IN_WORLD_JS, { timeoutMs: 180_000, reloadEveryMs: 0 }))) throw new Error(`${TAG} re-enter failed`);
  await page.waitForTimeout(8000);
}

async function main(): Promise<void> {
  process.env.AC_BASE ??= 'http://localhost:3471/';
  process.env.AC_BRIDGE ??= 'ws://localhost:9098';
  process.env.AC_ACCOUNT ??= 'persistprobe1';
  if (/^testacjs\d?$/.test(process.env.AC_ACCOUNT)) throw new Error(`${TAG} refusing to run on ${process.env.AC_ACCOUNT}`);
  mkdirSync(OUT, { recursive: true });
  const url = gameUrl({ cb: 'settings-persistence' });
  const browser = await launchBrowser();
  const logs: Record<string, string[]> = { A: [], B2: [], D: [] };
  const report: Record<string, unknown> = { at: new Date().toISOString(), account: process.env.AC_ACCOUNT, url: url.replace(/password=[^&]*/, 'password=…') };

  // ── Session A ──────────────────────────────────────────────────────────
  const a = await newPage(browser);
  await login(a.page, url, logs.A);
  const page = a.page;
  // Known starting point for the spell bar + toolbar.
  for (const sp of SPELLS) await adminCommand(page, `@addspell ${sp}`);
  await page.waitForTimeout(2500);
  // Clear what an earlier run left on the server: the spells on bar 1 and
  // every toolbar shortcut (through the UI's own remove paths).
  await readAc(page, `(() => { const ui = ac.gameUI; ui.activeSpellBarTab = 0;
    for (const sp of (ui.spellBarSlots[0] || []).filter(Boolean)) ui.removeSpellFromBar(sp.id); return 0; })()`);
  for (const [i, id] of (await readAc<number[]>(page, 'dbg.toolbarShortcuts()')).entries()) if (id) await readAc(page, `(dbg.removeShortcut(${i}), 0)`);
  await readAc(page, `(() => { const ui = ac.gameUI; ui.desiredComps.delete(${LEAD_SCARAB}); ui.callbacks.onSetDesiredComponentLevel(${LEAD_SCARAB}, 0); return 0; })()`);
  await page.waitForTimeout(1500);
  const baseline = await snapshot(page);
  report.baseline = baseline;
  await page.screenshot({ path: join(OUT, 'A0-baseline.png') });

  const changes: Record<string, unknown> = {};
  // Options → Character rows.
  await openOptionsTab(page, 'character');
  for (const k of OPTION_KEYS) changes[`option:${k}`] = await clickRow(page, k);
  // Options → Chat: a main-window channel checkbox + the Inactive opacity slider.
  await openOptionsTab(page, 'chat');
  const chatKey = (baseline.chatFilter as { key: string }).key;
  changes.chatFilter = await clickRow(page, chatKey);
  changes.chatOpacity = await setSlider(page, `document.querySelectorAll('.options-slider-track')[0]`,
    ((baseline.chatOpacity as { inactive: number }).inactive < 45) ? 0.6 : 0.3);
  // Options → Config: Align Camera To Slope (browser-local, like retail's machine-local config).
  await openOptionsTab(page, 'config');
  changes.config = await clickRow(page, 'alignCameraToSlope');
  await closeOptions(page);
  // Keyboard config: rebind the first action's slot-1 key (what the dialog's OK commits).
  changes.keybind = await readAc(page, `(() => { const r = ac.gameUI.keybindRegistry; const a = r.actions()[0];
    r.setMapping(a.id, 1, 'KeyJ'); ac.gameUI.onKeybindsCommitted && ac.gameUI.onKeybindsCommitted(); return a.id; })()`);
  // Spell bar: put both spells on tab 1 through the UI's assign path.
  changes.spellBar = await readAc(page, `(() => { const ui = ac.gameUI; const ids = ${JSON.stringify(SPELLS)};
    const out = []; for (const id of ids) { const i = ui.knownSpells.findIndex((s) => s.id === id); if (i >= 0) { ui.assignSpellToBar(i, -1); out.push(id); } } return out; })()`);
  // Components page desired level (Event_SetDesiredComponentLevel 0x0224) — Lead Scarab.
  changes.desiredComp = await readAc(page, `(() => { const ui = ac.gameUI; ui.desiredComps.set(${LEAD_SCARAB}, 25);
    ui.callbacks.onSetDesiredComponentLevel(${LEAD_SCARAB}, 25); return true; })()`);
  // Toolbar: real HTML5 drag of the first pack item onto slot 1.
  await readAc(page, '(() => { if (!ac.gameUI.inventoryVisible) ac.gameUI.toggleInventory(); return 0; })()');
  await page.waitForTimeout(1500);
  const packItem = await readAc<number>(page, '(ac.gameUI.inventoryItems || [])[0]?.id || 0');
  if (packItem) await page.dragAndDrop('[data-inv-slot="0"]', '[data-item-shortcut="0"]').catch((e) => console.log(`${TAG} shortcut drag failed ${e}`));
  changes.shortcut = packItem;
  await page.waitForTimeout(1500);
  // Panels window (inventory showing): drag it left/up.
  changes.panelsWindow = await dragTo(page, "document.querySelector('[data-panels-window-frame]')?.parentElement", [[700, 100], [520, 140]], 'panels window');
  await readAc(page, '(() => { if (ac.gameUI.inventoryVisible) ac.gameUI.toggleInventory(); return 0; })()');
  // Toolbar window, radar + floaty chat 1.
  changes.toolbar = await dragTo(page, "document.getElementById('hud-toolbar-window')", [[1100, 600], [1160, 560]], 'toolbar');
  changes.radar = await dragTo(page, 'ac.gameUI.radarContainer', [[1300, 300], [1240, 340]], 'radar');
  await readAc(page, '(ac.gameUI.toggleFloatyChatWindow(1, true), 0)');
  await page.waitForTimeout(800);
  changes.floatyChat1 = await dragTo(page, "document.querySelector('[data-floaty-chat=\"1\"]')", [[200, 0], [260, 40]], 'floaty chat 1');
  // LAST: the main chat window, then log out at once (no debounce wait).
  changes.mainChat = await dragTo(page, 'ac.gameUI.chatContainer', [[100, 560], [160, 520]], 'main chat');
  report.changes = changes;
  const afterA = await snapshot(page);
  report.sessionA = afterA;
  await page.screenshot({ path: join(OUT, 'A1-changed.png') });
  await logoutAndReenter(page);
  const b1 = await snapshot(page);
  report.sessionB1_sameBrowser = b1;
  await page.screenshot({ path: join(OUT, 'B1-relog-same-browser.png') });
  await a.ctx.close();

  // ── Session B2 — another device ───────────────────────────────────────
  const b = await newPage(browser);
  await login(b.page, url, logs.B2);
  const b2 = await snapshot(b.page);
  report.sessionB2_newDevice = b2;
  await b.page.screenshot({ path: join(OUT, 'B2-new-device.png') });
  // ── In-session: a moved window keeps its move when re-opened ──────────
  // (the login-time server copy must not win over the newer move).
  await readAc(b.page, '(() => { if (!ac.gameUI.inventoryVisible) ac.gameUI.toggleInventory(); return 0; })()');
  await b.page.waitForTimeout(1500);
  await dragBy(b.page, "document.querySelector('[data-panels-window-frame]')?.parentElement", 0, 90, 'panels window (B2)');
  const panelsMovedB2 = await snapshot(b.page); // closes + re-opens the inventory
  report.panelsWindowAfterReopenB2 = panelsMovedB2.panelsWindow;
  // ── C — change ONE window, then close the tab without logging out ─────
  await dragBy(b.page, 'ac.gameUI.chatContainer', 80, -60, 'main chat (tab close)');
  const beforeClose = await readAc(b.page, 'ac.gameUI.mainChatRect()');
  report.tabCloseExpectedMainChat = beforeClose;
  await b.page.close({ runBeforeUnload: true });
  await b.ctx.close();
  await new Promise((r) => setTimeout(r, 8000));
  const d = await newPage(browser);
  await login(d.page, url, logs.D);
  const dSnap = await snapshot(d.page);
  report.sessionD_afterTabClose = dSnap;
  await d.page.screenshot({ path: join(OUT, 'D-after-tab-close.png') });

  // Log out properly so ACE frees the character for the next run.
  await readAc(d.page, '(ac.gameUI.callbacks.onLogout(), 0)').catch(() => {});
  await waitFor(d.page, "window.__ac.gameUI.ui.currentScreen === 'character-select'", { timeoutMs: 60_000, reloadEveryMs: 0 }).catch(() => false);
  await d.ctx.close();

  // ── E — the same character in a smaller browser window ─────────────────
  // Our HUD resizes with the window (the browser-UX exception): windows
  // saved near the right/bottom of the 1568x775 session must land fully on
  // screen (MoveTo-style clamp), not off the edge.
  await new Promise((r) => setTimeout(r, 5000));
  const e = await newPage(browser, SMALL_VIEWPORT);
  await login(e.page, url, []);
  await readAc(e.page, '(() => { if (!ac.gameUI.inventoryVisible) ac.gameUI.toggleInventory(); return 0; })()');
  await e.page.waitForTimeout(1500);
  const onScreen = await readAc<Record<string, { l: number; t: number; r: number; b: number; inside: boolean } | null>>(e.page, `(() => {
    const W = window.innerWidth, H = window.innerHeight;
    const box = (el) => { if (!el || el.style.display === 'none') return null; const b = el.getBoundingClientRect();
      return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom), inside: b.left >= -1 && b.top >= -1 && b.right <= W + 1 && b.bottom <= H + 1 }; };
    const ui = ac.gameUI; const f1 = (ui.floatyChatInstances || []).find((i) => i.def.index === 1);
    return { mainChat: box(ui.chatContainer), floatyChat1: box(f1 && f1.panelEl), radar: box(ui.radarContainer),
      toolbar: box(document.getElementById('hud-toolbar-window')),
      panelsWindow: box(document.querySelector('[data-panels-window-frame]')?.parentElement) };
  })()`);
  report.sessionE_smallWindow = { viewport: SMALL_VIEWPORT, windows: onScreen };
  await e.page.screenshot({ path: join(OUT, 'E-small-window.png') });
  await readAc(e.page, '(ac.gameUI.callbacks.onLogout(), 0)').catch(() => {});
  await waitFor(e.page, "window.__ac.gameUI.ui.currentScreen === 'character-select'", { timeoutMs: 60_000, reloadEveryMs: 0 }).catch(() => false);
  await e.ctx.close();
  await browser.close();

  // ── Verdicts ──────────────────────────────────────────────────────────
  const eq = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  const pick = (s: Snapshot, k: string) => s[k];
  type Row = { setting: string; store: 'server' | 'local'; changed: boolean; sameBrowser: boolean; newDevice: boolean | 'reset-as-expected' | 'NOT-reset' };
  const rows: Row[] = [];
  const add = (setting: string, store: 'server' | 'local', get: (s: Snapshot) => unknown) => {
    const A = get(afterA), base = get(baseline);
    const changed = !eq(A, base);
    const newDev = get(b2);
    rows.push({
      setting, store, changed,
      sameBrowser: changed && eq(get(b1), A),
      newDevice: store === 'server' ? changed && eq(newDev, A) : (eq(newDev, base) ? 'reset-as-expected' : 'NOT-reset'),
    });
  };
  for (const k of OPTION_KEYS) add(`option ${k}`, 'server', (s) => (s.options as Record<string, boolean>)[k]);
  add('chat filter (main window channel)', 'server', (s) => pick(s, 'chatFilter'));
  add('chat inactive opacity', 'server', (s) => (s.chatOpacity as { inactive: number }).inactive);
  add('main chat window position', 'server', (s) => { const r = s.mainChat as { x: number; y: number } | null; return r && { x: r.x, y: r.y }; });
  add('floaty chat 1 open + position', 'server', (s) => pick(s, 'floatyChat1'));
  add('radar position', 'server', (s) => { const r = s.radar as { x: number; y: number } | null; return r && { x: r.x, y: r.y }; });
  add('panels window position (inventory/character/…)', 'server', (s) => { const r = s.panelsWindow as { x: number; y: number } | null; return r && { x: r.x, y: r.y }; });
  add('toolbar item shortcut', 'server', (s) => pick(s, 'shortcuts'));
  add('spell bar favorites (tab 1)', 'server', (s) => pick(s, 'spellBar0'));
  add('key binding', 'local', (s) => pick(s, 'keybind'));
  add('Config option (Align Camera To Slope)', 'local', (s) => (s.config as { alignCameraToSlope: unknown }).alignCameraToSlope);
  add('toolbar window position', 'server', (s) => pick(s, 'toolbar'));
  add('desired components (fill comps)', 'server', (s) => pick(s, 'desiredComps'));
  const xy = (r: unknown) => { const o = r as { x: number; y: number } | null; return o && { x: o.x, y: o.y }; };
  const extra = {
    // In-session: the panels window re-opens where it was just dragged.
    panelsReopenKeepsMove: !eq(xy(panelsMovedB2.panelsWindow), xy(b2.panelsWindow)),
    // Tab close (pagehide/beforeunload flush): the one change made last landed …
    tabCloseFlush: !eq(xy(beforeClose), xy(b2.mainChat)) && eq(xy(dSnap.mainChat), xy(beforeClose)),
    // … the B2 panels move (saved in the same blob) landed …
    tabClosePanelsMove: eq(xy(dSnap.panelsWindow), xy(panelsMovedB2.panelsWindow)),
    // … and the windows untouched in B2 kept their session-A values (whole-module save).
    untouchedWindowsKept: eq(dSnap.floatyChat1, afterA.floatyChat1) && eq(xy(dSnap.radar), xy(afterA.radar))
      && eq(dSnap.toolbar, afterA.toolbar) && eq(dSnap.chatOpacity, afterA.chatOpacity),
  };
  (extra as Record<string, boolean>).smallWindowAllOnScreen = Object.values(onScreen).every((b) => b === null || b.inside);
  const tabCloseOk = Object.values(extra).every(Boolean);
  report.rows = rows;
  report.extraChecks = extra;
  report.tabCloseFlush = tabCloseOk;
  report.logs = logs;
  const pass = rows.every((r) => r.changed && r.sameBrowser && (r.store === 'server' ? r.newDevice === true : r.newDevice === 'reset-as-expected')) && tabCloseOk;
  report.pass = pass;
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.table(rows);
  console.log(`${TAG} extra checks: ${JSON.stringify(extra)}`);
  console.log(`${TAG} ${pass ? 'PASS' : 'FAIL'} → ${join(OUT, 'report.json')}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
