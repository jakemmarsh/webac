/**
 * ChatMessageType — categorizes chat window messages to control color and filtering.
 *
 * Reference: reference/ACE/Source/ACE.Entity/Enum/ChatMessageType.cs
 *
 * Used with server chat packets (0x02BB HearSpeech, 0x02BC HearRangedSpeech,
 * 0xF7B0 0x02BD Tell, 0xF7E0 ServerMessage). Each type has an authoritative
 * color per ACE's LogTextTypeEnumMapper documentation and classic AC client.
 */
export enum ChatMessageType {
  Broadcast = 0x00,
  AllChannels = 0x01,
  Speech = 0x02,
  Tell = 0x03,
  OutgoingTell = 0x04,
  System = 0x05,
  Combat = 0x06,
  Magic = 0x07,
  Channel = 0x08,
  ChannelSend = 0x09,
  Social = 0x0A,
  SocialSend = 0x0B,
  Emote = 0x0C,
  Advancement = 0x0D,
  Abuse = 0x0E,
  Help = 0x0F,
  Appraisal = 0x10,
  Spellcasting = 0x11,
  Allegiance = 0x12,
  Fellowship = 0x13,
  WorldBroadcast = 0x14,
  CombatEnemy = 0x15,
  CombatSelf = 0x16,
  Recall = 0x17,
  Craft = 0x18,
  Salvaging = 0x19,
  /**
   * FAITHFUL.327 — Reserved/unknown ChatMessageType values present in ACE
   * source but documented as "Unknown purpose/filter?". Per
   * `reference/ACE/Source/ACE.Entity/Enum/ChatMessageType.cs:264-271` these
   * render as "Light cyan (sky blue)" — retail's colorBlueGrey (CORE.17.s,
   * BuildChatColorLookupTable @ 004f31c0 groups 0x1b..0x1e, 0x20 and Abuse).
   * x1A (0x1A) is commented out in ACE ("Client doesn't display it"): chat
   * windows filter it, the spew box shows it (CORE.17.k).
   */
  X1B = 0x1B,
  X1C = 0x1C,
  X1D = 0x1D,
  X1E = 0x1E,
  AdminTell = 0x1F,
}

/**
 * Retail default chat text colours — CORE.17.s.
 *
 * Source: the decompiled EoL client, ChatInterface::BuildChatColorLookupTable
 * @ 004f31c0 (docs/retail-client-symbols.md, "Default chat text colours").
 * Every chat window runs it from the ChatInterface ctor tail @ 004f3e60; the
 * text element then picks the font colour per line from this table
 * (UIElement_Text::AppendStringInfoWithFont @ 00469de0 → SetFontColorHelper
 * (property 0x1b, type)). The named colours are float RGBA globals in
 * acclient.exe .data (0x81c4a8..0x81c578), rounded to 8-bit here.
 *
 * ACE's ChatMessageType.cs comments ("Bright Yellow Text" for Social /
 * Fellowship / AdminTell, "Light Pink" for Channel, "Red" for Help /
 * CombatEnemy, "Pink" for CombatSelf, "Green" for WorldBroadcast /
 * Salvaging) agree with this table; the hand-written table that lived here
 * before 2026-09-09 did not (Broadcast white, System grey, Magic green, …).
 */
export const RETAIL_CHAT_COLORS = {
  /** colorGreen 0x81c578 (0.5, 1.0, 0.498) — the default for every text type. */
  green: '#80ff7f',
  /** colorWhite 0x81c4b8. */
  white: '#ffffff',
  /** colorGrey 0x81c558 (0.824, 0.824, 0.784). */
  grey: '#d2d2c8',
  /** colorYellow 0x81c4c8 (1.0, 1.0, 0.247). */
  yellow: '#ffff3f',
  /** colorTan 0x81c4d8 (0.824, 0.824, 0.392). */
  tan: '#d2d264',
  /** colorPink 0x81c528 (1.0, 0.588, 0.588). */
  pink: '#ff9696',
  /** colorOrange 0x81c568 (0.933, 0.573, 0.118). */
  orange: '#ee921e',
  /** colorBlueGrey 0x81c548 (0.706, 0.863, 0.941). */
  blueGrey: '#b4dcf0',
  /** colorDarkRed 0x81c4f8 (1.0, 0.247, 0.247). */
  darkRed: '#ff3f3f',
  /** colorLightRed 0x81c508 (0.96, 0.459, 0.447). */
  lightRed: '#f57572',
  /** colorLightBlue 0x81c518 (0.247, 0.749, 1.0). */
  lightBlue: '#3fbfff',
  /** colorCyan 0x81c538 (0.247, 0.863, 0.863). */
  cyan: '#3fdcdc',
  /** colorBrightPurple 0x81c4e8 (1.0, 0.498, 1.0). */
  brightPurple: '#ff7fff',
  /** colorBrightRed 0x81c4a8 (1.0, 0.0, 0.0) — type 0x1a, the spew-box red. */
  brightRed: '#ff0000',
} as const;

