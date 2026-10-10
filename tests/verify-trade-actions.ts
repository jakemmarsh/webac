/**
 * Trade GameAction wire-format anchors.
 *
 * Anchors the trade-action payloads against ACE C# server-side parsing in
 *   reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionAcceptTrade.cs
 *   reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionDeclineTrade.cs
 *   reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionResetTrade.cs
 *   reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionCloseTradeNegotiations.cs
 *   reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionAddToTrade.cs
 *
 * AcceptTrade reads 28 bytes of payload (and discards them all). The wire format
 * MUST match exactly even though the server ignores the values, because that's
 * what the original AC client sends and any deviation could trip a non-ACE
 * server. The other four are no-payload or 8-byte payloads.
 */
import { describe, it, expect } from 'vitest';
import {
  BinaryWriter,
  BinaryReader,
  GameActionType,
  GameMessageOpcode,
  serializeGameAction,
  deserializeMessage,
} from '@ac/network';

function buildAcceptTradePayload(
  partnerGuid: number,
  tradeStamp: number,
  tradeStatus: number,
  initiatorGuid: number,
  initiatorAccepts: boolean,
  partnerAccepts: boolean,
): Uint8Array {
  const w = new BinaryWriter(28);
  w.writeUInt32(partnerGuid);
  w.writeFloat64(tradeStamp);
  w.writeUInt32(tradeStatus);
  w.writeUInt32(initiatorGuid);
  w.writeUInt32(initiatorAccepts ? 1 : 0);
  w.writeUInt32(partnerAccepts ? 1 : 0);
  return w.toBuffer();
}

describe('Trade GameAction wire format (ACE-anchored)', () => {
  it('AcceptTrade payload is exactly 28 bytes and round-trips ACE field layout', () => {
    const payload = buildAcceptTradePayload(0x80001234, 1234567.89, 7, 0x80005678, true, false);
    expect(payload.length).toBe(28);

    // Reader mirrors ACE GameActionAcceptTrade.Handle:
    //   uint partnerGuid; double tradeStamp; uint tradeStatus;
    //   uint initiatorGuid; bool initiatorAccepts; bool partnerAccepts;
    const r = new BinaryReader(payload);
    expect(r.readUInt32()).toBe(0x80001234);
    expect(r.readFloat64()).toBeCloseTo(1234567.89, 5);
    expect(r.readUInt32()).toBe(7);
    expect(r.readUInt32()).toBe(0x80005678);
    expect(r.readUInt32()).toBe(1);
    expect(r.readUInt32()).toBe(0);
    expect(r.remaining).toBe(0);
  });

  it('serializeGameAction(AcceptTrade) wraps payload in GameAction envelope', () => {
    const payload = buildAcceptTradePayload(0x12345678, 0, 0, 0x12345678, true, true);
    const msg = serializeGameAction(42, GameActionType.AcceptTrade, payload);
    // Envelope: opcode u32 + sequence u32 + actionType u32 + payload
    expect(msg.length).toBe(12 + 28);

    const parsed = deserializeMessage(msg);
    expect(parsed.type).toBe('action');
    if (parsed.type !== 'action') return;
    expect(parsed.opcode).toBe(GameMessageOpcode.GameAction);
    expect(parsed.sequence).toBe(42);
    expect(parsed.actionType).toBe(GameActionType.AcceptTrade);
    expect(parsed.payload.length).toBe(28);
  });

  it('DeclineTrade has zero-length payload', () => {
    const msg = serializeGameAction(1, GameActionType.DeclineTrade);
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(GameActionType.DeclineTrade);
    expect(parsed.payload.length).toBe(0);
  });

  it('ResetTrade has zero-length payload', () => {
    const msg = serializeGameAction(1, GameActionType.ResetTrade);
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(GameActionType.ResetTrade);
    expect(parsed.payload.length).toBe(0);
  });

  it('CloseTradeNegotiations has zero-length payload', () => {
    const msg = serializeGameAction(1, GameActionType.CloseTradeNegotiations);
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(GameActionType.CloseTradeNegotiations);
    expect(parsed.payload.length).toBe(0);
  });

  it('AddToTrade payload is 8 bytes: itemGuid + tradeSlot', () => {
    // ACE GameActionAddToTrade.Handle: ReadUInt32 itemGuid + ReadUInt32 tradeSlot
    const w = new BinaryWriter(8);
    w.writeUInt32(0x80009999);
    w.writeUInt32(3);
    const payload = w.toBuffer();
    expect(payload.length).toBe(8);

    const r = new BinaryReader(payload);
    expect(r.readUInt32()).toBe(0x80009999);
    expect(r.readUInt32()).toBe(3);
  });

  it('OpenTradeNegotiations payload is 4 bytes: partnerGuid', () => {
    // ACE GameActionOpenTradeNegotiations.Handle: ReadUInt32 tradePartnerGuid
    const w = new BinaryWriter(4);
    w.writeUInt32(0x80007777);
    const payload = w.toBuffer();
    expect(payload.length).toBe(4);
    const r = new BinaryReader(payload);
    expect(r.readUInt32()).toBe(0x80007777);
  });
});

describe('Final no-handler outbound stubs (FAITHFUL.48)', () => {
  // These enum values exist on the wire but have no ACE handler file.
  // Wiring them anyway gives the client a 100% outbound surface — server
  // ignores the message but the client can still emit it byte-correctly.
  const noPayload = (actionType: number, hex: number) => {
    const msg = serializeGameAction(1, actionType);
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(hex);
    expect(parsed.payload.length).toBe(0);
  };

  it('AbuseLogRequest + DoMovementCommand + StopMovementCommand + TurnTo + 2 plugin responses: zero-payload', () => {
    noPayload(GameActionType.AbuseLogRequest, 0x0140);
    noPayload(GameActionType.QueryPluginListResponse, 0x02AF);
    noPayload(GameActionType.QueryPluginResponse, 0x02B2);
    noPayload(GameActionType.DoMovementCommand, 0xF61E);
    noPayload(GameActionType.TurnTo, 0xF649);
    noPayload(GameActionType.StopMovementCommand, 0xF661);
  });
});

