/**
 * LayoutDesc — UI Layout definition from client_local_English.dat (0x21xxxxxx).
 *
 * Ported exactly from ACE C# source:
 *   ACE.DatLoader/FileTypes/LayoutDesc.cs
 *   ACE.DatLoader/Entity/ElementDesc.cs
 *   ACE.DatLoader/Entity/StateDesc.cs
 *   ACE.DatLoader/Entity/MediaDesc.cs
 *   ACE.DatLoader/Entity/BaseProperty.cs
 *   ACE.DatLoader/Entity/StringInfo.cs
 */
import { DatReader } from '../DatReader.js';

// ─── Enums (from ACE.Entity.Enum) ──────────────────────────────────────

export enum IncorporationFlags {
  PassToChildren = 0x1,
  X = 0x2,
  Y = 0x4,
  Width = 0x8,
  Height = 0x10,
  ZLevel = 0x20,
}

export enum MediaType {
  Undef = 0,
  Movie = 1,
  Alpha = 2,
  Animation = 3,
  Cursor = 4,
  Image = 5,
  Jump = 6,
  Message = 7,
  Pause = 8,
  Sound = 9,
  State = 10,
  Fade = 11,
  Stretch = 12,
}

export enum BasePropertyType {
  Invalid = 0,
  Bool = 1,
  Integer = 2,
  LongInteger = 3,
  Float = 4,
  Vector = 5,
  Color = 6,
  String = 7,
  StringInfo = 8,
  Enum = 9,
  DataFile = 10,
  Waveform = 11,
  InstanceID = 12,
  Position = 13,
  TimeStamp = 14,
  Bitfield32 = 15,
  Bitfield64 = 16,
  Array = 17,
  Struct = 18,
  StringToken = 19,
  PropertyName = 20,
  TriState = 21,
}

// ─── Data Structures ────────────────────────────────────────────────────

export interface StringInfo {
  strToken: number;
  stringId: number;
  tableId: number;
  override: number;
  unknown1: number;
  unknown2: number;
}

export interface BaseProperty {
  id: number;
  propertyType: BasePropertyType;
  // Value — only the matching type field is populated
  valueBool?: boolean;
  valueInt?: number;
  valueFloat?: number;
  valueEnum?: number;
  valueColor?: number;
  valueDataFile?: number;
  valueString?: StringInfo;
  valueVector?: { x: number; y: number; z: number };
  valueBitfield32?: number;
  valueBitfield64?: bigint;
  valueInstanceId?: number;
  valueArray?: BaseProperty[];
  valueStruct?: Map<number, BaseProperty>;
}

export interface MediaDesc {
  type: MediaType;
  // Movie
  fileName?: string;
  stretchToFullScreen?: boolean;
  // Alpha / Image / Cursor / Sound
  file?: number;
  // Animation
  duration?: number;
  drawMode?: number;
  frames?: number[];
  // Jump
  jumpItemIndex?: number;
  probability?: number;
  // Message
  messageId?: number;
  // Pause
  minDuration?: number;
  maxDuration?: number;
  // Cursor
  xHotspot?: number;
  yHotspot?: number;
  // Sound
  sType?: number;
  // State
  stateId?: number;
  // Fade
  startAlpha?: number;
  endAlpha?: number;
}

export interface StateDesc {
  stateId: number;
  passToChildren: boolean;
  incorporationFlags: number;
  properties: Map<number, BaseProperty>;
  media: MediaDesc[];
}

export interface ElementDesc extends StateDesc {
  uiReadOrder: number;
  elementId: number;
  type: number;
  baseElement: number;
  baseLayout: number;
  defaultState: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * Signed: `StateDesc`'s Archive read stores m_zLevel as a `long`, and
   * `UIRegion::CompareZLevel @ 0069f000` compares it signed — 0xffffffff is
   * -1 (frontmost), not 4294967295. Higher = painted EARLIER (further back);
   * see retailPaintOrder in the renderer's LayoutRenderer.
   */
  zLevel: number;
  leftEdge: number;
  topEdge: number;
  rightEdge: number;
  bottomEdge: number;
  states: Map<number, StateDesc>;
  children: Map<number, ElementDesc>;
}

export interface LayoutDescData {
  id: number;
  displayWidth: number;
  displayHeight: number;
  elements: Map<number, ElementDesc>;
}

// ─── Parsing ────────────────────────────────────────────────────────────

/** Map of property ID → BasePropertyType, loaded from MasterProperty (0x39000001). */
let masterPropertyTypes: Map<number, BasePropertyType> | null = null;


/**
 * Set the MasterProperty type lookup table.
 * Must be called before parsing LayoutDesc files that contain BaseProperty values.
 * If not set, property values will be skipped with a warning.
 */
export function setMasterPropertyTypes(types: Map<number, BasePropertyType>): void {
  masterPropertyTypes = types;
}


