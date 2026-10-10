/**
 * CORE.17.h.g.b — the retail chat font is a DAT bitmap font picked by the two
 * Config-tab menus, NOT a Windows TrueType face.
 *
 * Retail (reference/client-eol/decomp/acclient-decompiled.c):
 *   gmClient::GRPCallback_OnFontPreferenceChanged @ 004018f0 fires on either
 *   pref (UI.ChatFontFace / UI.ChatFontSize, registered :2108-2120) and sends
 *   CM_UI::SendNotice_FontSettingsChanged(sm_nFontFace, sm_nFontSize) @
 *   00479bf0 to every listener of global message 0x4dd267 — each
 *   ChatInterface (main log + the four floaty windows; the ctor tail @
 *   004f3e60 applies the current pair at construction, :233323).
 *   ChatInterface::RecvNotice_FontSettingsChanged @ 004f4460 (:233612-233645):
 *     if (face < 6 && size < 6)
 *       map  = DBObj::GetByEnum(0x10000001, 2, 0x26)        // an EnumIDMap = our DidMapper
 *       name = PStringBase(_Formatted, "Chat_%s_%s",         // exe .rdata :79594
 *                          UI_ChatFontFace_Choices[face],    // $E133 @ 006c2fd0
 *                          UI_ChatFontSize_Choices[size])    // $E136 @ 006c3030
 *       if (map->NameToEnum(name, &e) && map->EnumToDID(e, &did) && (font = Font::Get(did)))
 *         m_chatLog->ChangeExistingTextToNewFont(font);      // every glyph already in the log
 *         m_chatLog->SetFontDIDWithoutChangingExistingText(did);  // new text
 *   DBCache::GetDIDFromEnum @ 00413940: master map (DAT header MasterMapID =
 *   0x25000000) [2] → 0x25000002 UNIQUEDB; UNIQUEDB[0x10000001] → 0x25000012
 *   "UI_ChatFonts" — the DidMapper whose client names are the 25
 *   Chat_<Face>_<Size> entries (each → a 0x40 Font).
 *
 * Only the chat LOG changes font; the entry field and the rest of the UI keep
 * their layout fonts. A name the mapper lacks, or a font that fails to load,
 * leaves the log untouched (the retail `if` chain falls through).
 */
import type { DidMapper } from '@ac/dat-parser/file-types/DidMapper.js';
import { readDidMapper } from '@ac/dat-parser/file-types/DidMapper.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';

/** UI_ChatFontFace_Choices — $E133 @ 006c2fd0 (menu order = pref value 0..4). */
export const CHAT_FONT_FACE_CHOICES = ['Arial', 'CourierNew', 'PalatinoLinotype', 'Tahoma', 'TimesNewRoman'] as const;
/** UI_ChatFontSize_Choices — $E136 @ 006c3030 (menu order = pref value 0..4). */
export const CHAT_FONT_SIZE_CHOICES = ['Tiny', 'Small', 'Medium', 'Large', 'XL'] as const;

/** gmClient::InitOptions SetDefaultValue — UI.ChatFontFace 2 (Palatino Linotype), UI.ChatFontSize 1 (Small). */
export const RETAIL_DEFAULT_CHAT_FONT_FACE = 2;
export const RETAIL_DEFAULT_CHAT_FONT_SIZE = 1;

/** The DAT header's MasterMapID (DBCache::m_MasterMapID) — the DidMapper of DidMappers. */
export const MASTER_DID_MAPPER_ID = 0x25000000;
/** Master-map enum 2 → UNIQUEDB (DBObj::GetByEnum's second argument). */
export const UNIQUEDB_MASTER_ENUM = 2;
/** UNIQUEDB enum 0x10000001 → UI_ChatFonts (DBObj::GetByEnum's first argument). */
export const UI_CHAT_FONTS_UNIQUEDB_ENUM = 0x10000001;
/** Where the chain lands in the EoL portal.dat (kept as a fallback when the master map is unreadable). */
export const UI_CHAT_FONTS_DID_MAPPER_ID = 0x25000012;

/** The Font DID the retail defaults resolve to: Chat_PalatinoLinotype_Small → 0x40000000 (Palatino_Linotype_16). */
export const RETAIL_DEFAULT_CHAT_FONT_DID = 0x40000000;

/** RecvNotice_FontSettingsChanged's guard: both indices below 6 — and inside the five-entry choice tables. */
export function isChatFontChoiceValid(face: unknown, size: unknown): face is number {
  return Number.isInteger(face) && Number.isInteger(size)
    && (face as number) >= 0 && (face as number) < CHAT_FONT_FACE_CHOICES.length
    && (size as number) >= 0 && (size as number) < CHAT_FONT_SIZE_CHOICES.length;
}

/** `Chat_%s_%s` over the two choice tables; null when either index is outside them. */
export function chatFontName(face: unknown, size: unknown): string | null {
  if (!isChatFontChoiceValid(face, size)) return null;
  return `Chat_${CHAT_FONT_FACE_CHOICES[face]}_${CHAT_FONT_SIZE_CHOICES[size as number]}`;
}

/** EnumIDMap::NameToEnum over the client name table (exact match, like the retail hash lookup). */
export function didMapperNameToEnum(mapper: DidMapper, name: string): number | null {
  for (const [e, n] of mapper.client.enumToName) if (n === name) return e;
  return null;
}

/** NameToEnum → EnumToDID: the Font DID for a face/size pair, or null when the mapper has no such name. */
export function resolveChatFontDid(mapper: DidMapper, face: unknown, size: unknown): number | null {
  const name = chatFontName(face, size);
  if (name === null) return null;
  const e = didMapperNameToEnum(mapper, name);
  if (e === null) return null;
  const did = mapper.client.enumToId.get(e);
  return did === undefined || did === 0 ? null : did;
}

export interface DidMapperSource {
  getFileData(id: number): ArrayBuffer | null | undefined;
}

function readMapper(db: DidMapperSource, id: number): DidMapper | null {
  try {
    const data = db.getFileData(id);
    if (!data) return null;
    return readDidMapper(new DatReader(data));
  } catch {
    return null;
  }
}

/**
 * DBCache::GetDIDFromEnum(0x10000001, 2) followed by the EnumIDMap load: the
 * master map's enum 2 (UNIQUEDB), then UNIQUEDB's 0x10000001 (UI_ChatFonts).
 * Falls back to the known EoL DID when the chain cannot be followed.
 */
export function loadUiChatFontsMapper(db: DidMapperSource, masterMapId: number = MASTER_DID_MAPPER_ID): DidMapper | null {
  let target: number | undefined;
  const master = masterMapId ? readMapper(db, masterMapId) : null;
  const uniqueDbId = master?.client.enumToId.get(UNIQUEDB_MASTER_ENUM);
  if (uniqueDbId) {
    const uniqueDb = readMapper(db, uniqueDbId);
    target = uniqueDb?.client.enumToId.get(UI_CHAT_FONTS_UNIQUEDB_ENUM);
  }
  return readMapper(db, target || UI_CHAT_FONTS_DID_MAPPER_ID);
}
