/**
 * docs/vtank-parity-gaps.md §3.1 — VirindiTank's salvaging: what a Salvage loot rule took goes into the
 * Ust (never a tinkered or retained item), and CombineSalvage merges partial bags of one material by the
 * .utl's SalvageCombine workmanship bands (VTClassic's defaults without one). Pure parts (the .utl block,
 * the bands, the planner) and the engine through the AgentApi fakes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ALL_MODULES_OFF, importVTank, parseSalvageBands, parseSalvageCombineBlock, parseUtl, parseUtlFile, SALVAGE_COMBINE_DEFAULTS,
  salvageBandIndex, validateRoutineDoc, vtOption, ROUTINE_SCHEMA_VERSION, type RoutineProfile, type SalvageCombine,
} from '../packages/shared/src/routines/index.ts';
import { findUst, isPartialBag, planSalvageCombine, salvageRefusal, type SalvageItem } from '../packages/renderer/src/agent/macro/salvagePlan.ts';
import { AgentApi, type AgentHost } from '../packages/renderer/src/agent/AgentApi.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import { parseCreateObject } from '../packages/network/src/MessageSerializer.ts';
import { buildInventoryEntry } from '../packages/renderer/src/network/objectSubjectRouting.ts';

const CRLF = (lines: string[]) => lines.join('\r\n');
/** A SalvageCombine block's body as VTClassic writes it (UTLBlock_SalvageCombine.Write). */
const blockBody = (lines: string[]) => `${CRLF(lines)}\r\n`;
const utlWith = (block: string | null) => {
  const req = 'Iron Sword\r\n1\r\n';
  const rule = CRLF(['Salvage it', '', '0;2;1', String(req.length), 'Iron Sword', '1']);
  const head = `UTL\r\n1\r\n1\r\n${rule}\r\n`;
  return block === null ? head : `${head}SalvageCombine\r\n${block.length}\r\n${block}`;
};

/** A CreateObject for a salvage bag: WeenieHeaderFlag.Workmanship (0x01000000) float, then MaterialType (0x80000000) u32. */
function bagCreateObject(workmanship: number | null, material: number): Uint8Array {
  const b: number[] = [];
  const u8 = (v: number) => b.push(v & 0xff);
  const u16 = (v: number) => { u8(v); u8(v >> 8); };
  const u32 = (v: number) => { u16(v); u16(v >>> 16); };
  const align = () => { while (b.length % 4) u8(0); };
  const flags = (workmanship !== null ? 0x01000000 : 0) | 0x80000000;
  u32(0x80036667); u8(0x11); u8(0); u8(0); u8(0); align(); u32(0); u32(0);
  for (let i = 0; i < 9; i++) u16(0);
  align();
  u32(flags >>> 0);
  const name = 'Salvage (40)';
  u16(name.length); for (const c of name) u8(c.charCodeAt(0)); align();
  u16(20983); u16(1); u32(0x40000000); u32(0); align();
  if (workmanship !== null) { const f = new DataView(new ArrayBuffer(4)); f.setFloat32(0, workmanship, true); for (let i = 0; i < 4; i++) u8(f.getUint8(i)); }
  u32(material);
  return new Uint8Array(b);
}

describe('a salvage bag\'s workmanship off the wire', () => {
  it('parseCreateObject keeps WeenieHeaderFlag.Workmanship (a bag\'s average) and the inventory entry carries it', () => {
    const obj = parseCreateObject(bagCreateObject(7.5, 61))!;
    expect(obj.workmanship).toBeCloseTo(7.5);
    expect(obj.materialType).toBe(61);
    expect(buildInventoryEntry(obj).workmanship).toBeCloseTo(7.5);
    const none = parseCreateObject(bagCreateObject(null, 61))!;
    expect(none.workmanship).toBeUndefined();
    expect(none.materialType).toBe(61);
    expect(buildInventoryEntry(none).workmanship).toBeUndefined();
  });
});

