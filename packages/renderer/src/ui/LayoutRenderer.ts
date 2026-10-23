/**
 * LayoutRenderer — renders DAT LayoutDesc UI definitions to DOM elements.
 *
 * Given a LayoutDesc ID (0x21xxxxxx from client_local_English.dat), parses
 * the layout and creates a positioned DOM element tree with DAT texture
 * backgrounds. This is the foundation for pixel-perfect AC UI.
 */
import { wheelScrollPixels } from './wheelScroll.js';
import { DatDatabase, DatReader } from '@ac/dat-parser';
import { datMissEpoch, noDatMissSince, onDatMissResolved } from '@ac/dat-parser/streaming/DatMiss.js';
import {
  parseLayoutDesc, resolveLayoutDesc, applyAttachTimeAnchors, MediaType, IncorporationFlags, getString,
  parseStringTable, registerStringTable,
} from '@ac/dat-parser/file-types/LayoutDesc.js';
import type {
  LayoutDescData, ElementDesc, StateDesc, MediaDesc, BaseProperty,
} from '@ac/dat-parser/file-types/LayoutDesc.js';
import type { UITextureLoader } from './UITextureLoader.js';
import { ACFontRenderer } from './ACFontRenderer.js';
import { OUTLINE_NEIGHBOUR_OFFSETS } from './ACFontRenderer.js';
import { outlineColorFromProps, type OutlineDescLike } from './TextOutline.js';
import { textColorFromProps, textStyleFromDesc, cssFromArgb, DEFAULT_TEXT_FONT_DID } from './DatTextStyle.js';
import { truncateTextToFit, truncationSpec } from './TextTruncation.js';
import { calcJustification } from './UIElementTextLayout.js';
import { ZLayer, zLayer } from './ZIndexRegistry.js';
import { applyRetailPaintOrder, applyOwnedObjectLayers } from './LayoutPaintOrder.js';
import { cursorCSS, setElementCursor } from './GlobalCursor.js';
export { retailPaintOrder, applyRetailPaintOrder } from './LayoutPaintOrder.js';

/**
 * Well-known AC UI state IDs — EnumMapper 0x2200002F (the base of
 * 0x2200001C): 0x1 normal, 0x2 normal_rollover, 0x3 normal_pressed, 0x6
 * highlight, 0x7 highlight_rollover, 0x8 highlight_pressed, 0xb closed,
 * 0xc open, 0xd ghosted. `UIElement_Button::UpdateState_ @ 00471cf0` enters
 * base+3 while the mouse is down over the button and base+2 for the
 * rollover (base = 5 when the button is lit through attribute 0xe), 0xd
 * when ghosted. CORE.17.k.b.b.b: Hover / Pressed used to be swapped here
 * (0x3 / 0x2), so a rollover drew the pressed art and vice versa.
 */
export const UIState = {
  Normal:   0x1,
  Hover:    0x2,
  Pressed:  0x3,
  Selected: 0x6,
  Closed:   0xb,
  Open:     0xc,
  Disabled: 0xd,
} as const;

/** Callback for element click events. */
export type LayoutClickHandler = (elementId: number, element: HTMLElement) => void;

/**
 * CORE.17.k.b.b.c — `Font::Get` for a text element's p26 font DID: the
 * parsed font with its foreground + background sheets (GameUI.loadFontRenderer
 * caches one renderer per DID). `null` when the DID does not load — the label
 * then falls back to the UI font the renderer was built with.
 */
export type FontResolver = (fontDid: number) => ACFontRenderer | null;

/** A label as last painted: its text, the caller's colour, and the desc + state it drew in. */
interface LabelPaint {
  text: string;
  color?: string;
  desc?: OutlineDescLike | null;
  stateId?: number;
}

/**
 * CORE.17.k.b.b.b — the state a freshly rendered element rests in: its
 * defaultState when the desc defines it, else `normal` (0x1) when defined,
 * else 0 (the element's own media + properties only). This is the state
 * the initial render draws (renderElement applies the element media, then
 * that state's) and the one a rollover / press returns to.
 */
export function restingStateOf(desc: { defaultState?: number; states?: ReadonlyMap<number, unknown> }): number {
  if (!desc.states) return 0;
  if (desc.defaultState && desc.states.has(desc.defaultState)) return desc.defaultState;
  if (desc.states.has(UIState.Normal)) return UIState.Normal;
  return 0;
}

/**
 * The text properties a label draws with in `stateId`: the element's own
 * properties, then that state's (`UIElement::SetState` applies desc +
 * state; a state the desc does not define contributes nothing).
 */
function statePropsOf(desc: OutlineDescLike | null | undefined, stateId: number | undefined): ReadonlyMap<number, BaseProperty> | undefined {
  if (!desc || !stateId || !desc.states) return undefined;
  return desc.states.get(stateId)?.properties;
}

/**
 * VISUAL.combat-power-label-position — the justification/margin properties a
 * label lays out with: the element desc's, overlaid by the state it is in.
 * UIElement::SetState applies the state desc's attributes through
 * OnSetAttribute like the element's own, so a state's p20 (0x14 →
 * SetHorizontalJustification) wins while the element is in it — the combat
 * bar's 0x21000007:0x10000052 is right-justified (p20=3) only in the panel
 * states 0x10000003 melee / 0x10000004 missile that
 * gmCombatUI::RecvNotice_SetCombatMode @ 004cc620 puts it in.
 */
export function textLayoutPropsOf(
  props: ReadonlyMap<number, BaseProperty> | undefined,
  stateProps: ReadonlyMap<number, BaseProperty> | undefined,
): Map<number, BaseProperty> | undefined {
  if (!stateProps || stateProps.size === 0) return props as Map<number, BaseProperty> | undefined;
  const merged = new Map<number, BaseProperty>(props ?? []);
  for (const id of [20, 21, 35, 36, 37, 38]) {
    const p = stateProps.get(id);
    if (p) merged.set(id, p);
  }
  return merged;
}

/** Handle returned by render() for interacting with a rendered layout. */
export interface LayoutHandle {
  /** Root DOM element containing the rendered layout. */
  root: HTMLElement;
  /** The parsed LayoutDesc data. */
  layout: LayoutDescData;
  /** Map of elementId → DOM element for direct access. */
  elements: Map<number, HTMLElement>;
  /** Map of elementId → resolved ElementDesc (geometry, edges, props). */
  descs: Map<number, ElementDesc>;
  /**
   * CORE.3.d — resize a subtree render (render() with subtreeElementId) to a
   * new root size, reflowing every child per its DAT edge anchors
   * (UIElement::UpdateForParentSizeChange @ 00462640: leftEdge/topEdge
   * 1=fixed 2=follows far edge 3=centered; rightEdge/bottomEdge 1=follows
   * far edge 3=centered, else fixed span from the near edge). Present only
   * on subtree renders.
   */
  resizeSubtree?(width: number, height: number): void;
  /**
   * UIElement::SetSize on one rendered element (`elementId`'s DOM node): its
   * box takes the new size and its children reflow per their DAT edge anchors
   * from the authored size, as resizeSubtree does for the root (a 3-slice
   * button's middle stretches, its right cap follows the far edge).
   */
  resizeElement?(elementId: number, width: number, height: number): void;
  /** Set the text content of an element (rendered via AC bitmap font or fallback). */
  setText(elementId: number, text: string, color?: string): void;
  /** Set the fill fraction (0-1) of a meter/bar element. */
  setFill(elementId: number, fraction: number): void;
  /** Show or hide an element. */
  setVisible(elementId: number, visible: boolean): void;
  /**
   * Switch an element to a specific state — `UIElement::SetState @
   * 00464e70`: the state's media replace the element's (MediaMachine::Reset)
   * and its text properties (p27 colour, p33/p34 outline) are re-applied to
   * the label (OnSetAttribute over the old/new property diff); a state the
   * desc does not define is state 0 (the element's own properties + media).
   */
  setState(elementId: number, stateId: number, paletteId?: number): void;
  /** The state an element is in: the last setState / rollover / press, else its resting (default) state. */
  getState?(elementId: number): number | undefined;
  /** Set a per-element palette override. Future state changes will use this palette. */
  setPalette(elementId: number, paletteId: number | undefined): void;
  /** Make an element interactive (hover/pressed texture swapping + click). */
  setInteractive(elementId: number, handler?: LayoutClickHandler): void;
  /** Make an element a scrollable region with DAT-textured scrollbar. */
  setScrollable(elementId: number, options?: ScrollableOptions): ScrollHandle;
  /** Make an element draggable. */
  setDraggable(elementId: number, options?: DragOptions): void;
  /** Register an element as a drop target. */
  setDropTarget(elementId: number, handler: DropHandler): void;
  /** Destroy the rendered layout and remove from DOM. */
  destroy(): void;
  /** Register a click handler for an element. */
  onClick(elementId: number, handler: LayoutClickHandler): void;
}

/** Handle for a panel window (extends LayoutHandle with window management). */
export interface PanelHandle extends LayoutHandle {
  /** Move the panel to a position (relative to parent). */
  moveTo(x: number, y: number): void;
  /** Close and destroy the panel. */
  close(): void;
  /** Bring this panel to the front of other panels. */
  bringToFront(): void;
}

/** Options for panel rendering. */
export interface PanelOptions {
  /** Initial X position (default: 0). */
  x?: number;
  /** Initial Y position (default: 0). */
  y?: number;
  /** Scale factor (default: 1). */
  scale?: number;
  /**
   * Element ID(s) to use as the drag handle. Usually the title bar; layouts
   * with no title bar (e.g. the social container 0x21000031, whose tab strip
   * is the top edge) can pass several elements. If omitted, panel isn't
   * draggable.
   */
  dragHandleId?: number | number[];
  /**
   * Pixels of pointer travel before a drag engages (default 0 = immediate).
   * When > 0, the click that follows an engaged drag is suppressed, so
   * clickable elements (tabs, buttons) can double as drag handles without
   * losing their click behavior.
   */
  dragThreshold?: number;
  /** Element ID for the close button. If omitted, panel can't be closed. */
  closeButtonId?: number;
  /** Callback when panel is closed via close button. */
  onClose?: () => void;
  /**
   * FAITHFUL.477 — opt-in panel-position persistence. When set, the
   * panel's `{left, top}` is read from localStorage on render
   * (overriding `x`/`y` defaults) and re-written on every drag-end.
   * Keys are namespaced under `ac_panel_pos_v1` to avoid colliding
   * with other persisted state. Closes the panel-position
   * persistence gap explicitly noted in the session-opening audit.
   */
  persistKey?: string;
  /**
   * CORE.5.c — render only this element's subtree (same as render()'s
   * subtreeElementId): the panel window element is rebased to (0,0), the
   * container is sized to it, and the handle gains resizeSubtree so dock
   * panels can REFLOW to the dock slot per their DAT edge flags instead
   * of uniform-downscaling.
   */
  subtreeElementId?: number;
  /**
   * CORE.17.k.b.b.c.c.a.a — keep the panel at its authored `x` in a HUD
   * wider than the 800 px base instead of the right-edge re-anchor a panel
   * whose right edge meets the base's would otherwise get (the default
   * serves the right-dock column). For a full-width bar authored at (0,0)
   * with no edge flags (gmSlumlordUI's 0x2100000e) the left edge is the
   * anchor.
   */
  anchorLeft?: boolean;
  /**
   * Element IDs whose DAT p23 text should NOT be auto-rendered — same as
   * render()'s skipAutoTextIds. Needed since base-inheritance resolution:
   * elements whose label lives in an inherited base desc (e.g. paperdoll
   * "Slots" 0x100005be / backpack "Burden" 0x100001d7) now auto-render it,
   * doubling any identical label the caller overlays.
   */
  skipAutoTextIds?: number[];
}

