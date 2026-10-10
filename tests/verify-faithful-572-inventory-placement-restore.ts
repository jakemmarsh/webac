/**
 * FAITHFUL.572 — restore the user's saved inventory + equipment slot
 * placement from PlayerDescription's tail. ACE persists each item's
 * `PlacementPosition` (the slot index the user dragged the item to)
 * and ships the ordered guid list at login per
 * `reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventPlayerDescription.cs:401-424`:
 *
 *   if (GameplayOptions bit set):
 *     byte[] GameplayOptions  (raw PackObjPropertyCollection — NO length prefix)
 *   uint inventoryCount
 *   N × (uint guid + uint ContainerType)
 *   uint equippedCount
 *   M × (uint guid + uint CurrentWieldedLocation + uint ClothingPriority)
 *
 * Pre-FAITHFUL.572 PlayerDescriptionParser stopped at CharacterOptions2
 * and silently dropped both blocks, so the inventory grid drew items in
 * ObjectCreate arrival order. Any rearrangement the user did before
 * logout was lost — a visible UX regression vs retail AC.
 *
 * Reading the placement blocks requires walking past the GameplayOptions
 * byte[], which has no length prefix. The byte[] is the retail client's
 * serialized PackObjPropertyCollection (window placements + opacities).
 * Since CORE.3.f the walk is a real PARSE (decomp-pinned codec in
 * packages/network/src/PlayerModuleOptions.ts — version u32 + bucket-size
 * index u8 + packed count + N × BaseProperty, then align(4) past the pad
 * bytes retail PlayerModule::Pack appends) and still falls back to "skip
 * placement read" if an unrecognized OptionProperty key is encountered
 * (cannot recover the offset without knowing the entry size).
 *
 * InventoryManager honors the placement order via setPlacementOrder(guids):
 * getAll() and getByContainer() sort items by their saved index, falling
 * back to Map insertion order for items not in the saved list.
 *
 * main.ts wires desc.inventoryPlacement into InventoryManager and marks
 * the UI dirty so the next render-loop tick re-syncs with the restored
 * order.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePlayerDescription } from '../packages/renderer/src/network/PlayerDescriptionParser';
import { InventoryManager } from '@ac/shared';

const REPO = resolve(fileURLToPath(import.meta.url), '../..');
const PARSER = readFileSync(resolve(REPO, 'packages/renderer/src/network/PlayerDescriptionParser.ts'), 'utf-8');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf-8');
const INV_MGR = readFileSync(resolve(REPO, 'packages/shared/src/inventory/InventoryManager.ts'), 'utf-8');
const ACE_PD = readFileSync(resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventPlayerDescription.cs'), 'utf-8');
const ACE_OPT_FLAG = readFileSync(resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/CharacterOptionDataFlag.cs'), 'utf-8');
const ACE_CONTAINER = readFileSync(resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/ContainerType.cs'), 'utf-8');

/* ================================================================ */
/*  PlayerDescriptionResult exposes new fields                       */
/* ================================================================ */

describe('FAITHFUL.572 — PlayerDescriptionResult shape', () => {
  it('result type exposes inventoryPlacement: Array<{guid, containerType}>', () => {
    expect(PARSER).toMatch(/inventoryPlacement:\s*Array<\{\s*guid:\s*number;\s*containerType:\s*number\s*\}>/);
  });

  it('result type exposes equippedPlacement: Array<{guid, wieldedLocation, clothingPriority}>', () => {
    expect(PARSER).toMatch(/equippedPlacement:\s*Array<\{\s*guid:\s*number;\s*wieldedLocation:\s*number;\s*clothingPriority:\s*number\s*\}>/);
  });

  it('default result initializes both placements to empty arrays', () => {
    expect(PARSER).toMatch(/inventoryPlacement:\s*\[\]/);
    expect(PARSER).toMatch(/equippedPlacement:\s*\[\]/);
  });

  it('docblocks cite ACE GameEventPlayerDescription.cs:401-416 and :418-424', () => {
    expect(PARSER).toMatch(/GameEventPlayerDescription\.cs:401-416/);
    expect(PARSER).toMatch(/GameEventPlayerDescription\.cs:418-424/);
  });
});

/* ================================================================ */
/*  GameplayOptions skip + placement reads                           */
/* ================================================================ */

