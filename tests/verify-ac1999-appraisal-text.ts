/**
 * BUG.ac1999-appraisal-details (webac#3): appraising a Yumi at a 1999 vendor showed only
 * "Value: 400" / "Burden: 980". Two causes, both driven here through the real modules:
 *  1. Every era: a shop ware's examine had no weenie to read. parseApproachVendor read and
 *     dropped the ware's AmmoType / ValidLocations / Priority, and the examine looked only at
 *     world objects and our packs, so the weapon / armor / ammunition sections (gated on those
 *     fields) never ran (ui/examine/appraisedWeenie.ts).
 *  2. AC1999: the text came from end of retail's builder. The 1999 client.exe's
 *     ItemExaminePanel::SetAppraiseInfo @ 0x0050b6c0 has its own lines and wording
 *     (ui/examine/ItemAppraisalText1999.ts), and the adapter dropped the 1999-only fields the
 *     page reads (spell names, mana rate, range fallback, mana stone, enchantments, pages).
 * Bytes are built per the AC1999 server's writers (ObjectMsgs.cpp IdentifyObject, Appraisal.cpp
 * AppraisalProfile::Pack, Vendor.cpp) and fed through Adapter1999 → ServerMessageHandler.
 */
import { describe, expect, it } from 'vitest';
import { Adapter1999, emptyCodecs } from '../packages/network/src/era1999/Adapter1999.js';
import { registerInventory1999 } from '../packages/network/src/era1999/codecs/Inventory1999.js';
import { registerObjects1999 } from '../packages/network/src/era1999/codecs/Objects1999.js';
import type { Player1999State } from '../packages/network/src/era1999/codecs/Player1999.js';
import { Writer1999 } from '../packages/network/src/era1999/Wire1999.js';
import { deserializeMessage } from '../packages/network/src/MessageSerializer.js';
import { ServerMessageHandler, type IdentifyResponseData, type VendorInfoData } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { buildItemAppraisalText } from '../packages/renderer/src/ui/examine/ItemAppraisalText.js';
import {
  armorProtectionToString1999, buildItemAppraisalText1999, coverageToString1999, damageTypeToString1999,
  lockpickSuccessPercentToString1999, rangeYards1999, weaponTimeToString1999,
} from '../packages/renderer/src/ui/examine/ItemAppraisalText1999.js';
import { resolveAppraisedWeenie } from '../packages/renderer/src/ui/examine/appraisedWeenie.js';
import { eraClientRules } from '../packages/renderer/src/era/EraFeatures.js';
import { eraProfile } from '../packages/renderer/src/era/EraProfiles.js';

const PLAYER = 0x50000003;
const VENDOR = 0x7000020;
const YUMI = 0x7000030;

function pipeline() {
  const logs: string[] = [];
  const c = emptyCodecs();
  registerObjects1999(c, { movement: (b) => b });
  const player = { guid: PLAYER, eventSequence: 100 } as Player1999State;
  registerInventory1999(c, { player: () => player });
  const a = new Adapter1999(c, { account: 'acjs', log: (m) => logs.push(m) });
  const got: { vendor: VendorInfoData[]; identify: IdentifyResponseData[] } = { vendor: [], identify: [] };
  const h = new ServerMessageHandler();
  h.setHandlers({ onApproachVendor: (d) => got.vendor.push(d), onIdentifyResponse: (d) => got.identify.push(d) });
  const feed = (msg: Uint8Array) => {
    const out = a.inbound(msg, 4);
    expect(logs).toEqual([]);
    for (const m of out) h.handleMessage(deserializeMessage(m));
  };
  return { feed, got };
}

/** A 0xF7B0-wrapped 1999 event, as the server's QueueNetMessage builds it. */
const wrapped = (type: number, body: (w: Writer1999) => void) => {
  const w = new Writer1999().u32(0xf7b0).u32(PLAYER).u32(42).u32(type);
  body(w);
  return w.toBytes();
};

