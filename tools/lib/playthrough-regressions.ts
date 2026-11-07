/**
 * This week's player-reported regressions as play-through steps (Jake, 2026-11-07): each reported bug becomes a
 * step of the first-hour run (tools/ac1999-playthrough.ts), so it can't silently come back.
 *
 *   option-defaults         a fresh profile's era option defaults (BUG.ac1999-environment-detail-default,
 *                           BUG.ac1999-texture-resolution-defaults): 1999 Environment Detail Textures off and the
 *                           texture menus Full; end of retail / Dark Majesty on, Medium / High
 *   pack-scroll-sort        webac#27: scroll the main pack down with the DAT scrollbar, drag one item onto another,
 *                           and the grid still shows the rows it showed (the scroll offset is kept)
 *   pack-bars               webac#25 / #27: a side pack holding items shows its fullness bar; a used kit shows its
 *                           uses bar in the pack and on a toolbar shortcut
 *   toolbar-relog           an item dragged onto toolbar slot 1 is still there after a relog
 *   shield-relog            webac#26: a wielded shield DRAWS the same pose after a relog as right after equipping
 *                           (acDebug.heldPose: the holding frame and every part's applied placement frame), not the
 *                           same requested placement id (1999 shields fall back from 6 to frame 0)
 *   running-jump-coast      BUG.remote-running-jump-snapback: a running jump with W let go mid-air coasts v / ln 20
 *                           after landing (retail calc_friction @ 0050ee70), not a dead stop
 *   create-character-click  UX.chargen-click-during-texture-load: a Create Character click opens chargen, with
 *                           Please Wait up until it does
 *   walk-short              the live gate's smoke (2026-11-07): walk a few metres through the agent's walk and the
 *                           position follows (every era on every fast-tier run; tools/lib/live-gate-scope.ts)
 *
 * Every check reads what the player SEES: the element under the point (elementFromPoint), the meter's drawn fill,
 * the option bullet's art, plus a screenshot; never text alone (memory note "verify UI by what is visible"). The
 * gestures are the real mouse and keyboard (a drag is a press, a move and a release over the cells). A step the
 * world makes impossible skips and says why. `--admin` lets a step spawn what it needs (the era's spawn command,
 * ADMIN_COMMANDS); without it a step uses what the character holds.
 *
 * The pure helpers (scroll and drag picking, the meter, coast and chargen-wait verdicts) are tested in
 * tests/verify-playthrough-regression-steps.ts; the steps run live (the lead runs them).
 */
import type { AgentResult } from '../../packages/renderer/src/agent/types.ts';
import { capacityBarFraction, structureBarFraction } from '../../packages/renderer/src/ui/structureBar.ts';
import { type HeldPose, heldPoseDifferences } from '../../packages/renderer/src/models/HeldPose.ts';
import { compassPoint } from '../../packages/renderer/src/agent/format.ts';
import { shortcutDropRefusal1999 } from '../../packages/renderer/src/network/itemShortcutRestore.ts';
import { type EraPlan, type Step, type StepContext, type StepOutcome, fail, ok, settle, skip } from './playthrough.ts';

// ── Geometry ────────────────────────────────────────────────────────────────

export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }
export const centerOf = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
/** `inner` lies wholly inside `outer` (1 px slack for sub-pixel layout). */
export const rectInside = (inner: Rect, outer: Rect): boolean =>
  inner.x >= outer.x - 1 && inner.y >= outer.y - 1 && inner.x + inner.w <= outer.x + outer.w + 1 && inner.y + inner.h <= outer.y + outer.h + 1;

// ── Era admin commands and the items the steps spawn ────────────────────────

/** The chat commands --admin types, per era: the AC1999 server's (ClientCommands.cpp) and ACE's (AdminCommands.cs). */
export interface AdminCommands { spawn: (wcid: number) => string; setHealth: (n: number) => string }

const ACE_ADMIN: AdminCommands = { spawn: (w) => `@ci ${w}`, setHealth: (n) => `@sethealth ${n}` };
export const ADMIN_COMMANDS: Record<string, AdminCommands> = {
  // spawnwcidinv @ ClientCommands.cpp:3147 ("Spawn by wcid into inventory"), sethealth @ :4163.
  'ac1999-retail': { spawn: (w) => `@spawnwcidinv ${w}`, setHealth: (n) => `@sethealth ${n}` },
  // HandleCI (AdminCommands.cs, one object per command), sethealth (DeveloperCommands).
  eor: ACE_ADMIN,
  'classicace-customdm': ACE_ADMIN,
};

/** Weenie classes every era's world has (1999 AC1999-World and ACE-World-16PY both carry them). */
export const REGRESSION_WCIDS = {
  /** Crude Lockpick: not stackable, 50 burden, so thirty fill rows without overloading the character. */
  filler: 511,
  /** Sack: a side pack (12 slots in 1999). */
  sack: 166,
  /** Crude / Handy Healing Kit (Structure 20 of MaxStructure 20). */
  kit: 628,
  /** Metal Round Shield, webac#26's shield. */
  shield: 1313,
} as const;

/** What the admin commands answer (spawn notices, a refusal for a bad wcid): expected chatter, not the client's refusals. */
export const ADMIN_CHATTER = /spawn|creat|couldn't find|can't be spawned|stacksize|health|must be below/i;

// ── Option defaults ────────────────────────────────────────────────────────

export interface OptionExpectation {
  /** The Config row's data-option-key. */
  key: string;
  kind: 'toggle' | 'menu';
  /** A toggle's expected state. */
  on?: boolean;
  /** A menu's expected label (case-insensitive). */
  label?: string;
  /** Only where the era draws the row (Landscape Detail Textures needs a see-through region texture). */
  optional?: boolean;
  why: string;
}

/** The era's fresh-profile defaults of the options the week's reports were about. */
export function optionDefaultsFor(era: EraPlan): OptionExpectation[] {
  if (era.key === 'ac1999-retail') {
    return [
      { key: 'buildingDetailTextures', kind: 'toggle', on: false, why: '1999 World_InitWorldEntry @ 0x0040d441 → 0x0042c236 zeroes the detail flags' },
      { key: 'landscapeTextureDetail', kind: 'menu', label: 'Full', why: '1999 texture-resolution globals are .bss: item 0, Full' },
      { key: 'environmentTextureDetail', kind: 'menu', label: 'Full', why: '1999 texture-resolution globals are .bss: item 0, Full' },
      { key: 'landscapeDetailTextures', kind: 'toggle', on: false, optional: true, why: '1999 Performance panel "Detail Texture: Landscape" starts off (0x42c236)' },
    ];
  }
  return [
    { key: 'buildingDetailTextures', kind: 'toggle', on: true, why: 'gmConfigUI::InitOptions SetDefaultValue(1) (Render_BuildingDetailTextures)' },
    { key: 'landscapeTextureDetail', kind: 'menu', label: 'Medium', why: 'Render_LandscapeTextureDetail SetDefaultValue(2) = Medium' },
    { key: 'environmentTextureDetail', kind: 'menu', label: 'High', why: 'Render_EnvironmentTextureDetail SetDefaultValue(1) = High' },
    { key: 'landscapeDetailTextures', kind: 'toggle', on: false, optional: true, why: 'the classic eras\' Landscape Detail Textures row starts off (webac#23)' },
  ];
}

/** One Config row as the page drew it (OPTION_ROWS_JS). */
export interface OptionRowSeen {
  key: string;
  present: boolean;
  kind?: 'toggle' | 'menu';
  /** The element under the row's control is the row's own (nothing covers it). */
  visible?: boolean;
  /** A toggle's data-option-on. */
  on?: boolean;
  /** A toggle bullet's drawn art: the ON circle 0x06004d17, the OFF one 0x06004d15, or neither. */
  art?: 'on' | 'off' | 'other' | 'none';
  /** A menu plate's drawn label (data-option-value). */
  value?: string | null;
}

/** Problems with the rows against the era's defaults; empty = they match. */
export function judgeOptionDefaults(want: OptionExpectation[], seen: OptionRowSeen[]): string[] {
  const out: string[] = [];
  for (const w of want) {
    const r = seen.find((s) => s.key === w.key);
    if (!r || !r.present) { if (!w.optional) out.push(`${w.key}: no row on the Config page`); continue; }
    if (r.visible === false) out.push(`${w.key}: the row is covered (the element under it is not the row's)`);
    if (w.kind === 'toggle') {
      if (r.on !== w.on) out.push(`${w.key}: ${r.on ? 'on' : 'off'}, the era's default is ${w.on ? 'on' : 'off'} (${w.why})`);
      const want2 = w.on ? 'on' : 'off';
      if (r.art && r.art !== 'none' && r.art !== want2) out.push(`${w.key}: the bullet draws the ${r.art} art, not ${want2}`);
    } else if ((r.value ?? '').trim().toLowerCase() !== (w.label ?? '').toLowerCase()) {
      out.push(`${w.key}: shows "${r.value ?? '(nothing)'}", the era's default is "${w.label}" (${w.why})`);
    }
  }
  return out;
}

// ── The pack grid ──────────────────────────────────────────────────────────

/** One grid cell as drawn: its index in the grid, the object in it (0 = empty), its box on the screen. */
export interface GridCell { i: number; guid: number; rect: Rect; structureFill?: number | null; structureShown?: boolean; covered?: boolean }

/** The open pack's grid (GRID_JS): its scroll state, viewport box, the scrollbar's buttons and every cell. */
export interface GridState {
  cols: number;
  /** One row in CSS px of the list (32). */
  rowPx: number;
  clientHeight: number;
  scrollTop: number;
  maxScroll: number;
  viewport: Rect;
  down: Rect | null;
  up: Rect | null;
  cells: GridCell[];
  /** The grid index of the cell under the middle of the viewport's bottom row (elementFromPoint), or -1. */
  bottomHit: number;
}

export const rowOf = (index: number, cols: number): number => Math.floor(index / cols);

/** The rows the list shows whole. */
export const visibleRowsOf = (clientHeight: number, rowPx: number): number => Math.max(1, Math.floor(clientHeight / rowPx));

/**
 * Items to add before the scroll check means anything: the last item must sit two rows past the viewport, so
 * scrolling to it moves the list by two rows or more.
 */
export function fillNeeded(occupied: number, visibleRows: number, cols: number): number {
  return Math.max(0, (visibleRows + 1) * cols + 1 - occupied);
}

