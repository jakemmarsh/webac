/**
 * GoArrow's main window, its state and actions without the DOM (docs/plugin-specs/goarrow.md §2, §3, §4,
 * §7). GoArrowWindow.ts draws it with the VVS kit; tests drive this directly. Clean room: our own code
 * from the spec's facts; labels and messages are GoArrow's (they are facts about the interface).
 *
 * Left out (see GoArrowWindow.ts): the Dereth and Dungeon map tabs, the Update tab, the HUD toolbar's
 * options, and the Details tab's Locate on Map / Dungeon Map buttons.
 */
import {
  GOARROW_COORDS_NONE,
  GOARROW_DEFAULT_SETTINGS,
  GOARROW_HUD_DEFAULT_POSITION,
  GOARROW_HUDS_RESET_MESSAGE,
  GOARROW_INVALID_COORDS_MESSAGE,
  GOARROW_INVALID_END_MESSAGE,
  GOARROW_INVALID_NEARBY_MESSAGE,
  GOARROW_INVALID_RADIUS_MESSAGE,
  GOARROW_LIMIT_TO,
  GOARROW_NO_MORE_ROUTES_MESSAGE,
  GOARROW_NO_ROUTE_LABEL,
  GOARROW_NO_ROUTE_MESSAGE,
  GOARROW_NO_SEARCH_MESSAGE,
  GOARROW_RECENT_COORDS_ICON,
  GOARROW_RESET_POSITION_MESSAGE,
  GOARROW_ROUTE_COPY_EMPTY_MESSAGE,
  GOARROW_ROUTE_COPY_PARTIAL_MESSAGE,
  GOARROW_TEXT_SIZE_MAX,
  GOARROW_TEXT_SIZE_MIN,
  GO_ANY_LOCATION,
  GO_ANY_PORTAL,
  GoLocationType,
  GoRouteSearch,
  formatGoCoords,
  formatGoCoordsFixed,
  formatGoRouteDistance,
  goCommandNameError,
  goFindLocationAt,
  goLetterBucket,
  goLocationIcon,
  goParseTextSize,
  goRouteCopyText,
  goSearchLocations,
  goTemporaryPoint,
  parseGoCoords,
  type GoArrowSettings,
  type GoArrowTarget,
  type GoCoords,
  type GoLocation,
  type GoPortalDevice,
  type GoRegionMap,
  type GoRoute,
  type GoSearchIn,
  type GoStartLocation,
  type GoUndergroundPortal,
} from '@ac/shared';

export type GoTopTab = 'HUDs' | 'Atlas' | 'Settings';
export type GoHudsTab = 'Arrow' | 'General';
export type GoAtlasTab = 'Search' | 'Route' | 'Details' | 'Favorites' | 'Recent';
export type GoSettingsTab = 'Chat' | 'Route Finding' | 'About';
export type GoDetailsTab = 'Description' | 'Modify/Add Location' | 'Delete...';
export type GoRouteSettingsTab = 'Start Locations' | 'Portal Devices';

/** The window's client size per top tab (spec §2: HUDs 216 × 280, Atlas and Settings 272 × 338). */
export const GOARROW_WINDOW_SIZES: Readonly<Record<GoTopTab, { w: number; h: number }>> = {
  HUDs: { w: 216, h: 280 },
  Atlas: { w: 272, h: 338 },
  Settings: { w: 272, h: 338 },
};
/** The Details tab's Minimize shrinks the window to this height (spec §2). */
export const GOARROW_DETAILS_MINIMIZED_HEIGHT = 136;
/** A VVS frame around a client area (the host's windows: + 12 wide, + 35 tall). */
export const VVS_FRAME_EXTRA = { w: 12, h: 35 } as const;
/** "Relative Coordinates" refresh every second while the Atlas tab is open (spec §2.6). */
export const GOARROW_RELATIVE_REFRESH_MS = 1000;
/** Recent lists keep this many entries, newest first (spec §2.6 Recent). */
export const GOARROW_MAX_RECENT = 15;
/** Details > Description wraps at this many characters (spec §2.6 Details). */
export const GOARROW_DESCRIPTION_WRAP = 42;

/** The window's settings: GoArrow's (core) plus the HUDs > General and Settings > Chat options (spec §2.5, §2.7, §7). */
export type GoArrowWindowSettings = GoArrowSettings & {
  /** "Active Opacity:" / "Inactive Opacity:" 0–255 (inactive ≥ 64, active ≥ inactive). */
  alphaActive: number;
  alphaInactive: number;
  /** "Display GoArrow messages in:": 0 = Main Chat, 1–4 the floating chat windows. */
  outputWindows: number[];
  /** "Always show errors in Main Chat". */
  alwaysShowErrors: boolean;
};