/** A 1999 PublicWeenieDesc (OldPublicWeenieDesc::Pack order; the 1999 reader @ 0x5d85c0). */
function pwd1999(w: Writer1999, o: { name: string; wcid: number; icon: number; type: number; bitfield?: number; value: number; ammoType?: number; validLocations?: number; priority?: number }): void {
  let header = 0x8 | 0x4000;
  if (o.ammoType !== undefined) header |= 0x100;
  if (o.validLocations !== undefined) header |= 0x10000;
  if (o.priority !== undefined) header |= 0x40000;
  w.u32(header).acString(o.name).u16(o.wcid).u16(o.icon).u32(o.type).u32(o.bitfield ?? 0x10);
  w.u32(o.value);
  if (o.ammoType !== undefined) w.u8(o.ammoType);
  w.u32(VENDOR);
  if (o.validLocations !== undefined) w.u32(o.validLocations);
  if (o.priority !== undefined) w.u32(o.priority);
  w.align4();
}

/** 0xC9: object id + a 1999 AppraisalProfile. */
function identify(build: (w: Writer1999) => void, obj = YUMI): IdentifyResponseData {
  const { feed, got } = pipeline();
  feed(wrapped(0xc9, (w) => { w.u32(obj); build(w); }));
  expect(got.identify).toHaveLength(1);
  return got.identify[0];
}

/** The Yumi's AppraisalProfile: weapon (Bow skill 2, speed 45, max velocity 27.3) + value 400 / burden 980. */
const yumiProfile = (w: Writer1999, success = 1) => {
  w.u32(0x2 | 0x8).i32(success);
  w.u32(0x2).i32(success ? 45 : -1).u32(2).i32(success ? 0 : -1).f64(0).f64(1.2).f64(27.3).f64(1.0).f64(1.0);
  w.u32(0xffffffff).u32(400).u32(980);
};

const paragraphs = (t: { paragraphs: Array<Array<{ text: string }>> }) => t.paragraphs.map((p) => p.map((l) => l.text).join('\n'));

describe('the reported case: a Yumi appraised at a 1999 bowyer', () => {
  function shop() {
    const { feed, got } = pipeline();
    feed(wrapped(0x62, (w) => {
      w.u32(VENDOR).u32(0x100).i32(0).i32(10000).i32(0).f32(1.35).f32(0.6);
      w.u32(1).u32(0xff000000 | 0xffffff).u32(YUMI);
      pwd1999(w, { name: 'Yumi', wcid: 363, icon: 0x0d4c, type: 0x100, value: 400, ammoType: 1, validLocations: 0x400000 });
    }));
    feed(wrapped(0xc9, (w) => { w.u32(YUMI); yumiProfile(w); }));
    return { ware: got.vendor[0].parsed!.items[0], d: got.identify[0] };
  }

  it('root cause: the ware\'s weenie fields were dropped, and with no weenie the page holds only value and burden', () => {
    const { ware, d } = shop();
    // What webAC showed (the end-of-retail builder with no weenie: the old examine path for a shop ware).
    expect(paragraphs(buildItemAppraisalText(d, { appraisalSuccess: true, weenie: undefined }))).toEqual(['Value: 400\nBurden: 980']);
    // parseApproachVendor now keeps them; they were read and discarded.
    expect([ware.validLocations, ware.ammoType]).toEqual([0x400000, 1]);
    // The examine's weenie sources: no world object, not in our packs, no CreateObject record — the shop row.
    expect(resolveAppraisedWeenie([undefined, null, null, ware], false)).toMatchObject({ validLocations: 0x400000, ammoType: 1, location: undefined });
  });

  it('the 1999 page reads exactly as the 1999 release client draws it', () => {
    const { ware, d } = shop();
    const t = buildItemAppraisalText1999(d, { appraisalSuccess: true, weenie: resolveAppraisedWeenie([undefined, null, null, ware], false) });
    expect(t.value).toBe('Value: 400 p');
    expect(t.burden).toBe('980 Burden Units');
    expect(paragraphs(t)).toEqual([
      'Value: 400 p',
      '980 Burden Units',
      'Use this item, or drag it to the weapon slot on the Inventory Panel, to wield it.',
      'Speed: Average (45)',
      'Range: 80 yds.',
      'Uses Bow Skill',
      'Cannot be used with shields.',
      'Uses arrows as ammunition.',
    ]);
    // AddItemInfo @ 0x0050d600: every line is its own paragraph.
    expect(t.text.split('\n\n')).toHaveLength(8);
    // No damage line: a launcher with ammunition takes its damage from the arrow (kb missile-weapon-panel-lines).
    expect(t.text).not.toMatch(/Damage/);
  });

  it('end of retail / Dark Majesty: the same shop ware now draws its weapon section too, in end-of-retail wording', () => {
    const { ware, d } = shop();
    const lines = buildItemAppraisalText(d, { appraisalSuccess: true, weenie: resolveAppraisedWeenie([undefined, null, null, ware], false) }).text.split('\n');
    expect(lines).toContain('Skill: Bow');
    expect(lines).toContain('Uses arrows as ammunition.');
    expect(lines.some((l) => l.startsWith('Speed: '))).toBe(true);
    expect(lines).not.toContain('Uses Bow Skill'); // 1999 wording stays in the 1999 era
  });

  it('only a 1999 world builds the 1999 page', () => {
    expect(eraClientRules(eraProfile('ac1999-retail')).appraisalText).toBe('ac1999');
    expect(eraClientRules(null).appraisalText).toBe('eor');
  });

  it('a failed appraisal: two-space Unknown lines, as the 1999 literals have them', () => {
    const d = identify((w) => yumiProfile(w, 0));
    const t = buildItemAppraisalText1999(d, { appraisalSuccess: false, weenie: { validLocations: 0x400000, ammoType: 1 } });
    expect(paragraphs(t)).toContain('Speed:  Unknown');
    expect(paragraphs(t)).toContain('Range:  Unknown');
  });
});

