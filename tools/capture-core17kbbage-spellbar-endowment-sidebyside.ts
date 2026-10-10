/**
 * CORE.17.k.b.b.a.g.e — the spell bar's endowment icon 0x100000b1: the
 * wielded caster's item spell (gmSpellcastingUI::UpdateEndowmentIcon @
 * 004c6120 — the spell icon underlay 0x10000452, the item's drag icon overlay
 * 0x10000453, the selected overlay 0x10000454 / 0x06004d09, the tooltip
 * "%s (%hs)\nDouble-click to cast this spell"), selectable (a click →
 * m_endowmentSelected, the name field "%s (%hs)", the Cast button's "USE the
 * %s" texts), cast through the Cast button / a double-click as
 * ItemHolder::UseObject(item, 1, 1) — a UseWithTarget on the selection or
 * "Select your target before using the %s". Before: the icon was hidden
 * unconditionally.
 *
 * Live capture on the ACE stack + a retail | before | after side-by-side.
 *
 * Beats (each a whole-screen frame + a 2x crop of the spell bar):
 *   no-caster        magic mode, one shortcut, no caster wielded
 *   wielded          the Practice Wand (@ci 4799, spell 27) wielded: the icon, selected
 *   cast-no-target   the Cast button with the endowment selected and nothing targeted
 *   shortcut-click   a click on the shortcut: the endowment deselects
 *   icon-click       a click on the icon: re-selected
 *   walk-next        Next Spell Selection from the endowment → the shortcut
 *   cast-target      the Cast button with a creature selected (UseWithTarget)
 *
 * Usage:
 *   npx tsx tools/capture-core17kbbage-spellbar-endowment-sidebyside.ts            # capture + compose
 *   npx tsx tools/capture-core17kbbage-spellbar-endowment-sidebyside.ts --before
 *   npx tsx tools/capture-core17kbbage-spellbar-endowment-sidebyside.ts --compose-only
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbage');
const RETAIL = join(REPO, 'reference', 'images', 'hud', 'rawg_10.jpg');
const RETAIL_EOL = join(REPO, 'reference', 'images', 'hud', 'reddit-shutdown.jpg');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const BASE = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const BEFORE = process.argv.includes('--before');
const PREFIX = BEFORE ? 'ours-before-' : 'ours-';

interface BarState {
  tab: number;
  selected: number | null;
  endowmentSelected: boolean | null;
  endowment: { itemId: number; spellId: number; present: boolean } | null;
  icon: { display: string; tooltip: string | null; spellIcon: string | null; itemIcon: string | null; selectedOverlay: string | null } | null;
  nameField: string;
  castTooltip: string | null;
  castable: boolean;
  casts: number[];
  spew: string[];
  sent: string[];
  equipped: string[];
  target: string | null;
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
    ui.wizard.name = 'Endowment Tester';
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

/** Hook the cast callback + the spew sink, enter magic mode, put one shortcut on tab 0. */
const SETUP_JS = `(() => {
  const ui = window.__ac.gameUI;
  window.__casts = []; window.__spew = [];
  const cb = ui.spellCallbacks || (ui.spellCallbacks = {});
  const orig = cb.onCastSpell;
  cb.onCastSpell = (i) => { window.__casts.push(i); if (orig) orig(i); };
  const origErr = ui.displayErrorText.bind(ui);
  ui.displayErrorText = (t) => { window.__spew.push(t); origErr(t); };
  ui.hud.combatMode = 8; ui.updateSpellBarVisibility();
  const tab = ui.activeSpellBarTab;
  if (!ui.knownSpells || ui.knownSpells.length < 1) {
    const t = ui.spellTable;
    const a = t.spells.get(1);
    ui.knownSpells = [{ id: 1, name: a.name, desc: a.desc, school: a.school, level: 1, power: a.power, manaCost: a.baseMana, difficulty: a.power, duration: a.duration || 0, components: [], targetType: 0, iconId: a.icon || undefined }];
  }
  const filled = (ui.spellBarSlots[tab] || []).filter(Boolean).length;
  if (filled === 0) ui.assignSpellToBar(0, 0);
  ui.selectSpellShortcut(0);
  ui.refreshSpellBarPanel();
  return { tab, spells: ui.knownSpells.map((s) => s.id + ':' + s.name), filled: (ui.spellBarSlots[tab] || []).filter(Boolean).length, magic: !!(ui.spellBarPanelEl && ui.spellBarPanelEl.style.display === 'block') };
})()`;

