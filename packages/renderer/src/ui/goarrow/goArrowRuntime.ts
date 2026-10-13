/**
 * GoArrow in the game (docs/plugin-specs/goarrow.md; the rules in @ac/shared goarrow/, the HUD and
 * window in this folder): settings and lists kept per browser, the era's generated location database
 * (loaded on first use, its own chunk), the arrow's destination, `/goarrow` and its aliases, and the
 * HUD each frame. Preview UI for now (GameUI.setPreviewFeatures): off for players not on the list.
 */
import {
  GOARROW_DEFAULT_SETTINGS, GOARROW_HUDS_RESET_MESSAGE, GOARROW_LOCKED_MESSAGE, GOARROW_MESSAGE_PREFIX, GOARROW_TAG_NOTHING_SELECTED,
  GOARROW_TO_ERROR, GOARROW_UNLOCKED_MESSAGE, GOARROW_HUD_DEFAULT_POSITION, formatGoCoords, goArrowInDungeon, goCoordsFromCell, goDecodeEraData,
  goDefaultStartLocations, goHelpText, goIsHereArg, goLocSendLine, goNoFindMatches, goParseCommand, parseGoCoords,
  type GoArrowEraData, type GoArrowTarget, type GoCommandNames, type GoCoords, type GoLocation, type GoPortalDevice, type GoStartLocation,
} from '@ac/shared';
import { ArrowHud, type ArrowHudPlayer } from './ArrowHud.js';
import { GoArrowModel, type GoArrowWindowHost, type GoArrowWindowSettings } from './GoArrowModel.js';

export type GoArrowEra = 'eol' | 'dm' | 'ac1999';

export interface GoArrowDeps {
  era(): GoArrowEra;
  /** You: cell, landblock-local x / y, and yaw (radians, the camera controller's); null out of the world. */
  self(): { cell: number; x: number; y: number; headingRadians: number; level?: number } | null;
  /** An EnvCell's SeenOutside flag (building interiors have it; dungeons don't). */
  seenOutside(cell: number): boolean;
  selected(): { guid: number; name: string } | null;
  object(guid: number): { name: string; cell: number; x: number; y: number } | null;
  /** Find an object by name nearby (GoArrow's /goarrow find), nearest first. */
  findByName(text: string): Array<{ guid: number; name: string }>;
  select(guid: number): void;
  say(text: string, kind: 'message' | 'help' | 'warning' | 'error'): void;
  /** A line as typed into the chat box (loc / dest send a tell). */
  chat(line: string): void;
  copy(text: string): void;
  storage(): { getItem(k: string): string | null; setItem(k: string, v: string): void } | null;
  enabled(): boolean;
}

const KEY = 'acjs.goarrow';

export class GoArrowRuntime implements GoArrowWindowHost {
  readonly model: GoArrowModel;
  hud: ArrowHud | null = null;
  private data: GoArrowEraData | null = null;
  private dataEra: GoArrowEra | null = null;
  private loading: Promise<void> | null = null;
  private target: GoArrowTarget | null = null;
  private trackedGuid: number | null = null;
  /** The host resizes the window (per top tab). */
  onResize: ((w: number, h: number) => void) | null = null;
  /** The window should redraw (its model changed outside a click). */
  onRedraw: (() => void) | null = null;

  constructor(private readonly d: GoArrowDeps) {
    this.model = new GoArrowModel(this);
    this.target = this.load<GoArrowTarget | null>('target', null);
  }

  // ── storage ──
  private load<T>(k: string, fallback: T): T {
    try { const raw = this.d.storage()?.getItem(`${KEY}.${k}`); return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; }
  }
  private save(k: string, v: unknown): void {
    try { this.d.storage()?.setItem(`${KEY}.${k}`, JSON.stringify(v)); } catch { /* storage blocked */ }
  }

  // ── era data ──
  /** Load the era's location database (its own chunk) once per era. */
  ensureData(): Promise<void> {
    const era = this.d.era();
    if (this.dataEra === era && this.data) return Promise.resolve();
    if (this.loading && this.dataEra === era) return this.loading;
    this.dataEra = era;
    this.loading = (async () => {
      const mod = era === 'ac1999' ? await import('./locations/ac1999.ts') : era === 'dm' ? await import('./locations/dm.ts') : await import('./locations/eol.ts');
      this.data = goDecodeEraData(mod.default as never, formatGoCoords);
      this.onRedraw?.();
    })();
    return this.loading;
  }