describe('.utl SalvageCombine block', () => {
  it('reads the default bands, the material overrides and (newer blocks) the value modes', () => {
    const body = blockBody(['1', '1-6, 7-8, 9, 10', '2', '10', '1-10', '64', '1-5;6-10', '1', '64', '25000']);
    const f = parseUtlFile(utlWith(body));
    expect(f.rules.map((r) => r.name)).toEqual(['Salvage it']);
    expect(f.salvageCombine).toEqual({ default: '1-6, 7-8, 9, 10', materials: { 10: '1-10', 64: '1-5;6-10' }, valueModes: { 64: 25000 } });
    // An older block (Mag's "I Hold Steel.utl") ends after the overrides.
    expect(parseSalvageCombineBlock(blockBody(['1', '1-10', '0']))).toEqual({ default: '1-10', materials: {} });
    // parseUtl still gives the rules alone.
    expect(parseUtl(utlWith(body)).map((r) => r.action)).toEqual([2]);
  });

  it('no block: nothing (VTClassic defaults apply); a block cut short is skipped and the rules still import', () => {
    expect(parseUtlFile(utlWith(null)).salvageCombine).toBeUndefined();
    // tests/fixtures/vtank/loot.utl ends in a SalvageCombine header whose body is cut short.
    const fixture = readFileSync(resolve(__dirname, 'fixtures/vtank/loot.utl'), 'latin1');
    const f = parseUtlFile(fixture);
    expect(f.rules.length).toBeGreaterThan(0);
    expect(f.salvageCombine).toBeUndefined();
  });

  it('import keeps each .utl\'s bands with its loot set, the first one active; the validator accepts them and refuses bad ones', () => {
    const a = utlWith(blockBody(['1', '1-5, 6-10', '1', '64', '1-10', '0']));
    const b = utlWith(null);
    const r = importVTank([{ name: 'Mine.utl', text: a }, { name: 'Plain.utl', text: b }], null, 'P');
    expect(r.value.salvageCombine).toEqual({ default: '1-5, 6-10', materials: { 64: '1-10' } });
    expect(r.value.salvageCombineSets).toEqual({ Mine: { default: '1-5, 6-10', materials: { 64: '1-10' } } });
    const doc = { schemaVersion: ROUTINE_SCHEMA_VERSION, account: 'a', server: 'local', profiles: [r.value] };
    expect(validateRoutineDoc(doc)).toEqual([]);
    // It survives a save (the routine document is stored as JSON).
    expect(JSON.parse(JSON.stringify(r.value)).salvageCombine).toEqual(r.value.salvageCombine);
    const bad = { ...doc, profiles: [{ ...r.value, salvageCombine: { default: 'six to ten', materials: { iron: '1-10' } } }] };
    expect(validateRoutineDoc(bad).map((x) => x.path)).toEqual(['profiles[0].salvageCombine.default', 'profiles[0].salvageCombine.materials.iron']);
  });
});

describe('workmanship bands (VTClassic GetRangeIndex)', () => {
  it('parses ranges and single numbers; a gap goes with the range below it; past the end is a band of its own', () => {
    const bands = parseSalvageBands('1-6, 7-8, 9, 10');
    expect(bands).toEqual([[1, 6], [7, 8], [9, 9], [10, 10]]);
    expect(salvageBandIndex(bands, 3.5)).toBe(0);
    expect(salvageBandIndex(bands, 6.5)).toBe(0); // the gap 6–7 counts with 1-6
    expect(salvageBandIndex(bands, 7)).toBe(1);
    expect(salvageBandIndex(bands, 9.4)).toBe(2);
    expect(salvageBandIndex(bands, 10)).toBe(3);
    expect(salvageBandIndex(bands, 0.5)).toBe(-1);
    expect(salvageBandIndex(parseSalvageBands('1-5'), 7)).toBe(1);
  });
  it('the defaults: "1-6, 7-8, 9, 10", and "1-10" for the 25 tinkering materials (as every corpus .utl lists)', () => {
    expect(SALVAGE_COMBINE_DEFAULTS.default).toBe('1-6, 7-8, 9, 10');
    expect(Object.keys(SALVAGE_COMBINE_DEFAULTS.materials!)).toHaveLength(25);
    expect(SALVAGE_COMBINE_DEFAULTS.materials![41]).toBe('1-10'); // Sunstone
    expect(SALVAGE_COMBINE_DEFAULTS.materials![61]).toBeUndefined(); // Iron
  });
});

