/**
 * RELEASE.launcher-screen — the world picker + login drawn on the pre-world
 * screen (layout 0x21000004), before character select.
 *
 * Retail EoL had no in-client login: the external Turbine launcher took the
 * account and world and handed acclient.exe a ticket (docs/release-plan.md,
 * "Login form"). A browser client has no launcher, so this screen is that
 * step, built from the screen's own DAT art instead of a web form:
 *
 *   - backdrop, list frame, ENTER / CREDITS / EXIT: layout 0x21000004 and its
 *     0x21000040 button templates, exactly as character select draws them;
 *   - Account / Password sit where the World box is (its frame hidden), each
 *     input in the DAT edit-field 3-slice 0x06005dc6/c7/c8 (DialogFactory's
 *     text-entry frame 0x21000042:0x10000456);
 *   - the world list fills the Characters listbox (0x1000039d) with rows of
 *     the listbox's own template 0x100003a5 (highlight slices per state);
 *     status bullets are the DAT presence pair 0x06004d17 / 0x06004d19;
 *   - the details panel is the DialogFactory plate (0x21000042:0x100002af);
 *   - "CUSTOM…" takes the DELETE slot's plate (0x100002d1 art), upper-cased
 *     like the DAT's own DELETE / CREDITS / EXIT labels;
 *   - text is the AC bitmap fonts via the DAT text elements named below;
 *     colours are those elements' own (normal / disabled states).
 * The baked "World" / "Characters" labels of backdrop 0x06007576 are covered
 * with patches of the same backdrop (no invented fill).
 *
 * All DAT access goes through LauncherKit (GameUI implements it), so this
 * module holds the behaviour and can be driven with a fake kit in tests.
 */
import type { ElementDesc } from '@ac/dat-parser/file-types/LayoutDesc.js';
import { charselHighlightSlices, charselRowState } from '../ui/CharselListRows.js';
import { descRef } from '../ui/DatTextStyle.js';
import {
  type World, type WorldDirectory, connectUrlFor, parseCustomBridge, probeCustomBridge, worldEnterBlock, worldRegistrationText,
} from './worldDirectory.js';
import { matchUrlWorld } from './urlLogin.js';
import { loadFavoriteWorlds, loadRememberedLogin, saveFavoriteWorlds, saveRememberedLogin, worldKeyOf, type RememberedLogin } from './launcherStorage.js';

export const CHARSEL_LAYOUT = 0x21000004;

/**
 * BUG.world-list-unreachable — a world list that fails to load is tried again
 * quietly after these delays (three attempts in all) while the details box
 * keeps its "Loading worlds…" state; only the last failure shows the error.
 * Production 2026-10-19: a player saw "(Failed to fetch)" from a request that
 * never reached the bridge. A browser-UX exception (CLAUDE.md).
 */
export const WORLD_LIST_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000];
/** While the error shows, the list is tried again in the background this often; a success brings it back. */
export const WORLD_LIST_BACKGROUND_RETRY_MS = 30_000;

/** The bridge's host name for the error text (from the configured bridge URL, never a literal). */
function bridgeHostName(bridgeUrl: string): string | null {
  try { return new URL(bridgeUrl).hostname || null; } catch { return null; }
}

/**
 * The details box's text when the world list can't be loaded: what happened
 * and one next step, no raw error string (the refusal-consistency shape).
 */
export function worldListUnavailableText(bridgeUrl: string): string {
  const host = bridgeHostName(bridgeUrl);
  const blocking = host ? `may be blocking ${host}` : 'may be blocking it';
  return `Can't reach the webAC server right now. Check your connection; if it keeps happening, a browser extension, VPN or network filter ${blocking}.`;
}

/** The CUSTOM pointer under the world-list error. */
export const WORLD_LIST_CUSTOM_HINT = "Or use CUSTOM to enter a server's own bridge.";

/** A world-list load that failed every quiet attempt (LauncherOptions.onWorldListFailed). */
export interface WorldListFailure {
  attempts: number;
  elapsedMs: number;
  /** The last attempt's error (a worldDirectory.WorldDirectoryError from loadWorldDirectory). */
  error: unknown;
}

/** The launcher's custom-bridge era probe: the era, or a rejection when the bridge did not answer. */
async function defaultProbeEra(bridgeUrl: string): Promise<string | null> {
  const r = await probeCustomBridge(bridgeUrl);
  if (!r.reachable) throw new Error(`no answer from ${bridgeUrl}`);
  return r.era;
}
const EL_MAIN = 0x1000039a;
const EL_WORLD_BOX = 0x1000039b;
const EL_LIST = 0x1000039c;
const EL_DELETE = 0x1000039f;
const EL_RESTORE = 0x1000039e;
const EL_CREATE = 0x100003a0;
const EL_ENTER = 0x100003a2;
const EL_CREDITS = 0x100003a3;
const EL_EXIT = 0x100003a4;
const BUTTON_IDS = [EL_RESTORE, EL_DELETE, EL_CREATE, EL_ENTER, EL_CREDITS, EL_EXIT];
/** UIElement disabled state. */
const UI_STATE_DISABLED = 0xd;

/**
 * The site's own pages (deploy/web/site), linked from the launcher so a
 * rendered page has crawlable links to them. Same tab: they are our own site.
 * Two rows: all five don't fit one line in the 259 px gap between the
 * CUSTOM… and CREDITS plates in font 0x40000000.
 */
export const LAUNCHER_SITE_LINKS: readonly (readonly { label: string; href: string }[])[] = [
  [
    { label: 'How to play', href: '/how-to-play-asherons-call/' },
    { label: 'Servers', href: '/servers/' },
    { label: 'Mac & Linux', href: '/mac-linux/' },
  ],
  [
    { label: 'Eras', href: '/eras/' },
    { label: 'About', href: '/about/' },
  ],
];

/** Text styles (DAT text elements) the launcher draws with. */
export const LAUNCHER_TEXT = {
  /** World box text: font 0x4000000b, 0xffd8af5b gold. Field labels, list header, links. */
  label: descRef(CHARSEL_LAYOUT, EL_WORLD_BOX),
  /** Create Character label: font 0x4000000c, 0xffffb219. World name in the details panel. */
  title: descRef(CHARSEL_LAYOUT, EL_CREATE),
  /** Listbox row template: font 0x40000000, cream 0xfffff2cc. Rows and body text. */
  body: descRef(CHARSEL_LAYOUT, 0x100003a5),
  /** Plate-button label (DELETE slot): font 0x4000000b, 0xffffb219 (0xffa8966d disabled). */
  button: descRef(CHARSEL_LAYOUT, EL_DELETE),
  /** ENTER label: font 0x40000012. */
  enter: descRef(CHARSEL_LAYOUT, EL_ENTER),
  /** DialogFactory text-entry edit text (0x2100003C 0x2c/0x3d/0x1000047e/0x2c). */
  edit: descRef(0x2100003c, 0x2c, 0x3d, 0x1000047e, 0x2c),
} as const;

