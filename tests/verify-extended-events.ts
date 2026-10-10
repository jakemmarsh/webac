/**
 * FAITHFUL.6 — Inbound GameEvent handlers for ChannelBroadcast,
 * InventoryServerSaveFailed, FellowshipQuit, FellowshipDismiss.
 *
 * Wire formats anchored against:
 *   reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventChannelBroadcast.cs
 *   reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventInventoryServerSaveFailed.cs
 *   reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventFellowshipQuit.cs
 *   reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventFellowshipDismiss.cs
 *   reference/ACE/Source/ACE.Server/Network/Extensions.cs (WriteString16L)
 *
 * WriteString16L = uint16 length + bytes + pad to 4-byte multiple (incl. the
 * 2-byte length prefix). readString16 in @ac/network mirrors this exactly.
 */
import { describe, it, expect } from 'vitest';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { BinaryWriter, GameMessageOpcode, GameEventType } from '@ac/network';

function event(eventType: number, payload: Uint8Array) {
  return {
    type: 'event' as const,
    opcode: GameMessageOpcode.GameEvent as GameMessageOpcode.GameEvent,
    objectGuid: 0,
    sequence: 1,
    eventType,
    payload,
  };
}

function writeString16L(w: BinaryWriter, s: string): void {
  const bytes = new TextEncoder().encode(s);
  w.writeUInt16(bytes.length);
  w.writeBytes(bytes);
  // Pad to 4-byte multiple INCLUDING the 2 bytes of length prefix (ACE Extensions.cs:20)
  const totalWritten = 2 + bytes.length;
  const remainder = totalWritten % 4;
  if (remainder !== 0) {
    const padding = 4 - remainder;
    for (let i = 0; i < padding; i++) w.writeUInt8(0);
  }
}

describe('ChannelBroadcast handler', () => {
  it('parses channel + senderName + messageText', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onChannelBroadcast: (d) => { cap = d; } });

    const w = new BinaryWriter(64);
    w.writeUInt32(0x16); // Channel.Allegiance
    writeString16L(w, 'Lord Bellator');
    writeString16L(w, 'Allegiance gather at the lifestone!');
    h.handleMessage(event(GameEventType.ChannelBroadcast, w.toBuffer()));

    expect(cap.channel).toBe(0x16);
    expect(cap.senderName).toBe('Lord Bellator');
    expect(cap.message).toBe('Allegiance gather at the lifestone!');
  });

  it('handles empty senderName (self-echo case per ACE comment)', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onChannelBroadcast: (d) => { cap = d; } });

    const w = new BinaryWriter(32);
    w.writeUInt32(0x16);
    writeString16L(w, '');           // empty sender → client renders "You say..."
    writeString16L(w, 'Hello team');
    h.handleMessage(event(GameEventType.ChannelBroadcast, w.toBuffer()));

    expect(cap.senderName).toBe('');
    expect(cap.message).toBe('Hello team');
  });
});

describe('InventoryServerSaveFailed handler', () => {
  it('parses itemGuid + WeenieError', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onInventoryServerSaveFailed: (d) => { cap = d; } });

    const w = new BinaryWriter(8);
    w.writeUInt32(0x80001234);
    w.writeUInt32(0x36); // WeenieError.ActionCancelled
    h.handleMessage(event(GameEventType.InventoryServerSaveFailed, w.toBuffer()));

    expect(cap.itemGuid).toBe(0x80001234);
    expect(cap.errorType).toBe(0x36);
  });

  it('handles legacy payload with no errorType (4 bytes only)', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onInventoryServerSaveFailed: (d) => { cap = d; } });

    const w = new BinaryWriter(4);
    w.writeUInt32(0x80005678);
    h.handleMessage(event(GameEventType.InventoryServerSaveFailed, w.toBuffer()));

    expect(cap.itemGuid).toBe(0x80005678);
    expect(cap.errorType).toBe(0);
  });
});

describe('IdentifyResponse SpellBook section', () => {
  // Anchored against reference/ACE/Source/ACE.Server/Network/Structure/AppraiseInfo.cs:21
  // and PackableList.cs (uint count + N × uint). Mask 0x80000000 distinguishes
  // active enchantments from intrinsic spells.
  it('parses intrinsic spells (no EnchantmentMask)', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onIdentifyResponse: (d) => { cap = d; } });

    const w = new BinaryWriter(32);
    w.writeUInt32(0x80001234);   // guid
    w.writeUInt32(0x0010);       // flags: SpellBook only
    w.writeUInt32(1);            // success bool
    w.writeUInt32(3);            // spellCount
    w.writeUInt32(1234);
    w.writeUInt32(5678);
    w.writeUInt32(9012);
    h.handleMessage(event(GameEventType.IdentifyObjectResponse, w.toBuffer()));

    expect(cap.spellBook).toEqual([1234, 5678, 9012]);
    expect(cap.activeEnchantments).toEqual([]);
  });

  it('separates active enchantments (EnchantmentMask 0x80000000) from intrinsic spells', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onIdentifyResponse: (d) => { cap = d; } });

    const w = new BinaryWriter(32);
    w.writeUInt32(0x80001234);
    w.writeUInt32(0x0010);
    w.writeUInt32(1);
    w.writeUInt32(4);
    w.writeUInt32(100);                 // intrinsic
    w.writeUInt32(0x80000000 | 200);    // active enchantment
    w.writeUInt32(300);                 // intrinsic
    w.writeUInt32(0x80000000 | 400);    // active enchantment
    h.handleMessage(event(GameEventType.IdentifyObjectResponse, w.toBuffer()));

    expect(cap.spellBook).toEqual([100, 300]);
    expect(cap.activeEnchantments).toEqual([200, 400]);
  });
});

describe('IdentifyResponse WeaponProfile section', () => {
  // Anchored against reference/ACE/Source/ACE.Server/Network/Structure/WeaponProfile.cs:
  // DamageType u32 + WeaponTime u32 + WeaponSkill u32 + Damage u32 +
  // DamageVariance f64 + DamageMod f64 + WeaponLength f64 + MaxVelocity f64 +
  // WeaponOffense f64 + MaxVelocityEstimated u32. Total 60 bytes after the
  // 12-byte header (guid + flags + success).
  it('parses a sword weapon profile (no spells, no armor)', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onIdentifyResponse: (d) => { cap = d; } });

    const w = new BinaryWriter(80);
    w.writeUInt32(0x80009000);  // guid
    w.writeUInt32(0x0020);       // flags: WeaponProfile only
    w.writeUInt32(1);            // success
    // WeaponProfile body
    w.writeUInt32(0x0001);       // DamageType.Slash
    w.writeUInt32(30);           // WeaponTime (faster than baseline 40)
    w.writeUInt32(44);           // WeaponSkill.LightWeapons (any positive id)
    w.writeUInt32(58);           // Damage
    w.writeFloat64(0.55);        // DamageVariance
    w.writeFloat64(1.20);        // DamageMod
    w.writeFloat64(1.10);        // WeaponLength
    w.writeFloat64(0.0);         // MaxVelocity (melee)
    w.writeFloat64(1.05);        // WeaponOffense (+5% attack)
    w.writeUInt32(0);            // MaxVelocityEstimated
    h.handleMessage(event(GameEventType.IdentifyObjectResponse, w.toBuffer()));

    expect(cap.weaponProfile).toBeTruthy();
    expect(cap.weaponProfile.damageType).toBe(0x0001);
    expect(cap.weaponProfile.weaponTime).toBe(30);
    expect(cap.weaponProfile.damage).toBe(58);
    expect(cap.weaponProfile.damageVariance).toBeCloseTo(0.55, 5);
    expect(cap.weaponProfile.damageMod).toBeCloseTo(1.20, 5);
    expect(cap.weaponProfile.weaponOffense).toBeCloseTo(1.05, 5);
  });

  it('parses WeaponProfile after SpellBook (combined flag 0x0030)', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onIdentifyResponse: (d) => { cap = d; } });

    const w = new BinaryWriter(128);
    w.writeUInt32(0x80009001);
    w.writeUInt32(0x0030);       // SpellBook (0x10) + WeaponProfile (0x20)
    w.writeUInt32(1);
    // SpellBook: 2 spells, one intrinsic + one enchantment
    w.writeUInt32(2);
    w.writeUInt32(42);
    w.writeUInt32(0x80000000 | 99);
    // WeaponProfile
    w.writeUInt32(0x0002);       // Pierce
    w.writeUInt32(35);
    w.writeUInt32(45);
    w.writeUInt32(72);
    w.writeFloat64(0.40);
    w.writeFloat64(1.0);
    w.writeFloat64(1.0);
    w.writeFloat64(0.0);
    w.writeFloat64(1.0);
    w.writeUInt32(0);
    h.handleMessage(event(GameEventType.IdentifyObjectResponse, w.toBuffer()));

    expect(cap.spellBook).toEqual([42]);
    expect(cap.activeEnchantments).toEqual([99]);
    expect(cap.weaponProfile.damageType).toBe(0x0002);
    expect(cap.weaponProfile.damage).toBe(72);
  });

  it('parses ArmorProfile then WeaponProfile when both flags set', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onIdentifyResponse: (d) => { cap = d; } });

    // Special case: an item with both armor and weapon facets (rare in vanilla
    // but legal per ACE wire format). Order in the stream: ArmorProfile first.
    const w = new BinaryWriter(128);
    w.writeUInt32(0x80009003);
    w.writeUInt32(0x0080 | 0x0020); // ArmorProfile + WeaponProfile
    w.writeUInt32(1);
    // ArmorProfile (8 floats)
    [1.5, 1.4, 1.3, 1.0, 1.0, 1.0, 0.8, 1.1].forEach(v => w.writeFloat32(v));
    // WeaponProfile (60 bytes)
    w.writeUInt32(0x0001); // Slash
    w.writeUInt32(30); w.writeUInt32(44); w.writeUInt32(50);
    w.writeFloat64(0.5); w.writeFloat64(1.0); w.writeFloat64(1.0);
    w.writeFloat64(0.0); w.writeFloat64(1.0);
    w.writeUInt32(0);
    h.handleMessage(event(GameEventType.IdentifyObjectResponse, w.toBuffer()));

    expect(cap.armorProfile.slashing).toBeCloseTo(1.5, 5);
    expect(cap.armorProfile.nether).toBeCloseTo(0.8, 5);
    expect(cap.weaponProfile.damageType).toBe(0x0001);
    expect(cap.weaponProfile.damage).toBe(50);
  });
});