export const GOARROW_WINDOW_DEFAULT_SETTINGS: Readonly<GoArrowWindowSettings> = Object.freeze({
  ...GOARROW_DEFAULT_SETTINGS,
  alphaActive: 255,
  alphaInactive: 255,
  outputWindows: [0],
  alwaysShowErrors: true,
});

/** The "Inactive Opacity:" floor (spec §2.5). */
export const GOARROW_INACTIVE_OPACITY_MIN = 64;

/** One "Recent Arrow Coordinates" row (spec §2.6 Recent). */
export interface GoRecentCoords {
  name: string;
  coords: GoCoords;
  icon: number;
  /** The location it named, when it named one. */
  locationId?: number;
}

/** Where favourites and recents are kept (browser storage, per character; the host decides). */
export interface GoArrowListStore {
  load(key: 'favorites' | 'recentLocations' | 'recentCoords'): unknown;
  save(key: 'favorites' | 'recentLocations' | 'recentCoords', value: unknown): void;
}

/** What GoArrow's window reads and drives. GameUI implements it; tests fake it. */
export interface GoArrowWindowHost {
  settings(): GoArrowWindowSettings;
  saveSettings(patch: Partial<GoArrowWindowSettings>): void;
  /** Every location: the era's generated database plus the player's own. */
  locations(): readonly GoLocation[];
  /** The route finder's world (the era's data: underground portals, islands). */
  routeWorld(): { locations: Iterable<GoLocation>; underground?: Iterable<GoUndergroundPortal>; regions: GoRegionMap };
  startLocations(): GoStartLocation[];
  saveStartLocations(list: GoStartLocation[]): void;
  portalDevices(): GoPortalDevice[];
  savePortalDevices(list: GoPortalDevice[]): void;
  /** The player's position now, null out of the world. */
  player(): GoCoords | null;
  /** Drops portals the server would refuse (optional; GoArrow itself uses every portal). */
  playerLevel?(): number | undefined;
  arrowTarget(): GoArrowTarget | null;
  /** Point the arrow (and show it: "go" actions switch it on, spec §1.5). */
  setArrowTarget(t: GoArrowTarget): void;
  /** The HUD's "enabled but not visible" reason (ArrowHud.hiddenReason), if any. */
  arrowHiddenReason?(): string | null;
  store: GoArrowListStore;
  /** A GoArrow chat line (the host adds the `<{ GoArrow }> ` prefix and picks the windows). */
  say(text: string, kind?: 'message' | 'help' | 'warning' | 'error'): void;
  /** The clipboard. */
  copy(text: string): void;
  /** The window's frame size changed (per top tab; Details' Minimize). */
  resize(w: number, h: number): void;
  /** "Reset All HUD Positions": the arrow (and any other GoArrow HUD) back to its default place. */
  resetHudPositions?(): void;
  /** Modify (asNew false) or Save As New (true); returns the stored location, or null when it can't be. */
  saveLocation?(loc: GoLocation, asNew: boolean): GoLocation | null;
  /** Delete a location; false when it can't be deleted. */
  deleteLocation?(loc: GoLocation): boolean;
}

/** A route end in the Route tab: the letter and name dropdowns, the coords edit and Here. */
export interface GoRouteEnd {
  letter: string;
  /** The picked location's id; null = `<Custom>`. */
  locationId: number | null;
  coordsText: string;
  here: boolean;
}

export interface GoModifyFields {
  name: string;
  coords: string;
  exit: string;
  type: number;
  useInRoute: boolean;
  descr: string;
}

/** List row modifiers (spec §2.6): Ctrl sets the route end, Shift the route start. */
export interface GoClickMods { ctrl?: boolean; shift?: boolean }

const MAX_RUN_MESSAGE = 'Invalid maximum run distance';
const PORTAL_RUN_MESSAGE = 'Invalid portal run distance';
const START_COORDS_MESSAGE = 'Invalid coordinates';
const START_RUN_MESSAGE = 'Invalid run distance';
const START_DELETE_CTRL_MESSAGE = 'You must hold down Ctrl while clicking to delete a start location';

/** Word-wrap the description at `width` characters (spec §2.6 Details). */
export function goWrapDescription(text: string, width = GOARROW_DESCRIPTION_WRAP): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

/** The text coords of a location for the lists (`0.0`), or `<None>`. */
export const goListCoords = (c: GoCoords | null | undefined): string => (c ? formatGoCoordsFixed(c, 1) : GOARROW_COORDS_NONE);