/** Geometry (800x600 pre-world space). */
export const LAUNCHER_GEOMETRY = {
  login: { x: 21, y: 22, w: 193, h: 128 },
  listHeader: { x: 42, y: 170 },
  details: { x: 222, y: 146, w: 256, h: 156 },
  /** Top edge of the ENTER circle's visible rim; the details panel must end above it. */
  enterRimTop: 312,
  rowHeight: 16,
} as const;

export interface LauncherKit {
  /** Clear the pre-world screen container and make the launcher the current screen; returns the mount. */
  prepareScreen(): HTMLElement;
  /** Render layout 0x21000004 into `inner` (buttons caller-drawn); null without DAT layouts. */
  renderLayout(inner: HTMLElement, callerDrawnIds: number[]): { elements: Map<number, HTMLElement>; destroy(): void } | null;
  /** The resolved element desc behind a descRef. */
  desc(ref: string): ElementDesc | null;
  texUrl(id: number): string | null;
  /** `text` drawn as the DAT text element `ref` (bitmap font); `color` overrides. */
  text(text: string, ref: string, opts?: { state?: number; color?: string }): HTMLElement;
  /** Pixel width of `text` in `ref`'s font (null without fonts). */
  measure(ref: string, text: string): number | null;
  /** CSS colour of `ref`'s text in `state` (null without DAT). */
  textColor(ref: string, state?: number): string | null;
  /** Font line height of `ref`'s font (0 without fonts). */
  lineHeight(ref: string): number;
  /**
   * Draw `input` (filling `host`) as the DAT edit text `ref` (DatEditField:
   * the desc's font and colour, the 1-px caret, inverted selection); the
   * input keeps the keys. Null without the font (the input stays as styled).
   * `hJustify` overrides the desc's p20 justification.
   */
  bindEditField(input: HTMLInputElement, host: HTMLElement, ref: string, hJustify?: number, masked?: boolean): { refresh(): void; destroy(): void } | null;
  /** The online colour (the 0x06004d17 presence bullet's green, AC_COLORS.onlineGreen). */
  onlineColor: string;
  attachScale(inner: HTMLElement): void;
  /** DialogFactory dialog plate (navy + gold nine-slice). */
  plate(w: number, h: number): HTMLDivElement;
  /** OK message dialog. */
  message(text: string, onOk?: () => void): void;
  /** DialogFactory text-entry dialog. */
  textEntry(prompt: string, onDone: (typed: string) => void): void;
  /** EXIT's "Are you sure you want to leave?" confirmation. */
  confirmExit(): void;
  /** CREDITS → gmCreditsUI over `frame` (the 800x600 box); `mods` = the click's modifier keys. */
  openCredits(frame: HTMLElement, mods?: { altKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }): void;
  /** Place a plate button's label where the DAT justification puts it. */
  justifyLabel(btn: HTMLElement): void;
  /** Tag a node as layout element (press sounds). */
  tagElement(el: HTMLElement, layoutId: number, elementId: number): void;
  /**
   * Call `cb` whenever streamed DAT files land; returns the unsubscribe.
   * A first visit draws the list before the row art (the online bullets)
   * has streamed in, so the launcher redraws when it missed a texture.
   */
  onFilesArrived?(cb: () => void): () => void;
}

export interface LauncherChoice {
  world: World;
  account: string;
  password: string;
  /** The WebSocket URL to connect to (bridge + ?server=<id>, or a custom bridge). */
  connectUrl: string;
}

export interface LauncherOptions {
  bridgeUrl: string;
  prefillAccount?: string | null;
  /** Lists the worlds (worldDirectory.loadWorldDirectory against the bridge). */
  loadDirectory: () => Promise<WorldDirectory>;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  /**
   * The public source repository (config.json `sourceUrl`). AGPL-3.0 §13:
   * players of the hosted client are offered its source; null hides the link.
   */
  sourceUrl?: string | null;
  /**
   * Show the links to the site's own pages (LAUNCHER_SITE_LINKS, config.json
   * `siteLinks`): true where the web image serves deploy/web/site beside the
   * client, false (local dev) where those pages don't exist.
   */
  siteLinks?: boolean;
  /**
   * `?world=<id or name>` (urlLogin.resolveUrlWorld): once the list loads,
   * that directory world is selected as a click on its row would select it.
   * Unknown or incompatible: the usual default selection.
   */
  linkedWorld?: string | null;
  /**
   * A custom bridge's era from its /healthz (worldDirectory.probeCustomBridge;
   * tests pass a fake). Rejects when the bridge answered neither probe: the
   * world is then World.eraUnknown.
   */
  probeEra?: (bridgeUrl: string) => Promise<string | null>;
  /** Quiet retry delays after a failed world-list load (default WORLD_LIST_RETRY_DELAYS_MS). */
  retryDelaysMs?: readonly number[];
  /** Background retry period while the error shows (default WORLD_LIST_BACKGROUND_RETRY_MS). */
  backgroundRetryMs?: number;
  /**
   * Every quiet attempt failed and the error is now shown (once per load:
   * the first, and each Retry; not the background retries). main.ts sends
   * the web-origin report (telemetry/WebReport.ts).
   */
  onWorldListFailed?: (f: WorldListFailure) => void;
}

/**
 * Greedy word wrap of `text` into at most `maxLines` lines of `width` px; the
 * last kept line gets an ellipsis when text was cut. Without a font measure,
 * falls back to ~6 px per character.
 */
export function wrapLines(text: string, width: number, maxLines: number, measure: (t: string) => number | null): string[] {
  const m = (t: string): number => measure(t) ?? t.length * 6;
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  let i = 0;
  for (; i < words.length; i++) {
    const next = cur ? `${cur} ${words[i]}` : words[i];
    if (m(next) <= width || !cur) { cur = next; continue; }
    lines.push(cur);
    cur = words[i];
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines) {
    if (cur) lines.push(cur);
    return lines;
  }
  let last = lines[lines.length - 1];
  while (last.includes(' ') && m(`${last}…`) > width) last = last.replace(/\s*\S+$/, '');
  lines[lines.length - 1] = `${last}…`;
  return lines;
}

