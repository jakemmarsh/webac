/**
 * The 1999 inventory / container / vendor / appraisal codecs
 * (packages/network/src/era1999/codecs/Inventory1999.ts). No capture of these exists yet, so:
 * outbound, each action is built with OUR real builders (serializeGameAction + build*Payload),
 * translated, and read back the way the AC1999 server's ClientEvents.cpp reads it; inbound, each
 * message is built per the AC1999 server's writer (ObjectMsgs.cpp, Vendor.cpp, Appraisal.cpp, …),
 * translated, and fed to our REAL ServerMessageHandler.
 */
import { describe, expect, it } from 'vitest';
import { Adapter1999, emptyCodecs } from '../packages/network/src/era1999/Adapter1999.js';
import { registerInventory1999 } from '../packages/network/src/era1999/codecs/Inventory1999.js';
import { registerObjects1999 } from '../packages/network/src/era1999/codecs/Objects1999.js';
import type { Player1999State } from '../packages/network/src/era1999/codecs/Player1999.js';
import { Writer1999 } from '../packages/network/src/era1999/Wire1999.js';
import {
  BinaryWriter, buildBuyPayload, buildGetAndWieldItemPayload, buildGiveObjectRequestPayload, buildPutItemInContainerPayload,
  buildSellPayload, buildSetInscriptionPayload, buildStackableMergePayload, buildStackableSplitTo3DPayload,
  buildStackableSplitToContainerPayload, buildStackableSplitToWieldPayload, buildUseWithTargetPayload, deserializeMessage,
  serializeGameAction, serializeGameEvent,
} from '../packages/network/src/MessageSerializer.js';
import { buildItemAppraisalText } from '../packages/renderer/src/ui/examine/ItemAppraisalText.js';
import { GameActionType } from '../packages/network/src/GameActionType.js';
import { APPRAISAL_1999_INT, APPRAISAL_1999_STRING } from '@ac/shared';
import { ServerMessageHandler, type IdentifyResponseData } from '../packages/renderer/src/network/ServerMessageHandler.js';

const PLAYER = 0x50000003;

function adapter() {
  const logs: string[] = [];
  const c = emptyCodecs();
  registerObjects1999(c, { movement: (b) => b });
  const player = { guid: PLAYER, eventSequence: 100 } as Player1999State;
  registerInventory1999(c, { player: () => player });
  return { a: new Adapter1999(c, { account: 'acjs', log: (m) => logs.push(m) }), logs };
}

function recording() {
  const got: Record<string, any[]> = {};
  const rec = (k: string) => (d: unknown) => { (got[k] ??= []).push(d); };
  const h = new ServerMessageHandler();
  h.setHandlers({
    onInventoryPut: rec('put'), onWieldObject: rec('wield'), onInventoryPutIn3D: rec('put3d'),
    onCloseGroundContainer: rec('close'), onInventoryServerSaveFailed: rec('failed'),
    onQueryItemManaResponse: rec('mana'), onApproachVendor: rec('vendor'), onIdentifyResponse: rec('identify'),
    onSetStackSize: rec('stack'), onInventoryRemove: rec('remove'),
  });
  const feed = (msgs: Uint8Array[]) => { for (const m of msgs) h.handleMessage(deserializeMessage(m)); };
  return { got, feed };
}

const u32s = (b: Uint8Array) => Array.from({ length: b.length >> 2 }, (_, i) => new DataView(b.buffer, b.byteOffset).getUint32(i * 4, true));
const SEQ = 7;
const act = (type: GameActionType, payload: Uint8Array) => serializeGameAction(SEQ, type, payload);
const dw = (...v: number[]) => { const w = new BinaryWriter(4 * v.length); for (const x of v) w.writeUInt32(x); return w.toBuffer(); };

