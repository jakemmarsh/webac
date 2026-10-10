/**
 * FAITHFUL.59 — pin 6 small wire-relevant ACE enums byte-for-byte.
 *
 * Sources:
 *   reference/ACE/Source/ACE.Entity/Enum/Placement.cs        (24 named + 13 XXXUnknown sentinels)
 *   reference/ACE/Source/ACE.Entity/Enum/ContainerType.cs    (3 values)
 *   reference/ACE/Source/ACE.Entity/Enum/HoldKey.cs          (3 values)
 *   reference/ACE/Source/ACE.Entity/Enum/PortalFlags.cs      (2 Flags bits)
 *   reference/ACE/Source/ACE.Entity/Enum/FactionBits.cs      (4 values + ValidFactions union + ToSentence)
 *   reference/ACE/Source/ACE.Entity/Enum/ChatNetworkBlobType.cs (7 Turbine-chat 0xF7DE dispatch types)
 */
import { describe, it, expect } from 'vitest';
import {
  Placement,
  ContainerType,
  HoldKey,
  PortalFlags,
  FactionBits, FACTION_BITS_VALID, factionBitsLabel,
  ChatNetworkBlobType,
  ParentLocation,
  VitalKey,
} from '@ac/shared';

describe('Placement (per ACE Placement.cs)', () => {
  it('hand/belt block: Default=0, RightHandCombat=1, RightHandNonCombat=2, LeftHand=3, Belt=4, Quiver=5, Shield=6, LeftWeapon=7, LeftUnarmed=8', () => {
    expect(Placement.Default).toBe(0);
    expect(Placement.RightHandCombat).toBe(1);
    expect(Placement.RightHandNonCombat).toBe(2);
    expect(Placement.LeftHand).toBe(3);
    expect(Placement.Belt).toBe(4);
    expect(Placement.Quiver).toBe(5);
    expect(Placement.Shield).toBe(6);
    expect(Placement.LeftWeapon).toBe(7);
    expect(Placement.LeftUnarmed).toBe(8);
  });

  it('missile/special block: SpecialCrowssbowBolt=51 (note ACE spelling), MissileFlight=52', () => {
    expect(Placement.SpecialCrowssbowBolt).toBe(51);
    expect(Placement.MissileFlight).toBe(52);
  });

  it('lifestyle block: Resting=101, Other=102, Hook=103', () => {
    expect(Placement.Resting).toBe(101);
    expect(Placement.Other).toBe(102);
    expect(Placement.Hook).toBe(103);
  });

  it('Random1..Random10 = 121..130 (sequential)', () => {
    expect(Placement.Random1).toBe(121);
    expect(Placement.Random5).toBe(125);
    expect(Placement.Random10).toBe(130);
  });

  it('XXXUnknown sentinels retain ACE-source integer values', () => {
    expect(Placement.XXXUnknownA).toBe(0x0000000A);
    expect(Placement.XXXUnknownF).toBe(0x0000000F);
    expect(Placement.XXXUnknown14).toBe(0x00000014);
    expect(Placement.XXXUnknown69).toBe(0x00000069);
    expect(Placement.XXXUnknown6A).toBe(0x0000006A);
    expect(Placement.XXXUnknown3F2).toBe(0x000003F2);
  });
});

describe('ContainerType (per ACE ContainerType.cs)', () => {
  it('3 values: NonContainer=0, Container=1, Foci=2', () => {
    expect(ContainerType.NonContainer).toBe(0);
    expect(ContainerType.Container).toBe(1);
    expect(ContainerType.Foci).toBe(2);
  });
});

describe('HoldKey (per ACE HoldKey.cs)', () => {
  it('Invalid=0x0, None=0x1, Run=0x2 — load-bearing for movement-mode wire', () => {
    expect(HoldKey.Invalid).toBe(0x0);
    expect(HoldKey.None).toBe(0x1);
    expect(HoldKey.Run).toBe(0x2);
  });
});

describe('PortalFlags (per ACE PortalFlags.cs Flags enum)', () => {
  it('ExactMatch=0x1, PortalSide=0x2', () => {
    expect(PortalFlags.ExactMatch).toBe(0x1);
    expect(PortalFlags.PortalSide).toBe(0x2);
  });
});

describe('FactionBits (per ACE FactionBits.cs + FactionBitsExtensions)', () => {
  it('None=0, CelestialHand=1, EldrytchWeb=2, RadiantBlood=4 (Flags enum)', () => {
    expect(FactionBits.None).toBe(0);
    expect(FactionBits.CelestialHand).toBe(0x1);
    expect(FactionBits.EldrytchWeb).toBe(0x2);
    expect(FactionBits.RadiantBlood).toBe(0x4);
  });

  it('FACTION_BITS_VALID = ValidFactions = CH | EW | RB = 0x7', () => {
    expect(FACTION_BITS_VALID).toBe(0x1 | 0x2 | 0x4);
    expect(FACTION_BITS_VALID).toBe(0x7);
  });

  it('factionBitsLabel matches FactionBitsExtensions.ToSentence', () => {
    expect(factionBitsLabel(FactionBits.None)).toBe('None');
    expect(factionBitsLabel(FactionBits.CelestialHand)).toBe('Celestial Hand');
    expect(factionBitsLabel(FactionBits.EldrytchWeb)).toBe('Eldrytch Web');
    expect(factionBitsLabel(FactionBits.RadiantBlood)).toBe('Radiant Blood');
  });
});

