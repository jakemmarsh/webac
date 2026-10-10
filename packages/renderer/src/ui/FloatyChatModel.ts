/**
 * CORE.3.c — Floating chat windows (retail gmFloatyChatUI) data model.
 *
 * Ground truth (decompiled EoL client + DAT):
 *
 * - The four floaty windows are elements 0x10000505 / 0x1000050e / 0x1000050f /
 *   0x10000510 of the gameplay layout 0x21000005 (gmGamePlayUI::SetupChildren @
 *   004e9ec0 looks them up by exactly these ids), each a partial desc inheriting
 *   the FloatyChatWindow template 0x100004f7@0x2100005b. Default rects come
 *   from the raw descs: 250x104 at (0,35)/(0,145)/(0,255)/(0,365), stacked on
 *   the left edge of the 800x600 base.
 * - Each carries p87 = its toggle command (0x10000114..0x10000117, the
 *   "Toggle Floating Chat Window N" UI actions) and p268435582 (attribute
 *   0x1000007e) = the ChatInterface window id 2..5 (ChatInterface::PostInit @
 *   004f3dd0 reads it via GetAttribute_Enum). p59=true = start hidden
 *   ("off by default"). p62/p63 = min height 76 / min width 150.
 * - ChatInterface::PostInit seeds the per-window default text-type filter by
 *   window id: 2 → 0x101c (Speech|Tell|OutgoingTell|Emote), 3 → 0x40c00
 *   (Social|SocialSend|Allegiance), 4 → 0x80000 (Fellowship), 5 → 0x78000000
 *   (types 0x1B-0x1E — the Turbine global channels; window 4's default title
 *   is "Chat Window 4: Channels"). The main chat (window id 8) gets
 *   0xfbffffff — everything except type 0x1A ("client doesn't display it",
 *   ACE ChatMessageType.cs).
 * - Message routing (ChatInterface::RecvNotice_DisplayFinalStringInfo @
 *   004f4640): a message targeted at a specific window id always displays
 *   there and nowhere else; an untargeted message (window id 0) displays in
 *   every window whose filter has the type's bit (TypeIsActive @ 004f2f10 =
 *   `(1n << type) & filter`).
 * - The 1-4 buttons in the main chat bar (0x10000522-525 in classic_chat
 *   0x21000006) flip to state 6 (lit box 0x06006219) while their window is
 *   open and state 1 (0x06006218) otherwise
 *   (gmMainChatUI::RecvNotice_SetPanelVisibility @ 004ccd80).
 * - Default titles from string table 0x23000001 (the
 *   ID_Chat_ChatN_DefaultTitle strings gmGamePlayUI::SetupChildren assigns):
 *   entries 0x997af25 / 0x997aab5 / 0x997aa45 / 0x997aa55.
 * - Retail persists open/position/size/title per window in the PlayerModule
 *   chat-window options (gmFloatyChatUI::MoveTo/ResizeTo write options
 *   0x10000086-89; UpdateFromPlayerModule reads them back). CORE.3.f wires
 *   the real server round-trip: the blob parses out of PlayerDescription
 *   (@ac/network PlayerModuleOptions codec) and saves back via
 *   SetCharacterOptions with retail's 480s dirty debounce
 *   (CPlayerModule::UseTime). The localStorage store below remains as the
 *   fallback for characters with no server blob yet and for solo mode,
 *   under the same per-character scoping as chat history / panel positions.
 */

/** Gameplay layout that hosts the floaty chat window elements. */
export const GAMEPLAY_LAYOUT_ID = 0x21000005;