/** The scrollTop that puts the row holding `lastIndex` at the bottom of the viewport. */
export function scrollTargetFor(lastIndex: number, cols: number, rowPx: number, clientHeight: number, maxScroll: number): number {
  const want = (rowOf(lastIndex, cols) + 1) * rowPx - clientHeight;
  return Math.max(0, Math.min(maxScroll, Math.ceil(want / rowPx) * rowPx));
}

/** The grid row the viewport's bottom row shows at `scrollTop`. */
export const bottomRowAt = (scrollTop: number, clientHeight: number, rowPx: number): number =>
  Math.floor((scrollTop + clientHeight - rowPx / 2) / rowPx);

/**
 * The drag the scroll check makes: an item in the viewport's bottom row onto another item fully in view (a move
 * to that item's place, the "sort"). Null when the bottom row holds no item or nothing else is in view.
 */
export function pickDragPair(g: Pick<GridState, 'cells' | 'viewport' | 'cols' | 'scrollTop' | 'clientHeight' | 'rowPx'>): { from: GridCell; to: GridCell } | null {
  const inView = g.cells.filter((c) => c.guid && rectInside(c.rect, g.viewport));
  const bottom = bottomRowAt(g.scrollTop, g.clientHeight, g.rowPx);
  const from = [...inView].reverse().find((c) => rowOf(c.i, g.cols) === bottom);
  if (!from) return null;
  // Prefer a target in the row above (the move stays in the scrolled part of the list), else any other in view.
  const to = inView.find((c) => c.guid !== from.guid && rowOf(c.i, g.cols) === bottom - 1)
    ?? [...inView].reverse().find((c) => c.guid !== from.guid);
  return to ? { from, to } : null;
}

/** Problems after the drag: it must have moved the item, kept the scroll offset and the rows on screen. */
export function judgeScrollKept(before: GridState, after: GridState, moved: number): string[] {
  const out: string[] = [];
  const at = (g: GridState): number => g.cells.find((c) => c.guid === moved)?.i ?? -1;
  if (at(after) === at(before)) out.push(`the drag moved nothing (the item is still in cell ${at(before)}): the scroll check can't be judged`);
  if (Math.abs(after.scrollTop - before.scrollTop) >= before.rowPx) {
    out.push(`the scroll offset went from ${before.scrollTop} px to ${after.scrollTop} px (webac#27: a move scrolled the pack)`);
  }
  const wantRow = bottomRowAt(before.scrollTop, before.clientHeight, before.rowPx);
  const gotRow = after.bottomHit < 0 ? -1 : rowOf(after.bottomHit, after.cols);
  if (gotRow !== wantRow) out.push(`the viewport's bottom row shows grid row ${gotRow} (by elementFromPoint), not row ${wantRow} as before the drag`);
  return out;
}

// ── Icon meters ────────────────────────────────────────────────────────────

/** A drawn icon meter: the bar's box and its fill's height (MeterSeen from METER_JS). */
export interface MeterSeen { shown: boolean; barH: number; fillH: number; covered: boolean }

/** Problems with a meter against the fraction the client should draw (null = hidden). */
export function judgeMeter(what: string, seen: MeterSeen | null, want: number | null): string[] {
  if (want === null) return seen?.shown ? [`${what}: a bar is drawn where none should be`] : [];
  if (!seen || !seen.shown) return [`${what}: no bar drawn (it should show ${Math.round(want * 100)}%)`];
  const out: string[] = [];
  const got = seen.barH > 0 ? seen.fillH / seen.barH : 0;
  // The meter rounds its fill to whole CSS pixels of a 30 px bar (buildIconMeterEl).
  if (Math.abs(got - want) > 1.5 / 30 + 0.01) out.push(`${what}: the fill shows ${Math.round(got * 100)}%, it should show ${Math.round(want * 100)}%`);
  if (seen.covered) out.push(`${what}: something else is drawn over the cell (elementFromPoint)`);
  return out;
}

export { capacityBarFraction, structureBarFraction };

// ── The running jump ───────────────────────────────────────────────────────

/** One rAF sample of the player (acDebug.collisionState): ms, the horizontal position in metres, on the ground. */
export interface MoveSample { t: number; x: number; z: number; g: boolean }

/** calc_friction @ 0050ee70 decays the landing velocity to a stop over v / ln 20 m (docs/movement-ab.md). */
export const RETAIL_COAST_PER_MPS = 1 / Math.log(20);

export interface CoastResult {
  /** Horizontal speed at touchdown (m/s). */
  landingSpeed: number;
  /** Metres from touchdown to rest. */
  coast: number;
  /** What retail coasts at that speed (m). */
  expected: number;
  /** ms from touchdown to rest. */
  settleMs: number;
}

/**
 * The coast after a running jump's landing, from the samples: the first airborne stretch after `fromT`, its
 * touchdown, the speed over the last 120 ms before it, and the distance to where the body came to rest (no more
 * than 2 cm moved in 250 ms). A string says why it can't be measured.
 */
export function coastFromSamples(samples: MoveSample[], fromT = -Infinity): CoastResult | string {
  const s = samples.filter((p) => p.t >= fromT);
  for (let i = 1; i < s.length; i++) {
    if (Math.hypot(s[i].x - s[i - 1].x, s[i].z - s[i - 1].z) > 3) return 'the position jumped more than 3 m between frames (a landblock re-centre?): run it again';
  }
  const up = s.findIndex((p) => !p.g);
  if (up < 0) return 'the character never left the ground (no jump)';
  const down = s.findIndex((p, i) => i > up && p.g);
  if (down < 0) return 'the character never landed in the samples';
  const land = s[down];
  const back = s.filter((p) => p.t >= land.t - 120 && p.t <= land.t);
  const first = back[0] ?? s[down - 1];
  const dt = (land.t - first.t) / 1000;
  const landingSpeed = dt > 0 ? Math.hypot(land.x - first.x, land.z - first.z) / dt : 0;
  let rest = -1;
  for (let i = down; i < s.length; i++) {
    const later = s.find((p) => p.t >= s[i].t + 250);
    if (!later) break;
    if (Math.hypot(later.x - s[i].x, later.z - s[i].z) <= 0.02) { rest = i; break; }
  }
  if (rest < 0) return 'the character never came to rest after landing (still moving at the end of the samples)';
  return {
    landingSpeed,
    coast: Math.hypot(s[rest].x - land.x, s[rest].z - land.z),
    expected: landingSpeed * RETAIL_COAST_PER_MPS,
    settleMs: s[rest].t - land.t,
  };
}

/** The coast against retail's: under half of it (or under 0.3 m) is the dead stop; over twice it plus a metre means the run went on. */
export function judgeCoast(c: CoastResult): string[] {
  if (c.landingSpeed < 2) return [`the landing speed was ${c.landingSpeed.toFixed(2)} m/s: not a running jump`];
  if (c.coast < Math.max(0.3, 0.5 * c.expected)) {
    return [`coasted ${c.coast.toFixed(2)} m after landing at ${c.landingSpeed.toFixed(2)} m/s; retail coasts ${c.expected.toFixed(2)} m (v / ln 20): a dead stop (BUG.remote-running-jump-snapback)`];
  }
  if (c.coast > 2 * c.expected + 1) return [`coasted ${c.coast.toFixed(2)} m, far past retail's ${c.expected.toFixed(2)} m: the run went on after W was let go`];
  return [];
}

// ── The Create Character click ────────────────────────────────────────────

/** One poll after the click: ms since it, the screen, Please Wait visible. */
export interface ChargenPoll { t: number; screen: string; waiting: boolean }

/** A click grace (ms) before Please Wait must show: the click's own frame. */
export const CHARGEN_CLICK_GRACE_MS = 600;

/** Chargen opened, with Please Wait up every poll until then (after the grace); else what went wrong. */
export function judgeChargenWait(polls: ChargenPoll[]): { ok: boolean; detail: string } {
  const opened = polls.find((p) => p.screen === 'character-create');
  const lost = polls.find((p) => p.t > CHARGEN_CLICK_GRACE_MS && p.screen !== 'character-create' && !p.waiting && (!opened || p.t < opened.t));
  if (lost) return { ok: false, detail: `${(lost.t / 1000).toFixed(1)} s after the click neither chargen nor Please Wait was showing (screen ${lost.screen}): the click was lost` };
  if (!opened) return { ok: false, detail: `chargen never opened in ${((polls.at(-1)?.t ?? 0) / 1000).toFixed(0)} s (Please Wait stayed up)` };
  const waited = polls.some((p) => p.waiting);
  return { ok: true, detail: `chargen opened ${(opened.t / 1000).toFixed(1)} s after the click${waited ? ', behind Please Wait until then' : ' (no wait: its art was in)'}` };
}

// ── Page-side readers ──────────────────────────────────────────────────────

/** A node's box as a Rect (page-side). */
const RECT_FN = `const R = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };`;

/** What a meter element draws, and whether the cell under it is the topmost thing there (page-side helper). */
const METER_FN = `const M = (cell, sel) => { if (!cell) return null; const bar = cell.querySelector(sel);
  if (!bar) return { shown: false, barH: 0, fillH: 0, covered: false };
  const b = bar.getBoundingClientRect(); const f = bar.firstElementChild ? bar.firstElementChild.getBoundingClientRect() : { height: 0 };
  const cs = getComputedStyle(bar); const shown = cs.display !== 'none' && cs.visibility !== 'hidden' && b.width > 0 && b.height > 0;
  const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
  return { shown, barH: b.height, fillH: f.height, covered: !hit || !cell.contains(hit) }; };`;

/** The open pack's grid as drawn (GridState), or null when the inventory isn't open or the pack holds nothing. */
export const GRID_JS = `(() => { ${RECT_FN}
  const ui = window.__ac && window.__ac.gameUI; if (!ui || !ui.inventoryVisible) return null;
  const any = document.querySelector('[data-inv-slot]'); if (!any) return null;
  const vp = any.closest('.layout-scroll-content'); if (!vp || !vp.firstElementChild) return null;
  const bar = vp.nextElementSibling && vp.nextElementSibling.dataset && vp.nextElementSibling.dataset.datScrollbar ? vp.nextElementSibling : null;
  const cells = [...vp.firstElementChild.children].map((c, i) => ({ i, guid: Number(c.dataset.acSelGuid || 0) >>> 0, rect: R(c) }));
  const vr = R(vp); const rowScreen = vr.h / Math.max(1, vp.clientHeight) * 32;
  const hit = document.elementFromPoint(vr.x + Math.min(16, vr.w / 2), vr.y + vr.h - rowScreen / 2);
  let bottomHit = -1; if (hit) { const cell = [...vp.firstElementChild.children].find((c) => c === hit || c.contains(hit)); if (cell) bottomHit = [...vp.firstElementChild.children].indexOf(cell); }
  const btn = (k) => bar ? R(bar.querySelector('[data-dat-scroll-btn="' + k + '"]')) : null;
  return { cols: 6, rowPx: 32, clientHeight: vp.clientHeight, scrollTop: vp.scrollTop, maxScroll: Math.max(0, vp.scrollHeight - vp.clientHeight),
    viewport: vr, down: btn('down'), up: btn('up'), cells, bottomHit };
})()`;

