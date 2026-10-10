/**
 * SWEEP1006 tier 3 — retail's reply text (acclient.exe .rdata literals):
 *  - /allegiance info: Handle_Allegiance__AllegianceInfoResponseEvent @ 0056a1d0
 *  - /age: Handle_Character__QueryAgeResponse @ 005711d0
 *  - available houses: Handle_House__Recv_AvailableHouses @ 00585d50 +
 *    DisplayListOfCoords @ 00585c20 (LandDefs::gid_to_lcoord @ 00497a90)
 *  (no /querymana: the retail command table in verify-retail-command-table.ts
 *  pins the exact registered names, and it is not one.)
 */
import { describe, it, expect } from 'vitest';
import { allegianceInfoLines, getAllegianceRankTitle } from '@ac/shared';
import { queryAgeLine, availableHousesLines, houseCoordLine } from '../packages/renderer/src/chat/ServerReplyLines.js';

describe('allegiance info', () => {
  const rec = (id: number, name: string, parent: number | undefined, online: boolean, rank = 0) =>
    ({ characterID: id, name, treeParent: parent, bitfield: online ? 1 : 0, rank, heritageGroup: 1, gender: 1 });
  it('the note, the target, its patron and its vassals with " *" online markers and rank titles', () => {
    const records = [rec(1, 'Alice', undefined, true, 2), rec(2, 'Bob', 1, false), rec(3, 'Cid', 2, true), rec(4, 'Dee', 2, false)];
    expect(allegianceInfoLines(records, 2, getAllegianceRankTitle)).toEqual([
      'Note: An asterisk (*) indicates that the character is currently online.',
      'Allegiance information for Bob:',
      `   Patron: ${getAllegianceRankTitle(1, 1, 2)} Alice *`,
      '   Vassals: ',
      '      Cid *',
      '      Dee',
    ]);
  });
  it('nothing when the queried character has no record (GetData fails)', () => {
    expect(allegianceInfoLines([rec(1, 'Alice', undefined, true)], 99, getAllegianceRankTitle)).toEqual([]);
    expect(allegianceInfoLines(undefined, 1, getAllegianceRankTitle)).toEqual([]);
  });
});

describe('/age', () => {
  it("'You have played for %s.' / '%s has played for %s.'", () => {
    expect(queryAgeLine('', '3d 4h 12m')).toBe('You have played for 3d 4h 12m.');
    expect(queryAgeLine('Bob', '1mo 2d')).toBe('Bob has played for 1mo 2d.');
  });
});

describe('available houses', () => {
  it('the count line, one coordinate line per location, no "(N shown)"', () => {
    // Holtburg landblock 0xA9B4, cell 0x0019 → lcoord x = 0xA9*8 + 3, y = 0xB4*8 + 0.
    const lines = availableHousesLines(1, [0xA9B40019], 12);
    expect(lines[0]).toBe('There are 12 cottages available.');
    const x = 0xa9 * 8 + ((0x19 - 1) >> 3), y = 0xb4 * 8 + ((0x19 - 1) & 7);
    expect(lines[1]).toBe(`     ${Math.abs((y - 1024) * 0.1 + 0.5).toFixed(1)}N, ${Math.abs((x - 1024) * 0.1 + 0.5).toFixed(1)}E`);
    expect(lines).toHaveLength(2);
  });
  it('the overflow note past 400; an interior cell is skipped', () => {
    const lines = availableHousesLines(3, [0x01d90108], 401);
    expect(lines[0]).toBe('There are 401 mansions available.');
    expect(lines.at(-1)).toBe('There were too many houses to display all the locations. Only the first 400 locations are displayed here.');
    expect(houseCoordLine(0x01d90108)).toBeNull();
  });
});
