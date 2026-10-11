/**
 * AGENT.vtank-crafting — VirindiTank's AutoCraftItems planner (craftPlan.ts),
 * the per-era recipe tables (tools/build-craft-tables.ts) and the macro doing
 * the craft through the agent API (vtMacro.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanSkill, RoutineProfile } from '../packages/shared/src/index.ts';
import { ALL_MODULES_OFF, emptyVtankData } from '../packages/shared/src/routines/index.ts';
import { FLETCHING_SKILL, idleCraftCategory, indexRecipes, planCraft, type CraftRow } from '../packages/renderer/src/agent/macro/craftPlan.ts';
import { parseRecipeSql } from '../tools/build-craft-tables.ts';
import EOL from '../packages/renderer/src/agent/macro/crafts/eol.ts';
import AC1999 from '../packages/renderer/src/agent/macro/crafts/ac1999.ts';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

const ARROWS: CraftRow = ['Bundle of Arrowheads', 'Bundle of Arrowshafts', 'Arrow', 10, FLETCHING_SKILL, 5, 323];
const SHAFTS: CraftRow = ['Knife', 'Wood', 'Bundle of Arrowshafts', 1, 0, 0, 900];
const KIT: CraftRow = ['Salve', 'Bandage', 'Healing Kit', 1, 0, 0, 901];
const fletcher = (buffed: number, training: PlanSkill['training'] = 'trained'): PlanSkill[] => [{ id: FLETCHING_SKILL, name: 'Fletching', training, base: buffed, buffed }];
const item = (guid: number, name: string, stack?: number) => ({ guid, name, ...(stack ? { stack } : {}) });

describe('planCraft (VTank AutoCraftItems: facts from openac-mosstank, docs/vtank-macro-behavior.md)', () => {
  const recipes = indexRecipes([ARROWS, SHAFTS, KIT]);

  it('crafts a wanted item you are out of from the parts you carry', () => {
    const s = planCraft({ recipes, items: [item(1, 'Bundle of Arrowheads'), item(2, 'Bundle of Arrowshafts')], skills: fletcher(100), want: [{ name: 'Arrow', count: 1 }], fletchExcess: 10 });
    expect(s).toMatchObject({ first: { guid: 1 }, second: { guid: 2 }, result: 'Arrow', count: 10, why: 'crafting Arrow (Bundle of Arrowheads on Bundle of Arrowshafts)' });
    // Carried already: nothing to do.
    expect(planCraft({ recipes, items: [item(1, 'Bundle of Arrowheads'), item(2, 'Bundle of Arrowshafts'), item(3, 'Arrow', 40)], skills: fletcher(100), want: [{ name: 'Arrow', count: 1 }], fletchExcess: 10 })).toBeNull();
  });

  it('a missing ingredient is crafted first when a recipe makes it', () => {
    const s = planCraft({ recipes, items: [item(1, 'Bundle of Arrowheads'), item(4, 'Knife'), item(5, 'Wood')], skills: fletcher(100), want: [{ name: 'Arrow', count: 1 }], fletchExcess: 10 });
    expect(s).toMatchObject({ result: 'Bundle of Arrowshafts', for: 'Arrow', first: { guid: 4 }, second: { guid: 5 } });
  });

  it('Fletching needs the skill trained and ≥ difficulty + ArrowheadFletchDiffExcessThreshold; a skill-less recipe needs nothing', () => {
    const parts = [item(1, 'Bundle of Arrowheads'), item(2, 'Bundle of Arrowshafts')];
    expect(planCraft({ recipes, items: parts, skills: fletcher(14), want: [{ name: 'Arrow', count: 1 }], fletchExcess: 10 })).toBeNull();
    expect(planCraft({ recipes, items: parts, skills: fletcher(15), want: [{ name: 'Arrow', count: 1 }], fletchExcess: 10 })).not.toBeNull();
    expect(planCraft({ recipes, items: parts, skills: fletcher(500, 'untrained'), want: [{ name: 'Arrow', count: 1 }], fletchExcess: 10 })).toBeNull();
    expect(planCraft({ recipes, items: [item(6, 'Salve'), item(7, 'Bandage')], skills: [], want: [{ name: 'Healing Kit', count: 1 }], fletchExcess: 10 })?.result).toBe('Healing Kit');
  });

  it('an idle count tops a stack up; a recipe cycle ends instead of looping', () => {
    const parts = [item(6, 'Salve'), item(7, 'Bandage'), item(8, 'Healing Kit', 1)];
    expect(planCraft({ recipes, items: parts, skills: [], want: [{ name: 'Healing Kit', count: 1 }], fletchExcess: 0 })).toBeNull();
    expect(planCraft({ recipes, items: parts, skills: [], want: [{ name: 'Healing Kit', count: 2 }], fletchExcess: 0 })?.result).toBe('Healing Kit');
    const loop = indexRecipes([['A', 'B', 'C', 1, 0, 0, 1], ['C', 'X', 'A', 1, 0, 0, 2]]);
    expect(planCraft({ recipes: loop, items: [item(9, 'B')], skills: [], want: [{ name: 'C', count: 1 }], fletchExcess: 0 })).toBeNull();
  });

  it('idle categories: kits by VTank\'s names, food by its examined BoosterEnum', () => {
    expect(idleCraftCategory('Greater Stamina Kit')).toBe('StamKits');
    expect(idleCraftCategory('Lesser Mana Kit')).toBe('ManaKits');
    expect(idleCraftCategory('Plentiful Healing Kit')).toBe('HealthKits');
    expect(idleCraftCategory('Apple', 2)).toBe('HealthFood');
    expect(idleCraftCategory('Mana Holtburger', 6)).toBe('ManaFood');
    expect(idleCraftCategory('Apple')).toBeNull();
  });
});

describe('the recipe tables (tools/build-craft-tables.ts)', () => {
  it('parses an ACE recipe file: the result, skill, difficulty and every cook_book pair', () => {
    const sql = "INSERT INTO `recipe` (`id`, `unknown_1`, `skill`, `difficulty`, `salvage_Type`, `success_W_C_I_D`, `success_Amount`, `success_Message`) VALUES (257, 0, 39 /* Cooking */, 100, 0, 7862 /* Mana Holtburger */, 1, 'You make a mana Holtburger.');\n" +
      "INSERT INTO `cook_book` (`recipe_Id`, `source_W_C_I_D`, `target_W_C_I_D`, `last_Modified`)\nVALUES (257, 5334 /* Mana Oil */,  7860 /* Holtburger */, '2005-02-09 10:00:00')\n     , (257, 5335 /* Mana Oil */,  7861 /* Holtburger */, '2005-02-09 10:00:00');";
    expect(parseRecipeSql(sql)).toEqual([
      { first: 'Mana Oil', second: 'Holtburger', result: 'Mana Holtburger', count: 1, skill: 39, difficulty: 100, id: 257 },
      { first: 'Mana Oil', second: 'Holtburger', result: 'Mana Holtburger', count: 1, skill: 39, difficulty: 100, id: 257 },
    ]);
  });

  it('the shipped end-of-retail and 1999 tables hold real recipes (arrows from heads and shafts by Fletching)', () => {
    const eol = JSON.parse(EOL) as CraftRow[];
    expect(eol.length).toBeGreaterThan(5000);
    expect(eol).toContainEqual(['Bundle of Arrowheads', 'Bundle of Arrowshafts', 'Arrow', 10, 37, 5, 323]);
    // Only the skills VTank crafts with (none, Fletching, Alchemy, Cooking).
    expect(new Set(eol.map((r) => r[4]))).toEqual(new Set([0, 37, 38, 39]));
    expect((JSON.parse(AC1999) as CraftRow[]).length).toBeGreaterThan(100);
  });
});

