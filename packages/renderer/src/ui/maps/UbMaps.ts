/**
 * UtilityBelt's Dungeon Maps and Landscape Maps windows (docs/vtank-parity-gaps.md §11.7; UtilityBelt is MIT,
 * ported from 5fe9825a: Tools/DungeonMaps.cs, Tools/LandscapeMaps.cs, Views/DungeonMapsView.xml,
 * Views/LandscapeMapsView.xml). Not retail UI: UB's own plugin windows, opt-in (Jake, 2026-10-12). Nothing
 * opens until the player asks (`/ub dungeonmaps`, `/ub landscapemaps`, or the window's entry in Decal's
 * bar, there while DungeonMaps.Enabled / LandscapeMaps.Enabled is on); the retail map panel is untouched.
 *
 * The windows are drawn with the automation window's kit (VVS's frame, tabs, buttons and slider from
 * portal.dat art, VVS's Times New Roman: automation/vvsText.ts); the map is drawn into a canvas inside, as UB
 * draws into a DxHud, its labels in VVS's font too (UB reads the theme's DefaultTextFontFace).
 * Both redraw only when what they show changed, looked at ten times a second while a window is open, and
 * cost nothing while closed (no timer, no listeners).
 *
 * What UB has that isn't here: lifestoned.org's spawn data (UB's legend of a manually loaded dungeon's
 * monsters, door / lever link tags, lock difficulties), UB's own compass and arrow PNGs (a text "N" and the
 * retail map's player icon stand in), and resizing a window by its edge (MapWindowWidth /
 * Height set the size; reopen to apply).
 */
import type { VTankKit } from '../automation/VTankWindow.js';
import { argbBytes, argbCss, type UbMapSettings } from './ubMapSettings.js';
import {
  buildDungeonMap, isDungeonCell, layerOf, layerTint, markerClassOf, markerLabel, zFromSlider, zSliderPosition,
  type DungeonMap, type DungeonMapSource, type DungeonPolyKind,
} from './dungeonMapModel.js';
import {
  coordText, coordinateIncrement, coordsToPixel, labelCandidates, landscapeScale, LANDSCAPE_MARKER_OPTIONS, placeLabel,
  pixelToCoords, terrainPalette, TerrainMapBuilder, TERRAIN_MAP_SIZE, type LandblockTerrain, type MapTable,
} from './landscapeMapModel.js';

export type UbMapWhich = 'dungeon' | 'landscape';

export interface UbMapSelf { guid: number; name: string; cell: number; x: number; y: number; z: number; heading: number }
export interface UbMapObject { guid: number; name: string; objectClass: number; cell: number; x: number; y: number; z: number; icon?: number }
/** `loops`: a circular or linear route (UB draws a lone point of one as its sticky point); `current`: the point walked to next (−1 none). */
export interface UbMapRoute { points: Array<{ x: number; y: number; z: number | null }>; loops: boolean; current: number }

/** The game side (main.ts over the client's own state; tests fake it). */
export interface UbMapHost {
  me(): UbMapSelf | null;
  /** The objects the client has placed in the world (not carried), landblock-local. */
  objects(): Iterable<UbMapObject>;
  dungeonSource(): DungeonMapSource;
  /** An interior cell's EnvCell flags (null when the cell isn't known). */
  envCellFlags(cellId: number): number | null;
  /** Make a landblock's cells resident (a streamed set); resolves at once otherwise. */
  ensureDungeon?(landblock: number): Promise<void>;
  /** This era's terrain: its landblocks, the Region's height table and colours. Null before the world is loaded. */
  terrain(): { read(lbx: number, lby: number): LandblockTerrain | null; heightTable: ArrayLike<number>; terrainColors: number[]; road: [number, number, number] } | null;
  /** This era's markers and dungeon names (tools/build-map-markers.ts). */
  mapTable(): Promise<MapTable>;
  /** The automation window's loaded route, landblock-local to `landblock` (UB draws VTank's nav on dungeon maps). */
  navRoute?(landblock: number): UbMapRoute | null;
}

/** What the windows are drawn with (GameUI: the automation window's kit and frame, VVS's font, portal.dat art). */
export interface UbMapUi {
  kit: Pick<VTankKit, 'text' | 'textTab' | 'flatButton' | 'slider' | 'check' | 'input' | 'colors' | 'list'>;
  /** A VVS-framed window; `onClose` runs on its close box. The body is `w − 12` × `h − 35` at (6, 29) of `root`. */
  open(key: string, title: string, w: number, h: number, onClose: () => void): { body: HTMLElement; root: HTMLElement } | null;
  close(key: string): void;
  /** A frameless, click-through layer at (x, y) of a window's last place (DrawWhenClosed). */
  bare(key: string, at: HTMLElement, x: number, y: number, w: number, h: number): HTMLElement | null;
  /** A label in VVS's font, 10 px, with UB's 1 px black shadow (TextureCache.GetText), or null when it can't be drawn. */
  textCanvas(text: string, color: string): HTMLCanvasElement | null;
  /** A portal.dat image ready to draw, or null (then `onLoad` once it is). */
  image(id: number, onLoad: () => void): CanvasImageSource | null;
  canvas(w: number, h: number): HTMLCanvasElement;
}

const TILE_SCALE = 5;
/** The map canvas inside a window: the frame's body (6, 29), the tab row (18), the control row (22). */
const CANVAS_X = 6;
const CANVAS_Y = 29 + 18 + 22;
const TICK_MS = 100;
/** UB's HUD fill under the landscape picture. */
const LANDSCAPE_FILL = 'rgb(29, 33, 59)';
/** The retail map's player icon (0x21000026:0x100001ed). */
const PLAYER_ICON = 0x06004d10;
/** UB's sticky-point image (VisualNav, DrawPortalImage 100667897). */
const STICKY_POINT_ICON = 100667897;
const POLY_SETTING: Record<DungeonPolyKind, string> = { floor: 'Floors', stairs: 'Stairs', wall: 'Walls', inner: 'InnerWalls', ramped: 'RampedWalls' };

type Ctx = CanvasRenderingContext2D;

