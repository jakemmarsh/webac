import { getString, getStringFromTable } from '@ac/dat-parser/file-types/LayoutDesc.js';

/**
 * The string table the retail fellowship panel is bound to:
 * gmFellowshipUI::PostInit @ 0048fd40 sets every toggle label via
 * StringInfo::SetStringIDandTableEnum(hash, 0x10000003), and table enum
 * 0x10000003 is the English table 0x23000003. The binding matters because
 * entry ids are token hashes shared across tables with DIFFERENT text —
 * id 237541360 ("ID_PlayerOption_FellowshipShareXP") is "Share Fellowship
 * Experience and Luminance" here but the short "Share Fellowship
 * Experience" in 0x23000005, and the flat getString index is
 * last-write-wins in 0x23000005's favor.
 */
export const FELLOWSHIP_STRING_TABLE = 0x23000003;

/**
 * Resolve a fellowship-panel string id through the panel's retail table
 * binding, falling back to the flat index and then the hardcoded default.
 */
export function fellowshipString(id: number, fallback: string): string {
  return getStringFromTable(FELLOWSHIP_STRING_TABLE, id) ?? getString(id) ?? fallback;
}