  // ── GoArrowWindowHost ──
  settings(): GoArrowWindowSettings {
    return { ...GOARROW_DEFAULT_SETTINGS, alphaActive: 255, alphaInactive: 255, outputWindows: [0], alwaysShowErrors: true, ...this.load<Partial<GoArrowWindowSettings>>('settings', {}) };
  }
  saveSettings(patch: Partial<GoArrowWindowSettings>): void { this.save('settings', { ...this.load<Partial<GoArrowWindowSettings>>('settings', {}), ...patch }); this.hud?.update(); }
  locations(): readonly GoLocation[] { return [...(this.data?.locations ?? []), ...this.load<GoLocation[]>('custom', [])]; }
  routeWorld(): ReturnType<GoArrowWindowHost['routeWorld']> {
    const data = this.data;
    if (!data) return { locations: this.locations(), regions: undefined as never };
    return { locations: this.locations(), underground: data.underground, regions: data.regions };
  }
  startLocations(): GoStartLocation[] { return this.load<GoStartLocation[] | null>(`starts.${this.d.era()}`, null) ?? goDefaultStartLocations(this.data?.starts ?? new Map()); }
  saveStartLocations(list: GoStartLocation[]): void { this.save(`starts.${this.d.era()}`, list); }
  portalDevices(): GoPortalDevice[] { return this.load<GoPortalDevice[] | null>(`devices.${this.d.era()}`, null) ?? (this.data?.devices ?? []).map((dv) => ({ ...dv, coords: null, enabled: true })); }
  savePortalDevices(list: GoPortalDevice[]): void { this.save(`devices.${this.d.era()}`, list); }
  player(): GoCoords | null { const s = this.d.self(); return s ? goCoordsFromCell(s.cell, s.x, s.y) : null; }
  playerLevel(): number | undefined { return this.d.self()?.level; }
  arrowTarget(): GoArrowTarget | null { return this.resolvedTarget(); }
  setArrowTarget(t: GoArrowTarget): void {
    this.target = t;
    this.trackedGuid = null;
    this.save('target', t);
    this.saveSettings({ visible: true });
    this.model.noteDestination(t);
  }
  arrowHiddenReason(): string | null { return this.hud?.hiddenReason() ?? null; }
  readonly store = {
    load: (k: 'favorites' | 'recentLocations' | 'recentCoords') => this.load<unknown>(`list.${k}`, null),
    save: (k: 'favorites' | 'recentLocations' | 'recentCoords', v: unknown) => this.save(`list.${k}`, v),
  };
  say(text: string, kind: 'message' | 'help' | 'warning' | 'error' = 'message'): void { this.d.say(`${GOARROW_MESSAGE_PREFIX}${text}`, kind); }
  copy(text: string): void { this.d.copy(text); }
  resize(w: number, h: number): void { this.onResize?.(w, h); }
  resetHudPositions(): void { this.saveSettings({ location: { ...GOARROW_HUD_DEFAULT_POSITION } }); }
  saveLocation(loc: GoLocation, asNew: boolean): GoLocation | null {
    const custom = this.load<GoLocation[]>('custom', []);
    if (asNew || loc.id < 0x80000000) {
      const id = Math.max(0x80000000, ...custom.map((c) => c.id)) + 1;
      const made = { ...loc, id };
      this.save('custom', [...custom, made]);
      return made;
    }
    const i = custom.findIndex((c) => c.id === loc.id);
    if (i < 0) return null;
    custom[i] = loc;
    this.save('custom', custom);
    return loc;
  }
  deleteLocation(loc: GoLocation): boolean {
    const custom = this.load<GoLocation[]>('custom', []);
    const next = custom.filter((c) => c.id !== loc.id);
    if (next.length === custom.length) return false;
    this.save('custom', next);
    return true;
  }

  // ── the arrow ──
  /** The destination now: a tracked object's live position. */
  private resolvedTarget(): GoArrowTarget | null {
    const t = this.target;
    if (t?.kind === 'object' && this.trackedGuid !== null) {
      const o = this.d.object(this.trackedGuid);
      return o ? { kind: 'object', name: o.name, coords: goCoordsFromCell(o.cell, o.x, o.y), inRange: true } : { ...t, inRange: false };
    }
    return t;
  }

  private parent: (() => HTMLElement | null) | null = null;

  /** Mount the HUD over the HUD layer (once); `parent` names the live layer each frame. */
  mount(parent: () => HTMLElement | null): void {
    this.parent = parent;
    if (this.hud) return;
    const at = parent();
    if (!at) return;
    this.hud = new ArrowHud({
      player: (): ArrowHudPlayer | null => {
        if (!this.d.enabled()) return null;
        const s = this.d.self();
        return s ? { coords: goCoordsFromCell(s.cell, s.x, s.y), heading: s.headingRadians, inDungeon: goArrowInDungeon(s.cell, this.d.seenOutside(s.cell)) } : null;
      },
      target: () => this.resolvedTarget(),
      settings: () => { const st = this.settings(); return this.d.enabled() ? st : { ...st, visible: false }; },
      savePosition: (p) => this.saveSettings({ location: p }),
      hide: () => this.saveSettings({ visible: false }),
      setTarget: (t) => { this.target = t; this.save('target', t); },
    }, at);
  }

