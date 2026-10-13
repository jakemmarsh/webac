/**
 * GoArrow's main window ("GoArrow", docs/plugin-specs/goarrow.md §2), drawn with the VVS kit as our other
 * plugin windows are (VTankKit: text, flat buttons, dropdowns, edits, bullets, text tabs, lists, icons).
 * Clean room: our own code; the labels, positions (GoArrow.xml's `left,top width x height`) and messages
 * are GoArrow's, as facts about its interface. State and actions live in GoArrowModel (no DOM).
 *
 * Notebooks: HUDs (Arrow, General) | Atlas (Search, Route, Details, Favorites, Recent) | Settings (Chat,
 * Route Finding, About). The window resizes per top tab (HUDs 216 × 280, Atlas and Settings 272 × 338).
 *
 * Left out, with reasons (No Dead-End UI):
 * - HUDs > Dereth and HUDs > Dungeon (the map HUDs): GoArrow's Dereth map image and Greeneye's dungeon maps
 *   are not licensed (spec §8), and no DAT-drawn GoArrow map exists yet. Likewise the Details tab's
 *   "Locate on Map" and "Dungeon Map" buttons, and General's "Both maps can be visible at once".
 * - Atlas > Update: our locations database is generated from each era's world data; there is no remote
 *   database to download (spec §5). The Delete... page's text drops its "online database ... update" clause.
 * - HUDs > General's toolbar options (Show HUDs toolbar, Display, Orientation, Buttons): the HUD toolbar is
 *   not built; our VVS bar opens the window instead.
 * - About: GoArrow's locations-database and dungeon-map credits name data we don't use; ours says where
 *   the database comes from.
 *
 * Decal's notebooks put each tab row above its page; ours are VVS text tabs, 16 px a row.
 */
import { GOARROW_LIMIT_TO, GOARROW_TEXT_COLORS, GOARROW_GO_ICON, GOARROW_DELETE_ICON, GOARROW_COORDS_UNKNOWN, GOARROW_VERSION, formatGoCoords, formatGoCoordsFixed, goLetterBucket, goLocationIcon, goLocationTypeLabel, goLocationTypeName, goRelativeCoords, type GoLocation } from '@ac/shared';
import type { MenuItem } from '../automation/AutomationPanel.js';
import type { VTankKit } from '../automation/VTankWindow.js';
import { renderVvsText, VVS_COLORS } from '../automation/vvsText.js';
import { GOARROW_SHIPPED_SETS } from './ArrowHud.js';
import {
  GOARROW_MODIFY_TYPES,
  GOARROW_WINDOW_SIZES,
  goListCoords,
  goWrapDescription,
  type GoArrowModel,
  type GoAtlasTab,
  type GoClickMods,
  type GoDetailsTab,
  type GoHudsTab,
  type GoRouteSettingsTab,
  type GoSettingsTab,
  type GoTopTab,
} from './GoArrowModel.js';

/** A notebook's tab row height. */
export const GOARROW_TAB_ROW = 16;
/** List row pitch. */
export const GOARROW_ROW = 18;

export const GOARROW_TOP_TABS: readonly GoTopTab[] = ['HUDs', 'Atlas', 'Settings'];
export const GOARROW_HUDS_TABS: readonly GoHudsTab[] = ['Arrow', 'General'];
export const GOARROW_ATLAS_TABS: readonly GoAtlasTab[] = ['Search', 'Route', 'Details', 'Favorites', 'Recent'];
export const GOARROW_SETTINGS_TABS: readonly GoSettingsTab[] = ['Chat', 'Route Finding', 'About'];
const ROUTE_SETTINGS_TABS: readonly GoRouteSettingsTab[] = ['Start Locations', 'Portal Devices'];
const LETTERS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];

/** GoArrow's named colours (spec §2.6, §4.3, §4.4). */
const GOLD = 'rgb(255, 215, 0)';
const GRAY = 'rgb(128, 128, 128)';
const LIGHT_GREEN = 'rgb(144, 238, 144)';
const DARK_RED = 'rgb(128, 0, 0)';

const LINK_COORDS_HELP = [
  'This option turns coordinates in the chat area into clickable links (like this: 10.7N, 52.3E).',
  'Click on the link to make the arrow point to those coords.',
  'Shift + Click on the link to set the route start to those coords.',
  'Ctrl + Click on the link to set the route end to those coords.',
];
const RUN_DIST_HELP = 'Some start locations (such as Abandoned Mines) require running through a dungeon.  The number you enter here will be added to the route distance when calculating a route from this start location.';
const locHelp = (c: string): string[] => [
  `The ${c} loc command sends your current coords to a specified target. The target can be any chat channel, such as fellowship (f), local chat (say), tell (t [name]), etc.`,
  `"${c} loc say"  =>  You say, "<coords>"`,
  `"${c} loc t Digero, I'm at"  =>  You tell Digero, "I'm at <coords>"`,
  `"${c} loc a Come to %c for the quest"  =>  [Allegiance] <you> says, "Come to <coords> for the quest"`,
];

