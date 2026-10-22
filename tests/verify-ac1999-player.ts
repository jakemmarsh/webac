/**
 * The 1999 player codecs (packages/network/src/era1999/codecs/Player1999.ts):
 * the real 1999 server's flat PlayerDescription (0x0013) and property updates
 * from the committed session capture, translated to end-of-retail messages
 * and read by our REAL parsers (parsePlayerDescription, ServerMessageHandler).
 * Synthetic 1999 messages cover the layouts the capture lacks. Runs in CI
 * (the fixture is committed).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { decodeCapture, type Message1999 } from '../tools/ac1999/decode-capture.js';
import { Adapter1999, emptyCodecs, eol, type Codecs1999 } from '../packages/network/src/era1999/Adapter1999.js';
import { registerCharSelect1999 } from '../packages/network/src/era1999/codecs/CharSelect1999.js';
import { registerObjects1999 } from '../packages/network/src/era1999/codecs/Objects1999.js';
import { key1999ToEoL, registerPlayer1999, type Player1999State } from '../packages/network/src/era1999/codecs/Player1999.js';
import { Writer1999 } from '../packages/network/src/era1999/Wire1999.js';
import { BinaryWriter, deserializeMessage } from '../packages/network/src/MessageSerializer.js';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { parsePlayerDescription } from '../packages/renderer/src/network/PlayerDescriptionParser.js';
import { PlayerState } from '../packages/renderer/src/player/PlayerState.js';
import { AttributeId, PropertyDataId, PropertyInt, PropertyInt64, PropertyString } from '@ac/shared';

const capture: Message1999[] = decodeCapture(readFileSync(resolve(__dirname, 'fixtures', 'ac1999-session-001.jsonl.gz')))
  .filter((m) => m.dir === 's2c');

const GUID = 0x50000003;

function build(extra?: (c: Codecs1999) => void): { a: Adapter1999; st: Player1999State; logs: string[] } {
  const logs: string[] = [];
  const c = emptyCodecs();
  registerCharSelect1999(c);
  extra?.(c);
  const st = registerPlayer1999(c);
  return { a: new Adapter1999(c, { account: 'acjsdbja', log: (m) => logs.push(m) }), st, logs };
}

/**
 * Every EoL message the adapter makes from the whole capture, in order. The
 * page's CharacterEnterWorld goes out first, as in a live session (the
 * server's first 0x000E for the player precedes its 0xF746).
 */
function translateCapture(a: Adapter1999): Uint8Array[] {
  const enter = a.outbound(eol(0xf657, (w) => { w.writeUInt32(GUID); w.writeString16('acjsdbja'); }));
  expect(enter?.[0].message.length).toBe(36);
  return capture.flatMap((m) => a.inbound(m.data, m.group));
}

function playerDescription(out: Uint8Array[]) {
  const events = out.map((b) => deserializeMessage(b)).filter((m) => m.type === 'event' && m.eventType === 0x13);
  expect(events).toHaveLength(1);
  const ev = events[0];
  if (ev.type !== 'event') throw new Error('unreachable');
  return { ev, desc: parsePlayerDescription(ev.payload)! };
}

/** Drive the real ServerMessageHandler with every EoL message; returns the handler spies. */
function drive(out: Uint8Array[]) {
  const h = new ServerMessageHandler();
  const spies = {
    onPlayerDescription: vi.fn(), onPrivateUpdatePropertyInt: vi.fn(), onPublicUpdatePropertyInt: vi.fn(),
    onPrivateUpdatePropertyInt64: vi.fn(), onPrivateUpdatePropertyString: vi.fn(), onPublicUpdatePropertyString: vi.fn(),
    onPrivateUpdatePropertyBool: vi.fn(), onPublicUpdatePropertyBool: vi.fn(), onPrivateUpdatePropertyFloat: vi.fn(),
    onPublicUpdatePropertyFloat: vi.fn(), onPrivateUpdatePropertyDataID: vi.fn(), onPublicUpdatePropertyDataID: vi.fn(),
    onPrivateUpdatePropertyInstanceID: vi.fn(), onPublicUpdatePropertyInstanceID: vi.fn(),
    onPrivateUpdatePosition: vi.fn(), onPublicUpdatePosition: vi.fn(),
    onPrivateUpdateVital: vi.fn(), onPrivateUpdateAttribute2ndLevel: vi.fn(), onPublicUpdateVital: vi.fn(),
    onPrivateUpdateAttribute: vi.fn(), onPrivateUpdateSkill: vi.fn(),
  };
  h.setHandlers(spies);
  for (const b of out) h.handleMessage(deserializeMessage(b));
  return spies;
}

