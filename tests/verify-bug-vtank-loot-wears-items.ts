/**
 * BUG.vtank-loot-wears-items — prod 2026-11-17 (end of retail, ACE server 1f069f0d, Windows Firefox, trace
 * ffa49bb85baa8e5b, build d0994b07549e, macro on a 66-point indoor route with looting): "vtank seems to be looting random
 * items and trying to equip them … until a new mob spawns. Then it proceeds to switch back to my main weapon … it
 * completely pauses my navigation and looting", and "they only take a few steps, pause for a couple of seconds". Its
 * refusals: "You must remove your _ to wear that" and "You're already wearing a trinket." (AutoSort's lines), "You are
 * not skilled enough to use that." (0x0468, GetAndWieldItem) and "Your _ is too low to use that item's magic." (0x04c9,
 * a wield that went on but whose spells didn't), with nav_idle reasons buffing / fighting / other.
 *
 * Root cause: a corpse's item is no world object (main.ts keeps its CreateObject with the open container), so
 * AgentApi.loot handed every corpse item to the loot rules with ItemType 0. scrollSpell let an unknown type through,
 * and an examined magic item's first spell read as "the scroll's spell": ReadUnknownScrolls took each learnable-looking
 * ring, sword or coat "to read" and lootExtras.readStep Used it, three times. A Use of armor or jewelry you carry is
 * AutoSort (wear), of a weapon AutoWield (the double-click), which takes the main weapon off first: the loop the player
 * saw, every corpse, the route held while it ran (reason "other": its label "read …"). Also: the loot rules' types
 * never matched a corpse item; the macro wielded any carried caster for magic mode when the Items tab listed none
 * (toMagic) or for an "Any Wand" row; and a wield the server refused for your skill was asked again at once.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALL_MODULES_OFF, VT_DAMAGE, VT_DEFAULT_MONSTER, type LootRule, type PlanItem, type RoutineProfile, type VtMonsterRow } from '@ac/shared';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import type { AgentItem } from '../packages/renderer/src/agent/types.ts';
import { buildCombatFamilies, planCombat, type CombatInput } from '../packages/renderer/src/agent/macro/combatPlan.ts';
import { scrollSpell } from '../packages/renderer/src/agent/macro/scrollPlan.ts';
import { planBuffItem } from '../packages/renderer/src/agent/macro/buffItems.ts';
import { useWouldPutOn } from '../packages/renderer/src/agent/macro/itemUse.ts';
import { aceRecord } from './_harness/aceAppraisal.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

const CORPSE = 0x80007001;
const SCROLL = 0x80007011;
const RING = 0x80007012;
const SWORD = 0x80007013;

/** The spells these items carry or teach (end-of-retail names; schools 1 War, 4 Creature). */
const TABLE = new Map([
  [1, { name: 'Flame Bolt II', school: 1, power: 50 }],
  [2, { name: 'Strength Self II', school: 4, power: 50 }],
  [3, { name: 'Blood Drinker Self II', school: 3, power: 50 }],
]);

const IT_JEWELRY = 0x8, IT_MELEE = 0x1, IT_WRITABLE = 0x2000;

/** An ACE examination of each: the ring and sword list their spells as a scroll does (AppraiseInfo.BuildSpells). */
const RECORDS = new Map([
  [SCROLL, aceRecord({ spells: ['Flame Bolt II'] })],
  // ItemWorkmanship 105, ItemCurMana 107, ItemMaxMana 108, ItemDifficulty 109 (Arcane Lore): what ACE appraises.
  [RING, aceRecord({ appraisal: { int: { 105: 4, 107: 400, 108: 600, 109: 160 } }, spells: ['Strength Self II'] })],
  [SWORD, aceRecord({ appraisal: { int: { 105: 6, 107: 300, 108: 500, 109: 120 } }, spells: ['Blood Drinker Self II'] })],
]);

const profile = (loot: LootRule[]): RoutineProfile => ({
  name: 'Loot', modules: { ...ALL_MODULES_OFF, looting: true, combat: true, inventory: true },
  initialState: 'Hunt', loot, buffSets: [], routes: [], macro: true,
  states: [{ name: 'Hunt', rules: [] }],
  settings: { AttackDistance: 20, EnableLooting: true, EnableBuffing: false, LootAllCorpses: true },
});

/** A value rule no item meets: it makes every corpse item examined first, as most VTank loot profiles do. */
const VALUE_RULE: LootRule = { label: 'Valuable', action: 'keep', match: { valueAtLeast: 10_000_000 } };

/**
 * The macro looting one corpse the way the live client shows it: the corpse is a world object, its items are only in
 * the open container's listing (with their ItemType), never world objects (main.ts openContainer.acceptCreateObject).
 */