/** Per-window template child ids (inherited from 0x100004f7@0x2100005b). */
export const FLOATY_TITLE_BAR_ID = 0x10000529; // drag region (5,5) 240x20
export const FLOATY_TITLE_TEXT_ID = 0x100004d9; // title text (5,5) 240x16
export const FLOATY_CLOSE_BOX_ID = 0x1000052a; // close box (230,6) 14x14
export const FLOATY_LOG_AREA_ID = 0x10000010; // log backing (5,25) 224x60
/** The FloatyChatWindow template layout (root 0x100004f7) whose text desc 0x10000011 carries the log margins p35/p36 = 2. */
export const FLOATY_CHAT_TEMPLATE_LAYOUT_ID = 0x2100005b;
export const FLOATY_LOG_TEXT_ID = 0x10000011; // log text area
export const FLOATY_SCROLLBAR_ID = 0x10000012; // scrollbar column (229,25) 16x60
export const FLOATY_ENTRY_ID = 0x10000016; // input text (202x18)
export const FLOATY_SEND_ID = 0x10000019; // Send button (38x18)
export const FLOATY_NEW_TEXT_INDICATOR_ID = 0x1000048c;

/** UIElement_Text attribute 0x1e (p30): GlyphList::m_nMaxCharacters (UIElement_Text::OnSetAttribute @ 0046a640). */
export const TEXT_MAX_CHARACTERS_ATTR = 0x1e;
/** GlyphList's m_nMaxCharacters when the desc sets no p30 (GlyphList::GlyphList @ 004734a0 writes 0xffff). */
export const TEXT_DEFAULT_MAX_CHARACTERS = 0xffff;

/**
 * Character cap of a chat entry (main 0x2100006f or floaty 0x2100005b
 * element 0x10000016): its desc's p30, else GlyphList's 0xffff default.
 * GlyphList::AddText @ 00473190 deletes whatever an insert pushes past the
 * cap, so the field simply stops accepting text there.
 * Retail's chat path (ChatInterface::HandleEnterKey / ProcessCommand) adds no
 * other limit. Every EoL entry carries p30 = 255; other eras follow their DAT.
 */
export function chatEntryMaxChars(
  desc: { properties?: Map<number, { valueInt?: number }> } | null | undefined,
): number {
  const v = desc?.properties?.get(TEXT_MAX_CHARACTERS_ATTR)?.valueInt;
  return typeof v === 'number' && v > 0 ? v : TEXT_DEFAULT_MAX_CHARACTERS;
}

/** Minimum window size — template p63 (width) / p62 (height). */
export const FLOATY_MIN_WIDTH = 150;
export const FLOATY_MIN_HEIGHT = 76;
/** Maximum window size — template p61 (width 0x400) / p60 (height 0x3a0). */
export const FLOATY_MAX_WIDTH = 1024;
export const FLOATY_MAX_HEIGHT = 928;

/**
 * CORE.3.d — the 8 UIElement_Resizebar (element class 9) edge/corner
 * handles of the FloatyChatWindow template. Each carries resize-direction
 * flags p43=left / p44=right / p45=top / p42=bottom;
 * UIElement_Resizebar::StartMouseResizing @ 0046b7e0 maps the flag combo
 * to a border and resizes the PARENT window per
 * UIElement::MouseResizeElement @ 00461130 (min/max clamped, position
 * clamped to >= 0 and the screen region). Their resize-arrow cursors come
 * from the DAT Cursor media (GAP.ui-cursor-global, LayoutRenderer).
 */
export const FLOATY_RESIZE_HANDLES: ReadonlyArray<{
  elementId: number; left: boolean; right: boolean; top: boolean; bottom: boolean;
}> = [
  { elementId: 0x100004fc, left: true, right: false, top: true, bottom: false }, // TL
  { elementId: 0x1000000f, left: false, right: false, top: true, bottom: false }, // T
  { elementId: 0x100004fe, left: false, right: true, top: true, bottom: false }, // TR
  { elementId: 0x100004d2, left: true, right: false, top: false, bottom: false }, // L
  { elementId: 0x100004d3, left: false, right: true, top: false, bottom: false }, // R
  { elementId: 0x10000501, left: true, right: false, top: false, bottom: true }, // BL
  { elementId: 0x100004d4, left: false, right: false, top: false, bottom: true }, // B
  { elementId: 0x10000503, left: false, right: true, top: false, bottom: true }, // BR
];

