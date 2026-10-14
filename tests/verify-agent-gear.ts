/**
 * The gear view (agent/gear.ts): what a player reads off the paperdoll and an item's examine window, as text.
 * Jake, watching the stream 2026-10-14: "why does it seem like neither of them are upgrading their gear? the mage
 * especially. he doesnt even have gloves!" The inventory listed only what was worn (an empty slot was absent),
 * and nothing showed an armor level or compared a pack item with what was worn.
 *
 * Masks are ACE's: EquipMask (ValidLocations / CurrentWieldedLocation) and CoverageMask (ClothingPriority).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { formatInventory, formatObservation } from '../packages/renderer/src/agent/format.ts';
import { formatGear, gearEmptyFacts, gearNote } from '../packages/renderer/src/agent/gear.ts';
import { TOOLS, TOOL_CALLER, type ToolCaller } from '../tools/ac-agent/tools.ts';
import { FakeHost } from './_harness/agentFake.ts';
import type { AgentItem } from '../packages/renderer/src/agent/types.ts';

// EquipMask
const ROBE_SLOTS = 0x200 | 0x400 | 0x800 | 0x1000 | 0x2000 | 0x4000; // Chest/Abdomen/UpperArm/LowerArm/UpperLeg/LowerLeg Armor
const FOOT_WEAR = 0x100, HAND_WEAR = 0x20, HEAD_WEAR = 0x1, CHEST_ARMOR = 0x200, HELD = 0x1000000, RINGS = 0x40000 | 0x80000;
const SHIRT_SLOTS = 0x2 | 0x8 | 0x10; // ChestWear, UpperArmWear, LowerArmWear
// CoverageMask
const ROBE_COVER = 0x400 | 0x800 | 0x1000 | 0x2000 | 0x100 | 0x200, HANDS = 0x8000, FEET = 0x10000, OUTER_CHEST = 0x400;

/** A level-19 war mage like Claude Arcanist: robe and sandals on, a wand in hand, no gloves, loot in the pack. */
function arcanist(): { host: FakeHost; api: AgentApi } {
  const host = new FakeHost();
  host.me.name = 'Claude Arcanist'; host.me.level = 19;
  host.inv = [
    { guid: 0x80001001, name: 'Robe', where: 'equipped', slot: 'ChestArmor+…', mask: ROBE_SLOTS, validLocations: ROBE_SLOTS, coverage: ROBE_COVER },
    { guid: 0x80001002, name: 'Sandals', where: 'equipped', slot: 'FootWear', mask: FOOT_WEAR, validLocations: FOOT_WEAR, coverage: FEET },
    { guid: 0x80001003, name: 'Wand', where: 'equipped', slot: 'Held', mask: HELD, validLocations: HELD, itemType: 0x8000 },
    { guid: 0x80002001, name: 'Leather Gauntlets', where: 'main pack', type: 'Armor', fits: 'HandWear', value: 150, validLocations: HAND_WEAR, coverage: HANDS },
    { guid: 0x80002002, name: 'Studded Leather Breastplate', where: 'main pack', type: 'Armor', fits: 'ChestArmor', value: 400, validLocations: CHEST_ARMOR, coverage: OUTER_CHEST },
    { guid: 0x80002003, name: 'Copper Ring', where: 'main pack', type: 'Jewelry', value: 80, validLocations: RINGS },
    { guid: 0x80002004, name: 'Pyreal', where: 'main pack', stack: 120, value: 120 },
  ];
  host.appraisalDatas.set(0x80001001, { int: { 28: 20 }, float: {}, string: {}, bool: {}, did: {}, spells: [] });
  host.appraisalDatas.set(0x80001002, { int: { 28: 10 }, float: {}, string: {}, bool: {}, did: {}, spells: [] });
  // The breastplate: AL 60, and Wield requires level 25 (WieldRequirements 158 = Level 7, Difficulty 160).
  host.appraisalDatas.set(0x80002002, { int: { 28: 60, 158: 7, 159: 0, 160: 25 }, float: {}, string: {}, bool: {}, did: {}, spells: [] });
  host.appraisalDatas.set(0x80002001, { int: { 28: 40, 158: 7, 159: 0, 160: 10 }, float: {}, string: {}, bool: {}, did: {}, spells: [] });
  host.appraised.push(0x80001001, 0x80001002, 0x80002002); // the gauntlets aren't examined yet
  return { host, api: new AgentApi(host) };
}