describe('SetCharacterOptions outbound (FAITHFUL.47)', () => {
  // Per reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionSetCharacterOptions.cs
  // + reference/ACE/Source/ACE.Entity/Enum/CharacterOptionDataFlag.cs.
  it('minimal: only flags + options1 + numTab1Spells=0 (12 bytes)', () => {
    const w = new BinaryWriter(16);
    w.writeUInt32(0);            // no conditional sections
    w.writeInt32(0x12345678);    // options1
    w.writeUInt32(0);            // numTab1Spells
    const msg = serializeGameAction(1, GameActionType.SetCharacterOptions, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(GameActionType.SetCharacterOptions);
    expect(parsed.actionType).toBe(0x01A1);
    expect(parsed.payload.length).toBe(12);
  });

  it('combined options1+options2+spellbookFilters: flag bits 0x60, 20 bytes', () => {
    const w = new BinaryWriter(20);
    w.writeUInt32(0x20 | 0x40);  // SpellbookFilters + CharacterOptions2
    w.writeInt32(0x12345678);
    w.writeUInt32(0);
    w.writeUInt32(0x3FFF);        // spellbookFilters (default)
    w.writeInt32(0x80);            // options2
    const msg = serializeGameAction(1, GameActionType.SetCharacterOptions, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(0x01A1);
    expect(parsed.payload.length).toBe(20);
  });

  it('with desiredComponents (sizeInfo + N × kv): flag bit 0x08', () => {
    const w = new BinaryWriter(64);
    w.writeUInt32(0x08);          // DesiredComps
    w.writeInt32(0);
    w.writeUInt32(0);             // numTab1Spells
    // sizeInfo = (numBuckets << 16) | count. 1 entry.
    w.writeUInt32((0x80 << 16) | 1);
    w.writeUInt32(694);
    w.writeInt32(50);
    const msg = serializeGameAction(1, GameActionType.SetCharacterOptions, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(0x01A1);
    // 4 + 4 + 4 + 4 (sizeInfo) + 4 (wcid) + 4 (count) = 24
    expect(parsed.payload.length).toBe(24);
  });
});

describe('AdvocateTeleport outbound (FAITHFUL.44)', () => {
  // Per reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionAdvocateTeleport.cs:
  //   target String16L + Position (Cell u32 + Vec3 + Quaternion = 32 bytes).
  // Admin/arch/PSR access required.
  it('AdvocateTeleport: target S16L + 32-byte Position', () => {
    const w = new BinaryWriter(64);
    w.writeString16('TestChar');
    w.writeUInt32(0x86040029);  // cell
    w.writeFloat32(12.0); w.writeFloat32(-28.0); w.writeFloat32(0.0);  // pos
    w.writeFloat32(1.0); w.writeFloat32(0.0); w.writeFloat32(0.0); w.writeFloat32(0.0);  // rot
    const msg = serializeGameAction(1, GameActionType.AdvocateTeleport, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(GameActionType.AdvocateTeleport);
    expect(parsed.actionType).toBe(0x00D6);
    // S16L 'TestChar' = 2 + 8 + 2 pad = 12 + Position 32 = 44 bytes
    expect(parsed.payload.length).toBe(44);
  });
});

describe('Jump outbound (FAITHFUL.41)', () => {
  // Per reference/ACE/Source/ACE.Server/Network/Structure/JumpPack.cs:
  //   Extent f32 + Vec3 (3×f32) + 4 ushorts (instance/serverCtrl/teleport/forcePos sequences) +
  //   trailing objectGuid u32 + spellId u32. Total 32 bytes.
  it('Jump: JumpPack + trailing fields = 32 bytes', () => {
    const w = new BinaryWriter(32);
    w.writeFloat32(0.85);  // jump extent
    w.writeFloat32(0); w.writeFloat32(0); w.writeFloat32(5.0); // velocity
    w.writeUInt16(0); w.writeUInt16(0); w.writeUInt16(0); w.writeUInt16(0); // 4 sequences
    w.writeUInt32(0); w.writeUInt32(0); // objectGuid + spellId
    const msg = serializeGameAction(1, GameActionType.Jump, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(GameActionType.Jump);
    expect(parsed.actionType).toBe(0xF61B);
    expect(parsed.payload.length).toBe(32);
  });
});

describe('SpellbookFilter + SetDesiredComponentLevel outbound (FAITHFUL.39)', () => {
  // Per reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionSpellbookFilter.cs.
  it('SpellbookFilter: filters u32 (SpellBookFilterOptions flags)', () => {
    const w = new BinaryWriter(4);
    w.writeUInt32(0x0F);  // War|Life|Item|Creature
    const msg = serializeGameAction(1, GameActionType.SpellbookFilter, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(0x0286);
    expect(parsed.payload.length).toBe(4);
  });

  // Per GameActionSetDesiredComponentLevel.cs: component_wcid u32 + amount u32.
  it('SetDesiredComponentLevel: component wcid + amount u32×2', () => {
    const w = new BinaryWriter(8);
    w.writeUInt32(694);   // component wcid (an arbitrary common SC wcid)
    w.writeUInt32(50);    // refill to 50
    const msg = serializeGameAction(1, GameActionType.SetDesiredComponentLevel, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(0x0224);
    expect(parsed.payload.length).toBe(8);
  });
});

describe('Channels + advanced housing + allegiance lock/house (FAITHFUL.38)', () => {
  const noPayload = (actionType: number, hex: number) => {
    const msg = serializeGameAction(1, actionType);
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(hex);
    expect(parsed.payload.length).toBe(0);
  };
  const u32Payload = (actionType: number, hex: number, val: number) => {
    const w = new BinaryWriter(4); w.writeUInt32(val);
    const msg = serializeGameAction(1, actionType, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(hex);
    expect(parsed.payload.length).toBe(4);
  };
  const s16lPayload = (actionType: number, hex: number) => {
    const w = new BinaryWriter(32); w.writeString16('Foo');
    const msg = serializeGameAction(1, actionType, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(hex);
    expect(parsed.payload.length).toBeGreaterThan(2);
  };

  it('AddChannel + RemoveChannel: u32 channel id', () => {
    u32Payload(GameActionType.AddChannel, 0x0145, 0x16);
    u32Payload(GameActionType.RemoveChannel, 0x0146, 0x16);
  });

  it('ListChannels + IndexChannels + BootEveryone: zero-length', () => {
    noPayload(GameActionType.ListChannels, 0x0148);
    noPayload(GameActionType.IndexChannels, 0x0149);
    noPayload(GameActionType.BootEveryone, 0x025F);
  });

  // Per GameActionHouseRentHouse.cs: slumlord u32 + items List<u32>.
  it('RentHouse: slumlord + items list', () => {
    const w = new BinaryWriter(16);
    w.writeUInt32(0x40060001);
    w.writeUInt32(1);
    w.writeUInt32(0x80001111);
    const msg = serializeGameAction(1, GameActionType.RentHouse, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(0x0221);
    expect(parsed.payload.length).toBe(12);
  });

  it('SetOpenHouseStatus + ModifyAllegiance{Guest,Storage}Permission: u32 bool', () => {
    u32Payload(GameActionType.SetOpenHouseStatus, 0x0247, 1);
    u32Payload(GameActionType.ModifyAllegianceGuestPermission, 0x0267, 1);
    u32Payload(GameActionType.ModifyAllegianceStoragePermission, 0x0268, 0);
  });

  it('ChangeStoragePermission: guestName S16L + hasPermission u32', () => {
    const w = new BinaryWriter(32);
    w.writeString16('Bob');
    w.writeUInt32(1);
    const msg = serializeGameAction(1, GameActionType.ChangeStoragePermission, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(0x0249);
  });

  it('BootSpecificHouseGuest + SetAllegianceApprovedVassal: playerName S16L', () => {
    s16lPayload(GameActionType.BootSpecificHouseGuest, 0x024A);
    s16lPayload(GameActionType.SetAllegianceApprovedVassal, 0x0040);
  });

  it('DoAllegianceHouseAction + DoAllegianceLockAction: u32 action enum', () => {
    u32Payload(GameActionType.DoAllegianceHouseAction, 0x0042, 1);
    u32Payload(GameActionType.DoAllegianceLockAction, 0x003F, 2);
  });
});

describe('Suicide + TrainSkill + TalkDirect + UseWithTarget + Arena + Stack ops (FAITHFUL.37)', () => {
  const noPayload = (actionType: number, hex: number) => {
    const msg = serializeGameAction(1, actionType);
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(hex);
    expect(parsed.payload.length).toBe(0);
  };

  it('Suicide + TeleToPkArena + TeleToPklArena: zero-length', () => {
    noPayload(GameActionType.Suicide, 0x0279);
    noPayload(GameActionType.TeleToPkArena, 0x0027);
    noPayload(GameActionType.TeleToPklArena, 0x0026);
  });

  // Per GameActionTrainSkill.cs: skill u32 + creditsSpent int32.
  it('TrainSkill: skill + credits = 8 bytes', () => {
    const w = new BinaryWriter(8); w.writeUInt32(44); w.writeInt32(4);
    const msg = serializeGameAction(1, GameActionType.TrainSkill, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(0x0047);
    expect(parsed.payload.length).toBe(8);
  });

  // Per GameActionTalkDirect.cs: message S16L + targetGuid u32 (text BEFORE guid).
  it('TalkDirect: message S16L + targetGuid u32 (text first)', () => {
    const w = new BinaryWriter(32);
    w.writeString16('hi');
    w.writeUInt32(0x80001234);
    const msg = serializeGameAction(1, GameActionType.TalkDirect, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(0x0032);
    // (2 + 2 + 0 pad) + 4 = 8
    expect(parsed.payload.length).toBe(8);
  });

  // Per GameActionUseWithTarget.cs: sourceGuid u32 + targetGuid u32 = 8 bytes.
  it('UseWithTarget: source + target u32×2', () => {
    const w = new BinaryWriter(8);
    w.writeUInt32(0x80001111);
    w.writeUInt32(0x80002222);
    const msg = serializeGameAction(1, GameActionType.UseWithTarget, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(0x0035);
    expect(parsed.payload.length).toBe(8);
  });

  // Per GameActionStackableMerge.cs: from + to + amount = 12 bytes.
  it('StackableMerge: from + to + amount = 12 bytes', () => {
    const w = new BinaryWriter(12);
    w.writeUInt32(0x80001111); w.writeUInt32(0x80002222); w.writeInt32(5);
    const msg = serializeGameAction(1, GameActionType.StackableMerge, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(0x0054);
    expect(parsed.payload.length).toBe(12);
  });

  // Per GameActionStackableSplitToWield.cs: stackId u32 + location int32 (EquipMask) + amount int32.
  it('StackableSplitToWield: stackId + equipMask + amount = 12 bytes', () => {
    const w = new BinaryWriter(12);
    w.writeUInt32(0x80001234);
    w.writeInt32(0x01000000);  // EquipMask.Held
    w.writeInt32(1);
    const msg = serializeGameAction(1, GameActionType.StackableSplitToWield, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(0x019B);
    expect(parsed.payload.length).toBe(12);
  });
});

describe('AFK + emote + inscription + house guest mgmt outbound (FAITHFUL.36)', () => {
  it('SetAfkMode + SetHooksVisibility: u32 bool (4 bytes)', () => {
    for (const [actionType, hex] of [
      [GameActionType.SetAfkMode, 0x000F] as const,
      [GameActionType.SetHooksVisibility, 0x0266] as const,
    ]) {
      const w = new BinaryWriter(4); w.writeUInt32(1);
      const msg = serializeGameAction(1, actionType, w.toBuffer());
      const parsed = deserializeMessage(msg);
      if (parsed.type !== 'action') throw new Error('expected action');
      expect(parsed.actionType).toBe(hex);
      expect(parsed.payload.length).toBe(4);
    }
  });

  it('SetAfkMessage + SoulEmote: String16L only', () => {
    for (const [actionType, hex] of [
      [GameActionType.SetAfkMessage, 0x0010] as const,
      [GameActionType.SoulEmote, 0x01E1] as const,
    ]) {
      const w = new BinaryWriter(32); w.writeString16('test message');
      const msg = serializeGameAction(1, actionType, w.toBuffer());
      const parsed = deserializeMessage(msg);
      if (parsed.type !== 'action') throw new Error('expected action');
      expect(parsed.actionType).toBe(hex);
      expect(parsed.payload.length).toBeGreaterThan(2);
    }
  });

  // Per GameActionSetInscription.cs: objectGuid u32 + inscriptionText S16L.
  it('SetInscription: objectGuid + text S16L', () => {
    const w = new BinaryWriter(64);
    w.writeUInt32(0x80001234);
    w.writeString16('To Bael, fondly');
    const msg = serializeGameAction(1, GameActionType.SetInscription, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(0x00BF);
    expect(parsed.payload.length).toBeGreaterThan(4);
  });

  it('RemovePlayerPermission + RemovePermanentGuest: String16L name', () => {
    for (const [actionType, hex] of [
      [GameActionType.RemovePlayerPermission, 0x021A] as const,
      [GameActionType.RemovePermanentGuest, 0x0246] as const,
    ]) {
      const w = new BinaryWriter(32); w.writeString16('Bob');
      const msg = serializeGameAction(1, actionType, w.toBuffer());
      const parsed = deserializeMessage(msg);
      if (parsed.type !== 'action') throw new Error('expected action');
      expect(parsed.actionType).toBe(hex);
      expect(parsed.payload.length).toBeGreaterThan(2);
    }
  });

  it('RequestFullGuestList: zero-length', () => {
    const msg = serializeGameAction(1, GameActionType.RequestFullGuestList);
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(0x024D);
    expect(parsed.payload.length).toBe(0);
  });
});

describe('Squelch management outbound (FAITHFUL.35)', () => {
  // Per reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionModify*Squelch.cs.
  it('ModifyAccountSquelch: squelch u32 + playerName S16L', () => {
    const w = new BinaryWriter(32);
    w.writeUInt32(1);  // squelch=true
    w.writeString16('Spammer');
    const msg = serializeGameAction(1, GameActionType.ModifyAccountSquelch, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(0x0059);
    expect(parsed.payload.length).toBeGreaterThan(4);
  });

  it('ModifyCharacterSquelch: squelch u32 + playerGuid u32 + playerName S16L + messageType u32', () => {
    const w = new BinaryWriter(48);
    w.writeUInt32(1);
    w.writeUInt32(0x80001234);
    w.writeString16('Spammer');
    w.writeUInt32(0x16); // ChatMessageType.Channel (any)
    const msg = serializeGameAction(1, GameActionType.ModifyCharacterSquelch, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(0x0058);
    // 4 + 4 + (2 + 7 + 3 pad) + 4 = 24
    expect(parsed.payload.length).toBe(24);
  });

  it('ModifyGlobalSquelch: squelch u32 + messageType u32 = 8 bytes', () => {
    const w = new BinaryWriter(8);
    w.writeUInt32(0); // unsquelch
    w.writeUInt32(0x0A); // ChatMessageType.Tell
    const msg = serializeGameAction(1, GameActionType.ModifyGlobalSquelch, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(0x005B);
    expect(parsed.payload.length).toBe(8);
  });
});

describe('Allegiance bans + consent + PK + remove-all outbound (FAITHFUL.34)', () => {
  const noPayload = (actionType: number, hex: number) => {
    const msg = serializeGameAction(1, actionType);
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(hex);
    expect(parsed.payload.length).toBe(0);
  };
  const stringPayload = (actionType: number, hex: number, name: string) => {
    const w = new BinaryWriter(32); w.writeString16(name);
    const msg = serializeGameAction(1, actionType, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(hex);
    expect(parsed.payload.length).toBeGreaterThan(2);
  };

  it('AddAllegianceBan + RemoveAllegianceBan + RemoveFromPlayerConsentList: String16L name', () => {
    stringPayload(GameActionType.AddAllegianceBan, 0x02A1, 'Offender');
    stringPayload(GameActionType.RemoveAllegianceBan, 0x02A2, 'Offender');
    stringPayload(GameActionType.RemoveFromPlayerConsentList, 0x0218, 'OldFriend');
  });

  it('ListAllegianceBans + EnterPkLite + RemoveAllFriends + Display/ClearPlayerConsentList + RemoveAll storage/guests: zero-length', () => {
    noPayload(GameActionType.ListAllegianceBans, 0x02A3);
    noPayload(GameActionType.EnterPkLite, 0x028F);
    noPayload(GameActionType.RemoveAllFriends, 0x0025);
    noPayload(GameActionType.DisplayPlayerConsentList, 0x0217);
    noPayload(GameActionType.ClearPlayerConsentList, 0x0216);
    noPayload(GameActionType.RemoveAllStoragePermission, 0x024C);
    noPayload(GameActionType.RemoveAllPermanentGuests, 0x025E);
  });
});

describe('Housing + chat + give + barber outbound (FAITHFUL.33)', () => {
  const noPayload = (actionType: number, hex: number) => {
    const msg = serializeGameAction(1, actionType);
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(hex);
    expect(parsed.payload.length).toBe(0);
  };

  it('HouseQuery + AbandonHouse + ListAvailableHouses + PingRequest: zero-length', () => {
    noPayload(GameActionType.HouseQuery, 0x021E);
    noPayload(GameActionType.AbandonHouse, 0x021F);
    noPayload(GameActionType.ListAvailableHouses, 0x0270);
    noPayload(GameActionType.PingRequest, 0x01E9);
  });

  // Per reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionChatChannel.cs.
  it('ChatChannel: channel u32 + message String16L', () => {
    const w = new BinaryWriter(32);
    w.writeUInt32(0x16);  // Channel.Allegiance
    w.writeString16('Hello allegiance!');
    const msg = serializeGameAction(1, GameActionType.ChatChannel, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(0x0147);
    // 4 (channel) + 2 (length) + 17 (bytes) + 1 (pad to 4) = 24
    expect(parsed.payload.length).toBe(24);
  });

  // Per GameActionGiveObjectRequest.cs: targetGuid u32 + objectGuid u32 + amount int32 = 12 bytes.
  it('GiveObjectRequest: target + object + amount u32×3 = 12 bytes', () => {
    const w = new BinaryWriter(12);
    w.writeUInt32(0x40070001);  // NPC guid
    w.writeUInt32(0x80001234);  // item guid
    w.writeInt32(1);             // amount
    const msg = serializeGameAction(1, GameActionType.GiveObjectRequest, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(0x00CD);
    expect(parsed.payload.length).toBe(12);
  });

  // Per Player_Character.HandleActionFinishBarber: 16 u32 fields = 64 bytes.
  it('FinishBarber: 16 u32 fields (palette/texture DIDs + setup + 2 options) = 64 bytes', () => {
    const w = new BinaryWriter(64);
    for (let i = 0; i < 16; i++) w.writeUInt32(0x10000 + i);
    const msg = serializeGameAction(1, GameActionType.FinishBarber, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(0x0311);
    expect(parsed.payload.length).toBe(64);
  });
});

describe('Query commands + fellowship leader/dismiss + RaiseVital (FAITHFUL.32)', () => {
  // Per reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionQueryHealth.cs.
  it('QueryHealth: u32 guid', () => {
    const w = new BinaryWriter(4); w.writeUInt32(0x80001234);
    const msg = serializeGameAction(1, GameActionType.QueryHealth, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(0x01BF);
    expect(parsed.payload.length).toBe(4);
  });

  // Per GameActionQueryBirth.cs: target String16L.
  it('QueryBirth: String16L target', () => {
    const w = new BinaryWriter(8); w.writeString16('');
    const msg = serializeGameAction(1, GameActionType.QueryBirth, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(0x01C4);
    expect(parsed.payload.length).toBe(4);
  });

  // Per GameActionQueryLord.cs + QueryAllegianceName.cs: no payload.
  it('QueryLord + QueryAllegianceName: zero-length', () => {
    const m1 = serializeGameAction(1, GameActionType.QueryLord);
    const p1 = deserializeMessage(m1);
    if (p1.type !== 'action') throw new Error('expected action');
    expect(p1.actionType).toBe(0x0258);
    expect(p1.payload.length).toBe(0);

    const m2 = serializeGameAction(1, GameActionType.QueryAllegianceName);
    const p2 = deserializeMessage(m2);
    if (p2.type !== 'action') throw new Error('expected action');
    expect(p2.actionType).toBe(0x0030);
    expect(p2.payload.length).toBe(0);
  });

  // Per GameActionRaiseVital.cs: vital u32 + xpSpent u32 = 8 bytes.
  it('RaiseVital: vital + xpSpent u32×2', () => {
    const w = new BinaryWriter(8);
    w.writeUInt32(1); // PropertyAttribute2nd.MaxHealth
    w.writeUInt32(50000);
    const msg = serializeGameAction(1, GameActionType.RaiseVital, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(0x0044);
    expect(parsed.payload.length).toBe(8);
  });

  // Per GameActionFellowshipAssignNewLeader.cs + Dismiss.cs: u32 playerId.
  it('FellowshipAssignNewLeader + FellowshipDismiss: u32 playerId', () => {
    const w = new BinaryWriter(4); w.writeUInt32(0x80009999);
    const m1 = serializeGameAction(1, GameActionType.FellowshipAssignNewLeader, w.toBuffer());
    const p1 = deserializeMessage(m1);
    if (p1.type !== 'action') throw new Error('expected action');
    expect(p1.actionType).toBe(0x0290);
    expect(p1.payload.length).toBe(4);

    const m2 = serializeGameAction(1, GameActionType.FellowshipDismiss, w.toBuffer());
    const p2 = deserializeMessage(m2);
    if (p2.type !== 'action') throw new Error('expected action');
    expect(p2.actionType).toBe(0x00A4);
    expect(p2.payload.length).toBe(4);
  });

  // Per GameActionFellowshipUpdateRequest.cs: panelOpen int32.
  it('FellowshipUpdateRequest: panelOpen int32', () => {
    const w = new BinaryWriter(4); w.writeInt32(1);
    const msg = serializeGameAction(1, GameActionType.FellowshipUpdateRequest, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(0x00A6);
    expect(parsed.payload.length).toBe(4);
  });
});

describe('Allegiance officer mgmt outbound (FAITHFUL.31)', () => {
  // Per reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameAction*.cs.
  const noPayload = (actionType: number, hex: number) => {
    const msg = serializeGameAction(1, actionType);
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(hex);
    expect(parsed.payload.length).toBe(0);
  };

  it('SetAllegianceName: String16L name', () => {
    const w = new BinaryWriter(16); w.writeString16('Knights');
    const msg = serializeGameAction(1, GameActionType.SetAllegianceName, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(0x0033);
    expect(parsed.payload.length).toBeGreaterThan(4); // length-prefix + bytes + padding
  });

  it('SetMotd / QueryMotd / list + clear officer actions all zero-payload or S16L', () => {
    // SetMotd
    {
      const w = new BinaryWriter(32); w.writeString16('Welcome!');
      const msg = serializeGameAction(1, GameActionType.SetMotd, w.toBuffer());
      const parsed = deserializeMessage(msg);
      if (parsed.type !== 'action') throw new Error('expected action');
      expect(parsed.actionType).toBe(0x0254);
    }
    noPayload(GameActionType.QueryMotd, 0x0255);
    noPayload(GameActionType.ListAllegianceOfficers, 0x02A6);
    noPayload(GameActionType.ListAllegianceOfficerTitles, 0x003D);
    noPayload(GameActionType.ClearAllegianceOfficers, 0x02A7);
    noPayload(GameActionType.ClearAllegianceOfficerTitles, 0x003E);
  });

  it('SetAllegianceOfficer: String16L name + level u32', () => {
    const w = new BinaryWriter(32);
    w.writeString16('Speaker');
    w.writeUInt32(3); // AllegianceOfficerLevel
    const msg = serializeGameAction(1, GameActionType.SetAllegianceOfficer, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(0x003B);
  });

  it('SetAllegianceOfficerTitle: level u32 + title String16L', () => {
    const w = new BinaryWriter(32);
    w.writeUInt32(3);
    w.writeString16('Speaker of the Realm');
    const msg = serializeGameAction(1, GameActionType.SetAllegianceOfficerTitle, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(0x003C);
  });

  it('AllegianceChatBoot: playerName + reason (String16L × 2)', () => {
    const w = new BinaryWriter(64);
    w.writeString16('Offender');
    w.writeString16('Trolling');
    const msg = serializeGameAction(1, GameActionType.AllegianceChatBoot, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(0x02A0);
  });

  it('AllegianceChatGag: playerName + enabled u32', () => {
    const w = new BinaryWriter(32);
    w.writeString16('Offender');
    w.writeUInt32(1);
    const msg = serializeGameAction(1, GameActionType.AllegianceChatGag, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(0x0041);
  });

  it('BreakAllegianceBoot: playerName + accountBoot u32', () => {
    const w = new BinaryWriter(32);
    w.writeString16('Vassal');
    w.writeUInt32(0);
    const msg = serializeGameAction(1, GameActionType.BreakAllegianceBoot, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(0x0277);
  });
});

describe('Allegiance + housing officer commands outbound (FAITHFUL.30)', () => {
  // Per reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionClearAllegianceName.cs.
  it('ClearAllegianceName: zero-length payload', () => {
    const msg = serializeGameAction(1, GameActionType.ClearAllegianceName);
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(0x0031);
    expect(parsed.payload.length).toBe(0);
  });

  it('ClearMotd: zero-length payload', () => {
    const msg = serializeGameAction(1, GameActionType.ClearMotd);
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(0x0256);
    expect(parsed.payload.length).toBe(0);
  });

  // Per GameActionHouseAddPermanentGuest.cs: guestName String16L.
  it('AddPermanentGuest: guestName String16L', () => {
    const w = new BinaryWriter(16);
    w.writeString16('LordBellator');
    const msg = serializeGameAction(1, GameActionType.AddPermanentGuest, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(0x0245);
    // String16L: "LordBellator" = 12 bytes + 2 length + 2 pad = 16
    expect(parsed.payload.length).toBe(16);
  });

  it('AddAllStoragePermission: zero-length payload', () => {
    const msg = serializeGameAction(1, GameActionType.AddAllStoragePermission);
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(0x025C);
    expect(parsed.payload.length).toBe(0);
  });

  // Per GameActionAddPlayerPermission.cs: playerName String16L.
  it('AddPlayerPermission: playerName String16L', () => {
    const w = new BinaryWriter(16);
    w.writeString16('TestChar');
    const msg = serializeGameAction(1, GameActionType.AddPlayerPermission, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(0x0219);
    // String16L: "TestChar" = 8 bytes + 2 length + 2 pad = 12
    expect(parsed.payload.length).toBe(12);
  });
});

describe('Book-editing outbound GameActions (FAITHFUL.29)', () => {
  // Each format per reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionBook*.cs.
  it('BookData: bookGuid u32', () => {
    const w = new BinaryWriter(4); w.writeUInt32(0x80009000);
    const msg = serializeGameAction(1, GameActionType.BookData, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(0x00AA);
    expect(parsed.payload.length).toBe(4);
  });

  it('BookAddPage: bookGuid u32', () => {
    const w = new BinaryWriter(4); w.writeUInt32(0x80009000);
    const msg = serializeGameAction(1, GameActionType.BookAddPage, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(0x00AC);
    expect(parsed.payload.length).toBe(4);
  });

  it('BookModifyPage: bookGuid + page + String16L text', () => {
    const w = new BinaryWriter(32);
    w.writeUInt32(0x80009000);
    w.writeInt32(0);
    w.writeString16('Hello');
    const msg = serializeGameAction(1, GameActionType.BookModifyPage, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(0x00AB);
    // 4 (guid) + 4 (page) + (2 length + 5 bytes + 1 pad to 4) = 16
    expect(parsed.payload.length).toBe(16);
  });

  it('BookDeletePage: bookGuid + page int32 = 8 bytes', () => {
    const w = new BinaryWriter(8);
    w.writeUInt32(0x80009000); w.writeInt32(2);
    const msg = serializeGameAction(1, GameActionType.BookDeletePage, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(0x00AD);
    expect(parsed.payload.length).toBe(8);
  });

  it('BookPageData: bookGuid + pageNum int32 = 8 bytes', () => {
    const w = new BinaryWriter(8);
    w.writeUInt32(0x80009000); w.writeInt32(0);
    const msg = serializeGameAction(1, GameActionType.BookPageData, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(0x00AE);
    expect(parsed.payload.length).toBe(8);
  });
});

describe('Shortcut bar outbound (FAITHFUL.28)', () => {
  // Per reference/ACE/Source/ACE.Server/Network/Structure/Shortcut.cs Write:
  //   Index u32 + ObjectId u32 + LayeredSpell (SpellId u16 + Layer u16) = 12 bytes
  it('AddShortCut: index + objectGuid + spell layered slot = 12 bytes', () => {
    const w = new BinaryWriter(12);
    w.writeUInt32(0);            // toolbar slot 0
    w.writeUInt32(0x80001234);   // object guid
    w.writeUInt16(0);            // spellId
    w.writeUInt16(0);            // layer
    const msg = serializeGameAction(1, GameActionType.AddShortCut, w.toBuffer());

    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(GameActionType.AddShortCut);
    expect(parsed.actionType).toBe(0x019C);
    expect(parsed.payload.length).toBe(12);
  });

  // Per GameActionRemoveShortcut.cs: index u32 (4 bytes).
  it('RemoveShortCut: index u32 (4 bytes)', () => {
    const w = new BinaryWriter(4);
    w.writeUInt32(7);
    const msg = serializeGameAction(1, GameActionType.RemoveShortCut, w.toBuffer());

    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(GameActionType.RemoveShortCut);
    expect(parsed.actionType).toBe(0x019D);
    expect(parsed.payload.length).toBe(4);
  });
});

describe('SetSingleCharacterOption outbound (FAITHFUL.27)', () => {
  // Per reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionSetSingleCharacterOption.cs:
  //   option u32 (CharacterOption enum) + value u32 (bool, 0/1). 8 bytes.
  it('SetSingleCharacterOption: option u32 + value u32', () => {
    const w = new BinaryWriter(8);
    w.writeUInt32(0x22);  // CharacterOption.SalvageMultipleMaterialsAtOnce
    w.writeUInt32(1);     // enable
    const msg = serializeGameAction(1, GameActionType.SetSingleCharacterOption, w.toBuffer());

    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(GameActionType.SetSingleCharacterOption);
    expect(parsed.actionType).toBe(0x0005);
    expect(parsed.payload.length).toBe(8);
  });
});

describe('Misc commonly-used outbound GameActions (FAITHFUL.26)', () => {
  // Per reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionQueryItemMana.cs:
  //   objectGuid u32.
  it('QueryItemMana: u32 guid (4 bytes)', () => {
    const w = new BinaryWriter(4);
    w.writeUInt32(0x80001234);
    const msg = serializeGameAction(1, GameActionType.QueryItemMana, w.toBuffer());

    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(GameActionType.QueryItemMana);
    expect(parsed.actionType).toBe(0x0263);
    expect(parsed.payload.length).toBe(4);
  });

  // Per GameActionQueryAge.cs: target String16L (unused but required for wire compat).
  it('QueryAge: target String16L', () => {
    const w = new BinaryWriter(16);
    w.writeString16(''); // empty name = query self
    const msg = serializeGameAction(1, GameActionType.QueryAge, w.toBuffer());

    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(GameActionType.QueryAge);
    expect(parsed.actionType).toBe(0x01C2);
    // String16L empty = 2 bytes length (0) + pad to 4 = 4 bytes total
    expect(parsed.payload.length).toBe(4);
  });

  // Per GameActionAbandonContract.cs: contractId u32.
  it('AbandonContract: contractId u32 (4 bytes)', () => {
    const w = new BinaryWriter(4);
    w.writeUInt32(0x10000001);
    const msg = serializeGameAction(1, GameActionType.AbandonContract, w.toBuffer());

    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(GameActionType.AbandonContract);
    expect(parsed.actionType).toBe(0x0316);
    expect(parsed.payload.length).toBe(4);
  });

  // Per GameActionHouseBuyHouse.cs: slumlord u32 + items List<u32> (count u32 + N×u32).
  it('BuyHouse: slumlord + items list', () => {
    const w = new BinaryWriter(20);
    w.writeUInt32(0x40060001);  // slumlord NPC guid
    w.writeUInt32(2);            // 2 payment items
    w.writeUInt32(0x80001111);
    w.writeUInt32(0x80001112);
    const msg = serializeGameAction(1, GameActionType.BuyHouse, w.toBuffer());

    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(GameActionType.BuyHouse);
    expect(parsed.actionType).toBe(0x021C);
    // 4 (slumlord) + 4 (count) + 2 × 4 (items) = 16 bytes
    expect(parsed.payload.length).toBe(16);
  });
});

describe('Chess outbound GameActions (FAITHFUL.25)', () => {
  // Per reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionChessJoin.cs:
  //   boardGuid u32 + color int32 (-1 unused).
  it('ChessJoin: boardGuid + color (-1) = 8 bytes', () => {
    const w = new BinaryWriter(8);
    w.writeUInt32(0x40A00001);
    w.writeInt32(-1);
    const msg = serializeGameAction(1, GameActionType.ChessJoin, w.toBuffer());

    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(GameActionType.ChessJoin);
    expect(parsed.actionType).toBe(0x0269);
    expect(parsed.payload.length).toBe(8);
  });

  // Per GameActionChessMove.cs: from(X i32, Y i32) + to(X i32, Y i32) = 16 bytes
  // (ChessPieceCoord.cs Write: X int32 + Y int32).
  it('ChessMove: from + to ChessPieceCoord = 16 bytes', () => {
    const w = new BinaryWriter(16);
    w.writeInt32(4); w.writeInt32(1); // from e2 (file 4, rank 1)
    w.writeInt32(4); w.writeInt32(3); // to e4
    const msg = serializeGameAction(1, GameActionType.ChessMove, w.toBuffer());

    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(GameActionType.ChessMove);
    expect(parsed.actionType).toBe(0x026B);
    expect(parsed.payload.length).toBe(16);
  });

  // Per GameActionChessQuit.cs: no payload.
  it('ChessQuit: zero-length payload', () => {
    const msg = serializeGameAction(1, GameActionType.ChessQuit);
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(GameActionType.ChessQuit);
    expect(parsed.actionType).toBe(0x026A);
    expect(parsed.payload.length).toBe(0);
  });

  // Per GameActionChessStalemate.cs: bool-as-int32.
  it('ChessStalemate: int32 (1=offering, 0=retracting)', () => {
    const w = new BinaryWriter(4);
    w.writeInt32(1);
    const msg = serializeGameAction(1, GameActionType.ChessStalemate, w.toBuffer());

    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(GameActionType.ChessStalemate);
    expect(parsed.actionType).toBe(0x026E);
    expect(parsed.payload.length).toBe(4);
  });

  // Per GameActionChessMovePass.cs: no payload.
  it('ChessMovePass: zero-length payload', () => {
    const msg = serializeGameAction(1, GameActionType.ChessMovePass);
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(GameActionType.ChessMovePass);
    expect(parsed.actionType).toBe(0x026D);
    expect(parsed.payload.length).toBe(0);
  });
});

describe('Spell-favorite outbound GameActions (FAITHFUL.24)', () => {
  // Per reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionAddSpellFavorite.cs:
  //   spellId u32 + spellBarPositionId u32 + spellBarId u32 (12 bytes).
  it('AddSpellFavorite: spellId + position + barIndex u32×3', () => {
    const w = new BinaryWriter(12);
    w.writeUInt32(2061);  // typical war spell ID
    w.writeUInt32(3);     // position 4 on the bar
    w.writeUInt32(0);     // bar 0
    const msg = serializeGameAction(1, GameActionType.AddSpellFavorite, w.toBuffer());

    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(GameActionType.AddSpellFavorite);
    expect(parsed.actionType).toBe(0x01E3);
    expect(parsed.payload.length).toBe(12);
  });

  // Per GameActionRemoveSpellFavorite.cs: spellId u32 + spellBarId u32 (8 bytes).
  it('RemoveSpellFavorite: spellId + barIndex u32×2', () => {
    const w = new BinaryWriter(8);
    w.writeUInt32(2061);
    w.writeUInt32(0);
    const msg = serializeGameAction(1, GameActionType.RemoveSpellFavorite, w.toBuffer());

    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(GameActionType.RemoveSpellFavorite);
    expect(parsed.actionType).toBe(0x01E4);
    expect(parsed.payload.length).toBe(8);
  });
});

describe('Friend list + CancelAttack outbound GameActions (FAITHFUL.23)', () => {
  // Per reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionAddFriend.cs:
  //   ReadString16L friendName.
  it('AddFriend: String16L name payload', () => {
    const w = new BinaryWriter(32);
    w.writeString16('LordBellator');
    const msg = serializeGameAction(1, GameActionType.AddFriend, w.toBuffer());

    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(GameActionType.AddFriend);
    expect(parsed.actionType).toBe(0x0018);
    // String16L = 2-byte length + bytes + pad-to-4. "LordBellator" = 12 bytes + 2 = 14, pad +2 = 16.
    expect(parsed.payload.length).toBe(16);
  });

  // Per GameActionRemoveFriend.cs: ReadUInt32 friendGuid.
  it('RemoveFriend: u32 friendGuid', () => {
    const w = new BinaryWriter(4);
    w.writeUInt32(0x80009999);
    const msg = serializeGameAction(1, GameActionType.RemoveFriend, w.toBuffer());

    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(GameActionType.RemoveFriend);
    expect(parsed.actionType).toBe(0x0017);
    expect(parsed.payload.length).toBe(4);
  });

  // Per GameActionCancelAttack.cs: no payload.
  it('CancelAttack: zero-length payload', () => {
    const msg = serializeGameAction(1, GameActionType.CancelAttack);
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(GameActionType.CancelAttack);
    expect(parsed.actionType).toBe(0x01B7);
    expect(parsed.payload.length).toBe(0);
  });
});

describe('ConfirmationResponse GameAction wire format', () => {
  // Per reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionConfirmationResponse.cs:
  //   ConfirmationType int32 + context u32 + response int32 (bool).
  it('payload: type i32 + context u32 + response i32 (12 bytes)', () => {
    const w = new BinaryWriter(12);
    w.writeInt32(1);             // ConfirmationType.SwearAllegiance
    w.writeUInt32(0x80001234);   // context (server-assigned)
    w.writeInt32(1);             // response: yes
    const payload = w.toBuffer();
    expect(payload.length).toBe(12);

    const r = new BinaryReader(payload);
    expect(r.readInt32()).toBe(1);
    expect(r.readUInt32()).toBe(0x80001234);
    expect(r.readInt32()).toBe(1);
  });

  it('serializeGameAction(ConfirmationResponse) wraps payload', () => {
    const w = new BinaryWriter(12);
    w.writeInt32(7); // Yes_No
    w.writeUInt32(0xCAFEBABE);
    w.writeInt32(0); // No
    const msg = serializeGameAction(11, GameActionType.ConfirmationResponse, w.toBuffer());

    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(GameActionType.ConfirmationResponse);
    expect(parsed.actionType).toBe(0x0275);
    expect(parsed.payload.length).toBe(12);
  });
});

describe('Salvage (CreateTinkeringTool) GameAction wire format', () => {
  it('payload: toolGuid u32 + itemCount u32 + itemGuid[itemCount] u32', () => {
    // ACE GameActionCreateTinkeringTool.Handle: ReadUInt32 toolGuid + ReadUInt32 itemCount,
    // then ReadUInt32 itemCount times.
    const toolGuid = 0x80001111;
    const items = [0x80002222, 0x80003333, 0x80004444];
    const w = new BinaryWriter(8 + items.length * 4);
    w.writeUInt32(toolGuid);
    w.writeUInt32(items.length);
    for (const g of items) w.writeUInt32(g);
    const payload = w.toBuffer();
    expect(payload.length).toBe(8 + items.length * 4);

    const r = new BinaryReader(payload);
    expect(r.readUInt32()).toBe(toolGuid);
    const n = r.readUInt32();
    expect(n).toBe(3);
    const decoded = [r.readUInt32(), r.readUInt32(), r.readUInt32()];
    expect(decoded).toEqual(items);
    expect(r.remaining).toBe(0);
  });

  it('serializeGameAction(CreateTinkeringTool) wraps salvage payload correctly', () => {
    const w = new BinaryWriter(12);
    w.writeUInt32(0x80009999);
    w.writeUInt32(1);
    w.writeUInt32(0x8000aaaa);
    const msg = serializeGameAction(7, GameActionType.CreateTinkeringTool, w.toBuffer());

    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(GameActionType.CreateTinkeringTool);
    expect(parsed.actionType).toBe(0x027D);
    expect(parsed.payload.length).toBe(12);
  });

  it('zero-item salvage still serializes (toolGuid + count=0)', () => {
    // ACE handler tolerates itemCount=0 (the while loop simply doesn't execute);
    // client should still serialize 8 bytes so the server can decode.
    const w = new BinaryWriter(8);
    w.writeUInt32(0x80000001);
    w.writeUInt32(0);
    const payload = w.toBuffer();
    expect(payload.length).toBe(8);
  });
});

// FAITHFUL.52 — Close the last 2 unwired outbound GameActions.
// Anchored against:
//   reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionStackableSplitTo3D.cs
//   reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionMagicRemoveSpellId.cs
describe('Final-final unwired outbound GameActions (FAITHFUL.52)', () => {
  it('StackableSplitTo3D: stackId u32 + amount int32 = 8 bytes (drops onto ground)', () => {
    const w = new BinaryWriter(8);
    w.writeUInt32(0x800012ab);
    w.writeInt32(5);
    const payload = w.toBuffer();
    expect(payload.length).toBe(8);

    const msg = serializeGameAction(99, GameActionType.StackableSplitTo3D, payload);
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(GameActionType.StackableSplitTo3D);
    expect(parsed.actionType).toBe(0x0056);
    expect(parsed.payload.length).toBe(8);

    const r = new BinaryReader(parsed.payload);
    expect(r.readUInt32()).toBe(0x800012ab);
    expect(r.readInt32()).toBe(5);
  });

  it('StackableSplitTo3D tolerates amount=0 (ACE handler reads then validates)', () => {
    const w = new BinaryWriter(8);
    w.writeUInt32(0x80009999);
    w.writeInt32(0);
    expect(w.toBuffer().length).toBe(8);
  });

  it('RemoveSpellC2S: spellId u32 = 4 bytes (server removes from spellbook)', () => {
    const w = new BinaryWriter(4);
    w.writeUInt32(2382);  // arbitrary spell id; ACE looks it up in SpellTable
    const payload = w.toBuffer();
    expect(payload.length).toBe(4);

    const msg = serializeGameAction(101, GameActionType.RemoveSpellC2S, payload);
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    expect(parsed.actionType).toBe(GameActionType.RemoveSpellC2S);
    expect(parsed.actionType).toBe(0x01A8);
    expect(parsed.payload.length).toBe(4);

    const r = new BinaryReader(parsed.payload);
    expect(r.readUInt32()).toBe(2382);
  });

  it('RemoveSpellC2S round-trip preserves full uint32 range (high bit OK)', () => {
    const w = new BinaryWriter(4);
    w.writeUInt32(0xFFFFFFFE);
    const msg = serializeGameAction(1, GameActionType.RemoveSpellC2S, w.toBuffer());
    const parsed = deserializeMessage(msg);
    if (parsed.type !== 'action') throw new Error('expected action');
    const r = new BinaryReader(parsed.payload);
    expect(r.readUInt32()).toBe(0xFFFFFFFE);
  });
});