/** A 0xF7B0-wrapped 1999 event, as the server's QueueNetMessage builds it (EventHeader + the message). */
const wrapped = (type: number, body: (w: Writer1999) => void, guid = PLAYER, seq = 42) => {
  const w = new Writer1999().u32(0xf7b0).u32(guid).u32(seq).u32(type);
  body(w);
  return w.toBytes();
};
const flat = (op: number, body: (w: Writer1999) => void) => { const w = new Writer1999().u32(op); body(w); return w.toBytes(); };

describe('outbound inventory actions: our builders → the bytes ClientEvents.cpp reads', () => {
  const cases: Array<[string, GameActionType, Uint8Array, number[]]> = [
    // STORE_ITEM: item, container, slot
    ['PutItemInContainer', GameActionType.PutItemInContainer, buildPutItemInContainerPayload(0x6000001, PLAYER, 3), [0x6000001, PLAYER, 3]],
    // EQUIP_ITEM: item, coverage
    ['GetAndWieldItem', GameActionType.GetAndWieldItem, buildGetAndWieldItemPayload(0x6000001, 0x100000), [0x6000001, 0x100000]],
    // DROP_ITEM: item (main.ts builds this payload by hand)
    ['DropItem', GameActionType.DropItem, dw(0x6000002), [0x6000002]],
    // USE_ITEM_EX: source, dest
    ['UseWithTarget', GameActionType.UseWithTarget, buildUseWithTargetPayload(0x6000003, 0x6000004), [0x6000003, 0x6000004]],
    // STACKABLE_MERGE: from, to, amount
    ['StackableMerge', GameActionType.StackableMerge, buildStackableMergePayload(0x6000005, 0x6000006, 25), [0x6000005, 0x6000006, 25]],
    // STACKABLE_SPLIT_TO_CONTAINER: stack, container, place, amount
    ['StackableSplitToContainer', GameActionType.StackableSplitToContainer, buildStackableSplitToContainerPayload(0x6000005, PLAYER, 2, 10), [0x6000005, PLAYER, 2, 10]],
    // STACKABLE_SPLIT_TO_3D: stack, amount
    ['StackableSplitTo3D', GameActionType.StackableSplitTo3D, buildStackableSplitTo3DPayload(0x6000005, 4), [0x6000005, 4]],
    // STACKABLE_SPLIT_TO_WIELD: stack, loc, amount
    ['StackableSplitToWield', GameActionType.StackableSplitToWield, buildStackableSplitToWieldPayload(0x6000007, 0x800000, 30), [0x6000007, 0x800000, 30]],
    // GIVE_OBJECT: target, object, amount
    ['GiveObjectRequest', GameActionType.GiveObjectRequest, buildGiveObjectRequestPayload(0x6000008, 0x6000009, 1), [0x6000008, 0x6000009, 1]],
    // NO_LONGER_VIEWING_CONTAINER: container (CloseCurrentContainer.ts builds it by hand)
    ['NoLongerViewingContents', GameActionType.NoLongerViewingContents, dw(0x7000001), [0x7000001]],
    // ITEM_MANA_REQUEST: item (0 = the selection cleared; the server returns on 0)
    ['QueryItemMana', GameActionType.QueryItemMana, dw(0), [0]],
  ];
  for (const [name, type, payload, fields] of cases) {
    it(`${name} (0x${type.toString(16)}) keeps its type and dwords`, () => {
      const { a } = adapter();
      const out = a.outbound(act(type, payload));
      expect(out).toHaveLength(1);
      expect(out![0].group).toBe(5);
      expect(u32s(out![0].message)).toEqual([0xf7b1, SEQ, type, ...fields]);
    });
  }

  it('a short action is refused, not padded', () => {
    const { a, logs } = adapter();
    expect(a.outbound(act(GameActionType.PutItemInContainer, dw(1, 2)))).toBeNull();
    expect(logs.some((l) => /failed to translate/.test(l))).toBe(true);
  });

  it('Buy / Sell become 1999 ItemProfiles (24-bit amount, high byte clear = no descriptor)', () => {
    const { a, logs } = adapter();
    const buy = a.outbound(act(GameActionType.Buy, buildBuyPayload(0x7000010, [{ amount: 3, objectId: 0x7000011 }, { amount: 1, objectId: 0x7000012 }])));
    expect(u32s(buy![0].message)).toEqual([0xf7b1, SEQ, 0x5f, 0x7000010, 2, 3, 0x7000011, 1, 0x7000012]);
    const sell = a.outbound(act(GameActionType.Sell, buildSellPayload(0x7000010, [{ amount: 0x1000005, objectGuid: 0x6000020 }])));
    // ItemProfile::UnPack: (packed & 0xFF000000) != 0 would read a PublicWeenieDesc next; the amount is masked.
    expect(u32s(sell![0].message)).toEqual([0xf7b1, SEQ, 0x60, 0x7000010, 1, 0x000005, 0x6000020]);
    expect(logs.some((l) => /24 bits/.test(l))).toBe(true);
  });

  /** BinaryReader::ReadString + ReadAlign (PhatSDK BinaryReader.cpp): u16 n, n bytes, align to 4 from the message start. */
  function serverReadString(m: Uint8Array, at: number): { text: string; next: number } {
    const n = m[at] | (m[at + 1] << 8);
    const raw = m.subarray(at + 2, at + 2 + n);
    const end = raw.indexOf(0);
    return { text: Buffer.from(end >= 0 ? raw.subarray(0, end) : raw).toString('latin1'), next: (at + 2 + n + 3) & ~3 };
  }

  it('SetInscription: String16 → AcString, which INSCRIBE reads as the same text', () => {
    const { a } = adapter();
    for (const text of ['Hi', 'Made by Acjs', '']) {
      const m = a.outbound(act(GameActionType.SetInscription, buildSetInscriptionPayload(0x6000030, text)))![0].message;
      expect(u32s(m.subarray(0, 16))).toEqual([0xf7b1, SEQ, 0xbf, 0x6000030]);
      const len = m[16] | (m[17] << 8);
      expect(len).toBe(text ? text.length + 1 : 0); // AcString counts the NUL; empty = bare 0
      const { text: read, next } = serverReadString(m, 16);
      expect(read).toBe(text);
      expect(next).toBeGreaterThanOrEqual(m.length);
      if (text) expect(m.length % 4).toBe(0);
    }
  });
});

