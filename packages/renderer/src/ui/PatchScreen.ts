/**
 * CORE.17.k.b.b.a.a — the loading (patch) screen, LayoutDesc 0x21000000, as
 * gmDataPatchUI draws it: its Cancel button, its copyright block and the
 * two meter labels, from the DAT text descs, and the epilogue the Cancel
 * button leads to.
 *
 * Ground truth (client_local_English.dat + the decompiled EoL client):
 *
 * - `gmDataPatchUI::gmDataPatchUI @ 004ee2b0` creates root 0x1000041a and
 *   binds 0x10000420 (connect text), 0x10000421 (patch text), 0x1000041e /
 *   0x1000041f (the meters). The layout's other children draw themselves:
 *   the title image 0x1000041b (0x06001343), the copyright 0x1000041d, and
 *   the Cancel button 0x1000041c at (696,30) 100x45 — an instance of the
 *   0x21000040:0x100002d3 plate template: p26 font 0x40000016, p27 white
 *   0xffffffff, p20 = p21 = 1 (centred both ways), p33 outline (p34
 *   unset → RGBAColor_Black), p23 string 134262076 "Cancel"; state media
 *   0x1 0x06004ca9 / 0x2 0x06004caa / 0x3 0x06004ca8 + the sound
 *   0x2000004b:0x72 (UI_ButtonPress) / 0xd 0x06004ca7.
 * - `gmDataPatchUI::ListenToElementMessage @ 004ede30`: element message 1
 *   (`UIElement_Button::MouseUp @ 004720e0` — a press that started on the
 *   button and was released on it) from 0x1000041c →
 *   `UIFramework::QueueUIMode(0x10000009)` = gmEpilogueUI.
 * - `gmEpilogueUI::gmEpilogueUI @ 004e9b00`: root element 0x10000399 of
 *   layout 0x21000036 — one blank 800x600 element whose only media is a
 *   Message 0x10000002 (probability 1). On the first UI tick
 *   (`MediaMachine::Update @ 00465ba0`, global message 3) `Update_Message @
 *   00465600` broadcasts it and `gmEpilogueUI::ListenToElementMessage @
 *   004e9c40` answers 0x10000002 with `Device::Done()` — the process exits
 *   right after the blank frame; a key press (global message 1,
 *   `ListenToGlobalMessage @ 004e9c30`) is the other way out. A browser tab
 *   cannot exit, so ours relaunches (the same mapping the Disconnected
 *   screen's Quit Game uses, main.ts relaunchConnectCycle).
 * - The copyright 0x1000041d (0,467) 800x40: font 0x40000002 (14 px), white,
 *   p20 = 1 (centred) / p21 = 4 (top), string 171998484 — two lines. The
 *   meter labels 0x10000420 (28,560) / 0x10000421 (408,560) 354x20: font
 *   0x40000001 (18 px), white, centred both ways; 0x10000420's states carry
 *   73246003 "Connect progress" (0x1), 3318519 "Connecting..."
 *   (0x1000003b), 184756820 "Connected!" (0x1000003c); 0x10000421 carries
 *   118662771 "Update progress". The strings live in the language DAT,
 *   which the splash precedes, so they are pinned here and asserted against
 *   the DAT by tests/verify-core17kbbaa-patch-cancel.ts.
 */
import { DatReader, RangedDat, Texture } from '@ac/dat-parser';
import { ACFont } from '@ac/dat-parser/file-types/ACFont.js';
import { SoundTable } from '@ac/dat-parser/file-types/SoundTable.js';
import type { DatFileSubset, RangeFetcher } from '@ac/dat-parser';
import type { ACFontRenderer } from './ACFontRenderer.js';
import { OUTLINE_NEIGHBOUR_OFFSETS } from './ACFontRenderer.js';
import { attachPreworldScale, PREWORLD_WIDTH, PREWORLD_HEIGHT } from './PreworldScale.js';
import { descRef } from './DatTextStyle.js';

export const PATCH_LAYOUT_ID = 0x21000000;
export const PATCH_ROOT_ELEMENT_ID = 0x1000041a;
export const PATCH_TITLE_ELEMENT_ID = 0x1000041b;
export const PATCH_TITLE_IMAGE = 0x06001343;
export const PATCH_TITLE_RECT = { x: 0, y: 30, width: 800, height: 482 } as const;