/** Both windows. One instance per client (main.ts). */
export class UbMaps {
  readonly dungeon: DungeonMapWindow;
  readonly landscape: LandscapeMapWindow;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(readonly host: UbMapHost, readonly ui: UbMapUi, readonly settings: UbMapSettings) {
    this.dungeon = new DungeonMapWindow(this);
    this.landscape = new LandscapeMapWindow(this);
  }

  /** `/ub dungeonmaps` / `/ub landscapemaps` and Decal's bar: open or close; the line to print. */
  toggle(which: UbMapWhich): string {
    const w = which === 'dungeon' ? this.dungeon : this.landscape;
    const name = which === 'dungeon' ? 'DungeonMaps' : 'LandscapeMaps';
    if (w.isOpen) { w.close(true); return `${name} window closed`; }
    if (!this.settings.bool(`${name}.Enabled`)) return `${name} is disabled (/ub opt set ${name}.Enabled true)`;
    w.open();
    return `${name} window opened`;
  }

  closeAll(): void {
    this.dungeon.close(true);
    this.landscape.close(true);
  }

  /** One window closed (UB hides it when its Enabled goes off). */
  close(which: UbMapWhich): void { (which === 'dungeon' ? this.dungeon : this.landscape).close(true); }

  /** Whether that window is open (Decal's bar marks it). */
  isOpen(which: UbMapWhich): boolean { return (which === 'dungeon' ? this.dungeon : this.landscape).isOpen; }