describe('IdentifyResponse ArmorProfile section', () => {
  // Anchored against reference/ACE/Source/ACE.Server/Network/Structure/ArmorProfile.cs.
  // 8 × float32 = 32 bytes total, ACE order: Slash, Pierce, Bludgeon, Cold, Fire, Acid, Nether, Lightning.
  it('parses an 8-float armor profile', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onIdentifyResponse: (d) => { cap = d; } });

    const w = new BinaryWriter(64);
    w.writeUInt32(0x80009100);   // guid
    w.writeUInt32(0x0080);       // flags: ArmorProfile only
    w.writeUInt32(1);            // success
    w.writeFloat32(1.5);         // slashing
    w.writeFloat32(1.4);         // piercing
    w.writeFloat32(1.3);         // bludgeoning
    w.writeFloat32(1.2);         // cold
    w.writeFloat32(1.1);         // fire
    w.writeFloat32(1.0);         // acid
    w.writeFloat32(0.9);         // nether
    w.writeFloat32(0.8);         // lightning
    h.handleMessage(event(GameEventType.IdentifyObjectResponse, w.toBuffer()));

    expect(cap.armorProfile).toBeTruthy();
    expect(cap.armorProfile.slashing).toBeCloseTo(1.5, 5);
    expect(cap.armorProfile.piercing).toBeCloseTo(1.4, 5);
    expect(cap.armorProfile.bludgeoning).toBeCloseTo(1.3, 5);
    expect(cap.armorProfile.cold).toBeCloseTo(1.2, 5);
    expect(cap.armorProfile.fire).toBeCloseTo(1.1, 5);
    expect(cap.armorProfile.acid).toBeCloseTo(1.0, 5);
    expect(cap.armorProfile.nether).toBeCloseTo(0.9, 5);
    expect(cap.armorProfile.lightning).toBeCloseTo(0.8, 5);
  });
});

describe('IdentifyResponse CreatureProfile section', () => {
  // Anchored against reference/ACE/Source/ACE.Server/Network/Structure/CreatureProfile.cs.
  // Variable length depending on profile flags. ShowAttributes (0x8) adds 10 u32s,
  // HasBuffsDebuffs (0x1) adds 2 u16s.
  it('parses health-only profile (failed assess: only health/healthMax)', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onIdentifyResponse: (d) => { cap = d; } });

    const w = new BinaryWriter(32);
    w.writeUInt32(0x80009200);
    w.writeUInt32(0x0100);       // flags: CreatureProfile only
    w.writeUInt32(1);
    w.writeUInt32(0);            // profileFlags: no ShowAttributes, no HasBuffsDebuffs
    w.writeUInt32(150);          // health
    w.writeUInt32(200);          // healthMax
    h.handleMessage(event(GameEventType.IdentifyObjectResponse, w.toBuffer()));

    expect(cap.creatureProfile.profileFlags).toBe(0);
    expect(cap.creatureProfile.health).toBe(150);
    expect(cap.creatureProfile.healthMax).toBe(200);
    expect(cap.creatureProfile.attributes).toBeUndefined();
  });

  it('parses full ShowAttributes profile (successful assess: HP + 10 attribute fields)', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onIdentifyResponse: (d) => { cap = d; } });

    const w = new BinaryWriter(64);
    w.writeUInt32(0x80009201);
    w.writeUInt32(0x0100);
    w.writeUInt32(1);
    w.writeUInt32(0x8);          // ShowAttributes
    w.writeUInt32(280); w.writeUInt32(320); // health 280/320
    // Attributes: Str, End, Quick, Coord, Focus, Self
    w.writeUInt32(140); w.writeUInt32(150); w.writeUInt32(135); w.writeUInt32(145); w.writeUInt32(100); w.writeUInt32(100);
    // Stamina, Mana, StaminaMax, ManaMax
    w.writeUInt32(180); w.writeUInt32(120); w.writeUInt32(180); w.writeUInt32(160);
    h.handleMessage(event(GameEventType.IdentifyObjectResponse, w.toBuffer()));

    expect(cap.creatureProfile.attributes).toBeTruthy();
    expect(cap.creatureProfile.attributes.strength).toBe(140);
    expect(cap.creatureProfile.attributes.endurance).toBe(150);
    expect(cap.creatureProfile.attributes.mana).toBe(120);
    expect(cap.creatureProfile.attributes.staminaMax).toBe(180);
  });
});