/** The Cancel button 0x1000041c and its 0x21000040:0x100002d3 template. */
export const PATCH_CANCEL_ELEMENT_ID = 0x1000041c;
export const PATCH_CANCEL_TEMPLATE = { layoutId: 0x21000040, elementId: 0x100002d3 } as const;
export const PATCH_CANCEL_RECT = { x: 696, y: 30, width: 100, height: 45 } as const;
export const PATCH_CANCEL_MEDIA = {
  normal: 0x06004ca9,
  hover: 0x06004caa,
  pressed: 0x06004ca8,
  disabled: 0x06004ca7,
} as const;
export const PATCH_CANCEL_FONT = 0x40000016;
export const PATCH_CANCEL_COLOR_ARGB = 0xffffffff;
export const PATCH_CANCEL_OUTLINE_ARGB = 0xff000000;
export const PATCH_CANCEL_STRING_ID = 134262076;
export const PATCH_CANCEL_TEXT = 'Cancel';
/** State 0x3's sound media: SoundTable 0x2000004b, Sound.UI_ButtonPress (0x72). */
export const PATCH_CANCEL_PRESS_SOUND = { table: 0x2000004b, sound: 0x72 } as const;

/** The epilogue mode the click queues, and its blank frame. */
export const EPILOGUE_UI_MODE = 0x10000009;
export const EPILOGUE_LAYOUT_ID = 0x21000036;
export const EPILOGUE_ROOT_ELEMENT_ID = 0x10000399;
/** The root's Message media → gmEpilogueUI::ListenToElementMessage → Device::Done. */
export const EPILOGUE_EXIT_MESSAGE_ID = 0x10000002;

/** The copyright block 0x1000041d. */
export const PATCH_COPYRIGHT = {
  elementId: 0x1000041d,
  rect: { x: 0, y: 467, width: 800, height: 40 },
  font: 0x40000002,
  colorArgb: 0xffffffff,
  hJustify: 1,
  vJustify: 4,
  stringId: 171998484,
  text: 'Copyright 1996-2014 Turbine, Inc. All rights reserved.\nThis program is protected by U.S. and International copyright laws as described in Help/About Asheron\'s Call.',
} as const;

/** The connect-meter label 0x10000420 and its per-state strings. */
export const PATCH_CONNECT_TEXT = {
  elementId: 0x10000420,
  rect: { x: 28, y: 560, width: 354, height: 20 },
  font: 0x40000001,
  colorArgb: 0xffffffff,
  strings: {
    /** state 0x1 */ progress: { id: 73246003, text: 'Connect progress' },
    /** state 0x1000003b */ connecting: { id: 3318519, text: 'Connecting...' },
    /** state 0x1000003c */ connected: { id: 184756820, text: 'Connected!' },
  },
  states: { progress: 0x1, connecting: 0x1000003b, connected: 0x1000003c },
} as const;

/** The patch-meter label 0x10000421. */
export const PATCH_UPDATE_TEXT = {
  elementId: 0x10000421,
  rect: { x: 408, y: 560, width: 354, height: 20 },
  font: 0x40000001,
  colorArgb: 0xffffffff,
  stringId: 118662771,
  text: 'Update progress',
} as const;

/** The Meter_Patch bars 0x1000041e / 0x1000041f. */
export const PATCH_METER_RECTS = {
  connect: { x: 40, y: 514, width: 325, height: 46 },
  update: { x: 420, y: 514, width: 325, height: 46 },
} as const;

/** Meter_Patch's 15 animated frames (1 s cycle): the filled background ... */
export const PATCH_METER_BG_FRAMES: readonly number[] = [
  0x0600195c, 0x0600195d, 0x0600195e, 0x0600195f, 0x06001960,
  0x06001961, 0x06001962, 0x06001963, 0x06001964, 0x06001965,
  0x06001970, 0x06001971, 0x06001972, 0x06001973, 0x06001974,
];
/** ... and the dark overlay drawn over the unfilled part. */
export const PATCH_METER_OV_FRAMES: readonly number[] = [
  0x06001966, 0x06001967, 0x06001968, 0x06001969, 0x0600196a,
  0x0600196b, 0x0600196c, 0x0600196d, 0x0600196e, 0x0600196f,
  0x06001975, 0x06001976, 0x06001977, 0x06001978, 0x06001979,
];