describe('the salvage planner', () => {
  const ust: SalvageItem = { guid: 1, name: 'Ust', itemType: 0x20000000, wcid: 20646 };
  const bag = (guid: number, material: number, workmanship: number, structure: number, value = 100): SalvageItem =>
    ({ guid, name: `Salvage (${structure})`, itemType: 0x40000000, materialType: material, workmanship, structure, value });

  it('finds the Ust; refuses tinkered, retained, worn and material-less items', () => {
    expect(findUst([{ guid: 9, name: 'Sword', itemType: 1 }, ust])?.guid).toBe(1);
    expect(findUst([{ guid: 9, name: 'Sword', itemType: 1 }])).toBeUndefined();
    const sword: SalvageItem = { guid: 5, name: 'Iron Sword', itemType: 1, materialType: 61, workmanship: 6 };
    expect(salvageRefusal(sword, { int: {}, bool: {} })).toBeNull();
    expect(salvageRefusal(sword, { int: { 171: 2 } })).toBe('it has been tinkered');
    expect(salvageRefusal({ ...sword, objectDescFlags: 0x01000000 }, { int: {} })).toBe('it is retained');
    expect(salvageRefusal(sword, { bool: { 91: true } })).toBe('it is retained');
    expect(salvageRefusal({ ...sword, equipped: true }, {})).toBe('it is worn');
    expect(salvageRefusal({ ...sword, materialType: 0 }, {})).toBe('it has no material');
    expect(salvageRefusal({ ...sword, workmanship: undefined }, {})).toBe('it has no workmanship');
  });

  it('combines partial bags of one material in one band, up to 100 units; not across bands, materials or full bags', () => {
    const d = SALVAGE_COMBINE_DEFAULTS;
    // Iron (61, default bands): 3.2 and 5.0 share 1-6; 7.5 is in 7-8 alone.
    expect(planSalvageCombine([bag(10, 61, 3.2, 40), bag(11, 61, 7.5, 30), bag(12, 61, 5, 50)], d)?.guids).toEqual([10, 12]);
    expect(planSalvageCombine([bag(10, 61, 3.2, 40), bag(11, 61, 7.5, 30)], d)).toBeNull();
    // Different materials never combine; a full bag is not partial.
    expect(planSalvageCombine([bag(10, 61, 3, 40), bag(11, 64, 3, 30)], d)).toBeNull();
    expect(isPartialBag(bag(13, 61, 3, 100))).toBe(false);
    expect(planSalvageCombine([bag(10, 61, 3, 40), bag(13, 61, 3, 100)], d)).toBeNull();
    // Sunstone (41) is "1-10": any workmanships combine.
    expect(planSalvageCombine([bag(20, 41, 2, 20), bag(21, 41, 9.5, 20)], d)?.guids).toEqual([20, 21]);
    // Bags are taken in workmanship order until 100 units.
    expect(planSalvageCombine([bag(30, 61, 1, 60), bag(31, 61, 2, 50), bag(32, 61, 3, 10)], d)?.guids).toEqual([30, 31]);
    // The profile's own bands replace the defaults; a bag given up on is skipped.
    const own: SalvageCombine = { default: '1-10' };
    expect(planSalvageCombine([bag(10, 61, 3.2, 40), bag(11, 61, 7.5, 30)], own)?.guids).toEqual([10, 11]);
    expect(planSalvageCombine([bag(10, 61, 3.2, 40), bag(11, 61, 7.5, 30)], own, new Set([10]))).toBeNull();
  });

  it('value mode: the whole band once it is worth the target, else the first two bags under 100 units', () => {
    const vm: SalvageCombine = { default: '1-10', valueModes: { 61: 1000 } };
    expect(planSalvageCombine([bag(1, 61, 3, 60, 600), bag(2, 61, 4, 60, 500), bag(3, 61, 5, 10, 10)], vm)?.guids).toEqual([1, 2, 3]);
    expect(planSalvageCombine([bag(1, 61, 3, 60, 100), bag(2, 61, 4, 60, 100), bag(3, 61, 5, 30, 10)], vm)?.guids).toEqual([1, 3]);
    expect(planSalvageCombine([bag(1, 61, 3, 60, 100), bag(2, 61, 4, 60, 100)], vm)).toBeNull();
  });

  it('CombineSalvage is an option the engine acts on (on by default)', () => {
    expect(vtOption('CombineSalvage')).toMatchObject({ default: true, engine: true });
  });
});

