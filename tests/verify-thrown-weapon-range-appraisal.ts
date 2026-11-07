/**
 * BUG.ace-thrown-weapon-range-1yd — on ACE every thrown weapon appraised "Range: 1 yds." (live check of
 * BUG.ac1999-appraisal-details, Ladim al-Faji the Bowyer, Yaraq, local ACE).
 *
 * Retail's rule: ItemExamineUI::Appraisal_ShowWeaponAndArmorData @ 0x4b10e0 (annotated decomp ~174866–174885)
 * prints pow(max_velocity, 2) × 0.10204 × 1.094 yds (capped at MISSILE_RANGE_CAP 85; ≥ 10 truncated to a multiple
 * of 5, else ceil) from the appraisal's WeaponProfile alone, with " (based on STRENGTH 100)" when
 * max_velocity_estimated is set. The client has no estimate of its own; retail's server computed a thrown weapon's
 * velocity at appraisal time, since the weenies store none (ACE-World-16PY wcid 316 Throwing Dart / 304 Throwing Axe
 * have no float 26).
 *
 * What servers send for a thrown weapon, and the velocity they really throw it with:
 *  - ACE: `MaximumVelocity ?? 1.0f`, flag never set (WeaponProfile.cs:57); throws at `?? 20` (Creature_Missile.cs:404).
 *  - ClassicACE (Dark Majesty): its own Strength-100 estimate with the flag set (WeaponProfile.cs:62–71).
 *  - GDLE / GDL (Seedsow, ClassicDereth): `InqFloatQuality(MAXIMUM_VELOCITY_FLOAT, 0)`, flag 0; throws at 20.
 *  - AC1999 server: the examiner's own velocity (CombatFormulas.cpp CalculateThrownVelocity); 0 for a missile weapon
 *    with nothing stored, thrown at 20 (MissileAttackEventData.cpp:166).
 * So a retail-faithful client fed ACE's placeholder printed a 1-yard reach for a dart the server throws 40 m. Our
 * client reads the un-estimated 1.0 / 0 placeholder as the 20 m/s those servers throw with (appraisedMissileVelocity),
 * like the ManaRate-0 ACE compatibility; real velocities (bows, ClassicACE's and AC1999's estimates) pass unchanged.
 * Every case below runs the real IdentifyObjectResponse bytes through ServerMessageHandler (and Adapter1999 for 1999).
 */
import { describe, expect, it } from 'vitest';
import { BinaryWriter, GameEventType, GameMessageOpcode, type ApproachVendorData } from '@ac/network';
import { appraisedMissileVelocity, DEFAULT_MAX_VELOCITY } from '@ac/shared';
import { Adapter1999, emptyCodecs } from '../packages/network/src/era1999/Adapter1999.js';
import { registerInventory1999 } from '../packages/network/src/era1999/codecs/Inventory1999.js';
import { registerObjects1999 } from '../packages/network/src/era1999/codecs/Objects1999.js';
import type { Player1999State } from '../packages/network/src/era1999/codecs/Player1999.js';
import { Writer1999 } from '../packages/network/src/era1999/Wire1999.js';
import { deserializeMessage } from '../packages/network/src/MessageSerializer.js';
import { ServerMessageHandler, type IdentifyResponseData } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { buildItemAppraisalText } from '../packages/renderer/src/ui/examine/ItemAppraisalText.js';
import { buildItemAppraisalText1999 } from '../packages/renderer/src/ui/examine/ItemAppraisalText1999.js';
import { resolveAppraisedWeenie } from '../packages/renderer/src/ui/examine/appraisedWeenie.js';