describe('inbound inventory events (0xF7B0-wrapped by the 1999 server, or flat)', () => {
  it('0x22 / 0x23 / 0x19A / 0x52 / 0xA0 / 0x264 reach their handlers, wrapped and flat', () => {
    const { a } = adapter();
    const { got, feed } = recording();
    const msgs = [
      wrapped(0x22, (w) => w.u32(0x6000001).u32(PLAYER).u32(4).u32(1)),
      flat(0x22, (w) => w.u32(0x6000002).u32(0x6000099).u32(0).u32(0)),
      wrapped(0x23, (w) => w.u32(0x6000001).u32(0x200000)),
      wrapped(0x19a, (w) => w.u32(0x6000003)),
      wrapped(0x52, (w) => w.u32(0x7000005)),
      wrapped(0xa0, (w) => w.u32(0x6000004).i32(0x29)),
      wrapped(0x264, (w) => w.u32(0x6000005).f32(0.5).u32(1)),
    ];
    for (const m of msgs) {
      const out = a.inbound(m, 4);
      expect(out).toHaveLength(1);
      // Every one is an EoL GameEvent for the player (the flat one gets the player's guid from the session).
      expect(u32s(out[0].subarray(0, 4))[0]).toBe(0xf7b0);
      expect(u32s(out[0].subarray(4, 8))[0]).toBe(PLAYER);
      feed(out);
    }
    expect(got.put).toEqual([
      { itemGuid: 0x6000001, containerGuid: PLAYER, slot: 4, itemType: 1 },
      { itemGuid: 0x6000002, containerGuid: 0x6000099, slot: 0, itemType: 0 },
    ]);
    expect(got.wield).toEqual([{ itemGuid: 0x6000001, location: 0x200000 }]);
    expect(got.put3d).toEqual([{ itemGuid: 0x6000003 }]);
    expect(got.close).toEqual([{ containerGuid: 0x7000005 }]);
    expect(got.failed).toEqual([{ itemGuid: 0x6000004, errorType: 0x29 }]);
    expect(got.mana).toEqual([{ targetGuid: 0x6000005, mana: 0.5, success: 1 }]);
  });

  it('a wrapped event keeps the server\'s envelope; a flat one takes the player\'s next event sequence', () => {
    const { a } = adapter();
    const w = a.inbound(wrapped(0x52, (x) => x.u32(1), PLAYER, 42), 4)[0];
    expect(u32s(w.subarray(0, 12))).toEqual([0xf7b0, PLAYER, 42]);
    const f1 = a.inbound(flat(0x52, (x) => x.u32(1)), 4)[0];
    const f2 = a.inbound(flat(0x52, (x) => x.u32(1)), 4)[0];
    expect(u32s(f1.subarray(0, 12))).toEqual([0xf7b0, PLAYER, 101]);
    expect(u32s(f2.subarray(0, 12))).toEqual([0xf7b0, PLAYER, 102]);
  });

  it('0x197 SetStackSize gains end of retail\'s sequence byte; 0x24 passes to remove', () => {
    const { a } = adapter();
    const { got, feed } = recording();
    feed(a.inbound(flat(0x197, (w) => w.u32(0x6000006).u32(75).u32(75)), 4));
    feed(a.inbound(flat(0x197, (w) => w.u32(0x6000006).u32(70).u32(70)), 4));
    feed(a.inbound(flat(0x24, (w) => w.u32(0x6000007)), 4));
    expect(got.stack).toEqual([
      { sequence: 1, guid: 0x6000006, stackSize: 75, value: 75 },
      { sequence: 2, guid: 0x6000006, stackSize: 70, value: 70 },
    ]);
    expect(got.remove).toEqual([{ itemGuid: 0x6000007 }]);
  });
});