  /** Each frame: the HUD repaints only when what it shows changed. */
  frame(): void {
    const h = this.hud;
    if (!h) return;
    // The HUD layer can be rebuilt under it (a re-login rebuilds the HUD): put the arrow back on the live layer.
    if (!h.root.isConnected && this.parent) { const p = this.parent(); if (p) p.appendChild(h.root); }
    h.update();
  }

  // ── /goarrow ──
  private names(): GoCommandNames {
    const s = this.settings();
    return { main: s.chatCommand, loc: s.locAlias.enabled ? s.locAlias.name : null, dest: s.destAlias.enabled ? s.destAlias.name : null, find: s.findAlias.enabled ? s.findAlias.name : null };
  }

  private coordsOrPlace(arg: string): { coords: GoCoords; name?: string } | null {
    if (goIsHereArg(arg)) { const p = this.player(); return p ? { coords: p } : null; }
    const c = parseGoCoords(arg);
    if (c) return { coords: c };
    const want = arg.trim().toLowerCase();
    const hit = this.locations().find((l) => l.name.toLowerCase() === want);
    return hit?.coords ? { coords: hit.coords, name: hit.name } : null;
  }

  /** A typed chat line: true when GoArrow took it. */
  chat(line: string): boolean {
    if (!this.d.enabled()) return false;
    const cmd = goParseCommand(line, this.names());
    if (!cmd) return false;
    void this.ensureData();
    switch (cmd.kind) {
      case 'help': for (const l of goHelpText(this.names())) this.say(l, 'help'); break;
      case 'error': this.say(cmd.message, 'error'); break;
      case 'hud': {
        if (cmd.target === 'arrow' || cmd.target === 'all') {
          const on = cmd.action === 'show' ? true : cmd.action === 'hide' ? false : !this.settings().visible;
          this.saveSettings({ visible: on });
          if (on) { const r = this.hud?.hiddenReason(); if (r) this.say(r, 'warning'); }
        } else this.say('This client has no GoArrow map or toolbar; UtilityBelt\'s Landscape and Dungeon Maps are on the Virindi Views bar.', 'warning');
        break;
      }
      case 'to': case 'start': case 'end': {
        const hit = this.coordsOrPlace(cmd.arg);
        if (!hit) { this.say(GOARROW_TO_ERROR, 'error'); break; }
        if (cmd.kind === 'to') this.setArrowTarget(hit.name ? { kind: 'location', name: hit.name, coords: hit.coords } : { kind: 'coords', coords: hit.coords });
        else { this.model.top = 'Atlas'; this.model.atlasTab = 'Route'; this.model.setRouteEndCoords(cmd.kind === 'start' ? 'from' : 'to', hit.coords); }
        this.onRedraw?.();
        break;
      }
      case 'reset': this.resetHudPositions(); this.say(GOARROW_HUDS_RESET_MESSAGE); break;
      case 'lock': this.saveSettings({ positionLocked: cmd.locked }); this.say(cmd.locked ? GOARROW_LOCKED_MESSAGE : GOARROW_UNLOCKED_MESSAGE); break;
      case 'loc': case 'dest': {
        const c = cmd.kind === 'loc' ? this.player() : (this.resolvedTarget() ? (this.resolvedTarget() as { coords?: GoCoords | null }).coords ?? null : null);
        if (!c) { this.say('No coordinates to send', 'error'); break; }
        this.d.chat(goLocSendLine(cmd.arg, formatGoCoords(c)));
        break;
      }
      case 'search': {
        void this.ensureData().then(() => { this.model.commandSearch(cmd.text || null); this.onRedraw?.(); });
        break;
      }
      case 'find': {
        const hits = this.d.findByName(cmd.text);
        if (!hits.length) { this.say(goNoFindMatches(cmd.text), 'error'); break; }
        this.d.select(hits[0]!.guid);
        break;
      }
      case 'tag': {
        const s = this.d.selected();
        if (!s) { this.say(GOARROW_TAG_NOTHING_SELECTED, 'error'); break; }
        const o = this.d.object(s.guid);
        this.target = { kind: 'object', name: s.name, coords: o ? goCoordsFromCell(o.cell, o.x, o.y) : null, inRange: !!o };
        this.trackedGuid = s.guid;
        this.save('target', this.target);
        this.saveSettings({ visible: true });
        break;
      }
    }
    return true;
  }
}