  /** The 10 Hz beat runs only while something is shown. */
  sync(): void {
    const live = this.dungeon.live || this.landscape.live;
    if (live && !this.timer) this.timer = setInterval(() => this.tick(), TICK_MS);
    if (!live && this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  tick(): void {
    this.dungeon.tick();
    this.landscape.tick();
  }

  private texts = new Map<string, HTMLCanvasElement | null>();
  /** Label canvases, cached (UB's TextureCache.GetText). */
  text(text: string, color: string): HTMLCanvasElement | null {
    const k = `${color}\u0000${text}`;
    let c = this.texts.get(k);
    if (c === undefined) {
      c = this.ui.textCanvas(text, color);
      if (c) {
        if (this.texts.size > 600) this.texts.clear();
        this.texts.set(k, c);
      }
    }
    return c ?? null;
  }
}

/** A window's shared shell: its frame, tabs and the map canvas. */
abstract class MapWindowBase {
  protected body: HTMLElement | null = null;
  protected root: HTMLElement | null = null;
  protected bareHost: HTMLElement | null = null;
  protected canvas: HTMLCanvasElement | null = null;
  protected tab = 0;
  protected shownKey = '';
  protected dirty = true;
  protected mouse: { x: number; y: number } | null = null;

  constructor(protected readonly maps: UbMaps, readonly key: string, readonly title: string, readonly settingPrefix: string) {}

  get isOpen(): boolean { return this.body !== null; }
  /** Drawing: open, or left on screen without its frame (DrawWhenClosed). */
  get live(): boolean { return this.body !== null || this.bareHost !== null; }
  protected get s(): UbMapSettings { return this.maps.settings; }

  open(): void {
    if (this.body) return;
    this.dropBare();
    const w = Math.max(200, this.s.num(`${this.settingPrefix}.MapWindowWidth`));
    const h = Math.max(160, this.s.num(`${this.settingPrefix}.MapWindowHeight`));
    const r = this.maps.ui.open(this.key, this.title, w, h, () => this.close(false));
    if (!r) return;
    this.body = r.body;
    this.root = r.root;
    this.onOpen();
    this.render();
    this.maps.sync();
  }

  /** `forced`: a command or Enabled off (never leaves a frameless map behind). */
  close(forced: boolean): void {
    if (!this.body) { if (forced) this.dropBare(); this.maps.sync(); return; }
    const keep = !forced && this.keepWhenClosed() && this.tab === 0;
    const canvas = this.canvas;
    const root = this.root;
    if (keep && root && canvas) {
      const host = this.maps.ui.bare(this.key, root, CANVAS_X, CANVAS_Y, canvas.width, canvas.height);
      if (host) {
        canvas.style.top = '0px';
        host.appendChild(canvas);
        this.bareHost = host;
      }
    }
    this.maps.ui.close(this.key);
    this.body = null;
    this.root = null;
    if (!this.bareHost) this.canvas = null;
    this.maps.sync();
  }

  protected dropBare(): void {
    this.bareHost?.remove();
    this.bareHost = null;
    if (!this.body) this.canvas = null;
  }

  protected keepWhenClosed(): boolean { return false; }
  protected onOpen(): void {}

  tick(): void {
    if (!this.live) return;
    if (!this.s.bool(`${this.settingPrefix}.Enabled`)) { this.close(true); return; }
    this.update();
    const key = this.stateKey();
    if (!this.dirty && key === this.shownKey) return;
    this.shownKey = key;
    this.dirty = false;
    this.draw();
  }

  protected abstract update(): void;
  protected abstract stateKey(): string;
  protected abstract draw(): void;
  protected abstract renderTab(area: HTMLElement, w: number, h: number): void;
  protected abstract tabs(): string[];

  /** The window's body: UB's notebook tabs, then the open tab. */
  render(): void {
    const body = this.body;
    if (!body) return;
    body.replaceChildren();
    const { kit } = this.maps.ui;
    const w = parseInt(body.style.width, 10) || body.clientWidth || 300;
    const h = parseInt(body.style.height, 10) || body.clientHeight || 240;
    const tabs = document.createElement('div');
    Object.assign(tabs.style, { position: 'absolute', left: '4px', top: '0', display: 'flex', gap: '9px', alignItems: 'center' });
    this.tabs().forEach((label, i) => {
      const t = kit.textTab(label, this.tab === i, () => { this.tab = i; this.render(); });
      t.dataset.ubMapTab = label;
      tabs.appendChild(t);
    });
    body.appendChild(tabs);
    const area = document.createElement('div');
    Object.assign(area.style, { position: 'absolute', left: '0', top: '18px', width: `${w}px`, height: `${h - 18}px` });
    body.appendChild(area);
    if (this.tab !== 0) this.canvas = null;
    this.renderTab(area, w, h - 18);
    this.dirty = true;
    this.tick();
  }

  /** The map canvas filling `area` below its control row. */
  protected mountCanvas(area: HTMLElement, top: number, w: number, h: number): HTMLCanvasElement {
    const c = this.maps.ui.canvas(Math.max(1, w), Math.max(1, h - top));
    Object.assign(c.style, { position: 'absolute', left: '0', top: `${top}px`, width: `${w}px`, height: `${Math.max(1, h - top)}px` });
    c.dataset.ubMapCanvas = this.key;
    area.appendChild(c);
    this.canvas = c;
    return c;
  }

  protected place(e: HTMLElement, x: number, y: number): HTMLElement {
    Object.assign(e.style, { position: 'absolute', left: `${x}px`, top: `${y}px` });
    return e;
  }

  /** A label drawn into the map. */
  protected drawText(ctx: Ctx, text: string, color: string, x: number, y: number, align: 'center' | 'left' = 'center'): { w: number; h: number } | null {
    const t = this.maps.text(text, color);
    if (!t) return null;
    ctx.drawImage(t, Math.round(align === 'center' ? x - t.width / 2 : x), Math.round(y));
    return { w: t.width, h: t.height };
  }
}

// ── Dungeon Maps ──

class DungeonMapWindow extends MapWindowBase {
  map: DungeonMap | null = null;
  landblock = 0;
  /** A dungeon picked on the Search tab (UB isManualLoad): no live objects, no following. */
  manual = false;
  follow = true;
  showAll = false;
  drawZ = 0;
  /** UB `scale` (5 − MapZoom): the map's pixels per metre are scale × 5. */
  scale: number;
  rotation = 0;
  /** UB dragOffsetX / Y: the point at the centre when not following (x, −y). */
  offsetX = 0;
  offsetY = 0;
  visited = new Set<number>();
  private search = '';
  private drag: { x: number; y: number; ox: number; oy: number; rot: number; rotate: boolean } | null = null;
  private loading = 0;
  private names: Map<number, string> | null = null;

  constructor(maps: UbMaps) {
    super(maps, 'ubDungeonMaps', 'Utility Belt Maps', 'DungeonMaps');
    this.scale = 5 - maps.settings.num('DungeonMaps.MapZoom');
  }

  protected tabs(): string[] { return ['Map', 'Search', 'About']; }
  protected keepWhenClosed(): boolean { return this.s.bool('DungeonMaps.DrawWhenClosed'); }

  protected onOpen(): void {
    if (!this.names) void this.maps.host.mapTable().then((t) => { this.names = t.dungeons; this.dirty = true; if (this.tab === 1) this.render(); }).catch(() => { this.names = new Map(); });
  }

  /** UB's dungeon name: its table's, else "Unknown Dungeon XXXX". */
  nameOf(landblock: number): string {
    return this.names?.get(landblock & 0xffff0000) ?? `Unknown Dungeon ${((landblock >>> 16) & 0xffff).toString(16).toUpperCase().padStart(4, '0')}`;
  }

  protected renderTab(area: HTMLElement, w: number, h: number): void {
    const { kit } = this.maps.ui;
    const c = kit.colors;
    if (this.tab === 0) {
      const follow = kit.flatButton('Follow', () => this.followMe(), 60, 16);
      follow.dataset.ubMap = 'follow';
      area.appendChild(this.place(follow, 8, 2));
      area.appendChild(this.place(kit.text('Opacity:', { color: c.text }), 72, 4));
      const op = kit.slider(this.s.num('DungeonMaps.Opacity'), 0, 20, 50, (v) => { this.setNum('DungeonMaps.Opacity', v); });
      op.dataset.ubMap = 'opacity';
      area.appendChild(this.place(op, 124, 4));
      area.appendChild(this.place(kit.text('ZLayer:', { color: c.text }), 180, 4));
      const z = kit.slider(this.map ? zSliderPosition(this.map, this.drawZ) : 100, 0, 100, 60, (v) => this.setZSlider(v));
      z.dataset.ubMap = 'zlayer';
      area.appendChild(this.place(z, 226, 4));
      const all = document.createElement('div');
      Object.assign(all.style, { display: 'flex', alignItems: 'center', gap: '3px' });
      const chk = kit.check(this.showAll, (on) => { this.showAll = on; this.dirty = true; this.render(); });
      chk.dataset.ubMap = 'all';
      all.appendChild(chk);
      all.appendChild(kit.text('All', { color: c.text }));
      area.appendChild(this.place(all, Math.min(w - 36, 292), 2));
      const canvas = this.mountCanvas(area, 22, w, h);
      this.bindCanvas(canvas);
    } else if (this.tab === 1) {
      area.appendChild(this.place(kit.text('Search:', { color: c.text }), 4, 3));
      const input = kit.input(this.search, Math.max(60, w - 56), (v) => { this.search = v; this.fillList(list); });
      input.dataset.ubMap = 'search';
      area.appendChild(this.place(input, 48, 2));
      const list = document.createElement('div');
      Object.assign(list.style, { position: 'absolute', left: '0', top: '24px', width: `${w}px`, height: `${h - 24}px`, overflowY: 'auto' });
      list.dataset.ubMap = 'dungeon-list';
      area.appendChild(list);
      this.fillList(list);
      kit.list(list);
    } else {
      const about = kit.text('Dungeon geometry drawn from this era\'s cell.dat (UtilityBelt\'s Dungeon Maps).', { color: c.text, maxWidth: w - 8 });
      area.appendChild(this.place(about, 4, 4));
    }
  }

  /** UB UpdateDungeonList: landblock and name, matching the search in either. */
  dungeonList(): Array<[string, string]> {
    const q = this.search.toLowerCase();
    const out: Array<[string, string]> = [];
    for (const [lb, name] of this.names ?? []) {
      const hex = ((lb >>> 16) & 0xffff).toString(16).toUpperCase().padStart(4, '0');
      if (hex.toLowerCase().includes(q) || name.toLowerCase().includes(q)) out.push([hex, name]);
    }
    return out;
  }

  private fillList(list: HTMLElement): void {
    const { kit } = this.maps.ui;
    list.replaceChildren();
    for (const [hex, name] of this.dungeonList()) {
      const row = document.createElement('div');
      Object.assign(row.style, { display: 'flex', gap: '8px', cursor: 'pointer', height: '16px', alignItems: 'center' });
      row.dataset.ubDungeon = hex;
      const lb = document.createElement('div');
      Object.assign(lb.style, { width: '34px', flexShrink: '0' });
      lb.appendChild(kit.text(hex, { color: kit.colors.text }));
      row.appendChild(lb);
      row.appendChild(kit.text(name, { color: kit.colors.text }));
      row.addEventListener('click', () => { void this.loadManual(parseInt(hex, 16) << 16 >>> 0); });
      list.appendChild(row);
    }
  }

  /** UB UIDungeonList_Click: load that dungeon to look at; the Map tab opens on its top floor. */
  async loadManual(landblock: number): Promise<void> {
    this.rotation = 0;
    this.tab = 0;
    await this.load(landblock, true);
    this.render();
  }

  followMe(): void {
    this.follow = true;
    this.manual = false;
    const me = this.maps.host.me();
    if (me && (me.cell & 0xffff0000) !== this.landblock) void this.load(me.cell, false);
    this.dirty = true;
  }

  private setNum(name: string, v: number): void {
    try { this.s.setValue?.(name, v); } catch { /* not a store */ }
    this.dirty = true;
  }

  private setZSlider(pos: number): void {
    if (!this.map) return;
    this.drawZ = zFromSlider(this.map, pos);
    if (this.follow) {
      const me = this.maps.host.me();
      if (me) { this.offsetX = me.x; this.offsetY = -me.y; }
    }
    this.follow = false;
    this.dirty = true;
  }

  /** UB LoadLandblock: the landblock's cells; a dungeon you stand in, or one picked to look at. */
  async load(cell: number, manual: boolean): Promise<void> {
    const lb = (cell & 0xffff0000) >>> 0;
    const ticket = ++this.loading;
    this.landblock = lb;
    this.manual = manual;
    this.visited.clear();
    const host = this.maps.host;
    if (!manual && !isDungeonCell(cell, host.envCellFlags(cell))) { this.map = null; this.dirty = true; return; }
    if (host.ensureDungeon) { try { await host.ensureDungeon(lb); } catch { /* draw what is resident */ } }
    if (ticket !== this.loading) return;
    this.map = buildDungeonMap(lb, host.dungeonSource());
    const m = this.map;
    if (m && manual) {
      this.follow = false;
      this.drawZ = m.maxZ;
      this.offsetX = (m.minX + m.maxX) / 2;
      this.offsetY = -(m.minY + m.maxY) / 2;
    } else if (m) {
      const me = host.me();
      if (me) this.drawZ = me.z;
    }
    this.dirty = true;
    if (this.body && this.tab === 0) this.render();
  }

  protected update(): void {
    const me = this.maps.host.me();
    if (!me) return;
    const lb = (me.cell & 0xffff0000) >>> 0;
    if (this.follow && !this.manual && (lb !== this.landblock || (!this.map && this.loading === 0))) {
      void this.load(me.cell, false);
      return;
    }
    if (!this.map || this.manual) return;
    if (this.follow) {
      if (Math.abs(this.drawZ - me.z) > 0.5) this.drawZ = me.z;
    }
    if ((me.cell & 0xffff) >= 0x100 && !this.visited.has(me.cell >>> 0)) { this.visited.add(me.cell >>> 0); this.dirty = true; }
  }

  private trackedObjects(me: UbMapSelf | null): UbMapObject[] {
    if (this.manual || !me) return [];
    const out: UbMapObject[] = [];
    for (const o of this.maps.host.objects()) {
      if (o.guid === me.guid || ((o.cell & 0xffff0000) >>> 0) !== this.landblock) continue;
      out.push(o);
    }
    // You, where the movement says you are (the object list lags it).
    out.push({ guid: me.guid, name: me.name, objectClass: 24, cell: me.cell, x: me.x, y: me.y, z: me.z });
    return out;
  }

  protected stateKey(): string {
    const me = this.maps.host.me();
    const objs = this.trackedObjects(me).map((o) => `${o.guid}:${o.x.toFixed(1)},${o.y.toFixed(1)},${o.z.toFixed(1)}`).join(';');
    return [this.map ? this.landblock : 0, this.manual, this.follow, this.showAll, this.drawZ.toFixed(1), this.scale.toFixed(2), this.rotation.toFixed(1),
      this.offsetX.toFixed(2), this.offsetY.toFixed(2), me ? `${me.x.toFixed(2)},${me.y.toFixed(2)},${me.heading.toFixed(1)}` : '', this.visited.size, objs].join('|');
  }

  private bindCanvas(c: HTMLCanvasElement): void {
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // UB: ±0.2 per notch within 0.3 … 5; MapZoom is saved as 5 − scale.
      if ((e.deltaY < 0 && this.scale < 5) || (e.deltaY > 0 && this.scale > 0.3)) {
        this.scale += e.deltaY < 0 ? 0.2 : -0.2;
        this.setNum('DungeonMaps.MapZoom', Math.round((5 - this.scale) * 100) / 100);
      }
    }, { passive: false });
    c.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      const me = this.maps.host.me();
      if (this.follow && me) { this.offsetX = me.x; this.offsetY = -me.y; }
      this.follow = false;
      this.drag = { x: e.clientX, y: e.clientY, ox: this.offsetX, oy: this.offsetY, rot: this.rotation, rotate: e.shiftKey };
      const move = (ev: PointerEvent) => this.dragTo(ev.clientX, ev.clientY);
      const up = () => { this.drag = null; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  /** UB's MouseMove: pan along the map's rotation, or (Shift) rotate. */
  dragTo(clientX: number, clientY: number): void {
    const d = this.drag;
    if (!d) return;
    if (d.rotate) {
      this.rotation = d.rot + (d.x - clientX + d.y - clientY);
      return;
    }
    const ppm = this.scale * TILE_SCALE;
    const dx = (clientX - d.x) / ppm;
    const dy = (clientY - d.y) / ppm;
    // Screen right / down → world, undoing the map's rotation (north up at 0).
    const r = (this.rotation * Math.PI) / 180;
    const wx = dx * Math.cos(r) - dy * Math.sin(r);
    const wy = -dx * Math.sin(r) - dy * Math.cos(r);
    this.offsetX = d.ox - wx;
    this.offsetY = d.oy + wy;
  }

  /** World (landblock-local) → canvas, with the map's centre, scale and rotation. */
  private projector(cw: number, ch: number, me: UbMapSelf | null): (x: number, y: number) => [number, number] {
    const following = this.follow && !this.manual && me;
    if (following) this.rotation = me.heading;
    const cx = following ? me.x : this.offsetX;
    const cy = following ? me.y : -this.offsetY;
    const ppm = this.scale * TILE_SCALE;
    const r = (this.rotation * Math.PI) / 180;
    const cos = Math.cos(r); const sin = Math.sin(r);
    return (x, y) => {
      const dx = x - cx; const dy = y - cy;
      // Heading-up: turn the world so `rotation` points up.
      const rx = dx * cos - dy * sin;
      const ry = dx * sin + dy * cos;
      return [cw / 2 + rx * ppm, ch / 2 - ry * ppm];
    };
  }

  protected draw(): void {
    const c = this.canvas;
    const ctx = c?.getContext('2d') as Ctx | null | undefined;
    if (!c || !ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    const m = this.map;
    if (!m) return;
    const me = this.manual ? null : this.maps.host.me();
    const P = this.projector(c.width, c.height, me);
    const ppm = this.scale * TILE_SCALE;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, this.s.num('DungeonMaps.Opacity') / 20));
    const objs = this.trackedObjects(me);
    const byLayer = new Map<number, UbMapObject[]>();
    for (const o of objs) { const l = layerOf(o.z); const a = byLayer.get(l); if (a) a.push(o); else byLayer.set(l, [o]); }
    const visitedTint = this.s.bool('DungeonMaps.ShowVisitedTiles') ? argbBytes(this.s.num('DungeonMaps.VisitedTilesColor')) : null;
    const route = !this.manual ? this.maps.host.navRoute?.(this.landblock) ?? null : null;
    for (const [layer, cells] of m.layers) {
      const tint = layerTint(this.drawZ, layer, this.showAll);
      if (tint === 'hidden') continue;
      const color = (kind: DungeonPolyKind, visited: boolean): string | null => {
        const set = `DungeonMaps.Display.${POLY_SETTING[kind]}`;
        if (!this.s.bool(`${set}.Enabled`)) return null;
        let [r, g, b, a] = argbBytes(this.s.num(`${set}.Color`));
        if (visited && visitedTint) { r = (r * visitedTint[0]) / 255; g = (g * visitedTint[1]) / 255; b = (b * visitedTint[2]) / 255; }
        if (tint.grey) { r = (r * 151) / 255; g = (g * 151) / 255; b = (b * 151) / 255; a = (a * 121) / 255; }
        r *= tint.mul; g *= tint.mul; b *= tint.mul;
        return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Math.round((a / 255) * 1000) / 1000})`;
      };
      for (const pass of [['floor', 'stairs'], ['inner', 'ramped', 'wall']] as DungeonPolyKind[][]) {
        for (const cell of cells) {
          const visited = this.visited.has(cell.id);
          for (const p of cell.polys) {
            if (!pass.includes(p.kind)) continue;
            const col = color(p.kind, visited);
            if (!col) continue;
            if (p.kind === 'floor' || p.kind === 'stairs') {
              ctx.beginPath();
              for (let i = 0; i < p.pts.length; i += 2) { const [sx, sy] = P(p.pts[i]!, p.pts[i + 1]!); if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy); }
              ctx.closePath();
              ctx.fillStyle = col;
              ctx.fill();
            } else {
              // A standing polygon seen from above is its two farthest-apart points.
              let best = 0; let a = 0; let b = 0;
              for (let i = 0; i < p.pts.length; i += 2) for (let j = i + 2; j < p.pts.length; j += 2) {
                const d = (p.pts[i]! - p.pts[j]!) ** 2 + (p.pts[i + 1]! - p.pts[j + 1]!) ** 2;
                if (d > best) { best = d; a = i; b = j; }
              }
              const [x1, y1] = P(p.pts[a]!, p.pts[a + 1]!);
              const [x2, y2] = P(p.pts[b]!, p.pts[b + 1]!);
              ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
              ctx.strokeStyle = col;
              ctx.lineWidth = Math.max(1, (p.kind === 'wall' ? 0.5 : 0.3) * ppm);
              ctx.stroke();
            }
          }
        }
      }
      if (route) this.drawRoute(ctx, P, route, layer, tint);
      for (const o of byLayer.get(layer) ?? []) this.drawMarker(ctx, P, o, me, ppm, tint);
    }
    // Labels: the shown floor's (all floors' with All), unrotated, centred on the object.
    for (const [layer, list] of byLayer) {
      if (!this.showAll && layer !== layerOf(this.drawZ)) continue;
      if (!m.layers.has(layer)) continue;
      for (const o of list) {
        const cls = this.markerClass(o, me);
        if (!this.shouldDraw(o, me, cls) || !this.s.bool(`DungeonMaps.Display.Markers.${cls}.ShowLabel`)) continue;
        const [sx, sy] = P(o.x, o.y);
        const t = this.maps.text(markerLabel(o.objectClass, o.name), argbCss(this.s.num(`DungeonMaps.Display.Markers.${cls}.Color`)));
        if (t) ctx.drawImage(t, Math.round(sx - t.width / 2), Math.round(sy - t.height / 2));
      }
    }
    ctx.restore();
    // The name header (UB: dungeon name and its Z level, the landcell in Debug) and the compass.
    if (this.s.bool('DungeonMaps.Display.DungeonName.Enabled')) {
      let name = `${this.nameOf(this.landblock)} (Z:${Math.floor((this.drawZ + 3) / 6)})`;
      if (this.s.bool('DungeonMaps.Debug') && me) name += ` ${(me.cell >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
      this.drawText(ctx, name, argbCss(this.s.num('DungeonMaps.Display.DungeonName.Color')), c.width / 2, 2);
    }
    if (this.s.bool('DungeonMaps.ShowCompass')) {
      // North, at the edge of a 12 px ring top right, turned with the map.
      const r = ((-this.rotation) * Math.PI) / 180;
      const cx = c.width - 14; const cy = 16;
      this.drawText(ctx, 'N', 'rgb(255, 255, 255)', cx + 10 * Math.sin(r), cy - 10 * Math.cos(r) - 6);
    }
  }

  private markerClass(o: UbMapObject, me: UbMapSelf | null): string {
    return markerClassOf(o.objectClass, o.name, !!me && o.guid === me.guid, me?.name ?? '');
  }

  /** UB ShouldDrawMarker: its class is on and it is within 300 m of you. */
  private shouldDraw(o: UbMapObject, me: UbMapSelf | null, cls: string): boolean {
    if (me && Math.hypot(o.x - me.x, o.y - me.y, o.z - me.z) > 300) return false;
    return this.s.bool(`DungeonMaps.Display.Markers.${cls}.Enabled`);
  }

  private drawMarker(ctx: Ctx, P: (x: number, y: number) => [number, number], o: UbMapObject, me: UbMapSelf | null, ppm: number, tint: { mul: number; grey: boolean }): void {
    const cls = this.markerClass(o, me);
    if (!this.shouldDraw(o, me, cls)) return;
    const k = `DungeonMaps.Display.Markers.${cls}`;
    const size = this.s.num(`${k}.Size`) / 5;
    const [sx, sy] = P(o.x, o.y);
    const icon = this.s.bool(`${k}.UseIcon`) && o.icon ? this.maps.ui.image(o.icon, () => { this.dirty = true; }) : null;
    ctx.save();
    if (tint.grey) ctx.globalAlpha *= 121 / 255;
    if (icon) {
      // UB: the 32 px icon at size / 5, in map-texture pixels (5 per metre).
      const px = ((32 * size) / TILE_SCALE) * ppm;
      ctx.drawImage(icon, sx - px / 2, sy - px / 2, px, px);
    } else {
      // UB's marker: a filled 16 px circle in the class colour at size / 5.
      const r = (((16 * size) / TILE_SCALE) * ppm) / 2;
      const [cr, cg, cb, ca] = argbBytes(this.s.num(`${k}.Color`));
      ctx.fillStyle = `rgba(${Math.round(cr * tint.mul)}, ${Math.round(cg * tint.mul)}, ${Math.round(cb * tint.mul)}, ${ca / 255})`;
      ctx.beginPath(); ctx.arc(sx, sy, Math.max(1.5, r), 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  /** UB DrawPointRoute: VTank's route on the floors it passes (points within 4 m of the floor). */
  private drawRoute(ctx: Ctx, P: (x: number, y: number) => [number, number], route: UbMapRoute, layer: number, tint: { mul: number; grey: boolean }): void {
    const on = (z: number | null) => z !== null && Math.abs(z + 1 - layer) < 4;
    const pts = route.loops ? route.points : route.points.slice(Math.max(0, route.current));
    if (pts.length === 1 && route.loops) {
      if (!this.s.bool('DungeonMaps.Display.VisualNavStickyPoint.Enabled') || !on(pts[0]!.z)) return;
      const img = this.maps.ui.image(STICKY_POINT_ICON, () => { this.dirty = true; });
      const [sx, sy] = P(pts[0]!.x, pts[0]!.y);
      if (img) ctx.drawImage(img, sx - 15, sy - 15, 30, 30);
      return;
    }
    if (!this.s.bool('DungeonMaps.Display.VisualNavLines.Enabled')) return;
    const [r, g, b, a] = argbBytes(this.s.num('DungeonMaps.Display.VisualNavLines.Color'));
    ctx.save();
    if (tint.grey) ctx.globalAlpha *= 121 / 255;
    ctx.strokeStyle = `rgba(${Math.round(r * tint.mul)}, ${Math.round(g * tint.mul)}, ${Math.round(b * tint.mul)}, ${a / 255})`;
    ctx.lineWidth = Math.max(1, this.scale);
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1]!; const q = pts[i]!;
      if (!on(p.z) && !on(q.z)) continue;
      const [x1, y1] = P(p.x, p.y); const [x2, y2] = P(q.x, q.y);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
    ctx.restore();
  }
}

// ── Landscape Maps ──

class LandscapeMapWindow extends MapWindowBase {
  /** UB zoom, 0–1 (scale = 1.5^(12·zoom) − 0.8); UB starts at 0.04. */
  zoom = 0.04;
  /** UB mapTextureOffsetX / Y: the picture pixel at the centre. */
  offX = TERRAIN_MAP_SIZE / 2;
  offY = TERRAIN_MAP_SIZE / 2;
  follow = false;
  private picture: HTMLCanvasElement | null = null;
  private builder: TerrainMapBuilder | null = null;
  private painted = 0;
  /** The picture is whole (its builder's 16 MB of pixels let go; the canvas stays for the session). */
  private pictureDone = false;
  private table: MapTable | null = null;
  private drag: { x: number; y: number; ox: number; oy: number } | null = null;
  private hover: { name: string; x: number; y: number } | null = null;

  constructor(maps: UbMaps) { super(maps, 'ubLandscapeMaps', 'Utility Belt Landscape Maps', 'LandscapeMaps'); }

  protected tabs(): string[] { return ['Map', 'About']; }

  get scale(): number { return landscapeScale(this.zoom); }

  protected onOpen(): void {
    if (!this.table) void this.maps.host.mapTable().then((t) => { this.table = t; this.dirty = true; }).catch(() => { this.table = { markers: [], dungeons: new Map() }; });
    this.startPicture();
  }

  /** The terrain picture, painted a few landblock columns per beat (the window shows while it fills in). */
  private startPicture(): void {
    if (this.builder || this.pictureDone) return;
    const t = this.maps.host.terrain();
    if (!t) return;
    this.builder = new TerrainMapBuilder((x, y) => t.read(x, y), t.heightTable, terrainPalette(t.terrainColors, t.road));
    this.picture = this.maps.ui.canvas(TERRAIN_MAP_SIZE, TERRAIN_MAP_SIZE);
  }

  /** Pixels of the picture built so far, onto its canvas. */
  private paintPicture(): void {
    const b = this.builder;
    const pic = this.picture;
    if (!b || !pic || this.painted >= 255) return;
    if (!b.done) b.step(8);
    const to = b.progress;
    if (to === this.painted) return;
    const ctx = pic.getContext('2d');
    if (ctx && typeof ImageData !== 'undefined') {
      const x0 = this.painted * 8;
      const w = (to - this.painted) * 8;
      const strip = new ImageData(w, TERRAIN_MAP_SIZE);
      for (let y = 0; y < TERRAIN_MAP_SIZE; y++) {
        const src = (y * TERRAIN_MAP_SIZE + x0) * 4;
        strip.data.set(b.rgba.subarray(src, src + w * 4), y * w * 4);
      }
      ctx.putImageData(strip, x0, 0);
    }
    this.painted = to;
    this.dirty = true;
    if (to >= 255) { this.builder = null; this.pictureDone = true; }
  }

  /** How built the picture is, 0–1 (tests, and the About tab). */
  get pictureProgress(): number { return this.pictureDone ? 1 : this.builder ? this.builder.progress / 255 : 0; }

  protected renderTab(area: HTMLElement, w: number, h: number): void {
    const { kit } = this.maps.ui;
    if (this.tab === 0) {
      const follow = kit.flatButton('Follow', () => this.followMe(), 60, 16);
      follow.dataset.ubMap = 'follow';
      area.appendChild(this.place(follow, 8, 2));
      const canvas = this.mountCanvas(area, 22, w, h);
      this.bindCanvas(canvas);
    } else {
      area.appendChild(this.place(kit.text('Map drawn from this era\'s cell.dat and world (UtilityBelt\'s Landscape Maps).', { color: kit.colors.text, maxWidth: w - 8 }), 4, 4));
    }
  }

  /** You on the map: your cell's coordinates (null in a dungeon, where the landscape has no place for you). */
  private myCoords(): { ew: number; ns: number; heading: number } | null {
    const me = this.maps.host.me();
    if (!me) return null;
    if (isDungeonCell(me.cell, (me.cell & 0xffff) >= 0x100 ? this.maps.host.envCellFlags(me.cell) : null)) return null;
    const ew = ((me.x / 24) + ((me.cell >>> 24) & 0xff) * 8 - 1019.5) / 10;
    const ns = ((me.y / 24) + ((me.cell >>> 16) & 0xff) * 8 - 1019.5) / 10;
    return { ew, ns, heading: me.heading };
  }

  /** UB FollowButton_Hit: centre on you at zoom 0.24 or closer, and keep you there. */
  followMe(): void {
    const c = this.myCoords();
    if (!c) return;
    this.zoom = Math.max(this.zoom, 0.24);
    this.centerOn(c.ew, c.ns);
    this.follow = true;
    this.dirty = true;
  }

  centerOn(ew: number, ns: number): void {
    const p = coordsToPixel(ew, ns);
    this.offX = p.x;
    this.offY = p.y;
  }

  /** Canvas point → map coordinates (UB HudToCoordinates). */
  hudToCoords(x: number, y: number, cw: number, ch: number): { ew: number; ns: number } {
    return pixelToCoords(this.offX + (x - cw / 2) / this.scale, this.offY + (y - ch / 2) / this.scale);
  }

  /** Map coordinates → canvas point (UB CoordinatesToHud). */
  coordsToHud(ew: number, ns: number, cw: number, ch: number): { x: number; y: number } {
    const p = coordsToPixel(ew, ns);
    return { x: cw / 2 + (p.x - this.offX) * this.scale, y: ch / 2 + (p.y - this.offY) * this.scale };
  }

  protected update(): void {
    // The Region and landblocks are there once you are in the world (a window opened before then starts here).
    if (!this.builder && !this.pictureDone) this.startPicture();
    this.paintPicture();
    if (this.follow) {
      const c = this.myCoords();
      if (c) this.centerOn(c.ew, c.ns);
    }
  }

  protected stateKey(): string {
    const c = this.myCoords();
    return [this.zoom.toFixed(3), this.offX.toFixed(1), this.offY.toFixed(1), this.painted, this.table ? 1 : 0,
      c ? `${c.ew.toFixed(3)},${c.ns.toFixed(3)},${c.heading.toFixed(0)}` : '', this.mouse ? `${this.mouse.x},${this.mouse.y}` : ''].join('|');
  }

  private bindCanvas(c: HTMLCanvasElement): void {
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const r = c.getBoundingClientRect();
      const k = r.width ? c.width / r.width : 1;
      const mx = (e.clientX - r.left) * k; const my = (e.clientY - r.top) * k;
      const before = this.hudToCoords(mx, my, c.width, c.height);
      this.zoom = Math.max(0, Math.min(1, this.zoom + (e.deltaY < 0 ? 0.04 : -0.04)));
      if (!this.follow) {
        // UB: zoom about the mouse.
        const after = this.coordsToHud(before.ew, before.ns, c.width, c.height);
        this.offX += (after.x - mx) / this.scale;
        this.offY += (after.y - my) / this.scale;
      }
      this.dirty = true;
    }, { passive: false });
    c.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.follow = false;
      this.drag = { x: e.clientX, y: e.clientY, ox: this.offX, oy: this.offY };
      const move = (ev: PointerEvent) => this.dragTo(ev.clientX, ev.clientY);
      const up = () => { this.drag = null; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); this.dirty = true; };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    c.addEventListener('pointermove', (e) => {
      const r = c.getBoundingClientRect();
      const k = r.width ? c.width / r.width : 1;
      this.mouse = { x: Math.round((e.clientX - r.left) * k), y: Math.round((e.clientY - r.top) * k) };
    });
    c.addEventListener('pointerleave', () => { this.mouse = null; });
  }

  dragTo(clientX: number, clientY: number): void {
    const d = this.drag;
    if (!d) return;
    this.offX = d.ox - (clientX - d.x) / this.scale;
    this.offY = d.oy - (clientY - d.y) / this.scale;
    this.dirty = true;
  }

  protected draw(): void {
    const c = this.canvas;
    const ctx = c?.getContext('2d') as Ctx | null | undefined;
    if (!c || !ctx) return;
    const W = c.width; const H = c.height;
    ctx.fillStyle = LANDSCAPE_FILL;
    ctx.fillRect(0, 0, W, H);
    const s = this.scale;
    if (this.picture) {
      ctx.imageSmoothingEnabled = s < 1;
      ctx.drawImage(this.picture, W / 2 - this.offX * s, H / 2 - this.offY * s, TERRAIN_MAP_SIZE * s, TERRAIN_MAP_SIZE * s);
    }
    this.drawMarkers(ctx, W, H);
    this.drawBorders(ctx, W, H);
    // You: the retail map's player icon, turned to your heading.
    const me = this.myCoords();
    if (me) {
      const p = this.coordsToHud(me.ew, me.ns, W, H);
      const icon = this.maps.ui.image(PLAYER_ICON, () => { this.dirty = true; });
      if (icon) {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate((me.heading * Math.PI) / 180);
        ctx.drawImage(icon, -8, -8, 17, 16);
        ctx.restore();
      }
    }
    // The mouse's coordinates, bottom centre (UB: 40 px up).
    if (this.mouse) {
      const m = this.hudToCoords(this.mouse.x, this.mouse.y, W, H);
      this.drawText(ctx, coordText(m.ns, m.ew), 'rgb(255, 255, 255)', W / 2, H - 40);
    }
  }

  /** UB RenderMarkers: icons in their zoom band, then labels placed clear of each other; the hovered pair on top. */
  private drawMarkers(ctx: Ctx, W: number, H: number): void {
    const t = this.table;
    if (!t) return;
    const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
    const labels: Array<{ name: string; x: number; y: number }> = [];
    let hover: { name: string; x: number; y: number } | null = null;
    for (const m of t.markers) {
      const o = LANDSCAPE_MARKER_OPTIONS[m.type];
      if (this.zoom < o.minMarker) continue;
      const p = this.coordsToHud(m.ew, m.ns, W, H);
      if (p.x < -8 || p.y < -8 || p.x > W + 8 || p.y > H + 8) continue;
      const img = this.maps.ui.image(o.icon, () => { this.dirty = true; });
      if (img) ctx.drawImage(img, Math.round(p.x - 8), Math.round(p.y - 8), 16, 16);
      const showLabel = this.zoom >= o.minLabel;
      if (showLabel) { placed.push({ x: Math.round(p.x - 8), y: Math.round(p.y - 8), w: 16, h: 16 }); labels.push({ name: m.name, x: p.x, y: p.y }); }
      if (this.mouse && Math.abs(this.mouse.x - p.x) <= 8 && Math.abs(this.mouse.y - p.y) <= 8) hover = { name: m.name, x: p.x, y: p.y };
    }
    for (const l of labels) {
      const tc = this.maps.text(l.name, 'rgb(255, 255, 255)');
      if (!tc) continue;
      const at = placeLabel(labelCandidates(Math.round(l.x), Math.round(l.y), tc.width, tc.height), placed);
      if (at) ctx.drawImage(tc, at.x + 2, at.y);
    }
    this.hover = hover;
    if (hover) {
      // UB's highlight: a dark box with an orange edge round the icon and its label.
      const tc = this.maps.text(hover.name, 'rgb(255, 255, 255)');
      ctx.save();
      ctx.strokeStyle = 'rgb(255, 165, 0)';
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(hover.x - 8) + 0.5, Math.round(hover.y - 8) + 0.5, 16, 16);
      if (tc) {
        const r = labelCandidates(Math.round(hover.x), Math.round(hover.y), tc.width, tc.height)[0]!;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.706)';
        ctx.fillRect(r.x, r.y, r.w + 2, r.h);
        ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w + 2, r.h);
        ctx.drawImage(tc, r.x + 2, r.y);
      }
      ctx.restore();
    }
  }

  /** UB RenderCoordinateBorders: 20 px bands, ticks at the zoom's increment, coordinates in light grey. */
  private drawBorders(ctx: Ctx, W: number, H: number): void {
    const B = 20;
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(0, 0, W, B); ctx.fillRect(0, H - B, W, B);
    ctx.fillRect(0, B, B, H - 2 * B); ctx.fillRect(W - B, B, B, H - 2 * B);
    const inc = coordinateIncrement(this.zoom);
    const grey = 'rgb(128, 128, 128)';
    const light = 'rgb(211, 211, 211)';
    ctx.strokeStyle = grey;
    ctx.lineWidth = 1;
    const tl = this.hudToCoords(0, 0, W, H);
    const br = this.hudToCoords(W, H, W, H);
    for (let ew = Math.ceil(tl.ew / inc) * inc; ew <= br.ew; ew += inc) {
      const x = Math.round(this.coordsToHud(ew, 0, W, H).x) + 0.5;
      for (const y0 of [0, H - B]) { ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y0 + 4); ctx.moveTo(x, y0 + B - 3); ctx.lineTo(x, y0 + B); ctx.stroke(); }
      const label = `${Math.abs(ew).toFixed(1)}${ew > 0 ? 'E' : 'W'}`;
      this.drawText(ctx, label, light, x, 4);
      this.drawText(ctx, label, light, x, H - B + 4);
    }
    for (let ns = Math.ceil(br.ns / inc) * inc; ns <= tl.ns; ns += inc) {
      const y = Math.round(this.coordsToHud(0, ns, W, H).y) + 0.5;
      if (y < B || y > H - B) continue;
      for (const x0 of [0, W - B]) { ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + 4, y); ctx.moveTo(x0 + B - 3, y); ctx.lineTo(x0 + B, y); ctx.stroke(); }
      const label = `${Math.abs(ns).toFixed(inc < 1 ? 1 : 0)}${ns > 0 ? 'N' : 'S'}`;
      const tc = this.maps.text(label, light);
      if (!tc) continue;
      for (const x0 of [B / 2, W - B / 2]) {
        ctx.save();
        ctx.translate(x0, y);
        ctx.rotate(-Math.PI / 2);
        ctx.drawImage(tc, -tc.width / 2, -tc.height / 2);
        ctx.restore();
      }
    }
    ctx.restore();
  }

  /** The marker under the mouse (UB's highlight), for tests. */
  get hovered(): string | null { return this.hover?.name ?? null; }
}