/** The carried items and packs (GameUI's own lists), for picking what a step works with. */
export interface HeldItem {
  guid: number; name: string; wcid: number; container: number; structure?: number; maxStructure?: number; itemsCapacity?: number; itemType: number; validLocations: number;
  /** ITEM_USEABLE, the combat use and the pwd bitfield: what the 1999 shortcut tray reads (shortcutDropRefusal1999). */
  usable?: number; combatUse?: number; objectDescFlags?: number;
}
export interface HeldState { packs: number[]; items: HeldItem[]; equipped: HeldItem[]; mainCapacity: number; selectedPack: number; open: boolean }
export const HELD_JS = `(() => { const ui = window.__ac && window.__ac.gameUI; if (!ui) return null;
  const m = (i) => ({ guid: i.id >>> 0, name: i.name, wcid: i.weenieClassId, container: (i.containerId || 0) >>> 0, structure: i.structure, maxStructure: i.maxStructure,
    itemsCapacity: i.itemsCapacity, itemType: (i.itemType || 0) >>> 0, validLocations: ((i.validLocations || 0) | (i.slot || 0)) >>> 0,
    usable: i.usable, combatUse: i.combatUse, objectDescFlags: i.objectDescFlags });
  return { packs: (ui.sidePackGuids || []).map((g) => g >>> 0), items: (ui.inventoryItems || []).map(m), equipped: (ui.equippedItems || []).map(m),
    mainCapacity: ui.inventoryItemsCapacity, selectedPack: ui.selectedPackSlot, open: !!ui.inventoryVisible }; })()`;

/** An element's box by selector (the first one drawn with a size), or null. */
export const boxJs = (selector: string): string => `(() => { ${RECT_FN}
  const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; });
  return el ? R(el) : null; })()`;

/** The pack-column cell of a pack (its UIItem inset, data-ac-sel-guid) and its fullness meter. */
export const packCellJs = (guid: number): string => `(() => { ${RECT_FN} ${METER_FN}
  const cells = [...document.querySelectorAll('[data-ac-sel-guid="${guid >>> 0}"]')].filter((c) => !c.closest('.layout-scroll-content') && !c.closest('[data-item-shortcut]'));
  const cell = cells.find((c) => c.getBoundingClientRect().width > 0) || null;
  return cell ? { rect: R(cell), meter: M(cell, '[data-capacity-bar]') } : null; })()`;

/** The drawn icon of a UIItem element: its rendered icon's background image (page-side helper). */
const ICON_FN = `const I = (el) => { const ic = el && el.querySelector('[data-ac-rendered-icon]'); return ic && ic.style.backgroundImage ? ic.style.backgroundImage : null; };`;

/** A grid cell of an item, its uses meter and its drawn icon, or null when it isn't drawn. */
export const itemCellJs = (guid: number): string => `(() => { ${RECT_FN} ${METER_FN} ${ICON_FN}
  const cell = [...document.querySelectorAll('[data-inv-slot][data-ac-sel-guid="${guid >>> 0}"]')].find((c) => c.getBoundingClientRect().width > 0) || null;
  return cell ? { rect: R(cell), meter: M(cell, '[data-structure-bar]'), icon: I(cell) } : null; })()`;

/** A toolbar shortcut slot: its box, whether it draws an item, its drawn icon, its uses meter, and what object the bar holds there. */
export const shortcutSlotJs = (index: number): string => `(() => { ${RECT_FN} ${METER_FN} ${ICON_FN}
  const slot = document.querySelector('[data-item-shortcut="${index}"]'); if (!slot) return null;
  const objects = window.acDebug && window.acDebug.toolbarShortcuts ? window.acDebug.toolbarShortcuts() : [];
  const r = R(slot); const hit = r && r.w > 0 ? document.elementFromPoint(r.x + r.w / 2, r.y + r.h / 2) : null;
  return { rect: r, drawsItem: slot.childElementCount > 0, icon: I(slot), covered: !hit || !slot.contains(hit), object: (objects[${index}] || 0) >>> 0,
    meter: M(slot, '[data-structure-bar]') }; })()`;

/** The Config rows of these keys as drawn (OptionRowSeen[]), each scrolled into the list's view first. */
export const optionRowsJs = (keys: string[]): string => `(() => {
  const ui = window.__ac && window.__ac.gameUI; const panel = ui && ui.optionsPanel; if (!panel) return null;
  const url = (t) => { try { return ui.getTexURL ? ui.getTexURL(t) : null; } catch (e) { return null; } };
  const onUrl = url(0x06004d17), offUrl = url(0x06004d15);
  return ${JSON.stringify(keys)}.map((key) => {
    const row = panel.querySelector('[data-option-key="' + key + '"]'); if (!row) return { key, present: false };
    row.scrollIntoView({ block: 'center' });
    const menu = row.dataset.optionRow === 'menu';
    const probe = (menu ? row.querySelector('.options-menu-field') : row.firstElementChild) || row;
    const b = probe.getBoundingClientRect(); const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
    const bg = !menu && row.firstElementChild ? (row.firstElementChild.style.backgroundImage || '') : '';
    return { key, present: true, kind: menu ? 'menu' : 'toggle', visible: !!hit && row.contains(hit), on: row.dataset.optionOn === '1',
      art: !bg ? 'none' : (onUrl && bg.includes(onUrl)) ? 'on' : (offUrl && bg.includes(offUrl)) ? 'off' : 'other', value: row.dataset.optionValue == null ? null : row.dataset.optionValue };
  }); })()`;

/** Start sampling the player every frame for `ms` (window.__ptMove), as MoveSample rows. */
export const startMoveSamplerJs = (ms: number): string => `(() => { const out = []; window.__ptMove = out; const end = performance.now() + ${ms};
  const tick = () => { const c = window.acDebug && window.acDebug.collisionState ? window.acDebug.collisionState() : null;
    if (c) out.push({ t: performance.now(), x: c.x, z: c.z, g: !!c.onGround }); if (performance.now() < end && window.__ptMove === out) requestAnimationFrame(tick); };
  requestAnimationFrame(tick); return true; })()`;

// ── Step helpers ───────────────────────────────────────────────────────────

const msg = (r: AgentResult | null | undefined): string => (r?.message ?? '').split('\n').map((l) => l.trim()).filter(Boolean).join(' / ').slice(0, 300);
const shots = async (ctx: StepContext, ...names: string[]): Promise<string[]> => (await Promise.all(names.map((n) => ctx.driver.screenshot(n)))).filter((p): p is string => !!p);
const held = (ctx: StepContext): Promise<HeldState | null> => ctx.driver.evaluate<HeldState | null>(HELD_JS);
const grid = (ctx: StepContext): Promise<GridState | null> => ctx.driver.evaluate<GridState | null>(GRID_JS);
const box = (ctx: StepContext, selector: string): Promise<Rect | null> => ctx.driver.evaluate<Rect | null>(boxJs(selector));

/** The options a regression step takes from the run. */
export interface RegressionOptions {
  /** --admin: a step may spawn what it needs with the era's admin commands. */
  admin?: boolean;
  /**
   * --keep-spawned: leave what the steps spawned on the character (the live gate's AC1999 screen-account prep wants
   * its filled side pack and used kit kept). Otherwise every step drops what it spawned before it ends.
   */
  keepSpawned?: boolean;
}

/** What the running step spawned (spawnHeld adds to it; leavesNoTrace drops it afterwards). */
const SPAWNED = new WeakMap<StepContext['state'], number[]>();

/** Type admin spawns into the chat box and wait for the objects; the new guids (fewer when some never came). */
export async function spawnHeld(ctx: StepContext, wcid: number, count: number): Promise<number[]> {
  const cmds = ADMIN_COMMANDS[ctx.era.key];
  if (!cmds || count <= 0) return [];
  const h0 = await held(ctx);
  const before = new Set([...(h0?.items ?? []), ...(h0?.equipped ?? [])].map((i) => i.guid));
  for (let i = 0; i < count; i++) { await ctx.driver.chat(cmds.spawn(wcid)); await ctx.driver.sleep(400); }
  let got: number[] = [];
  for (let i = 0; i < 30; i++) {
    const h = await held(ctx);
    got = (h?.items ?? []).filter((it) => it.wcid === wcid && !before.has(it.guid)).map((it) => it.guid);
    if (got.length >= count) break;
    await ctx.driver.sleep(500);
  }
  SPAWNED.get(ctx.state)?.push(...got);
  return got;
}

/**
 * Drop what a step spawned (taking off anything worn first): each step leaves the character as it found it, so no
 * step's outcome depends on what an earlier one left behind (fast run 2, 2026-11-07: thirty spawned lockpicks and the
 * admin components left ClassicACE's pack too full for the vendor steps). A side pack drops with what is in it.
 * Returns what could not be dropped.
 */