/** ACE-World-16PY values (the same weenies GDLE, ClassicACE and the AC1999 server load). */
interface Weapon { guid: number; name: string; value: number; burden: number; damageType: number; time: number; damage: number; variance: number }
const DART: Weapon = { guid: 0x80000316, name: 'Throwing Dart', value: 2, burden: 5, damageType: 2, time: 10, damage: 6, variance: 0.25 };
const AXE: Weapon = { guid: 0x80000304, name: 'Throwing Axe', value: 5, burden: 15, damageType: 1, time: 20, damage: 12, variance: 0.25 };
/** wcid 306 Longbow: MaximumVelocity 27.3, AmmoType Arrow, Bow skill. */
const LONGBOW: Weapon = { guid: 0x80000306, name: 'Longbow', value: 700, burden: 600, damageType: 0, time: 50, damage: 0, variance: 0 };
const MISSILE_SLOT = 0x400000; // ValidLocations MissileWeapon

const event = (eventType: number, payload: Uint8Array) => ({
  type: 'event' as const, opcode: GameMessageOpcode.GameEvent as GameMessageOpcode.GameEvent,
  objectGuid: 0x50000001, sequence: 1, eventType, payload,
});

function align(w: BinaryWriter): void { while (w.position % 4) w.writeUInt8(0); }

/** ACE GameEventApproachVendor with one ware: the Throwing Axe as ACE-World-16PY wcid 304 serializes it. */
function vendorRow() {
  const w = new BinaryWriter(256);
  w.writeUInt32(0x7000020); w.writeUInt32(0x100); w.writeUInt32(0); w.writeUInt32(10000); w.writeUInt32(0);
  w.writeFloat32(1.35); w.writeFloat32(0.6); w.writeUInt32(0); w.writeUInt32(0); w.writeString16(''); w.writeUInt32(1);
  w.writeUInt32(0xffffffff);
  // Value 0x8, CombatUse 0x200 (Missile), ValidLocations 0x10000 (MissileWeapon), Burden 0x200000; no AmmoType.
  w.writeUInt32(AXE.guid); w.writeUInt32(0x8 | 0x200 | 0x10000 | 0x200000); w.writeString16('Throwing Axe');
  w.writeUInt16(304); w.writeUInt16(0x0bd4); w.writeUInt32(0x100); w.writeUInt32(0);
  align(w);
  w.writeUInt32(5); w.writeUInt8(2); w.writeUInt32(MISSILE_SLOT); w.writeUInt16(15);
  align(w);
  let parsed: ApproachVendorData | null = null;
  const h = new ServerMessageHandler();
  h.setHandlers({ onApproachVendor: (d) => { parsed = d.parsed; } });
  h.handleMessage(event(GameEventType.ApproachVendor, w.toBuffer()));
  return parsed!.items[0];
}

/**
 * End-of-retail IdentifyObjectResponse (0xC9): Value/Burden ints + WeaponProfile in WeaponProfile.cs Write order
 * (damage type, time, skill, damage, variance, damage mod, length, max velocity, offense, max velocity estimated).
 * ACE, ClassicACE and GDLE all write this layout.
 */
function appraisal(item: Weapon, maxVelocity: number, estimated: number, skill = 12): IdentifyResponseData {
  const w = new BinaryWriter(160);
  w.writeUInt32(item.guid); w.writeUInt32(0x1 | 0x20); w.writeUInt32(1);
  w.writeUInt16(2); w.writeUInt16(0x40); w.writeUInt32(19); w.writeInt32(item.value); w.writeUInt32(5); w.writeInt32(item.burden);
  w.writeUInt32(item.damageType); w.writeUInt32(item.time); w.writeUInt32(skill); w.writeUInt32(item.damage);
  w.writeFloat64(item.variance); w.writeFloat64(1.0); w.writeFloat64(1.0); w.writeFloat64(maxVelocity); w.writeFloat64(1.0);
  w.writeUInt32(estimated);
  let got: IdentifyResponseData | null = null;
  const h = new ServerMessageHandler();
  h.setHandlers({ onIdentifyResponse: (d) => { got = d; } });
  h.handleMessage(event(0xc9, w.toBuffer()));
  expect(got).not.toBeNull();
  return got!;
}