// ── VISUAL.preworld-placeholder-before-portal-dat — the splash before the
// download ──────────────────────────────────────────────────────────────────
//
// Retail's DATs are local, so gmDataPatchUI's first frame is already the
// DAT-drawn splash. Ours downloads portal.dat (~900 MB) first; instead of a
// pre-art placeholder for the whole download, the splash's own files are
// read out of portal.dat with byte-range requests (RangedDat: header, the
// B-tree path to each id, each sector chain) — about 4 MB — and the splash
// draws from those while the full file streams in.

/** Every portal.dat file the splash draws directly. */
export const PATCH_SPLASH_DAT_FILES: readonly number[] = [
  PATCH_TITLE_IMAGE,
  ...PATCH_METER_BG_FRAMES,
  ...PATCH_METER_OV_FRAMES,
  PATCH_CANCEL_MEDIA.normal, PATCH_CANCEL_MEDIA.hover, PATCH_CANCEL_MEDIA.pressed, PATCH_CANCEL_MEDIA.disabled,
  PATCH_CONNECT_TEXT.font, PATCH_UPDATE_TEXT.font, PATCH_COPYRIGHT.font, PATCH_CANCEL_FONT,
  PATCH_CANCEL_PRESS_SOUND.table,
];

/**
 * The files a splash file needs in turn: a font's two glyph sheets
 * (Font::Get), a palette-indexed texture's default palette, and the waves
 * the Cancel press's sound (SoundTable 0x2000004b, UI_ButtonPress) can pick.
 */
export function patchSplashDependencies(fileId: number, data: ArrayBuffer): number[] {
  const type = fileId >>> 24;
  if (type === 0x40) {
    const font = ACFont.read(new DatReader(data));
    return [font.foregroundSurfaceDataId, font.backgroundSurfaceDataId];
  }
  if (type === 0x06) {
    const pal = Texture.read(new DatReader(data)).defaultPaletteId;
    return pal ? [pal] : [];
  }
  if (fileId === PATCH_CANCEL_PRESS_SOUND.table) {
    const entry = SoundTable.read(new DatReader(data)).data.get(PATCH_CANCEL_PRESS_SOUND.sound);
    return entry ? entry.data.map((d) => d.soundId) : [];
  }
  return [];
}

/** Read the splash's files out of portal.dat through `fetchRange`. */
export async function loadPatchSplashFiles(fetchRange: RangeFetcher): Promise<DatFileSubset> {
  const dat = await RangedDat.open(fetchRange);
  return dat.readSubset(PATCH_SPLASH_DAT_FILES, patchSplashDependencies);
}

// ── CORE.17.k.b.b.a.a.a — the label TEXTS: the connect level's state and the
// DDD patch strings ──────────────────────────────────────────────────────────
//
// `gmDataPatchUI::SetConnectLevel @ 004ede60` stores the level, sets the
// connect meter's 0x66 (level) attribute and switches 0x10000420's state:
//   level <= 0.0  → 0x1 (its own p23 73246003 "Connect progress")
//   0.0 < level < 1.0 → 0x1000003b (3318519 "Connecting...")
//   level >= 1.0  → 0x1000003c (184756820 "Connected!")
// (fcomp against the doubles at 0x794610 = 0.0 and 0x7928c0 = 1.0, then the
// indirect UIElement state call at vtable +0x9c). Its only callers pass 0.0
// (the ctor @ 004ee2b0) and 1.0 (`UseTime @ 004edf10`, once SharedNet
// reports the connection up), so the EoL client never shows "Connecting..."
// on this screen — the DAT carries the state for a level nobody sets.
//
// `gmDataPatchUI::OnDDDEvent @ 004edff0` drives 0x10000421 through
// `UIElement_Text::SetStringInfo` with the ID_DataPatch_* strings of table
// enum 0x10000002 (= 0x23000002); the meter follows `SetPatchLevel @
// 004edee0` (0x66). Its state: m_expected (-1 until PatchtimeBegin),
// m_recieved, m_fPatchLevel — see PatchStatus below.