describe('the captured 1999 PlayerDescription → EoL 0xF7B0/0x0013', () => {
  const { a, st, logs } = build();
  const out = translateCapture(a);
  const { ev, desc } = playerDescription(out);

  it('is an EoL game event on the player guid', () => {
    expect(st.guid).toBe(GUID);
    expect(ev.objectGuid).toBe(GUID);
    expect(logs.filter((l) => l.includes('failed to translate') || l.includes('unread'))).toEqual([]);
  });

  it('parses to the end: name, level, XP, strings, options', () => {
    expect(desc.name).toBe('Acjsdbja'); // from the 0x000F the server sends first
    expect(desc.level).toBe(1);
    expect(desc.totalExperience).toBe(0n);
    expect(desc.propertiesInt.get(20)).toBe(100); // CoinValue
    expect(desc.propertiesInt.get(40)).toBe(1); // CombatMode NonCombat
    expect(desc.propertiesInt.has(22)).toBe(false); // 1999 available XP moved to Int64
    expect(desc.propertiesString.get(3)).toBe('Male');
    expect(desc.propertiesString.get(4)).toBe('Sho');
    expect(desc.propertiesString.get(5)).toBe('Sorcerer');
    expect(desc.propertiesDataId.size).toBe(4);
    expect(desc.positions.get(1)?.landblockId).toBe(0xde51001d);
    expect(desc.characterOptions1).toBe(0x50c4a542);
    expect(desc.characterOptions2).toBe(-1);
    expect(desc.spellbookFilters).toBe(0x3fff);
  });

  it('heritage Int 188 becomes the end-of-retail enum (the 1999 server stores the 0-based index); gender stays', () => {
    expect(desc.propertiesString.get(4)).toBe('Sho');
    expect(desc.propertiesInt.get(188)).toBe(3); // 1999 index 2 → HeritageGroup.Sho
    expect(desc.propertiesInt.get(113)).toBe(1); // Gender: the server stores the enum (Male = 1), as EoL does
  });

  it('carries the Sorcerer template attributes and vitals', () => {
    expect([desc.strength, desc.endurance, desc.quickness, desc.coordination, desc.focus, desc.self]
      .map((x) => (x!.startingValue + x!.ranks))).toEqual([40, 40, 30, 40, 90, 90]);
    expect([desc.health!.current, desc.stamina!.current, desc.mana!.current]).toEqual([20, 40, 90]);
  });

  it('carries 39 skills (EoL numbering, id 0 dropped) with Sorcerer specializations', () => {
    expect(desc.skills).toHaveLength(39);
    expect(desc.skills.some((s) => s.skillId === 0)).toBe(false);
    const spec = desc.skills.filter((s) => s.advancementClass === 3).map((s) => s.skillId).sort((x, y) => x - y);
    expect(spec).toEqual([14, 16, 34]); // Arcane Lore, Mana Conversion, War Magic
    const arcane = desc.skills.find((s) => s.skillId === 14)!;
    expect(arcane.ranks).toBe(10);
    expect(arcane.cpSpent).toBe(0x29f);
    const trained = desc.skills.filter((s) => s.advancementClass === 2).map((s) => s.skillId).sort((x, y) => x - y);
    expect(trained).toEqual([13, 15, 22, 24, 30, 36]);
  });

  it('carries the spellbook, inventory and equipment', () => {
    expect(desc.spellIds).toEqual([0x1b, 0x4b, 0x56]);
    expect([...desc.spellCharges1999.keys()]).toEqual([0x1b, 0x4b, 0x56]);
    for (const c of desc.spellCharges1999.values()) expect(c).toBeLessThan(2);
    expect(desc.inventoryPlacement).toHaveLength(13);
    expect(desc.inventoryPlacement[0]).toEqual({ guid: 0x9000005b, containerType: 0 });
    expect(desc.inventoryPlacement[12]).toEqual({ guid: 0x90000058, containerType: 1 });
    expect(desc.equippedPlacement).toEqual([
      { guid: 0x9000004b, wieldedLocation: 0x1, clothingPriority: 0x4000 },
      { guid: 0x9000004c, wieldedLocation: 0x1e, clothingPriority: 0x68 },
      { guid: 0x9000004d, wieldedLocation: 0x44, clothingPriority: 0x3 },
      { guid: 0x9000004e, wieldedLocation: 0x180, clothingPriority: 0x10000 },
    ]);
  });

  it('feeds the live updates into the real ServerMessageHandler', () => {
    const s = drive(out);
    expect(s.onPlayerDescription).toHaveBeenCalledTimes(1);
    const ints = s.onPrivateUpdatePropertyInt.mock.calls.map(([d]) => [d.key, d.value]);
    expect(ints).toEqual([[20, 100], [125, 16], [40, 1]]);
    expect(s.onPrivateUpdatePropertyString.mock.calls[0][0]).toMatchObject({ key: 1, value: 'Acjsdbja' });
    expect(s.onPrivateUpdateAttribute2ndLevel.mock.calls.map(([d]) => [d.key, d.value])).toEqual([[4, 33], [4, 36], [4, 39]]);
  });

  it('learns the guid from 0xF746 alone, wrapping an objects codec that owns it', () => {
    const b = build((c) => registerObjects1999(c));
    const out2 = capture.flatMap((m) => b.a.inbound(m.data, m.group));
    expect(b.st.guid).toBe(GUID);
    const pc = out2.map((m) => deserializeMessage(m)).filter((m) => m.type === 'direct' && m.opcode === 0xf746);
    expect(pc).toHaveLength(1);
    expect(playerDescription(out2).ev.objectGuid).toBe(GUID);
  });
});