const STATE_JS = `(() => {
  const ui = window.__ac.gameUI;
  const tab = ui.activeSpellBarTab;
  const h = ui.spellBarHandle;
  const icon = h && h.elements.get(0x100000b1);
  const under = h && h.elements.get(0x10000452);
  const over = h && h.elements.get(0x10000453);
  const sel = h && h.elements.get(0x10000454);
  const nameEl = h && h.elements.get(0x1000048b);
  const cv = nameEl ? nameEl.querySelector('.layout-text > canvas') : null;
  const btn = h && h.elements.get(0x100000b2);
  const r = ui.spellBarPanelEl ? ui.spellBarPanelEl.getBoundingClientRect() : null;
  const eq = (window.acDebug && window.acDebug.equipped) ? window.acDebug.equipped() : null;
  const t = ui.hud.target;
  return { tab, selected: Array.isArray(ui.spellBarSelected) ? ui.spellBarSelected[tab] : null,
    endowmentSelected: typeof ui.endowmentSelected === 'function' ? ui.endowmentSelected() : null,
    endowment: typeof ui.endowmentState === 'function' ? ui.endowmentState() : null,
    icon: icon ? { display: icon.style.display, tooltip: icon.dataset.acTooltipText || null, spellIcon: under ? (under.dataset.spellIcon || null) : null, itemIcon: over ? (over.dataset.itemIcon || null) : null, selectedOverlay: sel ? sel.style.display : null } : null,
    nameField: cv ? (cv.dataset.text || '') : (nameEl ? nameEl.textContent || '' : ''),
    castTooltip: btn ? (btn.dataset.acTooltipText || null) : null, castable: !!(btn && btn.dataset.castable === '1'),
    casts: window.__casts.slice(), spew: window.__spew.slice(), sent: (window.__sent || []).slice(),
    equipped: Array.isArray(eq) ? eq.map((e) => e.name || String(e)) : (eq ? [JSON.stringify(eq).slice(0, 120)] : []),
    target: t ? t.name : null,
    bar: r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null };
})()`;
const RECT_JS = (sel: string) => `(() => { const e = ${sel}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`;
const CELL = (i: number) => RECT_JS(`window.__ac.gameUI.spellBarPanelEl.querySelector('[data-spell-slot="' + window.__ac.gameUI.activeSpellBarTab + '-${i}"]')`);
const CAST_BTN = RECT_JS(`window.__ac.gameUI.spellBarHandle.elements.get(0x100000b2)`);
const ICON = RECT_JS(`window.__ac.gameUI.spellBarHandle.elements.get(0x100000b1)`);

async function state(page: Page): Promise<BarState> { return page.evaluate(STATE_JS) as Promise<BarState>; }
async function shoot(page: Page, name: string, screens: Record<string, { file: string; state: BarState }>): Promise<BarState> {
  const file = `${PREFIX}${name}.png`;
  const s = await state(page);
  await page.screenshot({ path: join(OUT, file) });
  screens[name] = { file, state: s };
  console.log(`[core17kbbage] ${name}: sel=${s.selected} endow=${JSON.stringify(s.endowment)} endowSel=${s.endowmentSelected} icon=${JSON.stringify(s.icon)} name="${s.nameField}" tip="${s.castTooltip}" casts=${JSON.stringify(s.casts)} spew=${JSON.stringify(s.spew)} sent=${JSON.stringify(s.sent)} eq=${JSON.stringify(s.equipped)} target=${s.target}`);
  return s;
}