/** Main chat window id (attribute 0x1000007e on 0x10000601). */
export const MAIN_CHAT_WINDOW_ID = 8;

/**
 * CORE.17.g — the EoL main chat window as the root HUD authors it.
 * 0x21000005 child 0x10000601 at (0,500) 410x100, edges L1/T2/R2/B1 (left
 * fixed, rides the screen bottom, fixed span) → layout 0x2100006f whose
 * root 0x10000600 is type 0x10000050 = gmFloatyMainChatUI
 * (GetUIElementType @ 004d2370). Sizes come straight from the DAT: root
 * p60/p61 max 2000x2000, p62/p63 min 300x100. Retail never scales this
 * window with the viewport — it is 410 px wide at 1024x768 and at
 * 1920x1080 alike (docs/images/retail-client-wine-inworld-holtburg.png,
 * reference/images/hud/reddit-shutdown.jpg).
 */
export const MAIN_CHAT_WINDOW = {
  layoutId: 0x2100006f,
  rootElementId: 0x10000600,
  hudElementId: 0x10000601,
  width: 410,
  height: 100,
  minWidth: 300,
  minHeight: 100,
  maxWidth: 2000,
  maxHeight: 2000,
  /** Locked-UI border art (type 3, textures 0x060074bf-c6). */
  lockedBorderIds: [0x10000693, 0x10000694, 0x10000695, 0x10000696, 0x10000697, 0x10000698, 0x10000699, 0x1000069a],
  /** Unlocked drag (type 2) / resize (type 9) borders (textures 0x06006129-2d). */
  interactiveBorderIds: [0x1000069b, 0x1000069c, 0x1000069d, 0x1000069e, 0x1000069f, 0x100006a0, 0x100006a1, 0x100006a2],
  messageAreaId: 0x10000010,
  inputRowId: 0x10000013,
  maximizeButtonId: 0x1000046f,
} as const;

/**
 * CORE.17.g.a — the main chat maximize box 0x1000046f (368,5) 16x16.
 * Its two states in layout 0x2100006f: 0x10000048 (the default, art
 * 0x06005e65) while the window is at its normal size and 0x10000047 (art
 * 0x06005e64) while maximized. gmMainChatUI::HandleMaximizeButton @
 * 004cce50 flips the state with each toggle.
 */
export const MAIN_CHAT_MAXIMIZE_STATE_NORMAL = 0x10000048;
export const MAIN_CHAT_MAXIMIZE_STATE_MAXIMIZED = 0x10000047;

/** Window rect in HUD design px (position relative to the screen root). */
export interface ChatWindowRect { x: number; y: number; w: number; h: number; }

/**
 * gmMainChatUI's maximize bookkeeping: m_Maximized ([this+0x64c]),
 * m_OldY ([this+0x650]) and m_OldHeight ([this+0x654]). Not persisted —
 * a fresh window always starts un-maximized (whatever geometry the
 * PlayerModule options restore counts as its normal size).
 */
export interface MainChatMaximizeState { maximized: boolean; oldY: number; oldHeight: number; }

/**
 * gmMainChatUI::HandleMaximizeButton @ 004cce50, read from the
 * disassembly (Ghidra's listing loses the `height + screenH/2` stack slot
 * behind the `push ebp` and shows the min-height attribute in its place):
 *
 *   maxH = attr 0x3c (p60), minH = attr 0x3e (p62)      — the root's props
 *   grownH = h + screenH/2
 *   newY = (y + h < screenH && y < screenH/2) ? y       — top half: grow down
 *                                             : y - screenH/2  — else grow up
 *   maximize: oldY = y, oldH = h, state 0x10000047,
 *             newY = max(0, newY); grownH = min(grownH, screenH - newY);
 *             ResizeTo(w, grownH); MoveTo(x, newY)
 *   restore:  oldH clamped to [minH, maxH], oldY clamped to [0, screenH - minH],
 *             state 0x10000048; ResizeTo(w, oldH); MoveTo(x, oldY)
 *
 * The width never changes. `screenH` is the parent region's height — the
 * HUD root, i.e. the screen in design px. For the default 410x100 window
 * at (0,500) on an 800x600 screen: maximize → (0,200) 410x400, the bottom
 * two thirds of the screen; restore → (0,500) 410x100.
 */