// ── synthetic 1999 messages ─────────────────────────────────────────────

const msg = (op: number, f: (w: Writer1999) => void) => { const w = new Writer1999().u32(op); f(w); return w.toBytes(); };
const OTHER = 0x80001234;

function primed() {
  const b = build();
  b.a.inbound(msg(0xf746, (w) => w.u32(GUID)), 3);
  return b;
}

describe('1999 property updates → EoL private (own) / public (other) updates', () => {
  it('scalar updates', () => {
    const { a } = primed();
    const out = [
      msg(0x0e, (w) => w.u32(GUID).u32(25).i32(7)),
      msg(0x0e, (w) => w.u32(OTHER).u32(25).i32(9)),
      msg(0x0e, (w) => w.u32(GUID).u32(21).i32(12345)),
      msg(0x0e, (w) => w.u32(GUID).u32(40).i32(4)),
      msg(0x0f, (w) => w.u32(OTHER).u32(1).acString('Drudge')),
      msg(0x11, (w) => w.u32(GUID).u32(4).u32(0x30000001)),
      msg(0x11, (w) => w.u32(OTHER).u32(4).u32(0x30000002)),
      msg(0x2e, (w) => w.u32(GUID).u32(3).f64(1.5)),
      msg(0x2e, (w) => w.u32(OTHER).u32(3).f64(2.5)),
      msg(0x43, (w) => w.u32(GUID).u32(12).u32(1)),
      msg(0x43, (w) => w.u32(OTHER).u32(12).u32(0)),
      msg(0x43, (w) => w.u32(GUID).u32(4).u32(1)),
      msg(0x57, (w) => w.u32(GUID).u32(9).u32(OTHER)),
      msg(0x57, (w) => w.u32(OTHER).u32(9).u32(GUID)),
    ].flatMap((m) => a.inbound(m, 4));
    const s = drive(out);
    expect(s.onPrivateUpdatePropertyInt.mock.calls.map(([d]) => [d.key, d.value])).toEqual([[25, 7], [40, 8], [134, 4]]);
    expect(s.onPublicUpdatePropertyInt.mock.calls[0][0]).toEqual({ guid: OTHER, key: 25, value: 9 });
    expect(s.onPrivateUpdatePropertyInt64.mock.calls[0][0]).toMatchObject({ key: 1, value: 12345n });
    expect(s.onPublicUpdatePropertyString.mock.calls[0][0]).toEqual({ guid: OTHER, key: 1, value: 'Drudge' });
    expect(s.onPrivateUpdatePropertyDataID.mock.calls[0][0]).toMatchObject({ key: 4, value: 0x30000001 });
    expect(s.onPublicUpdatePropertyDataID.mock.calls[0][0]).toEqual({ guid: OTHER, key: 4, value: 0x30000002 });
    expect(s.onPrivateUpdatePropertyFloat.mock.calls[0][0]).toMatchObject({ key: 3, value: 1.5 });
    expect(s.onPublicUpdatePropertyFloat.mock.calls[0][0]).toEqual({ guid: OTHER, key: 3, value: 2.5 });
    expect(s.onPrivateUpdatePropertyBool.mock.calls[0][0]).toMatchObject({ key: 12, value: true });
    expect(s.onPublicUpdatePropertyBool.mock.calls[0][0]).toEqual({ guid: OTHER, key: 12, value: false });
    expect(s.onPrivateUpdatePropertyInstanceID.mock.calls[0][0]).toMatchObject({ key: 9, value: OTHER });
    expect(s.onPublicUpdatePropertyInstanceID.mock.calls[0][0]).toEqual({ guid: OTHER, key: 9, value: GUID });
  });

  it('heritage updates (Int 188) shift the 1999 0-based index to the EoL enum; a remove stays 0; -1 (any) passes', () => {
    const { a } = primed();
    const out = [
      msg(0x0e, (w) => w.u32(GUID).u32(188).i32(0)),
      msg(0x0e, (w) => w.u32(OTHER).u32(188).i32(1)),
      msg(0x0e, (w) => w.u32(OTHER).u32(188).i32(-1)),
      msg(0x0e, (w) => w.u32(GUID).u32(113).i32(2)),
      msg(0x1d1, (w) => w.u32(188)),
    ].flatMap((m) => a.inbound(m, 4));
    const s = drive(out);
    expect(s.onPrivateUpdatePropertyInt.mock.calls.map(([d]) => [d.key, d.value])).toEqual([[188, 1], [113, 2], [188, 0]]);
    expect(s.onPublicUpdatePropertyInt.mock.calls.map(([d]) => [d.key, d.value])).toEqual([[188, 2], [188, -1]]);
  });

  it('per-property sequence bytes increase', () => {
    const { a } = primed();
    const seqs = [1, 2, 3].map((v) => a.inbound(msg(0x0e, (w) => w.u32(GUID).u32(25).i32(v)), 4)[0][4]);
    expect(seqs).toEqual([1, 2, 3]);
    expect(a.inbound(msg(0x0e, (w) => w.u32(GUID).u32(26).i32(0)), 4)[0][4]).toBe(1);
  });

  it('position, attribute, skill and vital updates', () => {
    const { a } = primed();
    const pos = (w: Writer1999) => w.u32(0x905c003c).f32(10).f32(20).f32(30).f32(1).f32(0).f32(0).f32(0);
    const skill = (w: Writer1999, rank: number, sac: number) => w.u32(rank).i32(sac).u32(500).u32(0).i32(0).f64(0);
    const out = [
      msg(0x2d, (w) => pos(w.u32(GUID).u32(4))),
      msg(0x2d, (w) => pos(w.u32(OTHER).u32(4))),
      msg(0x26, (w) => w.u32(GUID).u32(1).u32(55).u32(0).u32(1000)),
      msg(0x2c, (w) => w.u32(GUID).u32(1).u32(56)),
      msg(0x28, (w) => skill(w.u32(GUID).u32(34), 12, 3)),
      msg(0x10, (w) => w.u32(GUID).u32(34).u32(13)),
      msg(0x2f, (w) => w.u32(GUID).u32(34).u32(2)),
      msg(0x29, (w) => w.u32(GUID).u32(1).u32(3).u32(0).u32(77).u32(25)),
      msg(0x29, (w) => w.u32(GUID).u32(6).u32(0).u32(0).u32(0).u32(88)),
      msg(0x29, (w) => w.u32(OTHER).u32(2).u32(0).u32(0).u32(0).u32(5)),
    ].flatMap((m) => a.inbound(m, 4));
    const s = drive(out);
    expect(s.onPrivateUpdatePosition.mock.calls[0][0]).toMatchObject({ positionType: 4, landblockId: 0x905c003c, x: 10, y: 20, z: 30, qw: 1 });
    expect(s.onPublicUpdatePosition.mock.calls[0][0]).toMatchObject({ guid: OTHER, positionType: 4, landblockId: 0x905c003c });
    expect(s.onPrivateUpdateAttribute.mock.calls.map(([d]) => [d.key, d.initLevel + d.levelFromCP, d.cpSpent]))
      .toEqual([[1, 55, 1000], [1, 56, 1000]]);
    expect(s.onPrivateUpdateSkill.mock.calls.map(([d]) => [d.key, d.points, d.advancementClass, d.cpSpent]))
      .toEqual([[34, 12, 3, 500], [34, 13, 3, 500], [34, 13, 2, 500]]);
    expect(s.onPrivateUpdateVital.mock.calls[0][0]).toMatchObject({ key: 1, levelFromCP: 3, cpSpent: 77, value: 25 });
    expect(s.onPrivateUpdateAttribute2ndLevel.mock.calls[0][0]).toMatchObject({ key: 6, value: 88 });
    expect(s.onPublicUpdateVital.mock.calls[0][0]).toMatchObject({ guid: OTHER, attribute: 2, currentValue: 5 });
  });

  it('removes become zero-value updates, in both the 1999 and the GDLE-timestamped width', () => {
    const { a, logs } = primed();
    const out = [
      msg(0x1d1, (w) => w.u32(25)),
      msg(0x1d1, (w) => w.u8(7).u32(26)),
      msg(0x1d2, (w) => w.u32(OTHER).u32(25)),
      msg(0x1d4, (w) => w.u8(1).u32(OTHER).u32(12)),
      msg(0x1d7, (w) => w.u32(16)),
      msg(0x1db, (w) => w.u32(9)),
    ].flatMap((m) => a.inbound(m, 4));
    expect(a.inbound(msg(0x1dd, (w) => w.u32(4)), 4)).toEqual([]);
    expect(logs.some((l) => l.includes('position remove'))).toBe(true);
    const s = drive(out);
    expect(s.onPrivateUpdatePropertyInt.mock.calls.map(([d]) => [d.key, d.value])).toEqual([[25, 0], [26, 0]]);
    expect(s.onPublicUpdatePropertyInt.mock.calls[0][0]).toEqual({ guid: OTHER, key: 25, value: 0 });
    expect(s.onPublicUpdatePropertyBool.mock.calls[0][0]).toEqual({ guid: OTHER, key: 12, value: false });
    expect(s.onPrivateUpdatePropertyString.mock.calls[0][0]).toMatchObject({ key: 16, value: '' });
    expect(s.onPrivateUpdatePropertyInstanceID.mock.calls[0][0]).toMatchObject({ key: 9, value: 0 });
  });

  it('the server\'s end-of-retail Int64 leftovers pass through', () => {
    const { a } = primed();
    const w = new BinaryWriter(32);
    w.writeUInt32(0x2cf); w.writeUInt8(3); w.writeUInt32(2); w.writeUInt32(5000); w.writeUInt32(0);
    const s = drive(a.inbound(w.toBuffer(), 4));
    expect(s.onPrivateUpdatePropertyInt64.mock.calls[0][0]).toMatchObject({ key: 2, value: 5000n });
  });

  it('attribute updates for other objects are dropped with a note', () => {
    const { a, logs } = primed();
    expect(a.inbound(msg(0x26, (w) => w.u32(OTHER).u32(1).u32(5).u32(0).u32(0)), 4)).toEqual([]);
    expect(logs.some((l) => l.includes('0x26 UpdateAttribute'))).toBe(true);
  });
});