describe('FAITHFUL.572 — parser advances past GameplayOptions, reads placement', () => {
  it('parser defines CHAR_OPT_GAMEPLAY_OPTIONS = 0x00000200', () => {
    expect(PARSER).toMatch(/CHAR_OPT_GAMEPLAY_OPTIONS\s*=\s*0x00000200/);
  });

  it('parser reads inventoryCount + N × (guid, containerType) after GameplayOptions', () => {
    expect(PARSER).toMatch(/inventoryCount = r\.readUInt32\(\)/);
    expect(PARSER).toMatch(/result\.inventoryPlacement\.push\(\{\s*guid,\s*containerType\s*\}\)/);
  });

  it('parser reads equippedCount + M × (guid, wieldedLocation, clothingPriority)', () => {
    expect(PARSER).toMatch(/equippedCount = r\.readUInt32\(\)/);
    expect(PARSER).toMatch(/result\.equippedPlacement\.push\(\{\s*guid,\s*wieldedLocation,\s*clothingPriority\s*\}\)/);
  });

  it('parser refuses to read placement blocks when the GameplayOptions walk fails (warns instead)', () => {
    expect(PARSER).toMatch(/canReadPlacement = false|canReadPlacement\)/);
    expect(PARSER).toMatch(/unrecognized property key/);
  });
});

/* ================================================================ */
/*  The structural walk handles every OptionProperty key             */
/*  (CORE.3.f: behavioral — the old source-text pins on the          */
/*  skip-only helpers were retired when the walk moved to the        */
/*  @ac/network PlayerModuleOptions codec and became a real parse)   */
/* ================================================================ */

describe('FAITHFUL.572/CORE.3.f — structural walk covers every OptionProperty value shape', () => {
  it('a blob exercising ALL 11 option keys walks cleanly and placement still reads', () => {
    const { buf, pos, w32, w16, w8 } = buildBasePlayerDescription();
    w32(0x240);                  // optionFlags = GameplayOptions | CO2
    w32(0);                      // CO1
    w32(0);                      // single 0u
    w32(0x3FFF);                 // SpellbookFilters
    w32(0);                      // CO2
    const blobStart = pos.p;
    // PackObjPropertyCollection with the full key census:
    w32(0x02); w8(0);            // version, bucketSizeIndex
    w8(3);                       // 3 top-level entries (packed count < 0x80)
    // 0x10000080 DefaultOpacity (f32)
    w32(0x10000080); w32(0x10000080);
    new DataView(buf).setFloat32(pos.p, 0.4, true); pos.p += 4;
    // 0x10000081 ActiveOpacity (f32)
    w32(0x10000081); w32(0x10000081);
    new DataView(buf).setFloat32(pos.p, 0.85, true); pos.p += 4;
    // 0x1000008C placement array with one full struct
    w32(0x1000008C); w32(0x1000008C);
    w32(1);                      // SmartArray count (u32)
    w32(0x1000008B);             // element propertyName = placement struct
    w8(0);                       // struct bucketSizeIndex
    w8(7);                       // 7 members
    w32(0x1000007F); w32(0x1000007F); w32(0x101C); w32(0); // filter u64
    w32(0x10000086); w32(0x10000086); w32(150);  // X
    w32(0x10000087); w32(0x10000087); w32(35);   // Y
    w32(0x10000088); w32(0x10000088); w32(250);  // Width
    w32(0x10000089); w32(0x10000089); w32(104);  // Height
    w32(0x1000008A); w32(0x1000008A); w8(1);     // Visibility (bool u8)
    w32(0x1000008D); w32(0x1000008D);            // Title (StringInfo)
    w8(1); w8(2); w16(0x41); w16(0x42);          // literal 'AB' (len-prefixed)
    w8(1); w8(0); w8(0); w8(0);                  // override flag + 3 empty PStrings
    w8(0); w8(0);                                // empty StringInfoData table
    // Retail pads the 0x01A1 tail to 4 bytes; ACE stores blob+pad verbatim.
    while ((pos.p - blobStart) % 4 !== 0) w8(0);
    // Placement blocks follow.
    w32(1); w32(0xDEADBEEF); w32(0);
    w32(0);
    const result = parsePlayerDescription(new Uint8Array(buf, 0, pos.p));
    expect(result).not.toBeNull();
    expect(result!.gameplayOptions).not.toBeNull();
    expect(result!.gameplayOptions!.defaultOpacity).toBeCloseTo(0.4, 6);
    expect(result!.gameplayOptions!.activeOpacity).toBeCloseTo(0.85, 6);
    expect(result!.gameplayOptions!.chatWindows.get(1)).toEqual({
      filter: 0x101Cn, x: 150, y: 35, w: 250, h: 104, visible: true, title: 'AB',
    });
    expect(result!.inventoryPlacement).toEqual([{ guid: 0xDEADBEEF, containerType: 0 }]);
  });
});