export function toggleMainChatMaximize(
  rect: Readonly<ChatWindowRect>,
  screenH: number,
  state: Readonly<MainChatMaximizeState>,
  bounds: { minHeight: number; maxHeight: number } = MAIN_CHAT_WINDOW,
): { rect: ChatWindowRect; state: MainChatMaximizeState; buttonState: number } {
  const { minHeight: minH, maxHeight: maxH } = bounds;
  if (state.maximized) {
    let oldH = state.oldHeight;
    if (oldH < minH) oldH = minH;
    if (oldH > maxH) oldH = maxH;
    let oldY = state.oldY;
    if (oldY < 0) oldY = 0;
    if (oldY > screenH - minH) oldY = screenH - minH;
    return {
      rect: { x: rect.x, y: oldY, w: rect.w, h: oldH },
      state: { maximized: false, oldY, oldHeight: oldH },
      buttonState: MAIN_CHAT_MAXIMIZE_STATE_NORMAL,
    };
  }
  const half = Math.trunc(screenH / 2);
  let grownH = rect.h + half;
  let newY = (rect.y + rect.h < screenH && rect.y < half) ? rect.y : rect.y - half;
  if (newY < 0) newY = 0;
  if (grownH + newY > screenH) grownH = screenH - newY;
  return {
    rect: { x: rect.x, y: newY, w: rect.w, h: grownH },
    state: { maximized: true, oldY: rect.y, oldHeight: rect.h },
    buttonState: MAIN_CHAT_MAXIMIZE_STATE_MAXIMIZED,
  };
}

/**
 * Main chat default filter — all low-dword types except 0x1A
 * (ChatInterface constructor / PostInit case 1 & 8).
 */
export const MAIN_CHAT_DEFAULT_FILTER = 0xfbffffff;

/**
 * CORE.17.h — chat window opacity, straight from the decompiled EoL client.
 *
 * Every chat window is a ChatInterface whose constructor
 * (ChatInterface::ChatInterface @ 004f4550) seeds
 *   m_fDefaultOpacity = 0.5   ([this+0x600])
 *   m_fActiveOpacity  = 1.0   ([this+0x604])
 *   m_fCurrentOpacity = 0.5   ([this+0x608]).
 * The floaty windows 1-4 keep those (gmFloatyChatUI::Create @ 004ce2c0 calls
 * the ChatInterface constructor and nothing else). The MAIN chat window's
 * constructor (gmMainChatUI::gmMainChatUI @ 004cd0f0, inherited by
 * gmFloatyMainChatUI @ 004d22b0) then overwrites [this+0x600] and
 * [this+0x608] with 1.0 — the main window is fully opaque whether or not the
 * entry has focus, and the see-through look of its message area is nothing
 * but the baked alpha of the 48x48 tile 0x06004cc2 (uniform black, alpha
 * 175/255 = 0.686). Both retail captures measure exactly that: the message
 * body covers ~0.69 of the world behind it and the window frame is
 * pixel-identical to the never-dimmed toolbar frame
 * (docs/images/retail-client-wine-inworld-holtburg.png,
 * reference/images/hud/reddit-shutdown.jpg).
 *
 * The PlayerModule options 0x10000080 (default) / 0x10000081 (active) are
 * applied ON TOP, and only when present: gmFloatyMainChatUI::
 * UpdateFromPlayerModule @ 004d2970 / gmFloatyChatUI::UpdateFromPlayerModule
 * @ 004ce3f0 InqOption each one and call SetDefaultOpacity / SetActiveOpacity
 * only on a hit; the layout 0x2100006f authors neither attribute (they would
 * arrive through ChatInterface::OnSetAttribute @ 004f3f60). The two setters
 * keep default <= active: SetDefaultOpacity @ 004f3bc0 raises the active
 * value to match, SetActiveOpacity @ 004f3c40 lowers the default to match.
 *
 * Which value shows: ChatInterface::SetOpacity @ 004f3120 pushes
 * m_fCurrentOpacity into the window's own render object (UIRegion::GetObject
 * -> UISurfaceObject::SetMaterialOpacity @ 00694120, the material's diffuse
 * alpha), so the WHOLE window blends — chrome, log text, scrollbar and
 * buttons together. Active applies while the window is the active element
 * and its focus descendant is the entry (IsTextEntryFocused @ 004f30a0),
 * default otherwise. The change is not a snap: ChatInterface::
 * ListenToGlobalMessage @ 004f3840 registers for global message 3
 * (UIElementManager::UseTime @ 0045cfd0, once per frame) and walks
 * m_fCurrentOpacity toward the target by 0.05 * |active - default| per
 * tick, i.e. a 20-frame fade.
 */