/** The "Limit to" dropdown's labels and types (spec §3.3), and the Modify Type dropdown (without the composites). */
export const GOARROW_MODIFY_TYPES = GOARROW_LIMIT_TO.filter((t) => t.type !== GO_ANY_LOCATION && t.type !== GO_ANY_PORTAL);

export class GoArrowModel {
  top: GoTopTab = 'Atlas';
  hudsTab: GoHudsTab = 'Arrow';
  atlasTab: GoAtlasTab = 'Search';
  settingsTab: GoSettingsTab = 'Chat';
  detailsTab: GoDetailsTab = 'Description';
  routeSettingsTab: GoRouteSettingsTab = 'Start Locations';
  detailsMinimized = false;

  // HUDs > Arrow
  arrowCoordsText: string | null = null;
  textSizeText: string | null = null;

  // Atlas > Search
  searchText = true;
  searchNearby = false;
  searchName = '';
  searchIn: GoSearchIn = 'Name';
  searchRadius = '5';
  searchCoords = 'Enter Coords';
  searchLimit: number = GO_ANY_LOCATION;
  results: GoLocation[] = [];

  // "Relative Coordinates" per list
  relative = { search: false, route: false, favorites: false, recent: false };

  // Atlas > Route
  from: GoRouteEnd = { letter: '#', locationId: null, coordsText: '', here: true };
  to: GoRouteEnd = { letter: '#', locationId: null, coordsText: '', here: false };
  route: GoRoute | null = null;
  routeLabel = '0 km';
  private routeSearch: GoRouteSearch | null = null;
  private copyFrom = 0;

  // Atlas > Details
  selected: GoLocation | null = null;
  modify: GoModifyFields = { name: 'Location Name', coords: '0.0N, 0.0E', exit: '0.0N, 0.0E', type: GoLocationType.Custom, useInRoute: false, descr: '' };

  // Settings > Route Finding > Start Locations editor
  startEdit: { index: number | null; name: string; runDist: string; coords: string } = { index: null, name: '', runDist: '', coords: '' };

  constructor(readonly host: GoArrowWindowHost) {}

  // ── window and tabs ──

  /** The frame size for the current top tab (and Details' Minimize). */
  frameSize(): { w: number; h: number } {
    const s = GOARROW_WINDOW_SIZES[this.top];
    const h = this.top === 'Atlas' && this.atlasTab === 'Details' && this.detailsMinimized ? GOARROW_DETAILS_MINIMIZED_HEIGHT : s.h;
    return { w: s.w + VVS_FRAME_EXTRA.w, h: h + VVS_FRAME_EXTRA.h };
  }

  setTop(tab: GoTopTab): void {
    this.top = tab;
    this.resize();
  }

  setAtlasTab(tab: GoAtlasTab): void {
    this.atlasTab = tab;
    this.resize();
  }

  toggleMinimize(): void {
    this.detailsMinimized = !this.detailsMinimized;
    this.resize();
  }

  private resize(): void {
    const f = this.frameSize();
    this.host.resize(f.w, f.h);
  }

  /** Whether the open tab shows relative coordinates that need the 1 s refresh. */
  needsRelativeRefresh(): boolean {
    if (this.top !== 'Atlas') return false;
    const r = this.relative;
    return (this.atlasTab === 'Search' && r.search) || (this.atlasTab === 'Route' && r.route) || (this.atlasTab === 'Favorites' && r.favorites)
      || (this.atlasTab === 'Recent' && r.recent) || this.atlasTab === 'Details';
  }

  // ── favourites and recents ──

  favoriteIds(): number[] {
    const v = this.host.store.load('favorites');
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [];
  }

  /** A location as the lists show it: its favourite flag set from the store. */
  decorate(loc: GoLocation): GoLocation {
    const fav = this.favoriteIds().includes(loc.id);
    return fav === !!loc.isFavorite ? loc : { ...loc, isFavorite: fav };
  }

  locationById(id: number): GoLocation | null {
    return this.host.locations().find((l) => l.id === id) ?? (this.selected?.id === id ? this.selected : null);
  }

  favorites(): GoLocation[] {
    return this.favoriteIds().map((id) => this.locationById(id)).filter((l): l is GoLocation => !!l).map((l) => ({ ...l, isFavorite: true }));
  }

  recentLocations(): GoLocation[] {
    const v = this.host.store.load('recentLocations');
    const ids = Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [];
    return ids.map((id) => this.locationById(id)).filter((l): l is GoLocation => !!l).map((l) => this.decorate(l));
  }