/**
 * Map of StringTable entry-id → first string, built from StringTable(s)
 * registered via `registerStringTable`. LayoutDesc `p23` (TextString) refs
 * resolve through this. StringTable 0x23000001 is the English client table.
 */
const stringIndex: Map<number, string> = new Map();

/**
 * Map of StringTable entry-id → full fragment array (all `strings[]` of the
 * entry, newlines unescaped). Some entries are multi-fragment templates with
 * variable slots BETWEEN the fragments — e.g. id 118350547 is
 * ["Innate Strength: ", "\nInnate Endurance: ", …, "\n"], rendered by
 * interleaving the fragments with the substituted values
 * (frag[0] + val[0] + frag[1] + val[1] + … + frag[n]). `getString` only
 * exposes strings[0]; the Character Information report needs the rest.
 */
const stringPartsIndex: Map<number, string[]> = new Map();

/**
 * Per-table entry index: table id → (entry id → strings[0]). Entry ids are
 * token hashes, so the SAME id can hold DIFFERENT text in different tables —
 * e.g. id 237541360 ("ID_PlayerOption_FellowshipShareXP") is "Share
 * Fellowship Experience and Luminance" in 0x23000003 but "Share Fellowship
 * Experience" in 0x23000005. The retail client disambiguates by binding each
 * consumer to a table (StringInfo::SetStringIDandTableEnum — e.g.
 * gmFellowshipUI::PostInit @ 0048fd40 binds all four fellowship toggles to
 * table enum 0x10000003 = English table 0x23000003); `getStringFromTable`
 * is our equivalent.
 */
const tableStringIndex: Map<number, Map<number, string>> = new Map();

/**
 * Per-table fragment index: table id → (entry id → strings[]). The
 * table-bound twin of `stringPartsIndex` — a template whose first fragment
 * is empty (a leading variable slot, e.g. ID_DataPatch_PatchProgress
 * 56886563 = ['', '% of ', 'K complete...']) reads as "" through
 * `getStringFromTable`; consumers that fill variables need the fragments.
 */
const tablePartsIndex: Map<number, Map<number, string[]>> = new Map();

/**
 * Register a parsed StringTable so its entries can be resolved by id via
 * `getString(id)`. Safe to call multiple times for different tables; later
 * registrations win on id collisions in the flat index, while
 * `getStringFromTable` keeps each table's own entries addressable.
 */
export function registerStringTable(table: StringTableData): void {
  let perTable = tableStringIndex.get(table.id);
  if (!perTable) {
    perTable = new Map();
    tableStringIndex.set(table.id, perTable);
  }
  let perTableParts = tablePartsIndex.get(table.id);
  if (!perTableParts) {
    perTableParts = new Map();
    tablePartsIndex.set(table.id, perTableParts);
  }
  for (const entry of table.entries) {
    if (entry.strings.length > 0) {
      stringIndex.set(entry.id, entry.strings[0]);
      stringPartsIndex.set(entry.id, entry.strings);
      perTable.set(entry.id, entry.strings[0]);
      perTableParts.set(entry.id, entry.strings);
    }
  }
}

/**
 * `getStringParts` bound to one table (the StringInfo table binding, as
 * `getStringFromTable` is to `getString`): the entry's full fragment array
 * with newlines unescaped, or null when the table or entry is unregistered.
 */
export function getStringPartsFromTable(tableId: number, id: number): string[] | null {
  const parts = tablePartsIndex.get(tableId)?.get(id);
  return parts ? parts.map(unescapeStringTableText) : null;
}

/**
 * The string-table meta-language's backslash escapes, as the retail client
 * undoes them (`StringTableMetaLanguage::GetUnEscapedChar @ 0067b750`):
 * `\n` `\r` `\t` and `\q` (a double quote) become the control / quote
 * character, and a backslash before one of the meta characters
 * `[ ] ! { } # \ | ^ $` (`IsEscapeChar @ 0067b690`) yields that character —
 * e.g. ID_CharGen_NamePrompt is stored as "\[ Name \]" and draws as
 * "[ Name ]". Any other backslash pair is left as it is.
 */
export function unescapeStringTableText(text: string): string {
  return text.replace(/\\([nrtq[\]!{}#\\|^$])/g, (_m, c: string) => {
    switch (c) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'q': return '"';
      default: return c;
    }
  });
}

/**
 * Resolve a StringTable entry id to its full fragment array (newlines
 * unescaped, matching `getString`). Returns null if the id isn't registered.
 * Use for multi-fragment templates that interleave fragments with values.
 */
export function getStringParts(id: number): string[] | null {
  const parts = stringPartsIndex.get(id);
  return parts ? parts.map(unescapeStringTableText) : null;
}