/** StringInfo table enum 0x10000002 = the English table 0x23000002. */
export const PATCH_STRING_TABLE_ENUM = 0x10000002;
export const PATCH_STRING_TABLE_ID = 0x23000002;

/**
 * The ID_DataPatch_* strings (ids = acStringHash(token) in 0x23000002),
 * pinned as their fragment arrays: a variable slot sits between every two
 * fragments (StringInfo::AddVariable_* fills them in order), so
 * "<percent>% of <total>K complete..." is ['', '% of ', 'K complete...'].
 */
export const PATCH_DDD_STRINGS = {
  /** DDD_PatchtimeInterrogation (while m_expected == -1). */
  interrogation: { token: 'ID_DataPatch_Interrogation', id: 20083534, parts: ['Looking for data to patch...'] },
  /** DDD_PatchtimePending (while m_expected == -1): token_total = the queue position. */
  waiting: { token: 'ID_DataPatch_Waiting', id: 30457015, parts: ['Too many people patching.  We\'re #', ' in line...'] },
  /** DDD_PatchtimeBegin: m_expected = the byte total. */
  patching: { token: 'ID_DataPatch_Patching', id: 61383143, parts: ['Patching data...'] },
  /** DDD_DataDownloaded: token_percent = trunc(level * 100), token_total = m_expected >> 10 (K). */
  patchProgress: { token: 'ID_DataPatch_PatchProgress', id: 56886563, parts: ['', '% of ', 'K complete...'] },
  /** DDD_PatchtimeEnd: level 1.0. */
  patchingDone: { token: 'ID_DataPatch_PatchingDone', id: 31989477, parts: ['Patching Done!'] },
} as const;

/**
 * The English LanguageInfo (0x41000000) number format
 * `StringInfoDataHelper::NumToString @ 0042f280` applies to every integer
 * StringInfo variable (`ULInt_StringInfoData::ToString @ 0042f810`):
 * CLanguageInfoInterface::GetGroupingSize / GetGroupingSeperator. Pinned
 * because the language DAT is not loaded while the splash runs.
 */
export const PATCH_NUMBER_FORMAT = { groupingSize: 3, groupingSeparator: ',' } as const;

/** NumToString for a non-negative integer: digit groups per the LanguageInfo. */
export function formatLanguageUInt(
  value: number,
  fmt: { groupingSize: number; groupingSeparator: string } = PATCH_NUMBER_FORMAT,
): string {
  const digits = Math.max(0, Math.trunc(value)).toString(10);
  if (fmt.groupingSize <= 0 || !fmt.groupingSeparator) return digits;
  const groups: string[] = [];
  for (let end = digits.length; end > 0; end -= fmt.groupingSize) {
    groups.unshift(digits.slice(Math.max(0, end - fmt.groupingSize), end));
  }
  return groups.join(fmt.groupingSeparator);
}

/**
 * StringInfo::GetString for a fragment array: the variables fill the slots
 * between the fragments in order (frag[0] + var[0] + frag[1] + …); a
 * missing variable leaves its slot empty, extra variables are ignored.
 */
export function formatStringParts(parts: readonly string[], vars: readonly string[] = []): string {
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    out += parts[i];
    if (i < parts.length - 1) out += vars[i] ?? '';
  }
  return out;
}

export interface PatchLabel {
  /** The 0x10000420 state (connect) or the string id (patch) the text comes from. */
  source: number;
  text: string;
}

/** SetConnectLevel's state switch for 0x10000420. */
export function connectTextForLevel(level: number): PatchLabel {
  const s = PATCH_CONNECT_TEXT.strings;
  if (level <= 0) return { source: PATCH_CONNECT_TEXT.states.progress, text: s.progress.text };
  if (level < 1) return { source: PATCH_CONNECT_TEXT.states.connecting, text: s.connecting.text };
  return { source: PATCH_CONNECT_TEXT.states.connected, text: s.connected.text };
}

/** The DDDEvent cases OnDDDEvent handles, with their payload. */
export type PatchEvent =
  | { kind: 'interrogation' }
  | { kind: 'pending'; position: number }
  | { kind: 'begin'; expected: number }
  | { kind: 'downloaded'; bytes: number }
  | { kind: 'end' };