/** A 1999 PublicWeenieDesc (OldPublicWeenieDesc::Pack order, KB 01-header). */
function pwd1999(w: Writer1999, o: { name: string; wcid: number; icon: number; value: number; stack?: number; maxStack?: number; plural?: string; container: number }): void {
  let header = 0x8 | 0x4000;
  if (o.plural) header |= 0x1;
  if (o.stack !== undefined) header |= 0x1000 | 0x2000;
  w.u32(header).acString(o.name).u16(o.wcid).u16(o.icon).u32(0x80).u32(0x10); // TYPE_MISC, BF_ATTACKABLE-ish bitfield
  if (o.plural) w.acString(o.plural);
  w.u32(o.value);
  if (o.stack !== undefined) w.u16(o.stack).u16(o.maxStack!);
  w.u32(o.container);
  w.align4();
}

describe('0x62 ApproachVendor', () => {
  const VENDOR = 0x7000020;
  const body = (w: Writer1999) => {
    w.u32(VENDOR);
    w.u32(0x80 | 0x2).i32(5).i32(10000).i32(0).f32(1.25).f32(0.6); // VendorProfile, 24 bytes
    w.u32(2);
    w.u32(0xff000000 | 0xffffff).u32(0x7000021); // unlimited stock (-1 in 24 bits)
    pwd1999(w, { name: 'Pyreal', wcid: 273, icon: 0x1234, value: 1, stack: 1, maxStack: 5000, plural: 'Pyreals', container: VENDOR });
    w.u32(0xff000000 | 3).u32(0x7000022);
    pwd1999(w, { name: 'Healing Kit', wcid: 628, icon: 0x0abc, value: 40, container: VENDOR });
  };

  for (const [label, msg] of [['wrapped', wrapped(0x62, body)], ['flat', flat(0x62, body)]] as const) {
    it(`${label}: the profile and both wares parse with parseApproachVendor, descriptors via the 0xF745 codec`, () => {
      const { a, logs } = adapter();
      const { got, feed } = recording();
      const out = a.inbound(msg, 4);
      expect(logs).toEqual([]);
      feed(out);
      expect(got.vendor).toHaveLength(1);
      const v = got.vendor[0].parsed;
      expect(v.vendorGuid).toBe(VENDOR);
      expect([v.merchandiseItemTypes, v.merchandiseMinValue, v.merchandiseMaxValue, v.dealMagicalItems]).toEqual([0x82, 5, 10000, false]);
      expect(v.buyPrice).toBeCloseTo(1.25);
      expect(v.sellPrice).toBeCloseTo(0.6);
      expect([v.alternateCurrency, v.altCurrencyAmount, v.altCurrencyName]).toEqual([0, 0, '']);
      expect(v.items).toHaveLength(2);
      const [pyreal, kit] = v.items;
      expect([pyreal.guid, pyreal.name, pyreal.weenieClassId, pyreal.iconId, pyreal.value, pyreal.pluralName]).toEqual([0x7000021, 'Pyreal', 273, 0x06001234, 1, 'Pyreals']);
      expect(pyreal.stackSize).toBe(-1);
      expect(pyreal.maxStackSize).toBe(5000);
      expect([kit.guid, kit.name, kit.weenieClassId, kit.iconId, kit.value, kit.stackSize]).toEqual([0x7000022, 'Healing Kit', 628, 0x06000abc, 40, 3]);
    });
  }

  it('without the 0xF745 codec the wares cannot be read: refused, logged', () => {
    const c = emptyCodecs();
    registerInventory1999(c);
    const logs: string[] = [];
    const a = new Adapter1999(c, { account: 'acjs', log: (m) => logs.push(m) });
    expect(a.inbound(wrapped(0x62, body), 4)).toEqual([]);
    expect(logs.join('\n')).toMatch(/0xF745/);
  });
});

