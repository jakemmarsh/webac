/**
 * BUG.ace-thrown-weapon-range-1yd — a Throwing Axe appraised at an ACE vendor reads "Range: 1 yds."
 * (live check of BUG.ac1999-appraisal-details, Ladim al-Faji the Bowyer, Yaraq, local ACE).
 *
 * Not a client field gap. The Range line is built from the appraisal's WeaponProfile alone:
 * end of retail's ItemExamineUI::Appraisal_ShowWeaponAndArmorData (annotated decomp ~174866–174885)
 * reads only WeaponProfile.max_velocity and .max_velocity_estimated, with no client-side estimate
 * and nothing from the weenie beyond the missile valid-location bit. ACE fills that profile with
 * `MaxVelocity = weapon.MaximumVelocity ?? 1.0f` and never sets MaxVelocityEstimated
 * (ACE.Server/Network/Structure/WeaponProfile.cs:57–59), and ACE-World-16PY's thrown weapons carry
 * no MaximumVelocity (wcid 304 Throwing Axe: value 5, burden 15, no float 26), so ACE sends 1.0
 * and the faithful client prints 1²/9.8×1.094 → ceil → 1. The same axe in our pack reads the same.
 * Retail's server sent an estimate and set the flag (the client's " (based on STRENGTH 100)" suffix).
 *
 * Pinned here with the real wire shapes: the vendor-row source and the pack-item source give the
 * same page; a profile carrying the retail estimate prints the suffix; 1999 thrown weapons (whose
 * velocity the AC1999 server computes per examiner, kb game-mechanics/thrown-weapon-range) print
 * their damage, speed and range.
 */
import { describe, expect, it } from 'vitest';
import { BinaryWriter, GameEventType, GameMessageOpcode, type ApproachVendorData } from '@ac/network';
import { ServerMessageHandler, type IdentifyResponseData } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { buildItemAppraisalText } from '../packages/renderer/src/ui/examine/ItemAppraisalText.js';
import { buildItemAppraisalText1999 } from '../packages/renderer/src/ui/examine/ItemAppraisalText1999.js';
import { resolveAppraisedWeenie } from '../packages/renderer/src/ui/examine/appraisedWeenie.js';

const AXE = 0x80000304;

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
  w.writeUInt32(AXE); w.writeUInt32(0x8 | 0x200 | 0x10000 | 0x200000); w.writeString16('Throwing Axe');
  w.writeUInt16(304); w.writeUInt16(0x0bd4); w.writeUInt32(0x100); w.writeUInt32(0);
  align(w);
  w.writeUInt32(5); w.writeUInt8(2); w.writeUInt32(0x400000); w.writeUInt16(15);
  align(w);
  let parsed: ApproachVendorData | null = null;
  const h = new ServerMessageHandler();
  h.setHandlers({ onApproachVendor: (d) => { parsed = d.parsed; } });
  h.handleMessage(event(GameEventType.ApproachVendor, w.toBuffer()));
  return parsed!.items[0];
}

/** ACE IdentifyObjectResponse for wcid 304: Value/Burden ints + WeaponProfile (WeaponProfile.cs Write order). */
function appraisal(maxVelocity: number, estimated: number): IdentifyResponseData {
  const w = new BinaryWriter(160);
  w.writeUInt32(AXE); w.writeUInt32(0x1 | 0x20); w.writeUInt32(1);
  w.writeUInt16(2); w.writeUInt16(0x40); w.writeUInt32(19); w.writeInt32(5); w.writeUInt32(5); w.writeInt32(15);
  w.writeUInt32(1); w.writeUInt32(20); w.writeUInt32(12); w.writeUInt32(12); // Slash, WeaponTime 20, skill 12 Thrown Weapon, Damage 12
  w.writeFloat64(0.25); w.writeFloat64(1.0); w.writeFloat64(1.0); w.writeFloat64(maxVelocity); w.writeFloat64(1.0);
  w.writeUInt32(estimated);
  let got: IdentifyResponseData | null = null;
  const h = new ServerMessageHandler();
  h.setHandlers({ onIdentifyResponse: (d) => { got = d; } });
  h.handleMessage(event(0xc9, w.toBuffer()));
  return got!;
}

describe('a thrown weapon\'s Range line comes from the appraisal profile alone', () => {
  it('vendor row and pack item give the same page; ACE\'s 1.0 placeholder reads "Range: 1 yds." in both', () => {
    const ware = vendorRow();
    expect([ware.validLocations, ware.ammoType]).toEqual([0x400000, 0]);
    const d = appraisal(1.0, 0);
    const fromShop = buildItemAppraisalText(d, { weenie: resolveAppraisedWeenie([undefined, null, null, ware], false) });
    const fromPack = buildItemAppraisalText(d, { weenie: resolveAppraisedWeenie([{ validLocations: 0x400000, objectDescFlags: 0 }], false) });
    expect(fromShop.text).toBe(fromPack.text);
    const lines = fromShop.text.split('\n');
    expect(lines).toContain('Damage: 9 - 12, Slashing'); // no ammo type: not a launcher, so damage shows
    expect(lines).toContain('Range: 1 yds.'); // what ACE sends (WeaponProfile.cs:57), printed faithfully
  });

  it('the retail-shaped profile (an estimate with max_velocity_estimated set) prints the STRENGTH 100 suffix', () => {
    const d = appraisal(20, 1);
    const lines = buildItemAppraisalText(d, { weenie: resolveAppraisedWeenie([undefined, null, null, vendorRow()], false) }).text.split('\n');
    expect(lines).toContain('Range: 40 yds. (based on STRENGTH 100)');
  });

  it('1999: a thrown weapon shows damage, speed, range (the AC1999 server sends the examiner\'s velocity) and the shield line', () => {
    const d = appraisal(18.5, 0);
    const lines = buildItemAppraisalText1999(d, { weenie: { validLocations: 0x400000, ammoType: 0 } }).text.split('\n\n');
    expect(lines.slice(2)).toEqual([
      'Use this item, or drag it to the weapon slot on the Inventory Panel, to wield it.',
      'Damage: 9 - 12, Slashing', 'Speed: Fast (20)', 'Range: 30 yds.', 'Uses Thrown Weapon Skill', 'Cannot be used with shields.',
    ]);
  });
});