function lootSetup(listing: Array<{ guid: number; name: string; itemType: number }>, loot: LootRule[]) {
  vi.useFakeTimers();
  const host = new FakeHost();
  const api = new AgentApi(host);
  (host as unknown as { spellTableData: () => unknown }).spellTableData = () => ({ spells: new Map([...TABLE].map(([id, s]) => [id, { ...s, desc: '', category: id, bitfield: 0 }])) });
  (host as unknown as { skillList: () => unknown[] }).skillList = () => [
    { id: 34, name: 'War Magic', training: 'trained', base: 100, buffed: 100 },
    { id: 31, name: 'Creature Enchantment', training: 'trained', base: 100, buffed: 100 },
    { id: 32, name: 'Item Enchantment', training: 'trained', base: 100, buffed: 100 },
  ];
  for (const it of listing) {
    host.appraisals.set(it.guid, it.name);
    host.appraisalDatas.set(it.guid, RECORDS.get(it.guid)!);
  }
  host.add({ guid: CORPSE, name: 'Corpse of Drudge Skulker', objectDescFlags: 0x2000, x: 80, y: 22 });
  host.appraisals.set(CORPSE, 'Killed by Someone.');
  host.inv = [{ guid: 0x50000001, name: 'Iron Sword', where: 'equipped', mask: 0x100000, slot: 'MeleeWeapon', itemType: IT_MELEE }] as AgentItem[];
  host.use = (g: number) => {
    host.sent.push(`use ${g.toString(16)}`);
    if (g === CORPSE) host.container = host.container?.guid === g ? null : { guid: g, items: listing.filter((i) => !host.inv.some((x) => x.guid === i.guid)) };
    // Reading a scroll uses it up (ACE Scroll.ActOnUse).
    if (g === SCROLL) host.inv = host.inv.filter((i) => i.guid !== g);
    return true;
  };
  host.pickUp = (g: number) => {
    host.sent.push(`pickup ${g.toString(16)}`);
    const it = listing.find((i) => i.guid === g)!;
    host.inv.push({ guid: g, name: it.name, where: 'main pack', itemType: it.itemType } as AgentItem);
    if (host.container) host.container.items = host.container.items.filter((i) => i.guid !== g);
    return true;
  };
  const reports: string[] = [];
  api.routine.onReport = (r) => reports.push(r);
  api.routine.start(profile(loot));
  const tick = async (ms: number) => { for (let t = 0; t < ms; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(100); } };
  return { host, api, reports, tick };
}

describe('BUG.vtank-loot-wears-items — the loot pass never takes armor, jewelry or weapons "to read"', () => {
  afterEach(() => vi.useRealTimers());

  const corpse = [
    { guid: SCROLL, name: 'Scroll of Flame Bolt II', itemType: IT_WRITABLE },
    { guid: RING, name: 'Gold Ring', itemType: IT_JEWELRY },
    { guid: SWORD, name: 'Long Sword', itemType: IT_MELEE },
  ];

  it('an examined ring and sword with learnable-looking spells are left; only the scroll is taken and read; nothing else is Used', async () => {
    const t = lootSetup(corpse, [VALUE_RULE]);
    await t.tick(130_000);
    expect(t.host.sent).toContain(`pickup ${SCROLL.toString(16)}`);
    expect(t.host.sent).toContain(`use ${SCROLL.toString(16)}`);
    expect(t.reports).toContain('Read Scroll of Flame Bolt II');
    // Before: "Took to read Gold Ring (an unknown scroll)", then three Uses of each (AutoSort / AutoWield in the client).
    expect(t.host.sent).not.toContain(`pickup ${RING.toString(16)}`);
    expect(t.host.sent).not.toContain(`pickup ${SWORD.toString(16)}`);
    expect(t.host.sent.filter((x) => x === `use ${RING.toString(16)}` || x === `use ${SWORD.toString(16)}`)).toEqual([]);
    expect(t.reports.filter((r) => /Took to read (Gold Ring|Long Sword)/.test(r))).toEqual([]);
    t.api.routine.stop();
  });

  it('the loot rules see a corpse item\'s type: a Jewelry rule keeps the ring (it read "Unknown" before), and it is kept, not worn', async () => {
    const t = lootSetup(corpse, [VALUE_RULE, { label: 'Rings', action: 'keep', match: { types: ['Jewelry'] } }]);
    await t.tick(130_000);
    expect(t.host.sent).toContain(`pickup ${RING.toString(16)}`);
    expect(t.reports).toContain('Kept Gold Ring (rule: Rings)');
    expect(t.host.sent).not.toContain(`use ${RING.toString(16)}`);
    expect(t.host.sent.filter((x) => x.startsWith('wield '))).toEqual([]);
    t.api.routine.stop();
  });

  it('/vt testitem on an item selected in the open corpse: named and typed from the listing (it said "select an item first")', async () => {
    vi.useFakeTimers();
    const host = new FakeHost();
    const api = new AgentApi(host);
    host.container = { guid: CORPSE, items: [{ guid: RING, name: 'Gold Ring', itemType: IT_JEWELRY }] };
    host.appraisals.set(RING, 'Gold Ring');
    host.appraisalDatas.set(RING, RECORDS.get(RING)!);
    host.target = RING;
    expect(await api.routine.testItem([{ label: 'Rings', action: 'keep', match: { types: ['Jewelry'] } }])).toEqual(['TestItem: Gold Ring => keep (rule: Rings)']);
  });

  it('scrollSpell: a known non-scroll type is never a scroll; an unknown one is a scroll only by its examination\'s ItemType or its name', () => {
    expect(scrollSpell({ name: 'Gold Ring', itemType: IT_JEWELRY }, { spells: ['Strength Self II'] })).toBeNull();
    expect(scrollSpell({ name: 'Gold Ring', itemType: 0 }, { spells: ['Strength Self II'] })).toBeNull();
    expect(scrollSpell({ name: 'Gold Ring', itemType: 0 }, { spells: ['Strength Self II'], int: { 1: IT_JEWELRY } })).toBeNull();
    expect(scrollSpell({ name: 'Inscription', itemType: 0 }, { spells: ['Flame Bolt II'], int: { 1: IT_WRITABLE } })).toBe('Flame Bolt II');
    expect(scrollSpell({ name: 'Scroll of Flame Bolt II', itemType: 0 })).toBe('Flame Bolt II');
    expect(scrollSpell({ name: 'Scroll of Flame Bolt II', itemType: IT_WRITABLE }, { spells: ['Flame Bolt II'] })).toBe('Flame Bolt II');
  });
});