type Opts = { bold?: boolean; italic?: boolean; color?: string; w?: number; align?: 'left' | 'center' | 'right' };

/** Draw the window's body (the client area) into `body`. Call again (redraw) after any change. */
export function renderGoArrowWindow(body: HTMLElement, kit: VTankKit, model: GoArrowModel, redraw: () => void): void {
  const scrolls = new Map<string, number>();
  body.querySelectorAll<HTMLElement>('[data-goarrow-list]').forEach((e) => scrolls.set(e.dataset.goarrowList!, e.scrollTop));
  body.innerHTML = '';
  const size = GOARROW_WINDOW_SIZES[model.top];
  const root = tag(document.createElement('div'), { goarrow: 'window', top: model.top });
  Object.assign(root.style, { position: 'absolute', left: '0', top: '0', width: `${size.w}px`, height: `${size.h}px`, overflow: 'hidden' });
  body.appendChild(root);
  const c = kit.colors;
  const act = (fn: () => void) => () => { fn(); redraw(); };

  // ── parts ──
  const at = (e: HTMLElement, x: number, y: number, parent: HTMLElement): HTMLElement => {
    Object.assign(e.style, { position: 'absolute', left: `${x}px`, top: `${y}px` });
    parent.appendChild(e);
    return e;
  };
  const label = (parent: HTMLElement, text: string, x: number, y: number, o: Opts = {}): HTMLElement => {
    const t = o.bold || o.italic ? renderVvsText(text, o.color ?? VVS_COLORS.text, { bold: o.bold, italic: o.italic, maxWidth: o.w }) : kit.text(text, { color: o.color ?? c.text, ...(o.w ? { maxWidth: o.w } : {}) });
    const box = tag(document.createElement('div'), { goarrowLabel: text });
    Object.assign(box.style, { display: 'flex', justifyContent: o.align === 'center' ? 'center' : o.align === 'right' ? 'flex-end' : 'flex-start', ...(o.w ? { width: `${o.w}px` } : {}), pointerEvents: 'none' });
    box.appendChild(t);
    return at(box, x, y, parent);
  };
  const mods = (e: MouseEvent): GoClickMods => ({ ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
  /** A Decal checkbox: the bullet and its text. Acts on mousedown, so Ctrl+click works on a Mac. */
  const checkbox = (parent: HTMLElement, text: string, on: boolean, x: number, y: number, fn: (m: GoClickMods) => void, o: Opts = {}): HTMLElement => {
    const box = tag(document.createElement('div'), { goarrowCheck: text, on: on ? '1' : '0' });
    Object.assign(box.style, { display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', height: '16px' });
    const bullet = kit.check(on, () => {});
    bullet.style.pointerEvents = 'none';
    box.appendChild(bullet);
    if (text) box.appendChild(o.bold || o.italic ? renderVvsText(text, VVS_COLORS.text, { bold: o.bold, italic: o.italic }) : kit.text(text, { color: c.text }));
    box.addEventListener('mousedown', (e) => { if (e.button !== 0) return; e.preventDefault(); e.stopPropagation(); fn(mods(e)); redraw(); });
    return at(box, x, y, parent);
  };
  const button = (parent: HTMLElement, text: string, x: number, y: number, w: number, h: number, fn: () => void): HTMLElement =>
    at(tag(kit.flatButton(text, act(fn), w, h), { goarrowButton: text }), x, y, parent);
  const edit = (parent: HTMLElement, name: string, value: string, x: number, y: number, w: number, onChange: (v: string) => void, onEnter?: (v: string) => void): HTMLInputElement => {
    const i = kit.input(value, w, onChange) as HTMLInputElement;
    tag(i, { goarrowEdit: name });
    if (onEnter) i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { onEnter(i.value); redraw(); } });
    at(i, x, y, parent);
    return i;
  };
  const dropdown = (parent: HTMLElement, name: string, text: string, x: number, y: number, w: number, items: () => MenuItem[], pick: (v: string) => void): HTMLElement =>
    at(tag(kit.dropdown(text, (a) => kit.menu(a, items(), (v) => { pick(v); redraw(); }, { width: w }), w), { goarrowDropdown: name }), x, y, parent);
  const page = (parent: HTMLElement, name: string, x: number, y: number, w: number, h: number): HTMLElement => {
    const p = tag(document.createElement('div'), { goarrowPage: name });
    Object.assign(p.style, { width: `${w}px`, height: `${h}px`, overflow: 'hidden' });
    return at(p, x, y, parent);
  };
  const tabs = <T extends string>(parent: HTMLElement, group: string, names: readonly T[], open: T, y: number, pick: (t: T) => void): void => {
    const row = tag(document.createElement('div'), { goarrowTabs: group });
    Object.assign(row.style, { display: 'flex', gap: '10px', alignItems: 'center', height: `${GOARROW_TAB_ROW}px` });
    for (const n of names) row.appendChild(tag(kit.textTab(n, n === open, act(() => pick(n))), { goarrowTab: n }));
    at(row, 4, y, parent);
  };
  const listBox = (parent: HTMLElement, name: string, x: number, y: number, w: number, h: number): HTMLElement => {
    const box = tag(document.createElement('div'), { goarrowList: name });
    Object.assign(box.style, { width: `${w}px`, height: `${h}px` });
    at(box, x, y, parent);
    const inner = document.createElement('div');
    Object.assign(inner.style, { display: 'flex', flexDirection: 'column', paddingRight: '16px' });
    box.appendChild(inner);
    kit.list(box);
    const keep = scrolls.get(name);
    if (keep) queueMicrotask(() => { box.scrollTop = keep; });
    return inner;
  };
  /** A list row: absolute cells; each cell may take a mousedown (with modifiers). */
  const row = (inner: HTMLElement, data: Record<string, string>): { line: HTMLElement; cell: (el: HTMLElement, x: number, w: number, fn?: (m: GoClickMods) => void, kind?: string) => void } => {
    const line = tag(kit.row(false), data);
    Object.assign(line.style, { position: 'relative', height: `${GOARROW_ROW}px`, minHeight: `${GOARROW_ROW}px`, padding: '0' });
    inner.appendChild(line);
    const cell = (el: HTMLElement, x: number, w: number, fn?: (m: GoClickMods) => void, kind?: string) => {
      const b = document.createElement('div');
      if (kind) b.dataset.goarrowCell = kind;
      Object.assign(b.style, { position: 'absolute', left: `${x}px`, top: '1px', width: `${w}px`, height: '16px', overflow: 'hidden', whiteSpace: 'nowrap', cursor: fn ? 'pointer' : 'default' });
      b.appendChild(el);
      if (fn) b.addEventListener('mousedown', (e) => { if (e.button !== 0) return; e.preventDefault(); e.stopPropagation(); fn(mods(e)); redraw(); });
      line.appendChild(b);
    };
    return { line, cell };
  };
  /** One of the Atlas's location lists (spec §2.6): icon | name | coords | go icon. */
  const locationList = (parent: HTMLElement, name: string, x: number, y: number, w: number, h: number, locs: GoLocation[], o: { nameW?: number; relative: boolean; inFavorites?: boolean; onIcon: (i: number, m: GoClickMods) => void }): void => {
    const inner = listBox(parent, name, x, y, w, h);
    const player = model.host.player();
    const nameW = o.nameW ?? w - 16 - 4 - 16 - 4 - 74 - 4 - 16 - 4;
    locs.forEach((loc, i) => {
      const { cell } = row(inner, { goarrowLocation: String(loc.id), goarrowName: loc.name });
      cell(kit.icon(goLocationIcon(loc, o.inFavorites), 16), 2, 16, (m) => o.onIcon(i, m), 'icon');
      cell(kit.text(loc.name, { color: c.text }), 22, nameW, (m) => model.clickLocation(loc, m), 'name');
      const rel = o.relative && player && loc.coords;
      const coordsText = rel ? goListCoords(goRelativeCoords(player, loc.coords!)) : goListCoords(loc.coords);
      cell(kit.text(coordsText, { color: rel ? GOLD : c.text }), 26 + nameW, 74, (m) => model.clickLocation(loc, m), 'coords');
      cell(kit.icon(GOARROW_GO_ICON, 16), 30 + nameW + 74, 16, () => model.goLocation(loc), 'go');
    });
  };
  const relativeBox = (parent: HTMLElement, key: keyof GoArrowModel['relative']): void => {
    checkbox(parent, 'Relative Coordinates', model.relative[key], 4, 258, () => { model.relative[key] = !model.relative[key]; });
  };

  // ── the top notebook ──
  tabs(root, 'main', GOARROW_TOP_TABS, model.top, 0, (t) => model.setTop(t));
  const sub = GOARROW_TAB_ROW;
  const y0 = GOARROW_TAB_ROW * 2;
  const pw = size.w;
  const ph = size.h - y0;

  if (model.top === 'HUDs') {
    tabs(root, 'huds', GOARROW_HUDS_TABS, model.hudsTab, sub, (t) => { model.hudsTab = t; });
    const p = page(root, model.hudsTab, 0, y0, pw, ph);
    const s = model.host.settings();
    if (model.hudsTab === 'Arrow') {
      checkbox(p, 'Show Arrow', s.visible, 4, 8, () => model.setShowArrow(!s.visible), { bold: true });
      checkbox(p, 'Show arrow indoors', s.displayIndoors, 92, 8, () => model.host.saveSettings({ displayIndoors: !s.displayIndoors }));
      label(p, 'Coords', 4, 24);
      edit(p, 'edtArrowCoords', model.arrowCoordsShown(), 48, 24, 104, (v) => { model.arrowCoordsText = v; }, (v) => model.applyArrowCoords(v));
      button(p, 'Here', 160, 24, 48, 16, () => model.arrowHere());
      checkbox(p, 'Show destination over arrow', s.showDestinationOver, 4, 40, () => model.host.saveSettings({ showDestinationOver: !s.showDestinationOver }));
      checkbox(p, 'Show distance under arrow', s.showDistanceUnder, 4, 56, () => model.host.saveSettings({ showDistanceUnder: !s.showDistanceUnder }));
      checkbox(p, 'Require Ctrl key to move arrow', s.positionLocked, 4, 72, () => model.host.saveSettings({ positionLocked: !s.positionLocked }));
      checkbox(p, 'Automatically track corpses', s.trackCorpses, 4, 88, () => model.host.saveSettings({ trackCorpses: !s.trackCorpses }));
      label(p, 'Arrow image', 4, 112);
      const sets = [...GOARROW_SHIPPED_SETS].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
      const shownSet = sets.find((n) => n.toLowerCase() === s.arrowName.toLowerCase()) ?? sets[0] ?? s.arrowName;
      dropdown(p, 'choArrowImage', shownSet, 72, 112, 136, () => sets.map((n) => ({ label: n, value: n })), (v) => model.host.saveSettings({ arrowName: v }));
      label(p, 'Text color', 4, 136);
      const colorName = GOARROW_TEXT_COLORS.find((x) => x.rgb === (s.textColor & 0xffffff))?.label ?? `#${(s.textColor & 0xffffff).toString(16).padStart(6, '0').toUpperCase()}`;
      dropdown(p, 'choTextColor', colorName, 4, 152, 96, () => GOARROW_TEXT_COLORS.map((x) => ({ label: x.label, value: String(x.rgb) })), (v) => model.host.saveSettings({ textColor: Number(v) }));
      label(p, 'Text size', 112, 136);
      edit(p, 'edtTextSize', model.textSizeShown(), 112, 152, 32, (v) => { model.textSizeText = v; }, (v) => model.applyTextSize(v));
      button(p, '+', 144, 152, 12, 8, () => model.bumpTextSize(1));
      button(p, '-', 144, 160, 12, 8, () => model.bumpTextSize(-1));
      checkbox(p, 'Bold', s.textBold, 168, 152, () => model.host.saveSettings({ textBold: !s.textBold }));
      button(p, 'Reset Position', 56, 196, 104, 16, () => model.resetArrowPosition());
    } else {
      label(p, 'Active Opacity:', 4, 152);
      at(tag(kit.slider(s.alphaActive, 0, 255, 112, (v) => { model.setOpacity('active', v); redraw(); }), { goarrowSlider: 'sldHudOpacityActive' }), 96, 154, p);
      label(p, 'Inactive Opacity:', 4, 168);
      at(tag(kit.slider(s.alphaInactive, 0, 255, 112, (v) => { model.setOpacity('inactive', v); redraw(); }), { goarrowSlider: 'sldHudOpacityInactive' }), 96, 170, p);
      button(p, 'Reset All HUD Positions', 40, 192, 136, 16, () => model.resetHudPositions());
    }
    return;
  }

  if (model.top === 'Atlas') {
    tabs(root, 'atlas', GOARROW_ATLAS_TABS, model.atlasTab, sub, (t) => model.setAtlasTab(t));
    const p = page(root, model.atlasTab, 0, y0, pw, ph);
    if (model.atlasTab === 'Search') {
      checkbox(p, 'Text', model.searchText, 4, 8, (m) => model.clickSearchKind('text', m.ctrl));
      edit(p, 'edtSearchName', model.searchName, 60, 8, 132, (v) => { model.searchName = v; }, () => model.search());
      dropdown(p, 'choSearchIn', model.searchIn, 200, 8, 64, () => ['Name', 'Descr', 'Both'].map((x) => ({ label: x, value: x })), (v) => { model.searchIn = v as typeof model.searchIn; });
      checkbox(p, 'Nearby', model.searchNearby, 4, 28, (m) => model.clickSearchKind('nearby', m.ctrl));
      edit(p, 'edtSearchRadius', model.searchRadius, 60, 28, 30, (v) => { model.searchRadius = v; }, () => model.search());
      label(p, 'km', 94, 28);
      edit(p, 'edtSearchCoords', model.searchCoords, 116, 28, 108, (v) => { model.searchCoords = v; }, () => model.search());
      button(p, 'Here', 232, 28, 32, 16, () => model.searchHere());
      label(p, 'Limit to', 16, 50);
      dropdown(p, 'choSearchLimit', GOARROW_LIMIT_TO.find((t) => t.type === model.searchLimit)?.label ?? 'Any', 60, 48, 132, () => GOARROW_LIMIT_TO.map((t) => ({ label: t.label, value: String(t.type) })), (v) => { model.searchLimit = Number(v); });
      at(tag(kit.flatButton('Search', act(() => model.search()), 64, 16), { goarrowButton: 'Search' }), 200, 48, p).dataset.bold = '1';
      const results = model.results.map((l) => model.decorate(l));
      locationList(p, 'lstSearchResults', 0, 72, 272, 182, results, { nameW: 118, relative: model.relative.search, onIcon: (i, m) => model.clickIcon('search', i, m) });
      relativeBox(p, 'search');
      label(p, `${model.results.length.toLocaleString('en-US')} - `, 152, 258, { w: 50, align: 'right' });
      label(p, 'matches found', 192, 258, { w: 80, align: 'right' });
    } else if (model.atlasTab === 'Route') {
      for (const which of ['from', 'to'] as const) {
        const e = model.routeEnd(which);
        const y = which === 'from' ? 8 : 56;
        label(p, which === 'from' ? 'From' : 'To', 4, y + 1, { bold: true });
        dropdown(p, `choRoute${which === 'from' ? 'From' : 'To'}Ltr`, e.letter, 40, y, 48, () => LETTERS.map((l) => ({ label: l, value: l })), (v) => { e.letter = v; e.locationId = null; });
        const picked = e.locationId !== null ? model.locationById(e.locationId) : null;
        dropdown(p, `choRoute${which === 'from' ? 'From' : 'To'}`, picked && goLetterBucket(picked.name) === e.letter ? picked.name : '<Custom>', 96, y, 168,
          () => [{ label: '<Custom>', value: '' }, ...model.routeChoices(e.letter).map((l) => ({ label: l.name, value: String(l.id) }))],
          (v) => model.pickRouteLocation(which, v === '' ? null : Number(v)));
        label(p, 'Coords', 56, y + 24);
        edit(p, `edtRoute${which === 'from' ? 'From' : 'To'}Coords`, model.routeCoordsShown(which), 96, y + 24, 120, (v) => { e.coordsText = v; e.here = false; }, () => model.findRoute());
        checkbox(p, 'Here', e.here, 224, y + 24, () => { e.here = !e.here; if (!e.here) e.coordsText = ''; });
      }
      button(p, 'Copy', 4, 104, 64, 16, () => model.copyRoute());
      at(tag(kit.flatButton('Find Route', act(() => model.findRoute()), 112, 16), { goarrowButton: 'Find Route', bold: '1' }), 80, 104, p);
      button(p, 'Next longer', 200, 104, 64, 16, () => model.nextLonger());
      const inner = listBox(p, 'lstRoute', 0, 126, 272, 128);
      const player = model.host.player();
      const nameW = 272 - 16 - 4 - 16 - 4 - 74 - 4 - 16 - 4;
      (model.route?.steps ?? []).forEach((step, i) => {
        const { cell } = row(inner, { goarrowStep: String(i), goarrowName: step.location.name });
        cell(kit.icon(goLocationIcon(step.location), 16), 2, 16, (m) => model.clickIcon('route', i, m), 'icon');
        cell(kit.text(step.location.name, { color: c.text }), 22, nameW, (m) => model.clickLocation(step.location, m), 'name');
        const rel = model.relative.route && player;
        cell(kit.text(goListCoords(rel ? goRelativeCoords(player, step.coords) : step.coords), { color: rel ? GOLD : c.text }), 26 + nameW, 74, (m) => model.clickLocation(step.location, m), 'coords');
        cell(kit.icon(GOARROW_GO_ICON, 16), 30 + nameW + 74, 16, () => model.goRouteStep(i), 'go');
      });
      relativeBox(p, 'route');
      label(p, model.routeLabel, 216, 258, { w: 52, align: 'right' }).dataset.goarrowRouteDistance = '1';
    } else if (model.atlasTab === 'Details') {
      const l = model.selected;
      label(p, l ? l.name : 'No location selected', 4, 8, { bold: true, w: 224 }).dataset.goarrowDetails = 'name';
      label(p, l ? goLocationTypeLabel(l, formatGoCoords) : '', 4, 24, { w: 224 }).dataset.goarrowDetails = 'type';
      if (l) at(tag(kit.icon(goLocationIcon(model.decorate(l)), 32), { goarrowDetails: 'icon' }), 232, 8, p);
      label(p, 'Absolute Coords:', 4, 40);
      label(p, 'Relative Coords:', 4, 56);
      const player = model.host.player();
      label(p, l?.coords ? formatGoCoordsFixed(l.coords, 1) : '', 88, 40).dataset.goarrowDetails = 'abs';
      label(p, l?.coords && player ? formatGoCoordsFixed(goRelativeCoords(player, l.coords), 1) : '', 88, 56, { color: GOLD }).dataset.goarrowDetails = 'rel';
      button(p, 'Copy', 168, 48, 40, 16, () => model.detailsCopy());
      button(p, model.detailsMinimized ? 'Restore' : 'Minimize', 212, 48, 52, 16, () => model.toggleMinimize());
      button(p, 'Route Start', 4, 72, 82, 16, () => model.detailsRouteStart());
      button(p, 'Arrow Target', 95, 72, 82, 16, () => model.detailsArrowTarget());
      button(p, 'Route End', 4, 92, 82, 16, () => model.detailsRouteEnd());
      button(p, 'Add Favorite', 95, 92, 82, 16, () => model.addFavorite());
      const detailTabs: GoDetailsTab[] = ['Description', ...(model.host.saveLocation ? ['Modify/Add Location' as const] : []), ...(model.host.deleteLocation ? ['Delete...' as const] : [])];
      if (!detailTabs.includes(model.detailsTab)) model.detailsTab = 'Description';
      tabs(p, 'details', detailTabs, model.detailsTab, 112, (t) => { model.detailsTab = t; });
      const dp = page(p, model.detailsTab, 0, 112 + GOARROW_TAB_ROW, 272, 158 - GOARROW_TAB_ROW);
      if (model.detailsTab === 'Description') {
        const inner = listBox(dp, 'lstLocationDescription', 0, 0, 272, 158 - GOARROW_TAB_ROW);
        for (const line of goWrapDescription(l?.notes ?? '')) {
          const r = document.createElement('div');
          Object.assign(r.style, { minHeight: '13px', paddingLeft: '4px' });
          r.dataset.goarrowDescription = line;
          r.appendChild(kit.text(line, { color: c.text }));
          inner.appendChild(r);
        }
      } else if (model.detailsTab === 'Modify/Add Location') {
        const f = model.modify;
        label(dp, 'Name', 4, 4);
        edit(dp, 'edtModifyName', f.name, 48, 4, 216, (v) => { f.name = v; });
        label(dp, 'Coords', 4, 24);
        edit(dp, 'edtModifyCoords', f.coords, 48, 24, 104, (v) => { f.coords = v; });
        button(dp, 'Here', 160, 24, 40, 16, () => { const pl = model.host.player(); if (pl) f.coords = formatGoCoords(pl); });
        label(dp, 'Exit', 4, 44);
        edit(dp, 'edtModifyExitCoords', f.exit, 48, 44, 104, (v) => { f.exit = v; });
        tag(button(dp, 'Here', 160, 44, 40, 16, () => { const pl = model.host.player(); if (pl) f.exit = formatGoCoords(pl); }), { goarrowButton: 'Exit Here' });
        button(dp, 'None', 208, 44, 40, 16, () => { f.exit = ''; f.useInRoute = false; });
        label(dp, 'Type', 4, 66);
        dropdown(dp, 'choModifyType', goLocationTypeName(f.type), 48, 64, 152, () => GOARROW_MODIFY_TYPES.map((t) => ({ label: t.label, value: String(t.type) })), (v) => { f.type = Number(v); });
        checkbox(dp, 'Use in route finding', f.useInRoute, 48, 86, () => { f.useInRoute = !f.useInRoute; });
        label(dp, 'Descr', 4, 104);
        edit(dp, 'edtModifyDescription', f.descr, 48, 104, 216, (v) => { f.descr = v; });
        at(tag(kit.flatButton('Modify', act(() => model.saveModified(false)), 88, 16), { goarrowButton: 'Modify', bold: '1' }), 16, 124, dp);
        button(dp, 'Save As New', 112, 124, 80, 16, () => model.saveModified(true));
        button(dp, 'Reset', 200, 124, 56, 16, () => model.resetModify());
      } else {
        label(dp, 'This will remove the location from the database on your computer.  It is only really useful to delete locations that you have added yourself.', 4, 4, { w: 256 });
        label(dp, 'You must hold down the Ctrl key while clicking Delete', 4, 100, { w: 272 });
        // Delete reads Ctrl on mousedown (a Mac's Ctrl+click never clicks); its text is GoArrow's dark red.
        const del = tag(kit.flatButton('', () => {}, 64, 16), { goarrowButton: 'Delete', bold: '1' });
        del.replaceChildren(renderVvsText('Delete', DARK_RED, { bold: true }));
        del.addEventListener('mousedown', (e) => { if (e.button !== 0) return; e.preventDefault(); e.stopPropagation(); model.deleteSelected(e.ctrlKey || e.metaKey); redraw(); });
        at(del, 104, 130, dp);
      }
    } else if (model.atlasTab === 'Favorites') {
      label(p, 'Favorite Locations', 4, 2, { bold: true, w: 256, align: 'center' });
      locationList(p, 'lstFavorites', 0, 15, 272, 239, model.favorites(), { relative: model.relative.favorites, inFavorites: true, onIcon: (i, m) => model.clickIcon('favorites', i, m) });
      relativeBox(p, 'favorites');
      label(p, 'Ctrl+Click icon to remove', 124, 258, { italic: true, color: DARK_RED, w: 144, align: 'right' });
    } else {
      label(p, 'Recent Locations', 4, 2, { bold: true, w: 256, align: 'center' });
      locationList(p, 'lstRecent', 0, 15, 272, 121, model.recentLocations(), { relative: model.relative.recent, onIcon: (i, m) => model.clickIcon('recent', i, m) });
      label(p, 'Recent Arrow Coordinates', 4, 138, { bold: true, w: 256, align: 'center' });
      const inner = listBox(p, 'lstRecentCoords', 0, 151, 272, 103);
      const player = model.host.player();
      model.recentCoords().forEach((rc, i) => {
        const { cell } = row(inner, { goarrowRecentCoords: String(i), goarrowName: rc.name });
        cell(kit.icon(rc.icon, 16), 2, 16, () => model.removeRecentCoords(i), 'icon');
        cell(kit.text(rc.name, { color: c.text }), 22, 148, (m) => model.clickRecentCoords(rc, m), 'name');
        const rel = model.relative.recent && player;
        cell(kit.text(goListCoords(rel ? goRelativeCoords(player, rc.coords) : rc.coords), { color: rel ? GOLD : c.text }), 174, 74, (m) => model.clickRecentCoords(rc, m), 'coords');
      });
      relativeBox(p, 'recent');
      label(p, 'Click icon to remove', 124, 258, { italic: true, color: DARK_RED, w: 144, align: 'right' });
    }
    return;
  }

  // Settings
  tabs(root, 'settings', GOARROW_SETTINGS_TABS, model.settingsTab, sub, (t) => { model.settingsTab = t; });
  const p = page(root, model.settingsTab, 0, y0, pw, ph);
  const s = model.host.settings();
  const cmd = `/${s.chatCommand.toLowerCase()}`;
  const say = (lines: string[]) => { for (const l of lines) model.host.say(l, 'help'); };
  if (model.settingsTab === 'Chat') {
    checkbox(p, 'Make coords in chat area clickable', s.linkCoords, 4, 8, () => model.host.saveSettings({ linkCoords: !s.linkCoords }));
    button(p, '?', 220, 10, 12, 12, () => say(LINK_COORDS_HELP)).dataset.goarrowHelp = 'link';
    label(p, 'Display GoArrow messages in:', 4, 32);
    checkbox(p, 'Main Chat', s.outputWindows.includes(0), 16, 48, () => model.toggleOutput(0));
    for (let n = 1; n <= 4; n++) checkbox(p, String(n), s.outputWindows.includes(n), 64 + n * 32, 48, () => model.toggleOutput(n));
    checkbox(p, 'Always show errors in Main Chat', s.alwaysShowErrors, 16, 64, () => model.host.saveSettings({ alwaysShowErrors: !s.alwaysShowErrors }));
    label(p, 'Chat command: /', 4, 88);
    edit(p, 'edtChatCommand', s.chatCommand, 88, 88, 56, () => {}, (v) => model.renameCommand('main', v));
    label(p, `Type '${cmd} help' to see chat commands`, 16, 104, { italic: true, w: 248, align: 'center' });
    const alias = (kind: 'loc' | 'dest' | 'find', y: number, key: 'locAlias' | 'destAlias' | 'findAlias', help?: string[]) => {
      const a = s[key];
      checkbox(p, `Enable '${cmd} ${kind}' command alias`, a.enabled, 4, y, () => model.host.saveSettings({ [key]: { ...a, enabled: !a.enabled } } as Partial<typeof s>));
      label(p, 'Command: /', 24, y + 16);
      edit(p, `edt${kind}Command`, a.name, 80, y + 16, 56, () => {}, (v) => model.renameCommand(kind, v));
      if (help) button(p, '?', 144, y + 18, 12, 12, () => say(help)).dataset.goarrowHelp = kind;
    };
    alias('loc', 136, 'locAlias', locHelp(cmd));
    alias('dest', 184, 'destAlias', locHelp(cmd));
    alias('find', 232, 'findAlias');
  } else if (model.settingsTab === 'Route Finding') {
    label(p, 'Maximum running distance between portals', 4, 4);
    edit(p, 'edtMaxRunDist', String(s.maxRunDistance), 216, 4, 30, () => {}, (v) => model.applyRunDistance('max', v));
    label(p, 'km', 248, 4);
    label(p, 'Treat using a portal equivalent to running', 4, 22);
    edit(p, 'edtPortalRunDist', String(s.portalRunDistance), 216, 22, 30, () => {}, (v) => model.applyRunDistance('portal', v));
    label(p, 'km', 248, 22);
    tabs(p, 'routeSettings', ROUTE_SETTINGS_TABS, model.routeSettingsTab, 40, (t) => { model.routeSettingsTab = t; });
    const rp = page(p, model.routeSettingsTab, 0, 40 + GOARROW_TAB_ROW, 272, 234 - GOARROW_TAB_ROW);
    if (model.routeSettingsTab === 'Start Locations') {
      const inner = listBox(rp, 'lstStartLocations', 0, 0, 272, 121);
      model.host.startLocations().forEach((st, i) => {
        const { cell } = row(inner, { goarrowStart: st.name, on: st.enabled ? '1' : '0' });
        cell(kit.check(st.enabled, () => {}), 2, 16, () => model.toggleStart(i), 'check');
        cell(kit.icon(st.icon, 16), 20, 16, () => model.toggleStart(i), 'icon');
        cell(kit.text(st.name, { color: c.text }), 40, 118, () => model.editStart(i), 'name');
        cell(kit.text(st.coords ? formatGoCoordsFixed(st.coords, 1) : GOARROW_COORDS_UNKNOWN, { color: st.coords ? c.text : GRAY }), 160, 74, () => model.editStart(i), 'coords');
        if (st.kind === 'Regular') cell(kit.icon(GOARROW_DELETE_ICON, 16), 236, 16, (m) => model.deleteStart(i, !!m.ctrl), 'delete');
      });
      const e = model.startEdit;
      const ed = page(rp, 'startEditor', 4, 120, 264, 56);
      label(ed, 'Add or modify a start location', 0, 0);
      label(ed, 'Name', 6, 16);
      edit(ed, 'edtStartLocationName', e.name, 40, 16, 120, (v) => { e.name = v; });
      label(ed, 'Run dist', 168, 16);
      edit(ed, 'edtStartLocationRunDist', e.runDist, 208, 16, 30, (v) => { e.runDist = v; });
      button(ed, '?', 242, 18, 12, 12, () => model.host.say(RUN_DIST_HELP, 'help')).dataset.goarrowHelp = 'rundist';
      label(ed, 'Coords', 6, 36);
      edit(ed, 'edtStartLocationCoords', e.coords, 40, 36, 80, (v) => { e.coords = v; });
      button(ed, 'Here', 128, 36, 32, 16, () => model.startHere());
      button(ed, e.index !== null ? 'Modify' : 'Add', 176, 36, 80, 16, () => model.saveStart());
      checkbox(rp, 'Automatically update recall coordinates', s.autoUpdateRecalls, 4, 176, () => model.host.saveSettings({ autoUpdateRecalls: !s.autoUpdateRecalls }));
      label(rp, 'Applies to lifestone, bindstone, house, and portal ties', 16, 192, { italic: true });
    } else {
      const inner = listBox(rp, 'lstPortalDevices', 0, 0, 272, 201 - GOARROW_TAB_ROW);
      model.host.portalDevices().forEach((d, i) => {
        const { cell } = row(inner, { goarrowDevice: d.name, on: d.enabled ? '1' : '0' });
        cell(kit.check(d.enabled, () => {}), 2, 16, () => model.toggleDevice(i), 'check');
        cell(kit.icon(d.icon ?? 0x060030c3, 16), 20, 16, () => model.toggleDevice(i), 'icon');
        cell(kit.text(d.name, { color: c.text }), 40, 156, undefined, 'name');
        cell(kit.text(d.coords ? 'Detected' : 'Not Detected', { color: d.coords ? LIGHT_GREEN : GRAY }), 198, 70, undefined, 'detected');
      });
      checkbox(rp, 'Automatically detect portal devices at mansion', s.autoDetectPortalDevices, 4, 202 - GOARROW_TAB_ROW, () => model.host.saveSettings({ autoDetectPortalDevices: !s.autoDetectPortalDevices }));
    }
  } else {
    label(p, `GoArrow v${GOARROW_VERSION}`, 8, 8, { bold: true, w: 256, align: 'center' });
    label(p, 'VVS edition by Virindi', 8, 24, { w: 256, align: 'center' });
    label(p, 'Updated by Kimseth (HG)', 8, 36, { w: 256, align: 'center' });
    label(p, 'Locations database generated from', 40, 66, { bold: true, w: 192, align: 'center' });
    label(p, "this world's own data", 48, 82, { w: 176, align: 'center' });
    label(p, `Type '${cmd} help' to see chat commands`, 8, 240, { italic: true, w: 256, align: 'center' });
  }
}

function tag<T extends HTMLElement>(e: T, data: Record<string, string>): T {
  for (const [k, v] of Object.entries(data)) e.dataset[k] = v;
  return e;
}