  recentCoords(): GoRecentCoords[] {
    const v = this.host.store.load('recentCoords');
    if (!Array.isArray(v)) return [];
    return v.filter((r): r is GoRecentCoords => !!r && typeof r === 'object' && typeof (r as GoRecentCoords).name === 'string'
      && !!(r as GoRecentCoords).coords && typeof (r as GoRecentCoords).coords.ns === 'number' && typeof (r as GoRecentCoords).coords.ew === 'number');
  }

  private noteRecentLocation(loc: GoLocation): void {
    if (loc.id < 0) return;
    const v = this.host.store.load('recentLocations');
    const ids = (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : []).filter((id) => id !== loc.id);
    this.host.store.save('recentLocations', [loc.id, ...ids].slice(0, GOARROW_MAX_RECENT));
  }

  /** Add a "Recent Arrow Coordinates" row for a destination (spec §1.6: every destination change). */
  noteDestination(t: GoArrowTarget): void {
    let row: GoRecentCoords | null = null;
    if (t.kind === 'coords') row = { name: formatGoCoords(t.coords), coords: t.coords, icon: GOARROW_RECENT_COORDS_ICON };
    else if (t.kind === 'location' && t.coords) {
      const loc = this.host.locations().find((l) => l.name === t.name && l.coords && l.coords.ns === t.coords!.ns && l.coords.ew === t.coords!.ew);
      row = { name: t.name, coords: t.coords, icon: loc ? goLocationIcon(loc) : GOARROW_RECENT_COORDS_ICON, ...(loc ? { locationId: loc.id } : {}) };
    } else if (t.kind === 'route' && t.coords[t.index]) row = { name: t.names[t.index] ?? '', coords: t.coords[t.index]!, icon: GOARROW_RECENT_COORDS_ICON };
    else if (t.kind === 'object' && t.coords) row = { name: t.name, coords: t.coords, icon: GOARROW_RECENT_COORDS_ICON };
    if (!row) return;
    const rest = this.recentCoords().filter((r) => !(r.name === row!.name && r.coords.ns === row!.coords.ns && r.coords.ew === row!.coords.ew));
    this.host.store.save('recentCoords', [row, ...rest].slice(0, GOARROW_MAX_RECENT));
  }

  removeRecentLocation(id: number): void {
    const v = this.host.store.load('recentLocations');
    const ids = Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [];
    this.host.store.save('recentLocations', ids.filter((x) => x !== id));
  }

  removeRecentCoords(index: number): void {
    const rows = this.recentCoords();
    rows.splice(index, 1);
    this.host.store.save('recentCoords', rows);
  }

  // ── pointing the arrow ──

  private point(t: GoArrowTarget): void {
    this.host.setArrowTarget(t);
    this.noteDestination(t);
  }

  /** A list's go icon (spec §2.6): target the location and show the arrow. */
  goLocation(loc: GoLocation): void {
    if (!loc.coords) return;
    this.noteRecentLocation(loc);
    this.point({ kind: 'location', name: loc.name, coords: loc.coords });
  }

  /** Entered coordinates (spec §1.6): a known location within 0.049 becomes a location target. */
  goCoords(coords: GoCoords): void {
    const loc = goFindLocationAt(this.host.locations(), coords);
    if (loc) this.goLocation(loc);
    else this.point({ kind: 'coords', coords });
  }

  /** The Route tab's go icon: route mode at that step. */
  goRouteStep(index: number): void {
    const r = this.route;
    if (!r || !r.steps[index]) return;
    this.point({ kind: 'route', names: r.steps.map((s) => s.location.name), coords: r.steps.map((s) => s.coords), index });
  }

  /** A Recent Arrow Coordinates row: target it (Ctrl: route end, Shift: route start). */
  clickRecentCoords(row: GoRecentCoords, mods: GoClickMods = {}): void {
    if (mods.ctrl) { this.setRouteEndCoords('to', row.coords, row.locationId); return; }
    if (mods.shift) { this.setRouteEndCoords('from', row.coords, row.locationId); return; }
    const loc = row.locationId !== undefined ? this.locationById(row.locationId) : null;
    if (loc) this.goLocation(loc);
    else this.point({ kind: 'coords', coords: row.coords });
  }

  // ── HUDs > Arrow ──

  /** The Coords edit's text: what the player is typing, else the current destination. */
  arrowCoordsShown(): string {
    if (this.arrowCoordsText !== null) return this.arrowCoordsText;
    const t = this.host.arrowTarget();
    const c = !t ? null : t.kind === 'route' ? t.coords[t.index] ?? null : t.coords;
    return c ? formatGoCoords(c) : '';
  }

