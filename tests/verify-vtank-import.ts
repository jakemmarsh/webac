/**
 * AGENT.vtank-import — VirindiTank .met / .nav / .utl into the routine
 * document. The fixtures are our own files in VTank's formats, checked with
 * an independent reference parser (docs/vtank-formats.md); the importer also
 * read 108 community metas, 108 navs and 92 loot profiles with no errors
 * while it was built.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseMapCoords } from '../packages/renderer/src/agent/AgentApi.js';
import { Palette } from '../packages/dat-parser/src/file-types/Palette.js';
import { DAT_PATHS, openDat } from './_harness/dat.js';
import { VTCLASSIC_COLOR_SLOTS } from '../packages/shared/src/routines/vtank.js';
import {
  emptyRoutineDoc, importVTank, navToRoute, metToProfile, navCoords, parseMet, parseNav, parseUtl, utlToLoot, validateRoutineDoc, vtankKind,
} from '../packages/shared/src/routines/index.js';
import { colourNear, lootRuleFor, vtcHsv } from '../packages/renderer/src/agent/RoutineEngine.js';

const fx = (f: string) => readFileSync(resolve(__dirname, 'fixtures', 'vtank', f), 'latin1');

describe('.nav', () => {
  it('reads the route type and every step; coordinates land on the same metre', () => {
    const nav = parseNav(fx('holtburg-loop.nav'));
    expect(nav.mode).toBe('circular');
    expect(nav.nodes.map((n) => [n.type, n.extra])).toEqual([[0, []], [3, ['5000']], [2, ['1635']]]);
    // VTank's 42.100 north = global/240 − 101.95, the origin parseMapCoords reads with: the same spot.
    expect(navCoords(33.6, 42.1)).toBe('42.100N, 33.600E');
    expect(navCoords(-10, -0.02)).toBe('0.020S, 10.000W');
    const p = parseMapCoords(navCoords(33.6, 42.1))!;
    expect(p.x / 240 - 101.95).toBeCloseTo(33.6, 6);
    expect(p.y / 240 - 101.95).toBeCloseTo(42.1, 6);
  });

  it('reads LF-only copies too (the lengths count CRLF)', () => {
    expect(parseNav(fx('holtburg-loop.nav').replace(/\r\n/g, '\n')).nodes).toHaveLength(3);
  });
});

describe('.utl', () => {
  it('reads rules in order with their requirements and keep-up-to counts', () => {
    const rules = parseUtl(fx('loot.utl'));
    expect(rules.map((r) => [r.name, r.action, r.keepCount])).toEqual([
      ['Pyreals', 1, undefined], ['Healing kits', 10, 5], ['Valuable', 3, undefined], ['Rares', 1, undefined], ['Off', 1, undefined],
    ]);
    expect(rules[2].reqs).toEqual([{ type: 3, lines: ['500', '19'] }, { type: 7, lines: ['2'] }]);
  });

  it('becomes loot rules: name, value, object class, keep-up-to, item properties; a switched-off rule stays off', () => {
    const { value: loot, problems } = utlToLoot(parseUtl(fx('loot.utl')));
    expect(loot[0]).toEqual({ label: 'Pyreals', action: 'keep', match: { name: '^Pyreals?$' } });
    expect(loot[1]).toEqual({ label: 'Healing kits', action: 'keep-up-to', count: 5, match: { name: 'Healing Kit' } });
    expect(loot[2]).toEqual({ label: 'Valuable', action: 'sell', match: { valueAtLeast: 500, types: ['Armor'] } });
    // Decal's IconUnderlay key is ACE DID 52; the rare underlay 0x06005B0C has the low bits 23308.
    expect(loot[3].match.props).toEqual([{ kind: 'did', key: 52, op: 'eq', value: 23308 }]);
    expect(loot[4].disabled).toBe(true);
    expect(problems).toEqual([]);
    const props = (did: Record<number, number>) => ({ int: {}, float: {}, string: {}, bool: {}, did, spells: [] });
    expect(lootRuleFor(loot, { name: 'Junk' })).toBeNull();
    expect(lootRuleFor(loot, { name: 'Gem', props: props({ 52: 0x06005b0c }) })?.label).toBe('Rares');
    expect(lootRuleFor(loot, { name: 'Leather Cap', type: 'Armor', value: 900 })?.label).toBe('Valuable');
  });
});

describe('.met', () => {
  it('reads every rule: condition, action, data, state', () => {
    const rules = parseMet(fx('hunt.met'));
    expect(rules.map((r) => [r.state, r.cond, r.act])).toEqual([
      ['Default', 1, 4], ['Default', 13, 3], ['Default', 2, 1], ['Fight', 3, 1], ['Sell', 6, 1], ['Fight', 16, 7],
    ]);
  });

  it('imports as states with rules that run: routes, settings, call/return, portal/death/landblock checks, expressions', () => {
    const { value: p, problems } = importVTank([{ name: 'hunt.met', text: fx('hunt.met') }, { name: 'loot.utl', text: fx('loot.utl') }], null, 'Hunt');
    expect(p.states.map((s) => s.name)).toEqual(['Default', 'Fight', 'Sell']);
    expect(p.initialState).toBe('Default');
    expect(p.description).toBe('Imported from VirindiTank meta hunt.met');
    // VTank's macro fights, loots and walks the loaded route from its settings: on, with VTank's defaults.
    expect(p.macro).toBe(true);
    expect(p.ruleFiring).toBe('once');
    expect(p.settings).toMatchObject({ EnableCombat: true, EnableNav: true });
    expect(p.routes).toEqual([expect.objectContaining({ name: 'Holtburg loop', mode: 'circular', points: ['42.100N, 33.600E', '42.000N, 33.700E', '41.900N, 33.650E'] })]);
    const def = p.states[0].rules;
    // Embed Nav loads the route (the macro walks it).
    expect(def[0]).toMatchObject({ when: [{ kind: 'always' }], do: [{ kind: 'load-route', route: 'Holtburg loop' }] });
    // Monster count within range → monster-within; DoAll → actions in order; /vt opt set → a setting.
    expect(def[1]).toMatchObject({ when: [{ kind: 'monster-within', meters: 25, names: ['Drudge'] }] });
    expect(def[1].disabled).toBeUndefined();
    expect(def[1].do).toEqual([{ kind: 'set-state', state: 'Fight' }, { kind: 'set-setting', name: 'EnableCombat', value: true }]);
    // All → one rule with both; Not(death) is ours now.
    expect(def[2].when).toEqual([{ kind: 'free-slots-below', slots: 3 }, { kind: 'not', condition: { kind: 'died' } }]);
    expect(def[2].disabled).toBeUndefined();
    // Any stays one rule, as in VTank's Meta tab: a landblock check or a chat match.
    expect(p.states[1].rules.find((r) => r.label === 'Rule 4')?.when).toEqual([
      { kind: 'any', conditions: [{ kind: 'landblock', landblock: 0x8bb30000 }, { kind: 'chat-matches', pattern: '^You have been' }] },
    ]);
    expect(p.states[1].rules.some((r) => r.label?.startsWith('Rule 4.'))).toBe(false);
    // Expressions are expression steps.
    expect(p.states[1].rules.find((r) => r.label === 'Rule 6')?.do).toEqual([{ kind: 'expression', expr: 'setvar[done,1]' }]);
    expect(p.loot).toHaveLength(5);
    // The route's pause and recall steps run on arrival (stops); only the untestable loot requirement remains.
    expect(p.routes[0].stops).toEqual([
      { at: 1, do: [{ kind: 'wait', seconds: 5 }] },
      { at: 2, do: [{ kind: 'cast', spell: 'Lifestone Recall', target: 'self' }] },
    ]);
    expect(problems).toEqual([]);
    expect(validateRoutineDoc({ ...emptyRoutineDoc('local-eor', 'a'), profiles: [p] })).toEqual([]);
  });

  it('Seconds in state (P), Time Left On Spell, Dist Any Route Pt and Chat Message Capture import as ours', () => {
    const kv = (pairs: Array<[string, { t: 'i' | 's' | 'd'; v: number | string }]>) => ({ t: 'table' as const, cols: ['k', 'v'], rows: pairs.map(([k, v]) => [{ t: 's' as const, v: k }, v]) });
    const rule = (cond: number, condData: unknown) => ({ cond, condData, act: 1, actData: { t: 's' as const, v: 'Default' }, state: 'Default' }) as never;
    const { value: p, problems } = metToProfile('X', [
      rule(22, { t: 'i', v: 30 }),
      rule(23, kv([['sid', { t: 'i', v: 2 }], ['sec', { t: 'i', v: 600 }]])),
      rule(25, kv([['dist', { t: 'd', v: 40 }]])),
      rule(14, kv([['p', { t: 'i', v: 2 }], ['c', { t: 'i', v: 3 }], ['r', { t: 'd', v: 12.5 }]])),
      rule(28, kv([['p', { t: 's', v: '^(?<who>\\w+) says' }], ['c', { t: 's', v: '0;2' }]])),
    ]);
    expect(p.states[0].rules.map((r) => r.when[0])).toEqual([
      { kind: 'seconds-in-state-persistent', seconds: 30 },
      { kind: 'spell-time-at-least', spell: '', spellId: 2, seconds: 600 },
      // Meta distances are yards (a game metre): no conversion (metaf reference: DistToRteGE "(in yards)").
      { kind: 'route-distance-at-least', meters: 40 },
      { kind: 'monster-priority-count', priority: 2, count: 3, meters: 12.5 },
      { kind: 'chat-capture', pattern: '^(?<who>\\w+) says', colors: [0, 2] },
    ]);
    expect(problems).toEqual([]);
    expect(validateRoutineDoc({ ...emptyRoutineDoc('local-eor', 'a'), profiles: [p] })).toEqual([]);
  });

  it('a Follow navroute is a follow route; an NPC Talk point is talk-to', () => {
    const follow = navToRoute('F', { mode: 'follow', nodes: [], follow: { name: 'Leader', guid: 1 } });
    expect(follow).toEqual({ route: { name: 'F', mode: 'follow', points: [], follow: 'Leader' }, problems: [] });
    const talk = navToRoute('T', { mode: 'once', nodes: [{ type: 7, ew: 33.6, ns: 42.1, z: 0, extra: ['Sean the Speedy', '37', 'True', '33.6', '42.1', '0'] }] });
    expect(talk.route?.stops).toEqual([{ at: 0, do: [{ kind: 'talk-to', name: 'Sean the Speedy' }] }]);
    expect(validateRoutineDoc({ ...emptyRoutineDoc('local-eor', 'a'), profiles: [{ name: 'P', modules: { buffs: false, vitals: false, combat: false, looting: false, navigation: true, inventory: false, service: false }, initialState: 'S', states: [{ name: 'S', rules: [] }], loot: [], buffSets: [], routes: [follow.route!, talk.route!, { name: 'Empty', mode: 'circular', points: [] }] }] })).toEqual([]);
  });

  it('Call state creates the states it goes to and returns to, and an empty state name gets one', () => {
    const kv = (pairs: Array<[string, string]>) => ({ t: 'table' as const, cols: ['k', 'v'], rows: pairs.map(([k, v]) => [{ t: 's' as const, v: k }, { t: 's' as const, v }]) });
    const { value: p } = metToProfile('X', [
      { cond: 1, condData: { t: 'i', v: 0 }, act: 5, actData: kv([['st', 'Rebuff'], ['ret', 'Hunting']]), state: 'Default' },
      { cond: 1, condData: { t: 'i', v: 0 }, act: 1, actData: { t: 's', v: '' }, state: 'Default' },
    ]);
    expect(p.states.map((s) => s.name)).toEqual(['Default', 'Rebuff', 'Hunting', '(unnamed)']);
    expect(validateRoutineDoc({ ...emptyRoutineDoc('local-eor', 'a'), profiles: [p] })).toEqual([]);
  });

  it('UtilityBelt and VirindiTank chat commands become steps (use, give, combat mode, jump, mexec, loot sets, bc)', () => {
    const chat = (text: string) => ({ cond: 1, condData: { t: 'i' as const, v: 0 }, act: 2, actData: { t: 's' as const, v: text }, state: 'Default' });
    const { value: p } = metToProfile('X', [
      chat('/ub use Healing Kit'), chat('/ub usel Portal to Holtburg'), chat('/ub use Healing Kit on me'),
      chat('/ub give 3 Pyreal to Arbiter'), chat('/ub combatstate magic'), chat('/ub jumpsw 180 1000'),
      chat('/ub mexec setvar[a,1]'), chat('/vt loot load Hunting.utl'), chat('/ub bc /ub combatstate melee'),
      chat('/ub opt set VideoPatch true'), chat('/ub autovendor'), chat('/f Fellowship present'), chat('/ub myquests'),
    ]);
    expect(p.states[0].rules.slice(0, 13).map((r) => r.do[0])).toEqual([
      { kind: 'use-object', name: 'Healing Kit' },
      { kind: 'use-object', name: 'Portal to Holtburg' },
      { kind: 'use-item', item: 'Healing Kit', on: 'self' },
      { kind: 'give', item: 'Pyreal', to: 'Arbiter', count: 3 },
      { kind: 'combat-mode', mode: 'magic' },
      { kind: 'jump', heading: 180, holdMs: 1000, forward: true, walk: true },
      { kind: 'expression', expr: 'setvar[a,1]' },
      { kind: 'load-loot', set: 'Hunting' },
      { kind: 'combat-mode', mode: 'melee' },
      { kind: 'set-setting', name: 'ub:VideoPatch', value: true },
      { kind: 'sell-by-loot-rules', vendor: '' },
      { kind: 'say', text: '/f Fellowship present' },
      { kind: 'unsupported', what: 'chat command "/ub myquests"' },
    ]);
  });

  it('every loot profile is a named set; /vt loot load points at it, or says which file to import', () => {
    const met = (text: string) => ({ name: 'm.met', text: ['1', 'CondAct', '5', 'CType', 'AType', 'CData', 'AData', 'State', 'n', 'n', 'n', 'n', 'n', '1', 'i', '1', 'i', '2', 'i', '0', 's', text, 's', 'Default', ''].join('\r\n') });
    const ok = importVTank([met('/vt loot load LOOT.utl'), { name: 'loot.utl', text: fx('loot.utl') }], null, 'X').value;
    expect(Object.keys(ok.lootSets ?? {})).toEqual(['loot']);
    expect(ok.loot).toHaveLength(5);
    expect(ok.states[0].rules[0].do).toEqual([{ kind: 'load-loot', set: 'loot' }]);
    const missing = importVTank([met('/vt loot load Other')], null, 'X');
    expect(missing.value.states[0].rules[0]).toMatchObject({ disabled: true, do: [{ kind: 'unsupported', what: 'load loot profile "Other" (import Other.utl too)' }] });
    expect(validateRoutineDoc({ ...emptyRoutineDoc('local-eor', 'a'), profiles: [missing.value] })).toEqual([]);
  });

  it('knows each file by name or content, and says when one isn\'t a VirindiTank file', () => {
    expect(vtankKind('x.MET', '')).toBe('met');
    expect(vtankKind('noext', fx('holtburg-loop.nav'))).toBe('nav');
    expect(importVTank([{ name: 'notes.txt', text: 'hello' }], null, 'X').problems).toEqual(['notes.txt: not a VirindiTank .met, .nav or .utl file']);
  });
});

describe('.utl requirements on properties and on you', () => {
  it('Decal keys become ACE properties; min damage, free slots, level and skills become requirements', () => {
    const { value: loot, problems } = utlToLoot([
      { name: 'Props', action: 1, reqs: [
        { type: 2, lines: ['3', '218103822'] }, // EquipableSlots (ValidLocations 9) ≤ 3
        { type: 3, lines: ['1', '218103841'] }, // DamageType 45 ≥ 1
        { type: 7, lines: ['4'] },
      ] },
      { name: 'Damage', action: 1, reqs: [{ type: 10, lines: ['12,5'] }] },
      { name: 'You', action: 1, reqs: [
        { type: 1001, lines: ['5'] }, { type: 1002, lines: ['10'] }, { type: 1003, lines: ['50'] },
        { type: 1000, lines: ['200', '34'] }, { type: 1004, lines: ['6', '10', '300'] },
      ] },
    ]);
    expect(problems).toEqual([]);
    expect(loot[0].match.props).toEqual([
      { kind: 'int', key: 9, op: 'le', value: 3 },
      { kind: 'int', key: 45, op: 'ge', value: 1 },
    ]);
    expect(loot[1].match).toEqual({ minDamageAtLeast: 12.5 });
    expect(loot[2].match).toMatchObject({
      freeSlotsAtLeast: 5, characterLevelAtLeast: 10, characterLevelAtMost: 50,
      characterSkills: [{ skill: 34, atLeast: 200 }, { skill: 6, baseMin: 10, baseMax: 300 }],
    });
  });

  it('object classes that are item flags (healing kit, lockpick, book) or salvage bags', () => {
    const { value: loot, problems } = utlToLoot([
      { name: 'Kits', action: 1, reqs: [{ type: 7, lines: ['29'] }] },
      { name: 'Picks', action: 1, reqs: [{ type: 7, lines: ['30'] }] },
      { name: 'Salvage', action: 1, reqs: [{ type: 7, lines: ['39'] }] },
    ]);
    expect(problems).toEqual([]);
    expect(loot.map((l) => l.match)).toEqual([{ descFlags: 0x10000 }, { descFlags: 0x20000 }, { types: ['Tinkering Material'] }]);
    expect(lootRuleFor(loot, { name: 'Healing Kit', type: 'Misc', descFlags: 0x10010 })?.label).toBe('Kits');
    expect(lootRuleFor(loot, { name: 'Bag of Salvaged Iron', type: 'Tinkering Material' })?.label).toBe('Salvage');
    expect(lootRuleFor(loot, { name: 'Ring', type: 'Jewelry', descFlags: 0x10 })).toBeNull();
  });

  it('exact palette in a slot compares the low 24 bits of that ObjDesc subpalette', () => {
    const { value: loot, problems } = utlToLoot([{ name: 'Red coat', action: 1, reqs: [{ type: 17, lines: ['1', '3055'] }, { type: 17, lines: ['2', '3056'] }] }]);
    expect(problems).toEqual([]);
    expect(loot[0].match.palettes).toEqual([{ slot: 1, palette: 3055 }, { slot: 2, palette: 3056 }]);
    const pals = (...ids: number[]) => ids.map((id) => ({ id, example: null }));
    expect(lootRuleFor(loot, { name: 'Coat', palettes: pals(0x04000001, 0x04000bef, 0x04000bf0) })?.label).toBe('Red coat');
    expect(lootRuleFor(loot, { name: 'Coat', palettes: pals(0x04000001, 0x04000bef) })).toBeNull();
    expect(lootRuleFor(loot, { name: 'Coat', palettes: pals(0x04000001, 0x04000bef, 0x04000bf1) })).toBeNull();
  });

  it('total ratings sums the eight gear ratings (VTClassic ComputedItemInfo)', () => {
    const { value: loot, problems } = utlToLoot([{ name: 'Rated', action: 1, reqs: [{ type: 2007, lines: ['10'] }] }]);
    expect(problems).toEqual([]);
    expect(loot[0].match).toEqual({ totalRatingsAtLeast: 10 });
    const props = (int: Record<number, number>) => ({ int, float: {}, string: {}, bool: {}, did: {}, spells: [] });
    expect(lootRuleFor(loot, { name: 'Ring', props: props({ 370: 3, 372: 2, 376: 1, 379: 4 }) })?.label).toBe('Rated');
    expect(lootRuleFor(loot, { name: 'Ring', props: props({ 370: 3, 377: 50 }) })).toBeNull();
    expect(lootRuleFor(loot, { name: 'Ring' })).toBeNull();
  });

  it('"Need to buff" imports as a condition the engine runs', () => {
    const { value: p } = metToProfile('X', [{ cond: 15, condData: { t: 'i', v: 0 }, act: 1, actData: { t: 's', v: 'Buff' }, state: 'Default' }]);
    expect(p.states[0].rules[0].when).toEqual([{ kind: 'need-buff' }]);
    expect(p.states[0].rules[0].disabled).toBeUndefined();
  });
});

describe('similar colour (VTClassic types 14, 15, 16)', () => {
  it('reads any-subpalette, armour-group and slot colour tests', () => {
    const { value: loot, problems } = utlToLoot([
      { name: 'Any gold', action: 1, reqs: [{ type: 14, lines: ['255', '195', '46', '10', '0.1'] }] },
      { name: 'Red shoulders', action: 1, reqs: [{ type: 15, lines: ['195', '8', '16', '10', '0,1', 'Amuli Coat (Collar/Shoulder)'] }] },
      { name: 'Slot 1', action: 1, reqs: [{ type: 16, lines: ['70', '6', '87', '12', '0.2', '1'] }] },
      { name: 'Odd group', action: 1, reqs: [{ type: 15, lines: ['1', '2', '3', '10', '0.1', 'Nothing Like This'] }] },
    ]);
    expect(loot[0].match.colours).toEqual([{ rgb: [255, 195, 46], maxHue: 10, maxSV: 0.1 }]);
    expect(loot[1].match.colours).toEqual([{ rgb: [195, 8, 16], maxHue: 10, maxSV: 0.1, slots: [1, 2], group: 'Amuli Coat (Collar/Shoulder)' }]);
    expect(loot[2].match.colours).toEqual([{ rgb: [70, 6, 87], maxHue: 12, maxSV: 0.2, slots: [1] }]);
    expect(problems).toEqual(['loot rule 4 "Odd group": can\'t test armour group "Nothing Like This" (not in VTClassic\'s colour slot table)']);
    expect(Object.keys(VTCLASSIC_COLOR_SLOTS)).toHaveLength(63);
  });

  it('hue as System.Drawing.Color.GetHue; saturation 1 − min/max; value max/255', () => {
    expect(vtcHsv([255, 0, 0])).toEqual({ h: 0, s: 1, v: 1 });
    expect(vtcHsv([0, 255, 0]).h).toBe(120);
    expect(vtcHsv([255, 0, 255]).h).toBe(300);
    expect(vtcHsv([128, 128, 128])).toEqual({ h: 0, s: 0, v: 128 / 255 });
  });

  it('matches within the hue and S/V distances, only in the named slots, and never on an unloaded palette', () => {
    const gold = { rgb: [255, 195, 46] as [number, number, number], maxHue: 10, maxSV: 0.1 };
    expect(colourNear(gold, [{ id: 1, example: 0xffc32e }])).toBe(true);
    expect(colourNear(gold, [{ id: 1, example: 0xffc838 }])).toBe(true); // a shade off
    expect(colourNear(gold, [{ id: 1, example: 0x2ec3ff }])).toBe(false); // blue
    expect(colourNear({ ...gold, slots: [1] }, [{ id: 1, example: 0xffc32e }, { id: 2, example: 0x000000 }])).toBe(false);
    expect(colourNear({ ...gold, slots: [1] }, [{ id: 1, example: 0x000000 }, { id: 2, example: 0xffc32e }])).toBe(true);
    expect(colourNear(gold, [{ id: 1, example: null }])).toBe(false);
  });
});

describe.skipIf(!existsSync(DAT_PATHS.portal))('the example colour is the middle of the subpalette range (EoL portal.dat)', () => {
  let middle: (palette: number, offset: number, length: number) => string;
  beforeAll(() => {
    const db = openDat(DAT_PATHS.portal);
    middle = (palette, offset, length) => { const c = Palette.read(db.getReader(palette)).colors[offset + Math.floor(length / 2)]; return `${(c >> 16) & 255},${(c >> 8) & 255},${c & 255}`; };
  });
  it('community profiles\' distinctive target colours are exactly real clothing ranges\' middle colours', () => {
    // Each colour occurs only 1–6 times in the whole portal.dat, and the corpus uses it as a target;
    // each is the middle entry of a range a ClothingTable gives that palette.
    expect(middle(0x04000450, 576, 64)).toBe('255,195,46');
    expect(middle(0x0400047b, 576, 64)).toBe('195,8,16');
    expect(middle(0x0400047b, 1216, 64)).toBe('191,8,19');
    expect(middle(0x04000691, 576, 64)).toBe('218,79,16');
    expect(middle(0x04001122, 1728, 192)).toBe('70,6,87');
    expect(middle(0x04000472, 1392, 96)).toBe('64,8,118');
  });
});