describe('a synthetic 1999 PlayerDescription with hotbar, spell bar, XP, vitae', () => {
  function description(): Uint8Array {
    const w = new Writer1999().u32(0x13);
    w.u32(0x01 | 0x10).u32(0x0a);
    w.u16(4).u16(0x10).u32(25).i32(12).u32(21).i32(250000).u32(22).i32(1000).u32(40).i32(3);
    w.u16(1).u16(0x10).u32(5).acString('Bow Hunter');
    w.u32(0x001 | 0x002 | 0x100 | 0x200).u32(1);
    w.u32(0x1 | 0x40);
    w.u32(60).u32(0).u32(12345);
    w.u32(2).u32(0).u32(0).u32(30);
    w.u16(2).u16(0x20);
    w.u32(0).u32(1).i32(1).u32(0).u32(0).i32(0).f64(0); // skill 0: dropped
    w.u32(2).u32(7).i32(3).u32(900).u32(0).i32(0).f64(1.5);
    w.u16(1).u16(0x40).u32(0x3e1).f32(0.75).f32(0).f32(0.5); // charge, +0xC, likelihood
    w.u32(0x4); // vitae only
    w.u32(666 | (1 << 16)).u32(204).i32(0).f64(-10).f64(-1).u32(0).f32(0).f32(0).f64(0).u32(0x800000).u32(0).f32(0.95);
    w.u32(1).u32(0x400); // selectorFlags: hotbar; options ToggleRun
    w.u32(1).u32(3).u32(0x90000010).u32(0);
    w.u32(2).u32(0x3e1).u32(0x3e2);
    w.u32(1).u32(0x90000010).u32(0);
    w.u32(0);
    return w.toBytes();
  }

  it('reads through every section into the real parser', () => {
    const { a } = primed();
    a.inbound(msg(0x0f, (w) => w.u32(GUID).u32(1).acString('Archer')), 4);
    const { desc } = playerDescription(a.inbound(description(), 4));
    expect(desc.name).toBe('Archer');
    expect(desc.level).toBe(12);
    expect(desc.totalExperience).toBe(250000n);
    expect(desc.availableExperience).toBe(1000n);
    expect(desc.propertiesInt.get(40)).toBe(4); // missile 3 → EoL Missile 0x4
    expect(desc.propertiesString.get(5)).toBe('Bow Hunter');
    // f0 60 / f1 0 → ranks 60 (the level the 1999 client prices from), start 0 (BUG.ac1999-attribute-raise).
    expect(desc.strength).toEqual({ ranks: 60, startingValue: 0, cpSpent: 12345 });
    expect(desc.health).toEqual({ ranks: 2, startingValue: 0, cpSpent: 0, current: 30 });
    expect(desc.skills).toEqual([{ skillId: 2, ranks: 7, advancementClass: 3, cpSpent: 900, initLevel: 0 }]);
    expect(desc.spellIds).toEqual([0x3e1]);
    // The spell's Charge rides in the end-of-retail entry's f32 (below ACE's 2.0): VISUAL.ac1999-spell-charge.
    expect([...desc.spellCharges1999]).toEqual([[0x3e1, 0.75]]);
    expect(desc.vitae).toMatchObject({ spellId: 666, layer: 1, spellCategory: 204, statModValue: expect.closeTo(0.95, 5), isVitae: true });
    expect(desc.shortcuts).toEqual([{ index: 3, objectId: 0x90000010, spellId: 0, layer: 0 }]);
    expect(desc.spellBars[0]).toEqual([0x3e1, 0x3e2]);
    expect(desc.spellBars.slice(1).every((b) => b.length === 0)).toBe(true);
    expect(desc.characterOptions1).toBe(0x400);
    expect(desc.inventoryPlacement).toEqual([{ guid: 0x90000010, containerType: 0 }]);
    expect(desc.equippedPlacement).toEqual([]);
  });

  it('refuses a description carrying a table 1999 servers strip', () => {
    const { a, logs } = primed();
    const w = new Writer1999().u32(0x13).u32(0).u32(0x0a).u32(0x004).u32(1);
    expect(a.inbound(w.toBytes(), 4)).toEqual([]);
    expect(logs.some((l) => l.includes('Body'))).toBe(true);
  });
});