  /** Enter in the Coords edit. */
  applyArrowCoords(text: string): void {
    const c = parseGoCoords(text);
    if (!c) { this.host.say(GOARROW_INVALID_COORDS_MESSAGE, 'error'); return; }
    this.arrowCoordsText = null;
    this.goCoords(c);
  }

  /** Here: the destination becomes the player's position. */
  arrowHere(): void {
    const p = this.host.player();
    if (!p) return;
    this.arrowCoordsText = null;
    this.goCoords(p);
  }

  setShowArrow(on: boolean): void {
    this.host.saveSettings({ visible: on });
    if (on) {
      const why = this.host.arrowHiddenReason?.();
      if (why) this.host.say(why, 'warning');
    }
  }

  textSizeShown(): string {
    return this.textSizeText ?? String(this.host.settings().textSize);
  }

  applyTextSize(text: string): void {
    const r = goParseTextSize(text);
    if ('error' in r) { this.host.say(r.error, 'error'); return; }
    this.textSizeText = null;
    this.host.saveSettings({ textSize: r.size });
  }

  bumpTextSize(delta: 1 | -1): void {
    const n = Math.max(GOARROW_TEXT_SIZE_MIN, Math.min(GOARROW_TEXT_SIZE_MAX, this.host.settings().textSize + delta));
    this.textSizeText = null;
    this.host.saveSettings({ textSize: n });
  }

  resetArrowPosition(): void {
    this.host.saveSettings({ location: { ...GOARROW_HUD_DEFAULT_POSITION } });
    this.host.say(GOARROW_RESET_POSITION_MESSAGE);
  }

  // ── HUDs > General ──

  /** The opacity sliders (spec §2.5): inactive at least 64, active at least inactive. */
  setOpacity(which: 'active' | 'inactive', v: number): void {
    const s = this.host.settings();
    let active = which === 'active' ? v : s.alphaActive;
    let inactive = which === 'inactive' ? v : s.alphaInactive;
    inactive = Math.max(GOARROW_INACTIVE_OPACITY_MIN, Math.min(255, Math.round(inactive)));
    active = Math.max(inactive, Math.min(255, Math.round(active)));
    this.host.saveSettings({ alphaActive: active, alphaInactive: inactive });
  }

  resetHudPositions(): void {
    if (this.host.resetHudPositions) this.host.resetHudPositions();
    else this.host.saveSettings({ location: { ...GOARROW_HUD_DEFAULT_POSITION } });
    this.host.say(GOARROW_HUDS_RESET_MESSAGE);
  }

  // ── Atlas > Search ──

  /** The Text / Nearby checkboxes keep at least one on; Ctrl+click makes one exclusive (spec §3.3). */
  clickSearchKind(which: 'text' | 'nearby', ctrl = false): void {
    if (ctrl) { this.searchText = which === 'text'; this.searchNearby = which === 'nearby'; return; }
    if (which === 'text') { this.searchText = !this.searchText; if (!this.searchText && !this.searchNearby) this.searchNearby = true; } else { this.searchNearby = !this.searchNearby; if (!this.searchText && !this.searchNearby) this.searchText = true; }
  }

  searchHere(): void {
    const p = this.host.player();
    if (p) this.searchCoords = formatGoCoords(p);
  }

  /** The Search button. */
  search(): void {
    if (!this.searchText && !this.searchNearby) { this.host.say(GOARROW_NO_SEARCH_MESSAGE, 'error'); return; }
    let near: { coords: GoCoords; radius: number } | null = null;
    if (this.searchNearby) {
      const radius = Number(this.searchRadius.trim());
      if (!this.searchRadius.trim() || !Number.isFinite(radius) || radius <= 0) { this.host.say(GOARROW_INVALID_RADIUS_MESSAGE, 'error'); return; }
      const c = parseGoCoords(this.searchCoords);
      if (!c) { this.host.say(GOARROW_INVALID_NEARBY_MESSAGE, 'error'); return; }
      near = { coords: c, radius };
    }
    this.results = goSearchLocations(this.host.locations(), { text: this.searchText ? this.searchName : null, searchIn: this.searchIn, near, type: this.searchLimit });
  }

  /** `/goarrow search <text>` (spec §6.2): fills the tab and runs it. */
  commandSearch(text: string | null): void {
    this.top = 'Atlas';
    this.atlasTab = 'Search';
    if (text) {
      this.searchName = text;
      this.searchText = true;
      this.searchNearby = false;
      this.searchLimit = GO_ANY_LOCATION;
      this.search();
    }
    this.resize();
  }

  /** A list row's name or coords (spec §2.6): Details; Ctrl = route end; Shift = route start. */
  clickLocation(loc: GoLocation, mods: GoClickMods = {}): void {
    if (mods.ctrl) { this.setRouteEndLocation('to', loc); return; }
    if (mods.shift) { this.setRouteEndLocation('from', loc); return; }
    this.showDetails(loc);
  }