describe('Housing GameEvents (simple wire formats)', () => {
  it('HouseStatus: WeenieError u32', () => {
    // Per reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventHouseStatus.cs
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onHouseStatus: (d) => { cap = d; } });

    const w = new BinaryWriter(4);
    w.writeUInt32(0x047F); // YouMustOwnHouseToUseCommand
    h.handleMessage(event(GameEventType.HouseStatus, w.toBuffer()));

    expect(cap.weenieError).toBe(0x047F);
  });

  it('UpdateRentTime: rentTime u32', () => {
    // Per GameEventHouseUpdateRentTime.cs — unix timestamp.
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onHouseUpdateRentTime: (d) => { cap = d; } });

    const w = new BinaryWriter(4);
    w.writeUInt32(1750000000); // late 2025 / early 2026 unix ts
    h.handleMessage(event(GameEventType.UpdateRentTime, w.toBuffer()));

    expect(cap.rentTime).toBe(1750000000);
  });

  it('HouseTransaction: noticeType u32', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onHouseTransaction: (d) => { cap = d; } });

    const w = new BinaryWriter(4);
    w.writeUInt32(2); // ACE default noticeType
    h.handleMessage(event(GameEventType.HouseTransaction, w.toBuffer()));

    expect(cap.noticeType).toBe(2);
  });

  it('AvailableHouses: HouseType u32 + locations list + totalAvailable int32', () => {
    // Per GameEventHouseAvailableHouses.cs — used to populate the buy-house panel.
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onHouseAvailableHouses: (d) => { cap = d; } });

    const w = new BinaryWriter(32);
    w.writeUInt32(2); // HouseType.Cottage (or similar)
    w.writeUInt32(3); // 3 locations
    w.writeUInt32(0x40050001);
    w.writeUInt32(0x40050002);
    w.writeUInt32(0x40050003);
    w.writeUInt32(15); // total available
    h.handleMessage(event(GameEventType.AvailableHouses, w.toBuffer()));

    expect(cap.houseType).toBe(2);
    expect(cap.locations).toEqual([0x40050001, 0x40050002, 0x40050003]);
    expect(cap.totalAvailable).toBe(15);
  });

  it('HouseProfile: crystalGuid u32 + raw payload remainder', () => {
    // Struct content (HouseProfile) is rich; we expose the raw remainder for now.
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onHouseProfileRaw: (d) => { cap = d; } });

    const w = new BinaryWriter(32);
    w.writeUInt32(0x60000001); // crystal guid
    w.writeUInt32(0xCAFEF00D);
    w.writeUInt32(0xDEADBEEF);
    h.handleMessage(event(GameEventType.HouseProfile, w.toBuffer()));

    expect(cap.crystalGuid).toBe(0x60000001);
    expect(cap.rawPayload.length).toBe(8); // 2 remaining u32
  });

  it('HouseUpdateRestrictions: sequence u8 + objectGuid u32 + raw remainder', () => {
    // Per ACE GameEventHouseUpdateRestrictions.cs:11 the sequence prefix is
    // Sequences.GetNextSequence(SequenceType.UpdateRestrictionDB) which
    // returns a single byte (default ByteSequence per SequenceManager.cs:178).
    // Pre-fix the parser read u32 and drifted the cursor 3 bytes.
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onHouseUpdateRestrictionsRaw: (d) => { cap = d; } });

    const w = new BinaryWriter(32);
    w.writeUInt8(42);              // sequence (ByteSequence: 1 byte)
    w.writeUInt32(0x60000002);    // objectGuid
    w.writeUInt32(0x1);            // restriction db payload begin
    h.handleMessage(event(GameEventType.HouseUpdateRestrictions, w.toBuffer()));

    expect(cap.sequence).toBe(42);
    expect(cap.objectGuid).toBe(0x60000002);
    expect(cap.rawPayload.length).toBe(4);
  });
});

describe('HouseProfile + UpdateHAR structured parse (FAITHFUL.46)', () => {
  const writePString = (w: BinaryWriter, s: string) => {
    const bytes = new TextEncoder().encode(s);
    w.writeUInt16(bytes.length);
    w.writeBytes(bytes);
    const total = 2 + bytes.length;
    const rem = total % 4;
    if (rem !== 0) for (let i = 0; i < 4 - rem; i++) w.writeUInt8(0);
  };

  // Per reference/ACE/Source/ACE.Server/Network/Structure/HouseProfile.cs Write.
  it('HouseProfile: 9 u32s + S16L name + 2 payment lists', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onHouseProfile: (d) => { cap = d; } });

    const w = new BinaryWriter(128);
    w.writeUInt32(0x60000001);  // crystalGuid
    // HouseProfile body
    w.writeUInt32(2001);         // DwellingID
    w.writeUInt32(0x80009999);  // OwnerID
    w.writeUInt32(0x1);          // Bitmask
    w.writeInt32(50);            // MinLevel
    w.writeInt32(-1);            // MaxLevel (no max)
    w.writeInt32(-1); w.writeInt32(-1);  // alleg ranks
    w.writeUInt32(0);             // MaintenanceFree=false
    w.writeUInt32(2);             // HouseType.Villa
    writePString(w, 'Lord Bellator');
    // Buy list: empty (we own it)
    w.writeUInt32(0);
    // Rent list: 1 entry
    w.writeUInt32(1);
    w.writeInt32(50000); w.writeInt32(50000); w.writeUInt32(273);
    writePString(w, 'Pyreal'); writePString(w, 'Pyreals');
    h.handleMessage(event(GameEventType.HouseProfile, w.toBuffer()));

    expect(cap.crystalGuid).toBe(0x60000001);
    expect(cap.dwellingId).toBe(2001);
    expect(cap.ownerId).toBe(0x80009999);
    expect(cap.minLevel).toBe(50);
    expect(cap.maxLevel).toBe(-1);
    expect(cap.maintenanceFree).toBe(false);
    expect(cap.houseType).toBe(2);
    expect(cap.ownerName).toBe('Lord Bellator');
    expect(cap.buy).toEqual([]);
    expect(cap.rent.length).toBe(1);
    expect(cap.rent[0].name).toBe('Pyreal');
  });

  // Per reference/ACE/Source/ACE.Server/Network/Structure/HouseAccess.cs Write
  // + GuestInfo.cs Write: ItemStoragePermission u32 + GuestName S16L.
  it('UpdateHAR: parses guest list + roommates per HouseAccess.cs', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onHouseUpdateHAR: (d) => { cap = d; } });

    const w = new BinaryWriter(128);
    w.writeUInt32(0x10000001);  // Version
    w.writeUInt32(0x3);          // Bitmask flags
    w.writeUInt32(0x80009999);  // MonarchID
    // Guest list: 2 entries
    w.writeUInt16(2); w.writeUInt16(64);
    w.writeUInt32(0x80001111);
    w.writeUInt32(0);             // dwelling-only
    writePString(w, 'GuestA');
    w.writeUInt32(0x80001112);
    w.writeUInt32(1);             // storage too
    writePString(w, 'GuestB');
    // Roommates: 1 entry
    w.writeUInt32(1);
    w.writeUInt32(0x80001113);
    h.handleMessage(event(GameEventType.UpdateHAR, w.toBuffer()));

    expect(cap.version).toBe(0x10000001);
    expect(cap.bitmask).toBe(0x3);
    // HARBitfield.OpenHouse = 0x1 (ACE.Entity.Enum.HARBitfield) — bit is set here.
    expect(cap.openStatus).toBe(true);
    expect(cap.monarchId).toBe(0x80009999);
    expect(cap.guests.length).toBe(2);
    expect(cap.guests[0]).toEqual({ guid: 0x80001111, storageAccess: false, name: 'GuestA' });
    expect(cap.guests[1].storageAccess).toBe(true);
    expect(cap.roommates).toEqual([0x80001113]);
  });

  // BUG.house-guest-list-open-status-hardcoded-false — openStatus must track
  // the OpenHouse bit (0x1), not just be true whenever the bitmask is nonzero.
  it('UpdateHAR: openStatus is false when HARBitfield.OpenHouse (0x1) is unset', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onHouseUpdateHAR: (d) => { cap = d; } });

    const w = new BinaryWriter(128);
    w.writeUInt32(0x10000001);  // Version
    w.writeUInt32(0x2);          // Bitmask: AllegianceGuests only, OpenHouse unset
    w.writeUInt32(0x80009999);  // MonarchID
    w.writeUInt16(0); w.writeUInt16(0); // no guests
    w.writeUInt32(0); // no roommates
    h.handleMessage(event(GameEventType.UpdateHAR, w.toBuffer()));

    expect(cap.bitmask).toBe(0x2);
    expect(cap.openStatus).toBe(false);
  });
});