// The AC1999 server's STypeInt (PhatSDK/GameStatEnums.h) has no augmentation block, so its keys past 214
// sit below ACE's. Unmapped, NUM_CHARACTER_TITLES (230) read as AugmentationIncreasedCarryingCapacity
// and the carry capacity flipped between Strength × 150 and × 180 by session.
describe('1999 Int keys past 214 → end-of-retail PropertyInt numbering', () => {
  const intKey1999ToEoL = (k: number) => key1999ToEoL('int', k);
  it('maps each run, name-matched against ACE PropertyInt.cs', () => {
    expect([0, 5, 188, 214].map(intKey1999ToEoL)).toEqual([0, 5, 188, 214]);
    expect(intKey1999ToEoL(215)).toBe(247); // RARES_TIER_ONE_LOGIN → RaresTierOneLogin
    expect(intKey1999ToEoL(229)).toBe(PropertyInt.CharacterTitleId); // 261
    expect(intKey1999ToEoL(230)).toBe(PropertyInt.NumCharacterTitles); // 262
    expect(intKey1999ToEoL(261)).toBe(303); // IMBUED_EFFECT_2 → ImbuedEffect2
    expect(intKey1999ToEoL(267)).toBe(311); // IMBUE_STACKING_BITS → ImbueStackingBits
    expect(intKey1999ToEoL(343)).toBe(390); // ENLIGHTENMENT → Enlightenment
    expect(intKey1999ToEoL(344)).toBeNull(); // NUM_INT_STAT_VALUES: no property
  });

  it('maps the other property types the same way, and drops keys with no end-of-retail property', () => {
    expect([1, 2, 3, 5, 6, 7].map((k) => key1999ToEoL('int64', k))).toEqual([1, 2, 4, 6, 7, 8]); // luminance 5/6 → 6/7
    expect(key1999ToEoL('int64', 8)).toBeNull();
    expect([47, 48, 51].map((k) => key1999ToEoL('string', k))).toEqual([47, 49, 52]); // KillQuest2 49, GearPlatingName 52
    expect(key1999ToEoL('string', 52)).toBeNull();
    expect([52, 53, 54, 58].map((k) => key1999ToEoL('did', k))).toEqual([52, 55, 57, 61]); // ProcSpell, AlternateCurrency, OlthoiDeathTreasureType
    expect(key1999ToEoL('did', 59)).toBeNull();
    expect([4, 105, 130].map((k) => key1999ToEoL('bool', k))).toEqual([4, 105, 130]);
    expect([131, 132, 133].map((k) => key1999ToEoL('bool', k))).toEqual([null, null, null]); // MERGE_LOCKED, sentinel, XPGAIN_BOOL
    expect([key1999ToEoL('float', 171), key1999ToEoL('float', 172)]).toEqual([171, null]);
    expect([key1999ToEoL('iid', 45), key1999ToEoL('iid', 46)]).toEqual([45, null]);
    expect([key1999ToEoL('position', 27), key1999ToEoL('position', 28)]).toEqual([27, null]);
  });

  /** A 1999 description: Strength 70, burden 1045, a title (229 = 1) and one title owned (230 = 1). */
  function titledDescription(): Uint8Array {
    const w = new Writer1999().u32(0x13);
    w.u32(0x01).u32(0x0a);
    w.u16(3).u16(0x10).u32(5).i32(1045).u32(229).i32(1).u32(230).i32(1);
    w.u32(0x001).u32(1);
    w.u32(0x1).u32(70).u32(0).u32(0); // Strength only
    w.u32(0).u32(0); // no hotbar; options
    w.u32(0); // spell bar
    w.u32(0); // content profile
    w.u32(0); // inventory placement
    return w.toBytes();
  }

  it('the description carries titles under their EoL keys, and the capacity is the server\'s Strength × 150', () => {
    const { a } = primed();
    const { desc } = playerDescription(a.inbound(titledDescription(), 4));
    expect(desc.propertiesInt.get(PropertyInt.AugmentationIncreasedCarryingCapacity)).toBeUndefined();
    expect(desc.propertiesInt.get(PropertyInt.AugmentationExtraPackSlot)).toBeUndefined();
    expect(desc.propertiesInt.get(PropertyInt.NumCharacterTitles)).toBe(1);
    expect(desc.propertiesInt.get(PropertyInt.CharacterTitleId)).toBe(1);
    expect(desc.propertiesInt.get(PropertyInt.EncumbranceVal)).toBe(1045);
    // As main.ts feeds PlayerState from the description.
    const ps = new PlayerState();
    ps.attributes.setInnate(AttributeId.Strength, desc.strength!.startingValue + desc.strength!.ranks);
    for (const [k, v] of desc.propertiesInt) ps.serverIntProps.set(k, v);
    // AC1999 EncumbranceSystem::EncumbranceCapacity(strength, 0): no augmentations in 1999.
    expect(ps.encumbranceCapacity).toBe(70 * 150);
  });

  it('updates and removes renumber the key too', () => {
    const { a } = primed();
    const out = [
      msg(0x0e, (w) => w.u32(GUID).u32(230).i32(2)),
      msg(0x0e, (w) => w.u32(OTHER).u32(229).i32(3)),
      msg(0x1d1, (w) => w.u32(230)),
    ].flatMap((m) => a.inbound(m, 4));
    const s = drive(out);
    expect(s.onPrivateUpdatePropertyInt.mock.calls.map(([d]) => [d.key, d.value])).toEqual([[262, 2], [262, 0]]);
    expect(s.onPublicUpdatePropertyInt.mock.calls.map(([d]) => [d.key, d.value])).toEqual([[261, 3]]);
  });
});