export interface ChatOpacityState {
  /** Opacity while the entry is NOT focused (0..1). */
  defaultOpacity: number;
  /** Opacity while the entry has focus (0..1). */
  activeOpacity: number;
}

/** ChatInterface::ChatInterface @ 004f4550 — floaty chat windows 1-4. */
export const CHAT_INTERFACE_CTOR_OPACITY: Readonly<ChatOpacityState> = { defaultOpacity: 0.5, activeOpacity: 1.0 };

/** gmMainChatUI::gmMainChatUI @ 004cd0f0 — the main chat window. */
export const MAIN_CHAT_CTOR_OPACITY: Readonly<ChatOpacityState> = { defaultOpacity: 1.0, activeOpacity: 1.0 };

/** ChatInterface::ListenToGlobalMessage @ 004f3840 — 0.05 of the span per UseTime tick. */
export const CHAT_OPACITY_FADE_TICKS = 20;

/**
 * The 20 per-frame ticks expressed as a CSS transition. Retail ticks once per
 * rendered frame, so the wall-clock length is frame-rate bound; 60 fps is the
 * figure used here.
 */
export const CHAT_OPACITY_FADE_MS = Math.round(CHAT_OPACITY_FADE_TICKS * 1000 / 60);

/** ChatInterface::SetDefaultOpacity @ 004f3bc0 — raises active to keep default <= active. */
export function setChatDefaultOpacity(s: ChatOpacityState, v: number): void {
  s.defaultOpacity = v;
  if (s.activeOpacity < v) s.activeOpacity = v;
}

/** ChatInterface::SetActiveOpacity @ 004f3c40 — lowers default to keep default <= active. */
export function setChatActiveOpacity(s: ChatOpacityState, v: number): void {
  s.activeOpacity = v;
  if (v < s.defaultOpacity) s.defaultOpacity = v;
}

/** The value SetOpacity pushes into the material for the given focus state. */
export function chatOpacityFor(s: Readonly<ChatOpacityState>, entryFocused: boolean): number {
  return entryFocused ? s.activeOpacity : s.defaultOpacity;
}

/**
 * The PlayerModule GameplayOptions 0x10000080 / 0x10000081 as the client sees
 * them: each is either present (0..1) or absent.
 */
export interface ChatOpacityOptions {
  defaultOpacity?: number;
  activeOpacity?: number;
}

/**
 * UpdateFromPlayerModule: start from the window class's constructor values,
 * then apply whichever options exist, default (0x10000080) first, active
 * (0x10000081) second — the retail call order.
 */
export function resolveChatOpacity(
  ctor: Readonly<ChatOpacityState>,
  opts: ChatOpacityOptions,
): ChatOpacityState {
  const s: ChatOpacityState = { defaultOpacity: ctor.defaultOpacity, activeOpacity: ctor.activeOpacity };
  if (opts.defaultOpacity !== undefined) setChatDefaultOpacity(s, Math.max(0, Math.min(1, opts.defaultOpacity)));
  if (opts.activeOpacity !== undefined) setChatActiveOpacity(s, Math.max(0, Math.min(1, opts.activeOpacity)));
  return s;
}