/**
 * AC's 28-bit string-id hash (the retail client's `compute_str_hash`).
 * Symbolic string tokens like "ID_CharacterInfo_Birth" resolve to numeric
 * StringTable entry ids through this hash — the Character Information panel
 * (gmCharacterInfoUI) addresses ~70 of its template strings this way.
 *
 * Transcribed from the decompiled retail client
 * (`compute_str_hash @ 0x00413110`):
 *   h = 0; for each byte c: h = h*16 + c;
 *     if (h & 0xF0000000) h = ((h & 0xF0000000) >>> 24 ^ h) & 0x0FFFFFFF;
 *   if (h === 0xFFFFFFFF) h = 0xFFFFFFFE;
 * Verified: "ID_CharacterInfo_Birth" → 135508168, "..._Luminance_Header"
 * → 153985746, "..._Innates" → 118350547 (all match the live DAT entries).
 */
export function acStringHash(token: string): number {
  let h = 0;
  for (let i = 0; i < token.length; i++) {
    h = (h * 16 + token.charCodeAt(i)) >>> 0;
    if ((h & 0xf0000000) !== 0) {
      h = (((h & 0xf0000000) >>> 24) ^ h) & 0x0fffffff;
    }
  }
  if (h === 0xffffffff) h = 0xfffffffe;
  return h >>> 0;
}

/**
 * Resolve a StringTable entry id (e.g. 227814001 → "I") to its first string.
 * Returns null if the id hasn't been registered — callers should fall back
 * to a hardcoded default if the StringTable isn't loaded yet.
 */
export function getString(id: number): string | null {
  // DAT strings store newlines as the literal two-character escape "\n"
  // (e.g. 67513140 "Attribute\n Credits") and the meta characters behind a
  // backslash ("\[ Name \]") — undo the escapes the way the client does so
  // they never render as literal backslash pairs on screen.
  const s = stringIndex.get(id);
  return s === undefined ? null : unescapeStringTableText(s);
}

/**
 * Resolve a StringTable entry id within one SPECIFIC table (the retail
 * client's StringInfo table binding — see `tableStringIndex`). Returns null
 * if that table isn't registered or has no such entry; callers fall back to
 * the flat `getString(id)`.
 */
export function getStringFromTable(tableId: number, id: number): string | null {
  const s = tableStringIndex.get(tableId)?.get(id);
  return s === undefined ? null : unescapeStringTableText(s);
}


function readStringInfo(r: DatReader): StringInfo {
  return {
    strToken: r.readUInt8(),
    stringId: r.readUInt32(),
    tableId: r.readUInt32(),
    override: r.readUInt8(),
    unknown1: r.readUInt8(),
    unknown2: r.readUInt8(),
  };
}

export function readBaseProperty(r: DatReader): BaseProperty {
  const id = r.readUInt32();

  // Look up property type from MasterProperty
  const propType = masterPropertyTypes?.get(id);
  if (propType === undefined) {
    throw new Error(`BaseProperty ID 0x${id.toString(16)} not found in MasterProperty table`);
  }

  const prop: BaseProperty = { id, propertyType: propType };

  switch (propType) {
    case BasePropertyType.Enum:
      prop.valueEnum = r.readUInt32();
      break;
    case BasePropertyType.Bool:
      prop.valueBool = r.readUInt8() !== 0;
      break;
    case BasePropertyType.DataFile:
      prop.valueDataFile = r.readUInt32();
      break;
    case BasePropertyType.Float:
      prop.valueFloat = r.readFloat32();
      break;
    case BasePropertyType.StringInfo:
      prop.valueString = readStringInfo(r);
      break;
    case BasePropertyType.Color:
      prop.valueColor = r.readUInt32();
      break;
    case BasePropertyType.Array: {
      // SmartArray of BaseProperty
      const count = r.readUInt32();
      prop.valueArray = [];
      for (let i = 0; i < count; i++) {
        prop.valueArray.push(readBaseProperty(r));
      }
      break;
    }
    case BasePropertyType.Integer:
      prop.valueInt = r.readInt32();
      break;
    case BasePropertyType.Struct: {
      r.readUInt8(); // bucket size
      const totalObjects = r.readUInt8();
      prop.valueStruct = new Map();
      for (let i = 0; i < totalObjects; i++) {
        const key = r.readUInt32();
        prop.valueStruct.set(key, readBaseProperty(r));
      }
      break;
    }
    case BasePropertyType.Vector:
      prop.valueVector = r.readVector3();
      break;
    case BasePropertyType.Bitfield32:
      prop.valueBitfield32 = r.readUInt32();
      break;
    case BasePropertyType.Bitfield64:
      prop.valueBitfield64 = BigInt(r.readUInt32()) | (BigInt(r.readUInt32()) << 32n);
      break;
    case BasePropertyType.InstanceID:
      prop.valueInstanceId = r.readUInt32();
      break;
    case BasePropertyType.String:
      // No use cases in end-of-retail
      break;
    default:
      break;
  }

  return prop;
}

