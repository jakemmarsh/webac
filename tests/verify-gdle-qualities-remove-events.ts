/**
 * GAP.gdle-qualities-remove-events — GDL-family servers (Dark Majesty /
 * Classic Dereth, Seedsow) send the retail qualities REMOVE events when a
 * property is gone (WeenieObject.cpp Notify*StatUpdated, the `else` branch
 * after InqX fails):
 *   private  [u32 op][u8 seq][u32 key]             0x1D1 Int, 0x1D3 Bool, 0x1D5 Float, 0x1D7 String,
 *                                                   0x1D9 DataID, 0x1DB InstanceID, 0x1DD Position, 0x2B8 Int64
 *   public   [u32 op][u8 seq][u32 guid][u32 key]   the even twin of each (0x2B9 for Int64)
 * Retail reads exactly that (CM_Qualities::DispatchUI_[Private]Remove*Event:
 * seq @+4, guid @+5, key @+9) and drops the key (ClientObjMaintSystem::
 * <T>::RemoveStat). Before this fix all sixteen fell through to logUnhandled,
 * so a property the server cleared kept its stale value on our side.
 *
 * These drive GDLE-layout bytes through the REAL ServerMessageHandler into
 * the real stores the update path writes.
 */
import { describe, expect, it, vi } from 'vitest';
import { GameMessageOpcode, BinaryWriter } from '@ac/network';
import { PropertyBool, PropertyDataId, PropertyInt, PropertyInt64 } from '@ac/shared';
import { InventoryManager } from '../packages/shared/src/inventory/InventoryManager.js';
import { ServerMessageHandler, type ServerMessageHandlers, type PropertyUpdateData } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { PlayerState } from '../packages/renderer/src/player/PlayerState.js';
import { applyPropertyDataIdUpdate, applyPublicUpdatePropertyInt, type ServerObject } from '../packages/renderer/src/world/ServerObjectManager.js';
import { Adapter1999, emptyCodecs, eol } from '../packages/network/src/era1999/Adapter1999.js';
import { registerPlayer1999 } from '../packages/network/src/era1999/codecs/Player1999.js';
import { deserializeMessage } from '../packages/network/src/MessageSerializer.js';

const OBJ = 0x80000a1b;

/** The payload GDLE writes after the opcode (WeenieObject.cpp). */
function removePayload(guid: number | null, key: number, seq = 0x2a): Uint8Array {
  const w = new BinaryWriter();
  w.writeUInt8(seq);
  if (guid !== null) w.writeUInt32(guid);
  w.writeUInt32(key);
  return w.toBuffer();
}

function handlerWith(h: ServerMessageHandlers): ServerMessageHandler {
  const s = new ServerMessageHandler();
  s.setHandlers(h);
  return s;
}

function send(s: ServerMessageHandler, opcode: number, payload: Uint8Array): void {
  s.handleMessage({ type: 'direct', opcode, payload });
}

describe('opcode numbers match the retail dispatch switch', () => {
  it('0x1D1..0x1DE and 0x2B8/0x2B9', () => {
    expect(GameMessageOpcode.PrivateRemovePropertyInt).toBe(0x1d1);
    expect(GameMessageOpcode.PublicRemovePropertyInt).toBe(0x1d2);
    expect(GameMessageOpcode.PrivateRemovePropertyBool).toBe(0x1d3);
    expect(GameMessageOpcode.PublicRemovePropertyBool).toBe(0x1d4);
    expect(GameMessageOpcode.PrivateRemovePropertyFloat).toBe(0x1d5);
    expect(GameMessageOpcode.PublicRemovePropertyFloat).toBe(0x1d6);
    expect(GameMessageOpcode.PrivateRemovePropertyString).toBe(0x1d7);
    expect(GameMessageOpcode.PublicRemovePropertyString).toBe(0x1d8);
    expect(GameMessageOpcode.PrivateRemovePropertyDataID).toBe(0x1d9);
    expect(GameMessageOpcode.PublicRemovePropertyDataID).toBe(0x1da);
    expect(GameMessageOpcode.PrivateRemovePropertyInstanceID).toBe(0x1db);
    expect(GameMessageOpcode.PublicRemovePropertyInstanceID).toBe(0x1dc);
    expect(GameMessageOpcode.PrivateRemovePosition).toBe(0x1dd);
    expect(GameMessageOpcode.PublicRemovePosition).toBe(0x1de);
    expect(GameMessageOpcode.PrivateRemovePropertyInt64).toBe(0x2b8);
    expect(GameMessageOpcode.PublicRemovePropertyInt64).toBe(0x2b9);
  });
});