// v2: HUD switched from non-uniform scale(sx,sy) to a UNIFORM scale + edge
// anchoring, so panel positions saved as left/top under the old 800-base no longer
// map to the same screen spot. Bumping the key drops stale saves once; panels then
// start at the new right-docked defaults and re-persist in the new scaled space.
const PANEL_POSITIONS_KEY_BASE = 'ac_panel_pos_v2';

// BUG.panel-positions-not-per-character — retail persisted panel/window
// layout per-character; a bare global key let dragging a panel for one
// character immediately relocate the SAME panel for another character on
// the same account/browser. `panelPositionsScope` is set via
// `LayoutRenderer.setPanelPositionsScope()` at enter-world (mirroring
// GameUI's ChatHistoryState.keyFor scoping fix), so every read/write below
// is namespaced under the active account+character once known.
let panelPositionsScope = '';

function panelPositionsKey(): string {
  return panelPositionsScope ? `${PANEL_POSITIONS_KEY_BASE}:${panelPositionsScope}` : PANEL_POSITIONS_KEY_BASE;
}

function loadPanelPositions(): Record<string, { left: number; top: number }> {
  try {
    const raw = localStorage.getItem(panelPositionsKey());
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch { /* fall through */ }
  return {};
}

function savePanelPosition(key: string, left: number, top: number): void {
  try {
    const positions = loadPanelPositions();
    positions[key] = { left, top };
    localStorage.setItem(panelPositionsKey(), JSON.stringify(positions));
  } catch { /* quota / disabled — drop silently */ }
}

/** Options for scroll regions. */
export interface ScrollableOptions {
  /** Element ID for the scrollbar track (applies that element's DAT textures). */
  trackElementId?: number;
  /** Element ID for the scrollbar thumb (applies that element's DAT textures). */
  thumbElementId?: number;
  /** DAT texture ID (0x06xxxxxx) for the scrollbar track background. */
  trackTextureId?: number;
  /** DAT texture ID (0x06xxxxxx) for the scrollbar thumb. */
  thumbTextureId?: number;
  /** Element ID for scroll-up button. */
  upButtonId?: number;
  /** Element ID for scroll-down button. */
  downButtonId?: number;
  /** Scroll step in pixels for button/wheel (default: 20). */
  scrollStep?: number;
}

/** Handle for interacting with a scroll region. */
export interface ScrollHandle {
  /** The scrollable content wrapper element. */
  contentEl: HTMLElement;
  /** Set scroll position (0 = top, 1 = bottom). */
  setPosition(fraction: number): void;
  /** Scroll to bottom (useful for chat). */
  scrollToBottom(): void;
  /** Append content to the scroll region. */
  appendContent(el: HTMLElement): void;
}

/** Callback for drop events. */
export type DropHandler = (sourceElementId: number, targetElementId: number, sourceData?: any) => void;

/** Options for draggable elements. */
export interface DragOptions {
  /** Custom data attached to the drag (e.g., item ID, spell ID). */
  data?: any;
  /** Custom ghost element creator. If omitted, clones the element. */
  createGhost?: (el: HTMLElement) => HTMLElement;
  /** Called when drag starts. */
  onDragStart?: (elementId: number) => void;
  /** Called when drag ends (whether dropped or cancelled). */
  onDragEnd?: (elementId: number, dropped: boolean) => void;
}

/** Shared drag state — only one drag active at a time. */
let activeDrag: {
  sourceElementId: number;
  sourceData: any;
  ghost: HTMLElement;
  offsetX: number;
  offsetY: number;
  onEnd?: (dropped: boolean) => void;
} | null = null;

/** All registered drop targets across all layouts. */
const dropTargets = new Map<HTMLElement, { elementId: number; handler: DropHandler }>();

// Global mouse handlers for drag (registered once)
let dragHandlersRegistered = false;
function registerDragHandlers() {
  if (dragHandlersRegistered) return;
  dragHandlersRegistered = true;

  document.addEventListener('mousemove', (e) => {
    if (!activeDrag) return;
    activeDrag.ghost.style.left = `${e.clientX - activeDrag.offsetX}px`;
    activeDrag.ghost.style.top = `${e.clientY - activeDrag.offsetY}px`;
  });

  document.addEventListener('mouseup', (e) => {
    if (!activeDrag) return;
    const drag = activeDrag;
    activeDrag = null;
    drag.ghost.remove();

    // Check if we're over a drop target
    let dropped = false;
    const elementsUnder = document.elementsFromPoint(e.clientX, e.clientY);
    for (const el of elementsUnder) {
      const target = dropTargets.get(el as HTMLElement);
      if (target) {
        target.handler(drag.sourceElementId, target.elementId, drag.sourceData);
        dropped = true;
        break;
      }
    }

    // Remove highlight from all drop targets
    for (const [el] of dropTargets) {
      el.style.opacity = '';
    }

    drag.onEnd?.(dropped);
  });
}

export class LayoutRenderer {
  private languageDb: DatDatabase;
  private uiTextureLoader: UITextureLoader;
  private fontRenderer: ACFontRenderer | null;
  /** CORE.17.k.b.b.c — Font::Get for the descs' p26 fonts (null: every label draws with `fontRenderer`). */
  private fontResolver: FontResolver | null = null;
  /**
   * CORE.17.k.b.b.b — the text + caller colour last rendered into an element
   * (restyleLabel redraws it per state), with the desc and state it drew in
   * (repaintAllLabels redraws it as it was).
   */
  private labelTexts = new WeakMap<HTMLElement, LabelPaint>();
  /** BUG.hud-text-blank-font-sheet — every element a label was painted into (weakly held), for repaintAllLabels. */
  private labelElements = new Set<WeakRef<HTMLElement>>();
  private labelElementsPruneAt = 256;
  /** Font renderers whose heal (ACFontRenderer.onHeal) repaints this renderer's labels. */
  private healWatched = new WeakSet<ACFontRenderer>();
  /** A label fell back while its font was rebuilding: the timer that retries the rebuild. */
  private healRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private healRetryDelayMs = 0;
  private layoutCache = new Map<number, LayoutDescData>();
  private resolvedLayoutCache = new Map<number, LayoutDescData>();
  /**
   * Streamed DATs: elements whose media drew while a texture (or its
   * palette) was not resident yet, with every media apply since, in order.
   * Replayed when the files land (replayMissedMedia), so the art fills in
   * without re-rendering the panel; a later apply that draws cleanly ends it.
   */
  private readonly pendingMedia = new Map<HTMLElement, Array<() => boolean>>();
  private unsubscribeMediaArrival: (() => void) | null = null;
  /** Streamed DATs: labels painted while their font (or its glyph sheets) was not resident yet → their repaint. */
  private readonly pendingLabels = new Map<HTMLElement, () => void>();
  private panelZCounter = ZLayer.PANEL_BASE;

  // FAITHFUL.484 — global LockUI state (CharacterOption 0x33). Static
  // so the drag handler can check it without needing a per-instance
  // reference (panels are created during renderPanel and the lock
  // state can change later via Options-panel toggle). Callers set it
  // via `LayoutRenderer.setUILocked()` from GameUI's
  // onCharacterOptionToggle handler.
  private static uiLocked = false;
  static isUILocked(): boolean { return LayoutRenderer.uiLocked; }
  static setUILocked(locked: boolean): void { LayoutRenderer.uiLocked = locked; }

  // BUG.panel-positions-not-per-character — re-scope persisted panel
  // positions to this account+character so a character switch mid-session
  // (no page reload) doesn't show another character's saved panel layout.
  // Call at enter-world, before any panel is rendered for the new
  // character. Panels re-read `loadPanelPositions()` fresh on every
  // renderPanel() call, so this takes effect on the next panel opened.
  static setPanelPositionsScope(accountName: string, characterName: string): void {
    panelPositionsScope = `${accountName}:${characterName}`;
  }

  constructor(languageDb: DatDatabase, uiTextureLoader: UITextureLoader, fontRenderer?: ACFontRenderer | null) {
    this.languageDb = languageDb;
    this.uiTextureLoader = uiTextureLoader;
    this.fontRenderer = fontRenderer ?? null;
    this.watchHeal(this.fontRenderer);
  }

  private loadedStringTables = new Set<number>();

  /**
   * Register a client_local string table (0x23xxxxxx) the boot did not load
   * (main.ts registers only the UI tables), e.g. the credits tables
   * 0x23000008 / 0x23000009 gmCreditsUI reads. Idempotent; false when the
   * table is missing.
   */
  loadStringTable(tableId: number): boolean {
    if (this.loadedStringTables.has(tableId)) return true;
    const data = this.languageDb.getFileData(tableId);
    if (!data) return false;
    registerStringTable(parseStringTable(new DatReader(data)));
    this.loadedStringTables.add(tableId);
    return true;
  }

  /**
   * Set or replace the UI font (0x40000000) renderer. GameUI hands over its
   * own (loadUiFontAsset), so the HUD and chat share one instance and its
   * streamed-miss reload; labels already painted are redrawn with it.
   */
  setFontRenderer(fontRenderer: ACFontRenderer | null): void {
    this.fontRenderer = fontRenderer;
    this.watchHeal(fontRenderer);
    this.repaintAllLabels();
  }

  /** The UI font renderer labels draw with (null before GameUI hands it over). */
  get uiFontRenderer(): ACFontRenderer | null { return this.fontRenderer; }

  /** Repaint every label when `renderer` heals (a blank or lost glyph sheet rebuilt). Once per renderer. */
  private watchHeal(renderer: ACFontRenderer | null): void {
    if (!renderer || this.healWatched.has(renderer) || typeof renderer.onHeal !== 'function') return;
    this.healWatched.add(renderer);
    renderer.onHeal(() => this.repaintAllLabels());
  }

  /**
   * BUG.hud-text-blank-font-sheet — redraw every connected label from its stored
   * text, colour, desc and state. Labels are otherwise painted only when their
   * text or state changes, so a label that took the fallback while the font
   * was missing or rebuilding kept it for the session. Returns the count.
   */
  repaintAllLabels(): number {
    let n = 0;
    for (const ref of [...this.labelElements]) {
      const el = ref.deref();
      if (!el) { this.labelElements.delete(ref); continue; }
      const label = this.labelTexts.get(el);
      // Destroyed panels are skipped (as replayMissedMedia does).
      if (!label || !el.isConnected) continue;
      this.paintText(el, label.text, label.color, label.desc, label.stateId);
      n++;
    }
    return n;
  }

  /** A label fell back while `renderer` rebuilds a blank sheet: try the rebuild again soon (its heal repaints). */
  private scheduleHealRetry(renderer: ACFontRenderer): void {
    if (this.healRetryTimer !== null || typeof setTimeout !== 'function') return;
    this.healRetryDelayMs = Math.min(30_000, Math.max(ACFontRenderer.rebuildIntervalMs + 50, this.healRetryDelayMs * 2));
    this.healRetryTimer = setTimeout(() => {
      this.healRetryTimer = null;
      if (renderer.isReady && !renderer.needsRebuild) { this.healRetryDelayMs = 0; return; }
      if (renderer.needsRebuild) this.scheduleHealRetry(renderer);
    }, this.healRetryDelayMs);
  }

  /**
   * CORE.17.k.b.b.c — install the resolver a label's p26 font DID goes
   * through (`UIElement_Text::OnSetAttribute @ 0046a640` case 0x1a →
   * `SetFontDID` → `Font::Get`). Labels rendered before this is set drew with
   * the UI font; they are redrawn from their descs the next time their text
   * or state changes.
   */
  setFontResolver(resolver: FontResolver | null): void {
    this.fontResolver = resolver;
  }

  /**
   * The renderer a label draws with: the UI font renderer for 0x40000000 (the
   * one GameUI built and handed over, background sheet included), else the resolved p26 font
   * — falling back to the UI font when the DID does not load or no resolver
   * is installed (retail's `SetFontDID` on a null font keeps the old one).
   */
  private rendererForFont(fontDid: number): ACFontRenderer | null {
    if (fontDid === DEFAULT_TEXT_FONT_DID || !this.fontResolver) return this.fontRenderer;
    const resolved = this.fontResolver(fontDid);
    this.watchHeal(resolved);
    return resolved?.isReady ? resolved : this.fontRenderer;
  }

  /**
   * Parse a LayoutDesc from the language DAT.
   * Results are cached for reuse.
   */
  getLayout(layoutId: number): LayoutDescData | null {
    const cached = this.layoutCache.get(layoutId);
    if (cached) return cached;

    const fileData = this.languageDb.getFileData(layoutId);
    if (!fileData) {
      console.warn(`[LayoutRenderer] Layout 0x${layoutId.toString(16).padStart(8, '0')} not found in language DAT`);
      return null;
    }

    const reader = new DatReader(fileData);
    const layout = parseLayoutDesc(reader);
    this.layoutCache.set(layoutId, layout);
    return layout;
  }

  /**
   * Parse a LayoutDesc and resolve every element's base-inheritance chain
   * (retail LayoutDesc::InqFullDesc / ElementDesc::Incorporate — see
   * resolveLayoutDesc in @ac/dat-parser). Elements with type==0 derive
   * their states/media/properties from a base element, usually in the
   * shared template layout 0x21000040 — e.g. the classic_chat numbered
   * window buttons 0x10000522-525 inherit their gold box art (state 1 →
   * texture 0x06006218) from template 0x10000526. Rendering the raw
   * unresolved descs drops all inherited chrome.
   */
  getResolvedLayout(layoutId: number): LayoutDescData | null {
    const cached = this.resolvedLayoutCache.get(layoutId);
    if (cached) return cached;
    const raw = this.getLayout(layoutId);
    if (!raw) return null;
    const epoch = datMissEpoch();
    const resolved = resolveLayoutDesc(raw, (id) => this.getLayout(id));
    // LAYOUT.attach-time-center-anchors — retail's SetParent applies each
    // element's edge anchors as it attaches (centred L3/T3 elements leave
    // their authored placeholder x/y), so every render and desc reader sees
    // the attached rects.
    applyAttachTimeAnchors(resolved);
    // RELEASE.streaming-regression-gate — a base layout that missed resolves partial: not cached.
    if (noDatMissSince(epoch)) this.resolvedLayoutCache.set(layoutId, resolved);
    return resolved;
  }

  /**
   * Get a DAT texture as a data URL with its alpha channel scaled by
   * `alphaMultiplier` (0..1). See UITextureLoader.getTextureDataURLWithAlpha.
   */
  getTextureDataURLWithAlpha(textureId: number, alphaMultiplier: number, paletteId?: number): string | null {
    return this.uiTextureLoader.getTextureDataURLWithAlpha(textureId, alphaMultiplier, paletteId);
  }

  /**
   * Render a LayoutDesc into DOM elements and append to parent.
   *
   * @param layoutId - LayoutDesc file ID (0x21xxxxxx)
   * @param parent - DOM element to append the rendered layout to
   * @param options - Optional rendering configuration
   * @returns A LayoutHandle for interacting with the rendered layout, or null if layout not found
   */
  render(
    layoutId: number,
    parent: HTMLElement,
    options: {
      /** Override width (defaults to layout's displayWidth) */
      width?: number;
      /** Override height (defaults to layout's displayHeight) */
      height?: number;
      /** Scale factor (e.g., to fit current viewport vs. 800x600 design) */
      scale?: number;
      /**
       * Element IDs whose DAT p23 (StringInfo) text should NOT be auto-rendered.
       * Use when the caller overlays its own interactive labeled widget on top
       * of a layout element — otherwise both the DAT string and the caller's
       * label draw at the same spot and garble (e.g. char-select buttons).
       */
      skipAutoTextIds?: number[];
      /**
       * Element IDs the caller draws itself: it overlays a widget that IS the
       * element and paints its state media (normal / rollover / pressed /
       * ghosted). Their nodes keep their rect but carry no media, so the
       * art is composited once. VISUAL.charselect-enter-disc-tint: the
       * char-select ENTER disc 0x06004cb2 is 42% opaque, and drawing it under
       * the overlay button as well darkened the disc to 26,25,57 where retail
       * (one draw) shows 31,38,75; the plates' soft edges doubled the same way.
       */
      callerDrawnIds?: number[];
      /**
       * CORE.3.c — render only this element's (resolved) subtree instead of
       * the whole layout, with the subtree root repositioned to (0,0) and the
       * container sized to the element. Mirrors the retail client creating a
       * single UIElement from one ElementDesc of a layout (e.g. a
       * FloatyChatWindow instance out of gameplay layout 0x21000005).
       */
      subtreeElementId?: number;
      /**
       * RECON.dialogs-via-layoutrenderer — the subtree root as a path of
       * element ids from a top-level element down (`UIElement::
       * GetChildRecursive` from a known parent). For layouts whose ids repeat
       * under different parents: every DialogFactory dialog in 0x2100003C
       * names its plate 0x3d, so `[0x15, 0x3d]` is the ConfirmationDialog's.
       * Takes precedence over subtreeElementId.
       */
      subtreePath?: readonly number[];
      /**
       * CORE.17.k.b.b.c.c.a.a.c.a — direct children of the subtree root not
       * to instantiate (with subtreeElementId). The EoL transaction dock
       * 0x2100006d:0x100005fb (gmFloatyEnvPanelUI) holds five full panels in
       * stacked slots of which gmEnvPanelUI::RecvNotice_SetPanelVisibility @
       * 004cc760 shows exactly one; a host renders the frame + the one slot
       * it shows instead of five panels' DOM (and their repeated ids).
       */
      omitChildIds?: readonly number[];
      /**
       * CORE.17.k.b.b.c.c.a.a.c.a — further layouts whose elements' OWN p23
       * labels auto-render too. A panel inherited through a slot's base (the
       * transaction dock's slots) keeps the labels its own layout render drew
       * (the vendor's tabs and buttons): the own-text gate below reads only
       * `layoutId`'s raw descs.
       */
      autoTextLayoutIds?: readonly number[];
    } = {},
  ): LayoutHandle | null {
    const layout = this.getResolvedLayout(layoutId);
    if (!layout) return null;

    // Resolve the subtree root up front so width/height defaults can size to it.
    let subtreeRoot: ElementDesc | null = null;
    if (options.subtreePath && options.subtreePath.length > 0) {
      const [head, ...rest] = options.subtreePath;
      let node: ElementDesc | null = [...layout.elements.values()].find((el) => el.elementId === head) ?? null;
      for (const id of rest) {
        node = node ? ([...node.children.values()].find((c) => c.elementId === id) ?? null) : null;
      }
      if (!node) return null;
      subtreeRoot = node;
    } else if (options.subtreeElementId !== undefined) {
      const findById = (el: ElementDesc, id: number): ElementDesc | null => {
        if (el.elementId === id) return el;
        for (const [, child] of el.children) {
          const hit = findById(child, id);
          if (hit) return hit;
        }
        return null;
      };
      for (const [, el] of layout.elements) {
        subtreeRoot = findById(el, options.subtreeElementId);
        if (subtreeRoot) break;
      }
      if (!subtreeRoot) return null;
      if (options.omitChildIds && options.omitChildIds.length > 0) {
        const omit = new Set(options.omitChildIds);
        subtreeRoot = {
          ...subtreeRoot,
          children: new Map([...subtreeRoot.children].filter(([, c]) => !omit.has(c.elementId))),
        };
      }
    }
    const skipAutoText = new Set(options.skipAutoTextIds ?? []);
    // Auto-text stays gated to elements whose OWN (raw, pre-inheritance)
    // desc carries p23: base-inheritance resolution surfaces every
    // inherited label too (options "Apply"/"Reset", char-panel Titles-tab
    // headers, paperdoll "Slots"/"Burden", …), and rendering those
    // unconditionally doubles labels GameUI still overlays itself and
    // bleeds text from tabs whose elements GameUI never had to hide while
    // they were chrome-less. Panels adopt the DAT-native labels
    // deliberately, one task at a time, by dropping their overlays.
    const ownTextIds = new Set<number>();
    const rawLayout = this.getLayout(layoutId);
    if (rawLayout) {
      const collectOwnText = (el: ElementDesc): void => {
        if (el.properties.has(23) || [...el.states.values()].some((s) => s.properties.has(23))) {
          ownTextIds.add(el.elementId);
        }
        for (const [, child] of el.children) collectOwnText(child);
      };
      for (const [, el] of rawLayout.elements) collectOwnText(el);
    }
    for (const extraId of options.autoTextLayoutIds ?? []) {
      const extra = this.getLayout(extraId);
      if (!extra) continue;
      const collect = (el: ElementDesc): void => {
        if (el.properties.has(23) || [...el.states.values()].some((st) => st.properties.has(23))) ownTextIds.add(el.elementId);
        for (const [, child] of el.children) collect(child);
      };
      for (const [, el] of extra.elements) collect(el);
    }
    const autoTextAllowed = (id: number): boolean => !skipAutoText.has(id) && ownTextIds.has(id);

    const scale = options.scale ?? 1;
    const width = options.width ?? (subtreeRoot ? subtreeRoot.width : layout.displayWidth);
    const height = options.height ?? (subtreeRoot ? subtreeRoot.height : layout.displayHeight);

    // Create root container
    const root = document.createElement('div');
    root.dataset.layoutId = `0x${layoutId.toString(16).padStart(8, '0')}`;
    Object.assign(root.style, {
      position: 'relative',
      width: `${width * scale}px`,
      height: `${height * scale}px`,
      overflow: 'hidden',
      pointerEvents: 'none', // Let clicks pass through empty areas
    });

    const elements = new Map<number, HTMLElement>();
    const elementDescs = new Map<number, ElementDesc>();
    const clickHandlers = new Map<number, LayoutClickHandler>();
    const fillElements = new Map<number, HTMLElement>();
    const textElements = new Map<number, HTMLElement>();
    // Each rendered desc node → the DOM node built from it (ids repeat, and
    // DOM order is the retail paint order, not the desc tree's order).
    const domByDesc = new Map<ElementDesc, HTMLElement>();
    const elementPalettes = new Map<number, number>(); // per-element palette overrides
    // CORE.17.k.b.b.b — the state each element is in (UIElement::m_state);
    // absent = its resting state (restingStateOf).
    const elementStates = new Map<number, number>();
    // Capture reference to this so closures can access current fontRenderer and applyMedia
    const self = this;

    /**
     * CORE.17.k.b.b.b — `UIElement::SetState @ 00464e70` for a rendered
     * element: the state's media (the resting state re-applies the element's
     * own media first, the way the initial render did), then the label
     * re-styled with the state's text properties. A state id the desc does
     * not define is retail's state 0: the element's own media + properties.
     */
    const enterState = (elementId: number, el: HTMLElement, desc: ElementDesc, stateId: number, paletteId?: number): void => {
      const pal = paletteId ?? elementPalettes.get(elementId);
      elementStates.set(elementId, applyState(el, desc, stateId, pal));
    };
    /**
     * SetState on one DOM instance (returns the state entered — 0 when the
     * desc does not define `stateId`). When the entered state (or the desc,
     * for state 0) is marked PassToChildren, every child enters the same
     * state id (SetState's loop over the children with vtable +0x9c) — the
     * dialog-button family's plate is three child slices whose own states
     * carry the normal / pressed / ghosted art (0x06004c96 / 95 / 94, …),
     * so a press depresses the plate. Children are resolved on this
     * instance's DOM (template child ids repeat under every button), not
     * through the id-keyed `elements` map.
     */
    const applyState = (el: HTMLElement, desc: ElementDesc, stateId: number, pal: number | undefined): number => {
      const resting = restingStateOf(desc);
      const state = desc.states.get(stateId);
      if (!state) {
        stateId = 0;
        if (desc.media.length > 0) self.applyMediaToElement(el, desc.media, scale, pal);
      } else if (stateId === resting) {
        self.applyMediaToElement(el, desc.media, scale, pal);
        if (state.media.length > 0) self.applyMediaToElement(el, state.media, scale, pal);
      } else if (state.media.length > 0) {
        self.applyMediaToElement(el, state.media, scale, pal);
      }
      // CORE.17.k.b.b.c.a — the state the element is in, readable on the
      // element itself (the tab strips' 0xb / 0xc, the harness + tests).
      el.dataset.acState = stateId.toString(16);
      self.restyleLabel(el, desc, stateId);
      const passToChildren = state ? state.passToChildren : desc.passToChildren;
      if (passToChildren) {
        for (const [, child] of desc.children) {
          const childEl = el.querySelector(`:scope > [data-element-id="0x${child.elementId.toString(16)}"]`) as HTMLElement | null;
          if (childEl) applyState(childEl, child, stateId, pal);
        }
      }
      return stateId;
    };
    const currentStateOf = (elementId: number, desc: ElementDesc): number =>
      elementStates.get(elementId) ?? restingStateOf(desc);

    /**
     * The rollover / press swaps of `UIElement_Button::UpdateState_ @
     * 00471cf0`: normal_rollover (0x2) while the mouse is over, normal_pressed
     * (0x3) while it is down over the button, back to the resting state on
     * release / leave — each through enterState, so a pressed-only p33 (the
     * 0x21000040:0x100002cd dialog-button family) outlines the label while
     * the mouse is down and loses the halo on release.
     */
    const wireStateSwaps = (elementId: number, el: HTMLElement, desc: ElementDesc): void => {
      const hasHover = desc.states.has(UIState.Hover);
      const hasPressed = desc.states.has(UIState.Pressed);
      const revert = (): void => enterState(elementId, el, desc, restingStateOf(desc));
      if (hasHover) {
        el.addEventListener('mouseenter', () => enterState(elementId, el, desc, UIState.Hover));
        el.addEventListener('mouseleave', revert);
      }
      if (hasPressed) {
        el.addEventListener('mousedown', (e) => {
          e.preventDefault();
          enterState(elementId, el, desc, UIState.Pressed);
        });
        // Release over the button → rollover if it has one, else resting.
        el.addEventListener('mouseup', () => {
          if (hasHover) enterState(elementId, el, desc, UIState.Hover);
          else revert();
        });
        // A press dragged off the button (no rollover state to fall to) must
        // not stay pressed — the mouseup lands elsewhere.
        if (!hasHover) el.addEventListener('mouseleave', revert);
      }
    };

    // Recursively render all elements (or just the requested subtree,
    // repositioned to the container origin).
    let renderedRoots: ElementDesc[];
    if (subtreeRoot) {
      const placed = { ...subtreeRoot, x: 0, y: 0 };
      renderedRoots = [placed];
      this.renderElement(
        placed,
        root, elements, elementDescs, fillElements, textElements, scale, autoTextAllowed, domByDesc,
      );
      // CORE.3.d — retail UIElements don't clip children to the parent
      // rect, and the FloatyChatWindow template relies on that: its
      // bottom resize bars sit at y=103..108 of the 104-tall window
      // (overhanging by 4px). With overflow:hidden on the container +
      // subtree root the bars' hit areas were clipped to a 1px sliver and
      // unreachable. Deeper elements keep their own overflow:hidden, so
      // interior clipping (log viewport, entry focus box) is unchanged.
      root.style.overflow = 'visible';
      const subtreeRootEl = elements.get(subtreeRoot.elementId);
      if (subtreeRootEl) subtreeRootEl.style.overflow = 'visible';
    } else {
      // The layout's top-level elements are ordered the same way under the
      // container. Nothing becomes a CSS z-index, so a root's own zLevel
      // (the chat band's 900, the 3D view's 9999) never leaks into the
      // caller's stacking context — where the layout sits among other
      // screens' windows is the host's call (ZIndexRegistry tiers).
      const rendered: Array<{ el: HTMLElement; desc: ElementDesc }> = [];
      for (const [_key, element] of layout.elements) {
        rendered.push({
          el: this.renderElement(element, root, elements, elementDescs, fillElements, textElements, scale, autoTextAllowed, domByDesc),
          desc: element,
        });
      }
      applyRetailPaintOrder(root, rendered);
      renderedRoots = rendered.map((r) => r.desc);
    }
    if (options.callerDrawnIds?.length) {
      const callerDrawn = new Set(options.callerDrawnIds);
      for (const [desc, node] of domByDesc) {
        if (callerDrawn.has(desc.elementId)) node.style.backgroundImage = '';
      }
    }
    // VISUAL.ui-owned-object-layers — attribute-0xcd elements draw over the
    // 2D surface they sit in (RenderUI::LinkObject order), not in their
    // parent's sibling order.
    applyOwnedObjectLayers(root, renderedRoots, domByDesc);

    parent.appendChild(root);

    // CORE.3.d — the edge-anchored reflow of resizeSubtree / resizeElement
    // (UIElement::UpdateForParentSizeChange @ 00462640, described there).
    const reflow = (desc: ElementDesc, parentDW: number, parentDH: number, parentNewW: number, parentNewH: number): void => {
      const parentOrigW = parentNewW - parentDW;
      const parentOrigH = parentNewH - parentDH;
      for (const [, child] of desc.children) {
        const el = domByDesc.get(child);
        const origX1 = child.x + child.width - 1;
        const origY1 = child.y + child.height - 1;
        let x0 = child.x, x1 = origX1, y0 = child.y, y1 = origY1;
        if (child.leftEdge === 2) x0 = child.x + parentDW;
        else if (child.leftEdge === 3) x0 = Math.floor(parentNewW / 2) - Math.floor(child.width / 2);
        else if (child.leftEdge === 4 && parentOrigW > 0) x0 = Math.round(child.x * parentNewW / parentOrigW);
        if (child.rightEdge === 1) x1 = origX1 + parentDW;
        else if (child.rightEdge === 3) x1 = Math.floor(parentNewW / 2) - 1 + Math.floor(child.width / 2);
        else if (child.rightEdge === 4 && parentOrigW > 0) x1 = Math.round((origX1 + 1) * parentNewW / parentOrigW) - 1;
        if (child.topEdge === 2) y0 = child.y + parentDH;
        else if (child.topEdge === 3) y0 = Math.floor(parentNewH / 2) - Math.floor(child.height / 2);
        else if (child.topEdge === 4 && parentOrigH > 0) y0 = Math.round(child.y * parentNewH / parentOrigH);
        if (child.bottomEdge === 1) y1 = origY1 + parentDH;
        else if (child.bottomEdge === 3) y1 = Math.floor(parentNewH / 2) - 1 + Math.floor(child.height / 2);
        else if (child.bottomEdge === 4 && parentOrigH > 0) y1 = Math.round((origY1 + 1) * parentNewH / parentOrigH) - 1;
        const w = x1 - x0 + 1;
        const h = y1 - y0 + 1;
        if (el) {
          el.style.left = `${x0 * scale}px`;
          el.style.top = `${y0 * scale}px`;
          if ((child.incorporationFlags & IncorporationFlags.Width) !== 0) el.style.width = `${w * scale}px`;
          if ((child.incorporationFlags & IncorporationFlags.Height) !== 0) el.style.height = `${h * scale}px`;
        }
        reflow(child, w - child.width, h - child.height, w, h);
      }
    };
    const handle: LayoutHandle = {
      root,
      layout,
      elements,
      descs: elementDescs,

      // CORE.3.d — edge-anchored reflow for subtree renders, matching
      // UIElement::UpdateForParentSizeChange @ 00462640 (decompiled EoL
      // client): every element's new rect is recomputed from its ORIGINAL
      // desc rect plus its parent's current-vs-original size delta, so
      // repeated resizes never accumulate drift.
      //   leftEdge/topEdge: 1 = fixed to near edge, 2 = follows far edge
      //     (x0 += dW), 3 = centered (x0 = newParentW/2 - origW/2); 0/other
      //     = fixed.
      //   rightEdge/bottomEdge: 1 = follows far edge (x1 += dW), 3 =
      //     centered (x1 = newParentW/2 - 1 + origW/2); 0/other = fixed
      //     (span keeps its original far coordinate).
      // Proportional mode 4 (CORE.5.b.c) scales the coordinate with the
      // parent's new-size/original-size ratio (the _ftol2 float path in the
      // decompiled UpdateForParentSizeChange) — the side-by-side vitals
      // cluster's three bars (L4/R4 columns) divide the widened window
      // proportionally. Far edges scale the EXCLUSIVE coordinate (x1+1) so
      // adjacent proportional spans stay gap- and overlap-free.
      resizeSubtree: subtreeRoot ? (newW: number, newH: number) => {
        root.style.width = `${newW * scale}px`;
        root.style.height = `${newH * scale}px`;
        // CORE.5.c — size the window element itself too: retail resizes the
        // window via SetSize and only the CHILDREN reflow through
        // UpdateForParentSizeChange. Without this the subtree root's own
        // media/background keeps its authored height while its children
        // reflow past it (e.g. a dock panel grown to the slot).
        const rootEl = elements.get(subtreeRoot.elementId);
        if (rootEl) {
          rootEl.style.width = `${newW * scale}px`;
          rootEl.style.height = `${newH * scale}px`;
        }
        // CORE.5.b.c — element IDs repeat inside a subtree (the vitals
        // cluster's three bars share cap/fill/ornament child ids), and the
        // id-keyed `elements` map only holds the LAST rendered instance.
        // Each desc node maps to the DOM node rendered from it (domByDesc).
        // Not document order: siblings are re-appended in retail paint
        // order (applyRetailPaintOrder), so the nth DOM hit of an id is no
        // longer the nth desc visit — pairing that way swapped the social
        // panes' dividers / button slices onto each other's rects.
        reflow(subtreeRoot, newW - subtreeRoot.width, newH - subtreeRoot.height, newW, newH);
      } : undefined,
      resizeElement(elementId: number, newW: number, newH: number) {
        const desc = elementDescs.get(elementId);
        const el = elements.get(elementId);
        if (!desc || !el) return;
        el.style.width = `${newW * scale}px`;
        el.style.height = `${newH * scale}px`;
        reflow(desc, newW - desc.width, newH - desc.height, newW, newH);
      },

      setText(elementId: number, text: string, color?: string) {
        const el = textElements.get(elementId) ?? elements.get(elementId);
        if (!el) return;
        // Delegate to the shared rendering helper so manual setText and
        // auto-resolved p23 text take the same code path. The resolved desc
        // supplies retail justification/margins (p20/p21/p35-38) so a
        // setText onto e.g. a 0x21000044 radio row lands left-justified
        // past its gem exactly like retail (CORE.5.c.c). The element's
        // current state supplies its text properties (CORE.17.k.b.b.b).
        const desc = elementDescs.get(elementId);
        self['renderTextInto'](el, text, color, desc, desc ? currentStateOf(elementId, desc) : undefined);
      },

      setFill(elementId: number, fraction: number) {
        const el = fillElements.get(elementId) ?? elements.get(elementId);
        if (el) {
          const pct = Math.max(0, Math.min(1, fraction)) * 100;
          el.style.width = `${pct}%`;
        }
      },

      setVisible(elementId: number, visible: boolean) {
        const el = elements.get(elementId);
        if (el) {
          el.style.display = visible ? '' : 'none';
        }
      },

      setState(elementId: number, stateId: number, paletteId?: number) {
        const el = elements.get(elementId);
        const desc = elementDescs.get(elementId);
        if (!el || !desc) return;
        enterState(elementId, el, desc, stateId, paletteId);
      },

      getState(elementId: number) {
        const desc = elementDescs.get(elementId);
        return desc ? currentStateOf(elementId, desc) : undefined;
      },

      setPalette(elementId: number, paletteId: number | undefined) {
        if (paletteId === undefined) {
          elementPalettes.delete(elementId);
        } else {
          elementPalettes.set(elementId, paletteId);
        }
      },

      setInteractive(elementId: number, handler?: LayoutClickHandler) {
        const el = elements.get(elementId);
        const desc = elementDescs.get(elementId);
        if (!el || !desc) return;

        el.style.pointerEvents = 'auto';
        el.style.cursor = 'pointer';
        wireStateSwaps(elementId, el, desc);

        if (handler) {
          clickHandlers.set(elementId, handler);
          el.addEventListener('click', () => handler(elementId, el));
        }
      },

      setScrollable(elementId: number, options: ScrollableOptions = {}): ScrollHandle {
        const el = elements.get(elementId);
        if (!el) {
          // Return a no-op handle
          const dummy = document.createElement('div');
          return { contentEl: dummy, setPosition() {}, scrollToBottom() {}, appendContent() {} };
        }

        const scrollStep = options.scrollStep ?? 20;

        // Create inner content wrapper that scrolls
        const contentEl = document.createElement('div');
        contentEl.className = 'layout-scroll-content';
        Object.assign(contentEl.style, {
          position: 'absolute',
          left: '0', top: '0',
          width: '100%', height: '100%',
          overflowY: 'scroll',
          overflowX: 'hidden',
          pointerEvents: 'auto',
          // Hide native scrollbar — we render our own from DAT
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
        });

        // Move existing children into content wrapper
        while (el.firstChild) {
          contentEl.appendChild(el.firstChild);
        }
        el.appendChild(contentEl);

        // Hide WebKit scrollbar
        const styleId = 'layout-scroll-style';
        if (!document.getElementById(styleId)) {
          const style = document.createElement('style');
          style.id = styleId;
          style.textContent = '.layout-scroll-content::-webkit-scrollbar { display: none; }';
          document.head.appendChild(style);
        }

        // Create scrollbar track — DAT textures applied via trackElementId option
        const trackEl = document.createElement('div');
        trackEl.className = 'layout-scrollbar-track';
        Object.assign(trackEl.style, {
          position: 'absolute',
          right: '0', top: '0',
          width: '12px', height: '100%',
          pointerEvents: 'auto',
          zIndex: '10',
        });

        // Scrollbar thumb — DAT textures applied via thumbElementId option
        const thumbEl = document.createElement('div');
        thumbEl.className = 'layout-scrollbar-thumb';
        Object.assign(thumbEl.style, {
          position: 'absolute',
          left: '0', top: '0',
          width: '100%', height: '30px',
          cursor: 'pointer',
        });
        trackEl.appendChild(thumbEl);

        // Apply DAT textures to track/thumb from element IDs or direct texture IDs
        if (options.trackElementId) {
          const trackDesc = elementDescs.get(options.trackElementId);
          if (trackDesc) self.applyMediaToElement(trackEl, trackDesc.media, scale);
        } else if (options.trackTextureId) {
          const trackTex = options.trackTextureId;
          self.applyArt(trackEl, () => self.applyStretchedTexture(trackEl, trackTex));
        }
        if (options.thumbElementId) {
          const thumbDesc = elementDescs.get(options.thumbElementId);
          if (thumbDesc) self.applyMediaToElement(thumbEl, thumbDesc.media, scale);
        } else if (options.thumbTextureId) {
          const thumbTex = options.thumbTextureId;
          self.applyArt(thumbEl, () => self.applyStretchedTexture(thumbEl, thumbTex));
        }

        el.appendChild(trackEl);

        // Update thumb position on scroll
        const updateThumb = () => {
          const maxScroll = contentEl.scrollHeight - contentEl.clientHeight;
          if (maxScroll <= 0) {
            thumbEl.style.display = 'none';
            return;
          }
          thumbEl.style.display = '';
          const fraction = contentEl.scrollTop / maxScroll;
          const trackHeight = trackEl.clientHeight;
          const thumbHeight = Math.max(20, (contentEl.clientHeight / contentEl.scrollHeight) * trackHeight);
          thumbEl.style.height = `${thumbHeight}px`;
          thumbEl.style.top = `${fraction * (trackHeight - thumbHeight)}px`;
        };
        contentEl.addEventListener('scroll', updateThumb);

        // Thumb drag
        let dragging = false;
        let dragStartY = 0;
        let dragStartTop = 0;
        // PERF.session-soak-dom-nodes — document listeners only while the thumb is held (see the panel drag).
        const onThumbMove = (e: MouseEvent) => {
          if (!dragging) return;
          const dy = e.clientY - dragStartY;
          const trackHeight = trackEl.clientHeight;
          const thumbHeight = thumbEl.clientHeight;
          const maxTop = trackHeight - thumbHeight;
          const newTop = Math.max(0, Math.min(maxTop, dragStartTop + dy));
          const fraction = maxTop > 0 ? newTop / maxTop : 0;
          contentEl.scrollTop = fraction * (contentEl.scrollHeight - contentEl.clientHeight);
        };
        const onThumbUp = () => {
          dragging = false;
          document.removeEventListener('mousemove', onThumbMove);
          document.removeEventListener('mouseup', onThumbUp);
        };
        thumbEl.addEventListener('mousedown', (e) => {
          dragging = true;
          dragStartY = e.clientY;
          dragStartTop = parseFloat(thumbEl.style.top) || 0;
          document.addEventListener('mousemove', onThumbMove);
          document.addEventListener('mouseup', onThumbUp);
          e.preventDefault();
        });

        // Track click
        trackEl.addEventListener('click', (e) => {
          if (e.target === thumbEl) return;
          const rect = trackEl.getBoundingClientRect();
          const fraction = (e.clientY - rect.top) / rect.height;
          contentEl.scrollTop = fraction * (contentEl.scrollHeight - contentEl.clientHeight);
        });

        // Mouse wheel on the scroll area
        el.addEventListener('wheel', (e) => {
          contentEl.scrollTop += wheelScrollPixels(e, scrollStep, contentEl.clientHeight);
          e.preventDefault();
        }, { passive: false });

        // Wire up/down buttons if provided
        if (options.upButtonId) {
          handle.setInteractive(options.upButtonId, () => {
            contentEl.scrollTop -= scrollStep;
          });
        }
        if (options.downButtonId) {
          handle.setInteractive(options.downButtonId, () => {
            contentEl.scrollTop += scrollStep;
          });
        }

        // Initial thumb update
        requestAnimationFrame(updateThumb);

        return {
          contentEl,
          setPosition(fraction: number) {
            contentEl.scrollTop = fraction * (contentEl.scrollHeight - contentEl.clientHeight);
            updateThumb();
          },
          scrollToBottom() {
            contentEl.scrollTop = contentEl.scrollHeight;
            updateThumb();
          },
          appendContent(child: HTMLElement) {
            contentEl.appendChild(child);
            updateThumb();
          },
        };
      },

      setDraggable(elementId: number, options: DragOptions = {}) {
        const el = elements.get(elementId);
        if (!el) return;

        registerDragHandlers();
        el.style.pointerEvents = 'auto';
        el.style.cursor = 'grab';

        el.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();

          // Create ghost element
          let ghost: HTMLElement;
          if (options.createGhost) {
            ghost = options.createGhost(el);
          } else {
            ghost = el.cloneNode(true) as HTMLElement;
            ghost.style.opacity = '0.7';
          }
          Object.assign(ghost.style, {
            position: 'fixed',
            pointerEvents: 'none',
            zIndex: zLayer(ZLayer.DRAG_GHOST),
          });
          document.body.appendChild(ghost);

          const rect = el.getBoundingClientRect();
          const offsetX = e.clientX - rect.left;
          const offsetY = e.clientY - rect.top;

          ghost.style.left = `${e.clientX - offsetX}px`;
          ghost.style.top = `${e.clientY - offsetY}px`;
          ghost.style.width = `${rect.width}px`;
          ghost.style.height = `${rect.height}px`;

          activeDrag = {
            sourceElementId: elementId,
            sourceData: options.data,
            ghost,
            offsetX,
            offsetY,
            onEnd: (dropped) => {
              options.onDragEnd?.(elementId, dropped);
            },
          };

          // Highlight valid drop targets
          for (const [targetEl] of dropTargets) {
            targetEl.style.opacity = '0.8';
          }

          options.onDragStart?.(elementId);
        });
      },

      setDropTarget(elementId: number, handler: DropHandler) {
        const el = elements.get(elementId);
        if (!el) return;

        registerDragHandlers();
        el.style.pointerEvents = 'auto';
        dropTargets.set(el, { elementId, handler });

        // Subtle opacity feedback on drag hover (no fake CSS — real highlight comes from DAT states)
        el.addEventListener('mouseenter', () => {
          if (activeDrag) el.style.opacity = '0.7';
        });
        el.addEventListener('mouseleave', () => {
          if (activeDrag) el.style.opacity = '';
        });
      },

      destroy() {
        // Clean up drop targets for this layout
        for (const [el] of dropTargets) {
          if (root.contains(el)) {
            dropTargets.delete(el);
          }
        }
        root.remove();
      },

      onClick(elementId: number, handler: LayoutClickHandler) {
        clickHandlers.set(elementId, handler);
        const el = elements.get(elementId);
        const desc = elementDescs.get(elementId);
        if (!el) return;

        el.style.pointerEvents = 'auto';
        el.style.cursor = 'pointer';
        el.addEventListener('click', () => handler(elementId, el));

        // Auto-enable state swapping if element has hover/pressed states
        if (desc) wireStateSwaps(elementId, el, desc);
      },
    };

    return handle;
  }

  /**
   * Render a single ElementDesc into a DOM element.
   */
  /**
   * Render a LayoutDesc as a moveable, closeable panel window.
   * Wraps render() with drag-to-move, close button, and z-ordering.
   */
  renderPanel(
    layoutId: number,
    parent: HTMLElement,
    options: PanelOptions = {},
  ): PanelHandle | null {
    // Create a panel wrapper for positioning
    const panelEl = document.createElement('div');
    panelEl.dataset.panel = `0x${layoutId.toString(16).padStart(8, '0')}`;
    const zIndex = ++this.panelZCounter;
    // FAITHFUL.477 — restore persisted position if persistKey set
    // (overrides options.x/y).
    let initialX = options.x ?? 0;
    let initialY = options.y ?? 0;
    let usedStored = false;
    if (options.persistKey) {
      const stored = loadPanelPositions()[options.persistKey];
      if (stored && typeof stored.left === 'number' && typeof stored.top === 'number') {
        initialX = stored.left;
        initialY = stored.top;
        usedStored = true;
      }
    }
    Object.assign(panelEl.style, {
      position: 'absolute',
      left: `${initialX}px`,
      top: `${initialY}px`,
      zIndex: zIndex.toString(),
      pointerEvents: 'none',
    });

    parent.appendChild(panelEl);

    // Render layout into the panel wrapper
    const handle = this.render(layoutId, panelEl, {
      scale: options.scale,
      skipAutoTextIds: options.skipAutoTextIds,
      subtreeElementId: options.subtreeElementId,
    });
    if (!handle) {
      panelEl.remove();
      return null;
    }

    // Uniform-scale HUD: the right-dock panels' default x (e.g. 500) was authored
    // as a right-edge anchor in the 800-wide HUD base, which used to fill the
    // viewport via a non-uniform scale. The HUD now scales uniformly and the
    // container is wider than 800, so a literal left:500 lands mid-screen. For the
    // DEFAULT (non-dragged) position of a panel that docks at/near the base's right
    // edge, re-derive left from the parent's real width so it pins to the right
    // edge. Stays left-based so drag/persist keep working. (Dragged positions are
    // saved/restored in this same scaled space, so they need no adjustment.)
    if (!usedStored && !options.anchorLeft) {
      // The caller sizes the wrapper (panelEl) AFTER renderPanel returns, so the
      // panel width isn't known yet — defer one frame, then re-dock right-edge
      // panels. Kept left-based so drag/persist keep working.
      requestAnimationFrame(() => {
        if (!panelEl.isConnected) return;
        const HUD_BASE_W = 800;
        const pw = panelEl.offsetWidth;
        const baseRightGap = HUD_BASE_W - initialX - pw;
        // Only re-dock panels whose right edge sits at/near the base's right edge
        // (the right-dock column). A small gap window excludes CENTERED dialogs
        // (whose gap ≈ their side margin, ~200+), which must keep their position.
        if (pw > 0 && baseRightGap > -40 && baseRightGap < 120) {
          const parentW = parent.offsetWidth || HUD_BASE_W;
          panelEl.style.left = `${(parentW - HUD_BASE_W) + initialX}px`;
        }
      });
    }

    // ALWAYS clamp the final position into the viewport — even when a stored position
    // was used (the re-anchor above is skipped then). A stale/off-screen saved left
    // (e.g. a 'character' position left over from a previous HUD scale) otherwise renders
    // the panel off the right edge and makes it permanently unreachable (the toolbar
    // toggle just flips an invisible panel). Runs after the re-anchor frame.
    requestAnimationFrame(() => {
      if (!panelEl.isConnected) return;
      const pw = panelEl.offsetWidth;
      const ph = panelEl.offsetHeight;
      const parentW = parent.offsetWidth || 800;
      const parentH = parent.offsetHeight || 600;
      if (pw > 0) {
        const curLeft = parseInt(panelEl.style.left) || 0;
        const clampedLeft = Math.min(Math.max(curLeft, 0), Math.max(0, parentW - pw));
        if (clampedLeft !== curLeft) panelEl.style.left = `${clampedLeft}px`;
      }
      if (ph > 0) {
        const curTop = parseInt(panelEl.style.top) || 0;
        const clampedTop = Math.min(Math.max(curTop, 0), Math.max(0, parentH - ph));
        if (clampedTop !== curTop) panelEl.style.top = `${clampedTop}px`;
      }
    });

    // Bring to front on any click within the panel
    const bringToFront = () => {
      panelEl.style.zIndex = (++this.panelZCounter).toString();
    };
    panelEl.addEventListener('mousedown', bringToFront);

    // Drag-to-move via title bar element (or several handle elements when
    // the layout has no title bar — e.g. 0x21000031's tab strip).
    const dragIds = options.dragHandleId === undefined
      ? []
      : Array.isArray(options.dragHandleId) ? options.dragHandleId : [options.dragHandleId];
    const dragThreshold = options.dragThreshold ?? 0;
    for (const dragId of dragIds) {
      const dragHandle = handle.elements.get(dragId);
      if (!dragHandle) continue;
      dragHandle.style.pointerEvents = 'auto';
      // Threshold handles are clickable elements in their own right — keep
      // their pointer cursor instead of advertising 'move'.
      if (dragThreshold === 0) dragHandle.style.cursor = 'move';

      let pressed = false;
      let engaged = false;
      let startX = 0, startY = 0;
      let panelStartX = 0, panelStartY = 0;

      dragHandle.addEventListener('mousedown', (e) => {
        // FAITHFUL.484 — Per ACE CharacterOption.LockUI (0x33) /
        // CharacterOptions2.LockUI. When enabled, panels can't be
        // dragged. Read the global `LayoutRenderer.isUILocked()`
        // predicate at mousedown time so the lock takes effect on
        // every drag attempt without re-rendering panels.
        if (LayoutRenderer.isUILocked()) return;
        pressed = true;
        engaged = dragThreshold === 0;
        startX = e.clientX;
        startY = e.clientY;
        panelStartX = parseInt(panelEl.style.left) || 0;
        panelStartY = parseInt(panelEl.style.top) || 0;
        // PERF.session-soak-dom-nodes — the document listeners live only for
        // the press. Attached for the panel's lifetime, they kept every closed
        // panel (and its whole element tree) reachable from `document`: ~140
        // detached nodes per examine window, about 2,000 per hour of play.
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        bringToFront();
        e.preventDefault();
        e.stopPropagation();
      });

      const onMove = (e: MouseEvent) => {
        if (!pressed) return;
        if (!engaged) {
          if (Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) < dragThreshold) return;
          engaged = true;
        }
        // Mouse deltas are screen px but panel coords live in the parent's
        // design space (the HUD is an 800x600 space scaled to the viewport)
        // — divide by the parent's effective scale or panels drag ~2x
        // faster than the pointer.
        const parentRect = parent.getBoundingClientRect();
        const scaleX = parent.offsetWidth > 0 ? parentRect.width / parent.offsetWidth : 1;
        const scaleY = parent.offsetHeight > 0 ? parentRect.height / parent.offsetHeight : 1;
        panelEl.style.left = `${panelStartX + (e.clientX - startX) / (scaleX || 1)}px`;
        panelEl.style.top = `${panelStartY + (e.clientY - startY) / (scaleY || 1)}px`;
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (!pressed) return;
        pressed = false;
        if (!engaged) return;
        // FAITHFUL.477 — persist final position on drag-end.
        if (options.persistKey) {
          const left = parseInt(panelEl.style.left) || 0;
          const top = parseInt(panelEl.style.top) || 0;
          savePanelPosition(options.persistKey, left, top);
        }
        // Keep `engaged` set until after the click that follows mouseup has
        // been dispatched (and suppressed below), then reset.
        setTimeout(() => { engaged = false; }, 0);
      };

      if (dragThreshold > 0) {
        // Capture-phase: runs before the element's own click handlers, so an
        // engaged drag never also fires the tab/button action.
        dragHandle.addEventListener('click', (e) => {
          if (engaged) {
            e.preventDefault();
            e.stopImmediatePropagation();
            engaged = false;
          }
        }, true);
      }
    }

    // Close button
    if (options.closeButtonId) {
      handle.onClick(options.closeButtonId, () => {
        panelHandle.close();
        options.onClose?.();
      });
    }

    const panelHandle: PanelHandle = {
      ...handle,

      moveTo(x: number, y: number) {
        panelEl.style.left = `${x}px`;
        panelEl.style.top = `${y}px`;
      },

      close() {
        handle.destroy();
        panelEl.remove();
      },

      bringToFront() {
        bringToFront();
      },

      destroy() {
        handle.destroy();
        panelEl.remove();
      },
    };

    return panelHandle;
  }

  private renderElement(
    element: ElementDesc,
    parent: HTMLElement,
    elements: Map<number, HTMLElement>,
    elementDescs: Map<number, ElementDesc>,
    fillElements: Map<number, HTMLElement>,
    textElements: Map<number, HTMLElement>,
    scale: number,
    autoTextAllowed: (id: number) => boolean = () => true,
    domByDesc?: Map<ElementDesc, HTMLElement>,
  ): HTMLElement {
    const el = document.createElement('div');
    el.dataset.elementId = `0x${element.elementId.toString(16)}`;
    el.dataset.elementType = element.type.toString();

    // Position and size from IncorporationFlags
    const hasX = (element.incorporationFlags & IncorporationFlags.X) !== 0;
    const hasY = (element.incorporationFlags & IncorporationFlags.Y) !== 0;
    const hasW = (element.incorporationFlags & IncorporationFlags.Width) !== 0;
    const hasH = (element.incorporationFlags & IncorporationFlags.Height) !== 0;

    Object.assign(el.style, {
      position: 'absolute',
      left: hasX ? `${element.x * scale}px` : '0px',
      top: hasY ? `${element.y * scale}px` : '0px',
      width: hasW ? `${element.width * scale}px` : undefined,
      height: hasH ? `${element.height * scale}px` : undefined,
      overflow: 'hidden',
      pointerEvents: 'none',
    });

    // Z-ordering: the DAT zLevel is NOT a CSS z-index — retail's order is
    // the inverse (higher zLevel = further back) and per-parent; the parent
    // puts this element in its retail DOM slot among its siblings once they
    // are all rendered (applyRetailPaintOrder).

    // Retail UIElement_Scrollbar (element class 11) is a RUNTIME widget:
    // it repositions its down-button to the bottom edge, moves the thumb
    // with the scroll fraction, and hides entirely when the content fits
    // (see the decompiled client's UIElement_Scrollbar). A static render
    // of its resolved desc mis-assembles it — the down button sits at its
    // DAT-baked y (e.g. 32 of 68 in classic_chat 0x10000012) and the bar
    // shows even where retail hides it (char-panel attribute list). Until
    // the runtime widget exists (CORE.3.b), INHERITED scrollbar subtrees
    // (baseElement != 0 — chrome-less before inheritance resolution)
    // render hidden; panels that implement scrolling draw their own art
    // and a caller can opt in via handle.setVisible(id, true). Elements
    // that are type 11 in their own raw desc (combat-bar power slider
    // 0x1000004f, baseElement 0) keep rendering as they always did.
    if (element.type === 11 && element.baseElement !== 0) {
      el.style.display = 'none';
    }

    // Apply textures from the element's default state media
    this.applyMediaToElement(el, element.media, scale);

    // Apply textures from the defaultState if it exists in states map
    if (element.defaultState && element.states.has(element.defaultState)) {
      const defaultState = element.states.get(element.defaultState)!;
      this.applyMediaToElement(el, defaultState.media, scale);
    } else if (element.states.has(UIState.Normal)) {
      // If no explicit defaultState, apply Normal state if present
      this.applyMediaToElement(el, element.states.get(UIState.Normal)!.media, scale);
    }

    // Auto-resolve p23 (StringInfo) text property from DAT StringTable.
    // Callers that call handle.setText(id, text) later will overwrite this
    // (setText removes any prior .layout-text child). Placeholder strings
    // like "..." are skipped so panel titles the client fills in at runtime
    // (e.g. inventory "Inventory" / spell-bar "100% Charge") don't get
    // polluted by the placeholder text.
    if (autoTextAllowed(element.elementId)) {
      this.applyTextFromProperty(el, element);
      if (element.defaultState && element.states.has(element.defaultState)) {
        // State descs carry the p23 override but justification lives on the
        // element desc — pass it separately (CORE.5.c.c).
        this.applyTextFromProperty(el, element.states.get(element.defaultState)!, element);
      }
    }

    // Store in the elements and descs maps
    elements.set(element.elementId, el);
    elementDescs.set(element.elementId, element);
    domByDesc?.set(element, el);

    // Render children recursively
    const rendered: Array<{ el: HTMLElement; desc: ElementDesc }> = [];
    for (const [_key, child] of element.children) {
      rendered.push({
        el: this.renderElement(child, el, elements, elementDescs, fillElements, textElements, scale, autoTextAllowed, domByDesc),
        desc: child,
      });
    }
    applyRetailPaintOrder(el, rendered);

    parent.appendChild(el);
    return el;
  }

  /**
   * If `src` carries a p23 (StringInfo) property that resolves to a real
   * DAT string, render that text into `el`. Placeholder strings ("...")
   * and unresolved IDs are skipped. Imperative `handle.setText` calls
   * overwrite this (both paths append to `.layout-text` after removing
   * any prior one, so later wins).
   */
  private applyTextFromProperty(
    el: HTMLElement,
    src: { properties: Map<number, BaseProperty>; defaultState?: number; states?: ReadonlyMap<number, StateDesc> },
    just?: { properties: Map<number, BaseProperty>; defaultState?: number; states?: ReadonlyMap<number, StateDesc> },
  ): void {
    const textProp = src.properties.get(23);
    const stringId = textProp?.valueString?.stringId;
    if (!stringId) return;
    const text = getString(stringId);
    if (!text || text === '...') return;
    const desc = just ?? src;
    this.renderTextInto(el, text, undefined, desc, restingStateOf(desc));
  }

  /**
   * CORE.5.c.c — derive the retail text-layout CSS from an element's
   * resolved justification properties. UIElement_Text::OnSetAttribute in
   * the decompiled client maps p20 (0x14) → SetHorizontalJustification and
   * p21 (0x15) → SetVerticalJustification; CalcJustification @ 00467260
   * treats value 1 as centered, 3/5 as far-edge, anything else as
   * near-edge offset by the margin (p35=left, p36=right, p37=top,
   * p38=bottom — e.g. the 0x21000044 radio-row template is p20=2/p35=16:
   * left-justified 16px in, clearing its 13px toggle gem). When an element
   * carries no explicit p20/p21 we keep this renderer's historical
   * centered default rather than retail's near-edge default, so only
   * DAT-authored justification changes existing panels.
   */
  private textLayoutFromProps(props?: Map<number, BaseProperty>): Record<string, string> {
    const style: Record<string, string> = { alignItems: 'center', justifyContent: 'center' };
    if (!props) return style;
    const enumVal = (id: number): number | undefined => {
      const p = props.get(id);
      const v = (p as { valueInt?: number; valueEnum?: number } | undefined);
      const n = v?.valueInt ?? v?.valueEnum;
      return typeof n === 'number' ? n : undefined;
    };
    const hJust = enumVal(20);
    const vJust = enumVal(21);
    if (hJust !== undefined && hJust !== 1) {
      style.justifyContent = (hJust === 3 || hJust === 5) ? 'flex-end' : 'flex-start';
    }
    if (vJust !== undefined && vJust !== 1) {
      style.alignItems = (vJust === 3 || vJust === 5) ? 'flex-end' : 'flex-start';
    }
    const margL = enumVal(35); const margR = enumVal(36);
    const margU = enumVal(37); const margD = enumVal(38);
    if (margL || margR || margU || margD) {
      style.padding = `${margU ?? 0}px ${margR ?? 0}px ${margD ?? 0}px ${margL ?? 0}px`;
      style.boxSizing = 'border-box';
    }
    return style;
  }

  /**
   * Render a text string into `el` using the AC bitmap font when available,
   * falling back to a browser `<span>` otherwise. Any existing `.layout-text`
   * child is removed first so the latest call wins. Color is optional; if
   * unset the font renderer uses its default. When `desc` is given, its
   * p20/p21/p35-38 justification+margin properties position the text the
   * way retail's UIElement_Text does (see textLayoutFromProps).
   *
   * CORE.17.k.b.b — the desc's p33/p34 pair (resolved through the base
   * chain, element desc + the state it is in — `outlineColorFromProps`) is
   * UIElement_Text's outline (`SetOutline @ 00466630` + `m_curOutlineColor`,
   * black when no p34): the canvas is grown by the renderer's
   * `outlinePadding` and pulled back with negative margins so the glyphs keep
   * their layout position while the halo reaches outside the glyph rects,
   * the way `DrawSelf @ 00467aa0` pass 0 draws it (clipped only by the
   * element's SurfaceWindow). `UIElement_Button::OnSetAttribute @ 00471f40`
   * chains to the text class first, so button labels carry it too.
   *
   * CORE.17.k.b.b.b — `stateId` is the state the element is in (its resting
   * state for a fresh render): the outline comes from desc + that state, and
   * a non-resting state that carries its own p27 recolours the label (the
   * 0x2100003f:0x10000372 button base: white on rollover, 0xff333333
   * pressed; tabs 0xb closed 0xff7f7f7f / 0xc open 0xffcccccc; 0xd ghosted
   * 0xff4c4c4c) — the caller's `color` stands for the resting look until
   * CORE.17.k.b.b.c reads the desc's own p26 / p27. The text and the
   * caller's colour are remembered per element so a later state change
   * (restyleLabel) can redraw the same label.
   */
  private renderTextInto(
    el: HTMLElement,
    text: string,
    color?: string,
    desc?: OutlineDescLike | null,
    stateId?: number,
  ): void {
    if (!this.labelTexts.has(el)) this.trackLabelElement(el);
    this.labelTexts.set(el, { text, color, desc, stateId });
    this.paintText(el, text, color, desc, stateId);
  }

  /** Remember `el` for repaintAllLabels; collected elements are pruned as the set grows. */
  private trackLabelElement(el: HTMLElement): void {
    if (typeof WeakRef !== 'function') return;
    this.labelElements.add(new WeakRef(el));
    if (this.labelElements.size < this.labelElementsPruneAt) return;
    for (const ref of [...this.labelElements]) if (!ref.deref()) this.labelElements.delete(ref);
    this.labelElementsPruneAt = Math.max(256, this.labelElements.size * 2);
  }

  /**
   * Redraw an element's remembered label for `stateId` (enterState). No-op
   * for an element that never had text rendered into it.
   */
  private restyleLabel(el: HTMLElement, desc: OutlineDescLike, stateId: number): void {
    const cached = this.labelTexts.get(el);
    if (!cached) return;
    this.paintText(el, cached.text, cached.color, desc, stateId);
  }

  private paintText(
    el: HTMLElement,
    text: string,
    callerColor: string | undefined,
    desc: OutlineDescLike | null | undefined,
    stateId: number | undefined,
  ): void {
    // A font that read across a streamed miss (a p26 font, its glyph sheets)
    // drew with a fallback: repaint the label — its latest text — on arrival.
    const label = this.labelTexts.get(el);
    if (label) { label.desc = desc; label.stateId = stateId; }
    const missEpoch = datMissEpoch();
    try {
      this.paintTextNow(el, text, callerColor, desc, stateId);
    } finally {
      if (noDatMissSince(missEpoch)) {
        this.pendingLabels.delete(el);
      } else {
        this.pendingLabels.set(el, () => {
          const latest = this.labelTexts.get(el);
          this.paintText(el, latest?.text ?? text, latest ? latest.color : callerColor, desc, stateId);
        });
        this.unsubscribeMediaArrival ??= onDatMissResolved(() => this.replayMissedMedia());
      }
    }
  }

  private paintTextNow(
    el: HTMLElement,
    text: string,
    callerColor: string | undefined,
    desc: OutlineDescLike | null | undefined,
    stateId: number | undefined,
  ): void {
    // The element's own label wrappers are its direct children: every one
    // goes (a label is replaced, never stacked under the next — the 1999 Cast
    // button's face showed its last two texts at once). With none of its own,
    // the first nested one goes, as before (a label a caller set into a parent).
    const own = el.querySelectorAll(':scope > .layout-text');
    if (own.length > 0) own.forEach((n) => n.remove());
    else el.querySelector('.layout-text')?.remove();
    const stateProps = statePropsOf(desc, stateId);
    const resting = desc ? restingStateOf(desc) : 0;
    // CORE.17.k.b.b.c — `UIElement_Text::DoFontReset @ 0046a560`:
    // SetFontDIDHelper(0x1a, m_curFontObj, 0) takes entry 0 of the desc's p26
    // font list (Font::Get through FontLocal::GetGlobalOrLocalFont; a DID
    // that does not load keeps the previous font), SetFontColorHelper(0x1b,
    // m_curFontColor, 0) entry 0 of the p27 colour table — both from the
    // desc + the state the element is in. The caller's colour overrides the
    // desc's resting colour (our hand-built panels); a non-resting state's
    // own p27 overrides both.
    const style = desc ? textStyleFromDesc(desc, stateId) : null;
    const stateColorArgb = stateId !== undefined && stateId !== resting ? textColorFromProps(stateProps) : undefined;
    const color = stateColorArgb !== undefined ? cssFromArgb(stateColorArgb)
      : (callerColor ?? (style ? cssFromArgb(style.colorArgb) : undefined));
    const fontDid = style ? style.font : DEFAULT_TEXT_FONT_DID;
    const fontRenderer = this.rendererForFont(fontDid);
    const drawnFont = fontRenderer && fontRenderer !== this.fontRenderer ? fontDid : DEFAULT_TEXT_FONT_DID;

    const wrapper = document.createElement('div');
    wrapper.className = 'layout-text';
    Object.assign(wrapper.style, {
      position: 'absolute',
      left: '0', top: '0', width: '100%', height: '100%',
      display: 'flex',
      pointerEvents: 'none',
      zIndex: '5',
    }, this.textLayoutFromProps(textLayoutPropsOf(desc?.properties as Map<number, BaseProperty> | undefined, stateProps)));

    const outlineColor = desc ? outlineColorFromProps(desc.properties, stateProps) : undefined;
    if (stateId !== undefined) wrapper.dataset.acState = stateId.toString(16);
    const fullText = text;
    if (fontRenderer?.isReady) {
      // CORE.17.k.b.b.a.g.a — UIElement_Text::RecalculateTruncation @
      // 00466f80: a desc with the p199 trailer ("...") cuts a text wider
      // than the element (less its p35 / p36 margins) and appends the
      // trailer; with p208 the FULL text becomes the element's tooltip
      // (SetTooltip + SetTooltipOn) so a clipped label reads whole on hover.
      text = this.truncateForDesc(el, text, desc, fontRenderer);
      // UIElement_Text breaks lines at an embedded "\n" (e.g. the @framerate
      // meter's "FPS: …\nDEG: …"); a newline-free text stays one canvas line.
      const canvas = text.includes('\n')
        ? fontRenderer.renderWrappedTextToCanvas(text, Math.max(1, ...text.split('\n').map((l) => fontRenderer.measureText(l))), color, 1, outlineColor)
        : fontRenderer.renderTextToCanvas(text, color, 1, outlineColor);
      if (text !== fullText) canvas.dataset.acFullText = fullText;
      canvas.dataset.acFont = drawnFont.toString(16);
      canvas.style.imageRendering = 'pixelated';
      canvas.style.width = `${canvas.width}px`;
      canvas.style.height = `${canvas.height}px`;
      canvas.style.flexShrink = '0';
      if (outlineColor) {
        // The halo reaches the DRAWN font's own border pixels outside the glyphs.
        const pad = fontRenderer.outlinePadding;
        canvas.style.marginLeft = `${-pad.x}px`;
        canvas.style.marginTop = `${-pad.y}px`;
        canvas.style.marginRight = `${-pad.x}px`;
        canvas.style.marginBottom = `${-pad.y}px`;
        canvas.dataset.acOutline = outlineColor;
      }
      wrapper.appendChild(canvas);
      this.placeByCalcJustification(el, wrapper, canvas, outlineColor ? fontRenderer.outlinePadding : { x: 0, y: 0 },
        textLayoutPropsOf(desc?.properties as Map<number, BaseProperty> | undefined, stateProps));
    } else {
      // A font whose glyph sheet came back blank rebuilds on a later use; make
      // sure one comes, so its heal repaints this label (BUG.hud-text-blank-font-sheet).
      if (fontRenderer?.needsRebuild) this.scheduleHealRetry(fontRenderer);
      const span = document.createElement('span');
      Object.assign(span.style, {
        color: color ?? 'inherit',
        fontSize: '11px',
        fontFamily: 'monospace',
        // No DAT font: the eight-neighbour ring of DrawSelf's fallback pass
        // (mode 0x9000) for an outlined element, the old soft shadow otherwise.
        textShadow: outlineColor
          ? OUTLINE_NEIGHBOUR_OFFSETS.map(([ox, oy]) => `${ox}px ${oy}px 0 ${outlineColor}`).join(', ')
          : '1px 1px 1px rgba(0,0,0,0.8)',
      });
      if (outlineColor) span.dataset.acOutline = outlineColor;
      if (style) span.dataset.acFont = style.font.toString(16);
      span.textContent = text;
      wrapper.appendChild(span);
    }

    el.appendChild(wrapper);
  }

  /**
   * VISUAL.examine-misc-list-row-sliver.a — UIElement_Text::CalcJustification
   * @ 00467260 places the text at integer offsets: centred is
   * margin + (avail >> 1) - (size >> 1), far is avail - size. Flex centring
   * put an odd remainder on a half pixel the browser rounded down (the chat
   * Send label sat 1 px low against the EoR frame). When the element's DAT
   * size is known the canvas is placed absolutely at retail's offsets (an
   * outline halo keeps its negative-margin pull-back); without one the flex
   * layout stays. No p20 / p21 keeps this renderer's centred default.
   */
  private placeByCalcJustification(
    el: HTMLElement, wrapper: HTMLElement, canvas: HTMLCanvasElement,
    pad: { x: number; y: number }, props: Map<number, BaseProperty> | undefined,
  ): void {
    const W = parseFloat(el.style.width);
    const H = parseFloat(el.style.height);
    if (!(W > 0 && H > 0)) return;
    const num = (id: number): number | undefined => {
      const v = props?.get(id) as { valueInt?: number; valueEnum?: number } | undefined;
      const n = v?.valueInt ?? v?.valueEnum;
      return typeof n === 'number' ? n : undefined;
    };
    const textW = canvas.width - 2 * pad.x;
    const textH = canvas.height - 2 * pad.y;
    const x = calcJustification(textW, W, 0, num(20) ?? 1, num(35) ?? 0, num(36) ?? 0);
    const y = calcJustification(textH, H, 0, num(21) ?? 1, num(37) ?? 0, num(38) ?? 0);
    Object.assign(wrapper.style, { display: 'block', padding: '0' });
    // The outline's negative margins (set above) still pull the halo back.
    Object.assign(canvas.style, { position: 'absolute', left: `${x}px`, top: `${y}px` });
    canvas.dataset.acJustify = `${x},${y}`;
  }

  /**
   * RecalculateTruncation for `el`: the drawn text (the full text, or its
   * fitting prefix + the p199 trailer) and the p208 tooltip on the element —
   * tagged with the full text and the desc's p71 root (data-ac-tooltip-text /
   * -root, the attributes UIElementManager's HUD machine reads), cleared
   * again when a later text fits.
   */
  private truncateForDesc(el: HTMLElement, text: string, desc: OutlineDescLike | null | undefined, renderer: ACFontRenderer | null = this.fontRenderer): string {
    if (!renderer || typeof renderer.measureText !== 'function') return text;
    const spec = desc ? truncationSpec(desc.properties, getString) : null;
    const ownsTooltip = el.dataset.acTooltipTruncation === '1';
    if (!spec) return text;
    const props = desc!.properties;
    const intProp = (id: number): number => {
      const p = props.get(id) as { valueInt?: number } | undefined;
      return typeof p?.valueInt === 'number' ? p.valueInt : 0;
    };
    const width = parseFloat(el.style.width) || (desc as { width?: number }).width || 0;
    const innerWidth = width - intProp(35) - intProp(36);
    const result = truncateTextToFit(text, innerWidth, (s) => renderer.measureText(s), spec.trailer);
    if (result.truncated && spec.tooltip) {
      el.dataset.acTooltipText = text;
      const root = (props.get(71) as { valueEnum?: number } | undefined)?.valueEnum;
      if (root !== undefined) el.dataset.acTooltipRoot = root.toString(16);
      el.dataset.acTooltipTruncation = '1';
    } else if (ownsTooltip) {
      delete el.dataset.acTooltipText;
      delete el.dataset.acTooltipRoot;
      delete el.dataset.acTooltipTruncation;
    }
    return result.text;
  }

  /**
   * Apply media items (images, animations) to a DOM element as backgrounds.
   *
   * @param el - Target DOM element
   * @param media - Media descriptors from LayoutDesc
   * @param _scale - Scale factor (reserved for future use)
   * @param paletteId - Optional palette override (0x04xxxxxx) for palette-indexed textures
   */
  applyMediaToElement(el: HTMLElement, media: MediaDesc[], _scale: number, paletteId?: number): void {
    this.applyArt(el, () => this.applyMediaNow(el, media, paletteId));
  }

  /**
   * Run one art apply on `el` (`apply` returns true when it set or cleared
   * the element's image), recording it for replayMissedMedia when it read
   * across a streamed miss — or when an earlier apply on `el` is still pending.
   */
  private applyArt(el: HTMLElement, apply: () => boolean): void {
    const missEpoch = datMissEpoch();
    const drewImage = apply();
    const history = this.pendingMedia.get(el);
    if (!noDatMissSince(missEpoch)) {
      if (history) history.push(apply);
      else this.pendingMedia.set(el, [apply]);
      this.unsubscribeMediaArrival ??= onDatMissResolved(() => this.replayMissedMedia());
    } else if (history) {
      // A clean apply that sets the image supersedes everything before it.
      if (drewImage) this.pendingMedia.delete(el);
      else history.push(apply);
    }
  }

  /** Elements whose art is still waiting for streamed files (probes / tests). */
  get pendingMediaCount(): number { return this.pendingMedia.size; }

  /** Labels still waiting for a streamed font (probes / tests). */
  get pendingLabelCount(): number { return this.pendingLabels.size; }

  /** Streamed files landed: re-apply the media of the elements that drew across a miss (closed panels are dropped). */
  replayMissedMedia(): void {
    const pending = [...this.pendingMedia];
    this.pendingMedia.clear();
    for (const [el, history] of pending) {
      if (!el.isConnected) continue;
      for (const apply of history) this.applyArt(el, apply);
    }
    const labels = [...this.pendingLabels];
    this.pendingLabels.clear();
    for (const [el, repaint] of labels) if (el.isConnected) repaint();
    if (this.pendingMedia.size === 0 && this.pendingLabels.size === 0) {
      this.unsubscribeMediaArrival?.();
      this.unsubscribeMediaArrival = null;
    }
  }

  /** A scrollbar's direct track / thumb texture, stretched to the element; true when drawn. */
  private applyStretchedTexture(el: HTMLElement, textureId: number): boolean {
    const url = this.uiTextureLoader.getTextureDataURL(textureId);
    if (!url) return false;
    el.style.backgroundImage = `url(${url})`;
    el.style.backgroundSize = '100% 100%';
    return true;
  }

  /** applyMediaToElement's drawing; true when it set (or cleared) the element's image. */
  private applyMediaNow(el: HTMLElement, media: MediaDesc[], paletteId?: number): boolean {
    let drewImage = false;
    // CORE.17.k.b.b.a.f.b — a state whose only image media is file 0 (the
    // chargen watermark 0x100003d8's Custom state 0x1000002b) draws NOTHING
    // in retail (UIElement::SetMediaState with a null DID): the previous
    // state's image must go, not linger.
    let applied = false;
    let nullImage = false;
    for (const m of media) {
      if (m.type === MediaType.Image && !m.file) nullImage = true;
      if (m.type === MediaType.Image && m.file && m.file !== 0) {
        applied = true;
        // Apply texture as background image
        const url = this.uiTextureLoader.getTextureDataURL(m.file, paletteId);
        if (url) {
          el.style.backgroundImage = `url(${url})`;
          applyRetailImageBlit(el);
          drewImage = true;
        }
      } else if (m.type === MediaType.Animation && m.frames && m.frames.length > 0) {
        // For animations, use the first frame as a static image
        const firstFrame = m.frames[0];
        if (firstFrame && firstFrame !== 0) {
          const url = this.uiTextureLoader.getTextureDataURL(firstFrame, paletteId);
          if (url) {
            applied = true;
            el.style.backgroundImage = `url(${url})`;
            applyRetailImageBlit(el);
            drewImage = true;
          }
        }
      }
    }
    if (nullImage && !applied) { el.style.backgroundImage = ''; drewImage = true; }
    // GAP.ui-cursor-global — MediaMachine::Update_Cursor @ 00465a80: a Cursor
    // media sets the element's own cursor (UIElement::SetCursor), file 0
    // clears it (UnSetCursor). The window border edges are the EoL users.
    for (const m of media) {
      if (m.type !== MediaType.Cursor) continue;
      const url = m.file ? this.uiTextureLoader.getTextureDataURL(m.file) : null;
      setElementCursor(el, url ? cursorCSS(url, m.xHotspot ?? 0, m.yHotspot ?? 0) : null);
    }
    return drewImage;
  }
}

/**
 * GAP.indicator-bar-interactive (chess board) — retail never scales a UI
 * image: UIRegion::DrawSelf @ 0069f1a0 hands the region's Graphic to
 * Graphic::Draw @ 00693b20, which PutImage()s it at its native size when the
 * box fits inside the image (cropped to the box) and otherwise TILES it from
 * the region origin plus m_ptTilingOffset (0,0 unless SetTilingOffset
 * @ 0069f730), wrapping the source by the image width/height. The media's
 * drawMode only picks the blit (UIRegion::SetImageByDID @ 0069f960: 2 →
 * Blit_3Alpha, 3 → Blit_4Alpha, else Normal). A 64×64 board texture in the
 * 256×256 chess list box 0x10000174 therefore draws as 4×4 tiles (8×8
 * squares), where the former 100%-stretch drew four giant squares.
 */
export function applyRetailImageBlit(el: HTMLElement): void {
  el.style.backgroundSize = 'auto';
  el.style.backgroundRepeat = 'repeat';
  el.style.backgroundPosition = '0 0';
}