describe('HouseData structured parse (FAITHFUL.45)', () => {
  // Per reference/ACE/Source/ACE.Server/Network/Structure/HouseData.cs Write:
  //   BuyTime u32 + RentTime u32 + HouseType u32 + MaintenanceFree u32 +
  //   Buy List<HousePayment> + Rent List<HousePayment> + Position (Cell + Vec3 + Quat).
  it('parses HouseData with buy + rent payment lists + Position', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onHouseData: (d) => { cap = d; } });

    const writePString = (w: BinaryWriter, s: string) => {
      const bytes = new TextEncoder().encode(s);
      w.writeUInt16(bytes.length);
      w.writeBytes(bytes);
      const total = 2 + bytes.length;
      const rem = total % 4;
      if (rem !== 0) for (let i = 0; i < 4 - rem; i++) w.writeUInt8(0);
    };

    const w = new BinaryWriter(256);
    w.writeUInt32(1700000000);  // buyTime (unix)
    w.writeUInt32(1730000000);  // rentTime
    w.writeUInt32(2);            // HouseType.Villa
    w.writeUInt32(0);            // maintenanceFree=false
    // Buy list: 1 payment of 100000 Pyreals
    w.writeUInt32(1);
    w.writeInt32(100000);
    w.writeInt32(100000);        // fully paid (we already own)
    w.writeUInt32(273);
    writePString(w, 'Pyreal');
    writePString(w, 'Pyreals');
    // Rent list: 2 entries
    w.writeUInt32(2);
    w.writeInt32(50000); w.writeInt32(25000); w.writeUInt32(273);
    writePString(w, 'Pyreal'); writePString(w, 'Pyreals');
    w.writeInt32(20); w.writeInt32(0); w.writeUInt32(46);
    writePString(w, 'Pine Log'); writePString(w, 'Pine Logs');
    // Position
    w.writeUInt32(0x12345678);
    w.writeFloat32(10); w.writeFloat32(20); w.writeFloat32(0);
    w.writeFloat32(1); w.writeFloat32(0); w.writeFloat32(0); w.writeFloat32(0);
    h.handleMessage(event(GameEventType.HouseData, w.toBuffer()));

    expect(cap.buyTime).toBe(1700000000);
    expect(cap.rentTime).toBe(1730000000);
    expect(cap.houseType).toBe(2);
    expect(cap.maintenanceFree).toBe(false);
    expect(cap.buy.length).toBe(1);
    expect(cap.buy[0].num).toBe(100000);
    expect(cap.buy[0].paid).toBe(100000);
    expect(cap.rent.length).toBe(2);
    expect(cap.rent[0].paid).toBe(25000);
    expect(cap.rent[1].name).toBe('Pine Log');
    expect(cap.position.cell).toBe(0x12345678);
    expect(cap.position.x).toBeCloseTo(10, 5);
    expect(cap.position.rw).toBeCloseTo(1, 5);
  });
});

describe('Structured housing payload parsing (FAITHFUL.40)', () => {
  // Per reference/ACE/Source/ACE.Server/Network/Structure/HousePayment.cs Write:
  //   count u32 + N × (Num int32 + Paid int32 + WeenieID u32 + Name S16L + PluralName S16L).
  it('UpdateRentPayment: parses HousePayment list', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onHouseUpdateRentPayment: (d) => { cap = d; } });

    const writePString = (w: BinaryWriter, s: string) => {
      const bytes = new TextEncoder().encode(s);
      w.writeUInt16(bytes.length);
      w.writeBytes(bytes);
      const total = 2 + bytes.length;
      const rem = total % 4;
      if (rem !== 0) for (let i = 0; i < 4 - rem; i++) w.writeUInt8(0);
    };

    const w = new BinaryWriter(128);
    w.writeUInt32(2);              // 2 payment entries
    // Entry 1: 10000 pyreals needed, 5000 paid
    w.writeInt32(10000);
    w.writeInt32(5000);
    w.writeUInt32(273);            // Pyreal wcid
    writePString(w, 'Pyreal');
    writePString(w, 'Pyreals');
    // Entry 2: 50 leather, 0 paid
    w.writeInt32(50);
    w.writeInt32(0);
    w.writeUInt32(46);             // Leather wcid (arbitrary)
    writePString(w, 'Leather Hide');
    writePString(w, 'Leather Hides');
    h.handleMessage(event(GameEventType.UpdateRentPayment, w.toBuffer()));

    expect(cap.payments.length).toBe(2);
    expect(cap.payments[0].num).toBe(10000);
    expect(cap.payments[0].paid).toBe(5000);
    expect(cap.payments[0].weenieId).toBe(273);
    expect(cap.payments[0].name).toBe('Pyreal');
    expect(cap.payments[0].pluralName).toBe('Pyreals');
    expect(cap.payments[1].num).toBe(50);
    expect(cap.payments[1].paid).toBe(0);
  });

  // Per reference/ACE/Source/ACE.Server/Network/Structure/RestrictionDB.cs Write:
  //   Version u32 + OpenStatus u32 + MonarchID u32 +
  //   PackableHashTable<ObjectGuid, uint> (count u16 + buckets u16 + N × (key u32 + value u32)).
  // GameEventHouseUpdateRestrictions.cs:11 prefixes with sequence u8 +
  // objectGuid u32 — NOT u32 + u32 (see FAITHFUL.575).
  it('HouseUpdateRestrictions: parses RestrictionDB + permission table', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onHouseUpdateRestrictions: (d) => { cap = d; } });

    const w = new BinaryWriter(64);
    w.writeUInt8(99);                // sequence (ByteSequence: 1 byte)
    w.writeUInt32(0x60000123);      // objectGuid (the house)
    // RestrictionDB body
    w.writeUInt32(0x10000002);      // Version
    w.writeUInt32(1);                // OpenStatus = open
    w.writeUInt32(0x80009999);      // MonarchID
    w.writeUInt16(2);                // 2 perms
    w.writeUInt16(8);                // numBuckets
    w.writeUInt32(0x80001111); w.writeUInt32(0);  // dwelling-only access
    w.writeUInt32(0x80001112); w.writeUInt32(1);  // storage access too
    h.handleMessage(event(GameEventType.HouseUpdateRestrictions, w.toBuffer()));

    expect(cap.sequence).toBe(99);
    expect(cap.objectGuid).toBe(0x60000123);
    expect(cap.version).toBe(0x10000002);
    expect(cap.openStatus).toBe(true);
    expect(cap.monarchId).toBe(0x80009999);
    expect(cap.permissions.length).toBe(2);
    expect(cap.permissions[0]).toEqual({ playerGuid: 0x80001111, storageAccess: false });
    expect(cap.permissions[1]).toEqual({ playerGuid: 0x80001112, storageAccess: true });
  });
});

describe('Turbine chat channel management', () => {
  // Per reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventChannelIndex.cs
  it('ChannelIndex: count u32 + N × String16L channel names', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onChannelIndex: (d) => { cap = d; } });

    const writePString = (w: BinaryWriter, s: string) => {
      const bytes = new TextEncoder().encode(s);
      w.writeUInt16(bytes.length);
      w.writeBytes(bytes);
      const total = 2 + bytes.length;
      const rem = total % 4;
      if (rem !== 0) for (let i = 0; i < 4 - rem; i++) w.writeUInt8(0);
    };

    const w = new BinaryWriter(128);
    w.writeUInt32(3);
    writePString(w, 'Admin');
    writePString(w, 'Audit');
    writePString(w, 'Help');
    h.handleMessage(event(GameEventType.ChannelIndex, w.toBuffer()));

    expect(cap.channels).toEqual(['Admin', 'Audit', 'Help']);
  });

  // Per reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventChannelList.cs
  it('ChannelList: count u32 + N × String16L player names', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onChannelList: (d) => { cap = d; } });

    const writePString = (w: BinaryWriter, s: string) => {
      const bytes = new TextEncoder().encode(s);
      w.writeUInt16(bytes.length);
      w.writeBytes(bytes);
      const total = 2 + bytes.length;
      const rem = total % 4;
      if (rem !== 0) for (let i = 0; i < 4 - rem; i++) w.writeUInt8(0);
    };

    const w = new BinaryWriter(64);
    w.writeUInt32(2);
    writePString(w, 'TestChar');
    writePString(w, 'GameMaster');
    h.handleMessage(event(GameEventType.ChannelList, w.toBuffer()));

    expect(cap.players).toEqual(['TestChar', 'GameMaster']);
  });
});