describe('the gear view: the paperdoll as text', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('lists every slot, worn or EMPTY, with armor levels from appraisals and what a multi-part item covers', () => {
    const { api } = arcanist();
    const text = formatInventory(api.inventory());
    expect(text).toMatch(/^gear \(the paperdoll/);
    expect(text).toContain('  head:       EMPTY\n');
    expect(text).toContain('  chest:      Robe #80001001 (AL 20; covers chest, abdomen, upper arms, lower arms, upper legs, lower legs)');
    expect(text).toContain('  abdomen:    Robe (above)');
    expect(text).toContain('  hands:      EMPTY  (in your pack: Leather Gauntlets #80002001)');
    expect(text).toContain('  feet:       Sandals #80001002 (AL 10)');
    expect(text).toContain('  rings:      EMPTY, EMPTY  (in your pack: Copper Ring #80002003)');
    expect(text).toContain('  weapon:     Wand #80001003');
    expect(text).toContain('  shield:     EMPTY');
    expect(text).toContain('  neck:       EMPTY');
    // Later eras' slots show only when something uses them.
    expect(text).not.toContain('cloak:');
    // The pack follows, each wearable item with what wearing it would do.
    expect(text).toContain('#80002001 Leather Gauntlets  (Armor, fits HandWear, value 150)\n      wear: covers hands; fills your EMPTY hands; appraise it to see its armor level and wield requirements');
    expect(text).toContain('#80002002 Studded Leather Breastplate  (Armor, fits ChestArmor, value 400)\n      wear: covers chest; replaces your Robe #80001001 (AL 20); leaves bare: abdomen, upper arms, lower arms, upper legs, lower legs; AL 60 vs your 20; Wield requires level 25 (you do NOT meet it yet)');
    expect(text).toContain('wear: fills your EMPTY rings slot; appraise it to see its wield requirements');
    expect(text).toMatch(/#80002004 Pyreal {2}\(x120, value 120\)$/); // nothing to wear: no note
  });

  it('once appraised, the gauntlets show their armor level and a requirement you meet', () => {
    const { host, api } = arcanist();
    host.appraised.push(0x80002001);
    const items = api.inventory();
    expect(gearNote(items.find((i) => i.name === 'Leather Gauntlets')!, items)).toBe('covers hands; fills your EMPTY hands; AL 40; Wield requires level 10 (you meet it)');
  });

  it('a skill requirement is judged from your buffed skill (ACE CheckWieldRequirement Skill = Current)', () => {
    const { host, api } = arcanist();
    host.appraisalDatas.set(0x80002003, { int: { 158: 1, 159: 15, 160: 100 }, float: {}, string: {}, bool: {}, did: {}, spells: [] });
    host.appraised.push(0x80002003);
    host.skills.set(15, { base: 80, buffed: 110 });
    const items = api.inventory();
    expect(gearNote(items.find((i) => i.name === 'Copper Ring')!, items)).toBe('fills your EMPTY rings slot; Wield requires Magic Defense 100 (you meet it)');
    host.skills.set(15, { base: 80, buffed: 90 });
    const again = api.inventory();
    expect(gearNote(again.find((i) => i.name === 'Copper Ring')!, again)).toMatch(/Magic Defense 100 \(you do NOT meet it yet\)/);
  });

  it('clothing alone on a two-layer part says no armor is over it', () => {
    const items: AgentItem[] = [
      { guid: 1, name: 'Shirt', where: 'equipped', mask: SHIRT_SLOTS, coverage: 0x8 | 0x20 | 0x40 },
    ];
    const text = formatGear(items);
    expect(text).toContain('  chest:      Shirt #1 (AL ? (appraise it to see); covers chest, upper arms, lower arms)  (clothing only: no armor over it)');
    expect(text).toContain('  abdomen:    EMPTY');
  });

  it('without ClothingPriority the EquipMask bits tell what an item covers', () => {
    const items: AgentItem[] = [
      { guid: 1, name: 'Leather Cap', where: 'equipped', mask: HEAD_WEAR },
      { guid: 2, name: 'Iron Helm', where: 'main pack', validLocations: HEAD_WEAR },
    ];
    expect(formatGear(items)).toContain('  head:       Leather Cap #1 (AL ? (appraise it to see))');
    expect(gearNote(items[1], items)).toBe('covers head; replaces your Leather Cap #1 (AL ?); appraise it to see its armor level and wield requirements');
  });

  it('observe names the bare body parts and the pack items that would cover one', () => {
    const { api } = arcanist();
    const obs = api.observe();
    expect(obs.gearEmpty).toEqual({ slots: ['head', 'hands'], packFits: ['Leather Gauntlets'] });
    expect(formatObservation(obs)).toContain('gear: no helm or hat (head), no gloves (hands); in your pack that would cover one: Leather Gauntlets (ac_inventory / ac_gear show every gear slot)');
  });

  it('observe says nothing when every body part is covered, or when the tab gives no slot numbers', () => {
    expect(gearEmptyFacts([{ guid: 1, name: 'Robe', where: 'equipped' }])).toBeNull();
    const dressed: AgentItem[] = [
      { guid: 1, name: 'Robe', where: 'equipped', mask: ROBE_SLOTS, coverage: ROBE_COVER },
      { guid: 2, name: 'Cap', where: 'equipped', mask: HEAD_WEAR },
      { guid: 3, name: 'Gloves', where: 'equipped', mask: HAND_WEAR },
      { guid: 4, name: 'Boots', where: 'equipped', mask: FOOT_WEAR },
    ];
    expect(gearEmptyFacts(dressed)).toBeNull();
    const host = new FakeHost();
    expect(formatObservation(new AgentApi(host).observe())).not.toContain('gear:');
  });

  it('an older tab (no slot numbers) keeps the plain inventory and ac_gear says to reload', () => {
    const items: AgentItem[] = [{ guid: 1, name: 'Robe', where: 'equipped', slot: 'ChestArmor' }];
    expect(formatInventory(items)).not.toContain('gear (');
    expect(formatGear(items)).toMatch(/older version.*reload it/);
  });

  it('ac_gear renders the paperdoll through the page\'s inventory call', async () => {
    const { host, api } = arcanist();
    const surface = api.surface() as Record<string, (...a: unknown[]) => unknown>;
    const calls: string[] = [];
    const c: ToolCaller = {
      notice: null, maxWaitMs: 20_000,
      connection: () => ({ account: 'a', characters: 'any', tab: 'on', character: host.me.name, screen: 'world' }),
      call: async <T>(m: string, args: unknown[] = []) => { calls.push(m); return (await surface[m](...args)) as T; },
    };
    const out = await TOOL_CALLER.run(c, () => TOOLS.find((t) => t.name === 'ac_gear')!.run({}));
    expect(calls).toEqual(['inventory']);
    expect(out.text).toContain('  hands:      EMPTY  (in your pack: Leather Gauntlets #80002001)');
    expect(out.text).toContain('wearable in your pack:\n  #80002001 Leather Gauntlets: covers hands; fills your EMPTY hands');
    expect(out.text).not.toContain('Pyreal');
  });
});