  /** A row's type icon: removes the row (Favorites: only with Ctrl; spec §2.6). */
  clickIcon(list: 'search' | 'route' | 'favorites' | 'recent', index: number, mods: GoClickMods = {}): void {
    if (list === 'search') this.results.splice(index, 1);
    else if (list === 'route') {
      this.route?.steps.splice(index, 1);
    } else if (list === 'favorites') {
      if (!mods.ctrl) return;
      const fav = this.favorites()[index];
      if (fav) this.host.store.save('favorites', this.favoriteIds().filter((id) => id !== fav.id));
    } else {
      const loc = this.recentLocations()[index];
      if (loc) this.removeRecentLocation(loc.id);
    }
  }

  // ── Atlas > Route ──

  /** The name dropdown's choices for a letter: `<Custom>`, then every location under that letter. */
  routeChoices(letter: string): GoLocation[] {
    return goSearchLocations(this.host.locations(), {}).filter((l) => goLetterBucket(l.name) === letter && l.coords);
  }

  routeEnd(which: 'from' | 'to'): GoRouteEnd {
    return which === 'from' ? this.from : this.to;
  }

  /** The coords edit's text (the player's position while Here is on). */
  routeCoordsShown(which: 'from' | 'to'): string {
    const e = this.routeEnd(which);
    if (e.here) { const p = this.host.player(); return p ? formatGoCoords(p) : ''; }
    return e.coordsText;
  }

  pickRouteLocation(which: 'from' | 'to', id: number | null): void {
    const e = this.routeEnd(which);
    e.locationId = id;
    const loc = id === null ? null : this.locationById(id);
    if (loc?.coords) { e.coordsText = formatGoCoords(loc.coords); e.here = false; }
  }

  setRouteEndLocation(which: 'from' | 'to', loc: GoLocation): void {
    if (!loc.coords) return;
    this.setRouteEndCoords(which, loc.coords, loc.id >= 0 ? loc.id : undefined);
  }

  /** Route start / end from a list, Details or a chat link (opens Atlas > Route). */
  setRouteEndCoords(which: 'from' | 'to', coords: GoCoords, locationId?: number): void {
    const e = this.routeEnd(which);
    const loc = locationId !== undefined ? this.locationById(locationId) : null;
    e.locationId = loc ? loc.id : null;
    e.letter = loc ? goLetterBucket(loc.name) : e.letter;
    e.coordsText = formatGoCoords(coords);
    e.here = false;
    this.top = 'Atlas';
    this.atlasTab = 'Route';
    this.resize();
  }

  private routePoint(which: 'from' | 'to'): GoLocation | null | 'invalid' {
    const e = this.routeEnd(which);
    const text = this.routeCoordsShown(which);
    if (!text.trim()) return null;
    const c = parseGoCoords(text);
    if (!c) return 'invalid';
    const loc = e.locationId !== null ? this.locationById(e.locationId) : null;
    if (loc?.coords && Math.abs(loc.coords.ns - c.ns) < 1e-6 && Math.abs(loc.coords.ew - c.ew) < 1e-6) return loc;
    return goTemporaryPoint(which === 'from' ? 'start' : 'end', c);
  }

  /** Find Route (spec §4.2). */
  findRoute(): void {
    const to = this.routePoint('to');
    if (!to || to === 'invalid') { this.host.say(GOARROW_INVALID_END_MESSAGE, 'error'); return; }
    const fromPoint = this.routePoint('from');
    const from = fromPoint === 'invalid' ? null : fromPoint;
    const s = this.host.settings();
    const starts = this.host.startLocations();
    const mansion = starts.find((x) => x.kind === 'MansionRecall');
    const level = this.host.playerLevel?.();
    this.routeSearch = new GoRouteSearch(this.host.routeWorld(), starts, this.host.portalDevices(), from, to, {
      portalWeight: s.portalRunDistance,
      maxRunDistance: s.maxRunDistance,
      mansionRunDistance: mansion?.runDistance ?? 1,
      ...(level !== undefined ? { playerLevel: level } : {}),
    });
    this.copyFrom = 0;
    this.showRoute(this.routeSearch.next(), GOARROW_NO_ROUTE_MESSAGE);
  }

  /** Next longer: the same search, the next start (spec §4.2). */
  nextLonger(): void {
    if (!this.routeSearch) { this.host.say(GOARROW_NO_MORE_ROUTES_MESSAGE, 'warning'); return; }
    this.copyFrom = 0;
    this.showRoute(this.routeSearch.next(), GOARROW_NO_MORE_ROUTES_MESSAGE);
  }