describe('AllegianceInfoResponse structured parse (FAITHFUL.42)', () => {
  // Per reference/ACE/Source/ACE.Server/Network/Structure/AllegianceProfile.cs
  // + AllegianceHierarchy.cs Write.
  it('parses the AllegianceHierarchy header up through approvedVassal', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onAllegianceInfo: (d) => { cap = d; } });

    const writePString = (w: BinaryWriter, s: string) => {
      const bytes = new TextEncoder().encode(s);
      w.writeUInt16(bytes.length);
      w.writeBytes(bytes);
      const total = 2 + bytes.length;
      const rem = total % 4;
      if (rem !== 0) for (let i = 0; i < 4 - rem; i++) w.writeUInt8(0);
    };

    const w = new BinaryWriter(256);
    w.writeUInt32(0x80009999);   // playerGuid
    // AllegianceProfile body
    w.writeUInt32(42);            // totalMembers
    w.writeUInt32(15);            // totalVassals
    // AllegianceHierarchy
    w.writeUInt16(3);             // recordCount (monarch + 2 vassals)
    w.writeUInt16(0x000B);        // oldVersion
    // Officers PackableHashTable: 0 entries
    w.writeUInt16(0);             // count
    w.writeUInt16(8);             // numBuckets
    // OfficerTitles list: 0 entries
    w.writeUInt32(0);
    // 4 broadcast counters
    w.writeUInt32(1000); w.writeUInt32(0); w.writeUInt32(2000); w.writeUInt32(1);
    // MOTD
    writePString(w, 'Welcome');
    writePString(w, 'Bellator');
    w.writeUInt32(0xABCD);        // chatRoomId
    // Position (bindPoint)
    w.writeUInt32(0x12345678);    // cell
    w.writeFloat32(10.5); w.writeFloat32(20.5); w.writeFloat32(0.0);  // pos
    w.writeFloat32(1.0); w.writeFloat32(0.0); w.writeFloat32(0.0); w.writeFloat32(0.0);  // rotation (identity quaternion)
    // Allegiance name + meta
    writePString(w, 'Knights of Bellator');
    w.writeUInt32(0x100);          // nameLastSetTime
    w.writeUInt32(1);              // isLocked
    w.writeUInt32(0);              // approvedVassal (0 = none)
    // Records-raw bytes — we don't parse these in this layer
    w.writeUInt32(0xDEADBEEF);

    h.handleMessage(event(GameEventType.AllegianceInfoResponse, w.toBuffer()));

    expect(cap.playerGuid).toBe(0x80009999);
    expect(cap.totalMembers).toBe(42);
    expect(cap.totalVassals).toBe(15);
    expect(cap.recordCount).toBe(3);
    expect(cap.oldVersion).toBe(0x000B);
    expect(cap.officers).toEqual([]);
    expect(cap.officerTitles).toEqual([]);
    expect(cap.monarchBroadcastTime).toBe(1000);
    expect(cap.spokesBroadcastTime).toBe(2000);
    expect(cap.motd).toBe('Welcome');
    expect(cap.motdSetBy).toBe('Bellator');
    expect(cap.chatRoomId).toBe(0xABCD);
    expect(cap.bindPoint.cell).toBe(0x12345678);
    expect(cap.bindPoint.x).toBeCloseTo(10.5, 5);
    expect(cap.bindPoint.rw).toBeCloseTo(1.0, 5);
    expect(cap.allegianceName).toBe('Knights of Bellator');
    expect(cap.isLocked).toBe(true);
    expect(cap.recordsRaw.length).toBe(4);
  });

  it('parses per-record AllegianceData (monarch + 1 vassal)', () => {
    // Per reference/ACE/Source/ACE.Server/Network/Structure/AllegianceData.cs Write:
    //   characterID u32 + cpCached u32 + cpTithed u32 + bitfield u32 +
    //   gender u8 + heritageGroup u8 + rank u16 +
    //   (level u32 if HasPackedLevel=0x8) +
    //   loyalty u16 + leadership u16 +
    //   (timeOnline u32 + allegianceAge u32 if HasAllegianceAge=0x4 else uTimeOnline ulong) +
    //   name String16L.
    //
    // First record (index 0) is the monarch — NO treeParent prefix. Vassals (index >= 1)
    // each have a 4-byte treeParent ObjectGuid prefix per AllegianceHierarchy.cs records list.
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onAllegianceInfo: (d) => { cap = d; } });

    const writePString = (w: BinaryWriter, s: string) => {
      const bytes = new TextEncoder().encode(s);
      w.writeUInt16(bytes.length);
      w.writeBytes(bytes);
      const total = 2 + bytes.length;
      const rem = total % 4;
      if (rem !== 0) for (let i = 0; i < 4 - rem; i++) w.writeUInt8(0);
    };

    const writeAllegianceData = (w: BinaryWriter, fields: {
      characterID: number; cpCached: number; cpTithed: number;
      bitfield: number; gender: number; hg: number; rank: number;
      level?: number; loyalty: number; leadership: number;
      timeOnline?: number; age?: number; name: string;
    }) => {
      w.writeUInt32(fields.characterID);
      w.writeUInt32(fields.cpCached);
      w.writeUInt32(fields.cpTithed);
      w.writeUInt32(fields.bitfield);
      w.writeUInt8(fields.gender);
      w.writeUInt8(fields.hg);
      w.writeUInt16(fields.rank);
      if (fields.bitfield & 0x8) w.writeUInt32(fields.level ?? 0);
      w.writeUInt16(fields.loyalty);
      w.writeUInt16(fields.leadership);
      if (fields.bitfield & 0x4) {
        w.writeUInt32(fields.timeOnline ?? 0);
        w.writeUInt32(fields.age ?? 0);
      } else {
        w.writeUInt32(0); w.writeUInt32(0);  // ulong = 0
      }
      writePString(w, fields.name);
    };

    const w = new BinaryWriter(512);
    w.writeUInt32(0x80009999);                  // playerGuid
    w.writeUInt32(2); w.writeUInt32(0);          // totalMembers=2, totalVassals=0 (we're the monarch)
    w.writeUInt16(2); w.writeUInt16(0x000B);    // recordCount=2, oldVersion
    w.writeUInt16(0); w.writeUInt16(0);          // 0 officers (count u16, buckets u16)
    w.writeUInt32(0);                            // 0 officer titles
    w.writeUInt32(0); w.writeUInt32(0); w.writeUInt32(0); w.writeUInt32(0);
    writePString(w, ''); writePString(w, '');
    w.writeUInt32(0);                            // chatRoomId
    w.writeUInt32(0); w.writeFloat32(0); w.writeFloat32(0); w.writeFloat32(0);
    w.writeFloat32(1); w.writeFloat32(0); w.writeFloat32(0); w.writeFloat32(0);
    writePString(w, 'MyAllegiance');
    w.writeUInt32(0); w.writeUInt32(0); w.writeUInt32(0);
    // Records start here. Monarch (index 0, no treeParent):
    writeAllegianceData(w, {
      characterID: 0x80001000, cpCached: 5000, cpTithed: 100000,
      bitfield: 0x8 | 0x4,  // HasPackedLevel + HasAllegianceAge
      gender: 1, hg: 1, rank: 10, level: 150,
      loyalty: 290, leadership: 290,
      timeOnline: 3600, age: 86400 * 30,
      name: 'KingBob',
    });
    // Vassal (index 1, treeParent prefix → swearing to KingBob):
    w.writeUInt32(0x80001000);  // treeParent
    writeAllegianceData(w, {
      characterID: 0x80002000, cpCached: 100, cpTithed: 5000,
      bitfield: 0x8,  // HasPackedLevel only
      gender: 2, hg: 2, rank: 8, level: 100,
      loyalty: 250, leadership: 200,
      name: 'VassalVal',
    });
    h.handleMessage(event(GameEventType.AllegianceInfoResponse, w.toBuffer()));

    expect(cap.records).toBeDefined();
    expect(cap.records.length).toBe(2);
    // Monarch
    expect(cap.records[0].treeParent).toBeUndefined();
    expect(cap.records[0].characterID).toBe(0x80001000);
    expect(cap.records[0].name).toBe('KingBob');
    expect(cap.records[0].level).toBe(150);
    expect(cap.records[0].rank).toBe(10);
    expect(cap.records[0].timeOnline).toBe(3600);
    // Vassal
    expect(cap.records[1].treeParent).toBe(0x80001000);
    expect(cap.records[1].characterID).toBe(0x80002000);
    expect(cap.records[1].name).toBe('VassalVal');
    expect(cap.records[1].level).toBe(100);
    expect(cap.records[1].uTimeOnline).toBe(BigInt(0));
  });

  it('handles allegiance with officers + titles', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onAllegianceInfo: (d) => { cap = d; } });

    const writePString = (w: BinaryWriter, s: string) => {
      const bytes = new TextEncoder().encode(s);
      w.writeUInt16(bytes.length);
      w.writeBytes(bytes);
      const total = 2 + bytes.length;
      const rem = total % 4;
      if (rem !== 0) for (let i = 0; i < 4 - rem; i++) w.writeUInt8(0);
    };

    const w = new BinaryWriter(256);
    w.writeUInt32(0x80009999);
    w.writeUInt32(50); w.writeUInt32(20);
    w.writeUInt16(0); w.writeUInt16(0x000B);
    // 2 officers
    w.writeUInt16(2); w.writeUInt16(8);
    w.writeUInt32(0x80001111); w.writeUInt32(3); // Speaker
    w.writeUInt32(0x80001112); w.writeUInt32(2); // Castellan
    // 3 officer titles
    w.writeUInt32(3);
    writePString(w, 'Speaker');
    writePString(w, 'Seneschal');
    writePString(w, 'Castellan');
    // broadcast counters
    w.writeUInt32(0); w.writeUInt32(0); w.writeUInt32(0); w.writeUInt32(0);
    writePString(w, ''); writePString(w, '');
    w.writeUInt32(0);
    // bindPoint
    w.writeUInt32(0); w.writeFloat32(0); w.writeFloat32(0); w.writeFloat32(0);
    w.writeFloat32(1); w.writeFloat32(0); w.writeFloat32(0); w.writeFloat32(0);
    writePString(w, '');
    w.writeUInt32(0); w.writeUInt32(0); w.writeUInt32(0);

    h.handleMessage(event(GameEventType.AllegianceInfoResponse, w.toBuffer()));

    expect(cap.officers.length).toBe(2);
    expect(cap.officers[0]).toEqual({ guid: 0x80001111, officerLevel: 3 });
    expect(cap.officerTitles).toEqual(['Speaker', 'Seneschal', 'Castellan']);
  });
});

