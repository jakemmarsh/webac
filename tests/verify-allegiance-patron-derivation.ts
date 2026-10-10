/**
 * BUG.allegiance-patron-section-unpopulated — derive the PATRON section's
 * record from AllegianceUpdate's flat `members` list.
 *
 * Ground truth: reference/ACE/Source/ACE.Server/Network/Structure/
 * AllegianceHierarchy.cs Write(). The monarch record always has no
 * treeParent prefix (parsed client-side as parentGuid=0). If the local
 * player isn't the monarch, a "self" record is written with treeParent =
 * the player's own patron's characterID — but a *separate* patron record is
 * only appended when that patron ISN'T the monarch itself (lines 104,122).
 * So resolving "my patron" from the flat list means: find self by guid,
 * then find the record whose guid equals self.parentGuid, and treat a
 * parentGuid===0 hit (the monarch) as "no separate patron to show" since
 * GameUI's MONARCH section already renders that identical row.
 *
 * Before this fix, GameUI.setAllegianceData() was always called with the
 * bare parsed AllegianceData (no `patron` field), so the DAT-mandated
 * PATRON section (layout 0x1000025a) never rendered for any character with
 * a patron, even though its render code was fully wired up.
 */
import { describe, it, expect } from 'vitest';
import { resolveAllegiancePatron } from '../packages/shared/src/systems/AllegianceInfoQuery.js';

function member(guid: number, parentGuid: number) {
  return { guid, parentGuid };
}

describe('BUG.allegiance-patron-section-unpopulated — resolveAllegiancePatron', () => {
  it('resolves the patron record for a player deeper than the monarch\'s direct vassal', () => {
    const monarch = member(1, 0);
    const patron = member(2, 1);
    const self = member(3, 2);
    const members = [monarch, patron, self];

    expect(resolveAllegiancePatron(members, 3)).toBe(patron);
  });

  it('returns undefined when the resolved parent IS the monarch (parentGuid === 0), avoiding a duplicate of the MONARCH row', () => {
    const monarch = member(1, 0);
    const self = member(2, 1);
    const members = [monarch, self];

    expect(resolveAllegiancePatron(members, 2)).toBeUndefined();
  });

  it('returns undefined when the queried guid is the monarch itself (no patron at all)', () => {
    const monarch = member(1, 0);
    const vassal = member(2, 1);
    const members = [monarch, vassal];

    expect(resolveAllegiancePatron(members, 1)).toBeUndefined();
  });

  it('returns undefined when the local player guid is not present in members (parse gap / stale call)', () => {
    const members = [member(1, 0), member(2, 1)];
    expect(resolveAllegiancePatron(members, 999)).toBeUndefined();
  });

  it('resolves correctly with a vassal present alongside the patron chain', () => {
    const monarch = member(1, 0);
    const patron = member(2, 1);
    const self = member(3, 2);
    const vassal = member(4, 3);
    const members = [monarch, patron, self, vassal];

    expect(resolveAllegiancePatron(members, 3)).toBe(patron);
    // The vassal's own "patron" is self, not the grand-patron.
    expect(resolveAllegiancePatron(members, 4)).toBe(self);
  });
});

/*
 * Behavioral PATRON-render coverage moved to verify-allegiance-pane-native.ts
 * (CORE.5.c.d.a): the allegiance tab is now the DAT-native pane 0x10000291,
 * which derives self/patron/vassals from the records + selfGuid directly
 * (retail AllegianceProfile::GetPatron semantics) instead of the a.patron
 * field these tests rendered through the old hand-built branch. The native
 * suite asserts the PATRON section (name + own XP passed up in the scoped
 * 0x10000490 group), the patron==monarch combined-label case, and the
 * self-is-monarch hidden case.
 */