describe('1999 weapons, shields and ammunition', () => {
  it('a wielded sword: damage range and types, defense / attack bonuses, enchantment colour, craftsman', () => {
    const d = identify((w) => {
      w.u32(0x2 | 0x8 | 0x4000000 | 0x200000).i32(1);
      w.u32(0x1 | 0x2).i32(30).u32(11).i32(12).f64(0.5).f64(1.1).f64(0).f64(1.05).f64(0.9);
      w.u32(0xffffffff).u32(1500).u32(300);
      w.acString('Acjs');
      w.u32(0x00080008); // weapon enchantment: damage raised
    }, 0x7000031);
    const t = buildItemAppraisalText1999(d, { weenie: { validLocations: 0x100000, location: 0x100000 } });
    expect(paragraphs(t)).toEqual([
      'Value: 1,500 p', '300 Burden Units',
      'Use this item to unwield it.', 'Created by Acjs.',
      'Damage: 6 - 12, Slashing/Piercing',
      // _ftol @ 0x005ba450 truncates: (1 - 0.9) × 100 = 9.999… prints 9, as the 1999 client did.
      'Bonus to Melee Defense: +5%.', 'Bonus to Attack Skill: -9%.',
      'Speed: Fast (30)', 'Uses Sword Skill',
    ]);
    expect(t.lines.find((l) => l.text.startsWith('Damage'))!.color).toBe(1);
  });

  it('a shield: shield-slot wield line, shield level, then its protections', () => {
    const d = identify((w) => {
      w.u32(0x4 | 0x8 | 0x8000).i32(1);
      // slash pierce bludgeon cold fire acid electric. The client compares the f32 against f64 bounds, so
      // 0.8f (0.80000001…) is past "Below average"'s 0.8 and reads Average (@ 0x005e37e0).
      for (const f of [1.0, 0.8, 1.2, 0.4, 0.6, 0.0, 2.0]) w.f32(f);
      w.u32(0xffffffff).u32(100).u32(500);
      w.u32(50);
    });
    expect(paragraphs(buildItemAppraisalText1999(d, { weenie: { validLocations: 0x200000 } }))).toEqual([
      'Value: 100 p', '500 Burden Units',
      'Use this item, or drag it onto the shield slot in the Inventory Panel, to wield it.',
      'Shield Level: 50',
      'Average protection against Slashing Damage.', 'Average protection against Piercing Damage.',
      'Above average protection against Bludgeon Damage.', 'Below average protection against Fire Damage.',
      'Below average protection against Cold Damage.', 'No protection against Acid Damage.',
      'Unparalleled protection against Electrical Damage.',
    ]);
  });

  it('arrows: ammunition-slot line and what fires them', () => {
    const d = identify((w) => w.u32(0x8).i32(1).u32(0xffffffff).u32(2).u32(1));
    expect(paragraphs(buildItemAppraisalText1999(d, { weenie: { validLocations: 0x800000, ammoType: 1 } })).slice(2)).toEqual([
      'Use this item, or drag it to the ammunition slot on the Inventory Panel, to wield it.',
      'Used as ammunition by bows.',
    ]);
  });
});