describe('OpponentTurn structured ChessMoveData (FAITHFUL.41 + FAITHFUL.117 wire-value fix)', () => {
  // Per reference/ACE/Source/ACE.Server/Network/Structure/ChessMoveData.cs Write:
  //   moveType int32 + playerGuid u32 + variable body.
  //   ChessMoveType is default-indexed C# enum: Invalid=0, Pass=1, Resign=2,
  //   Stalemate=3, Grid=4, FromTo=5, SelectedPiece=6.
  //   `writer.Write((int)data.Type)` serializes the enum int directly.
  //
  // Pre-FAITHFUL.117 these tests used 1/2/3 (matching the parser's then-buggy
  // dispatch). ACE actually writes 4/5/6 — FromTo (5) is the only type used
  // in live play per ACE comment "only ChessMoveType.FromTo used?".
  it('FromTo move: from + to coordinates parsed', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onChessOpponentTurn: (d) => { cap = d; } });

    const w = new BinaryWriter(32);
    w.writeUInt32(0x40A00006);  // boardGuid
    w.writeUInt32(0);            // color (Black)
    w.writeUInt32(5);            // moveType = FromTo (ChessMoveType.FromTo = 5)
    w.writeUInt32(0x80009999);  // playerGuid
    w.writeUInt32(4); w.writeUInt32(1);  // from e2 (file 4, rank 1)
    w.writeUInt32(4); w.writeUInt32(3);  // to e4
    h.handleMessage(event(GameEventType.OpponentTurn, w.toBuffer()));

    expect(cap.moveType).toBe(5);
    expect(cap.playerGuid).toBe(0x80009999);
    expect(cap.from).toEqual({ x: 4, y: 1 });
    expect(cap.to).toEqual({ x: 4, y: 3 });
    expect(cap.pieceGuid).toBeUndefined();
  });

  it('Grid move: only `to` populated', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onChessOpponentTurn: (d) => { cap = d; } });

    const w = new BinaryWriter(24);
    w.writeUInt32(0x40A00006);
    w.writeUInt32(1);
    w.writeUInt32(4);            // moveType = Grid (ChessMoveType.Grid = 4)
    w.writeUInt32(0x80009999);
    w.writeUInt32(3); w.writeUInt32(7);  // to coordinate
    h.handleMessage(event(GameEventType.OpponentTurn, w.toBuffer()));

    expect(cap.moveType).toBe(4);
    expect(cap.to).toEqual({ x: 3, y: 7 });
    expect(cap.from).toBeUndefined();
  });

  it('SelectedPiece move: pieceGuid populated', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onChessOpponentTurn: (d) => { cap = d; } });

    const w = new BinaryWriter(20);
    w.writeUInt32(0x40A00006);
    w.writeUInt32(0);
    w.writeUInt32(6);            // moveType = SelectedPiece (ChessMoveType.SelectedPiece = 6)
    w.writeUInt32(0x80009999);
    w.writeUInt32(0xA0000001);  // pieceGuid
    h.handleMessage(event(GameEventType.OpponentTurn, w.toBuffer()));

    expect(cap.moveType).toBe(6);
    expect(cap.pieceGuid).toBe(0xA0000001);
    expect(cap.from).toBeUndefined();
    expect(cap.to).toBeUndefined();
  });

  // Locks in the FAITHFUL.117 wire-value bug fix: any future regression that
  // re-introduces the old 1/2/3 dispatch must fail this test. ACE writes
  // ChessMoveType as a default-indexed C# enum integer, so a FromTo move
  // arrives as moveType=5 — the pre-fix parser tested for ===2 and silently
  // dropped it.
  it('regression: ChessMoveType wire values must be 4/5/6 (Grid/FromTo/SelectedPiece)', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onChessOpponentTurn: (d) => { cap = d; } });

    const w = new BinaryWriter(24);
    w.writeUInt32(0x40A00006);
    w.writeUInt32(0);
    w.writeUInt32(2);            // moveType = 2 (pre-FAITHFUL.117 buggy "FromTo")
    w.writeUInt32(0x80009999);
    w.writeUInt32(4); w.writeUInt32(1);
    w.writeUInt32(4); w.writeUInt32(3);
    h.handleMessage(event(GameEventType.OpponentTurn, w.toBuffer()));

    // Old buggy code would have populated from+to; corrected code recognises
    // moveType=2 as the unused Resign type and leaves both undefined.
    expect(cap.moveType).toBe(2);
    expect(cap.from).toBeUndefined();
    expect(cap.to).toBeUndefined();
  });
});

describe('Chess minigame events', () => {
  // Wire formats from reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEvent*.cs.
  // ChessColor enum: Black=0, White=1, None=-1.
  it('StartGame: boardGuid u32 + color int32', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onChessStartGame: (d) => { cap = d; } });

    const w = new BinaryWriter(8);
    w.writeUInt32(0x40A00001); // chessboard guid
    w.writeUInt32(1);          // White goes first
    h.handleMessage(event(GameEventType.StartGame, w.toBuffer()));

    expect(cap.boardGuid).toBe(0x40A00001);
    expect(cap.color).toBe(1);
  });

  it('GameOver: boardGuid u32 + teamWinner int32', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onChessGameOver: (d) => { cap = d; } });

    const w = new BinaryWriter(8);
    w.writeUInt32(0x40A00002);
    w.writeUInt32(0);          // Black wins
    h.handleMessage(event(GameEventType.GameOver, w.toBuffer()));

    expect(cap.teamWinner).toBe(0);
  });

  it('JoinGameResponse: color = -1 indicates failure', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onChessJoinGameResponse: (d) => { cap = d; } });

    const w = new BinaryWriter(8);
    w.writeUInt32(0x40A00003);
    w.writeInt32(-1);          // failed to join
    h.handleMessage(event(GameEventType.JoinGameResponse, w.toBuffer()));

    expect(cap.color).toBe(-1);
  });

  it('MoveResponse: boardGuid u32 + ChessMoveResult int32', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onChessMoveResponse: (d) => { cap = d; } });

    const w = new BinaryWriter(8);
    w.writeUInt32(0x40A00004);
    w.writeUInt32(1);          // Success
    h.handleMessage(event(GameEventType.MoveResponse, w.toBuffer()));

    expect(cap.result).toBe(1);
  });

  it('OpponentStalemate: stalemate bool encoded as int32 (1=offering, 0=retracting)', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onChessOpponentStalemate: (d) => { cap = d; } });

    const w = new BinaryWriter(12);
    w.writeUInt32(0x40A00005);
    w.writeUInt32(1);  // White
    w.writeUInt32(1);  // offering stalemate
    h.handleMessage(event(GameEventType.OpponentStalemate, w.toBuffer()));

    expect(cap.stalemate).toBe(true);
  });

  it('OpponentTurn: boardGuid + color + raw ChessMoveData remainder', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onChessOpponentTurnRaw: (d) => { cap = d; } });

    const w = new BinaryWriter(32);
    w.writeUInt32(0x40A00006);
    w.writeUInt32(0);          // Black
    w.writeUInt32(0xCAFEF00D); // raw move data begin
    h.handleMessage(event(GameEventType.OpponentTurn, w.toBuffer()));

    expect(cap.boardGuid).toBe(0x40A00006);
    expect(cap.rawMoveData.length).toBe(4);
  });
});