  private showRoute(route: GoRoute | null, failure: string): void {
    this.route = route;
    if (!route) { this.routeLabel = GOARROW_NO_ROUTE_LABEL; this.host.say(failure, 'warning'); return; }
    this.routeLabel = formatGoRouteDistance(route.distance);
  }

  /** Copy (spec §4.5): 225 characters at a time. */
  copyRoute(): void {
    const r = this.route;
    if (!r || !r.steps.length) { this.host.say(GOARROW_ROUTE_COPY_EMPTY_MESSAGE, 'warning'); return; }
    const { text, next } = goRouteCopyText(r, this.copyFrom < r.steps.length ? this.copyFrom : 0);
    this.host.copy(text);
    this.copyFrom = next ?? 0;
    if (next !== null) this.host.say(GOARROW_ROUTE_COPY_PARTIAL_MESSAGE);
  }

  // ── Atlas > Details ──

  showDetails(loc: GoLocation): void {
    this.selected = loc;
    this.resetModify();
    this.noteRecentLocation(loc);
    this.top = 'Atlas';
    this.atlasTab = 'Details';
    this.resize();
  }

  resetModify(): void {
    const l = this.selected;
    this.modify = l
      ? { name: l.name, coords: l.coords ? formatGoCoords(l.coords) : '', exit: l.exitCoords ? formatGoCoords(l.exitCoords) : '', type: l.type, useInRoute: l.useInRouteFinding, descr: l.notes }
      : { name: 'Location Name', coords: '0.0N, 0.0E', exit: '0.0N, 0.0E', type: GoLocationType.Custom, useInRoute: false, descr: '' };
  }

  private needSelected(): GoLocation | null {
    if (!this.selected) this.host.say('Select a location first', 'error');
    return this.selected;
  }

  detailsCopy(): void {
    const l = this.needSelected();
    if (l?.coords) this.host.copy(`${l.name} [${formatGoCoordsFixed(l.coords, 1)}]`);
  }

  detailsRouteStart(): void { const l = this.needSelected(); if (l) this.setRouteEndLocation('from', l); }
  detailsRouteEnd(): void { const l = this.needSelected(); if (l) this.setRouteEndLocation('to', l); }
  detailsArrowTarget(): void { const l = this.needSelected(); if (l) this.goLocation(l); }

  addFavorite(): void {
    const l = this.needSelected();
    if (!l) return;
    if (l.id < 0) { this.host.say('This location cannot be added as a favorite', 'error'); return; }
    const ids = this.favoriteIds();
    if (ids.includes(l.id)) { this.host.say(`${l.name} is already in your favorites list`, 'warning'); return; }
    this.host.store.save('favorites', [...ids, l.id]);
  }

  /** Modify (asNew false) or Save As New (true), spec §2.6 Details' messages. */
  saveModified(asNew: boolean): void {
    if (!this.host.saveLocation) return;
    const base = this.selected;
    if (!asNew && !base) { this.host.say('You must select a location before modifying it', 'error'); return; }
    const f = this.modify;
    const coords = parseGoCoords(f.coords);
    if (!coords) { this.host.say(`Invalid location coordinates: ${f.coords}`, 'error'); return; }
    let exit: GoCoords | null = null;
    if (f.exit.trim() && f.exit.trim() !== GOARROW_COORDS_NONE) {
      exit = parseGoCoords(f.exit);
      if (!exit) { this.host.say(`Invalid exit coordinates: ${f.exit}`, 'error'); return; }
    }
    if (f.useInRoute && !exit) this.host.say('In order to be used in route finding, a location must have exit coordinates', 'warning');
    const loc: GoLocation = {
      ...(base && !asNew ? base : {}),
      id: base && !asNew ? base.id : -1,
      name: f.name,
      type: f.type,
      coords,
      exitCoords: exit,
      notes: f.descr,
      useInRouteFinding: f.useInRoute && !!exit,
      isCustomized: true,
    };
    const saved = this.host.saveLocation(loc, asNew);
    if (!saved) { this.host.say('This location cannot be modified', 'error'); return; }
    this.selected = saved;
    this.resetModify();
    this.host.say(asNew ? `The new location ${saved.name} has been added to the locations database` : `The location ${saved.name} has been successfully modified`);
  }

