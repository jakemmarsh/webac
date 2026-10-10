/**
 * AllegianceInfoQuery — resolves the (target, patron, vassals) triple the
 * retail client displays in response to GameEventAllegianceInfoResponse
 * (the `/allegiance info <name>` reply), per two authoritative sources:
 *
 *   Server record layout — reference/ACE/Source/ACE.Server/Network/Structure/
 *   AllegianceHierarchy.cs Write(): records[0] is always the allegiance
 *   MONARCH's AllegianceData (no treeParent). If the queried player isn't
 *   the monarch, two more groups are appended: a "self" record (treeParent
 *   = the player's own patron's characterID) and, if that patron isn't the
 *   monarch itself, a separate patron record (treeParent = the grand-monarch's
 *   characterID -- NOT useful for lookup, only self's treeParent is). Vassal
 *   records (if any) always carry treeParent = the queried player's own
 *   characterID.
 *
 *   Retail display logic — decompiled reference/client-eol/decomp/
 *   acclient-decompiled.c, ClientAllegianceSystem::
 *   Handle_Allegiance__AllegianceInfoResponseEvent @ 0056a1d0: looks up the
 *   queried player's own AllegianceData, then AllegianceProfile::GetPatron,
 *   then walks AllegianceProfile::GetFirstVassal/GetNextVassal -- i.e. only
 *   the queried player's immediate family (self + patron + direct vassals),
 *   not the whole allegiance tree.
 *
 * Because treeParent is only meaningful relative to each record's *own*
 * position (never a raw "my patron's guid" pointer except for the self
 * record), the correct general-purpose lookup is: find the record whose
 * characterID equals the queried playerGuid (that's target -- whether it's
 * records[0] when the player queried is the monarch, or an explicit self
 * record otherwise); the record whose characterID equals target.treeParent
 * is the patron (this resolves correctly to records[0] when the patron
 * *is* the monarch, since records[0].characterID is the monarch's own
 * characterID and no separate patron record was written in that case); and
 * every record whose treeParent equals target.characterID is a vassal.
 */

export interface AllegianceInfoRecord {
  treeParent?: number;
  characterID: number;
  bitfield: number;
  name: string;
}

export interface AllegianceInfoQueryResult<T extends AllegianceInfoRecord> {
  target: T | undefined;
  patron: T | undefined;
  vassals: T[];
}

/** AllegianceIndex.LoggedIn bit — reference/ACE/Source/ACE.Entity/Enum/Network/AllegianceIndex.cs. */
const LOGGED_IN_BIT = 0x1;

export function isAllegianceRecordOnline(record: AllegianceInfoRecord): boolean {
  return (record.bitfield & LOGGED_IN_BIT) !== 0;
}

export function resolveAllegianceInfoQuery<T extends AllegianceInfoRecord>(
  records: T[],
  playerGuid: number,
): AllegianceInfoQueryResult<T> {
  const target = records.find((r) => r.characterID === playerGuid);
  const patron = target?.treeParent !== undefined
    ? records.find((r) => r.characterID === target.treeParent)
    : undefined;
  const vassals = target ? records.filter((r) => r.treeParent === target.characterID) : [];
  return { target, patron, vassals };
}

/** Flat AllegianceUpdate member record shape (MessageSerializer.ts AllegianceMember). */
export interface AllegianceMemberRecord {
  guid: number;
  parentGuid: number;
}

/**
 * Derive the PATRON-section record GameUI's Allegiance-tab render expects
 * from AllegianceUpdate's flat `members` list, mirroring
 * resolveAllegianceInfoQuery's target->treeParent lookup: find the local
 * player's own record by guid, then the record whose guid equals its
 * parentGuid. Returns undefined when the local player isn't in the list, has
 * no patron, or the resolved parent IS the monarch (parentGuid === 0) --
 * AllegianceHierarchy.cs:104/122 never writes a separate patron record when
 * the patron is the monarch, and the MONARCH section already renders that
 * same record, so surfacing it again as PATRON would be a duplicate row.
 */
export function resolveAllegiancePatron<T extends AllegianceMemberRecord>(
  members: T[],
  selfGuid: number,
): T | undefined {
  const self = members.find((m) => m.guid === selfGuid);
  if (!self) return undefined;
  const patron = members.find((m) => m.guid === self.parentGuid);
  return patron && patron.parentGuid !== 0 ? patron : undefined;
}

/** The fields AllegianceData::GetFullName reads. */
export interface AllegianceNameRecord extends AllegianceInfoRecord {
  rank?: number;
  heritageGroup?: number;
  gender?: number;
}

/**
 * AllegianceData::GetFullName @ 005b6950 — the rank title, a space and the
 * name when AllegianceSystem::GetTitle has one; the bare name otherwise.
 */
export function allegianceFullName(r: AllegianceNameRecord, titleOf: (heritage: number, gender: number, rank: number) => string): string {
  const title = titleOf(r.heritageGroup ?? 0, r.gender ?? 0, r.rank ?? 0);
  return title ? `${title} ${r.name}` : r.name;
}

/**
 * SWEEP1006 allegiance info — ClientAllegianceSystem::
 * Handle_Allegiance__AllegianceInfoResponseEvent @ 0056a1d0: nothing when the
 * profile has no record for the queried character (GetData fails);
 * otherwise, as chat type 0, the note, "Allegiance information for %hs%s:",
 * "   Patron: %hs%s" when there is a patron, then "   Vassals: " and one
 * "      %hs%s" per vassal when there are any. %s is " *" for a character
 * logged in. Literals: acclient.exe .rdata (UTF-16) 0x3cef30 / 0x3ceee0 /
 * 0x3ceeb8 / 0x3cee8c, marker 0x3cef28.
 */
export function allegianceInfoLines<T extends AllegianceNameRecord>(
  records: T[] | undefined, playerGuid: number,
  titleOf: (heritage: number, gender: number, rank: number) => string,
): string[] {
  if (!records || records.length === 0) return [];
  const { target, patron, vassals } = resolveAllegianceInfoQuery(records, playerGuid);
  if (!target) return [];
  const mark = (r: T) => (isAllegianceRecordOnline(r) ? ' *' : '');
  const lines = [
    'Note: An asterisk (*) indicates that the character is currently online.',
    `Allegiance information for ${allegianceFullName(target, titleOf)}${mark(target)}:`,
  ];
  if (patron) lines.push(`   Patron: ${allegianceFullName(patron, titleOf)}${mark(patron)}`);
  if (vassals.length > 0) {
    lines.push('   Vassals: ');
    for (const v of vassals) lines.push(`      ${allegianceFullName(v, titleOf)}${mark(v)}`);
  }
  return lines;
}