describe('Contract tracker + item-mana + allegiance-info events', () => {
  // Per reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventQueryItemManaResponse.cs
  it('QueryItemManaResponse: target u32 + mana f32 + success u32', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onQueryItemManaResponse: (d) => { cap = d; } });

    const w = new BinaryWriter(12);
    w.writeUInt32(0x80001234);
    w.writeFloat32(75.5);
    w.writeUInt32(1);
    h.handleMessage(event(GameEventType.QueryItemManaResponse, w.toBuffer()));

    expect(cap.targetGuid).toBe(0x80001234);
    expect(cap.mana).toBeCloseTo(75.5, 5);
    expect(cap.success).toBe(1);
  });

  // Per reference/ACE/Source/ACE.Server/Network/Structure/ContractTracker.cs:137-148
  // 28 bytes: Version u32 + ContractId u32 + Stage u32 + TimeWhenDone f64 + TimeWhenRepeats f64
  it('SendClientContractTracker: 28-byte ContractTracker + delete u32 + display u32', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onContractTracker: (d) => { cap = d; } });

    const w = new BinaryWriter(40);
    w.writeUInt32(1);            // Version
    w.writeUInt32(0x10000001);   // ContractId
    w.writeUInt32(2);            // Stage = InProgress
    w.writeFloat64(1234567.89);
    w.writeFloat64(2345678.90);
    w.writeUInt32(0);            // deleteContract
    w.writeUInt32(1);            // setAsDisplayContract
    h.handleMessage(event(GameEventType.SendClientContractTracker, w.toBuffer()));

    expect(cap.contract.version).toBe(1);
    expect(cap.contract.contractId).toBe(0x10000001);
    expect(cap.contract.stage).toBe(2);
    expect(cap.contract.timeWhenDone).toBeCloseTo(1234567.89, 4);
    expect(cap.deleteContract).toBe(false);
    expect(cap.setAsDisplayContract).toBe(true);
  });

  // Per reference/ACE/Source/ACE.Server/WorldObjects/Managers/ContractManager.cs:255
  // and PackableHashTable.cs: count u16 + buckets u16 + N × (key u32 + ContractTracker)
  it('SendClientContractTrackerTable: PackableHashTable header + entries', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onContractTrackerTable: (d) => { cap = d; } });

    const w = new BinaryWriter(80);
    w.writeUInt16(2);            // count
    w.writeUInt16(8);             // numBuckets
    // Contract 1
    w.writeUInt32(0x10000001);    // key
    w.writeUInt32(1);             // Version
    w.writeUInt32(0x10000001);    // ContractId
    w.writeUInt32(2);             // Stage
    w.writeFloat64(0); w.writeFloat64(0);
    // Contract 2
    w.writeUInt32(0x10000002);
    w.writeUInt32(1);
    w.writeUInt32(0x10000002);
    w.writeUInt32(3);             // Stage = DoneOrPendingRepeat
    w.writeFloat64(123); w.writeFloat64(456);
    h.handleMessage(event(GameEventType.SendClientContractTrackerTable, w.toBuffer()));

    expect(cap.numBuckets).toBe(8);
    expect(cap.contracts.length).toBe(2);
    expect(cap.contracts[0].key).toBe(0x10000001);
    expect(cap.contracts[1].entry.stage).toBe(3);
    expect(cap.contracts[1].entry.timeWhenRepeats).toBeCloseTo(456, 4);
  });

  // Per reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventAllegianceInfoResponse.cs
  it('AllegianceInfoResponse: playerGuid u32 + raw profile remainder', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onAllegianceInfoResponseRaw: (d) => { cap = d; } });

    const w = new BinaryWriter(32);
    w.writeUInt32(0x80009999);
    w.writeUInt32(0xCAFEF00D);    // raw profile payload begin
    w.writeUInt32(0xDEADBEEF);
    h.handleMessage(event(GameEventType.AllegianceInfoResponse, w.toBuffer()));

    expect(cap.playerGuid).toBe(0x80009999);
    expect(cap.rawPayload.length).toBe(8);
  });
});

describe('Portal storm events', () => {
  // Per reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventPortalStorm*.cs
  it('MiscPortalStorm: no payload', () => {
    const h = new ServerMessageHandler();
    let cap = false;
    h.setHandlers({ onPortalStorm: () => { cap = true; } });
    h.handleMessage(event(GameEventType.MiscPortalStorm, new Uint8Array(0)));
    expect(cap).toBe(true);
  });

  it('MiscPortalStormBrewing: extent f32 (default 0.4 per ACE source)', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onPortalStormBrewing: (d) => { cap = d; } });
    const w = new BinaryWriter(4);
    w.writeFloat32(0.4);
    h.handleMessage(event(GameEventType.MiscPortalStormBrewing, w.toBuffer()));
    expect(cap.extent).toBeCloseTo(0.4, 5);
  });

  it('MiscPortalStormImminent: extent f32 (default 0.6)', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onPortalStormImminent: (d) => { cap = d; } });
    const w = new BinaryWriter(4);
    w.writeFloat32(0.6);
    h.handleMessage(event(GameEventType.MiscPortalStormImminent, w.toBuffer()));
    expect(cap.extent).toBeCloseTo(0.6, 5);
  });

  it('MiscPortalStormSubsided: no payload', () => {
    const h = new ServerMessageHandler();
    let cap = false;
    h.setHandlers({ onPortalStormSubsided: () => { cap = true; } });
    h.handleMessage(event(GameEventType.MiscPortalStormSubsided, new Uint8Array(0)));
    expect(cap).toBe(true);
  });
});

describe('Confirmation dialog events', () => {
  it('ConfirmationRequest: ConfirmationType u32 + context u32 + String16L text', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onConfirmationRequest: (d) => { cap = d; } });

    const w = new BinaryWriter(64);
    w.writeUInt32(1); // ConfirmationType.SwearAllegiance (typical first value)
    w.writeUInt32(0x80001234); // context
    // String16L "Will you swear allegiance to Lord Bob?"
    const text = 'Swear allegiance?';
    const bytes = new TextEncoder().encode(text);
    w.writeUInt16(bytes.length);
    w.writeBytes(bytes);
    const totalWritten = 2 + bytes.length;
    const remainder = totalWritten % 4;
    if (remainder !== 0) for (let i = 0; i < 4 - remainder; i++) w.writeUInt8(0);
    h.handleMessage(event(GameEventType.ConfirmationRequest, w.toBuffer()));

    expect(cap.confirmationType).toBe(1);
    expect(cap.context).toBe(0x80001234);
    expect(cap.text).toBe('Swear allegiance?');
  });

  it('ConfirmationDone: ConfirmationType u32 + contextId u32', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onConfirmationDone: (d) => { cap = d; } });

    const w = new BinaryWriter(8);
    w.writeUInt32(1);
    w.writeUInt32(0x80001234);
    h.handleMessage(event(GameEventType.ConfirmationDone, w.toBuffer()));

    expect(cap.confirmationType).toBe(1);
    expect(cap.contextId).toBe(0x80001234);
  });
});

describe('Magic dispel events', () => {
  it('MagicDispelEnchantment: spellId u16 + layer u16', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onMagicDispelEnchantment: (d) => { cap = d; } });

    const w = new BinaryWriter(4);
    w.writeUInt16(1234); // spellId
    w.writeUInt16(2);    // layer
    h.handleMessage(event(GameEventType.MagicDispelEnchantment, w.toBuffer()));

    expect(cap.spellId).toBe(1234);
    expect(cap.layer).toBe(2);
  });

  it('MagicDispelMultipleEnchantments: count u32 + N × LayeredSpell (u16+u16)', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onMagicDispelMultipleEnchantments: (d) => { cap = d; } });

    const w = new BinaryWriter(16);
    w.writeUInt32(2);
    w.writeUInt16(100); w.writeUInt16(1);
    w.writeUInt16(200); w.writeUInt16(2);
    h.handleMessage(event(GameEventType.MagicDispelMultipleEnchantments, w.toBuffer()));

    expect(cap.spells).toEqual([
      { spellId: 100, layer: 1 },
      { spellId: 200, layer: 2 },
    ]);
  });
});