/* ================================================================ */
/*  Synthetic-payload roundtrip                                      */
/* ================================================================ */

function buildBasePlayerDescription(): {
  buf: ArrayBuffer;
  dv: DataView;
  pos: { p: number };
  w32: (v: number) => void;
  w16: (v: number) => void;
  w8: (v: number) => void;
} {
  const buf = new ArrayBuffer(8192);
  const dv = new DataView(buf);
  const pos = { p: 0 };
  const w32 = (v: number) => { dv.setUint32(pos.p, v, true); pos.p += 4; };
  const w16 = (v: number) => { dv.setUint16(pos.p, v, true); pos.p += 2; };
  const w8 = (v: number) => { dv.setUint8(pos.p, v); pos.p += 1; };
  // Common header — no properties, no vector flags.
  w32(0); // propertyFlags
  w32(0); // weenieType
  w32(0); // vectorFlags
  w32(0); // _hasHealth (unconditional)
  return { buf, dv, pos, w32, w16, w8 };
}

describe('FAITHFUL.572 — synthetic PlayerDescription restores inventory placement', () => {
  it('reads inventory placement when GameplayOptions bit is NOT set', () => {
    const { buf, pos, w32 } = buildBasePlayerDescription();
    // optionFlags: CharacterOptions2 (0x40) only — NO GameplayOptions bit.
    w32(0x40);                   // optionFlags
    w32(0x12345678);             // CharacterOptions1 (any value)
    // No Shortcut bit, no SpellLists8 → single 0u placeholder per ACE :377
    w32(0);                      // single 0u placeholder
    // No DesiredComps. SpellbookFilters is unconditional.
    w32(0x3FFF);                 // SpellbookFilters
    w32(0x00948700);             // CharacterOptions2
    // Inventory placement: 3 items
    w32(3);                      // inventoryCount
    w32(0x50000001); w32(0);     // guid, ContainerType.NonContainer
    w32(0x50000002); w32(0);     // guid, ContainerType.NonContainer
    w32(0x50000003); w32(1);     // guid, ContainerType.Container
    // Equipped placement: 2 items
    w32(2);                      // equippedCount
    w32(0x60000001); w32(0x01); w32(0);   // guid, WieldedLocation=HeadWear, ClothingPriority=0
    w32(0x60000002); w32(0x10); w32(0);   // guid, WieldedLocation=MissileWeapon, ClothingPriority=0

    const payload = new Uint8Array(buf, 0, pos.p);
    const result = parsePlayerDescription(payload);
    expect(result).not.toBeNull();
    expect(result!.inventoryPlacement).toHaveLength(3);
    expect(result!.inventoryPlacement[0]).toEqual({ guid: 0x50000001, containerType: 0 });
    expect(result!.inventoryPlacement[1]).toEqual({ guid: 0x50000002, containerType: 0 });
    expect(result!.inventoryPlacement[2]).toEqual({ guid: 0x50000003, containerType: 1 });
    expect(result!.equippedPlacement).toHaveLength(2);
    expect(result!.equippedPlacement[0]).toEqual({ guid: 0x60000001, wieldedLocation: 0x01, clothingPriority: 0 });
    expect(result!.equippedPlacement[1]).toEqual({ guid: 0x60000002, wieldedLocation: 0x10, clothingPriority: 0 });
  });

  it('reads inventory placement past a zero-element GameplayOptions blob', () => {
    const { buf, pos, w32, w8 } = buildBasePlayerDescription();
    // optionFlags: GameplayOptions (0x200) | CharacterOptions2 (0x40)
    w32(0x240);                  // optionFlags
    w32(0);                      // CharacterOptions1
    w32(0);                      // single 0u placeholder for SpellLists8
    w32(0x3FFF);                 // SpellbookFilters
    w32(0);                      // CharacterOptions2
    // GameplayOptions PackObjPropertyCollection: empty
    w32(0x02);                   // i_iVersion (always 0x02)
    w8(0);                       // m_numBuckets
    w8(0);                       // m_numElements = 0 (no entries)
    // CORE.3.f — retail PlayerModule::Pack zero-pads the 0x01A1 tail to a
    // 4-byte boundary and ACE stores blob+pad verbatim; the parser
    // re-aligns exactly like PlayerModule::UnPack @ 005d49d0.
    w8(0); w8(0);                // pad (blob was 6 bytes)
    // Inventory placement: 1 item
    w32(1);                      // inventoryCount
    w32(0xDEADBEEF); w32(0);     // guid, ContainerType.NonContainer
    // Equipped: 0
    w32(0);                      // equippedCount

    const payload = new Uint8Array(buf, 0, pos.p);
    const result = parsePlayerDescription(payload);
    expect(result).not.toBeNull();
    expect(result!.inventoryPlacement).toHaveLength(1);
    expect(result!.inventoryPlacement[0]).toEqual({ guid: 0xDEADBEEF, containerType: 0 });
    expect(result!.equippedPlacement).toHaveLength(0);
  });

  it('reads placement past a GameplayOptions blob with one Placement_X entry', () => {
    const { buf, pos, w32, w8 } = buildBasePlayerDescription();
    w32(0x240);                  // optionFlags = GameplayOptions | CO2
    w32(0);                      // CO1
    w32(0);                      // single 0u
    w32(0x3FFF);                 // SpellbookFilters
    w32(0);                      // CO2
    // GameplayOptions PackObjPropertyCollection: 1 entry of Option_Placement_X
    w32(0x02);                   // i_iVersion
    w8(0);                       // m_numBuckets
    w8(1);                       // m_numElements = 1
    w32(0x10000086);             // key = Option_Placement_X
    w32(0x10000086);             // propertyName (BaseProperty::Serialize
                                 //   re-writes the name; aclogview had
                                 //   called this copy m_pcPropertyDesc)
    w32(150);                    // intPropertyValue
    w8(0); w8(0);                // CORE.3.f — pad to 4 (blob was 18 bytes)
    // Inventory placement: 0 items
    w32(0);                      // inventoryCount
    w32(0);                      // equippedCount

    const payload = new Uint8Array(buf, 0, pos.p);
    const result = parsePlayerDescription(payload);
    expect(result).not.toBeNull();
    // Both placements parse cleanly because the structural walk advanced
    // exactly past the one entry's 12 bytes (4 key + 4 name + 4 value) + pad.
    expect(result!.inventoryPlacement).toEqual([]);
    expect(result!.equippedPlacement).toEqual([]);
  });

  it('refuses placement read (canReadPlacement=false) when GameplayOptions has an unknown key', () => {
    const { buf, pos, w32, w8 } = buildBasePlayerDescription();
    w32(0x240);                  // optionFlags
    w32(0);                      // CO1
    w32(0);                      // single 0u
    w32(0x3FFF);                 // SpellbookFilters
    w32(0);                      // CO2
    w32(0x02);                   // i_iVersion
    w8(0);                       // numBuckets
    w8(1);                       // numElements = 1
    w32(0xDEADBEEF);             // unknown OptionProperty key
    // Inventory + equipped data follows but should not be read since skip aborted.
    w32(5);                      // would-be inventoryCount, but parser should abort and not read
    w32(0x99999999);

    const payload = new Uint8Array(buf, 0, pos.p);
    const result = parsePlayerDescription(payload);
    expect(result).not.toBeNull();
    expect(result!.inventoryPlacement).toEqual([]);
    expect(result!.equippedPlacement).toEqual([]);
  });
});

