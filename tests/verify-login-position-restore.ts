/**
 * BUG.last-outside-death-login-snapshot-dropped — resolveLoginPositionRestore
 * must cover every PositionType the login PlayerDescription snapshot ships
 * (`reference/ACE/Source/ACE.Server/Network/GameEvent/Events/
 * GameEventPlayerDescription.cs:202-212`, per-entry PositionType numerics
 * from `ACE.Entity.Enum.Properties.PositionType.cs`), including
 * LastOutsideDeath (14) — the corpse-location entry a character who died
 * outdoors in a PRIOR session carries into this session's login snapshot.
 *
 * Pre-fix, main.ts's login-restore switch only handled LinkedLifestone (15),
 * LinkedPortalOne (8), LinkedPortalTwo (16) and LastPortal (9); a case 14
 * was silently missing (unlike the live PrivateUpdatePosition handler, which
 * already had it), so /corpse and /cor wrongly reported no recent death
 * until the player died again in the current session.
 *
 * BUG.login-position-restore-unreachable-positiontypes — that hash table is
 * built from exactly ONE entry server-side (GameEventPlayerDescription.cs
 * :202-212 hardcodes `WriteHeader(Writer, 1, 16)` around
 * `PositionType.LastOutsideDeath` only), and the sole `new
 * GameMessagePrivateUpdatePosition` call site across ACE.Server
 * (Creature_Death.cs:559) is likewise LastOutsideDeath-only — so
 * LinkedLifestone/LinkedPortalOne/LinkedPortalTwo/LastPortal are never sent
 * to a client, at login or live. Those four branches were deleted; this
 * resolver now only ever resolves LastOutsideDeath, and every other
 * PositionType (including the four just removed) must resolve to
 * `undefined`.
 */
import { describe, it, expect } from 'vitest';
import { resolveLoginPositionRestore } from '../packages/shared/src/systems/LoginPositionRestore.js';

const pos = (landblockId: number, x = 10, y = 20, z = 30) => ({ landblockId, x, y, z });

describe('BUG.last-outside-death-login-snapshot-dropped — resolveLoginPositionRestore', () => {
  it('PositionType 14 (LastOutsideDeath) resolves to a lastOutsideDeath action carrying the world coords', () => {
    const action = resolveLoginPositionRestore(14, pos(0x1234ffff), 111, 22, 333);
    expect(action).toEqual({ kind: 'lastOutsideDeath', worldX: 111, worldZ: 333 });
  });
});

describe('BUG.login-position-restore-unreachable-positiontypes — dead PositionTypes never resolve', () => {
  it('PositionType 15 (LinkedLifestone) — ACE never ships this in the login snapshot — resolves to undefined', () => {
    expect(resolveLoginPositionRestore(15, pos(0x5678ffff), 1, 2, 3)).toBeUndefined();
  });

  it('PositionType 8 (LinkedPortalOne) — ACE never ships this in the login snapshot — resolves to undefined', () => {
    expect(resolveLoginPositionRestore(8, pos(0xaaaaffff), 4, 5, 6)).toBeUndefined();
  });

  it('PositionType 16 (LinkedPortalTwo) — ACE never ships this in the login snapshot — resolves to undefined', () => {
    expect(resolveLoginPositionRestore(16, pos(0xbbbbffff), 7, 8, 9)).toBeUndefined();
  });

  it('PositionType 9 (LastPortal) — ACE never ships this in the login snapshot — resolves to undefined', () => {
    expect(resolveLoginPositionRestore(9, pos(0xccccffff), 10, 11, 12)).toBeUndefined();
  });

  it('an unrecognized PositionType (e.g. Location=1, never sent in the login snapshot) resolves to undefined rather than throwing', () => {
    expect(resolveLoginPositionRestore(1, pos(0xddddffff), 0, 0, 0)).toBeUndefined();
  });
});