/** A DAT plate button (the 0x21000040 templates): faces normal / hover / pressed, the label in `labelRef`'s font. */
export function launcherPlateButton(
  kit: LauncherKit, inner: HTMLElement, elementId: number, x: number, y: number, w: number, h: number,
  label: string, labelRef: string, faces: [number, number, number], onClick: (e: MouseEvent) => void,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  Object.assign(btn.style, {
    position: 'absolute', left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`, zIndex: '2',
    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0', outline: 'none',
    background: 'transparent', border: 'none', backgroundSize: '100% 100%', backgroundRepeat: 'no-repeat',
  });
  const set = (id: number): void => { const u = kit.texUrl(id); if (u) btn.style.backgroundImage = `url(${u})`; };
  set(faces[0]);
  btn.addEventListener('mouseenter', () => set(faces[1]));
  btn.addEventListener('mouseleave', () => set(faces[0]));
  btn.addEventListener('mousedown', () => set(faces[2]));
  btn.addEventListener('mouseup', () => set(faces[1]));
  const span = kit.text(label, labelRef);
  span.dataset.acDesc = labelRef;
  btn.appendChild(span);
  btn.addEventListener('click', onClick);
  kit.tagElement(btn, CHARSEL_LAYOUT, elementId);
  inner.appendChild(btn);
  kit.justifyLabel(btn);
  return btn;
}

/**
 * Cover the backdrop's baked "World" and "Characters" labels with patches
 * cut from plain sky of the same backdrop texture, feathered at the edges.
 */
export function coverLauncherBakedLabels(kit: LauncherKit, inner: HTMLElement): void {
  const url = kit.texUrl(0x06007576);
  if (!url) return;
  const patches: Array<{ dst: [number, number, number, number]; src: [number, number] }> = [
    // "World" label (above the hidden World box)
    { dst: [40, 14, 160, 50], src: [212, 140] },
    // "Characters" label (above the list frame)
    { dst: [8, 148, 212, 58], src: [212, 140] },
  ];
  for (const p of patches) {
    const [x, y, w, h] = p.dst;
    const el = document.createElement('div');
    el.className = 'launcher-backdrop-patch';
    Object.assign(el.style, {
      position: 'absolute', left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`,
      backgroundImage: `url(${url})`, backgroundSize: '800px 600px',
      backgroundPosition: `${-p.src[0]}px ${-p.src[1]}px`, pointerEvents: 'none', zIndex: '1',
    });
    const mask = 'linear-gradient(to right, transparent, black 14px, black calc(100% - 14px), transparent), linear-gradient(to bottom, transparent, black 10px, black calc(100% - 10px), transparent)';
    el.style.setProperty('mask-image', mask);
    el.style.setProperty('-webkit-mask-image', mask);
    el.style.setProperty('mask-composite', 'intersect');
    el.style.setProperty('-webkit-mask-composite', 'source-in');
    inner.appendChild(el);
  }
}

export class LauncherScreen {
  private worlds: World[] = [];
  private mode: WorldDirectory['mode'] | null = null;
  private selected: World | null = null;
  private loadError: string | null = null;
  /** The world directory request is in flight. */
  private loadingWorlds = false;
  /** ENTER was pressed before the world list arrived. */
  private pendingEnter = false;
  private account = '';
  private remembered: RememberedLogin;
  /** The `?world=` link, until the first directory load consumes it. */
  private linkedWorld: string | null;
  private resolve: ((c: LauncherChoice) => void) | null = null;
  private handle: { destroy(): void } | null = null;
  private listEl: HTMLElement | null = null;
  private detailsEl: HTMLElement | null = null;
  private headerEl: HTMLElement | null = null;
  private loginEl: HTMLElement | null = null;
  private accountInput: HTMLInputElement | null = null;
  private accountField: { refresh(): void; destroy(): void } | null = null;
  private passwordField: { refresh(): void; destroy(): void } | null = null;
  private passwordInput: HTMLInputElement | null = null;
  private done = false;
  /** A list texture was not resident yet when last drawn (streamed DATs). */
  private texMissed = false;
  private unsubscribeArrivals: (() => void) | null = null;

  constructor(private readonly kit: LauncherKit, private readonly opts: LauncherOptions) {
    this.linkedWorld = opts.linkedWorld ?? null;
    this.remembered = loadRememberedLogin(opts.storage === undefined ? undefined : opts.storage);
    this.account = opts.prefillAccount ?? this.remembered.account ?? '';
    this.favorites = loadFavoriteWorlds(opts.storage === undefined ? undefined : opts.storage);
  }

  /** Favourite world keys (worldKeyOf), oldest first; launcherStorage keeps them. */
  private favorites: string[];

  isFavorite(w: World): boolean { return this.favorites.includes(worldKeyOf(w)); }

  /** Star or unstar a world; the list re-sorts with favourites first. */
  toggleFavorite(w: World): void {
    const k = worldKeyOf(w);
    this.favorites = this.favorites.includes(k) ? this.favorites.filter((x) => x !== k) : [...this.favorites, k];
    saveFavoriteWorlds(this.favorites, this.opts.storage === undefined ? undefined : this.opts.storage);
    this.refresh();
    // Centred, not `nearest`: a row starred near the top shows the whole
    // favourites group above it, not the list cut one row short.
    this.revealSelected();
  }

  /** The list as drawn: favourites first (directory order kept within each group). */
  get orderedWorlds(): World[] {
    const fav = this.worlds.filter((w) => this.isFavorite(w));
    return fav.length ? [...fav, ...this.worlds.filter((w) => !this.isFavorite(w))] : this.worlds;
  }

  /** Greyed text: the plate label's disabled-state colour (0xffa8966d). */
  private get dim(): string | undefined { return this.kit.textColor(LAUNCHER_TEXT.button, UI_STATE_DISABLED) ?? undefined; }
  /** Notes: the plate label's normal colour (0xffffb219). */
  private get warn(): string | undefined { return this.kit.textColor(LAUNCHER_TEXT.button) ?? undefined; }

  /** Draw the screen, load the worlds, and resolve when the player enters a world. */
  run(): Promise<LauncherChoice> {
    const p = new Promise<LauncherChoice>((resolve) => { this.resolve = resolve; });
    this.unsubscribeArrivals = this.kit.onFilesArrived?.(() => {
      if (this.done || !this.texMissed) return;
      this.texMissed = false;
      this.refresh();
    }) ?? null;
    this.build();
    void this.load();
    return p;
  }

  get listedWorlds(): readonly World[] { return this.worlds; }
  get selectedWorld(): World | null { return this.selected; }
  /** Resolves once the first directory load has finished (tests). */
  loaded: Promise<void> = Promise.resolve();

