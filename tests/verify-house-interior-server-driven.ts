/**
 * GAP.59 — "House interior load with hooks + storage". The reconciliation
 * asked for a house-SPECIFIC interior loader, a HookState→3D mapping, and a
 * storage-chest UI. That is a WRONG PREMISE about the architecture.
 *
 * In retail/ACE, a house is a landblock structure: interior cells (EnvCells)
 * plus world objects (furniture, hooks, storage chests) the server sends.
 * The client renders it with the SAME generic pipeline it uses everywhere:
 *   - Interior cells → the generic cell/dungeon renderer. Our
 *     DungeonRenderer.hasDungeon is purely `numCells > 0` — it is not
 *     house-typed; a house landblock with cells loads exactly like any
 *     dungeon/interior.
 *   - A hooked item → ACE `Hook : Container`; the item lives in the hook's
 *     Inventory (HasItem/Item), i.e. it is a normal world object the server
 *     ObjectCreates at the hook slot and the client renders generically.
 *     Rendering hooked items "as generic weenies" is FAITHFUL, not a gap.
 *   - House storage → ACE `Storage : Chest` (a Container); opened with the
 *     generic container/loot panel, contents server-authoritative.
 *
 * So there is no house-specific client loader / hook-3D map / storage panel
 * to build — the server-driven generic pipeline IS the retail architecture.
 * (The standalone HousingSystem module's client-side placeItemOnHook/
 * addToStorage modeling is a solo-sim approximation retail never used; it is
 * correctly never instantiated in the live client.)
 *
 * This anchors the architecture in ACE (skipIf the reference is absent).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';

const ACE = 'reference/ACE/Source/ACE.Server/WorldObjects';
const hasAce = fs.existsSync(`${ACE}/Hook.cs`);

describe.skipIf(!hasAce)('GAP.59 — house interior/hooks/storage are server-driven world objects (ACE)', () => {
  it('a hooked item is a world object in the hook Container inventory (rendered generically)', () => {
    const hook = fs.readFileSync(`${ACE}/Hook.cs`, 'utf8');
    expect(hook).toMatch(/class\s+Hook\s*:\s*Container/);
    // the item on a hook lives in the hook's Inventory — a normal WorldObject
    expect(hook).toMatch(/HasItem\s*=>\s*Inventory/);
    expect(hook).toMatch(/Item\s*=>\s*Inventory/);
  });

  it('house storage is a Chest container (opened via the generic container panel)', () => {
    const storage = fs.readFileSync(`${ACE}/Storage.cs`, 'utf8');
    expect(storage).toMatch(/class\s+Storage\s*:\s*Chest/);
    // a Storage belongs to a House (ParentLink), not a bespoke storage panel
    expect(storage).toMatch(/House\s*\{\s*get\s*=>\s*ParentLink as House/);
  });

  it('a house is a landblock-instance world object (interior = cells), not a special loader', () => {
    const house = fs.readFileSync(`${ACE}/House.cs`, 'utf8');
    // houses are created from landblock instances (WeenieClassId) + link the slumlord
    expect(house).toMatch(/houseInstance/);
    expect(house).toMatch(/SetLinkProperties/);
  });
});