export async function dropSpawned(ctx: StepContext, guids: number[]): Promise<string[]> {
  const { driver } = ctx;
  const left: string[] = [];
  const h = await held(ctx);
  const sidePacks = new Set((h?.packs ?? []).slice(1)); // packs[0] is the main pack
  const spawned = new Set(guids);
  // A spawned side pack: what the character put in it goes back to the main pack first; the rest drops with it.
  for (const p of guids.filter((g) => sidePacks.has(g))) {
    for (const i of (h?.items ?? []).filter((x) => x.container === p && !spawned.has(x.guid))) {
      await driver.call<AgentResult>('moveItem', [i.guid, 0], 30_000).catch(() => null);
    }
  }
  const insideSpawnedPack = new Set((h?.items ?? []).filter((i) => spawned.has(i.container)).map((i) => i.guid));
  for (const g of guids) {
    if (insideSpawnedPack.has(g)) continue; // goes with its pack
    const now = await held(ctx);
    const worn = (now?.equipped ?? []).find((i) => i.guid === g);
    const item = worn ?? (now?.items ?? []).find((i) => i.guid === g);
    if (!item && !(now?.packs ?? []).includes(g)) continue; // used up, merged or already gone
    if (worn) await driver.call<AgentResult>('unequip', [g], 30_000).catch(() => null);
    const r = await driver.call<AgentResult>('drop', [g], 30_000).catch((e: Error) => ({ ok: false, message: e.message } as AgentResult));
    if (!r.ok) left.push(`${item?.name ?? `#${g.toString(16)}`}: ${msg(r)}`);
  }
  return left;
}

/** A step that drops what it spawned before it ends (unless --keep-spawned). */
export function leavesNoTrace(step: Step, opts: RegressionOptions = {}): Step {
  return {
    ...step,
    async run(ctx) {
      const mine: number[] = [];
      SPAWNED.set(ctx.state, mine);
      let out: StepOutcome;
      try { out = await step.run(ctx); } finally { SPAWNED.delete(ctx.state); }
      if (!mine.length || opts.keepSpawned) return out;
      const left = await dropSpawned(ctx, mine);
      const note = left.length ? `; left behind (could not drop): ${left.join(', ')}` : `; dropped the ${mine.length} item(s) it spawned`;
      return { ...out, detail: `${out.detail}${note}`, allow: [...(out.allow ?? []), /drop|dropped/i] };
    },
  };
}

// ── Free pack slots before the vendor and loot steps ───────────────────────

/** Main-pack slots the vendor, supplies and loot steps need free. */
export const PACK_SPACE_WANTED = 15;

/** The main pack's free slots (side packs and what is in them don't count against it). */
export function mainPackFree(h: Pick<HeldState, 'packs' | 'items' | 'mainCapacity'>): number {
  const main = h.packs[0];
  const packs = new Set(h.packs);
  const inMain = h.items.filter((i) => i.container === main && !packs.has(i.guid)).length;
  return Math.max(0, (h.mainCapacity ?? 0) - inMain);
}

/**
 * Right after entering the world: free main-pack slots, dropping regression filler an earlier run left (the Crude
 * Lockpicks pack-scroll-sort spawns) until PACK_SPACE_WANTED are free. Its own drops only; anything else stays.
 */
export function packSpaceStep(): Step {
  return {
    id: 'pack-space', title: `Free main-pack slots for the vendor and loot steps (${PACK_SPACE_WANTED} wanted)`, timeoutMs: 180_000, withOnly: true,
    async run(ctx) {
      const h = await held(ctx);
      if (!h || !h.mainCapacity) return skip('the client lists no main pack capacity');
      let free = mainPackFree(h);
      if (free >= PACK_SPACE_WANTED) return ok(`${free} of ${h.mainCapacity} main-pack slots free`);
      const filler = h.items.filter((i) => i.wcid === REGRESSION_WCIDS.filler && i.container === h.packs[0]).map((i) => i.guid);
      const want = Math.min(filler.length, PACK_SPACE_WANTED - free);
      const left = await dropSpawned(ctx, filler.slice(0, want));
      const after = await held(ctx);
      free = after ? mainPackFree(after) : free;
      const what = `dropped ${want - left.length} leftover Crude Lockpick(s) from earlier runs; ${free} of ${h.mainCapacity} main-pack slots free`;
      if (free >= PACK_SPACE_WANTED) return ok(what, { allow: [/drop|dropped/i] });
      return fail(`${what}, ${PACK_SPACE_WANTED} wanted: the pack is full of the character's own things (or the drops failed: ${left.join(', ') || 'none'})`, { allow: [/drop|dropped/i] });
    },
  };
}

/** Open the inventory with the real mouse on its toolbar button (no-op when open). */
async function openInventory(ctx: StepContext): Promise<boolean> {
  if ((await held(ctx))?.open) return true;
  const b = await box(ctx, '#tb-inv');
  if (b) await ctx.driver.click(centerOf(b));
  else await ctx.driver.call('press', ['Show/Hide Inventory Panel']);
  await ctx.driver.sleep(900);
  return !!(await held(ctx))?.open;
}

/** Show a pack's contents in the grid by clicking its pack-column cell (slot 0 = the main pack). */
async function showPack(ctx: StepContext, slot: number): Promise<boolean> {
  const h = await held(ctx);
  if (!h) return false;
  if (h.selectedPack === slot) return true;
  const guid = h.packs[slot];
  if (!guid) return false;
  const cell = await ctx.driver.evaluate<{ rect: Rect } | null>(packCellJs(guid));
  if (!cell) return false;
  await ctx.driver.click(centerOf(cell.rect));
  await ctx.driver.sleep(700);
  return (await held(ctx))?.selectedPack === slot;
}

/** Click the grid's DAT scrollbar button (`down` / `up`) until scrollTop reaches `target` (or stops moving). */
async function scrollGridTo(ctx: StepContext, target: number): Promise<GridState | null> {
  let g = await grid(ctx);
  for (let i = 0; g && i < 150; i++) {
    if (Math.abs(g.scrollTop - target) < g.rowPx / 2) break;
    const btn = g.scrollTop < target ? g.down : g.up;
    if (!btn) break;
    await ctx.driver.click(centerOf(btn));
    await ctx.driver.sleep(60);
    const next = await grid(ctx);
    if (next && next.scrollTop === g.scrollTop) { g = next; break; }
    g = next;
  }
  return g;
}

/** Bring a grid cell into the viewport with the scrollbar, as a player would. */
async function scrollCellIntoView(ctx: StepContext, guid: number): Promise<boolean> {
  const g = await grid(ctx);
  const c = g?.cells.find((x) => x.guid === guid);
  if (!g || !c) return false;
  if (rectInside(c.rect, g.viewport)) return true;
  const row = rowOf(c.i, g.cols);
  const target = Math.max(0, Math.min(g.maxScroll, row * g.rowPx - Math.max(0, g.clientHeight - g.rowPx) / 2));
  const after = await scrollGridTo(ctx, Math.round(target / g.rowPx) * g.rowPx);
  const c2 = after?.cells.find((x) => x.guid === guid);
  return !!after && !!c2 && rectInside(c2.rect, after.viewport);
}

/** Log out to character select and enter again as the run's character. */
export async function relog(ctx: StepContext): Promise<{ ok: boolean; detail: string; screenshots: string[] }> {
  const { driver } = ctx;
  const name = ctx.state.character;
  if (!name) return { ok: false, detail: 'no character name to enter with', screenshots: [] };
  await driver.call('logout');
  let p = await driver.probe();
  for (let i = 0; i < 120 && p.screen !== 'character-select'; i++) { await driver.sleep(500); p = await driver.probe(); }
  if (p.screen !== 'character-select') return { ok: false, detail: `not at character select 60 s after logging out (screen ${p.screen})`, screenshots: await shots(ctx, 'relog-stuck') };
  const r = await driver.call<AgentResult>('enterWorld', [name], 120_000);
  if (!r.ok) return { ok: false, detail: `entering again as ${name}: ${msg(r)}`, screenshots: [] };
  for (let i = 0; i < 40 && (await driver.probe()).screen !== 'world'; i++) await driver.sleep(500);
  await driver.sleep(4000);
  return { ok: true, detail: `relogged as ${name}`, screenshots: [] };
}

// ── Steps ──────────────────────────────────────────────────────────────────

export function optionDefaultsStep(): Step {
  return {
    id: 'option-defaults', title: 'A fresh profile shows the era\'s option defaults (Config page)', timeoutMs: 60_000,
    async run(ctx) {
      const { driver } = ctx;
      if (!driver.freshProfile) return skip('the run reuses a browser profile (--profile): its options are whatever it saved, not the defaults');
      const want = optionDefaultsFor(ctx.era);
      await driver.call('close', ['all']);
      await driver.sleep(400);
      const tb = await box(ctx, '#tb-opt');
      if (tb) await driver.click(centerOf(tb));
      else await driver.call('press', ['Show/Hide Options Panel']);
      await driver.sleep(900);
      if (!(await driver.uiState())?.optionsPanelVisible) return fail('the Options panel did not open', { screenshots: await shots(ctx, 'options-not-open') });
      const tab = await box(ctx, '[data-options-tab="config"]');
      if (!tab) return fail('the Options panel has no Config tab', { screenshots: await shots(ctx, 'options-no-config') });
      await driver.click(centerOf(tab));
      await driver.sleep(900);
      const seen = await driver.evaluate<OptionRowSeen[] | null>(optionRowsJs(want.map((w) => w.key)));
      const screenshots = await shots(ctx, 'option-defaults');
      if (tb) await driver.click(centerOf(tb)); else await driver.call('close', ['all']);
      if (!seen) return fail('the Config page was not drawn', { screenshots });
      const problems = judgeOptionDefaults(want, seen);
      const said = seen.filter((s) => s.present).map((s) => `${s.key} ${s.kind === 'menu' ? `"${s.value}"` : s.on ? 'on' : 'off'}`).join(', ');
      return problems.length ? fail(problems.join('; '), { screenshots }) : ok(`as the era's client starts: ${said}`, { screenshots });
    },
  };
}

export function packScrollSortStep(opts: RegressionOptions = {}): Step {
  return {
    id: 'pack-scroll-sort', title: 'Scroll the pack down, drag an item onto another: the scroll offset stays (webac#27)', timeoutMs: 240_000,
    async run(ctx) {
      const { driver } = ctx;
      await driver.call('close', ['all']);
      if (!(await openInventory(ctx))) return fail('the inventory did not open', { screenshots: await shots(ctx, 'inventory-not-open') });
      if (!(await showPack(ctx, 0))) return fail('could not show the main pack in the grid');
      let g = await grid(ctx);
      if (!g) return skip('the main pack holds nothing to drag');
      const visibleRows = visibleRowsOf(g.clientHeight, g.rowPx);
      const occupied = g.cells.filter((c) => c.guid).length;
      const need = fillNeeded(occupied, visibleRows, g.cols);
      let spawned = '';
      if (need > 0) {
        if (!opts.admin) return skip(`the main pack holds ${occupied} items; ${need} more are needed to scroll two rows past its ${visibleRows} visible rows (run with --admin to spawn them)`);
        const got = await spawnHeld(ctx, REGRESSION_WCIDS.filler, need);
        spawned = `spawned ${got.length} of ${need} fillers (wcid ${REGRESSION_WCIDS.filler}); `;
        await driver.sleep(1000);
        g = await grid(ctx);
        if (!g) return fail(`${spawned}and the grid is gone`, { allow: [ADMIN_CHATTER] });
      }
      const last = Math.max(...g.cells.filter((c) => c.guid).map((c) => c.i));
      const target = scrollTargetFor(last, g.cols, g.rowPx, g.clientHeight, g.maxScroll);
      if (target < g.rowPx) return skip(`${spawned}the last item is in row ${rowOf(last, g.cols) + 1}: the list needn't scroll to show it`, { allow: [ADMIN_CHATTER] });
      const before = await scrollGridTo(ctx, target);
      if (!before || Math.abs(before.scrollTop - target) >= before.rowPx) {
        return fail(`${spawned}the DAT scrollbar's down button did not scroll the grid to ${target} px (at ${before?.scrollTop ?? '?'} px)`, { screenshots: await shots(ctx, 'pack-not-scrolled'), allow: [ADMIN_CHATTER] });
      }
      const pair = pickDragPair(before);
      if (!pair) return skip(`${spawned}no item in the bottom row to drag onto another in view`, { allow: [ADMIN_CHATTER] });
      const screenshots = await shots(ctx, 'pack-scrolled');
      await driver.drag(centerOf(pair.from.rect), centerOf(pair.to.rect));
      await settle(driver, 10_000);
      await driver.sleep(1500);
      const after = await grid(ctx);
      screenshots.push(...await shots(ctx, 'pack-after-drag'));
      if (!after) return fail(`${spawned}the grid is gone after the drag`, { screenshots, allow: [ADMIN_CHATTER] });
      const problems = judgeScrollKept(before, after, pair.from.guid);
      const what = `${spawned}scrolled to ${before.scrollTop} px with the down button (bottom row ${bottomRowAt(before.scrollTop, before.clientHeight, before.rowPx) + 1}), dragged cell ${pair.from.i} onto cell ${pair.to.i}`;
      return problems.length ? fail(`${what}: ${problems.join('; ')}`, { screenshots, allow: [ADMIN_CHATTER] })
        : ok(`${what}; the grid stayed at ${after.scrollTop} px with the same rows on screen`, { screenshots, allow: [ADMIN_CHATTER] });
    },
  };
}

/** A used kit or lockpick: structure below its max. */
/** An own item that may go into the side pack: not a pack, not wearable, not a kit or lockpick (usedTool's kinds). */
export const sidePackFiller = (i: Pick<HeldItem, 'itemType' | 'validLocations' | 'name' | 'maxStructure'>): boolean =>
  (i.itemType & 0x200) === 0 && (i.validLocations ?? 0) === 0 && !((i.maxStructure ?? 0) > 0) && !/kit|lockpick/i.test(i.name);

export const usedTool = (i: HeldItem): boolean => (i.maxStructure ?? 0) > 0 && (i.structure ?? 0) < (i.maxStructure ?? 0) && /kit|lockpick/i.test(i.name);

/** The toolbar slot the pack-bars step puts its kit on: the first empty of slots 2-9 (slot 1 is toolbar-relog's). */
export function freeShortcutSlot(objects: number[], holding: number): number {
  const has = objects.indexOf(holding);
  if (has >= 0) return has;
  for (let i = 1; i < 9; i++) if (!objects[i]) return i;
  return -1;
}

export function packBarsStep(opts: RegressionOptions = {}): Step {
  return {
    id: 'pack-bars', title: 'A side pack shows its fullness bar; a used kit its uses bar in the pack and on the toolbar (webac#25)', timeoutMs: 240_000,
    async run(ctx) {
      const { driver } = ctx;
      const notes: string[] = [];
      const problems: string[] = [];
      const skipped: string[] = [];
      await driver.call('close', ['all']);
      if (!(await openInventory(ctx))) return fail('the inventory did not open', { screenshots: await shots(ctx, 'inventory-not-open') });
      if (!(await showPack(ctx, 0))) return fail('could not show the main pack in the grid');
      // ── a side pack holding items ──
      let h = await held(ctx);
      const holding = (p: number): number => (h?.items ?? []).filter((i) => i.container === p).length;
      let pack = (h?.packs ?? []).slice(1).find((p) => holding(p) > 0) ?? 0;
      if (!pack && opts.admin) {
        let empty = (h?.packs ?? []).slice(1)[0] ?? 0;
        if (!empty) { empty = (await spawnHeld(ctx, REGRESSION_WCIDS.sack, 1))[0] ?? 0; await driver.sleep(1500); notes.push(empty ? 'spawned a Sack' : 'the Sack spawn brought nothing'); }
        h = await held(ctx);
        const slot = (h?.packs ?? []).indexOf(empty);
        // What goes in the side pack: filler (spawned for it when none is held), never a kit or a lockpick (the uses
        // bar below is checked on the kit in the main pack: fast run 4 moved the Handy Healing Kit into the Sack).
        let item = (h?.items ?? []).find((i) => i.container === h!.packs[0] && !h!.packs.includes(i.guid) && i.wcid === REGRESSION_WCIDS.filler);
        if (!item) {
          const g = (await spawnHeld(ctx, REGRESSION_WCIDS.filler, 1))[0];
          h = await held(ctx);
          item = (h?.items ?? []).find((i) => i.guid === g);
        }
        item ??= (h?.items ?? []).find((i) => i.container === h!.packs[0] && !h!.packs.includes(i.guid) && sidePackFiller(i));
        if (slot > 0 && item) {
          const r = await driver.call<AgentResult>('moveItem', [item.guid, slot], 30_000);
          await settle(driver, 10_000);
          notes.push(`moved ${item.name} into side pack ${slot}: ${msg(r)}`);
          h = await held(ctx);
          if (holding(empty) > 0) pack = empty;
        }
      }
      if (!pack) skipped.push(`no side pack holds an item${opts.admin ? ' (the spawn or the move failed)' : ' (run with --admin to spawn a Sack and fill it)'}`);
      else {
        const p = (h?.items ?? []).find((i) => i.guid === pack);
        const want = capacityBarFraction(p?.itemsCapacity, holding(pack));
        const cell = await driver.evaluate<{ rect: Rect; meter: MeterSeen | null } | null>(packCellJs(pack));
        if (!cell) problems.push(`the side pack ${p?.name ?? pack} has no cell in the pack column`);
        else problems.push(...judgeMeter(`side pack ${p?.name ?? ''} (${holding(pack)} of ${p?.itemsCapacity ?? '?'})`, cell.meter, want));
        notes.push(`side pack ${p?.name ?? pack}: ${holding(pack)} of ${p?.itemsCapacity ?? '?'} items`);
      }
      // ── a used kit ──
      h = await held(ctx);
      let kit = (h?.items ?? []).find(usedTool);
      if (!kit) {
        let full = (h?.items ?? []).find((i) => /healing kit/i.test(i.name) && (i.maxStructure ?? 0) > 0);
        if (!full && opts.admin) { const g = (await spawnHeld(ctx, REGRESSION_WCIDS.kit, 1))[0]; await driver.sleep(1000); h = await held(ctx); full = (h?.items ?? []).find((i) => i.guid === g); notes.push(full ? `spawned ${full.name}` : 'the kit spawn brought nothing'); }
        const me = await driver.call<{ health: { cur: number; max: number } } | null>('self');
        const cmds = ADMIN_COMMANDS[ctx.era.key];
        let lowered = false;
        if (full && me && me.health.cur >= me.health.max && opts.admin && cmds) {
          await driver.chat(cmds.setHealth(Math.max(1, Math.floor(me.health.max / 3)))); await driver.sleep(1500); notes.push('lowered health with the admin command');
          lowered = true;
        }
        if (full) {
          const r = await driver.call<AgentResult>('use', [full.guid, {}], 45_000);
          await settle(driver, 10_000);
          await driver.sleep(1500);
          notes.push(`used ${full.name}: ${msg(r)}`);
          h = await held(ctx);
          kit = (h?.items ?? []).find(usedTool);
        }
        // Back to full health: a character left hurt draws a different vitals bar in every later capture (the live
        // gate's first fast run, 2026-11-07: all five AC1999 screens differed in the health number alone).
        if (lowered && me && cmds) {
          await driver.chat(cmds.setHealth(me.health.max)); await driver.sleep(1500);
          notes.push(`health set back to ${me.health.max}`);
        }
      }
      const screenshots: string[] = [];
      if (!kit) skipped.push(`no used kit or lockpick held${opts.admin ? ' (the kit was not used up by one)' : ' (run use-healing-kit while hurt first, or --admin)'}`);
      else {
        const want = structureBarFraction(kit.structure, kit.maxStructure);
        // The grid shows the pack the kit is in (the main pack, or the side pack holding it).
        const kitSlot = Math.max(0, (h?.packs ?? []).indexOf(kit.container));
        if (!(await showPack(ctx, kitSlot))) problems.push(`could not show pack ${kitSlot} (${kit.name}'s container) in the grid`);
        else if (!(await scrollCellIntoView(ctx, kit.guid))) problems.push(`${kit.name}'s grid cell could not be scrolled into view`);
        else {
          const cell = await driver.evaluate<{ rect: Rect; meter: MeterSeen | null } | null>(itemCellJs(kit.guid));
          problems.push(...judgeMeter(`${kit.name} in the pack (${kit.structure}/${kit.maxStructure})`, cell?.meter ?? null, want));
          screenshots.push(...await shots(ctx, 'pack-bars-pack'));
          // The toolbar: the kit's shortcut, made by dragging its cell onto a free slot.
          const objects = await driver.evaluate<number[]>('(window.acDebug && window.acDebug.toolbarShortcuts ? window.acDebug.toolbarShortcuts() : []).map((g) => g >>> 0)');
          const slot = freeShortcutSlot(objects, kit.guid);
          if (slot < 0) skipped.push('no free toolbar slot (2-9) for the kit');
          else {
            if (objects[slot] !== kit.guid && cell) {
              const target = await driver.evaluate<{ rect: Rect } | null>(shortcutSlotJs(slot));
              if (target) { await driver.drag(centerOf(cell.rect), centerOf(target.rect)); await driver.sleep(2000); }
            }
            const s = await driver.evaluate<{ rect: Rect; drawsItem: boolean; covered: boolean; object: number; meter: MeterSeen | null } | null>(shortcutSlotJs(slot));
            if (!s || s.object !== kit.guid) problems.push(`dragging ${kit.name} onto toolbar slot ${slot + 1} made no shortcut (the slot holds ${s?.object ? `#${s.object.toString(16)}` : 'nothing'})`);
            else {
              if (!s.drawsItem) problems.push(`toolbar slot ${slot + 1} holds ${kit.name} but draws nothing`);
              problems.push(...judgeMeter(`${kit.name} on toolbar slot ${slot + 1}`, s.meter, want));
            }
            notes.push(`${kit.name} ${kit.structure}/${kit.maxStructure} on toolbar slot ${slot + 1}`);
          }
        }
      }
      screenshots.push(...await shots(ctx, 'pack-bars'));
      const allow = [ADMIN_CHATTER, /full|already|don't need|no need|not hurt|trained/i];
      const detail = [...notes, ...skipped.map((s) => `not checked: ${s}`)].join('; ');
      if (problems.length) return fail(`${problems.join('; ')} (${detail})`, { screenshots, allow });
      if (skipped.length === 2) return skip(detail, { screenshots, allow });
      return ok(detail, { screenshots, allow });
    },
  };
}

/**
 * The slot's object id is the bar's model, not what it draws: a slot can hold the right guid and draw another
 * item's icon (or a stale one). When both are drawn, the slot's icon must be the item's own pack-cell icon,
 * read at the same moment (the same rendered-icon cache). Null = fine or not judgeable (an icon still pending).
 */
export function judgeShortcutIcon(slotIcon: string | null | undefined, cellIcon: string | null | undefined, name: string): string | null {
  if (!slotIcon || !cellIcon) return null;
  return slotIcon === cellIcon ? null : `slot 1 holds ${name} but draws a different icon than ${name}'s own pack cell`;
}

type SlotSeen = { rect: Rect; object: number; drawsItem: boolean; covered: boolean; icon?: string | null };
type CellSeen = { rect: Rect; icon?: string | null };

/** The era's toolbar refusal for an item (null = it takes it): the 1999 tray's AcceptDragObject rule, none in other eras. */
export function shortcutTrayRefusal(era: string, it: Pick<HeldItem, 'usable' | 'combatUse' | 'validLocations' | 'itemType' | 'objectDescFlags'>): string | null {
  if (era !== 'ac1999-retail') return null;
  const flags = (it.objectDescFlags ?? 0) >>> 0;
  // A whole stack dragged (no partial split held): the split refusal is not the item's.
  return shortcutDropRefusal1999({ usable: it.usable, combatUse: it.combatUse, validLocations: it.validLocations, itemType: it.itemType, stuck: (flags & 0x4) !== 0, isPlayer: (flags & 0x8) !== 0 }, { splitSize: 1, maxSplitSize: 1 });
}

export function toolbarRelogStep(): Step {
  return {
    id: 'toolbar-relog', title: 'An item on toolbar slot 1 is still there after a relog', timeoutMs: 300_000,
    async run(ctx) {
      const { driver } = ctx;
      await driver.call('close', ['all']);
      if (!(await openInventory(ctx))) return fail('the inventory did not open');
      if (!(await showPack(ctx, 0))) return fail('could not show the main pack in the grid');
      const h = await held(ctx);
      const g = await grid(ctx);
      const inView = (g?.cells ?? []).filter((c) => c.guid && g && rectInside(c.rect, g.viewport));
      const isPack = (guid: number): boolean => !!h?.packs.includes(guid);
      // An item the era's tray takes: the 1999 ShortcutSlot::AcceptDragObject @ 0x00500240 refuses one that isn't usable,
      // wearable, a container or a caster ("Only usable items can go here": fast run 5's Calling Stone, ItemUseable No);
      // end of retail's gmToolbarUI takes any item.
      const takes = (guid: number): boolean => {
        const it = h?.items.find((i) => i.guid === guid);
        return !it || shortcutTrayRefusal(ctx.era.key, it) === null;
      };
      const pick = inView.find((c) => !isPack(c.guid) && takes(c.guid));
      if (!pick) return skip(`no item in view in the main pack that the ${ctx.era.label} toolbar takes`);
      const name = h?.items.find((i) => i.guid === pick.guid)?.name ?? `#${pick.guid.toString(16)}`;
      let slot = await driver.evaluate<{ rect: Rect; object: number } | null>(shortcutSlotJs(0));
      if (!slot) return skip('this era draws no item shortcut slots');
      // Slot 1 holding something else: drag it off to the 3D view first (that removes the shortcut).
      if (slot.object && slot.object !== pick.guid) {
        const vw = await driver.evaluate<{ w: number; h: number }>('({ w: innerWidth, h: innerHeight })');
        await driver.drag(centerOf(slot.rect), { x: vw.w / 2, y: vw.h * 0.3 });
        await driver.sleep(1500);
      }
      await driver.drag(centerOf(pick.rect), centerOf(slot.rect));
      await driver.sleep(2000);
      const s0 = await driver.evaluate<SlotSeen | null>(shortcutSlotJs(0));
      const cell0 = await driver.evaluate<CellSeen | null>(itemCellJs(pick.guid));
      const screenshots = await shots(ctx, 'toolbar-slot1');
      if (!s0 || s0.object !== pick.guid) return fail(`dragging ${name} onto slot 1 made no shortcut (slot 1 holds ${s0?.object ? `#${s0.object.toString(16)}` : 'nothing'})`, { screenshots });
      if (!s0.drawsItem || s0.covered) return fail(`slot 1 holds ${name} but ${s0.covered ? 'something covers it' : 'draws nothing'}`, { screenshots });
      const wrong0 = judgeShortcutIcon(s0.icon, cell0?.icon, name);
      if (wrong0) return fail(wrong0, { screenshots });
      const r = await relog(ctx);
      screenshots.push(...r.screenshots);
      if (!r.ok) return fail(r.detail, { screenshots });
      let s1: SlotSeen | null = null;
      for (let i = 0; i < 30; i++) {
        s1 = await driver.evaluate<SlotSeen | null>(shortcutSlotJs(0));
        if (s1?.object === pick.guid && s1.drawsItem) break;
        await driver.sleep(500);
      }
      screenshots.push(...await shots(ctx, 'toolbar-slot1-after-relog'));
      if (!s1 || s1.object !== pick.guid) return fail(`after the relog slot 1 holds ${s1?.object ? `#${s1.object.toString(16)}` : 'nothing'}, not ${name}`, { screenshots });
      if (!s1.drawsItem || s1.covered) return fail(`after the relog slot 1 holds ${name} but ${s1.covered ? 'something covers it' : 'draws nothing'}`, { screenshots });
      // The item's own cell, drawn now (the relog may have closed the inventory: open it to read the icon).
      if (await openInventory(ctx) && await showPack(ctx, 0)) {
        const s1b = await driver.evaluate<SlotSeen | null>(shortcutSlotJs(0));
        const wrong1 = judgeShortcutIcon(s1b?.icon, (await driver.evaluate<CellSeen | null>(itemCellJs(pick.guid)))?.icon, name);
        if (wrong1) return fail(`after the relog ${wrong1}`, { screenshots });
      }
      return ok(`${name} dragged onto slot 1; after the relog slot 1 still draws it`, { screenshots });
    },
  };
}

/** main.ts's attach line: `[Wield] Attached <name> (setup 0x…) to part_N (location=L, placement=P from CreateObject|ParentEvent, frame=F)`. */
export interface WieldLine {
  name: string;
  /** The placement requested (ParentEvent / CreateObject AnimationFrame / Resting). */
  placement: number;
  source: string;
  /** The placement frame the Setup actually used after SetPlacementFrame's fallback; null = identity, undefined = an older log without it. */
  frame?: number | null;
}
export function parseWieldLine(line: string): WieldLine | null {
  const m = /^\[Wield\] Attached (.+?)(?: \(setup 0x[0-9a-f]+\))? to part_\d+ \(location=[^,]*, placement=(\d+|undefined)(?: from (\w+))?(?:, frame=(\d+|identity|null))?\)/i.exec(line);
  if (!m || m[2] === 'undefined') return null;
  const w: WieldLine = { name: m[1], placement: Number(m[2]), source: m[3] ?? '' };
  if (m[4] !== undefined) w.frame = /^\d+$/.test(m[4]) ? Number(m[4]) : null;
  return w;
}

/** The last attach line for an item named `name` among `lines` (the player's own attach has no " to <creature>"). */
export function lastWield(lines: string[], name: string): WieldLine | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const w = parseWieldLine(lines[i]);
    if (w && w.name === name) return w;
  }
  return null;
}

/** EquipMask Shield (ACE EquipMask.cs 0x00200000). */
export const SHIELD_SLOT = 0x00200000;

/** acDebug.heldPose(guid): the pose the player's held copy draws (HeldPose), null when none hangs, 'no-hook' without acDebug. */
export const heldPoseJs = (guid: number): string =>
  `(() => { const d = window.acDebug; if (!d || !d.heldPose) return 'no-hook'; return d.heldPose(${guid >>> 0}); })()`;

/**
 * The shield-relog verdict: what the copy DRAWS after the relog against right after equipping. The requested
 * placement id is not the pose: the 1999 shields have no Shield (6) frame, so a re-equip's 6 and the login's 0
 * both draw frame 0 (CPartArray::SetPlacementFrame's fallback, webac#26). Compares the drawn transforms
 * (heldPoseDifferences); without poses, the resolved frame ids from the attach lines; never the requested ids.
 */
export function judgeShieldRelog(
  first: { line: WieldLine; pose: HeldPose | null },
  second: { line: WieldLine; pose: HeldPose | null },
): { ok: boolean; detail: string } {
  const label = (x: { line: WieldLine; pose: HeldPose | null }): string => {
    const frame = x.pose ? x.pose.frame : x.line.frame;
    const req = `placement ${x.line.placement}`;
    return `${frame === undefined || frame === x.line.placement ? req : `${req} → frame ${frame ?? 'identity'}`} (${x.line.source || '?'})`;
  };
  const what = `${label(first)} right after equipping, ${label(second)} after the relog`;
  if (first.pose && second.pose) {
    const diffs = heldPoseDifferences(first.pose, second.pose);
    return diffs.length ? { ok: false, detail: `${what}: the relog draws it differently (${diffs.join('; ')}) (webac#26)` }
      : { ok: true, detail: `${what}: the same pose (holding frame and all ${first.pose.parts.length} parts)` };
  }
  if (first.line.frame !== undefined && second.line.frame !== undefined) {
    return first.line.frame === second.line.frame ? { ok: true, detail: `${what}: the same placement frame (no pose to compare)` }
      : { ok: false, detail: `${what}: a different placement frame (webac#26)` };
  }
  return { ok: false, detail: `${what}: can't tell what it draws (no acDebug.heldPose and no frame= in the attach line)` };
}

/** Wait for the held copy of `guid` and read its pose once it stops changing (a streamed re-attach rebuilds it). */
async function settledHeldPose(ctx: StepContext, guid: number): Promise<HeldPose | null> {
  const { driver } = ctx;
  let last: HeldPose | null = null;
  for (let i = 0; i < 20; i++) {
    const p = await driver.evaluate<HeldPose | null | 'no-hook'>(heldPoseJs(guid));
    if (p === 'no-hook' || p === undefined) return null;
    if (p && last && heldPoseDifferences(last, p).length === 0) return p;
    last = p ?? null;
    await driver.sleep(500);
  }
  return last;
}

export function shieldRelogStep(opts: RegressionOptions = {}): Step {
  return {
    id: 'shield-relog', title: 'A wielded shield sits the same after a relog as right after equipping (webac#26)', timeoutMs: 300_000,
    async run(ctx) {
      const { driver } = ctx;
      let h = await held(ctx);
      const isShield = (i: HeldItem): boolean => (i.validLocations & SHIELD_SLOT) !== 0;
      let shield = h?.equipped.find(isShield) ?? h?.items.find(isShield);
      let note = '';
      if (!shield && opts.admin) {
        const g = (await spawnHeld(ctx, REGRESSION_WCIDS.shield, 1))[0];
        await driver.sleep(1000);
        h = await held(ctx);
        shield = h?.items.find((i) => i.guid === g);
        note = shield ? `spawned ${shield.name}; ` : '';
      }
      if (!shield) return skip(`no shield held${opts.admin ? ' (the spawn brought nothing)' : ' (run with --admin to spawn a Metal Round Shield)'}`, { allow: [ADMIN_CHATTER] });
      if (h?.equipped.some((i) => i.guid === shield!.guid)) {
        await driver.call<AgentResult>('unequip', [shield.guid], 30_000);
        await settle(driver, 10_000);
      }
      const mark = driver.consoleLines().length;
      const r = await driver.call<AgentResult>('equip', [shield.guid, null], 45_000);
      if (!r.ok) return skip(`${note}equipping ${shield.name}: ${msg(r)}`, { allow: [ADMIN_CHATTER, /.*/] });
      let first: WieldLine | null = null;
      for (let i = 0; i < 20 && !first; i++) { await driver.sleep(500); first = lastWield(driver.consoleLines().slice(mark), shield.name); }
      const screenshots = await shots(ctx, 'shield-equipped');
      if (!first) return fail(`${note}equipped ${shield.name} (${msg(r)}), but the client logged no "[Wield] Attached ${shield.name}" within 10 s`, { screenshots, allow: [ADMIN_CHATTER] });
      const firstPose = await settledHeldPose(ctx, shield.guid);
      first = lastWield(driver.consoleLines().slice(mark), shield.name) ?? first;
      const relogMark = driver.consoleLines().length;
      const back = await relog(ctx);
      if (!back.ok) return fail(back.detail, { screenshots, allow: [ADMIN_CHATTER] });
      let second: WieldLine | null = null;
      for (let i = 0; i < 30 && !second; i++) { second = lastWield(driver.consoleLines().slice(relogMark), shield.name); if (!second) await driver.sleep(500); }
      screenshots.push(...await shots(ctx, 'shield-after-relog'));
      if (!second) return fail(`${note}after the relog the client logged no "[Wield] Attached ${shield.name}"`, { screenshots, allow: [ADMIN_CHATTER] });
      const secondPose = await settledHeldPose(ctx, shield.guid);
      second = lastWield(driver.consoleLines().slice(relogMark), shield.name) ?? second;
      const v = judgeShieldRelog({ line: first, pose: firstPose }, { line: second, pose: secondPose });
      return v.ok ? ok(`${note}${shield.name}: ${v.detail}`, { screenshots, allow: [ADMIN_CHATTER] })
        : fail(`${note}${shield.name}: ${v.detail}`, { screenshots, allow: [ADMIN_CHATTER] });
    },
  };
}

export function runningJumpCoastStep(): Step {
  return {
    id: 'running-jump-coast', title: 'A running jump with W let go mid-air coasts after landing (retail calc_friction)', timeoutMs: 90_000,
    async run(ctx) {
      const { driver } = ctx;
      const place = await driver.placeOf([]);
      if (place.me !== 'outdoors') return skip(`the character is ${place.me === 'unknown' ? 'somewhere unknown' : `in a ${place.me}`}: the jump wants open ground`);
      await driver.call('close', ['all']);
      const where = await driver.call<{ x: number; y: number; z: number; heading: number } | null>('where');
      if (!where) return fail('the agent API has no position');
      // 30 m of open ground in some direction (the client's own movement probe, straight ahead).
      let heading: number | null = null;
      for (const turn of [0, 90, 180, 270, 45, 135, 225, 315]) {
        const d = (where.heading + turn) % 360;
        const to = { x: where.x + 30 * Math.sin(d * Math.PI / 180), y: where.y + 30 * Math.cos(d * Math.PI / 180) };
        const end = await driver.call<{ x: number; y: number } | null>('probe', [to]);
        if (end && Math.hypot(end.x - to.x, end.y - to.y) < 1) { heading = d; break; }
      }
      if (heading === null) return skip('no 30 m of open ground in any of eight directions');
      await driver.call('turn', [heading]);
      await driver.sleep(500);
      const ready = await readyForKeys(ctx);
      if (ready.length) return fail(`the keys would not reach the 3D view: ${ready.join('; ')}`, { screenshots: await shots(ctx, 'jump-keys-blocked') });
      await driver.evaluate(startMoveSamplerJs(9000));
      const t0 = await driver.evaluate<number>('performance.now()');
      await driver.key('KeyW', true);
      await driver.sleep(1500);
      await driver.key('Space', true);
      await driver.sleep(250);
      await driver.key('Space', false);
      let airborne = false;
      for (let i = 0; i < 30 && !airborne; i++) {
        await driver.sleep(50);
        airborne = await driver.evaluate<boolean>('!!(window.acDebug && window.acDebug.collisionState && !window.acDebug.collisionState().onGround)');
      }
      await driver.key('KeyW', false);
      // The frame sampler saw every frame; the polls above only some (each evaluate takes a while on SwiftShader).
      if (!airborne) airborne = (await driver.evaluate<MoveSample[]>('(window.__ptMove || []).slice()') ?? []).some((s) => s.t > t0 + 1500 && !s.g);
      if (!airborne) { await driver.sleep(500); return fail('held Space 250 ms while running, and the character never left the ground', { screenshots: await shots(ctx, 'jump-none') }); }
      await driver.sleep(4500);
      const samples = await driver.evaluate<MoveSample[]>('(window.__ptMove || []).slice()');
      await driver.evaluate('(window.__ptMove = null, 0)');
      const screenshots = await shots(ctx, 'jump-landed');
      const c = coastFromSamples(samples, t0 + 1500);
      if (typeof c === 'string') return fail(c, { screenshots });
      const what = `landed at ${c.landingSpeed.toFixed(2)} m/s, coasted ${c.coast.toFixed(2)} m in ${(c.settleMs / 1000).toFixed(2)} s (retail: ${c.expected.toFixed(2)} m)`;
      const problems = judgeCoast(c);
      return problems.length ? fail(`${what}: ${problems.join('; ')}`, { screenshots }) : ok(what, { screenshots });
    },
  };
}

// ── Keys to the 3D view ─────────────────────────────────────────────────────

/** What would take a key press: the windows open, what is under the 3D view's click point, the focused element. */
export interface KeysState { open: string[]; under: string; underIsWorld: boolean; focus: string; typing: boolean }

/** Page-side: the KeysState at (x, y); a focused text field (a hidden book editor's, a chat box) is blurred first. */
export const keysStateJs = (x: number, y: number): string => `(() => {
  const ui = window.__ac && window.__ac.gameUI;
  const open = ui && ui.agentOpenWindows ? ui.agentOpenWindows() : [];
  const desc = (e) => !e ? 'nothing' : e.tagName.toLowerCase() + (e.id ? '#' + e.id : '');
  const typing = (e) => !!e && (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || e.isContentEditable);
  if (typing(document.activeElement)) document.activeElement.blur();
  const u = document.elementFromPoint(${x}, ${y});
  return { open, under: desc(u), underIsWorld: !!u && u.tagName === 'CANVAS', focus: desc(document.activeElement), typing: typing(document.activeElement) };
})()`;

/** Why a key press would not reach the 3D view (none = it would). */
export function judgeKeysState(s: KeysState | null): string[] {
  if (!s) return ['the page answered nothing'];
  const out: string[] = [];
  if (s.open.length) out.push(`still open after closing every window: ${s.open.join(', ')}`);
  if (!s.underIsWorld) out.push(`the 3D view's click point is covered by ${s.under}`);
  if (s.typing) out.push(`a text field keeps the focus (${s.focus})`);
  return out;
}

/**
 * Before real key presses: close every window (then each one still listed, by name), click the 3D view, and check
 * the keys would reach it. The live gate's first fast run (ClassicACE, 2026-11-07): the server's welcome Book was
 * open at login and the running jump's W / Space never moved the character. Returns the problems (none = ready).
 */
export async function readyForKeys(ctx: StepContext): Promise<string[]> {
  const { driver } = ctx;
  await driver.call('close', ['all']);
  await driver.sleep(300);
  const vw = await driver.evaluate<{ w: number; h: number }>('({ w: innerWidth, h: innerHeight })');
  const at = { x: vw.w / 2, y: vw.h * 0.3 };
  let s = await driver.evaluate<KeysState | null>(keysStateJs(at.x, at.y));
  for (const w of s?.open ?? []) await driver.call('close', [w.replace(/ \(.*$/, '')]).catch(() => undefined);
  if (s?.open.length) { await driver.sleep(300); s = await driver.evaluate<KeysState | null>(keysStateJs(at.x, at.y)); }
  if (judgeKeysState(s).length) return judgeKeysState(s);
  await driver.click(at); // the 3D view takes the keys (not the chat box)
  await driver.sleep(300);
  return judgeKeysState(await driver.evaluate<KeysState | null>(keysStateJs(at.x, at.y)));
}

// ── A short walk (the live gate's smoke) ────────────────────────────────────

/** How far the short walk asks for, and how far the character must have got for it to pass. */
export const WALK_SHORT_METRES = 8;
export const WALK_SHORT_MIN_MOVED = 2;

/** The bearings (degrees, 0 = north, clockwise) the short walk tries, in order. */
export const WALK_BEARINGS = [0, 90, 180, 270, 45, 135, 225, 315] as const;

/** A point `metres` from `at` along `bearing` (the agent's frame: x east, y north, as running-jump-coast probes). */
export function pointAlong(at: { x: number; y: number }, bearing: number, metres: number): { x: number; y: number } {
  return { x: at.x + metres * Math.sin(bearing * Math.PI / 180), y: at.y + metres * Math.cos(bearing * Math.PI / 180) };
}

/** The short walk's verdict: its problems (none = it walked). */
export function judgeWalk(from: { x: number; y: number } | null, to: { x: number; y: number } | null, minMoved = WALK_SHORT_MIN_MOVED): string[] {
  if (!from || !to) return ['the agent API has no position'];
  const moved = Math.hypot(to.x - from.x, to.y - from.y);
  return moved >= minMoved ? [] : [`moved ${moved.toFixed(2)} m (want at least ${minMoved} m)`];
}

/**
 * Where the short walk goes, from how far the movement probe got along each bearing: the bearing with the most open
 * ground, and a distance that stays half a metre short of what stopped the probe (at most WALK_SHORT_METRES). Null when
 * no bearing has WALK_SHORT_MIN_MOVED + 0.5 m open (the character is boxed in: walk out through a door instead).
 */
export function walkPlan(reaches: Array<{ bearing: number; reach: number }>): { bearing: number; metres: number } | null {
  const best = [...reaches].sort((x, y) => y.reach - x.reach)[0];
  if (!best || best.reach < WALK_SHORT_MIN_MOVED + 0.5) return null;
  return { bearing: best.bearing, metres: Math.min(WALK_SHORT_METRES, Math.floor((best.reach - 0.5) * 10) / 10) };
}

export function walkShortStep(): Step {
  return {
    id: 'walk-short', title: 'Walk a few metres: the position follows (the live gate\'s smoke)', timeoutMs: 150_000,
    async run(ctx) {
      const { driver } = ctx;
      await driver.call('close', ['all']);
      const from = await driver.call<{ x: number; y: number } | null>('where');
      if (!from) return fail('the agent API has no position');
      // How far each compass point is open (the client's own movement probe); the most open one is walked.
      const reaches: Array<{ bearing: number; reach: number }> = [];
      for (const b of WALK_BEARINGS) {
        const end = await driver.call<{ x: number; y: number } | null>('probe', [pointAlong(from, b, WALK_SHORT_METRES)]);
        reaches.push({ bearing: b, reach: end ? Math.hypot(end.x - from.x, end.y - from.y) : 0 });
      }
      const plan = walkPlan(reaches);
      let target: string | number;
      let how: string;
      if (plan) {
        target = `${plan.metres}m ${compassPoint(plan.bearing)}`;
        how = `the most open way (${reaches.map((r) => `${compassPoint(r.bearing)} ${r.reach.toFixed(1)} m`).join(', ')})`;
      } else {
        // Boxed in (fast run 5: a fresh AC1999 character in a small room, no way past 3 m): out through the nearest door,
        // which walk_to routes to.
        const o = await driver.call<{ nearby: Array<{ guid: number; name: string; kind: string; dist: number }> }>('observe', [{ filter: 'door', radius: 40, max: 5 }]).catch(() => ({ nearby: [] }));
        const door = o.nearby.filter((x) => x.kind === 'door').sort((x, y) => x.dist - y.dist)[0];
        if (!door) return fail(`boxed in: no bearing has ${WALK_SHORT_MIN_MOVED + 0.5} m open (${reaches.map((r) => `${compassPoint(r.bearing)} ${r.reach.toFixed(1)} m`).join(', ')}) and no door within 40 m`);
        target = door.guid;
        how = `out through ${door.name} ${door.dist.toFixed(0)} m off (no bearing had ${WALK_SHORT_MIN_MOVED + 0.5} m open)`;
      }
      const r = await driver.call<AgentResult>('walkTo', [target, { stopOnAggro: false }], 90_000);
      await driver.sleep(500);
      const to = await driver.call<{ x: number; y: number } | null>('where');
      const screenshots = await shots(ctx, 'walk-short');
      const problems = judgeWalk(from, to);
      const what = `walked ${typeof target === 'number' ? `to #${target.toString(16)}` : `"${target}"`}, ${how} (${msg(r) || (r.ok ? 'ok' : 'no answer')})`;
      return problems.length ? fail(`${what}: ${problems.join('; ')}`, { screenshots })
        : ok(`${what}: moved ${Math.hypot(to!.x - from.x, to!.y - from.y).toFixed(1)} m`, { screenshots });
    },
  };
}

export function createCharacterClickStep(): Step {
  return {
    id: 'create-character-click', title: 'Create Character opens chargen, Please Wait up until it does (UX.chargen-click-during-texture-load)', timeoutMs: 300_000,
    async run(ctx) {
      const { driver } = ctx;
      const name = ctx.state.character;
      if (!name) return fail('no character name to enter with afterwards');
      await driver.call('logout');
      let p = await driver.probe();
      for (let i = 0; i < 120 && p.screen !== 'character-select'; i++) { await driver.sleep(500); p = await driver.probe(); }
      if (p.screen !== 'character-select') return fail(`not at character select 60 s after logging out (screen ${p.screen})`, { screenshots: await shots(ctx, 'logout-stuck') });
      // A Please Wait for the character list itself goes first (GameUI.connectingMode).
      for (let i = 0; i < 40 && await driver.evaluate<boolean>('!!(window.__ac && window.__ac.gameUI && window.__ac.gameUI.connectingMode)'); i++) await driver.sleep(500);
      const btn = await driver.evaluate<{ rect: Rect; disabled: boolean } | null>(`(() => { const b = document.getElementById('btn-create-character'); if (!b) return null;
        const r = b.getBoundingClientRect(); return { rect: { x: r.x, y: r.y, w: r.width, h: r.height }, disabled: b.disabled }; })()`);
      if (!btn) return fail('character select draws no Create Character button', { screenshots: await shots(ctx, 'charsel-no-create') });
      const screenshots = await shots(ctx, 'charsel-before-create');
      let outcome: StepOutcome;
      if (btn.disabled) outcome = skip('Create Character is disabled: the account is at its character slot cap');
      else {
        const start = driver.now();
        await driver.click(centerOf(btn.rect));
        const polls: ChargenPoll[] = [];
        for (;;) {
          await driver.sleep(250);
          const st = await driver.evaluate<{ screen: string; waiting: boolean }>(`(() => { const a = window.__acAgent; const s = a && a.status ? a.status().screen : 'unknown';
            const w = document.getElementById('chargen-pleasewait'); let waiting = false;
            if (w) { const b = w.getBoundingClientRect(); const hit = b.width > 0 ? document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2) : null; waiting = !!hit && w.contains(hit); }
            return { screen: s, waiting }; })()`);
          polls.push({ t: driver.now() - start, ...st });
          if (st.screen === 'character-create' || driver.now() - start > 90_000) break;
          // Neither chargen nor its Please Wait after the click's own frame: the click was lost (judged below).
          if (!st.waiting && driver.now() - start > CHARGEN_CLICK_GRACE_MS) break;
        }
        const v = judgeChargenWait(polls);
        screenshots.push(...await shots(ctx, v.ok ? 'chargen-open' : 'chargen-not-open'));
        outcome = v.ok ? ok(v.detail) : fail(v.detail);
      }
      // Back out of chargen (its Exit and the Yes of ID_CharGen_ExitWarning), then into the world again.
      if ((await driver.probe()).screen === 'character-create') {
        await driver.evaluate('(window.__ac.gameUI.doChargenExit(), 0)');
        await driver.sleep(600);
        const d = (await driver.call<{ dialogs: Array<{ text: string; buttons: string[] }> }>('observe', [{ max: 0 }], 30_000)).dialogs ?? [];
        const yes = d.at(-1)?.buttons.find((b) => /^(yes|ok)$/i.test(b));
        if (yes) await driver.call('dialog', [yes, null]);
        for (let i = 0; i < 40 && (await driver.probe()).screen !== 'character-select'; i++) await driver.sleep(500);
      }
      const r = await driver.call<AgentResult>('enterWorld', [name], 120_000);
      for (let i = 0; i < 40 && (await driver.probe()).screen !== 'world'; i++) await driver.sleep(500);
      await driver.sleep(3000);
      if (!r.ok && outcome.status !== 'fail') return fail(`${outcome.detail}; then entering again as ${name}: ${msg(r)}`, { screenshots });
      return { ...outcome, screenshots };
    },
  };
}

// ── Composition ────────────────────────────────────────────────────────────

/** The regression step ids, in run order (option-defaults runs right after entering the world). */
export const REGRESSION_STEP_IDS = ['option-defaults', 'pack-space', 'walk-short', 'pack-scroll-sort', 'pack-bars', 'toolbar-relog', 'shield-relog', 'running-jump-coast', 'create-character-click'] as const;

/** The regression steps for an era (every one exists in all three eras: none is skipped by era). */
export function regressionSteps(_era: EraPlan, opts: RegressionOptions = {}): Step[] {
  return [optionDefaultsStep(), packSpaceStep(), walkShortStep(), ...[packScrollSortStep(opts), packBarsStep(opts), toolbarRelogStep(), shieldRelogStep(opts)].map((s) => leavesNoTrace(s, opts)),
    runningJumpCoastStep(), createCharacterClickStep()];
}

/**
 * The first hour with the regression steps in: option-defaults right after entering the world (and the --admin
 * prep), before anything could change an option; the rest after the give step, before the chat commands, so the
 * run still ends with the era's Yes / No command and the logout.
 */
export function withRegressionSteps(base: Step[], regressions: Step[]): Step[] {
  const FIRST = ['option-defaults', 'pack-space'];
  const first = regressions.filter((s) => FIRST.includes(s.id));
  const rest = regressions.filter((s) => !FIRST.includes(s.id));
  const out = [...base];
  const afterEnter = out.findIndex((s) => s.id === 'enter-world') + 1;
  out.splice(afterEnter, 0, ...first);
  const beforeCmds = out.findIndex((s) => s.id === 'cmd-help');
  out.splice(beforeCmds < 0 ? out.length : beforeCmds, 0, ...rest);
  return out;
}
