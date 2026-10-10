/**
 * FAITHFUL.557 — Text for 3 more silent WeenieErrors that ACE emits
 * but our map had no entries for (continuation of .540 + .556).
 *
 *  All three are user-actionable rejections that pre-fix produced no
 *  chat output, leaving the player confused why their action failed.
 *
 *  ACE emit sites:
 *    InvalidInventoryLocation (0x03F0) — Player_Inventory.cs:1563 +
 *      :2673 (player wields/equips to a slot the item.validLocations
 *      mask does not allow).
 *    AllegianceIllegalLevel (0x0410) — Player_Allegiance.cs:346
 *      (vassal-patron level differential exceeds AC's rule of
 *      "patron must be within 5 levels of vassal").
 *    QuestSolvedTooLongAgo (0x0446) — QuestManager.cs:549 (quest
 *      cooldown not yet expired).
 */
import { describe, it, expect } from 'vitest';
import { weenieErrorText, WeenieError } from '@ac/shared';

describe('FAITHFUL.557 — text for 3 more silent WeenieErrors', () => {
  it('InvalidInventoryLocation shows the wield-slot rejection', () => {
    expect(weenieErrorText(WeenieError.InvalidInventoryLocation))
      .toBe('That is not a valid place to wear that item.');
  });

  it('AllegianceIllegalLevel shows the patron-level rejection', () => {
    expect(weenieErrorText(WeenieError.AllegianceIllegalLevel))
      .toBe('You cannot swear allegiance to a character at that level.');
  });

  it('QuestSolvedTooLongAgo shows the cooldown rejection', () => {
    expect(weenieErrorText(WeenieError.QuestSolvedTooLongAgo))
      .toBe('You have solved this quest too recently to do it again.');
  });
});