export interface FloatyChatWindowDef {
  /** 1-based window number (the digit on its toggle button). */
  index: 1 | 2 | 3 | 4;
  /** Element id in gameplay layout 0x21000005. */
  elementId: number;
  /** Toggle button element id in classic_chat 0x21000006. */
  buttonElementId: number;
  /** "Toggle Floating Chat Window N" UI command (template p87). */
  commandId: number;
  /** ChatInterface window id (attribute 0x1000007e / p268435582). */
  windowId: number;
  /** Default text-type filter (low dword — ChatInterface::PostInit). */
  defaultFilter: number;
  /** Default title (string table 0x23000001, ID_Chat_ChatN_DefaultTitle). */
  defaultTitle: string;
  /** Default rect in the 800x600 base (raw desc in 0x21000005). */
  defaultRect: { x: number; y: number; w: number; h: number };
}

export const FLOATY_CHAT_WINDOWS: readonly FloatyChatWindowDef[] = [
  {
    index: 1,
    elementId: 0x10000505,
    buttonElementId: 0x10000522,
    commandId: 0x10000114,
    windowId: 2,
    defaultFilter: 0x101c, // Speech | Tell | OutgoingTell | Emote
    defaultTitle: 'Chat Window 1: Speech',
    defaultRect: { x: 0, y: 35, w: 250, h: 104 },
  },
  {
    index: 2,
    elementId: 0x1000050e,
    buttonElementId: 0x10000523,
    commandId: 0x10000115,
    windowId: 3,
    defaultFilter: 0x40c00, // Social | SocialSend | Allegiance
    defaultTitle: 'Chat Window 2: Allegiance',
    defaultRect: { x: 0, y: 145, w: 250, h: 104 },
  },
  {
    index: 3,
    elementId: 0x1000050f,
    buttonElementId: 0x10000524,
    commandId: 0x10000116,
    windowId: 4,
    defaultFilter: 0x80000, // Fellowship
    defaultTitle: 'Chat Window 3: Fellowship',
    defaultRect: { x: 0, y: 255, w: 250, h: 104 },
  },
  {
    index: 4,
    elementId: 0x10000510,
    buttonElementId: 0x10000525,
    commandId: 0x10000117,
    windowId: 5,
    defaultFilter: 0x78000000, // types 0x1B-0x1E (Turbine global channels)
    defaultTitle: 'Chat Window 4: Channels',
    defaultRect: { x: 0, y: 365, w: 250, h: 104 },
  },
];

/**
 * ChatInterface::TypeIsActive — bit test of the text-type filter. The filter
 * is a 64-bit bitfield (UIOption_CheckboxBitfield64 / Chat_PropType — the
 * Society channel mask 0x100000000 needs bit 32), so bigint filters are
 * supported alongside the 32-bit number form the window defaults use.
 */
export function floatyTypeIsActive(filter: number | bigint, textType: number): boolean {
  if (textType < 0 || textType > 63) return false;
  return ((BigInt(filter) >> BigInt(textType)) & 1n) !== 0n;
}

/**
 * CORE.3.d — the retail Chat Options page channel groups
 * (gmChatOptionsUI::InitOptions @ 0049f100 + AddCheckboxBitfield64Option @
 * 0049eda0, decompiled EoL client). Each checkbox toggles a MASK of
 * ChatMessageType bits inside the per-window 64-bit filter option
 * (0x1000007f). Suffixes match the optionsSettings keys the options panel
 * Chat tab already writes (chatMainWindow{Suffix} / chatWindow{N}{Suffix},
 * VISUAL3.63).
 */