/* ================================================================ */
/*  InventoryManager.setPlacementOrder respects the saved order      */
/* ================================================================ */

describe('FAITHFUL.572 — InventoryManager.setPlacementOrder reorders getAll()', () => {
  it('exports setPlacementOrder method and an internal _placementOrder map', () => {
    expect(INV_MGR).toMatch(/setPlacementOrder\(guids:\s*number\[\]\)/);
    expect(INV_MGR).toMatch(/_placementOrder:\s*Map<number,\s*number>/);
  });

  it('getAll() respects the placement order when one is set', () => {
    const inv = new InventoryManager();
    // Add in C, A, B order — Map iteration would naturally produce that.
    const cId = inv.addItem({ weenieClassId: 1, name: 'C', value: 0, burden: 0,
                              stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0 }, 100);
    const aId = inv.addItem({ weenieClassId: 1, name: 'A', value: 0, burden: 0,
                              stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0 }, 101);
    const bId = inv.addItem({ weenieClassId: 1, name: 'B', value: 0, burden: 0,
                              stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0 }, 102);
    // Pre-placement: arrival order is C, A, B.
    const pre = inv.getAll().map(i => i.name);
    expect(pre).toEqual(['C', 'A', 'B']);
    // Apply placement order A, B, C.
    inv.setPlacementOrder([aId, bId, cId]);
    const post = inv.getAll().map(i => i.name);
    expect(post).toEqual(['A', 'B', 'C']);
  });

  it('items not in the placement list sort after the placed items', () => {
    const inv = new InventoryManager();
    const aId = inv.addItem({ weenieClassId: 1, name: 'A', value: 0, burden: 0,
                              stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0 }, 201);
    const bId = inv.addItem({ weenieClassId: 1, name: 'B', value: 0, burden: 0,
                              stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0 }, 202);
    const cId = inv.addItem({ weenieClassId: 1, name: 'C', value: 0, burden: 0,
                              stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0 }, 203);
    // Placement only mentions A — B + C arrived after the save and should
    // come after in arrival order.
    inv.setPlacementOrder([aId]);
    const names = inv.getAll().map(i => i.name);
    expect(names[0]).toEqual('A');
    expect(names.slice(1).sort()).toEqual(['B', 'C']);
    // Avoid an unused-var lint complaint.
    expect([bId, cId]).toHaveLength(2);
  });

  it('getByContainer() also respects the placement order', () => {
    const inv = new InventoryManager();
    const aId = inv.addItem({ weenieClassId: 1, name: 'A', value: 0, burden: 0,
                              stackSize: 1, maxStackSize: 1, stackable: false, containerId: 5 }, 301);
    const bId = inv.addItem({ weenieClassId: 1, name: 'B', value: 0, burden: 0,
                              stackSize: 1, maxStackSize: 1, stackable: false, containerId: 5 }, 302);
    inv.setPlacementOrder([bId, aId]);
    const names = inv.getByContainer(5).map(i => i.name);
    expect(names).toEqual(['B', 'A']);
  });
});