describe('the routine engine salvages what the loot rules took', () => {
  let host: FakeHost;
  let api: AgentApi;
  let salvaged: number[][];
  const UST = 0x50000090;
  const MONSTER = 0x80002102;
  const CORPSE = 0x80002103;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    salvaged = [];
    // The era's salvage action (CreateTinkeringTool): the server destroys the items and makes a bag.
    (host as AgentHost).salvage = (tool, items) => {
      expect(tool).toBe(UST);
      salvaged.push([...items]);
      host.inv = host.inv.filter((i) => !items.includes(i.guid));
      return true;
    };
    api = new AgentApi(host);
  });
  afterEach(() => { api.routine.stop(); vi.useRealTimers(); });

  const profile = (over: Partial<RoutineProfile> = {}): RoutineProfile => ({
    name: 'Salvager', modules: { ...ALL_MODULES_OFF, combat: true, looting: true },
    initialState: 'Hunt', buffSets: [], routes: [],
    loot: [{ label: 'Iron', action: 'salvage', match: { name: '^Iron' } }],
    states: [{ name: 'Hunt', rules: [{ label: 'Fight', when: [{ kind: 'monster-within', meters: 40 }], do: [{ kind: 'attack-nearest', meters: 40 }, { kind: 'loot-nearby', meters: 20 }] }] }],
    ...over,
  });
  const step = async (ms: number) => { for (let t = 0; t < ms; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(100); } };

  /** Kill a drudge whose corpse holds `items`; each item picked up lands in the pack. */
  const killAndLoot = async (items: Array<{ guid: number; name: string }>, inPack: (g: number) => Record<string, unknown> = () => ({})) => {
    host.add({ guid: MONSTER, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 23 });
    for (const it of items) host.add({ ...it, itemType: 0x1, cell: 0 });
    host.pickUp = (g: number) => {
      host.sent.push(`pickup ${g.toString(16)}`);
      const it = items.find((x) => x.guid === g)!;
      host.inv.push({ guid: g, name: it.name, where: 'main pack', ...inPack(g) } as never);
      if (host.container) host.container.items = host.container.items.filter((x) => x.guid !== g);
      return true;
    };
    await step(600);
    host.dying.add(MONSTER);
    await step(200);
    host.objs.delete(MONSTER);
    host.add({ guid: CORPSE, name: 'Corpse of Drudge Skulker', objectDescFlags: 0x2000, x: 80, y: 23 });
    for (let i = 0; i < 40 && !host.sent.includes(`use ${CORPSE.toString(16)}`); i++) await step(100);
    host.container = { guid: CORPSE, items: items.map(({ guid, name }) => ({ guid, name })) };
    for (let i = 0; i < 200 && !api.routine.status().last.some((l) => l.includes('loot-nearby')); i++) await step(100);
    host.container = null;
    host.objs.delete(CORPSE);
  };
  const ironProps = { materialType: 61, workmanship: 6, objectDescFlags: 0 };
  const examined = (g: number, int: Record<number, number> = {}) => {
    host.appraised.push(g);
    host.appraisalDatas.set(g, { int, float: {}, string: {}, bool: {}, did: {}, spells: [] });
  };

  it('a Salvage item goes into the Ust through the salvage action, once the corpse is done', async () => {
    host.inv = [{ guid: UST, name: 'Ust', where: 'main pack', itemType: 0x20000000, wcid: 20646 } as never];
    const reports: string[] = [];
    api.routine.onReport = (r) => reports.push(r);
    api.routine.start(profile());
    await killAndLoot([{ guid: 0x80003001, name: 'Iron Sword' }, { guid: 0x80003002, name: 'Old Rag' }], () => ironProps);
    expect(host.sent).toContain('pickup 80003001');
    expect(host.sent).not.toContain('pickup 80003002');
    // It looks at the item first (a tinkered one is never salvaged), quietly.
    await step(1000);
    expect(host.appraiseCalls).toContainEqual({ guid: 0x80003001, quiet: true });
    expect(salvaged).toEqual([]);
    examined(0x80003001);
    await step(2000);
    expect(salvaged).toEqual([[0x80003001]]);
    expect(reports).toContain('Salvaged Iron Sword');
    // Once: it is gone.
    await step(3000);
    expect(salvaged).toEqual([[0x80003001]]);
  });

  it('a tinkered item is kept, said so; nothing is sent', async () => {
    host.inv = [{ guid: UST, name: 'Ust', where: 'main pack', itemType: 0x20000000, wcid: 20646 } as never];
    const reports: string[] = [];
    api.routine.onReport = (r) => reports.push(r);
    examined(0x80003001, { 171: 1 });
    api.routine.start(profile());
    await killAndLoot([{ guid: 0x80003001, name: 'Iron Sword' }], () => ironProps);
    await step(3000);
    expect(salvaged).toEqual([]);
    expect(reports).toContain('Kept Iron Sword unsalvaged: it has been tinkered');
  });

  it('no Ust: warned once, the item kept; a Ust in the pack later salvages it', async () => {
    const reports: string[] = [];
    api.routine.onReport = (r) => reports.push(r);
    examined(0x80003001);
    api.routine.start(profile());
    await killAndLoot([{ guid: 0x80003001, name: 'Iron Sword' }], () => ironProps);
    await step(4000);
    expect(salvaged).toEqual([]);
    expect(reports.filter((r) => r.startsWith('No Ust'))).toEqual(['No Ust in your inventory: items marked for salvage are kept until you carry one.']);
    host.inv.push({ guid: UST, name: 'Ust', where: 'main pack', itemType: 0x20000000, wcid: 20646 } as never);
    await step(2000);
    expect(salvaged).toEqual([[0x80003001]]);
  });

  it('an era with no salvaging (1999: no salvage action) leaves Salvage items alone', async () => {
    delete (host as AgentHost).salvage;
    host.inv = [{ guid: UST, name: 'Ust', where: 'main pack', itemType: 0x20000000, wcid: 20646 } as never];
    examined(0x80003001);
    const reports: string[] = [];
    api.routine.onReport = (r) => reports.push(r);
    api.routine.start(profile());
    await killAndLoot([{ guid: 0x80003001, name: 'Iron Sword' }], () => ironProps);
    await step(3000);
    expect(api.canSalvage()).toBe(false);
    expect(host.inv.some((i) => i.guid === 0x80003001)).toBe(true);
    expect(reports.some((r) => /No Ust|Salvaged/.test(r))).toBe(false);
  });

  it('CombineSalvage: partial bags of one band go through the Ust together; off, they stay; the profile\'s bands decide', async () => {
    const bag = (guid: number, workmanship: number, structure: number) => ({ guid, name: `Salvage (${structure})`, where: 'main pack', itemType: 0x40000000, materialType: 61, workmanship, structure });
    const ust = { guid: UST, name: 'Ust', where: 'main pack', itemType: 0x20000000, wcid: 20646 };
    const quiet = profile({ states: [{ name: 'Hunt', rules: [] }] });
    host.inv = [ust, bag(0x50000101, 3, 40), bag(0x50000102, 7.5, 30), bag(0x50000103, 5, 50)] as never;
    api.routine.start({ ...quiet, settings: { CombineSalvage: false } });
    await step(2000);
    expect(salvaged).toEqual([]);
    api.routine.stop();
    api.routine.start(quiet);
    await step(2000);
    // VTClassic's default bands: 3 and 5 share 1-6; 7.5 is alone in 7-8.
    expect(salvaged).toEqual([[0x50000101, 0x50000103]]);
    api.routine.stop();
    salvaged.length = 0;
    host.inv = [ust, bag(0x50000101, 3, 40), bag(0x50000102, 7.5, 30)] as never;
    api.routine.start({ ...quiet, salvageCombine: { default: '1-10' } });
    await step(2000);
    expect(salvaged).toEqual([[0x50000101, 0x50000102]]);
  });

  it('the macro salvages with Enable Looting on, not off', async () => {
    const ust = { guid: UST, name: 'Ust', where: 'main pack', itemType: 0x20000000, wcid: 20646 };
    const bag = (guid: number, workmanship: number) => ({ guid, name: 'Salvage (40)', where: 'main pack', itemType: 0x40000000, materialType: 61, workmanship, structure: 40 });
    host.inv = [ust, bag(0x50000101, 3), bag(0x50000102, 4)] as never;
    const macro = profile({ states: [{ name: 'Hunt', rules: [] }], macro: true });
    api.routine.start({ ...macro, settings: { EnableLooting: false } });
    await step(2000);
    expect(salvaged).toEqual([]);
    api.routine.stop();
    api.routine.start({ ...macro, settings: { EnableLooting: true } });
    await step(2000);
    expect(salvaged).toEqual([[0x50000101, 0x50000102]]);
  });
});