describe('0xC9 IdentifyObjectResponse: the 1999 fixed-field AppraisalProfile → end-of-retail tables', () => {
  function identify(build: (w: Writer1999) => void, obj = 0x6000040): IdentifyResponseData {
    const { a, logs } = adapter();
    const { got, feed } = recording();
    const out = a.inbound(wrapped(0xc9, (w) => { w.u32(obj); build(w); }), 4);
    expect(logs).toEqual([]);
    expect(out).toHaveLength(1);
    feed(out);
    expect(got.identify).toHaveLength(1);
    return got.identify[0];
  }

  it('a magic weapon: weapon profile, value/burden, use + description, weapon enchantments, magic ints', () => {
    const d = identify((w) => {
      w.u32(0x2 | 0x8 | 0x400 | 0x20000 | 0x200000 | 0x800000).i32(1);
      // WeaponProfile (56 bytes): type, time, skill, damage, variance, length, maxVelocity, defense, offense
      w.u32(0x1).i32(35).u32(0x2c).i32(12).f64(0.5).f64(1.1).f64(0).f64(1.05).f64(1.1);
      w.u32(0xffffffff).u32(450).u32(150); // mass (absent), Value, EncumbVal
      w.acString('Wield it.');
      w.acString('A finely made sword.');
      w.u32(0x00080008); // weapon ench bits: highlight 0x8, color 0x8
      w.u32(150).u32(200).u32(0xffffffff).u32(500).u32(1000).u32(0xffffffff).u32(0);
      w.acString('');
      w.u32(0xffffffff).u32(0);
      w.acString('Blood Drinker I').acString('').f64(-1);
    });
    expect(d.success).toBe(true);
    expect(d.weaponProfile).toEqual({
      damageType: 1, weaponTime: 35, weaponSkill: 0x2c, damage: 12, damageVariance: 0.5, damageMod: 1,
      weaponLength: 1.1, maxVelocity: 0, weaponOffense: 1.1, maxVelocityEstimated: 0,
    });
    expect(d.propertiesFloat!.get(29)).toBeCloseTo(1.05); // WeaponDefense
    expect(Object.fromEntries(d.propertiesInt!)).toEqual({ 19: 450, 5: 150, 109: 150, 106: 200, 107: 500, 108: 1000 });
    expect(d.propertiesString!.get(14)).toBe('Wield it.');
    expect(d.propertiesString!.get(16)).toBe('A finely made sword.');
    expect(d.weaponEnchantment).toEqual({ highlight: 0x8, color: 0x8 });
    expect(d.spellBook).toBeUndefined(); // 1999 sends names, not ids
    expect(d.propertiesString!.get(APPRAISAL_1999_STRING.spellNames)).toBe('Blood Drinker I'); // the 1999 page's magic gate
  });

  it('armor: 7 floats → 8 (electric → lightning, no nether), armor level, armor enchantments', () => {
    const d = identify((w) => {
      w.u32(0x4 | 0x8000 | 0x100000).i32(1);
      for (const f of [1.0, 0.8, 1.2, 0.4, 0.6, 0.5, 0.9]) w.f32(f);
      w.u32(60);
      w.u32(0x00010001);
    });
    expect(d.armorProfile).toEqual({
      slashing: 1, piercing: Math.fround(0.8), bludgeoning: Math.fround(1.2), cold: Math.fround(0.4),
      fire: Math.fround(0.6), acid: 0.5, nether: 0, lightning: Math.fround(0.9),
    });
    expect(d.propertiesInt!.get(28)).toBe(60);
    expect(d.armorEnchantment).toEqual({ highlight: 1, color: 1 });
  });

  it('a chest: lock section, structure, inscription block, craftsman, level restriction', () => {
    const d = identify((w) => {
      w.u32(0x200 | 0x800 | 0x40 | 0x4000000 | 0x10 | 0x10000 | 0x80000).i32(1);
      w.i32(35); // lockpick success %
      w.u32(1); // locked
      w.i32(250); // resist lockpick
      w.acString('Acjs');
      w.acString('For the bold').acString('Scribe').acString('');
      w.u32(0xffffffff).u32(20).acString(' '); // max level 20; " " opens the client's gate only
      w.u32(8).u32(10);
    });
    expect(Object.fromEntries(d.propertiesInt!)).toEqual({ 173: 35, 38: 250, 87: 20, 92: 8, 91: 10 });
    expect(d.propertiesBool!.get(3)).toBe(true);
    // The " " filler is kept: it is what opens the 1999 panel's level-restriction gate (0x005df880).
    expect(Object.fromEntries(d.propertiesString!)).toEqual({ 25: 'Acjs', 7: 'For the bold', 8: 'Scribe', 38: ' ' });
  });

  it('a player: creature profile, attributes, char details → end of retail\'s character-page properties', () => {
    const d = identify((w) => {
      w.u32(0x1).i32(1);
      w.u32(0x8 | 0x4 | 0x2 | 0x1).u32(12).i32(40).i32(55);
      for (const v of [60, 50, 40, 30, 20, 10, 80, 90, 100, 110]) w.u32(v);
      w.u32(31); // creature type (human)
      w.u32(2).u32(3).u32(7).u32(9).u32(0); // rank, followers, loyalty (+0x40), leadership (+0x44), +0x88
      w.acString('Female').acString("Gharu'ndim").acString('Bow Hunter').acString('').acString('Lord Acjs');
      for (const v of [0x05001001, 0x05001002, 0x05001003, 0x04001004, 0x04001005, 0x04001006]) w.u32(v);
      w.u32(0x00020002);
    }, 0x50000009);
    expect(d.guid).toBe(0x50000009);
    expect(d.creatureProfile).toEqual({
      profileFlags: 0x9, health: 40, healthMax: 55,
      attributes: { strength: 60, endurance: 50, quickness: 40, coordination: 30, focus: 20, self: 10, stamina: 80, mana: 90, staminaMax: 100, manaMax: 110 },
      attributeHighlights: 2, attributeColors: 2,
    });
    // Loyalty / Leadership ride under APPRAISAL_1999_INT (the 1999 character examine panel's "No Allegiance" line).
    expect(Object.fromEntries(d.propertiesInt!)).toEqual({ 2: 31, 30: 2, 35: 3, 113: 2, 188: 2, 25: 12, [APPRAISAL_1999_INT.loyalty]: 7, [APPRAISAL_1999_INT.leadership]: 9 });
    expect(Object.fromEntries(d.propertiesString!)).toEqual({ 3: 'Female', 4: "Gharu'ndim", 5: 'Bow Hunter', 11: 'Lord Acjs', 21: 'Lord Acjs' });
    expect(Object.fromEntries(d.propertiesDataID!)).toEqual({ 9: 0x05001001, 10: 0x05001002, 11: 0x05001003, 15: 0x04001004, 16: 0x04001005, 17: 0x04001006 });
  });

  it('a failed appraisal of a player: level unknown (no Level), success false', () => {
    const d = identify((w) => {
      w.u32(0x1).i32(0);
      w.u32(0).u32(0xffffffff).i32(40).i32(55);
    });
    expect(d.success).toBe(false);
    expect(d.propertiesInt).toBeUndefined();
    expect(d.creatureProfile).toEqual({ profileFlags: 0, health: 40, healthMax: 55 });
  });

  it('a failed weapon appraisal: damage / speed -1 reach the panel as -1, which reads Unknown', () => {
    const d = identify((w) => {
      w.u32(0x2).i32(0);
      w.u32(0x1).i32(-1).u32(0x2c).i32(-1).f64(0.5).f64(1.1).f64(0).f64(1.05).f64(1.1);
    });
    expect(d.success).toBe(false);
    expect(d.weaponProfile!.weaponTime).toBe(-1);
    expect(d.weaponProfile!.damage).toBe(-1);
    const lines = buildItemAppraisalText(d, { appraisalSuccess: false, weenie: { validLocations: 0x100000 } }).text.split('\n');
    expect(lines).toContain('Damage: Unknown');
    expect(lines).toContain('Speed:  Unknown');
    expect(lines.join('\n')).not.toMatch(/4294967295/);
  });

  it('an end-of-retail weapon profile reads the same values as before (signed read, values far below 2^31)', () => {
    const { got, feed } = recording();
    const body = new BinaryWriter(96);
    body.writeUInt32(0x6000040); body.writeUInt32(0x20); body.writeUInt32(1); // guid, flags WeaponProfile, success
    for (const v of [4, 35, 0x2c, 0x7ffffffe]) body.writeUInt32(v);
    for (let i = 0; i < 5; i++) body.writeFloat64(0.5);
    body.writeUInt32(0);
    feed([serializeGameEvent(1, 0xc9, body.toBuffer(), PLAYER)]);
    expect(got.identify[0].weaponProfile.weaponTime).toBe(35);
    expect(got.identify[0].weaponProfile.damage).toBe(0x7ffffffe);
  });

  it('a flag bit 1999 UnPack does not read is refused, not guessed', () => {
    const { a, logs } = adapter();
    expect(a.inbound(wrapped(0xc9, (w) => w.u32(1).u32(0x8000000).i32(1).u32(0)), 4)).toEqual([]);
    expect(logs.join('\n')).toMatch(/unknown layout/);
  });
});