function readMediaDesc(r: DatReader): MediaDesc {
  const type = r.readUInt32() as MediaType;
  r.readUInt32(); // Type again (read in the MediaType subclass constructor)

  const media: MediaDesc = { type };

  switch (type) {
    case MediaType.Movie:
      media.fileName = r.readPString(1);
      media.stretchToFullScreen = r.readUInt8() !== 0;
      break;
    case MediaType.Alpha:
      media.file = r.readUInt32();
      break;
    case MediaType.Animation: {
      media.duration = r.readFloat32();
      media.drawMode = r.readUInt32();
      const numFrames = r.readUInt32();
      media.frames = [];
      for (let i = 0; i < numFrames; i++) {
        media.frames.push(r.readUInt32());
      }
      break;
    }
    case MediaType.Cursor:
      media.file = r.readUInt32();
      media.xHotspot = r.readUInt32();
      media.yHotspot = r.readUInt32();
      break;
    case MediaType.Image:
      media.file = r.readUInt32();
      media.drawMode = r.readUInt32();
      break;
    case MediaType.Jump:
      media.jumpItemIndex = r.readUInt32();
      media.probability = r.readFloat32();
      break;
    case MediaType.Message:
      media.messageId = r.readUInt32();
      media.probability = r.readFloat32();
      break;
    case MediaType.Pause:
      media.minDuration = r.readFloat32();
      media.maxDuration = r.readFloat32();
      break;
    case MediaType.Sound:
      media.file = r.readUInt32();
      media.sType = r.readUInt32();
      break;
    case MediaType.State:
      media.stateId = r.readUInt32();
      media.probability = r.readFloat32();
      break;
    case MediaType.Fade:
      media.startAlpha = r.readFloat32();
      media.endAlpha = r.readFloat32();
      media.duration = r.readFloat32();
      break;
  }

  return media;
}

function readStateDesc(r: DatReader): StateDesc {
  const stateId = r.readUInt32();
  const passToChildren = r.readUInt8() !== 0;
  const incorporationFlags = r.readUInt32();

  // Properties dictionary
  r.readUInt8(); // bucket size
  const propCount = r.readUInt8();
  const properties = new Map<number, BaseProperty>();
  for (let i = 0; i < propCount; i++) {
    const key = r.readUInt32();
    properties.set(key, readBaseProperty(r));
  }

  // Media list
  const mediaCount = r.readUInt8();
  const media: MediaDesc[] = [];
  for (let i = 0; i < mediaCount; i++) {
    media.push(readMediaDesc(r));
  }

  return { stateId, passToChildren, incorporationFlags, properties, media };
}

function readElementDesc(r: DatReader): ElementDesc {
  // ElementDesc extends StateDesc — read base state first
  const base = readStateDesc(r);

  // Then read ElementDesc-specific fields
  const uiReadOrder = r.readUInt32();
  const elementId = r.readUInt32();
  const type = r.readUInt32();
  const baseElement = r.readUInt32();
  const baseLayout = r.readUInt32();
  const defaultState = r.readUInt32();

  let x = 0, y = 0, width = 0, height = 0, zLevel = 0;

  // VISUAL.screen-edge-bevel — positions are signed (retail UIRegion's m_x /
  // m_y are longs): the 3D view's resize-bar frame sits at (-1, -1), which an
  // unsigned read turned into 4294967295.
  if (base.incorporationFlags & IncorporationFlags.X) x = r.readInt32();
  if (base.incorporationFlags & IncorporationFlags.Y) y = r.readInt32();
  if (base.incorporationFlags & IncorporationFlags.Width) width = r.readUInt32();
  if (base.incorporationFlags & IncorporationFlags.Height) height = r.readUInt32();
  if (base.incorporationFlags & IncorporationFlags.ZLevel) zLevel = r.readInt32();

  const leftEdge = r.readUInt32();
  const topEdge = r.readUInt32();
  const rightEdge = r.readUInt32();
  const bottomEdge = r.readUInt32();

  // States dictionary
  r.readUInt8(); // bucket size
  const stateCount = r.readUInt8();
  const states = new Map<number, StateDesc>();
  for (let i = 0; i < stateCount; i++) {
    const key = r.readUInt32();
    states.set(key, readStateDesc(r));
  }

  // Children dictionary
  r.readUInt8(); // bucket size
  const childCount = r.readUInt8();
  const children = new Map<number, ElementDesc>();
  for (let i = 0; i < childCount; i++) {
    const key = r.readUInt32();
    children.set(key, readElementDesc(r));
  }

  return {
    ...base,
    uiReadOrder,
    elementId,
    type,
    baseElement,
    baseLayout,
    defaultState,
    x, y, width, height, zLevel,
    leftEdge, topEdge, rightEdge, bottomEdge,
    states,
    children,
  };
}

/**
 * Parse a LayoutDesc file (0x21xxxxxx) from the language DAT.
 */