async function captureLive(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.on('pageerror', (e) => console.log('[page error]', e.message));
  page.on('console', (m) => {
    const t = m.text();
    if (/Sent (UseWithTarget|Use|IdentifyObject) \((endowment)/.test(t)) {
      page.evaluate((line) => { const w = window as unknown as { __sent?: string[] }; (w.__sent = w.__sent || []).push(line); }, t).catch(() => {});
    }
  });
  console.log(`[core17kbbage] ${BASE}`);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await waitForWorld(page);
  console.log('[core17kbbage] in world');
  await page.waitForTimeout(6000);
  const setup = await page.evaluate(SETUP_JS);
  console.log(`[core17kbbage] setup: ${JSON.stringify(setup)}`);
  await page.waitForTimeout(1500);
  await page.mouse.move(VIEW.width / 2, 120);
  await page.waitForTimeout(400);
  const screens: Record<string, { file: string; state: BarState }> = {};
  // The character persists on ACE between runs (the wand stays wielded):
  // unwield the Held slot first so the no-caster beat is a no-caster beat.
  const hadHeld = await page.evaluate(`(() => { const eq = window.acDebug.equipped(); return eq.some((e) => e.slot === 'Held'); })()`);
  if (hadHeld) {
    await page.evaluate(`window.acDebug.unwield('Held')`);
    await page.waitForTimeout(3500);
    await page.evaluate(`(() => { const ui = window.__ac.gameUI; ui.hud.combatMode = 8; ui.updateSpellBarVisibility(); ui.refreshSpellBarPanel(); })()`);
    await page.waitForTimeout(600);
  }
  await shoot(page, 'no-caster', screens);

  // The Practice Wand (wcid 4799: ItemType Caster, SpellDID 27, ItemUseable
  // 0x600004, TargetType Creature) — created by the admin command unless the
  // pack already holds one, then wielded.
  const hasWand = await page.evaluate(`(() => { const ui = window.__ac.gameUI; return (ui.inventoryItems || []).some((i) => i.name === 'Practice Wand'); })()`);
  if (!hasWand) {
    await page.evaluate(`window.acDebug.sendChat('@ci 4799')`);
    await page.waitForTimeout(3000);
  }
  await page.evaluate(`window.acDebug.equip('Practice Wand', 'Held')`);
  await page.waitForTimeout(3500);
  await page.evaluate(`(() => { const ui = window.__ac.gameUI; ui.hud.combatMode = 8; ui.updateSpellBarVisibility(); ui.refreshSpellBarPanel(); })()`);
  await page.waitForTimeout(600);
  const hover = async (js: string): Promise<void> => {
    const p = await page.evaluate(js) as { x: number; y: number } | null;
    if (!p) return;
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(900);
  };
  await hover(ICON);
  await shoot(page, 'wielded', screens);

  const clickAt = async (js: string, kind: 'click' | 'dblclick'): Promise<boolean> => {
    const p = await page.evaluate(js) as { x: number; y: number } | null;
    if (!p) return false;
    if (kind === 'click') await page.mouse.click(p.x, p.y);
    else await page.mouse.dblclick(p.x, p.y);
    await page.mouse.move(p.x, p.y + 1);
    await page.waitForTimeout(700);
    return true;
  };

  if (await clickAt(CAST_BTN, 'click')) await shoot(page, 'cast-no-target', screens);
  if (await clickAt(CELL(0), 'click')) await shoot(page, 'shortcut-click', screens);
  if (await clickAt(ICON, 'click')) await shoot(page, 'icon-click', screens);
  await page.evaluate(`window.__ac.gameUI.cycleSpellSelection('next')`);
  await page.waitForTimeout(500);
  await shoot(page, 'walk-next', screens);
  await page.evaluate(`window.__ac.gameUI.cycleSpellSelection('prev')`);
  await page.waitForTimeout(400);

  // A creature target for the UseWithTarget beat: the nearest creature
  // through the debug selection (Holtburg's Town Crier / a drudge).
  const picked = await page.evaluate(`(() => {
    const objs = window.acDebug.getObjects ? window.acDebug.getObjects() : [];
    const list = Array.isArray(objs) ? objs : Object.values(objs || {});
    // acDebug.getObjects: { guid, name, type: the wire ItemType } — 0x10 = Creature.
    const c = list.find((o) => o && typeof o.type === 'number' && (o.type & 0x10) !== 0 && o.name);
    if (!c) return null;
    window.acDebug.select(c.guid ?? c.id);
    return c.name || String(c.guid ?? c.id);
  })()`);
  console.log(`[core17kbbage] target: ${picked}`);
  await page.waitForTimeout(800);
  await hover(CAST_BTN);
  if (await clickAt(CAST_BTN, 'click')) await shoot(page, 'cast-target', screens);

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
    const head = `<tr><th>beat</th><th>selected</th><th>endowment (item / spell / present)</th><th>m_endowmentSelected</th><th>0x100000b1</th><th>0x1000048b</th><th>Cast tooltip</th><th>casts</th><th>0x1a spew</th><th>sent</th><th>target</th></tr>`;
    const rows = names.map((n) => {
      const s = src.screens[n].state;
      const e = s.endowment;
      return `<tr><td>${n}</td><td>${s.selected ?? '—'}</td><td>${e ? `0x${e.itemId.toString(16)} / ${e.spellId} / ${e.present}` : '—'}</td><td>${s.endowmentSelected ?? '—'}</td><td>${s.icon ? `display="${s.icon.display}" sel="${s.icon.selectedOverlay}" spell=${s.icon.spellIcon} item=${s.icon.itemIcon} tip="${(s.icon.tooltip ?? '').replace(/\n/g, '\\n')}"` : '—'}</td><td>"${s.nameField}"</td><td>${(s.castTooltip ?? '—').replace(/\n/g, '\\n')}${s.castable ? ' [castable]' : ''}</td><td>${JSON.stringify(s.casts)}</td><td>${s.spew.join(' | ') || '—'}</td><td>${s.sent.join(' | ') || '—'}</td><td>${s.target ?? '—'}</td></tr>`;
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
  const html = `${CSS}<h1>CORE.17.k.b.b.a.g.e — the spell bar's endowment icon 0x100000b1 (gmSpellcastingUI::UpdateEndowmentIcon @ 004c6120): the wielded caster's item spell — the spell icon underlay 0x10000452, the item's drag icon overlay 0x10000453, the selected overlay 0x10000454 (0x06004d09), the tooltip "%s (%hs)\\nDouble-click to cast this spell"; selectable (a click → m_endowmentSelected; 0x1000048b "%s (%hs)"; the Cast button's "USE the %s" / "You must select a target for the %s" texts); the Cast button / a double-click → ItemHolder::UseObject(item, 1, 1) = UseWithTarget on the selection or "Select your target before using the %s" (0x1a). Before: the icon was hidden unconditionally, the wielded caster's spell had no place on the bar.</h1>
    <div class="row">${frame(RETAIL, 'retail reference — reference/images/hud/rawg_10.jpg (2005 layout): the spell bar in magic mode; the endowment sits left of the shortcuts when a caster with an item spell is wielded (none in this frame)', 700)}${frame(RETAIL_EOL, 'retail reference (EoL layout, ACE) — reference/images/hud/reddit-shutdown.jpg: the bar\'s left cell at (4,24) is the endowment icon\'s slot (hidden without a caster)', 700)}</div>
    ${beatRow('no caster wielded — retail: the icon hidden; ours: the same', 'no-caster')}
    ${beatRow('the Practice Wand (spell 27) wielded — retail: the icon shows (the spell icon under the wand icon), selected at once (nothing else selected), "Practice Wand (<spell>)" in 0x1000048b, "You must select a target for the Practice Wand" on the Cast button, the icon tooltip; before: hidden', 'wielded')}
    ${beatRow('the Cast button with the endowment selected and no target — retail: UseObject → "Select your target before using the Practice Wand" (0x1a); before: "You must select a spell to cast"', 'cast-no-target')}
    ${beatRow('a click on the shortcut — retail: SetSelected clears m_endowmentSelected (the overlay leaves the icon, the spell\'s name in the field); before: no icon', 'shortcut-click')}
    ${beatRow('a click on the icon — retail: m_endowmentSelected again, SetSelected(0), the field back to "%s (%hs)"', 'icon-click')}
    ${beatRow('Next Spell Selection from the endowment — retail: the first shortcut', 'walk-next')}
    ${beatRow('the Cast button with a creature selected — retail: TargetCompatibleWithObject → Event_UseWithTargetEvent (ACE casts the wand\'s spell on it); "USE the Practice Wand on <target>"', 'cast-target')}
    ${table(live, 'the bar state per beat (after, live-state.json)')}
    ${table(before, 'the bar state per beat (before, live-state-before.json)')}`;
  await page.setContent(html);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'core17kbbage-spellbar-endowment-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17kbbage] wrote ${join(OUT, 'core17kbbage-spellbar-endowment-sidebyside.png')}`);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--compose-only')) await captureLive();
  if (!BEFORE) await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