/* ================================================================ */
/*  main.ts wires the placement order on PlayerDescription           */
/* ================================================================ */

describe('FAITHFUL.572 — main.ts calls inventory.setPlacementOrder on login', () => {
  it('main.ts calls playerState.inventory.setPlacementOrder with desc.inventoryPlacement guids', () => {
    expect(MAIN).toMatch(/playerState\.inventory\.setPlacementOrder\([\s\S]*?desc\.inventoryPlacement\.map/);
  });

  it('main.ts marks inventoryDirty so the next render-loop tick re-syncs the panel', () => {
    expect(MAIN).toMatch(/FAITHFUL\.572[\s\S]+?inventoryDirty = true/);
  });

  it('main.ts only applies the placement order when desc.inventoryPlacement is non-empty', () => {
    expect(MAIN).toMatch(/desc\.inventoryPlacement\.length > 0/);
  });

  it('main.ts logs the restored slot count for diagnostics', () => {
    expect(MAIN).toMatch(/Restored \$\{desc\.inventoryPlacement\.length\} inventory slot placement/);
  });
});

/* ================================================================ */
/*  ACE source still anchors the fix                                  */
/* ================================================================ */

describe('FAITHFUL.572 — ACE source still anchors the wire format', () => {
  it('ACE GameEventPlayerDescription.cs still writes inventory count + (guid, ContainerType) pairs', () => {
    expect(ACE_PD).toMatch(/Writer\.Write\(\(uint\)Session\.Player\.Inventory\.Count\)/);
    expect(ACE_PD).toMatch(/Writer\.Write\(item\.Guid\.Full\)/);
    expect(ACE_PD).toMatch(/ContainerType\.NonContainer/);
    expect(ACE_PD).toMatch(/ContainerType\.Container/);
    expect(ACE_PD).toMatch(/ContainerType\.Foci/);
  });

  it('ACE GameEventPlayerDescription.cs still writes equipped count + (guid, location, priority) trios', () => {
    expect(ACE_PD).toMatch(/Writer\.Write\(\(uint\)Session\.Player\.EquippedObjects\.Values\.Count\)/);
    expect(ACE_PD).toMatch(/CurrentWieldedLocation/);
    expect(ACE_PD).toMatch(/ClothingPriority/);
  });

  it('ACE GameEventPlayerDescription.cs still writes GameplayOptions as raw byte[] (no length prefix)', () => {
    expect(ACE_PD).toMatch(/Writer\.Write\(Session\.Player\.Character\.GameplayOptions\)/);
  });

  it('ACE CharacterOptionDataFlag still has GameplayOptions = 0x200', () => {
    expect(ACE_OPT_FLAG).toMatch(/GameplayOptions\s*=\s*0x00000200/);
  });

  it('ACE ContainerType enum still has 3 values: NonContainer=0, Container=1, Foci=2', () => {
    expect(ACE_CONTAINER).toMatch(/NonContainer\s*=\s*0/);
    expect(ACE_CONTAINER).toMatch(/Container\s*=\s*1/);
    expect(ACE_CONTAINER).toMatch(/Foci\s*=\s*2/);
  });

  it('ACE Inventory ordering is by PlacementPosition', () => {
    expect(ACE_PD).toMatch(/OrderBy\(i => i\.PlacementPosition\)/);
  });
});