export function parseLayoutDesc(r: DatReader): LayoutDescData {
  const id = r.readUInt32();
  const displayWidth = r.readInt32();
  const displayHeight = r.readInt32();

  r.readUInt8(); // bucket size
  const totalObjects = r.readUInt8();
  const elements = new Map<number, ElementDesc>();
  for (let i = 0; i < totalObjects; i++) {
    const key = r.readUInt32();
    elements.set(key, readElementDesc(r));
  }

  return { id, displayWidth, displayHeight, elements };
}

// ─── Element inheritance resolution (retail InqFullDesc/Incorporate) ────
//
// A LayoutDesc element with type==0 is a PARTIAL desc that derives from a
// base element (baseElement id, top-level in the baseLayout file). The
// retail client resolves the full desc at element-creation time:
//   LayoutDesc::InqFullDesc @ 0069a520 — resolve base chain recursively
//   (guarding against cycles via an add_unique BaseInfo chain), then
//   ElementDesc::Incorporate @ 0069b5a0 overlays the derived desc onto the
//   resolved base.
// Merge semantics (from the decompiled EoL client, acclient-decompiled.c):
//   StateDesc::Incorporate @ 0069cca0:
//     - incorporationFlags are OR'd
//     - passToChildren/x/y/width/height/zLevel copied only when the
//       derived desc's corresponding flag bit is set
//     - media CONCATENATED (base media first, derived appended)
//     - properties: derived's override/extend base's per property id
//   ElementDesc::Incorporate:
//     - elementId, defaultState, edges, uiReadOrder copied from derived
//       unconditionally; type is NOT copied (the resolved chain root's
//       element class wins — e.g. chat buttons 0x10000522-525 resolve to
//       type 1 = UIElement_Button via 0x10000526 → 0x100002b9 → 0x1000047f)
//     - states merged per state-id (StateDesc::Incorporate on collision,
//       else the derived state is added)
//     - children merged per child key (recursive ElementDesc::Incorporate
//       on collision, else added)
// Children of a full desc are themselves resolved when created
// (UIElementManager::CreateElement → CreateElementRecursiveFromPartialDesc
// → InqFullDesc per child), so resolveElementTree recurses into children.

/** Loads a parsed LayoutDesc by DAT file id (0x21xxxxxx). */
export type LayoutLoader = (layoutId: number) => LayoutDescData | null;

function cloneStateDesc(s: StateDesc): StateDesc {
  return {
    stateId: s.stateId,
    passToChildren: s.passToChildren,
    incorporationFlags: s.incorporationFlags,
    properties: new Map(s.properties),
    media: [...s.media],
  };
}

function cloneElementDesc(e: ElementDesc): ElementDesc {
  return {
    ...e,
    properties: new Map(e.properties),
    media: [...e.media],
    states: new Map([...e.states].map(([k, s]) => [k, cloneStateDesc(s)])),
    children: new Map([...e.children].map(([k, c]) => [k, cloneElementDesc(c)])),
  };
}

/** StateDesc::Incorporate — merge `derived` state into `target` (mutates target). */
function incorporateState(target: StateDesc, derived: StateDesc): void {
  target.incorporationFlags |= derived.incorporationFlags;
  if (derived.incorporationFlags & IncorporationFlags.PassToChildren) {
    target.passToChildren = derived.passToChildren;
  }
  target.media = target.media.concat(derived.media);
  for (const [k, v] of derived.properties) target.properties.set(k, v);
}

/** ElementDesc::Incorporate — merge `derived` element into `target` (mutates target). */
function incorporateElement(target: ElementDesc, derived: ElementDesc): void {
  // Element-level StateDesc part: geometry gated by the derived's flags
  // (nested StateDescs carry no geometry — only the element base-state does).
  if (derived.incorporationFlags & IncorporationFlags.X) target.x = derived.x;
  if (derived.incorporationFlags & IncorporationFlags.Y) target.y = derived.y;
  if (derived.incorporationFlags & IncorporationFlags.Width) target.width = derived.width;
  if (derived.incorporationFlags & IncorporationFlags.Height) target.height = derived.height;
  if (derived.incorporationFlags & IncorporationFlags.ZLevel) target.zLevel = derived.zLevel;
  incorporateState(target, derived);

  target.elementId = derived.elementId;
  target.defaultState = derived.defaultState;
  target.leftEdge = derived.leftEdge;
  target.topEdge = derived.topEdge;
  target.rightEdge = derived.rightEdge;
  target.bottomEdge = derived.bottomEdge;
  target.uiReadOrder = derived.uiReadOrder;
  // type deliberately NOT copied — the base chain's element class wins.
  // Keep the derived's base ref for debugging/traceability.
  target.baseElement = derived.baseElement;
  target.baseLayout = derived.baseLayout;

  for (const [sid, s] of derived.states) {
    const existing = target.states.get(sid);
    if (existing) incorporateState(existing, s);
    else target.states.set(sid, cloneStateDesc(s));
  }
  // ElementDesc::Incorporate @ 0069b5a0 first counts the base's children the
  // derived desc does NOT override (local_44), then merges each derived
  // child; a child NEW to the base has that count added to its
  // m_uiReadOrder (decomp :626881) so it sorts after the base's own
  // children — the read order is UIElement::CompareZLevel's zLevel
  // tie-break (the paint order among equal-z siblings).
  let baseOnly = 0;
  for (const key of target.children.keys()) if (!derived.children.has(key)) baseOnly++;
  for (const [key, c] of derived.children) {
    const existing = target.children.get(key);
    if (existing) incorporateElement(existing, c);
    else {
      const added = cloneElementDesc(c);
      added.uiReadOrder = (added.uiReadOrder + baseOnly) >>> 0;
      target.children.set(key, added);
    }
  }
}

