/**
 * SWEEP.7 — AllegianceInfoResponse target/patron/vassal resolution.
 *
 * Ground truth: reference/ACE/Source/ACE.Server/Network/Structure/
 * AllegianceHierarchy.cs Write(). records[0] is always the allegiance
 * monarch's AllegianceData (no treeParent). If the queried player isn't the
 * monarch: a "self" record is appended with treeParent = the player's own
 * patron's characterID, and — only if that patron ISN'T the monarch — a
 * separate patron record is appended too (its own treeParent points further
 * up the tree, not useful for lookup). Vassal records (if any) always carry
 * treeParent = the queried player's own characterID.
 *
 * resolveAllegianceInfoQuery must reconstruct (target, patron, vassals) from
 * this flat records[] + the playerGuid that was queried, matching what
 * ClientAllegianceSystem::Handle_Allegiance__AllegianceInfoResponseEvent
 * (reference/client-eol/decomp/acclient-decompiled.c @ 0056a1d0) displays.
 */
import { describe, it, expect } from 'vitest';
import { resolveAllegianceInfoQuery, isAllegianceRecordOnline } from '../packages/shared/src/systems/AllegianceInfoQuery.js';

const LOGGED_IN = 0x1;

function rec(characterID: number, name: string, opts: { treeParent?: number; online?: boolean } = {}) {
  return {
    characterID,
    name,
    bitfield: opts.online ? LOGGED_IN : 0,
    ...(opts.treeParent !== undefined ? { treeParent: opts.treeParent } : {}),
  };
}

describe('SWEEP.7 — resolveAllegianceInfoQuery mirrors AllegianceHierarchy.cs record layout', () => {
  it('queried player IS the monarch: target is records[0], no patron, vassals gathered by treeParent === monarch guid', () => {
    const monarch = rec(1, 'Monarch', { online: true });
    const vassal1 = rec(2, 'VassalA', { treeParent: 1, online: false });
    const vassal2 = rec(3, 'VassalB', { treeParent: 1, online: true });
    const records = [monarch, vassal1, vassal2];

    const { target, patron, vassals } = resolveAllegianceInfoQuery(records, 1);
    expect(target).toBe(monarch);
    expect(patron).toBeUndefined();
    expect(vassals).toEqual([vassal1, vassal2]);
  });

  it('queried player is a direct vassal of the monarch (patron IS the monarch): patron resolves to records[0]', () => {
    const monarch = rec(1, 'Monarch', { online: true });
    const self = rec(2, 'Self', { treeParent: 1, online: true });
    const records = [monarch, self];

    const { target, patron, vassals } = resolveAllegianceInfoQuery(records, 2);
    expect(target).toBe(self);
    expect(patron).toBe(monarch);
    expect(vassals).toEqual([]);
  });

  it('queried player is deeper in the tree (patron is NOT the monarch): explicit patron record resolves via target.treeParent', () => {
    const monarch = rec(1, 'Monarch', { online: false });
    const patronRec = rec(2, 'Patron', { treeParent: 1, online: true });
    const self = rec(3, 'Self', { treeParent: 2, online: false });
    const vassal = rec(4, 'Vassal', { treeParent: 3, online: true });
    const records = [monarch, patronRec, self, vassal];

    const { target, patron, vassals } = resolveAllegianceInfoQuery(records, 3);
    expect(target).toBe(self);
    expect(patron).toBe(patronRec);
    expect(vassals).toEqual([vassal]);
  });

  it('queried playerGuid not present in records (parse gap) resolves to all-undefined/empty rather than throwing', () => {
    const records = [rec(1, 'Monarch', { online: true })];
    const { target, patron, vassals } = resolveAllegianceInfoQuery(records, 999);
    expect(target).toBeUndefined();
    expect(patron).toBeUndefined();
    expect(vassals).toEqual([]);
  });

  it('isAllegianceRecordOnline reads the AllegianceIndex.LoggedIn bit (0x1), ignoring other bitfield flags', () => {
    expect(isAllegianceRecordOnline(rec(1, 'A', { online: true }))).toBe(true);
    expect(isAllegianceRecordOnline(rec(1, 'A', { online: false }))).toBe(false);
    // HasAllegianceAge (0x4) set but LoggedIn (0x1) clear must still read offline.
    expect(isAllegianceRecordOnline({ characterID: 1, name: 'A', bitfield: 0x4 })).toBe(false);
    // Both LoggedIn and other flags set must still read online.
    expect(isAllegianceRecordOnline({ characterID: 1, name: 'A', bitfield: 0x1 | 0x8 })).toBe(true);
  });
});