const PACK_THROWN = resolveAppraisedWeenie([{ validLocations: MISSILE_SLOT, objectDescFlags: 0 }], false);
const eolLines = (d: IdentifyResponseData, weenie = PACK_THROWN) => buildItemAppraisalText(d, { weenie }).text.split('\n');

/** The AC1999 server's 0xC9 (Appraisal.cpp AppraisalProfile::Pack, 1999 layout), through Adapter1999 → ServerMessageHandler. */
function appraisal1999(item: Weapon, maxVelocity: number, skill = 12): IdentifyResponseData {
  const PLAYER = 0x50000003;
  const c = emptyCodecs();
  registerObjects1999(c, { movement: (b) => b });
  registerInventory1999(c, { player: () => ({ guid: PLAYER, eventSequence: 100 }) as Player1999State });
  const logs: string[] = [];
  const a = new Adapter1999(c, { account: 'acjs', log: (m) => logs.push(m) });
  const got: IdentifyResponseData[] = [];
  const h = new ServerMessageHandler();
  h.setHandlers({ onIdentifyResponse: (d) => got.push(d) });
  const w = new Writer1999().u32(0xf7b0).u32(PLAYER).u32(42).u32(0xc9).u32(item.guid);
  w.u32(0x2 | 0x8).i32(1);
  // weapon {damageType, time, skill, damage, variance, length, maxVelocity, defense, offense}
  w.u32(item.damageType).i32(item.time).u32(skill).i32(item.damage).f64(item.variance).f64(1.0).f64(maxVelocity).f64(1.0).f64(1.0);
  w.u32(0xffffffff).u32(item.value).u32(item.burden); // mass (absent), Value, EncumbVal
  for (const m of a.inbound(w.toBytes(), 4)) h.handleMessage(deserializeMessage(m));
  expect(logs).toEqual([]);
  expect(got).toHaveLength(1);
  return got[0];
}
const lines1999 = (d: IdentifyResponseData, ammoType = 0) =>
  buildItemAppraisalText1999(d, { weenie: { validLocations: MISSILE_SLOT, ammoType } }).text.split('\n\n');

/** AC1999 server CombatFormulas.cpp CalculateThrownVelocity (the examiner's Strength, the item's unit burden). */
const ac1999Thrown = (strength: number, burden: number) => 8.1223 * Math.pow(strength, 1 / 3) / Math.pow(Math.max(15, burden), 0.2389);
/** ClassicACE Creature_Combat.GetThrownWeaponMaxVelocity at Strength 100 (its WeaponProfile estimate, flag set). */
const classicAceEstimate = (burden: number) => Math.min(27.3, Math.max(5.45, 16 - 6 + 9 - (Math.sqrt(burden) - Math.sqrt(5))));

describe('appraisedMissileVelocity: an emulator\'s "no velocity stored" placeholder is the 20 m/s it throws with', () => {
  it('ACE 1.0 and GDLE 0 (not estimated) → 20; every real velocity, and any estimate, passes unchanged', () => {
    expect(DEFAULT_MAX_VELOCITY).toBe(20);
    expect(appraisedMissileVelocity(1.0, 0)).toBe(20);
    expect(appraisedMissileVelocity(0, 0)).toBe(20);
    expect(appraisedMissileVelocity(1.0)).toBe(20);
    for (const v of [2.0, 5.45, 15, 19, 24.9, 27.3, 45, 50]) expect(appraisedMissileVelocity(v, 0)).toBe(v);
    expect(appraisedMissileVelocity(1.0, 1)).toBe(1.0); // a server that says it estimated is taken at its word
  });
});