/** The "<percent>% of <total>K complete..." line for a level and a byte total. */
export function patchProgressText(level: number, expectedBytes: number): string {
  const percent = Math.trunc(Math.min(Math.max(level, 0), 1) * 100);
  const totalK = Math.trunc(Math.max(expectedBytes, 0)) >>> 10;
  return formatStringParts(PATCH_DDD_STRINGS.patchProgress.parts, [formatLanguageUInt(percent), formatLanguageUInt(totalK)]);
}

/**
 * gmDataPatchUI's patch side: m_expected / m_recieved / m_fPatchLevel and
 * the 0x10000421 text, advanced by OnDDDEvent. Starts as the ctor leaves it
 * (expected -1, received 0, level 0.0) with the label on its own p23
 * "Update progress" — nothing has been said about the patch yet.
 */
export class PatchStatus {
  expected = -1;
  received = 0;
  level = 0;
  label: PatchLabel = { source: PATCH_UPDATE_TEXT.stringId, text: PATCH_UPDATE_TEXT.text };

  /** OnDDDEvent: returns the new label when the event changed it, else null. */
  onEvent(event: PatchEvent): PatchLabel | null {
    const S = PATCH_DDD_STRINGS;
    switch (event.kind) {
      case 'interrogation':
        if (this.expected !== -1) return null;
        return this.setLabel(S.interrogation.id, formatStringParts(S.interrogation.parts));
      case 'pending':
        if (this.expected !== -1) return null;
        return this.setLabel(S.waiting.id, formatStringParts(S.waiting.parts, [formatLanguageUInt(event.position)]));
      case 'begin':
        this.expected = Math.max(0, Math.trunc(event.expected));
        return this.setLabel(S.patching.id, formatStringParts(S.patching.parts));
      case 'downloaded': {
        this.received += Math.max(0, Math.trunc(event.bytes));
        if (this.expected === -1) return null;
        const raw = this.expected === 0 ? 1 : this.received / this.expected;
        this.level = Math.min(Math.max(raw, 0), 1);
        return this.setLabel(S.patchProgress.id, patchProgressText(this.level, this.expected));
      }
      case 'end':
        if (this.expected === -1) this.expected = 0;
        this.received = this.expected;
        this.level = 1;
        return this.setLabel(S.patchingDone.id, formatStringParts(S.patchingDone.parts));
    }
  }

  private setLabel(source: number, text: string): PatchLabel {
    this.label = { source, text };
    return this.label;
  }
}

/**
 * Retail's DDD events arrive from the server over the connection, so the
 * patch side of gmDataPatchUI can't move before SharedNet reports the link up
 * (connect level 1.0). Our DATs come from a file host with no link involved,
 * and a cache-served set finishes in milliseconds, ahead of the bridge probe:
 * the patch meter filled before the connect meter. The gate holds the patch
 * events until the connect level reaches 1.0, then hands them over in order.
 * A bridge that never answers leaves the patch side on "Update progress", as
 * retail's would with no connection.
 */
export class PatchEventGate {
  private held: PatchEvent[] = [];
  private connected = false;

  /** A patch event: the events to apply now (none while the link is down). */
  push(event: PatchEvent): PatchEvent[] {
    if (this.connected) return [event];
    this.held.push(event);
    return [];
  }

  /** SetConnectLevel: at 1.0 the gate opens and returns the held events. */
  setConnectLevel(level: number): PatchEvent[] {
    if (this.connected || level < 1) return [];
    this.connected = true;
    const held = this.held;
    this.held = [];
    return held;
  }
}

/** The part of ACFontRenderer the splash draws with (a fake stands in under test). */
export type PatchFont = Pick<ACFontRenderer, 'isReady' | 'renderTextToCanvas' | 'outlinePadding'>;

const cssOf = (argb: number): string => '#' + ((argb >>> 0) & 0xffffff).toString(16).padStart(6, '0');

/**
 * One line of DAT-font text as a canvas (or a span when no font is ready),
 * rendered at `dpr` and displayed at logical size; with `outlineColor` the
 * canvas grows by the font's border and is pulled back with negative
 * margins so the glyphs keep their place (GameUI.renderACText parity).
 */