describe('BUG.vtank-loot-wears-items — a wield the server refuses for your skill is held, through looting and weapon swaps', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
  const MAIN = 0x50000001, WAND = 0x80007021, SHIRT = 0x80007022, PANTS = 0x50000002;

  /** The double-click on a wand you can't wield: the main weapon comes off first, then ACE refuses (SkillTooLow 0x0468). */
  function setup() {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const host = new FakeHost();
    host.inv = [
      { guid: MAIN, name: 'Iron Sword', where: 'equipped', mask: 0x100000, slot: 'MeleeWeapon', itemType: IT_MELEE, validLocations: 0x100000 },
      { guid: WAND, name: 'Wand', where: 'main pack', itemType: 0x8000, validLocations: 0x1000000 },
    ] as AgentItem[];
    const api = new AgentApi(host);
    host.wield = (g: number) => {
      host.sent.push(`wield ${g.toString(16)}`);
      if (g === WAND) {
        host.inv = host.inv.map((i) => (i.guid === MAIN ? { ...i, where: 'main pack', mask: undefined, slot: undefined } : i));
        setTimeout(() => api.pushChat('You are not skilled enough to use that.', 0x1a), 150);
      }
      if (g === SHIRT) api.pushChat('You must remove your Breeches to wear that', 0x1a);
      if (g === MAIN) setTimeout(() => { host.inv = host.inv.map((i) => (i.guid === MAIN ? { ...i, where: 'equipped', mask: 0x100000, slot: 'MeleeWeapon' } : i)); }, 150);
      return true;
    };
    const equip = async (g: number) => {
      let out: Awaited<ReturnType<AgentApi['equip']>> | null = null;
      void api.equip(g).then((x) => { out = x; });
      for (let t = 0; t < 8000 && !out; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(100); }
      return out as unknown as Awaited<ReturnType<AgentApi['equip']>>;
    };
    const wields = (g: number) => host.sent.filter((s) => s === `wield ${g.toString(16)}`).length;
    return { host, api, equip, wields };
  }

  it('refused once; asked again after a loot pickup and the main weapon going back on, nothing is sent; after the hold it may go', async () => {
    const t = setup();
    const first = await t.equip(WAND);
    expect(first.ok).toBe(false);
    expect(first.message).toMatch(/not skilled enough/);
    expect(t.wields(WAND)).toBe(1);
    // The fight puts the main weapon back; a corpse adds to the pack.
    await t.equip(MAIN);
    t.host.inv.push({ guid: 0x80007099, name: 'Pyreals', where: 'main pack', itemType: 0x40 } as AgentItem);
    const again = await t.equip(WAND);
    expect(again.ok).toBe(false);
    expect(again.message).toMatch(/not skilled enough .*not asked again/);
    expect(t.wields(WAND)).toBe(1);
    expect(t.api.equipHeld(WAND)).not.toBeNull();
    run(t.api, t.host, AgentApi.EQUIP_REFUSED_HOLD_MS);
    expect(t.api.equipHeld(WAND)).toBeNull();
  });

  it('a wear refused over what you wear is held until what you wear changes', async () => {
    const t = setup();
    t.host.inv.push(
      { guid: PANTS, name: 'Breeches', where: 'equipped', mask: 0x20, slot: 'UpperLegWear', itemType: 0x4, validLocations: 0x20 } as AgentItem,
      { guid: SHIRT, name: 'Shirt', where: 'main pack', itemType: 0x4, validLocations: 0x2 } as AgentItem,
    );
    const first = await t.equip(SHIRT);
    expect(first.ok).toBe(false);
    t.host.inv.push({ guid: 0x80007098, name: 'Pyreals', where: 'main pack', itemType: 0x40 } as AgentItem);
    expect((await t.equip(SHIRT)).message).toMatch(/nothing you wear has changed since/);
    expect(t.wields(SHIRT)).toBe(1);
    t.host.inv = t.host.inv.map((i) => (i.guid === PANTS ? { ...i, where: 'main pack', mask: undefined, slot: undefined } : i));
    expect(t.api.equipHeld(SHIRT)).toBeNull();
  });
});