describe('1999 armor, jewelry, food, kits, scrolls, chests and magic', () => {
  it('armor: wear line, armor level (two spaces), protections, coverage', () => {
    const d = identify((w) => {
      w.u32(0x4 | 0x8 | 0x8000 | 0x100000).i32(1);
      for (const f of [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0]) w.f32(f);
      w.u32(0xffffffff).u32(1000).u32(1200);
      w.u32(60);
      w.u32(0x00010001); // armor level raised
    });
    const t = buildItemAppraisalText1999(d, { weenie: { validLocations: 0x200 | 0x400 | 0x800 } });
    expect(paragraphs(t)).toEqual([
      'Value: 1,000 p', '1200 Burden Units',
      'Use this item, or drag it onto the character in the Inventory Panel, to wear it.',
      'Armor Level:  60', 'Covers Chest, Abdomen, Upper Arms',
      ...['Slashing', 'Piercing', 'Bludgeon', 'Fire', 'Cold', 'Acid', 'Electrical'].map((x) => `Average protection against ${x} Damage.`),
    ]);
    expect(t.lines.find((l) => l.text.startsWith('Armor Level'))!.color).toBe(1);
  });

  it('a magic ring: jewelry lines, then the magic block from the spell names the adapter now keeps', () => {
    const d = identify((w) => {
      w.u32(0x8 | 0x800000).i32(1);
      w.u32(0xffffffff).u32(2500).u32(30);
      w.u32(150).u32(200).u32(0xffffffff).u32(500).u32(1000);
      w.u32(0xffffffff); // +0x70 mana cost: absent
      w.f32(30); // +0x74: the panel's mana rate
      w.acString('');
      w.u32(0xffffffff).u32(0);
      w.acString('Strength Self II').acString('').f64(-1);
    });
    expect(paragraphs(buildItemAppraisalText1999(d, { weenie: { validLocations: 0xc0000 } })).slice(2)).toEqual([
      'Use this item, or drag it to the appropriate jewelry slot on the Inventory Panel, to wear it.',
      'Worn on finger.',
      'Casts the following spells: Strength Self II.',
      'Spellcraft: 200.', 'Mana: 500 / 1000.', 'Mana Cost: 1 point per 30 seconds.', 'Difficulty: 150.',
    ]);
  });

  it('a failed magic appraisal shows the names line only', () => {
    const d = identify((w) => {
      w.u32(0x800000).i32(0);
      for (let i = 0; i < 6; i++) w.u32(0xffffffff);
      w.u32(0).acString('').u32(0xffffffff).u32(0).acString('Unknown').acString('').f64(-1);
    });
    expect(paragraphs(buildItemAppraisalText1999(d, { appraisalSuccess: false }))).toEqual(['Value: ???', 'Unknown Mass', 'Spells: Unknown.']);
  });

  it('food: the eat line and the stamina boost "when consumed"', () => {
    const d = identify((w) => w.u32(0x8 | 0x2000 | 0x1000).i32(1).u32(0xffffffff).u32(5).u32(20).i32(4).i32(10));
    expect(paragraphs(buildItemAppraisalText1999(d, { weenie: { objectDescriptionFlags: 0x8000 } })).slice(2)).toEqual([
      'Use this item to eat it.', 'Restores 10 Stamina when consumed.',
    ]);
  });

  it('a healing kit: its Use string, the healing bonus, uses remaining', () => {
    const d = identify((w) => {
      w.u32(0x8 | 0x2000 | 0x1000 | 0x400 | 0x80000).i32(1);
      w.u32(0xffffffff).u32(40).u32(10);
      w.i32(2).i32(5);
      w.acString('Use this kit to heal.');
      w.u32(10).u32(10);
    });
    expect(paragraphs(buildItemAppraisalText1999(d, { weenie: { objectDescriptionFlags: 0x10000 } })).slice(2)).toEqual([
      'Use this kit to heal.', 'Bonus to Healing Skill: +5', 'Number of uses remaining: 10',
    ]);
  });

  it('a scroll: description, then its Use string (the server sends no spell names for a scroll)', () => {
    const d = identify((w) => {
      w.u32(0x8 | 0x400 | 0x20000).i32(1);
      w.u32(0xffffffff).u32(50).u32(5);
      w.acString('Use this item to attempt to learn its spell.');
      w.acString('Inscribed spell: Flame Bolt I');
    });
    expect(paragraphs(buildItemAppraisalText1999(d, { weenie: { objectDescriptionFlags: 0x2 } })).slice(2)).toEqual([
      'Inscribed spell: Flame Bolt I', 'Use this item to attempt to learn its spell.',
    ]);
  });

  it('a chest: lock, level restriction opened by the server\'s " " filler, capacity', () => {
    const d = identify((w) => {
      w.u32(0x200 | 0x800 | 0x40 | 0x10000).i32(1);
      w.i32(40); w.u32(1); w.i32(250);
      w.u32(0xffffffff).u32(20).acString(' ');
    });
    expect(paragraphs(buildItemAppraisalText1999(d, { weenie: { itemsCapacity: 120 } }))).toEqual([
      'Value: ???', 'Unknown Mass', 'Can hold up to 120 items.',
      'Locked', 'The lock looks difficult to pick (Resistance 250).',
      'Restricted to characters of Level 20 or below.',
      ' ', // the restriction string itself: AddItemInfo prints it after the level line
    ]);
  });

  it('a mana stone, enchantments and book pages: the blocks the adapter used to refuse', () => {
    const d = identify((w) => {
      w.u32(0x80 | 0x100 | 0x1000000 | 0x2000000).i32(1);
      w.u32(3).u32(10);
      w.f64(0.5).u32(4000);
      w.acString('Blood Drinker I');
    });
    expect(paragraphs(buildItemAppraisalText1999(d, {})).slice(2)).toEqual([
      '3 of 10 pages full.', 'Stored Mana: 4000', 'Efficiency: 50%', 'Enchantments:\nBlood Drinker I',
    ]);
  });
});

