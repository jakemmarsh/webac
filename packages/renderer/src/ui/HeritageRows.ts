/**
 * The character-creation heritage page's rows (layout 0x21000046): DAT row
 * order, each row's element, its label string and its portrait.
 *
 * A row whose label string is EMPTY in the loaded language DAT is not listed.
 * The classic servers' DATs (ClassicACE Infiltration and CustomDM) blank the
 * ten heritages their era doesn't have, keeping Aluvian, Gharu'ndim and Sho;
 * every end-of-retail label is non-empty, so end of retail lists all
 * thirteen. Jake, 2026-10-06: hide the blank rows rather than draw ten
 * nameless radio buttons. A label that is MISSING (null) still shows its
 * English fallback, as before.
 */
export interface HeritageRow {
  key: number;
  /** The row's element in page layout 0x21000046 (instances of radio-row template 0x2100004c:0x100002db). */
  elementId: number;
  labelId: number;
  fallback: string;
  portrait: number;
}

export const HERITAGE_ROWS: readonly HeritageRow[] = Object.freeze([
  { key: 1, elementId: 0x100003bf, labelId: 210457774, fallback: 'Aluvian', portrait: 0x06004d27 },
  { key: 2, elementId: 0x100003c1, labelId: 127652165, fallback: "Gharu'ndim", portrait: 0x06004d28 },
  { key: 3, elementId: 0x100003c2, labelId: 127640927, fallback: 'Sho', portrait: 0x06004d29 },
  { key: 4, elementId: 0x100003c3, labelId: 4308980, fallback: 'Viamontian', portrait: 0x06004d2a },
  { key: 5, elementId: 0x10000590, labelId: 173343959, fallback: 'Umbraen', portrait: 0x06006c19 },
  { key: 10, elementId: 0x10000591, labelId: 58926750, fallback: 'Penumbraen', portrait: 0x06006e36 },
  { key: 6, elementId: 0x100005a9, labelId: 45739268, fallback: 'Gear Knight', portrait: 0x06006d62 },
  { key: 11, elementId: 0x100005bf, labelId: 177197764, fallback: 'Undead', portrait: 0x06006e0c },
  { key: 9, elementId: 0x100005c4, labelId: 253310718, fallback: 'Empyrean', portrait: 0x06006e37 },
  { key: 7, elementId: 0x100005e8, labelId: 35555867, fallback: 'Aun Tumerok', portrait: 0x060070c1 },
  { key: 8, elementId: 0x100005f1, labelId: 250652366, fallback: 'Lugian', portrait: 0x06007275 },
  { key: 12, elementId: 0x100005c7, labelId: 245946601, fallback: 'Olthoi Soldier', portrait: 0x06006e8a },
  { key: 13, elementId: 0x100005c8, labelId: 149147940, fallback: 'Olthoi Spitter', portrait: 0x06006e8b },
]);

/**
 * The rows the heritage page lists, each with the label it shows, in DAT
 * order. `defined`: whether this world/era has the heritage at all
 * (GameUI.chargenHeritageDefined: the world CharGen ∩ EraProfile.heritages);
 * absent = all.
 */
export function visibleHeritageRows(getString: (id: number) => string | null, defined?: (heritage: number) => boolean): Array<HeritageRow & { label: string }> {
  const out: Array<HeritageRow & { label: string }> = [];
  for (const row of HERITAGE_ROWS) {
    if (defined && !defined(row.key)) continue;
    const text = getString(row.labelId);
    if (text === '') continue;
    out.push({ ...row, label: text ?? row.fallback });
  }
  return out;
}

/** Whether the heritage page lists `heritage` (unknown heritages are not hidden unless `defined` says so). */
export function heritageListed(heritage: number, getString: (id: number) => string | null, defined?: (heritage: number) => boolean): boolean {
  if (defined && !defined(heritage)) return false;
  const row = HERITAGE_ROWS.find((r) => r.key === heritage);
  return !row || getString(row.labelId) !== '';
}