describe('BUG.vtank-loot-wears-items — "Any Wand" means an Items-tab wand (or the one in hand), never a looted one', () => {
  const families = buildCombatFamilies({ spells: new Map([[27, { name: 'Flame Bolt I', category: 121, school: 1, bitfield: 0x3, power: 1 }]]) });
  const row = (extra: Partial<VtMonsterRow> = {}): VtMonsterRow => ({ ...structuredClone(VT_DEFAULT_MONSTER), name: '<DEFAULT>', on: ['A'], damage: VT_DAMAGE.Fire, weapon: 'Any Wand', ...extra });
  const LISTED: PlanItem = { guid: 900, name: 'Fire Wand', itemType: 0x8000 };
  const LOOT: PlanItem = { guid: 901, name: 'Wand', itemType: 0x8000 };
  const SWORD_IN_HAND: PlanItem = { guid: 902, name: 'Iron Sword', itemType: 0x1, equipped: true };
  const input = (over: Partial<CombatInput>): CombatInput => ({
    monsters: [{ guid: 1, name: 'Drudge Skulker', dist: 3, relBearing: 0 }], rows: [row()],
    spells: [{ id: 27, name: 'Flame Bolt I', school: 'War Magic', category: 121, power: 1, self: false, buff: false, duration: 0 }],
    skills: [{ id: 34, name: 'War Magic', training: 'specialized', base: 300, buffed: 300 }],
    items: [SWORD_IN_HAND, LOOT, LISTED], itemNames: ['Fire Wand'], wielded: { weapon: 'Iron Sword' }, stance: 'melee',
    settings: { AttackDistance: 30 }, castLog: [], now: 100_000, selectedGuid: null, families, ...over,
  });

  it('wields the listed wand, though a looted one comes first in the pack', () => {
    const a = planCombat(input({}));
    expect(a).toMatchObject({ kind: 'equip', item: { guid: LISTED.guid } });
  });

  it('none listed: the looted wand is not wielded (the weapon in hand stays)', () => {
    const a = planCombat(input({ items: [SWORD_IN_HAND, LOOT], itemNames: [] }));
    expect(a?.kind === 'equip' && a.item.guid === LOOT.guid).toBe(false);
  });
});

describe('BUG.vtank-loot-wears-items sweep — "use this item" steps never Use something a Use would put on', () => {
  it('a buff item named on the Consumables tab: a gem of it is used, a ring of the same name is not (its Use would wear it)', () => {
    // ACE: a gem's spell is its Spell data id 28, from its public description (agent/itemRecord.ts).
    const rec = aceRecord({ header: { itemType: 0x800, spellDid: 2 } });
    const gem: PlanItem = { guid: 1, name: "Asheron's Benediction", itemType: 0x800, ints: rec.int, dids: rec.did };
    const ring: PlanItem = { ...gem, guid: 2, itemType: IT_JEWELRY };
    const base = {
      listed: ["Asheron's Benediction"], active: [], threshold: 60, skills: [], inFellowship: false, cooldownLeft: () => 0,
      spellTable: { spells: new Map([[2, { name: 'Strength Self II', category: 2, school: 4, bitfield: 0x4 | 0x8, power: 50, duration: 1800 }]]) },
    };
    expect(planBuffItem({ ...base, items: [ring] })).toBeNull();
    expect(planBuffItem({ ...base, items: [ring, gem] })?.item.guid).toBe(1);
    expect([IT_JEWELRY, IT_MELEE, 0x2, 0x4, 0x100, 0x8000].every(useWouldPutOn)).toBe(true);
    expect([0x800, 0x20, 0x80, IT_WRITABLE, 0x80000, 0].some(useWouldPutOn)).toBe(false);
  });
});