describe('the 1999 client\'s tables (AppraisalSystem @ 0x005e2f00–0x005e3c00)', () => {
  it('speed, damage types, coverage, protections, lock difficulty, range', () => {
    expect([10, 11, 30, 31, 49, 50, 79, 80].map(weaponTimeToString1999)).toEqual(
      ['Very Fast', 'Fast', 'Fast', 'Average', 'Average', 'Slow', 'Slow', 'Very Slow']);
    expect(damageTypeToString1999(0x7f)).toBe('Slashing/Piercing/Bludgeoning/Cold/Fire/Acid/Electrical');
    expect(coverageToString1999(0x1 | 0x20 | 0x100)).toBe('Covers Head, Hands, Feet');
    expect(coverageToString1999(0x400000)).toBeNull();
    expect([0, 0.4, 0.41, 0.8, 1.19, 1.2, 1.6, 2.0].map((m) => armorProtectionToString1999(1, m)!.split(' protection')[0])).toEqual(
      ['No', 'Poor', 'Below average', 'Below average', 'Average', 'Above average', 'Excellent', 'Unparalleled']);
    expect(armorProtectionToString1999(1, -0.1)).toBeNull();
    expect([0, 4, 14, 34, 49, 69, 84, 94, 95].map(lockpickSuccessPercentToString1999)).toEqual(
      ['impossible', 'ridiculously difficult', 'extremely difficult', 'quite difficult', 'difficult', 'challenging', 'mildly challenging', 'easy', 'trivial']);
    expect([9.2, 83.2, 99.9, 120].map(rangeYards1999)).toEqual([10, 80, 90, 120]); // no 85 cap in 1999
  });

  it('weenie sources: first non-zero field wins, so a ground item takes its valid locations from its CreateObject record', () => {
    const w = resolveAppraisedWeenie([{ ammoType: 0, wieldedLocation: 0, objectDescFlags: 0x10 }, null, { validLocations: 0x100000, ammoType: 0 }], false)!;
    expect([w.validLocations, w.ammoType, w.location, w.objectDescriptionFlags]).toEqual([0x100000, 0, 0, 0x10]);
    expect(resolveAppraisedWeenie([undefined, null], false)).toBeUndefined();
  });
});