describe('VitalKey (per ACE Vital.cs)', () => {
  // Sequential uint enum used as the wire-format key in PrivateUpdateVital /
  // PublicUpdateVital messages. ACE interleaves Max-vs-current: MaxHealth=1,
  // Health=2, MaxStamina=3, Stamina=4, MaxMana=5, Mana=6. Wrong values here
  // = vital updates land in the wrong slot or get silently dropped.
  //
  // Renamed from "Vital" (the ACE source name) to avoid collision with the
  // existing `Vital` interface in character/VitalSystem.ts which represents
  // the runtime state of a client-side vital (current/raises/partialRegen).
  it('7 entries, Undefined=0..Mana=6 sequentially', () => {
    expect(VitalKey.Undefined).toBe(0);
    expect(VitalKey.MaxHealth).toBe(1);
    expect(VitalKey.Health).toBe(2);
    expect(VitalKey.MaxStamina).toBe(3);
    expect(VitalKey.Stamina).toBe(4);
    expect(VitalKey.MaxMana).toBe(5);
    expect(VitalKey.Mana).toBe(6);
  });

  it('odd values = Max (training data), even non-zero values = current', () => {
    // ACE wire format: Max keys (1/3/5) carry initLevel/levelFromCP/cpSpent;
    // current keys (2/4/6) carry just the current value.
    expect(VitalKey.MaxHealth % 2).toBe(1);
    expect(VitalKey.MaxStamina % 2).toBe(1);
    expect(VitalKey.MaxMana % 2).toBe(1);
    expect(VitalKey.Health % 2).toBe(0);
    expect(VitalKey.Stamina % 2).toBe(0);
    expect(VitalKey.Mana % 2).toBe(0);
  });

  it('no extras vs ACE source (7 entries total)', () => {
    const tsNames = Object.keys(VitalKey).filter((k) => Number.isNaN(Number(k)));
    expect(tsNames).toEqual([
      'Undefined', 'MaxHealth', 'Health', 'MaxStamina', 'Stamina', 'MaxMana', 'Mana',
    ]);
  });
});

describe('ParentLocation (per ACE ParentLocation.cs)', () => {
  // Sequential 0-9 enum used in ParentEvent (server tells observers an item is
  // wielded at a specific body-bone location on a creature). FAITHFUL.101 added
  // the symbolic enum after the equipped-item visualization (UI.55-65) was
  // pinned with bare numeric literals.
  it('10 sequential entries, None=0..LeftUnarmed=9', () => {
    expect(ParentLocation.None).toBe(0);
    expect(ParentLocation.RightHand).toBe(1);
    expect(ParentLocation.LeftHand).toBe(2);
    expect(ParentLocation.Shield).toBe(3);
    expect(ParentLocation.Belt).toBe(4);
    expect(ParentLocation.Quiver).toBe(5);
    expect(ParentLocation.Hearldry).toBe(6);
    expect(ParentLocation.Mouth).toBe(7);
    expect(ParentLocation.LeftWeapon).toBe(8);
    expect(ParentLocation.LeftUnarmed).toBe(9);
  });

  it('preserves the ACE-source typo "Hearldry" for cross-reference fidelity', () => {
    // ACE source: `Hearldry = 6,` (sic — should be "Heraldry"). Renaming would
    // break grep-cross-reference between this codebase and ACE C# source. If
    // ACE ever fixes the typo, this test breaks deliberately as a heads-up.
    expect(ParentLocation.Hearldry).toBe(6);
    // Belt-and-suspenders — confirm the misspelling is intentional.
    expect((ParentLocation as unknown as Record<string, number>)['Heraldry']).toBeUndefined();
  });

  it('no extras vs ACE source (10 entries total)', () => {
    const tsNames = Object.keys(ParentLocation).filter((k) => Number.isNaN(Number(k)));
    expect(tsNames).toEqual([
      'None', 'RightHand', 'LeftHand', 'Shield', 'Belt',
      'Quiver', 'Hearldry', 'Mouth', 'LeftWeapon', 'LeftUnarmed',
    ]);
  });
});

describe('ChatNetworkBlobType (per ACE ChatNetworkBlobType.cs)', () => {
  it('7 values 0-6 with documented direction', () => {
    expect(ChatNetworkBlobType.NETBLOB_UNKNOWN).toBe(0);
    expect(ChatNetworkBlobType.NETBLOB_EVENT_BINARY).toBe(1);     // S→C
    expect(ChatNetworkBlobType.NETBLOB_EVENT_XMLRPC).toBe(2);     // S→C
    expect(ChatNetworkBlobType.NETBLOB_REQUEST_BINARY).toBe(3);   // C→S
    expect(ChatNetworkBlobType.NETBLOB_REQUEST_XMLRPC).toBe(4);   // C→S
    expect(ChatNetworkBlobType.NETBLOB_RESPONSE_BINARY).toBe(5);  // S→C
    expect(ChatNetworkBlobType.NETBLOB_RESPONSE_XMLRPC).toBe(6);  // S→C
  });

  it('encoding pairing: every BINARY type has a matching XMLRPC type (Event, Request, Response)', () => {
    expect(ChatNetworkBlobType.NETBLOB_EVENT_XMLRPC - ChatNetworkBlobType.NETBLOB_EVENT_BINARY).toBe(1);
    expect(ChatNetworkBlobType.NETBLOB_REQUEST_XMLRPC - ChatNetworkBlobType.NETBLOB_REQUEST_BINARY).toBe(1);
    expect(ChatNetworkBlobType.NETBLOB_RESPONSE_XMLRPC - ChatNetworkBlobType.NETBLOB_RESPONSE_BINARY).toBe(1);
  });
});