describe('each remove event reaches the matching update handler with the default value and removed: true', () => {
  const cases: Array<[string, number, keyof ServerMessageHandlers, boolean, PropertyUpdateData['value']]> = [
    ['Int', 0x1d1, 'onPrivateUpdatePropertyInt', false, 0],
    ['Int', 0x1d2, 'onPublicUpdatePropertyInt', true, 0],
    ['Int64', 0x2b8, 'onPrivateUpdatePropertyInt64', false, 0n],
    ['Int64', 0x2b9, 'onPublicUpdatePropertyInt64', true, 0n],
    ['Bool', 0x1d3, 'onPrivateUpdatePropertyBool', false, false],
    ['Bool', 0x1d4, 'onPublicUpdatePropertyBool', true, false],
    ['Float', 0x1d5, 'onPrivateUpdatePropertyFloat', false, 0],
    ['Float', 0x1d6, 'onPublicUpdatePropertyFloat', true, 0],
    ['String', 0x1d7, 'onPrivateUpdatePropertyString', false, ''],
    ['String', 0x1d8, 'onPublicUpdatePropertyString', true, ''],
    ['DataID', 0x1d9, 'onPrivateUpdatePropertyDataID', false, 0],
    ['DataID', 0x1da, 'onPublicUpdatePropertyDataID', true, 0],
    ['InstanceID', 0x1db, 'onPrivateUpdatePropertyInstanceID', false, 0],
    ['InstanceID', 0x1dc, 'onPublicUpdatePropertyInstanceID', true, 0],
  ];
  for (const [type, op, name, isPublic, def] of cases) {
    it(`0x${op.toString(16)} ${isPublic ? 'public' : 'private'} ${type} → ${name}`, () => {
      const fn = vi.fn();
      const unhandled = vi.fn();
      const s = handlerWith({ [name]: fn });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (s as any).logUnhandled = unhandled;
      send(s, op, removePayload(isPublic ? OBJ : null, 77));
      expect(unhandled).not.toHaveBeenCalled();
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn.mock.calls[0][0]).toEqual({ guid: isPublic ? OBJ : 0, key: 77, value: def, removed: true });
    });
  }

  it('position removes reach their own handlers', () => {
    const priv = vi.fn();
    const pub = vi.fn();
    const s = handlerWith({ onPrivateRemovePosition: priv, onPublicRemovePosition: pub });
    send(s, 0x1dd, removePayload(null, 14));
    send(s, 0x1de, removePayload(OBJ, 2));
    expect(priv).toHaveBeenCalledWith({ guid: 0, positionType: 14 });
    expect(pub).toHaveBeenCalledWith({ guid: OBJ, positionType: 2 });
  });

  it('an ordinary update carries no removed flag', () => {
    const fn = vi.fn();
    const s = handlerWith({ onPrivateUpdatePropertyInt: fn });
    const w = new BinaryWriter(); w.writeUInt8(1); w.writeUInt32(PropertyInt.AllegianceRank); w.writeInt32(3);
    send(s, GameMessageOpcode.PrivateUpdatePropertyInt, w.toBuffer());
    expect(fn.mock.calls[0][0]).toEqual({ guid: 0, key: PropertyInt.AllegianceRank, value: 3 });
  });
});