  /** Bumped by each load and by leaving: a stale attempt or timer does nothing. */
  private loadGen = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** Load the world list again now (the error's Retry link), with the quiet retries. */
  retryWorldList(): Promise<void> {
    if (this.done || (this.loadingWorlds && this.loadError === null)) return this.loaded;
    return this.load();
  }

  private load(): Promise<void> {
    const gen = ++this.loadGen;
    this.clearRetryTimer();
    this.loadingWorlds = true;
    const wasShowingError = this.loadError !== null;
    this.loadError = null;
    if (wasShowingError) this.refresh();
    this.loaded = (async () => {
      const started = Date.now();
      const delays = this.opts.retryDelaysMs ?? WORLD_LIST_RETRY_DELAYS_MS;
      let lastErr: unknown = null;
      let attempts = 0;
      for (;;) {
        attempts++;
        try {
          const dir = await this.opts.loadDirectory();
          if (gen !== this.loadGen || this.done) return;
          this.finishLoad(this.applyDirectory(dir));
          return;
        } catch (err) {
          lastErr = err;
        }
        if (gen !== this.loadGen || this.done) return;
        if (attempts > delays.length) break;
        await new Promise<void>((resolve) => { this.retryTimer = setTimeout(resolve, delays[attempts - 1]); });
        this.retryTimer = null;
        if (gen !== this.loadGen || this.done) return;
      }
      this.loadError = worldListUnavailableText(this.opts.bridgeUrl);
      this.finishLoad(null);
      try { this.opts.onWorldListFailed?.({ attempts, elapsedMs: Date.now() - started, error: lastErr }); } catch { /* reporting never breaks the launcher */ }
      this.scheduleBackgroundRetry(gen);
    })();
    return this.loaded;
  }

  /** While the error shows: try again every backgroundRetryMs, silently; a success replaces the error with the list. */
  private scheduleBackgroundRetry(gen: number): void {
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (gen !== this.loadGen || this.done) return;
      this.loaded = this.opts.loadDirectory().then(
        (dir) => {
          if (gen !== this.loadGen || this.done) return;
          this.finishLoad(this.applyDirectory(dir));
        },
        () => {
          if (gen !== this.loadGen || this.done) return;
          this.scheduleBackgroundRetry(gen);
        },
      );
    }, this.opts.backgroundRetryMs ?? WORLD_LIST_BACKGROUND_RETRY_MS);
  }

  /** Take a loaded directory in; returns the `?world=` link's world to select, if any. */
  private applyDirectory(dir: WorldDirectory): World | null {
    this.mode = dir.mode;
    const linked = matchUrlWorld(dir.worlds, this.linkedWorld);
    this.linkedWorld = null;
    const custom = this.worlds.filter((w) => w.kind === 'custom');
    this.worlds = [...custom, ...dir.worlds];
    const key = this.remembered.worldKey;
    // The remembered custom bridge, then any favourite ones: a custom
    // world is not in the directory, so it is rebuilt from its key.
    if (!custom.length) {
      const keys = [...(key?.startsWith('custom:') ? [key] : []), ...this.favorites.filter((k) => k.startsWith('custom:') && k !== key)];
      for (const k of keys.reverse()) {
        const r = parseCustomBridge(k.slice('custom:'.length));
        if ('world' in r) {
          this.worlds.unshift(r.world);
          this.probeCustomEra(r.world);
        }
      }
    }
    if (!this.selected) {
      this.selected = this.worlds.find((w) => key !== null && worldKeyOf(w) === key)
        ?? this.orderedWorlds.find((w) => worldEnterBlock(w) === null)
        ?? this.orderedWorlds[0] ?? null;
    }
    this.loadError = null;
    return linked;
  }

  private finishLoad(linked: World | null): void {
    this.loadingWorlds = false;
    if (this.done) return;
    this.refresh();
    if (linked) this.select(linked);
    this.revealSelected();
    if (this.pendingEnter) {
      this.pendingEnter = false;
      this.attemptEnter();
    }
  }

  // ─── Building ─────────────────────────────────────────

  private build(): void {
    const mount = this.kit.prepareScreen();
    const inner = document.createElement('div');
    inner.id = 'launcher-inner';
    inner.dataset.mode = 'launcher';
    Object.assign(inner.style, { position: 'absolute', left: '0', top: '0', width: '800px', height: '600px', overflow: 'hidden' });
    this.kit.attachScale(inner);
    mount.appendChild(inner);

    const lh = this.kit.renderLayout(inner, BUTTON_IDS);
    this.handle = lh;
    // The World box frame is the character-select world plate; the launcher
    // puts the login fields there instead.
    const worldBox = lh?.elements.get(EL_WORLD_BOX);
    if (worldBox) worldBox.style.display = 'none';
    const main = lh?.elements.get(EL_MAIN);
    if (main && (!main.style.backgroundImage || main.style.backgroundImage === 'none')) {
      const bg = this.kit.texUrl(0x06007576);
      if (bg) Object.assign(main.style, { backgroundImage: `url(${bg})`, backgroundSize: '800px 600px' });
    }

    coverLauncherBakedLabels(this.kit, inner);
    this.buildLogin(inner);

    const header = document.createElement('div');
    header.className = 'launcher-list-header';
    Object.assign(header.style, {
      position: 'absolute', left: `${LAUNCHER_GEOMETRY.listHeader.x}px`, top: `${LAUNCHER_GEOMETRY.listHeader.y}px`,
      pointerEvents: 'none', zIndex: '2',
    });
    this.headerEl = header;
    inner.appendChild(header);

    // AGPL-3.0 §13 source offer: a plain link in the gap between the
    // Custom… and CREDITS plates, below the ENTER circle.
    if (this.opts.sourceUrl) {
      const src = document.createElement('a');
      src.className = 'launcher-source';
      src.href = this.opts.sourceUrl;
      src.target = '_blank';
      src.rel = 'noopener noreferrer';
      Object.assign(src.style, {
        position: 'absolute', left: '236px', top: '566px', width: '230px',
        textAlign: 'center', textDecoration: 'none', zIndex: '2',
      });
      src.appendChild(this.kit.text('Source code (AGPL-3.0)', LAUNCHER_TEXT.body, { color: this.dim }));
      inner.appendChild(src);
    }

    // The site's own pages, two rows above the source link (ENTER's circle
    // ends at y 500), centred in the same 230 px box.
    if (this.opts.siteLinks) {
      LAUNCHER_SITE_LINKS.forEach((row, i) => {
        const rowEl = document.createElement('div');
        rowEl.className = 'launcher-site-links';
        Object.assign(rowEl.style, {
          position: 'absolute', left: '236px', top: `${534 + i * 16}px`, width: '230px',
          display: 'flex', justifyContent: 'center', columnGap: '12px', zIndex: '2',
        });
        for (const link of row) {
          const a = document.createElement('a');
          a.className = 'launcher-site-link';
          a.href = link.href;
          a.style.textDecoration = 'none';
          a.appendChild(this.kit.text(link.label, LAUNCHER_TEXT.body, { color: this.dim }));
          rowEl.appendChild(a);
        }
        inner.appendChild(rowEl);
      });
    }

    const listHost = lh?.elements.get(EL_LIST) ?? (() => {
      const el = document.createElement('div');
      Object.assign(el.style, { position: 'absolute', left: '37px', top: '205px', width: '170px', height: '334px' });
      inner.appendChild(el);
      return el;
    })();
    listHost.style.pointerEvents = 'auto';
    // The list's bottom 10 px (y 522–532) lie inside the CUSTOM… button's 170x99
    // box (EL_DELETE at y 522), whose plate art only starts near y 548: above
    // the buttons, a click on the last row selects that world instead of
    // opening Custom… (seen on playwebac.com 2026-10-09: "Mistwood" opened it).
    listHost.style.zIndex = '3';
    // The listbox 0x1000039d at (5,7) 160x320 inside the list frame.
    const scroll = document.createElement('div');
    scroll.className = 'launcher-world-list';
    scroll.setAttribute('role', 'listbox');
    scroll.setAttribute('aria-label', 'Worlds');
    Object.assign(scroll.style, {
      position: 'absolute', left: '5px', top: '7px', width: '160px', height: '320px',
      overflowY: 'auto', overflowX: 'hidden', boxSizing: 'border-box', scrollbarWidth: 'thin',
    });
    // Arrow keys step through the worlds instead of scrolling the list.
    scroll.addEventListener('keydown', (e) => this.onListKey(e));
    listHost.appendChild(scroll);
    this.listEl = scroll;

    const g = LAUNCHER_GEOMETRY.details;
    const details = this.kit.plate(g.w, g.h);
    details.classList.add('launcher-details');
    details.setAttribute('aria-live', 'polite');
    Object.assign(details.style, { position: 'absolute', left: `${g.x}px`, top: `${g.y}px`, zIndex: '2', overflow: 'hidden' });
    this.detailsEl = details;
    inner.appendChild(details);

    this.buildButtons(inner);
    this.refresh();
  }

  private buildLogin(inner: HTMLElement): void {
    const g = LAUNCHER_GEOMETRY.login;
    const form = document.createElement('form');
    form.className = 'launcher-login';
    form.setAttribute('autocomplete', 'on');
    Object.assign(form.style, {
      position: 'absolute', left: `${g.x}px`, top: `${g.y}px`, width: `${g.w}px`, height: `${g.h}px`,
      margin: '0', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '6px',
      padding: '0 12px', boxSizing: 'border-box', zIndex: '3',
    });
    form.addEventListener('submit', (e) => { e.preventDefault(); this.attemptEnter(); });
    const editColor = this.kit.textColor(LAUNCHER_TEXT.edit) ?? this.kit.textColor(LAUNCHER_TEXT.body) ?? 'white';
    const editPx = Math.max(10, Math.min(14, this.kit.lineHeight(LAUNCHER_TEXT.edit) || 12));
    const field = (label: string, type: 'text' | 'password', autocomplete: string, value: string): HTMLInputElement => {
      const lbl = document.createElement('label');
      Object.assign(lbl.style, { display: 'flex', flexDirection: 'column', gap: '3px' });
      const cap = this.kit.text(label, LAUNCHER_TEXT.label);
      cap.style.alignSelf = 'flex-start';
      lbl.appendChild(cap);
      const frame = document.createElement('div');
      frame.className = 'launcher-edit-frame';
      Object.assign(frame.style, { position: 'relative', height: '24px', width: '100%' });
      const slice = (tex: number, style: Record<string, string>): void => {
        const s = document.createElement('div');
        s.dataset.tex = `0x${tex.toString(16).padStart(8, '0')}`;
        Object.assign(s.style, { position: 'absolute', top: '0', height: '24px', backgroundSize: '100% 100%', pointerEvents: 'none' }, style);
        const u = this.kit.texUrl(tex);
        if (u) s.style.backgroundImage = `url(${u})`;
        frame.appendChild(s);
      };
      slice(0x06005dc6, { left: '0', width: '11px' });
      slice(0x06005dc7, { left: '11px', right: '11px' });
      slice(0x06005dc8, { right: '0', width: '11px' });
      // The edit text's own box inside the frame art.
      const host = document.createElement('div');
      host.className = 'launcher-edit';
      Object.assign(host.style, { position: 'absolute', left: '4px', top: '4px', width: 'calc(100% - 8px)', height: '16px' });
      const input = document.createElement('input');
      input.type = type;
      input.name = type === 'password' ? 'password' : 'username';
      input.setAttribute('autocomplete', autocomplete);
      input.spellcheck = false;
      input.autocapitalize = 'off';
      // No maxLength: an input's cap silently cuts what is typed or pasted, and
      // retail sent the whole string (the EoL client keeps -a/-v in a PStringBase;
      // ACE reads String16L/String32L with no cap, refusing an account over 50
      // itself). A cut account name auto-created a different account.
      input.value = value;
      Object.assign(input.style, {
        position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', zIndex: '5',
        boxSizing: 'border-box', padding: '0 3px', background: 'transparent', border: 'none', outline: 'none',
        color: editColor, caretColor: editColor, fontFamily: 'Tahoma, Verdana, sans-serif', fontSize: `${editPx}px`,
        textAlign: 'left',
      });
      host.appendChild(input);
      frame.appendChild(host);
      lbl.appendChild(frame);
      form.appendChild(lbl);
      return input;
    };
    this.accountInput = field('Account', 'text', 'username', this.account);
    this.accountInput.classList.add('launcher-account');
    // RECON.dom-chrome-sweep.d — the account types in the DialogFactory
    // edit font (DatEditField), and so does the password (.d.a), drawn as
    // one dot per character in that font. Retail had no in-client login
    // (the Turbine launcher took the password), so no DAT or decomp names a
    // mask glyph: the dot is Jake's call (2026-10-10), matching the game's
    // other edit fields otherwise. The <input> stays type=password for
    // password managers; its own bullets are transparent like the account's text.
    this.accountField?.destroy();
    // Left-justified (p20 = 0), not the text-entry desc's centring: the desc
    // only lends the font and colour, and a login field reads left to right
    // with the password's bullets under it (Jake, 2026-10-10).
    this.accountField = this.kit.bindEditField(this.accountInput, this.accountInput.parentElement!, LAUNCHER_TEXT.edit, 0);
    this.accountInput.addEventListener('input', () => { this.account = this.accountInput!.value; });
    this.passwordInput = field('Password', 'password', 'current-password', '');
    this.passwordInput.classList.add('launcher-password');
    this.passwordField?.destroy();
    this.passwordField = this.kit.bindEditField(this.passwordInput, this.passwordInput.parentElement!, LAUNCHER_TEXT.edit, 0, true);
    // Hidden submit so Enter in either field submits the form (and password
    // managers see a real login form).
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.tabIndex = -1;
    Object.assign(submit.style, { position: 'absolute', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' });
    form.appendChild(submit);
    this.loginEl = form;
    inner.appendChild(form);
  }

  private plateButton(
    inner: HTMLElement, elementId: number, x: number, y: number, w: number, h: number,
    label: string, labelRef: string, faces: [number, number, number], onClick: (e: MouseEvent) => void,
  ): HTMLButtonElement {
    return launcherPlateButton(this.kit, inner, elementId, x, y, w, h, label, labelRef, faces, onClick);
  }

  private buildButtons(inner: HTMLElement): void {
    // ENTER ellipse (template 0x100002d9): 0x06004cb2 normal, 0x06004cb3 hover / pressed.
    const enter = this.plateButton(inner, EL_ENTER, 239, 289, 211, 211, 'ENTER', LAUNCHER_TEXT.enter,
      [0x06004cb2, 0x06004cb3, 0x06004cb3], () => this.attemptEnter());
    enter.classList.add('launcher-enter');
    enter.setAttribute('aria-label', 'Enter this world');
    // The 170x99 plate 0x100002d1: 0x06004c9e normal / 9f hover / a0 pressed.
    const plate: [number, number, number] = [0x06004c9e, 0x06004c9f, 0x06004ca0];
    // DELETE slot → Custom…
    const custom = this.plateButton(inner, EL_DELETE, 36, 522, 170, 99, 'CUSTOM…', LAUNCHER_TEXT.button, plate, () => this.promptCustom());
    custom.classList.add('launcher-custom');
    this.plateButton(inner, EL_CREDITS, 465, 522, 170, 99, 'CREDITS', descRef(CHARSEL_LAYOUT, EL_CREDITS), plate, (e) => this.kit.openCredits(inner, e));
    this.plateButton(inner, EL_EXIT, 615, 522, 170, 99, 'EXIT', descRef(CHARSEL_LAYOUT, EL_EXIT), plate, () => this.kit.confirmExit());
  }

  // ─── State → DOM ──────────────────────────────────────

  /** A list texture's URL; a miss redraws the list once the file streams in. */
  private listTex(id: number): string | null {
    const u = this.kit.texUrl(id);
    if (!u) this.texMissed = true;
    return u;
  }

  private refresh(): void {
    this.renderHeader();
    this.renderList();
    this.renderDetails();
    if (this.loginEl) this.loginEl.style.opacity = this.selected && worldEnterBlock(this.selected) ? '0.45' : '1';
  }

  private renderHeader(): void {
    const h = this.headerEl;
    if (!h) return;
    h.replaceChildren();
    const listed = this.worlds.filter((w) => w.kind === 'listed').length;
    const text = this.mode === 'multi' ? `Public worlds · ${listed}` : this.mode === 'pinned' ? 'Local world' : 'Worlds';
    h.appendChild(this.kit.text(text, LAUNCHER_TEXT.label));
  }

  private renderList(): void {
    const list = this.listEl;
    if (!list) return;
    const keep = list.scrollTop;
    // A row had focus (clicked, or arrowed to): the rebuilt selected row keeps it.
    const hadFocus = list.contains(document.activeElement);
    list.replaceChildren();
    const rowDesc = this.kit.desc(LAUNCHER_TEXT.body);
    const rowH = LAUNCHER_GEOMETRY.rowHeight;
    const ordered = this.orderedWorlds;
    const favCount = ordered.filter((w) => this.isFavorite(w)).length;
    ordered.forEach((w, i) => {
      const selected = w === this.selected;
      const fav = i < favCount;
      const row = document.createElement('div');
      row.className = 'launcher-world-row';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(selected));
      row.tabIndex = 0;
      row.dataset.world = worldKeyOf(w);
      const blocked = worldEnterBlock(w) !== null;
      if (blocked) row.dataset.blocked = 'true';
      Object.assign(row.style, {
        position: 'relative', width: '100%', height: `${rowH}px`, boxSizing: 'border-box', cursor: 'pointer',
        display: 'flex', alignItems: 'center', gap: '4px', padding: '0 4px 0 3px', overflow: 'hidden', outline: 'none',
      });
      if (fav) row.dataset.favorite = 'true';
      const paint = (rollover: boolean): void => {
        const state = charselRowState(selected, rollover);
        row.dataset.state = `0x${state.toString(16)}`;
        row.querySelectorAll('.launcher-row-hl').forEach((n) => n.remove());
        if (!rowDesc) return;
        for (const s of charselHighlightSlices(rowDesc, rowH, state)) {
          const u = s.file ? this.listTex(s.file) : null;
          if (!u) continue;
          const hl = document.createElement('div');
          hl.className = 'launcher-row-hl';
          Object.assign(hl.style, {
            position: 'absolute', left: '0', top: `${s.y}px`, width: '100%', height: `${s.height}px`,
            backgroundImage: `url(${u})`, backgroundSize: '100% 100%', pointerEvents: 'none',
          });
          row.insertBefore(hl, row.firstChild);
        }
      };
      paint(false);
      // The heart: the health ornament pair (0x06007491 bright / 0x06007490
      // depleted, layout 0x2100006c). Bright on a favourite; the depleted
      // heart appears on hover so any row can be starred.
      const heart = document.createElement('span');
      heart.className = 'launcher-fav';
      heart.setAttribute('role', 'button');
      heart.setAttribute('aria-label', fav ? `Remove ${w.name} from favorites` : `Add ${w.name} to favorites`);
      heart.setAttribute('aria-pressed', String(fav));
      Object.assign(heart.style, {
        position: 'relative', flex: '0 0 11px', width: '11px', height: '10px', backgroundSize: '100% 100%', cursor: 'pointer',
      });
      const heartArt = (show: boolean): void => {
        const u = show ? this.listTex(fav ? 0x06007491 : 0x06007490) : null;
        heart.style.backgroundImage = u ? `url(${u})` : 'none';
      };
      heartArt(fav);
      // The heart selects its own world too: the list then follows the row
      // to its new place instead of scrolling back to another selection
      // (Jake, 2026-10-16: "it jumps back to my focused right on heart/unheart").
      heart.addEventListener('click', (e) => {
        e.stopPropagation();
        this.selected = w;
        this.toggleFavorite(w);
        (this.listEl?.querySelector('.launcher-world-row[aria-selected="true"]') as HTMLElement | null)?.focus({ preventScroll: true });
      });
      heart.addEventListener('dblclick', (e) => e.stopPropagation());
      row.addEventListener('mouseenter', () => { paint(true); heartArt(true); });
      row.addEventListener('mouseleave', () => { paint(false); heartArt(fav); });

      // Left edge: the list's overlay scrollbar covers the right one.
      row.appendChild(heart);
      const dot = document.createElement('span');
      dot.className = 'launcher-dot';
      Object.assign(dot.style, { position: 'relative', flex: '0 0 9px', width: '9px', height: '9px', backgroundSize: '100% 100%' });
      if (w.online !== null) {
        const u = this.listTex(w.online ? 0x06004d17 : 0x06004d19);
        if (u) dot.style.backgroundImage = `url(${u})`;
        dot.dataset.online = String(w.online);
      }
      row.appendChild(dot);

      const state = charselRowState(selected, false);
      const name = this.kit.text(w.name, LAUNCHER_TEXT.body, { state, color: blocked ? this.dim : undefined });
      const nameBox = document.createElement('span');
      Object.assign(nameBox.style, { position: 'relative', flex: '1 1 auto', overflow: 'hidden', whiteSpace: 'nowrap' });
      nameBox.appendChild(name);
      row.appendChild(nameBox);

      const popText = w.online === false ? 'offline' : w.population !== null ? String(w.population) : '';
      if (popText) {
        const pop = this.kit.text(popText, LAUNCHER_TEXT.body, { state, color: selected ? undefined : this.dim });
        pop.style.position = 'relative';
        pop.style.flex = '0 0 auto';
        row.appendChild(pop);
      }
      row.addEventListener('click', () => this.select(w));
      // Retail's character list enters on a double-click; a world row does the same.
      row.addEventListener('dblclick', () => { this.select(w); this.attemptEnter(); });
      row.addEventListener('keydown', (e) => {
        const k = (e as KeyboardEvent).key;
        if (k === 'Enter') { e.preventDefault(); this.select(w); this.attemptEnter(); } else if (k === ' ') { e.preventDefault(); this.select(w); }
      });
      list.appendChild(row);
    });
    if (this.worlds.length === 0 && !this.loadError && this.mode === null) {
      const loading = this.kit.text('Loading worlds…', LAUNCHER_TEXT.body, { color: this.dim });
      loading.style.margin = '2px 4px';
      list.appendChild(loading);
    }
    list.scrollTop = keep;
    if (hadFocus) (list.querySelector('.launcher-world-row[aria-selected="true"]') as HTMLElement | null)?.focus({ preventScroll: true });
  }

  /** ArrowUp/Down, PageUp/Down, Home/End move the selection through the list. */
  private onListKey(e: KeyboardEvent): void {
    const worlds = this.orderedWorlds;
    if (!worlds.length) return;
    // F stars the selected world (Ctrl/Cmd+F stays the browser's find).
    if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (this.selected) { e.preventDefault(); this.toggleFavorite(this.selected); }
      return;
    }
    const last = worlds.length - 1;
    const cur = this.selected ? worlds.indexOf(this.selected) : -1;
    const page = Math.max(1, Math.floor((this.listEl?.clientHeight || 0) / LAUNCHER_GEOMETRY.rowHeight) - 1);
    let next: number;
    switch (e.key) {
      case 'ArrowDown': next = cur < 0 ? 0 : Math.min(last, cur + 1); break;
      case 'ArrowUp': next = cur < 0 ? 0 : Math.max(0, cur - 1); break;
      case 'PageDown': next = Math.min(last, Math.max(0, cur) + page); break;
      case 'PageUp': next = Math.max(0, cur - page); break;
      case 'Home': next = 0; break;
      case 'End': next = last; break;
      default: return;
    }
    e.preventDefault();
    this.select(worlds[next]);
    this.revealSelected(true);
  }

  private renderDetails(): void {
    const d = this.detailsEl;
    if (!d) return;
    d.querySelector('.launcher-details-body')?.remove();
    const g = LAUNCHER_GEOMETRY.details;
    const body = document.createElement('div');
    body.className = 'launcher-details-body';
    const padX = 12;
    const width = g.w - padX * 2;
    Object.assign(body.style, {
      position: 'absolute', left: `${padX}px`, top: '9px', width: `${width}px`, bottom: '7px',
      display: 'flex', flexDirection: 'column', gap: '3px', overflow: 'hidden',
    });
    const measureBody = (t: string) => this.kit.measure(LAUNCHER_TEXT.body, t);
    const para = (text: string, maxLines: number, color: string | undefined, cls: string): HTMLElement => {
      const box = document.createElement('div');
      box.className = cls;
      box.style.flexShrink = '0';
      for (const line of wrapLines(text, width, maxLines, measureBody)) {
        const el = this.kit.text(line, LAUNCHER_TEXT.body, { color });
        el.style.display = 'block';
        box.appendChild(el);
      }
      return box;
    };
    const w = this.selected;
    if (!w) {
      const waiting = this.pendingEnter ? 'Loading worlds… You will enter as soon as the list arrives.' : 'Loading worlds…';
      body.appendChild(para(this.loadError ?? waiting, 6, this.loadError ? this.warn : this.dim, 'launcher-desc'));
      if (this.loadError) {
        // Retry, drawn like the details box's Website / Discord / Favorite links.
        const row = document.createElement('div');
        row.className = 'launcher-links';
        Object.assign(row.style, { display: 'flex', flexShrink: '0', gap: '12px' });
        const retry = document.createElement('a');
        retry.className = 'launcher-retry-link';
        retry.href = '#';
        retry.style.textDecoration = 'none';
        retry.addEventListener('click', (e) => { e.preventDefault(); void this.retryWorldList(); });
        retry.appendChild(this.kit.text('Retry', LAUNCHER_TEXT.body, { color: this.kit.textColor(LAUNCHER_TEXT.label) ?? undefined }));
        row.appendChild(retry);
        body.appendChild(row);
        body.appendChild(para(WORLD_LIST_CUSTOM_HINT, 2, this.dim, 'launcher-hint'));
      }
      d.appendChild(body);
      return;
    }
    const title = this.kit.text(w.name, LAUNCHER_TEXT.title);
    title.classList.add('launcher-world-name');
    title.style.alignSelf = 'flex-start';
    title.style.flexShrink = '0';
    body.appendChild(title);

    // One meta row: emulator, ruleset, status, compat note.
    const meta = document.createElement('div');
    meta.className = 'launcher-meta';
    Object.assign(meta.style, { display: 'flex', flexWrap: 'nowrap', flexShrink: '0', gap: '8px', whiteSpace: 'nowrap', overflow: 'hidden' });
    const chip = (text: string, color: string | undefined): void => { meta.appendChild(this.kit.text(text, LAUNCHER_TEXT.body, { color })); };
    if (w.emu) chip(w.emu, this.dim);
    if (w.type) chip(w.type, this.dim);
    if (w.online === true) chip(w.population !== null ? `${w.population} online` : 'Online', this.kit.onlineColor);
    else if (w.online === false) chip('Offline', this.dim);
    if (w.compat !== 'ok' && w.compatNote) chip(w.compatNote, this.warn);
    if (meta.childElementCount) body.appendChild(meta);

    if (w.description) body.appendChild(para(w.description, 2, undefined, 'launcher-desc'));

    const links: Array<[string, string]> = [];
    // A register-first world: its registration page leads the links.
    if (w.registrationUrl) links.push(['Register', w.registrationUrl]);
    if (w.website) links.push(['Website', w.website]);
    if (w.discord) links.push(['Discord', w.discord]);
    {
      const row = document.createElement('div');
      row.className = 'launcher-links';
      Object.assign(row.style, { display: 'flex', flexShrink: '0', gap: '12px' });
      for (const [label, href] of links) {
        const a = document.createElement('a');
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.style.textDecoration = 'none';
        a.appendChild(this.kit.text(label, LAUNCHER_TEXT.body, { color: this.kit.textColor(LAUNCHER_TEXT.label) ?? undefined }));
        row.appendChild(a);
      }
      const fav = document.createElement('a');
      fav.className = 'launcher-fav-link';
      fav.href = '#';
      fav.style.textDecoration = 'none';
      fav.addEventListener('click', (e) => { e.preventDefault(); this.toggleFavorite(w); });
      fav.appendChild(this.kit.text(this.isFavorite(w) ? 'Unfavorite' : 'Favorite', LAUNCHER_TEXT.body, { color: this.kit.textColor(LAUNCHER_TEXT.label) ?? undefined }));
      row.appendChild(fav);
      body.appendChild(row);
    }

    const registration = worldRegistrationText(w);
    if (w.compat === 'incompatible') {
      // Nobody can play there from webAC (e.g. a VPN check that refuses the
      // bridge): say so where the new-player hint goes, before ENTER is tried.
      body.appendChild(para(w.compatReason ?? "This world can't be played from webAC.", 2, this.warn, 'launcher-hint launcher-blocked'));
    } else if (w.compatWarning) {
      // Enterable, but something a newcomer expects doesn't work from webAC
      // (AC1999: no new accounts, its per-address cap): warn where the
      // new-player hint goes, in the 2 lines the box has.
      body.appendChild(para(w.compatWarning, 2, this.warn, 'launcher-hint launcher-warning'));
    } else if (registration && w.registrationUrl) {
      // The whole note is a link to the world's registration page, in the link
      // colour; 2 lines, the room the details box has below the links row (a
      // third line was clipped by the box on playwebac.com, 2026-10-12).
      const a = document.createElement('a');
      a.className = 'launcher-hint launcher-register';
      a.href = w.registrationUrl;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      Object.assign(a.style, { textDecoration: 'none', flexShrink: '0' });
      a.append(...Array.from(para(registration, 2, this.kit.textColor(LAUNCHER_TEXT.label) ?? undefined, 'launcher-register-text').childNodes));
      body.appendChild(a);
    } else {
      const hint = registration
        ? `New here? ${registration}`
        : 'New here? Most worlds create your account the first time you log in.';
      body.appendChild(para(hint, 2, this.dim, 'launcher-hint'));
    }
    d.appendChild(body);
  }

  /**
   * Scroll the list so the selected row is visible (a remembered world may sit
   * far down): centred, or just enough to bring it in (`nearest`, arrow keys).
   */
  private revealSelected(nearest = false): void {
    const list = this.listEl;
    const row = list?.querySelector('.launcher-world-row[aria-selected="true"]') as HTMLElement | null;
    if (!list || !row) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top >= list.scrollTop && bottom <= list.scrollTop + list.clientHeight) return;
    if (!nearest) list.scrollTop = Math.max(0, top - Math.floor(list.clientHeight / 2));
    else list.scrollTop = top < list.scrollTop ? top : bottom - list.clientHeight;
  }

  // ─── Actions ──────────────────────────────────────────

  select(w: World): void {
    if (this.selected === w) return;
    this.selected = w;
    this.refresh();
  }

  /** ENTER / double-click / Enter: connect, or explain why not. */
  attemptEnter(): void {
    if (this.done) return;
    // RELEASE.launcher-enter-before-ready — ENTER while the world list is
    // still loading (no world selected yet) used to do nothing. Hold the
    // click and enter once the list arrives (load() re-runs this).
    const waitForList = !this.selected && this.loadingWorlds;
    const w = this.selected;
    const block = worldEnterBlock(w);
    if (!waitForList && (block || !w)) { this.kit.message(block ?? 'Pick a world first.'); return; }
    const account = (this.accountInput?.value ?? this.account).trim();
    const password = this.passwordInput?.value ?? '';
    if (!account) { this.kit.message('Enter an account name.', () => this.accountInput?.focus()); return; }
    // ACE rejects an empty password outright (AuthenticationHandler: no
    // auto-create, no login), and the connect dialog then waited forever.
    if (!password) { this.kit.message('Enter a password.', () => this.passwordInput?.focus()); return; }
    if (waitForList || !w) {
      this.pendingEnter = true;
      this.refresh();
      return;
    }
    this.done = true;
    this.loadGen++;
    this.clearRetryTimer();
    const finish = (): void => {
      saveRememberedLogin({ worldKey: worldKeyOf(w), account, era: w.era }, this.opts.storage === undefined ? undefined : this.opts.storage);
      this.handle?.destroy();
      this.handle = null;
      this.accountField?.destroy();
      this.accountField = null;
      this.passwordField?.destroy();
      this.passwordField = null;
      this.unsubscribeArrivals?.();
      this.unsubscribeArrivals = null;
      this.resolve?.({ world: w, account, password, connectUrl: connectUrlFor(this.opts.bridgeUrl, w) });
    };
    // A custom world's era comes from its bridge; enter once that answer is in.
    if (this.eraProbes.length) void Promise.all(this.eraProbes).then(finish);
    else finish();
  }

  private promptCustom(): void {
    this.kit.textEntry('Enter the wss:// address of a server\'s own webAC bridge (not its game server address).', (typed) => {
      if (!typed.trim()) return;
      const r = parseCustomBridge(typed);
      if ('error' in r) { this.kit.message(r.error); return; }
      this.worlds = [r.world, ...this.worlds.filter((x) => !(x.kind === 'custom' && x.bridgeUrl === r.world.bridgeUrl))];
      this.selected = r.world;
      this.refresh();
      this.probeCustomEra(r.world);
    });
  }

  /** In-flight era probes of custom bridges; ENTER waits for them. */
  private eraProbes: Promise<void>[] = [];

  /** Ask a custom world's own bridge which era it serves (its /healthz `era`). */
  private probeCustomEra(w: World): void {
    if (w.kind !== 'custom' || !w.bridgeUrl) return;
    const probe = (this.opts.probeEra ?? defaultProbeEra)(w.bridgeUrl)
      .then((era) => { w.era = era; w.eraUnknown = false; })
      // Unreachable: the era is unknown, not end of retail (ENTER stays in this page's era).
      .catch(() => { w.era = null; w.eraUnknown = true; });
    this.eraProbes.push(probe);
  }

  /** Focus the first empty field (after the screen is in the document). */
  focusFirstField(): void {
    if (this.accountInput && !this.accountInput.value) this.accountInput.focus();
    else this.passwordInput?.focus();
  }
}