describe('Query age + barber init events', () => {
  it('QueryAgeResponse: targetName String16L + age String16L', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onQueryAgeResponse: (d) => { cap = d; } });

    const w = new BinaryWriter(32);
    const writePString = (s: string) => {
      const bytes = new TextEncoder().encode(s);
      w.writeUInt16(bytes.length);
      w.writeBytes(bytes);
      const total = 2 + bytes.length;
      const rem = total % 4;
      if (rem !== 0) for (let i = 0; i < 4 - rem; i++) w.writeUInt8(0);
    };
    writePString('TestChar');
    writePString('7d 4h 12m');
    h.handleMessage(event(GameEventType.QueryAgeResponse, w.toBuffer()));

    expect(cap.targetName).toBe('TestChar');
    expect(cap.age).toBe('7d 4h 12m');
  });

  it('StartBarber: full field-order cross-check vs GameEventStartBarber.cs (14 u32 + option1 + option2)', () => {
    // Per reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventStartBarber.cs:
    // 14 sequential Writer.Write(uint) calls (PaletteBaseDID, HeadObjectDID,
    // HairTexture, DefaultHairTexture, EyesTextureDID, DefaultEyesTextureDID,
    // NoseTextureDID, DefaultNoseTextureDID, MouthTextureDID,
    // DefaultMouthTextureDID, SkinPaletteDID, HairPaletteDID, EyesPaletteDID,
    // SetupTableId), then option1 (int) + option2 (int, always 0). Every
    // field below gets a DISTINCT sentinel value so a field-order
    // transposition (not just a wrong total count) would fail this test.
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onStartBarber: (d) => { cap = d; } });

    const w = new BinaryWriter(64);
    for (let i = 0; i < 14; i++) w.writeUInt32(0x10000 + i);
    w.writeUInt32(1);           // option1 (e.g. Empyrean bound/running variant)
    w.writeUInt32(0);           // option2 (unused in ACE, always 0)
    h.handleMessage(event(GameEventType.StartBarber, w.toBuffer()));

    expect(cap.paletteBaseDID).toBe(0x10000);
    expect(cap.headObjectDID).toBe(0x10001);
    expect(cap.hairTexture).toBe(0x10002);
    expect(cap.defaultHairTexture).toBe(0x10003);
    expect(cap.eyesTextureDID).toBe(0x10004);
    expect(cap.defaultEyesTextureDID).toBe(0x10005);
    expect(cap.noseTextureDID).toBe(0x10006);
    expect(cap.defaultNoseTextureDID).toBe(0x10007);
    expect(cap.mouthTextureDID).toBe(0x10008);
    expect(cap.defaultMouthTextureDID).toBe(0x10009);
    expect(cap.skinPaletteDID).toBe(0x1000a);
    expect(cap.hairPaletteDID).toBe(0x1000b);
    expect(cap.eyesPaletteDID).toBe(0x1000c);
    expect(cap.setupTableId).toBe(0x1000d);
    expect(cap.option1).toBe(1);
    expect(cap.option2).toBe(0);
  });
});

describe('IdentifyResponse HookProfile section', () => {
  // Per reference/ACE/Source/ACE.Server/Network/Structure/HookProfile.cs:
  // HookFlags u32 + ValidLocations u32 (EquipMask) + AmmoType u32.
  it('parses 3-uint hook profile', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onIdentifyResponse: (d) => { cap = d; } });

    const w = new BinaryWriter(32);
    w.writeUInt32(0x80009300);
    w.writeUInt32(0x0040);       // HookProfile only
    w.writeUInt32(1);
    w.writeUInt32(0x1);          // HookFlags.Inscribable
    w.writeUInt32(0x00100000);   // EquipMask.MeleeWeapon
    w.writeUInt32(0);            // AmmoType.None
    h.handleMessage(event(GameEventType.IdentifyObjectResponse, w.toBuffer()));

    expect(cap.hookProfile).toBeTruthy();
    expect(cap.hookProfile.hookFlags).toBe(0x1);
    expect(cap.hookProfile.validLocations).toBe(0x00100000);
    expect(cap.hookProfile.ammoType).toBe(0);
  });
});

describe('IdentifyResponse enchantment bitfields', () => {
  // Per AppraiseInfo.cs:761-775 — three 2-ushort bitfields. Stream order:
  // Armor (bit 0x0200), Weapon (bit 0x0800), Resist (bit 0x0400). Bit number ≠ stream order.
  it('parses armor/weapon/resist bitfields in ACE stream order', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onIdentifyResponse: (d) => { cap = d; } });

    const w = new BinaryWriter(32);
    w.writeUInt32(0x80009400);
    w.writeUInt32(0x0200 | 0x0800 | 0x0400);  // all three set
    w.writeUInt32(1);
    // Armor first
    w.writeUInt16(0x1F); w.writeUInt16(0x01);   // armor highlight + color
    // Weapon second
    w.writeUInt16(0xFE); w.writeUInt16(0x02);
    // Resist third
    w.writeUInt16(0x7F); w.writeUInt16(0x03);
    h.handleMessage(event(GameEventType.IdentifyObjectResponse, w.toBuffer()));

    expect(cap.armorEnchantment).toEqual({ highlight: 0x1F, color: 0x01 });
    expect(cap.weaponEnchantment).toEqual({ highlight: 0xFE, color: 0x02 });
    expect(cap.resistEnchantment).toEqual({ highlight: 0x7F, color: 0x03 });
  });
});

describe('IdentifyResponse ArmorLevels section', () => {
  // Per ArmorLevel.cs: 9 × uint32 in order Head, Chest, Abdomen, UpperArm,
  // LowerArm, Hand, UpperLeg, LowerLeg, Foot. Each value may have 9999 added
  // by ACE to signal an all-unenchantable layer (client displays asterisk).
  it('parses per-body-part armor levels', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onIdentifyResponse: (d) => { cap = d; } });

    const w = new BinaryWriter(64);
    w.writeUInt32(0x80009500);
    w.writeUInt32(0x4000);       // ArmorLevels only
    w.writeUInt32(1);
    [250, 300, 270, 220, 220, 200, 230, 230, 210].forEach(v => w.writeUInt32(v));
    h.handleMessage(event(GameEventType.IdentifyObjectResponse, w.toBuffer()));

    expect(cap.armorLevels).toEqual({
      head: 250, chest: 300, abdomen: 270,
      upperArm: 220, lowerArm: 220, hand: 200,
      upperLeg: 230, lowerLeg: 230, foot: 210,
    });
  });

  it('preserves the 9999 asterisk marker for unenchantable layers', () => {
    // ACE adds 9999 to any body-part total whose layers are all unenchantable,
    // signaling the client to display "AL N*". Consumer code subtracts 9999 to
    // display the real number, but the raw value must round-trip the wire.
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onIdentifyResponse: (d) => { cap = d; } });

    const w = new BinaryWriter(64);
    w.writeUInt32(0x80009501);
    w.writeUInt32(0x4000);
    w.writeUInt32(1);
    // Head is unenchantable (250 + 9999) — others normal.
    [10249, 300, 270, 220, 220, 200, 230, 230, 210].forEach(v => w.writeUInt32(v));
    h.handleMessage(event(GameEventType.IdentifyObjectResponse, w.toBuffer()));

    expect(cap.armorLevels.head).toBe(10249);
    expect(cap.armorLevels.head - 9999).toBe(250); // consumer's display value
    expect(cap.armorLevels.chest).toBe(300);
  });
});

describe('Fellowship membership change events', () => {
  it('FellowshipQuit: playerId u32', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onFellowshipQuit: (d) => { cap = d; } });

    const w = new BinaryWriter(4);
    w.writeUInt32(0x80009abc);
    h.handleMessage(event(GameEventType.FellowshipQuit, w.toBuffer()));

    expect(cap.playerId).toBe(0x80009abc);
  });

  it('FellowshipDismiss: playerId u32', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onFellowshipDismiss: (d) => { cap = d; } });

    const w = new BinaryWriter(4);
    w.writeUInt32(0x8000def0);
    h.handleMessage(event(GameEventType.FellowshipDismiss, w.toBuffer()));

    expect(cap.playerId).toBe(0x8000def0);
  });
});