export function renderPatchText(
  font: PatchFont | null, text: string, colorArgb: number, dpr = 1, outlineArgb?: number,
): HTMLElement {
  const color = cssOf(colorArgb);
  const outline = outlineArgb !== undefined ? cssOf(outlineArgb) : undefined;
  let el: HTMLElement;
  if (font?.isReady) {
    const canvas = font.renderTextToCanvas(text, color, dpr, outline);
    Object.assign(canvas.style, {
      display: 'block',
      width: `${canvas.width / dpr}px`, height: `${canvas.height / dpr}px`,
    });
    if (outline) {
      const pad = font.outlinePadding;
      Object.assign(canvas.style, {
        marginLeft: `${-pad.x}px`, marginTop: `${-pad.y}px`, marginRight: `${-pad.x}px`, marginBottom: `${-pad.y}px`,
      });
    }
    el = canvas;
  } else {
    const span = document.createElement('span');
    span.textContent = text;
    span.style.color = color;
    if (outline) span.style.textShadow = OUTLINE_NEIGHBOUR_OFFSETS.map(([ox, oy]) => `${ox}px ${oy}px 0 ${outline}`).join(', ');
    el = span;
  }
  if (outline) el.dataset.acOutline = outline;
  return el;
}

export interface PatchCancelButtonDeps {
  /** A data URL for a 0x06 texture (TextureManager.getIconDataURL). */
  textureUrl: (did: number) => string | null;
  /** Font 0x40000016 with its foreground + background sheets loaded. */
  font: PatchFont | null;
  /** Element message 1: the click. */
  onCancel: () => void;
  /** Entering state 0x3: its sound media. */
  onPress?: () => void;
  dpr?: number;
}

export type PatchCancelState = 'normal' | 'hover' | 'pressed' | 'disabled';

/**
 * The Cancel button 0x1000041c: the template's plate faces per state
 * (`UIElement_Button::UpdateState_ @ 00471cf0`: pressed while the mouse is
 * down on it, hover while over it, else normal) and the outlined "Cancel"
 * label centred on the plate. A click (press + release on the button,
 * `MouseUp @ 004720e0` → element message 1) calls `onCancel`.
 */