export const CHAT_FILTER_CHANNELS: ReadonlyArray<{ suffix: string; mask: bigint }> = [
  { suffix: 'Combat', mask: 0x600040n }, // Combat | CombatEnemy | CombatSelf
  { suffix: 'Magic', mask: 0x20080n }, // Magic | Spellcasting
  { suffix: 'AreaChat', mask: 0x1004n }, // Speech | Emote
  { suffix: 'Tells', mask: 0x18n }, // Tell | OutgoingTell
  { suffix: 'Allegiance', mask: 0x40c00n }, // Social | SocialSend | Allegiance
  { suffix: 'Fellowship', mask: 0x80000n },
  { suffix: 'General', mask: 0x8000000n }, // TurbineChat General (type 0x1B)
  { suffix: 'Trade', mask: 0x10000000n }, // type 0x1C
  { suffix: 'LFG', mask: 0x20000000n }, // type 0x1D
  { suffix: 'Roleplay', mask: 0x40000000n }, // type 0x1E
  { suffix: 'Society', mask: 0x100000000n }, // bit 32 — no EoL type emits it
  { suffix: 'Errors', mask: 0x4000000n }, // type 0x1A
];

/**
 * "Gameplay" channel mask — Broadcast | System | Advancement | Appraisal |
 * WorldBroadcast | Recall | Craft | Salvaging | AdminTell. Only the floaty
 * windows get this checkbox (main chat keeps the bits always-on via its
 * 0xfbffffff default).
 */
export const GAMEPLAY_FILTER_MASK = 0x83912021n;

/**
 * Compute a chat window's effective 64-bit text-type filter from the Chat
 * Options checkboxes. Mirrors UIOption_CheckboxBitfield64: the stored
 * option starts at the window's default mask and each checkbox sets or
 * clears exactly its channel's bits — bits outside every checkbox mask
 * (AllChannels / Abuse / Help in the main default) are untouched.
 *
 * @param getSetting reads one options key (chatMainWindowCombat, …);
 *   undefined falls back to the window's default state for that channel.
 * @param window 'main' or floaty window index 1-4.
 */
export function computeChatWindowFilter(
  getSetting: (key: string) => boolean | undefined,
  window: 'main' | 1 | 2 | 3 | 4,
): bigint {
  const def = window === 'main'
    ? BigInt(MAIN_CHAT_DEFAULT_FILTER)
    : BigInt(FLOATY_CHAT_WINDOWS[window - 1].defaultFilter);
  let filter = def;
  const keyBase = window === 'main' ? 'chatMainWindow' : `chatWindow${window}`;
  const apply = (suffix: string, mask: bigint): void => {
    const v = getSetting(`${keyBase}${suffix}`);
    const on = v === undefined ? (def & mask) !== 0n : v;
    filter = on ? filter | mask : filter & ~mask;
  };
  for (const { suffix, mask } of CHAT_FILTER_CHANNELS) apply(suffix, mask);
  if (window !== 'main') apply('Gameplay', GAMEPLAY_FILTER_MASK);
  return filter;
}

/** Persisted per-window state (localStorage stand-in for PlayerModule chat-window options). */
export interface FloatyChatWindowState {
  open: boolean;
  x: number;
  y: number;
  /** Size — retail chat-window options 0x10000088/89 (gmFloatyChatUI::ResizeTo). */
  w?: number;
  h?: number;
  /** Custom title — retail chat-window option 0x1000008d (gmFloatyChatUI::SetWindowTitle). */
  title?: string;
}

const STORAGE_KEY_BASE = 'ac_floaty_chat_v1';

export function floatyChatStorageKey(scope: string): string {
  return scope ? `${STORAGE_KEY_BASE}:${scope}` : STORAGE_KEY_BASE;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function loadFloatyChatStates(
  storage: StorageLike,
  scope: string,
): Record<number, FloatyChatWindowState> {
  try {
    const raw = storage.getItem(floatyChatStorageKey(scope));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    /* disabled / corrupt — fall through to defaults */
  }
  return {};
}

export function saveFloatyChatState(
  storage: StorageLike,
  scope: string,
  index: number,
  state: FloatyChatWindowState,
): void {
  try {
    const all = loadFloatyChatStates(storage, scope);
    all[index] = state;
    storage.setItem(floatyChatStorageKey(scope), JSON.stringify(all));
  } catch {
    /* quota / disabled — drop silently */
  }
}