describe('1999 String / DID / Bool / Int64 keys reach the client in end-of-retail numbering', () => {
  it('description tables are renumbered; a key with no EoL property is dropped', () => {
    const { a, logs } = primed();
    const w = new Writer1999().u32(0x13);
    w.u32(0x02 | 0x10 | 0x08 | 0x80).u32(0x0a);
    w.u16(1).u16(0x10).u32(5).u32(0x9999).u32(0); // Int64 5 AVAILABLE_LUMINANCE
    w.u16(2).u16(0x10).u32(1).u32(1).u32(131).u32(1); // Bool 1 Stuck, 131 MERGE_LOCKED
    w.u16(1).u16(0x10).u32(48).acString('Drudge Kill'); // String 48 KILL_QUEST_2
    w.u16(1).u16(0x10).u32(54).u32(0x2710); // DID 54 ALTERNATE_CURRENCY
    w.u32(0).u32(1); // no attributes
    w.u32(0).u32(0).u32(0).u32(0).u32(0);
    const out = a.inbound(w.toBytes(), 4);
    expect(logs).toEqual([]);
    const { desc } = playerDescription(out);
    expect(desc.propertiesInt64.get(PropertyInt64.AvailableLuminance)).toBe(0x9999n);
    expect(desc.propertiesInt64.has(5)).toBe(false);
    expect([...desc.propertiesBool.keys()]).toEqual([1]);
    expect(desc.propertiesString.get(PropertyString.KillQuest2)).toBe('Drudge Kill');
    expect(desc.propertiesDataId.get(PropertyDataId.AlternateCurrency)).toBe(0x2710);
  });

  it('updates, removes and the server\'s EoL-layout Int64 leftovers are renumbered or dropped with a note', () => {
    const { a, logs } = primed();
    const int64 = (seqNo: number, key: number, v: number) => {
      const w = new BinaryWriter(); w.writeUInt32(0x02cf); w.writeUInt8(seqNo); w.writeUInt32(key); w.writeUInt32(v); w.writeUInt32(0);
      return w.toBuffer();
    };
    const out = [
      msg(0x0f, (w) => w.u32(GUID).u32(51).acString('sig')),
      msg(0x11, (w) => w.u32(OTHER).u32(53).u32(0x2a)),
      msg(0x43, (w) => w.u32(GUID).u32(133).u32(1)),
      msg(0x1d3, (w) => w.u32(131)),
      msg(0x1d7, (w) => w.u32(49)),
      int64(1, 6, 500000),
      int64(2, 8, 1),
    ].flatMap((m) => a.inbound(m, 4));
    const s = drive(out);
    expect(s.onPrivateUpdatePropertyString.mock.calls.map(([d]) => [d.key, d.value])).toEqual([[52, 'sig'], [50, '']]);
    expect(s.onPublicUpdatePropertyDataID.mock.calls[0][0]).toEqual({ guid: OTHER, key: 55, value: 0x2a });
    expect(s.onPrivateUpdatePropertyBool).not.toHaveBeenCalled();
    expect(s.onPrivateUpdatePropertyInt64.mock.calls.map(([d]) => [d.key, d.value])).toEqual([[PropertyInt64.MaximumLuminance, 500000n]]);
    expect(logs.filter((l) => l.includes('no end-of-retail key'))).toHaveLength(3);
  });
});
