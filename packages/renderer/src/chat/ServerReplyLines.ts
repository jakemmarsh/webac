/**
 * SWEEP1006 reply lines — retail's text for three server replies (all chat
 * type 0, AddTextToScroll(…, 0, …)); literals read from acclient.exe .rdata.
 */

/**
 * ClientCommunicationSystem::Handle_Character__QueryAgeResponse @ 005711d0:
 * 'You have played for %s.' with no name, else '%s has played for %s.'.
 */
export function queryAgeLine(targetName: string | undefined, age: string): string {
  const name = targetName?.trim() ?? '';
  return name ? `${name} has played for ${age}.` : `You have played for ${age}.`;
}

/** Handle_House__Recv_AvailableHouses @ 00585d50's type words (1–4; any other type: empty). */
export function availableHouseTypeWord(houseType: number): string {
  switch (houseType) {
    case 1: return 'cottages';
    case 2: return 'villas';
    case 3: return 'mansions';
    case 4: return 'apartments';
    default: return '';
  }
}

/** Retail's cap on the locations it lists (the overflow note's 400). */
export const AVAILABLE_HOUSES_LISTED = 400;

/**
 * ClientHousingSystem::DisplayListOfCoords @ 00585c20 for one location: the
 * cell's landcell coordinates (LandDefs::gid_to_lcoord @ 00497a90) as
 * "     %.1f%s, %.1f%s" — |(y − 1024)·0.1 + 0.5| N/S, then x E/W.
 * Null for a cell gid_to_lcoord rejects (not an outdoor cell).
 */
export function houseCoordLine(cellId: number): string | null {
  const cell = cellId & 0xffff;
  if (cell === 0 || cell >= 0x100) return null;
  const lx = ((cellId >>> 21) & 0x7f8) + ((cell - 1) >> 3);
  const ly = (((cellId >>> 16) & 0xff) << 3) + ((cell - 1) & 7);
  if (lx < 0 || ly < 0 || lx >= 0x7f8 || ly >= 0x7f8) return null;
  const ns = ly < 0x400 ? 'S' : 'N';
  const ew = lx < 0x400 ? 'W' : 'E';
  const fmt = (v: number) => Math.abs(v * 0.1 + 0.5).toFixed(1);
  return `     ${fmt(ly - 0x400)}${ns}, ${fmt(lx - 0x400)}${ew}`;
}

/**
 * Handle_House__Recv_AvailableHouses @ 00585d50: 'There are %d %s
 * available.', each location (DisplayListOfCoords), then — total over 400 —
 * the overflow note.
 */
export function availableHousesLines(houseType: number, locations: readonly number[], totalAvailable: number): string[] {
  const lines = [`There are ${totalAvailable} ${availableHouseTypeWord(houseType)} available.`];
  for (const loc of locations) {
    const l = houseCoordLine(loc);
    if (l) lines.push(l);
  }
  if (totalAvailable > AVAILABLE_HOUSES_LISTED) {
    lines.push('There were too many houses to display all the locations. Only the first 400 locations are displayed here.');
  }
  return lines;
}