/** The table holds text types 0x00..0x21 (the `mov esi,0x22` append loop). */
export const RETAIL_CHAT_TEXT_TYPE_COUNT = 0x22;

/**
 * Builds the 34-entry type → colour table exactly the way
 * BuildChatColorLookupTable does: fill with green, then apply the override
 * groups in the decompiled order.
 */
export function buildRetailChatColorTable(): string[] {
  const c = RETAIL_CHAT_COLORS;
  const table: string[] = new Array<string>(RETAIL_CHAT_TEXT_TYPE_COUNT).fill(c.green);
  const set = (color: string, types: number[]): void => { for (const t of types) table[t] = color; };
  set(c.white, [ChatMessageType.Speech]);
  set(c.grey, [ChatMessageType.Emote]);
  set(c.yellow, [ChatMessageType.Tell, ChatMessageType.AdminTell, ChatMessageType.Social, ChatMessageType.Fellowship]);
  set(c.tan, [ChatMessageType.OutgoingTell, ChatMessageType.SocialSend]);
  set(c.pink, [ChatMessageType.Channel, ChatMessageType.ChannelSend]);
  set(c.orange, [ChatMessageType.Allegiance, 0x21]);
  set(c.blueGrey, [ChatMessageType.X1B, ChatMessageType.X1C, ChatMessageType.X1D, ChatMessageType.X1E, 0x20, ChatMessageType.Abuse]);
  set(c.darkRed, [ChatMessageType.Help, ChatMessageType.Combat, ChatMessageType.CombatEnemy]);
  set(c.lightRed, [ChatMessageType.CombatSelf]);
  set(c.lightBlue, [ChatMessageType.Magic, ChatMessageType.Spellcasting]);
  set(c.cyan, [ChatMessageType.Advancement]);
  set(c.brightPurple, [ChatMessageType.System]);
  set(c.brightRed, [0x1a]);
  return table;
}

const RETAIL_CHAT_COLOR_TABLE = buildRetailChatColorTable();

/**
 * ACE's GameEventTell carries a ChatMessageType field that the sender may
 * leave at 0 for a plain tell (ACE itself always passes ChatMessageType.Tell —
 * GameActionTell.cs:52, GameActionTalkDirect.cs:46, EmoteManager.cs:1376);
 * onTell (main.ts) uses this to fall back to Tell for the colour/routing when
 * a server sends 0. Not used for GameMessageSystemChat: retail indexes the
 * colour table by the type as sent, so a Broadcast (0) is simply green
 * (CORE.17.s) — there is no 0 → System remap.
 */
export function resolveChatType(chatType: number, fallback: ChatMessageType): ChatMessageType | number {
  return chatType > 0 ? chatType : fallback;
}

/**
 * Default chat text colour for a text type, as the retail EoL client draws
 * it (CSS hex). Types beyond the 34-entry table get the UIElement_Text
 * default (white).
 */
export function chatColorFor(type: ChatMessageType | number): string {
  return RETAIL_CHAT_COLOR_TABLE[type] ?? RETAIL_CHAT_COLORS.white;
}

/**
 * SquelchMask — per-channel squelch bitmask sent in GameEventSetSquelchDB's
 * SquelchInfo.Filters and consumed server-side by SquelchDB.Contains() /
 * SquelchManager.SquelchCharacter/HandleActionModifyGlobalSquelch (/filter).
 *
 * Reference: reference/ACE/Source/ACE.Entity/Enum/SquelchMask.cs — a
 * `[Flags]` enum where each legal-squelch ChatMessageType gets bit
 * `1 << type` (e.g. Tell=0x03 -> 0x8); AllChannels is the distinct
 * all-bits-set sentinel, not `1 << ChatMessageType.AllChannels`.
 */
export enum SquelchMask {
  None         = 0x0,
  Speech       = 0x4,
  Tell         = 0x8,
  Combat       = 0x40,
  Magic        = 0x80,
  Emote        = 0x1000,
  Appraisal    = 0x10000,
  Spellcasting = 0x20000,
  Allegiance   = 0x40000,
  Fellowship   = 0x80000,
  CombatEnemy  = 0x200000,
  CombatSelf   = 0x400000,
  Recall       = 0x800000,
  Craft        = 0x1000000,
  Salvaging    = 0x2000000,
  AllChannels  = 0xFFFFFFFF,
}

/**
 * Maps a ChatMessageType to its SquelchMask bit, per ACE's
 * `ChatMessageTypeExtensions.ToMask()` (ChatMessageType.cs:283-289):
 * AllChannels -> the all-bits sentinel, everything else -> `1 << type`.
 */
export function squelchMaskForChatType(type: ChatMessageType | number): number {
  if (type === ChatMessageType.AllChannels) return SquelchMask.AllChannels;
  return (1 << type) >>> 0;
}
