/**
 * LinkStatusPanelText — builds the text body of the retail "Link Status"
 * panel (gmLinkStatusUI, element class 0x1000001d, LayoutDesc 0x2100001d: a
 * 300x362 window whose body is the single text element 0x10000169).
 *
 * Faithful port of the decompiled retail client (reference/client-eol,
 * build ac1_sep13), gmLinkStatusUI::Update @ 004aaea0 — five StringInfos
 * from string table 0x10000001 (= StringTable 0x23000001), in order:
 *
 *   ID_LinkStatus_Info
 *   ID_LinkStatus_Colors
 *   ID_LinkStatus_Disconnect
 *   ID_LinkStatus_PacketLoss   %PACKET_LOSS% = LinkStatusHolder::
 *                              GetPacketLossPercentage, AddVariable_Float
 *                              precision 2 (`push 0x2` @ 004aaf8d)
 *   ID_LinkStatus_Ping         %PING% = m_pingRoundTripTime × 1000.0
 *                              (0x408f400000000000), precision 0
 *                              (`push 0x0` @ 004aaffd); the literal "????"
 *                              while the round trip is <= 0 (it starts at
 *                              -1.0, 0xbff00000, until a ping returns).
 *
 * The ids are the retail `compute_str_hash` of each token. The literals
 * below are the verbatim DAT fragments, used only as fallbacks when the
 * string tables aren't loaded (the DAT wins whenever it is available).
 */

import { acStringHash, getStringPartsFromTable } from '@ac/dat-parser/file-types/LayoutDesc.js';

/** StringInfo table enum 0x10000001 → client_local_English StringTable 0x23000001. */
export const LINK_STATUS_STRING_TABLE = 0x23000001;

/** StringTable 0x23000001 entry ids (compute_str_hash of the ID_* tokens). */
export const LINK_STATUS_STRING_IDS = {
  /** "Link Status" — window title (layout 0x2100001d title element 0x100000fe p23). */
  title: 187694290,
  info: acStringHash('ID_LinkStatus_Info'),
  colors: acStringHash('ID_LinkStatus_Colors'),
  disconnect: acStringHash('ID_LinkStatus_Disconnect'),
  packetLoss: acStringHash('ID_LinkStatus_PacketLoss'),
  ping: acStringHash('ID_LinkStatus_Ping'),
} as const;

/** Verbatim DAT fragments (escapes already undone) — fallback only. */
const FALLBACK_PARTS: Record<number, string[]> = {
  [LINK_STATUS_STRING_IDS.title]: ['Link Status'],
  [LINK_STATUS_STRING_IDS.info]: [
    'The Link Indicator shows the current status of your connection to the game servers.',
  ],
  [LINK_STATUS_STRING_IDS.colors]: [
    '\n\nGREEN = your link is good.\nYELLOW = no packets for at least 5 sec.\nRED = no packets for at least 20 sec.',
  ],
  [LINK_STATUS_STRING_IDS.disconnect]: [
    '\n\nIf approximately forty seconds pass without receiving a packet, you will be disconnected from the server.',
  ],
  [LINK_STATUS_STRING_IDS.packetLoss]: ['\n\n\nPacket loss for the last 10 sec: ', '%'],
  [LINK_STATUS_STRING_IDS.ping]: [
    '\n\nRoundtrip Ping time to Server: ',
    ' ms\n(Includes Internet latency)',
  ],
};

/** Shown for %PING% until a ping round trip has been measured. */
export const LINK_STATUS_PING_UNKNOWN = '????';

export interface LinkStatusPanelSource {
  /** LinkStatusHolder::GetPacketLossPercentage (the retail doubled ratio). */
  packetLoss: number;
  /** gmLinkStatusUI::m_pingRoundTripTime in SECONDS; <= 0 = not yet measured. */
  pingRoundTripSeconds: number;
}

function parts(id: number): string[] {
  return getStringPartsFromTable(LINK_STATUS_STRING_TABLE, id) ?? FALLBACK_PARTS[id];
}

/** Fragments with the variable in the slot between them (StringInfo::GetString). */
function fill(fragments: string[], variable: string): string {
  if (fragments.length <= 1) return fragments.join('');
  return fragments.join(variable);
}

/** The window title string (DAT "Link Status"). */
export function linkStatusPanelTitle(): string {
  return fill(parts(LINK_STATUS_STRING_IDS.title), '');
}

/**
 * StringInfoDataHelper::NumToString @ 0042f280 for a non-negative double:
 * digits are extracted by repeated `_ftol2` (truncation) down to 10^-precision,
 * the integer part grouped by 3 with ',' and the fraction after '.' (the
 * English LanguageInfo 0x41000000), with a leading zero below 1.
 */
export function formatStringInfoFloat(value: number, precision: number): string {
  const v = Math.abs(value);
  const scale = 10 ** precision;
  // A hair of slack so e.g. 0.29 × 100 = 28.999… still truncates to 29.
  const scaled = Math.trunc(v * scale + 1e-7);
  const intPart = Math.trunc(scaled / scale);
  const grouped = intPart.toString(10).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = value < 0 && scaled > 0 ? '-' : '';
  if (precision <= 0) return sign + grouped;
  const frac = (scaled - intPart * scale).toString(10).padStart(precision, '0');
  return `${sign}${grouped}.${frac}`;
}

/** Build the panel body text exactly as gmLinkStatusUI::Update assembles it. */
export function buildLinkStatusPanelText(s: LinkStatusPanelSource): string {
  const ping = s.pingRoundTripSeconds <= 0
    ? LINK_STATUS_PING_UNKNOWN
    : formatStringInfoFloat(s.pingRoundTripSeconds * 1000, 0);
  return (
    fill(parts(LINK_STATUS_STRING_IDS.info), '') +
    fill(parts(LINK_STATUS_STRING_IDS.colors), '') +
    fill(parts(LINK_STATUS_STRING_IDS.disconnect), '') +
    fill(parts(LINK_STATUS_STRING_IDS.packetLoss), formatStringInfoFloat(s.packetLoss, 2)) +
    fill(parts(LINK_STATUS_STRING_IDS.ping), ping)
  );
}