describe('end of retail / Dark Majesty: a thrown weapon\'s Range line', () => {
  it('ACE: the dart and the axe read the 40 yds. the server throws them (not "Range: 1 yds."), the same from shop and pack', () => {
    const ware = vendorRow();
    expect([ware.validLocations, ware.ammoType]).toEqual([MISSILE_SLOT, 0]);
    const axe = appraisal(AXE, 1.0, 0);
    const fromShop = buildItemAppraisalText(axe, { weenie: resolveAppraisedWeenie([undefined, null, null, ware], false) }).text;
    expect(fromShop).toBe(buildItemAppraisalText(axe, { weenie: PACK_THROWN }).text);
    const axeLines = fromShop.split('\n');
    expect(axeLines).toContain('Damage: 9 - 12, Slashing'); // no ammo type: not a launcher, so damage shows
    expect(axeLines).toContain('Range: 40 yds.');
    expect(axeLines).not.toContain('Range: 1 yds.');
    expect(axeLines.some((l) => l.startsWith('Damage Modifier'))).toBe(false); // launchers only (ammo type ≠ none)
    const dart = eolLines(appraisal(DART, 1.0, 0));
    expect(dart).toContain('Damage: 4.5 - 6, Piercing');
    expect(dart).toContain('Range: 40 yds.');
  });

  it('GDLE / GDL (Seedsow, ClassicDereth) send 0: 40 yds. too, not "Range: 0 yds."', () => {
    for (const item of [DART, AXE]) {
      const l = eolLines(appraisal(item, 0, 0));
      expect(l).toContain('Range: 40 yds.');
      expect(l).not.toContain('Range: 0 yds.');
    }
  });

  it('ClassicACE\'s Strength-100 estimate (flag set) prints as sent, with the retail suffix', () => {
    expect(eolLines(appraisal(DART, classicAceEstimate(DART.burden), 1))).toContain('Range: 40 yds. (based on STRENGTH 100)');
    expect(eolLines(appraisal(AXE, classicAceEstimate(AXE.burden), 1))).toContain('Range: 30 yds. (based on STRENGTH 100)');
    // ClassicACE, wielded: the wielder's own velocity, no flag.
    expect(eolLines(appraisal(AXE, classicAceEstimate(AXE.burden), 0))).toContain('Range: 30 yds.');
  });

  it('the other direction: a launcher\'s stored velocity is untouched (Longbow 27.3 → 80 yds., Damage Modifier shown)', () => {
    const bow = buildItemAppraisalText(appraisal(LONGBOW, 27.3, 0, 2), {
      weenie: resolveAppraisedWeenie([{ validLocations: MISSILE_SLOT, ammoType: 1, objectDescFlags: 0 }], false),
    }).text.split('\n');
    expect(bow).toContain('Range: 80 yds.');
    expect(bow).toContain('Damage Modifier: +0%.');
    expect(bow.some((l) => l.startsWith('Damage Bonus'))).toBe(true);
  });
});

describe('AC1999: a thrown weapon\'s Range line (real 1999 appraisal bytes)', () => {
  it('the AC1999 server\'s per-examiner velocity prints unchanged (STR 55: 20 yds., STR 100: 40 yds.)', () => {
    const dart55 = lines1999(appraisal1999(DART, ac1999Thrown(55, DART.burden)));
    expect(dart55).toContain('Damage: 5 - 6, Piercing'); // the 1999 panel prints whole numbers
    expect(dart55).toContain('Range: 20 yds.');
    expect(dart55).toContain('Uses Thrown Weapon Skill');
    expect(lines1999(appraisal1999(AXE, ac1999Thrown(100, AXE.burden)))).toContain('Range: 40 yds.');
    expect(lines1999(appraisal1999(AXE, 18.5))).toContain('Range: 30 yds.');
  });

  it('a missile weapon the server stores no velocity for (sent as 0, thrown at 20) reads 40 yds., not 0', () => {
    const l = lines1999(appraisal1999(DART, 0));
    expect(l).toContain('Range: 40 yds.');
    expect(l).not.toContain('Range: 0 yds.');
  });

  it('a 1999 launcher keeps its stored velocity (Longbow 27.3 → 80 yds.)', () => {
    expect(lines1999(appraisal1999(LONGBOW, 27.3, 2), 1)).toContain('Range: 80 yds.');
  });
});