/** An element rect + its four edge anchors, as UpdateForParentSizeChange reads them. */
export interface EdgeAnchoredRect {
  x: number; y: number; width: number; height: number;
  leftEdge: number; topEdge: number; rightEdge: number; bottomEdge: number;
}

/**
 * One element's new rect for a parent size change —
 * UIElement::UpdateForParentSizeChange @ 00462640 (decompiled EoL client):
 *   leftEdge/topEdge: 1 = fixed to near edge, 2 = follows far edge,
 *     3 = centered, 4 = proportional (the _ftol2 path: the coordinate
 *     scales with the parent's new/original size); 0/other = fixed.
 *   rightEdge/bottomEdge: 1 = follows far edge, 3 = centered,
 *     4 = proportional (the EXCLUSIVE coordinate scales, so adjacent
 *     proportional spans stay gap- and overlap-free); 0/other = fixed
 *     (span keeps its original far coordinate).
 * Same arithmetic as LayoutRenderer.resizeSubtree (CORE.3.d / CORE.5.b.c).
 */
export function reflowEdgeAnchoredRect(
  el: EdgeAnchoredRect,
  parentDW: number,
  parentDH: number,
  parentNewW: number,
  parentNewH: number,
): { x: number; y: number; width: number; height: number } {
  const parentOrigW = parentNewW - parentDW;
  const parentOrigH = parentNewH - parentDH;
  const origX1 = el.x + el.width - 1;
  const origY1 = el.y + el.height - 1;
  let x0 = el.x, x1 = origX1, y0 = el.y, y1 = origY1;
  if (el.leftEdge === 2) x0 = el.x + parentDW;
  else if (el.leftEdge === 3) x0 = Math.floor(parentNewW / 2) - Math.floor(el.width / 2);
  else if (el.leftEdge === 4 && parentOrigW > 0) x0 = Math.round(el.x * parentNewW / parentOrigW);
  if (el.rightEdge === 1) x1 = origX1 + parentDW;
  else if (el.rightEdge === 3) x1 = Math.floor(parentNewW / 2) - 1 + Math.floor(el.width / 2);
  else if (el.rightEdge === 4 && parentOrigW > 0) x1 = Math.round((origX1 + 1) * parentNewW / parentOrigW) - 1;
  if (el.topEdge === 2) y0 = el.y + parentDH;
  else if (el.topEdge === 3) y0 = Math.floor(parentNewH / 2) - Math.floor(el.height / 2);
  else if (el.topEdge === 4 && parentOrigH > 0) y0 = Math.round(el.y * parentNewH / parentOrigH);
  if (el.bottomEdge === 1) y1 = origY1 + parentDH;
  else if (el.bottomEdge === 3) y1 = Math.floor(parentNewH / 2) - 1 + Math.floor(el.height / 2);
  else if (el.bottomEdge === 4 && parentOrigH > 0) y1 = Math.round((origY1 + 1) * parentNewH / parentOrigH) - 1;
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/**
 * CORE.5.c — edge-anchored reflow of a desc subtree for a parent size
 * change (reflowEdgeAnchoredRect per element, mutating the descs). A child
 * whose own size changes cascades the delta to its children.
 */
function reflowForParentResize(
  el: ElementDesc,
  parentDW: number,
  parentDH: number,
  parentNewW: number,
  parentNewH: number,
): void {
  const r = reflowEdgeAnchoredRect(el, parentDW, parentDH, parentNewW, parentNewH);
  const dW = r.width - el.width;
  const dH = r.height - el.height;
  el.x = r.x; el.y = r.y; el.width = r.width; el.height = r.height;
  if (dW !== 0 || dH !== 0) {
    for (const [, c] of el.children) reflowForParentResize(c, dW, dH, r.width, r.height);
  }
}

/**
 * Every element's rect as retail has it once attached: UIElement::SetParent
 * @ 00462a50 runs UpdateForParentSizeChange @ 00462640 on each element as it
 * joins its parent, so the edge anchors apply even when nothing resizes. With
 * the parent at its authored size only mode 3 (centred) moves anything: an
 * L3/T3 element authored at a placeholder x/y (the type-5 dialog's edit frame
 * 0x2100003C:0x1000047e at x=0) is centred, and an R3/B3 span of odd size
 * loses its odd pixel, as retail's integer halves do. A top-level element's
 * parent is the layout's display size. Mutates `layout`'s element descs.
 */
export function applyAttachTimeAnchors(layout: LayoutDescData): void {
  const attach = (el: ElementDesc, parentDW: number, parentDH: number, parentW: number, parentH: number): void => {
    const r = reflowEdgeAnchoredRect(el, parentDW, parentDH, parentW, parentH);
    const dW = r.width - el.width;
    const dH = r.height - el.height;
    el.x = r.x; el.y = r.y; el.width = r.width; el.height = r.height;
    for (const [, c] of el.children) attach(c, dW, dH, r.width, r.height);
  };
  for (const [, el] of layout.elements) attach(el, 0, 0, layout.displayWidth, layout.displayHeight);
}

/**
 * LayoutDesc::InqFullDesc — resolve a partial (type==0) element desc against
 * its base chain. Returns a NEW desc (never mutates the input or any cached
 * base layout). A missing base layout/element or a cycle falls back to a
 * clone of the partial desc rather than failing the whole layout.
 */
export function resolveElementDesc(
  desc: ElementDesc,
  loadLayout: LayoutLoader,
  chain: Set<string> = new Set(),
): ElementDesc {
  if (desc.type !== 0) return cloneElementDesc(desc);
  const key = `${desc.baseLayout >>> 0}:${desc.baseElement >>> 0}`;
  if (desc.baseLayout === 0 || desc.baseElement === 0 || chain.has(key)) {
    return cloneElementDesc(desc);
  }
  chain.add(key);
  const baseLayout = loadLayout(desc.baseLayout);
  const base = baseLayout?.elements.get(desc.baseElement);
  if (!base) return cloneElementDesc(desc);
  const full = resolveElementDesc(base, loadLayout, chain);
  const baseW = full.width;
  const baseH = full.height;
  incorporateElement(full, desc);
  // CORE.5.c — when the derived element's size differs from its base root
  // (e.g. spellbook page 0x100002ac, 300x575, incorporating the classic
  // 300x337 page 0x10000294@0x21000032), retail sizes the incorporated
  // tree to the incorporating element and the children track it per their
  // edge flags — the reference screenshot (spellbook-panel.jpg) shows the
  // footer 0x10000297 (T2B1) pinned to the PAGE bottom and the list
  // 0x10000295 (B1) filling above it, not the base-layout raw geometry.
  // Children the derived desc itself repositions/resizes (their own
  // X/Y/W/H incorporation flags) are authored against the DERIVED size
  // and are left where the derived desc put them.
  const dW = full.width - baseW;
  const dH = full.height - baseH;
  if (dW !== 0 || dH !== 0) {
    for (const [childKey, child] of full.children) {
      const derivedChild = desc.children.get(childKey);
      if (derivedChild && (derivedChild.incorporationFlags
        & (IncorporationFlags.X | IncorporationFlags.Y | IncorporationFlags.Width | IncorporationFlags.Height)) !== 0) {
        continue;
      }
      reflowForParentResize(child, dW, dH, full.width, full.height);
    }
  }
  return full;
}

/**
 * Resolve an element and, recursively, all of its (post-merge) children —
 * mirrors the retail client resolving each child desc at creation time.
 */
export function resolveElementTree(
  desc: ElementDesc,
  loadLayout: LayoutLoader,
): ElementDesc {
  const full = resolveElementDesc(desc, loadLayout);
  full.children = new Map(
    [...full.children].map(([k, c]) => [k, resolveElementTree(c, loadLayout)]),
  );
  return full;
}

/**
 * Resolve every top-level element tree of a layout. Returns a new
 * LayoutDescData; the input (and any layout returned by `loadLayout`)
 * is left untouched, so raw parse caches stay valid as base sources.
 */
export function resolveLayoutDesc(
  layout: LayoutDescData,
  loadLayout: LayoutLoader,
): LayoutDescData {
  return {
    ...layout,
    elements: new Map(
      [...layout.elements].map(([k, e]) => [k, resolveElementTree(e, loadLayout)]),
    ),
  };
}

// ─── StringTable (0x23xxxxxx) ───────────────────────────────────────────

export interface StringTableEntry {
  id: number;
  varNames: string[];
  vars: string[];
  strings: string[];
  comments: number[];
  unknown: number;
}

export interface StringTableData {
  id: number;
  language: number;
  unknown: number;
  entries: StringTableEntry[];
}

function readStringTableEntry(r: DatReader): StringTableEntry {
  const id = r.readUInt32();

  const numVarNames = r.readUInt16();
  const varNames: string[] = [];
  for (let i = 0; i < numVarNames; i++) {
    varNames.push(r.readUnicodeString());
  }

  const numVars = r.readUInt16();
  const vars: string[] = [];
  for (let i = 0; i < numVars; i++) {
    vars.push(r.readUnicodeString());
  }

  const numStrings = r.readUInt32();
  const strings: string[] = [];
  for (let i = 0; i < numStrings; i++) {
    strings.push(r.readUnicodeString());
  }

  const numComments = r.readUInt32();
  const comments: number[] = [];
  for (let i = 0; i < numComments; i++) {
    comments.push(r.readUInt32());
  }

  const unknown = r.readUInt8();
  return { id, varNames, vars, strings, comments, unknown };
}

/**
 * Parse a StringTable file (0x23xxxxxx) from the language DAT.
 */
export function parseStringTable(r: DatReader): StringTableData {
  const id = r.readUInt32();
  const language = r.readUInt32();
  const unknown = r.readUInt8();

  // SmartArray of StringTableData (CompressedUInt32 count)
  const count = r.readCompressedUInt32();
  const entries: StringTableEntry[] = [];
  for (let i = 0; i < count; i++) {
    entries.push(readStringTableEntry(r));
  }

  return { id, language, unknown, entries };
}

// ─── MasterProperty (0x39000001) ────────────────────────────────────────

export interface MasterPropertyDesc {
  propertyName: number;
  propertyType: BasePropertyType;
  propertyGroup: number;
  propertyProvider: number;
  data: number;
}

/**
 * Parse MasterProperty (0x39000001) from portal.dat.
 * Returns a map of property ID → property type for use with BaseProperty parsing.
 *
 * Format from ACE C# MasterProperty.cs:
 *   uint32 Id
 *   uint32 unknown (always 0)
 *   uint32 unknown (always 0)
 *   byte   bucket (= 5)
 *   CompressedUInt32 numEnums
 *   numEnums × { uint32 key, PString(1) value } → m_emapper
 *   byte   bucket (= 6)
 *   SmartArray<uint, BasePropertyDesc>: CompressedUInt32 count, then count × { uint32 key, BasePropertyDesc }
 */
export function parseMasterProperty(r: DatReader): Map<number, BasePropertyType> {
  const id = r.readUInt32(); // File ID

  r.readUInt32(); // 0, Unknown
  r.readUInt32(); // 0, Unknown

  // m_emapper dictionary
  r.readUInt8(); // = 5, bucket
  const numEnums = r.readCompressedUInt32();
  for (let i = 0; i < numEnums; i++) {
    r.readUInt32(); // key
    // ACE's ReadPString(1) does NOT align — read manually (1 byte length + string, no alignment)
    const strLen = r.readUInt8();
    r.skip(strLen);
  }

  // m_properties SmartArray
  r.readUInt8(); // = 6, bucket
  const count = r.readCompressedUInt32();
  const types = new Map<number, BasePropertyType>();

  for (let i = 0; i < count; i++) {
    const key = r.readUInt32();

    // BasePropertyDesc.Unpack
    const propertyName = r.readUInt32();
    const propertyType = r.readUInt32() as BasePropertyType;
    const propertyGroup = r.readUInt32();
    const propertyProvider = r.readUInt32();
    const data = r.readUInt32();

    r.readInt32(); // unknown_int_1, always 0

    // Default value
    const hasDefaultValue = r.readUInt8() !== 0;
    if (hasDefaultValue) {
      switch (propertyType) {
        case BasePropertyType.Bool:
          r.readUInt8();
          break;
        case BasePropertyType.Color:
        case BasePropertyType.DataFile:
        case BasePropertyType.Enum:
          r.readUInt32();
          break;
        case BasePropertyType.Float:
          r.readFloat32();
          break;
        case BasePropertyType.Integer:
          r.readInt32();
          break;
        case BasePropertyType.Vector:
          r.readFloat32(); r.readFloat32(); r.readFloat32();
          break;
      }
    }

    const hasMax = r.readUInt8() !== 0;
    if (hasMax) {
      if (propertyType === BasePropertyType.Float) r.readFloat32();
      else r.readInt32();
    }

    const hasMin = r.readUInt8() !== 0;
    if (hasMax) { // Note: ACE C# checks hasMax here too (likely a bug, but we match it)
      if (propertyType === BasePropertyType.Float) r.readFloat32();
      else r.readInt32();
    }

    // Remaining fields
    r.readFloat32(); // predictionTimeout
    r.readUInt8(); // inheritanceType
    r.readUInt8(); // datFileType
    r.readUInt8(); // propagationType
    // 10 boolean flags
    for (let j = 0; j < 10; j++) r.readUInt8();

    // Available properties
    const numAvailable = r.readUInt8();
    for (let j = 0; j < numAvailable; j++) {
      r.readUInt32(); r.readUInt32();
    }

    types.set(key, propertyType);
  }

  return types;
}