export function buildPatchCancelButton(deps: PatchCancelButtonDeps): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 'patch-cancel';
  btn.type = 'button';
  btn.className = 'ac-btn';
  const r = PATCH_CANCEL_RECT;
  Object.assign(btn.style, {
    position: 'absolute', left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px`,
    padding: '0', border: 'none', background: 'transparent', cursor: 'pointer',
    backgroundSize: '100% 100%', backgroundRepeat: 'no-repeat',
    display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'visible',
  });
  btn.dataset.acDesc = descRef(PATCH_LAYOUT_ID, PATCH_CANCEL_ELEMENT_ID);
  btn.dataset.acFont = PATCH_CANCEL_FONT.toString(16);

  const label = renderPatchText(deps.font, PATCH_CANCEL_TEXT, PATCH_CANCEL_COLOR_ARGB, deps.dpr ?? 1, PATCH_CANCEL_OUTLINE_ARGB);
  label.dataset.acDesc = btn.dataset.acDesc;
  label.dataset.acFont = btn.dataset.acFont;
  btn.appendChild(label);

  const setState = (state: PatchCancelState): void => {
    const did = PATCH_CANCEL_MEDIA[state];
    btn.dataset.acState = state;
    btn.dataset.acMedia = did.toString(16);
    const url = deps.textureUrl(did);
    btn.style.backgroundImage = url ? `url(${url})` : '';
  };
  let over = false;
  let pressed = false;
  const update = (): void => setState(pressed && over ? 'pressed' : over ? 'hover' : 'normal');
  btn.addEventListener('mouseenter', () => { over = true; update(); });
  btn.addEventListener('mouseleave', () => { over = false; update(); });
  btn.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    pressed = true; over = true; update();
    deps.onPress?.();
  });
  const release = (): void => { if (!pressed) return; pressed = false; update(); };
  btn.addEventListener('mouseup', release);
  btn.addEventListener('blur', release);
  // A release away from the button ends the press without a click (MouseUp
  // only broadcasts message 1 when the mouse is still on the button).
  if (typeof window !== 'undefined') window.addEventListener('mouseup', release);
  btn.addEventListener('click', () => deps.onCancel());
  setState('normal');
  return btn;
}

/**
 * The copyright block 0x1000041d: the DAT string's lines in font 0x40000002,
 * each centred (p20 = 1), stacked from the cell's top edge (p21 = 4).
 */
export function buildPatchCopyright(font: PatchFont | null, dpr = 1): HTMLDivElement {
  const c = PATCH_COPYRIGHT;
  const el = document.createElement('div');
  el.id = 'patch-copyright';
  Object.assign(el.style, {
    position: 'absolute', left: `${c.rect.x}px`, top: `${c.rect.y}px`, width: `${c.rect.width}px`, height: `${c.rect.height}px`,
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start',
    color: cssOf(c.colorArgb), fontFamily: 'sans-serif', fontSize: '11px', lineHeight: '14px', textAlign: 'center',
    overflow: 'visible',
  });
  el.dataset.acDesc = descRef(PATCH_LAYOUT_ID, c.elementId);
  el.dataset.acFont = c.font.toString(16);
  for (const line of c.text.split('\n')) {
    const run = renderPatchText(font, line, c.colorArgb, dpr);
    run.dataset.acFont = el.dataset.acFont;
    el.appendChild(run);
  }
  return el;
}

/**
 * Draw `text` into a meter label cell (0x10000420 / 0x10000421): font
 * 0x40000001, white, centred both ways in the 354x20 cell. Replaces the
 * cell's previous content.
 */
export function renderPatchLabel(cell: HTMLElement, font: PatchFont | null, text: string, dpr = 1): HTMLElement {
  const run = renderPatchText(font, text, PATCH_CONNECT_TEXT.colorArgb, dpr);
  run.dataset.acFont = PATCH_CONNECT_TEXT.font.toString(16);
  if (run.tagName === 'CANVAS') run.style.margin = '0 auto';
  cell.replaceChildren(run);
  cell.dataset.acFont = run.dataset.acFont;
  // The text a canvas run carries (probes read it back; CORE.17.k.b.b.a.a.a).
  cell.dataset.acText = text;
  return run;
}

export interface EpilogueDeps {
  /** Device::Done — ours relaunches the client. */
  onExit: () => void;
  win?: Window;
}

/**
 * gmEpilogueUI: the blank 800x600 frame (layout 0x21000036, root
 * 0x10000399) whose Message media exits the client on the first UI tick —
 * ours on the next animation frame — or on a key press before that.
 * Returns the frame's host; `onExit` fires once.
 */
export function buildEpilogueFrame(deps: EpilogueDeps): HTMLDivElement {
  const win = deps.win ?? window;
  const host = document.createElement('div');
  host.id = 'epilogue-host';
  Object.assign(host.style, { position: 'fixed', inset: '0', background: '#000' });
  const inner = document.createElement('div');
  inner.id = 'epilogue-inner';
  inner.dataset.mode = 'epilogue';
  inner.dataset.acLayout = EPILOGUE_LAYOUT_ID.toString(16);
  inner.dataset.acDesc = descRef(EPILOGUE_LAYOUT_ID, EPILOGUE_ROOT_ELEMENT_ID);
  inner.style.background = '#000';
  inner.style.width = `${PREWORLD_WIDTH}px`;
  inner.style.height = `${PREWORLD_HEIGHT}px`;
  const detachScale = attachPreworldScale(inner, win);
  host.appendChild(inner);
  let done = false;
  const exit = (): void => {
    if (done) return;
    done = true;
    win.removeEventListener('keydown', exit);
    detachScale();
    deps.onExit();
  };
  win.addEventListener('keydown', exit);
  // MediaMachine::Update runs the root's media on the next UI tick: the
  // Message 0x10000002 is Device::Done.
  if (typeof win.requestAnimationFrame === 'function') win.requestAnimationFrame(() => exit());
  else win.setTimeout(() => exit(), 0);
  return host;
}

// ─── Patch failure (browser delivery) ───────────────────────────────────
// Retail patched over its own server link and reported failures through the
// NetError dialog; ours downloads the DATs over HTTP before any game link, so
// a failed download is a browser-delivery error with no retail string. Once
// it is shown it must stay: the bridge health probe resolving a moment later
// ("Connected!") used to paint over it, leaving "Patching data..." forever.

/** Latches the splash status once a failure is on screen. */
export class PatchStatusLatch {
  private failedText: string | null = null;
  /** Record the failure; returns the text to draw. */
  fail(text: string): string {
    this.failedText = text;
    return text;
  }
  get failed(): boolean { return this.failedText !== null; }
  /** Whether an ordinary status write (connect level, DDD progress) may draw. */
  allows(): boolean { return this.failedText === null; }
}

/** Player-facing text for a fatal boot error. */
export function patchFailureText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const status = /:\s*(\d{3})\b/.exec(msg)?.[1];
  if (/Failed to fetch .*\.(dat|json)/.test(msg) && status) {
    return `Game data is unavailable right now (HTTP ${status}). Please try again later.`;
  }
  if (/^Truncated download/.test(msg)) {
    return 'The game data download was interrupted. Reload to try again.';
  }
  if (err instanceof TypeError && /fetch|network/i.test(msg)) {
    return 'Could not reach the game data server. Check your connection and reload.';
  }
  return `Error: ${msg}`;
}

// ── ERA.switch-no-splash — an era-switch reload is not a new launch ──────
// Entering a world of another era stashes the login and reloads the page
// into that era (era/EraBoot.ts). Retail had no in-client era switch, so
// the reload is a browser-UX surface: to the player it is the second half
// of ENTER, and putting gmDataPatchUI back up (the patch splash with its
// two meters) read as being bounced back to the start (Jake, playwebac.com
// 2026-10-06). That boot keeps the screen black — the pre-world letterbox
// the connecting screen opens on — and shows a single progress line only
// when a download is really holding it up.

/** How a boot presents the data patch. */
export interface PatchBootPlan {
  /** gmDataPatchUI's splash (title art, meters, Cancel) is drawn. */
  splash: boolean;
  /** The splash's own files are read by byte range ahead of the whole portal.dat (whole-DAT boots). */
  rangedSplash: boolean;
  /** The interrogation waits (bounded) for that ranged splash read. */
  waitForRangedSplash: boolean;
  /** Patch events wait for the connect meter (PatchEventGate); only a drawn connect meter needs that. */
  gatePatchOnConnect: boolean;
  /** The quiet line (QuietPatchProgress) reports a slow download instead of the meters. */
  quietProgress: boolean;
}

export function patchBootPlan(opts: { resumingEraSwitch: boolean; streamedInterface: boolean }): PatchBootPlan {
  if (opts.resumingEraSwitch) {
    return { splash: false, rangedSplash: false, waitForRangedSplash: false, gatePatchOnConnect: false, quietProgress: true };
  }
  const ranged = !opts.streamedInterface;
  return { splash: true, rangedSplash: ranged, waitForRangedSplash: ranged, gatePatchOnConnect: true, quietProgress: false };
}

/** A download shorter than this never shows the quiet line (a cache-served set takes well under it). */
export const QUIET_PATCH_REVEAL_MS = 1000;

/**
 * The quiet boot's one progress line: the patch's own ID_DataPatch_* text
 * ("<n>% of <total>K complete..."), shown only while bytes are downloading
 * and the boot has run past QUIET_PATCH_REVEAL_MS. `text()` is null while
 * the screen should stay black.
 */
export class QuietPatchProgress {
  readonly status = new PatchStatus();
  private downloading = false;
  private ended = false;

  constructor(private readonly startedAt: number, private readonly revealMs = QUIET_PATCH_REVEAL_MS) {}

  onEvent(event: PatchEvent): void {
    this.status.onEvent(event);
    if (event.kind === 'begin' && event.expected > 0) this.downloading = true;
    if (event.kind === 'end') this.ended = true;
  }

  /** The line to show at `now`, or null (nothing to wait for, or not long enough to mention). */
  text(now: number): string | null {
    if (!this.downloading || this.ended || this.status.level >= 1) return null;
    if (now - this.startedAt < this.revealMs) return null;
    return this.status.label.text;
  }
}