describe('update then remove leaves the key absent in the real stores', () => {
  function updateInt(key: number, value: number): Uint8Array {
    const w = new BinaryWriter(); w.writeUInt8(1); w.writeUInt32(key); w.writeInt32(value); return w.toBuffer();
  }

  it('PlayerState int mirror: GDLE allegiance break (AllegianceManager.cpp RemoveInt ALLEGIANCE_RANK_INT + Notify)', () => {
    const ps = new PlayerState();
    const notified: PropertyUpdateData[] = [];
    const s = handlerWith({
      onPrivateUpdatePropertyInt: (d) => {
        notified.push(d);
        ps.applyServerIntProp(d.key, d.value as number, d.removed);
        if (d.key === PropertyInt.AllegianceRank) ps.allegianceRank = d.value as number;
      },
    });
    send(s, GameMessageOpcode.PrivateUpdatePropertyInt, updateInt(PropertyInt.AllegianceRank, 4));
    expect(ps.serverIntProps.get(PropertyInt.AllegianceRank)).toBe(4);
    expect(ps.allegianceRank).toBe(4);
    send(s, GameMessageOpcode.PrivateRemovePropertyInt, removePayload(null, PropertyInt.AllegianceRank));
    expect(ps.serverIntProps.has(PropertyInt.AllegianceRank)).toBe(false);
    expect(ps.allegianceRank).toBe(0);
    expect(notified).toHaveLength(2);
    expect(notified[1].removed).toBe(true);
  });

  it('PlayerState bools: GDLE login clears IS_ADVOCATE (Player.cpp RemoveBool)', () => {
    const ps = new PlayerState();
    const s = handlerWith({ onPrivateUpdatePropertyBool: (d) => { ps.applyServerBool(d.key, d.value as boolean); } });
    const w = new BinaryWriter(); w.writeUInt8(1); w.writeUInt32(PropertyBool.IsAdvocate); w.writeUInt32(1);
    send(s, GameMessageOpcode.PrivateUpdatePropertyBool, w.toBuffer());
    expect(ps.isAdvocate).toBe(true);
    send(s, GameMessageOpcode.PrivateRemovePropertyBool, removePayload(null, PropertyBool.IsAdvocate));
    expect(ps.isAdvocate).toBe(false);
  });

  it('inventory item: a public Int remove (core plating deintegrator clears an int on a pack item)', () => {
    const inv = new InventoryManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inv.addItem({ name: 'Healing Kit', structure: 10, maxStructure: 10 } as any, OBJ);
    let dirty = 0;
    const s = handlerWith({ onPublicUpdatePropertyInt: (d) => { if (inv.applyPublicPropertyInt(d.guid, d.key, d.value as number)) dirty++; } });
    send(s, GameMessageOpcode.PublicRemovePropertyInt, removePayload(OBJ, PropertyInt.Structure));
    expect(inv.getItem(OBJ)?.structure).toBe(0);
    expect(dirty).toBe(1);
  });

  it('inventory item: a public DataID remove drops the icon overlay', () => {
    const inv = new InventoryManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inv.addItem({ name: 'Breastplate', iconOverlayDid: 0x06005b0c } as any, OBJ);
    const s = handlerWith({ onPublicUpdatePropertyDataID: (d) => { inv.applyPublicPropertyDataId(d.guid, d.key, d.value as number); } });
    send(s, GameMessageOpcode.PublicRemovePropertyDataID, removePayload(OBJ, PropertyDataId.IconOverlay));
    expect(inv.getItem(OBJ)?.iconOverlayDid).toBeUndefined();
  });

  it('world object: a public Int / DataID remove clears the mirrored field', () => {
    const obj = { guid: OBJ, radarColor: 5, iconOverlayId: 0x06001234 } as unknown as ServerObject;
    const s = handlerWith({
      onPublicUpdatePropertyInt: (d) => applyPublicUpdatePropertyInt(obj, d.key, d.value as number),
      onPublicUpdatePropertyDataID: (d) => applyPropertyDataIdUpdate(obj, d.key, d.value as number),
    });
    send(s, GameMessageOpcode.PublicRemovePropertyInt, removePayload(OBJ, PropertyInt.RadarBlipColor));
    send(s, GameMessageOpcode.PublicRemovePropertyDataID, removePayload(OBJ, PropertyDataId.IconOverlay));
    expect(obj.radarColor).toBe(0);
    expect(obj.iconOverlayId).toBe(0);
  });
});

describe('PublicUpdatePropertyString field order (sweep)', () => {
  function stringUpdate(a: number, b: number, value: string): Uint8Array {
    const w = new BinaryWriter();
    w.writeUInt8(3); w.writeUInt32(a); w.writeUInt32(b);
    // payload offset 9 → align to the message's 4-byte boundary (opcode included: 13 → 16)
    w.writeUInt8(0); w.writeUInt8(0); w.writeUInt8(0);
    w.writeString16(value);
    return w.toBuffer();
  }
  it('GDLE / retail order: seq, guid, key (HandleStringUpdateEvents @ 0055a980)', () => {
    const fn = vi.fn();
    send(handlerWith({ onPublicUpdatePropertyString: fn }), GameMessageOpcode.PublicUpdatePropertyString, stringUpdate(OBJ, 1, 'Renamed'));
    expect(fn.mock.calls[0][0]).toEqual({ guid: OBJ, key: 1, value: 'Renamed' });
  });
  it('ACE order: seq, key, guid (GameMessagePublicUpdatePropertyString.cs)', () => {
    const fn = vi.fn();
    send(handlerWith({ onPublicUpdatePropertyString: fn }), GameMessageOpcode.PublicUpdatePropertyString, stringUpdate(1, 0x50000004, 'Renamed'));
    expect(fn.mock.calls[0][0]).toEqual({ guid: 0x50000004, key: 1, value: 'Renamed' });
  });
});

describe('AC1999: the server\'s Int64 removes (0x2B8/0x2B9) pass through renumbered', () => {
  it('private Int64 remove of 1999 key 5 (AvailableLuminance) → EoL key 6, removed', () => {
    const c = emptyCodecs();
    registerPlayer1999(c);
    const logs: string[] = [];
    const a = new Adapter1999(c, { account: 'x', log: (m) => logs.push(m) });
    a.outbound(eol(0xf657, (w) => { w.writeUInt32(0x50000003); w.writeString16('x'); }));
    const raw = new BinaryWriter(); raw.writeUInt32(0x2b8); raw.writeUInt8(9); raw.writeUInt32(5);
    const out = a.inbound(raw.toBuffer(), 4);
    expect(out).toHaveLength(1);
    const m = deserializeMessage(out[0]);
    if (m.type !== 'direct') throw new Error('expected a direct message');
    const fn = vi.fn();
    send(handlerWith({ onPrivateUpdatePropertyInt64: fn }), m.opcode, m.payload);
    expect(fn.mock.calls[0][0]).toEqual({ guid: 0, key: PropertyInt64.AvailableLuminance, value: 0n, removed: true });
  });
});