describe('the macro crafts (vtMacro, through the agent API)', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    (host as unknown as { craftTable: () => Promise<CraftRow[]> }).craftTable = async () => [ARROWS];
    (host as unknown as { skillList: () => unknown[] }).skillList = () => fletcher(120);
    (host as unknown as Record<string, unknown>).spellTableData = () => ({ spells: new Map() });
    host.inv = [
      { guid: 0x50000a10, name: 'Bundle of Arrowheads', where: 'main pack', stack: 1 },
      { guid: 0x50000a11, name: 'Bundle of Arrowshafts', where: 'main pack', stack: 1 },
    ] as never;
  });
  const vt = (settings: Record<string, string | number | boolean> = {}): RoutineProfile => {
    const data = emptyVtankData();
    data.consumables = ['Arrow'];
    return { name: 'Craft', modules: { ...ALL_MODULES_OFF, combat: true, buffs: true, vitals: true }, initialState: 'Default', states: [{ name: 'Default', rules: [] }], loot: [], buffSets: [], routes: [], macro: true, settings: { EnableBuffing: false, ...settings }, vtank: data } as RoutineProfile;
  };
  const step = async (ms: number) => { for (let t = 0; t < ms; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(100); } };

  it('AutoCraftItems (on by default, as VTank): out of a listed item, it uses the parts on each other in peace mode', async () => {
    // The server's chance-of-success confirmation (ACE RecipeManager) pops up after the use: the macro presses Yes.
    const use = host.useWithTarget.bind(host);
    host.useWithTarget = (a: number, b: number) => { const r = use(a, b); host.dialogList.push({ text: 'You have a 100 percent chance of using Bundle of Arrowheads on Bundle of Arrowshafts.', buttons: ['Yes', 'No'] }); return r; };
    api.routine.start(vt());
    await step(2000);
    expect(host.sent).toContain('usewith 50000a10 50000a11');
    expect(host.dialogList).toEqual([]); // answered (Yes)
    api.routine.stop();
    host.sent.length = 0;
    const off = new AgentApi(host);
    off.routine.start(vt({ AutoCraftItems: false }));
    for (let t = 0; t < 2000; t += 100) { run(off, host, 100); await vi.advanceTimersByTimeAsync(100); }
    expect(host.sent.filter((x) => x.startsWith('usewith'))).toEqual([]);
  });
});