  /** Delete (needs Ctrl, spec §2.6). */
  deleteSelected(ctrl: boolean): void {
    if (!this.host.deleteLocation) return;
    const l = this.selected;
    if (!l) { this.host.say('You must select a location to delete it', 'error'); return; }
    if (!ctrl) { this.host.say('You must hold down the control key while clicking to delete a location', 'error'); return; }
    if (!this.host.deleteLocation(l)) { this.host.say('This location cannot be deleted', 'error'); return; }
    this.host.say(`The location ${l.name} has been successfully removed from the database`);
    this.results = this.results.filter((r) => r.id !== l.id);
    this.selected = null;
    this.resetModify();
  }

  // ── Settings > Chat ──

  /** Rename a chat command (Enter in its edit); null on success, else the message said. */
  renameCommand(kind: 'main' | 'loc' | 'dest' | 'find', name: string): string | null {
    const s = this.host.settings();
    const names = { main: s.chatCommand, loc: s.locAlias.name, dest: s.destAlias.name, find: s.findAlias.name };
    const err = goCommandNameError(kind, name, names);
    if (err) { this.host.say(err, 'error'); return err; }
    const n = name.trim();
    if (kind === 'main') this.host.saveSettings({ chatCommand: n });
    else if (kind === 'loc') this.host.saveSettings({ locAlias: { ...s.locAlias, name: n } });
    else if (kind === 'dest') this.host.saveSettings({ destAlias: { ...s.destAlias, name: n } });
    else this.host.saveSettings({ findAlias: { ...s.findAlias, name: n } });
    return null;
  }

  toggleOutput(win: number): void {
    const cur = this.host.settings().outputWindows;
    const next = cur.includes(win) ? cur.filter((w) => w !== win) : [...cur, win].sort();
    this.host.saveSettings({ outputWindows: next });
  }

  // ── Settings > Route Finding ──

  applyRunDistance(which: 'max' | 'portal', text: string): void {
    const n = Number(text.trim());
    if (!text.trim() || !Number.isFinite(n) || n < 0 || (which === 'max' && n <= 0)) { this.host.say(which === 'max' ? MAX_RUN_MESSAGE : PORTAL_RUN_MESSAGE, 'error'); return; }
    this.host.saveSettings(which === 'max' ? { maxRunDistance: n } : { portalRunDistance: n });
  }

  toggleStart(index: number): void {
    const list = this.host.startLocations().map((s) => ({ ...s }));
    const s = list[index];
    if (!s) return;
    s.enabled = !s.enabled;
    this.host.saveStartLocations(list);
  }

  editStart(index: number): void {
    const s = this.host.startLocations()[index];
    if (!s) return;
    this.startEdit = { index, name: s.name, runDist: String(s.runDistance), coords: s.coords ? formatGoCoords(s.coords) : '' };
  }

  startHere(): void {
    const p = this.host.player();
    if (p) this.startEdit.coords = formatGoCoords(p);
  }

  /** Add / Modify in the start-location editor. */
  saveStart(): void {
    const e = this.startEdit;
    const coords = e.coords.trim() ? parseGoCoords(e.coords) : null;
    if (e.coords.trim() && !coords) { this.host.say(START_COORDS_MESSAGE, 'error'); return; }
    const run = Number(e.runDist.trim());
    if (!e.runDist.trim() || !Number.isFinite(run) || run < 0) { this.host.say(START_RUN_MESSAGE, 'error'); return; }
    const list = this.host.startLocations().map((s) => ({ ...s }));
    const at = e.index !== null ? list[e.index] : undefined;
    if (at) {
      at.name = at.kind === 'Regular' ? e.name.trim() || at.name : at.name;
      at.runDistance = run;
      at.coords = coords;
    } else {
      if (!coords) { this.host.say(START_COORDS_MESSAGE, 'error'); return; }
      list.push({ name: e.name.trim() || formatGoCoords(coords), kind: 'Regular', coords, runDistance: run, enabled: true, icon: 0x06001f88 });
    }
    this.host.saveStartLocations(list);
    this.startEdit = { index: null, name: '', runDist: '', coords: '' };
  }

  /** The delete icon on a Regular row: needs Ctrl (spec §4.3). */
  deleteStart(index: number, ctrl: boolean): void {
    const list = this.host.startLocations();
    if (list[index]?.kind !== 'Regular') return;
    if (!ctrl) { this.host.say(START_DELETE_CTRL_MESSAGE, 'error'); return; }
    this.host.saveStartLocations(list.filter((_, i) => i !== index));
    if (this.startEdit.index === index) this.startEdit = { index: null, name: '', runDist: '', coords: '' };
  }

  toggleDevice(index: number): void {
    const list = this.host.portalDevices().map((d) => ({ ...d }));
    const d = list[index];
    if (!d) return;
    d.enabled = !d.enabled;
    this.host.savePortalDevices(list);
  }
}
