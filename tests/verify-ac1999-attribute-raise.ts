/**
 * BUG.ac1999-attribute-raise (webac#4) — in a 1999 world the Raise button
 * spent 110 XP and raised nothing, the panel never showed the real price, and
 * a buffed attribute read "80" where the 1999 client reads "Strength 80 (+15)".
 *
 * The cause: the 1999 adapter turned the AC1999 server's attribute record
 * {f0 value, f1 0, f2 cp} into end of retail's {ranks 0, startingValue f0,
 * xp f2}, and the panel priced a raise table[ranks + 1] − table[ranks]: the
 * first step, 110, every time. The AC1999 server (ClientEvents.cpp
 * SpendAttributeXP) wants XpTable[raises + 1] − invested; it banked the 110
 * into the attribute and raised nothing. The 1999 client.exe prices
 * XpTable[f0 − f1 + 1] − f2 (AttribInfoBox::Display @ 0x00544e10), end of
 * retail XpTable[ranks + 1] − ExperienceSpent (gmAttributeUI::GetCostToRaise
 * @ 0049cb80): the adapter now carries ranks f0 − f1 / xp f2 and the panel
 * prices against the XP spent.
 *
 * The wire cases build the AC1999 server's own 0x26 / 0x29 / 0x28 bytes
 * (WeenieObject.cpp NotifyAttributeStatUpdated + AC1999::Remap1999AttributeForWire,
 * ported below) and drive the real Adapter1999 → ServerMessageHandler →
 * PlayerState → GameUI. The 1999 world uses the shared character panel (Jake,
 * 2026-10-22, REVERT.ac1999-forked-panels); only its selection line is worded
 * the 1999 way (InfoBox::SetBase @ 0x00544a70, eraClientRules().statLineText),
 * pinned here against the real GameUI footer model in happy-dom, with end of
 * retail's wording unchanged. The real 1999 XpTable case skips without
 * dat-sets/ac1999-retail.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Adapter1999, emptyCodecs, eol } from '../packages/network/src/era1999/Adapter1999.js';
import { registerCharSelect1999 } from '../packages/network/src/era1999/codecs/CharSelect1999.js';
import { eolStat1999, registerPlayer1999, skillXp1999 } from '../packages/network/src/era1999/codecs/Player1999.js';
import { registerCombat1999 } from '../packages/network/src/era1999/codecs/Combat1999.js';
import { Writer1999 } from '../packages/network/src/era1999/Wire1999.js';
import { buildRaiseAttributePayload, deserializeMessage, serializeGameAction } from '../packages/network/src/MessageSerializer.js';
import { GameActionType } from '../packages/network/src/GameActionType.js';
import { ServerMessageHandler, type AttributeUpdateData, type SkillUpdateData, type VitalUpdateData } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { PlayerState } from '../packages/renderer/src/player/PlayerState.js';
import { AttributeId, VitalId } from '@ac/shared';
import { eraClientRules } from '../packages/renderer/src/era/EraFeatures.js';
import { eraProfile, EOR_ERA_ID } from '../packages/renderer/src/era/EraProfiles.js';
import { enchantDelta1999, statLineRuns1999, vitaeDelta1999, FOOTER_TITLE_COLORS, type StatLine1999 } from '../packages/renderer/src/ui/SkillDisplay.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { XpTable } from '../packages/dat-parser/src/file-types/XpTable.js';
import { transcodeXpTable1999 } from '../packages/dat-parser/src/era1999/Tables1999.js';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { openDat } from './_harness/dat.js';

const GUID = 0x50000003;

/**
 * A stand-in attribute curve for CI (the real 1999 one is read below when the
 * DATs are here): cumulative XP per level, first steps 110, 167, 224, 283, 341
 * as the 1999 portal.dat's (kb 0x26-UpdateAttribute, live-confirmed 2026-08-23).
 */
function curve(n: number): number[] {
  const steps = [110, 167, 224, 283, 341];
  const t = [0];
  for (let i = 1; i <= n; i++) t.push(t[i - 1] + (steps[i - 1] ?? Math.round(110 + 58 * (i - 1) + (i - 1) * (i - 1))));
  return t;
}

/** AC1999::Remap1999AttributeForWire (WeenieObject.cpp): the record the AC1999 server puts on the wire. */
function remap1999(init: number, raises: number, invested: number, T: number[]): { f0: number; f1: number; f2: number } {
  const value = init + raises;
  return { f0: value, f1: 0, f2: T[value + 1] - T[raises + 1] + invested };
}

/** ClientEvents.cpp SpendAttributeXP + GiveAttributeXP: spend, bank, re-level from the total. */
function serverSpend(a: { raises: number; invested: number }, exp: number, T: number[]): { raises: number; invested: number } {
  const neededForMax = T[T.length - 1] - a.invested;
  const spend = Math.min(exp, neededForMax);
  const invested = a.invested + spend;
  let raises = 0;
  while (raises + 1 < T.length && T[raises + 1] <= invested) raises++;
  return { raises, invested };
}

const msg = (op: number, f: (w: Writer1999) => void): Uint8Array => { const w = new Writer1999().u32(op); f(w); return w.toBytes(); };

function adapter(): Adapter1999 {
  const c = emptyCodecs();
  registerCharSelect1999(c);
  const st = registerPlayer1999(c);
  registerCombat1999(c, { player: () => st });
  const a = new Adapter1999(c, { account: 'acjs', log: () => {} });
  a.inbound(msg(0xf746, (w) => w.u32(GUID)), 3);
  return a;
}

/** The EoL messages through the real ServerMessageHandler, applied to `ps` as main.ts applies them. */
function apply(ps: PlayerState, out: Uint8Array[]): { attrs: AttributeUpdateData[]; vitals: VitalUpdateData[]; skills: SkillUpdateData[] } {
  const got = { attrs: [] as AttributeUpdateData[], vitals: [] as VitalUpdateData[], skills: [] as SkillUpdateData[] };
  const h = new ServerMessageHandler();
  h.setHandlers({
    onPrivateUpdateAttribute: (d: AttributeUpdateData) => {
      got.attrs.push(d);
      ps.attributes.setInnate(d.key as AttributeId, d.initLevel);
      ps.attributes.setRaises(d.key as AttributeId, d.levelFromCP);
      ps.attributes.setExperienceSpent(d.key as AttributeId, d.cpSpent);
    },
    onPrivateUpdateVital: (d: VitalUpdateData) => {
      got.vitals.push(d);
      const id = ({ 1: VitalId.Health, 3: VitalId.Stamina, 5: VitalId.Mana } as Record<number, VitalId>)[d.key];
      ps.vitals.setRaises(id, d.levelFromCP ?? 0);
      ps.vitals.setStartingValue(id, d.initLevel ?? 0);
      ps.vitals.setExperienceSpent(id, d.cpSpent ?? 0);
    },
    onPrivateUpdateSkill: (d: SkillUpdateData) => { got.skills.push(d); },
  });
  for (const b of out) h.handleMessage(deserializeMessage(b));
  return got;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let GameUIClass: any;
const domWindow = await loadDomWindow({ innerWidth: 1280, innerHeight: 800 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;
const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
beforeAll(async () => {
  installDomGlobals(domWindow, DOM_GLOBALS, saved);
  GameUIClass = (await import('../packages/renderer/src/ui/GameUI.js')).GameUI;
});
afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

describe('the AC1999 server\'s attribute reply prices the raise the server wants', () => {
  const T = curve(240);
  // Strength: chargen 50, raised 15 times (value 65), XP invested exactly to rank 15.
  const before = { init: 50, raises: 15, invested: T[15] };

  it('0x26 {65, 0, cp} reaches PrivateUpdateAttribute as ranks 65 / start 0 / xp cp (eolStat1999)', () => {
    const w = remap1999(before.init, before.raises, before.invested, T);
    const ps = new PlayerState();
    const got = apply(ps, adapter().inbound(msg(0x26, (m) => m.u32(GUID).u32(1).u32(w.f0).u32(w.f1).u32(w.f2)), 4));
    expect(got.attrs).toEqual([expect.objectContaining({ key: 1, levelFromCP: 65, initLevel: 0, cpSpent: w.f2 })]);
    expect(ps.attributes.getCurrent(AttributeId.Strength)).toBe(65); // the 1999 client shows f0
    expect(eolStat1999(65, 5, 900)).toEqual({ ranks: 60, start: 5, xp: 900 }); // an honest f1 keeps its split
  });

  it('the panel\'s price is the server\'s expected XpTable[raises + 1] − invested, not 110; paying it raises', () => {
    const w = remap1999(before.init, before.raises, before.invested, T);
    const ps = new PlayerState();
    apply(ps, adapter().inbound(msg(0x26, (m) => m.u32(GUID).u32(1).u32(w.f0).u32(w.f1).u32(w.f2)), 4));
    const price = GameUIClass.statRaiseCosts(T, ps.attributes.getRaises(AttributeId.Strength), ps.attributes.getExperienceSpent(AttributeId.Strength)).cost1;
    const expected = T[before.raises + 1] - before.invested; // ClientEvents.cpp SpendAttributeXP "expectedXP"
    expect(price).toBe(expected);
    expect(price).not.toBe(110);
    // The old price (ranks 0): the table's first step. Spending it banks XP and raises nothing — the report.
    const old = GameUIClass.statRaiseCosts(T, 0).cost1;
    expect(old).toBe(110);
    expect(serverSpend(before, old, T).raises).toBe(15);
    // The new price raises it.
    const after = serverSpend(before, price, T);
    expect(after.raises).toBe(16);

    // The server's reply after the raise prices the next step.
    const w2 = remap1999(before.init, after.raises, after.invested, T);
    const ps2 = new PlayerState();
    apply(ps2, adapter().inbound(msg(0x26, (m) => m.u32(GUID).u32(1).u32(w2.f0).u32(w2.f1).u32(w2.f2)), 4));
    expect(ps2.attributes.getCurrent(AttributeId.Strength)).toBe(66);
    expect(GameUIClass.statRaiseCosts(T, ps2.attributes.getRaises(AttributeId.Strength), ps2.attributes.getExperienceSpent(AttributeId.Strength)).cost1)
      .toBe(T[17] - T[16]);
  });

  it('XP banked short of a raise lowers the next price (the 1999 client\'s XpTable[f0 + 1] − f2)', () => {
    const partial = { raises: 15, invested: T[15] + 100 };
    const w = remap1999(before.init, partial.raises, partial.invested, T);
    const ps = new PlayerState();
    apply(ps, adapter().inbound(msg(0x26, (m) => m.u32(GUID).u32(1).u32(w.f0).u32(w.f1).u32(w.f2)), 4));
    const price = GameUIClass.statRaiseCosts(T, ps.attributes.getRaises(AttributeId.Strength), ps.attributes.getExperienceSpent(AttributeId.Strength)).cost1;
    expect(price).toBe(T[16] - T[15] - 100);
    expect(price).toBe(T[w.f0 - w.f1 + 1] - w.f2); // AttribInfoBox::Display @ 0x00544e10
  });

  it('0x2C UpdateAttributeScalar replaces the level alone (int SetAttribute writes +4 only)', () => {
    const ps = new PlayerState();
    const a = adapter();
    apply(ps, [...a.inbound(msg(0x26, (m) => m.u32(GUID).u32(1).u32(60).u32(10).u32(777)), 4), ...a.inbound(msg(0x2c, (m) => m.u32(GUID).u32(1).u32(61)), 4)]);
    expect(ps.attributes.getCurrent(AttributeId.Strength)).toBe(61);
    expect(ps.attributes.getInnate(AttributeId.Strength)).toBe(10);
    expect(ps.attributes.getExperienceSpent(AttributeId.Strength)).toBe(777);
  });

  it('the Raise button\'s 0x45 carries the price the server checks', () => {
    const out = adapter().outbound(serializeGameAction(7, GameActionType.RaiseAttribute, buildRaiseAttributePayload(1, 2215)));
    const v = new DataView(out![0].message.buffer, out![0].message.byteOffset);
    expect([v.getUint32(0, true), v.getUint32(8, true), v.getUint32(12, true), v.getUint32(16, true)]).toEqual([0xf7b1, 0x45, 1, 2215]);
  });
});

describe('sweep: vitals and skills price as the 1999 client does', () => {
  const T = curve(240);

  it('0x29 vital {f0 raises, f1 init, cp, current}: ranks f0 − f1, the price XpTable2nd[f0 − f1 + 1] − cp', () => {
    const ps = new PlayerState();
    const got = apply(ps, adapter().inbound(msg(0x29, (m) => m.u32(GUID).u32(1).u32(4).u32(0).u32(T[4] + 20).u32(36)), 4));
    expect(got.vitals[0]).toMatchObject({ key: 1, levelFromCP: 4, initLevel: 0, cpSpent: T[4] + 20, value: 36 });
    expect(GameUIClass.statRaiseCosts(T, ps.vitals.getRaises(VitalId.Health), ps.vitals.getExperienceSpent(VitalId.Health)).cost1).toBe(T[5] - T[4] - 20);
    // An f1 the 1999 client subtracts (0x00545070) leaves the level f0 (what it shows) and prices from f0 − f1.
    expect(eolStat1999(7, 2, 500)).toEqual({ ranks: 5, start: 2, xp: 500 });
  });

  it('0x28 skill: the 1999 client\'s pp is _pp + _init_level (0x005e2b30), and the level shown is the rank alone', () => {
    const got = apply(new PlayerState(), adapter().inbound(msg(0x28, (m) => m.u32(GUID).u32(34).u32(12).i32(3).u32(5000).u32(40).i32(0).f64(0)), 4));
    expect(got.skills[0]).toMatchObject({ key: 34, points: 12, advancementClass: 3, cpSpent: 5040, initLevel: 0 });
    expect(skillXp1999({ xp: 0xfffffff0, init: 0x20 })).toBe(0xffffffff);
    // SetProficiencyPoints @ 0x00545ed0: XpTable[rank + 1] − pp; the same as end of retail's gmSkillUI::GetCostToRaise.
    expect(GameUIClass.skillRaiseCosts(T, 12, 5040).cost1).toBe(T[13] - 5040);
  });

  it('ACE records (xp = XpTable[ranks]) price as before: end of retail and Dark Majesty unchanged', () => {
    for (const r of [0, 1, 9, 50]) {
      expect(GameUIClass.statRaiseCosts(T, r, T[r])).toEqual(GameUIClass.statRaiseCosts(T, r));
      expect(GameUIClass.statRaiseCosts(T, r).cost1).toBe(T[r + 1] - T[r]);
      expect(GameUIClass.statRaiseCosts(T, r).cost10).toBe(T[r + 10] - T[r]);
    }
  });
});

const stat = (o: Partial<StatLine1999> & Pick<StatLine1999, 'kind' | 'name' | 'value' | 'base'>): StatLine1999 => ({ enchanted: false, ...o });
const text = (rs: ReadonlyArray<{ text: string }>): string => rs.map((r) => r.text).join('');

describe('the 1999 stat line (InfoBox::SetBase @ 0x00544a70) as the shared footer title\'s runs', () => {
  it('a Strength of 65 + 15 reads "Strength 80 (+15)", the buff in colour 1 (green, UI+0x1a4)', () => {
    const runs = statLineRuns1999(stat({ kind: 'attribute', name: 'Strength', value: 80, base: 65, enchanted: true }), 1);
    expect(text(runs)).toBe('Strength 80 (+15)');
    expect(runs).toEqual([{ text: 'Strength 80', colorIndex: 0 }, { text: ' (+15)', colorIndex: 1 }]);
    expect(FOOTER_TITLE_COLORS[runs.at(-1)!.colorIndex] & 0xffffff).toBe(0x00ff00);
  });

  it('a lowered stat reads " (-n)" in red; an enchantment that cancels out " (+0)"; none, nothing', () => {
    const lowered = statLineRuns1999(stat({ kind: 'attribute', name: 'Self', value: 30, base: 40, enchanted: true }), 1);
    expect(text(lowered)).toBe('Self 30 (-10)');
    expect(lowered.at(-1)!.colorIndex).toBe(2);
    expect(text(statLineRuns1999(stat({ kind: 'attribute', name: 'Focus', value: 40, base: 40, enchanted: true }), 1))).toBe('Focus 40 (+0)');
    expect(text(statLineRuns1999(stat({ kind: 'attribute', name: 'Focus', value: 40, base: 40 }), 1))).toBe('Focus 40');
  });

  it('a vital reads "cur/max", vitae " (-n)" in colour 3 apart from the enchantments (0x005b2b90 / 0x005b2ca0)', () => {
    const health = stat({ kind: 'vital', name: 'Health', value: 30, max: 34, base: 36 });
    expect(vitaeDelta1999(health, 0.95)).toBe(-2); // round(36 × 0.95) − 36
    expect(enchantDelta1999(health, 0.95)).toBe(0);
    const runs = statLineRuns1999(health, 0.95);
    expect(text(runs)).toBe('Health 30/34 (-2)');
    expect(runs.at(-1)!.colorIndex).toBe(3);
    // Vitae never touches an attribute.
    expect(vitaeDelta1999(stat({ kind: 'attribute', name: 'Strength', value: 50, base: 50 }), 0.9)).toBe(0);
  });

  it('a skill reads "Name value (+n)"; at 0, "Name  (Must be trained)"', () => {
    expect(text(statLineRuns1999(stat({ kind: 'skill', name: 'War Magic', value: 90, base: 80, enchanted: true }), 1))).toBe('War Magic 90 (+10)');
    expect(text(statLineRuns1999(stat({ kind: 'skill', name: 'Gearcraft', value: 0, base: 0 }), 1))).toBe('Gearcraft  (Must be trained)');
  });
});

describe('GameUI: the shared character panel prices and raises a 1999 attribute, and words a buff the 1999 way', () => {
  it('the rules: a 1999 world words the line the 1999 way; end of retail and Dark Majesty keep theirs', () => {
    expect(eraClientRules(eraProfile('ac1999-retail')).statLineText).toBe('ac1999');
    for (const id of [EOR_ERA_ID, 'classic-dereth', 'classicace-customdm', 'classicace-infiltration']) {
      expect(eraClientRules(eraProfile(id)).statLineText).toBe('eor');
    }
    expect(eraClientRules(null).statLineText).toBe('eor');
  });

  /** A player as the AC1999 server describes it (Strength 50 + 15 raises), through the real adapter, with a +15 buff. */
  function buffedPlayer(T: number[]): PlayerState {
    const ps = new PlayerState();
    const w = remap1999(50, 15, T[15], T);
    apply(ps, adapter().inbound(msg(0x26, (m) => m.u32(GUID).u32(1).u32(w.f0).u32(w.f1).u32(w.f2)), 4));
    ps.enchantments.upsertRegistryEntry({ spellId: 2, layer: 1, spellCategory: 1, powerLevel: 1, startTime: 0, duration: -1, casterGuid: 0, statModType: 0x9001, statModKey: 1, statModValue: 15 });
    ps.xp.setXp(5000n, 5000n);
    return ps;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function gui(T: number[], sent: Array<[number, number]>): any {
    const c = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(c);
    const g = new GameUIClass(c);
    g.setRaiseCallbacks({ onRaiseAttribute: (id: number, xp: number) => sent.push([id, xp]) }, { attribute: T, vital: T, trainedSkill: T, specializedSkill: T });
    return g;
  }

  it('webac#4 in 1999: the footer shows "Strength 80 (+15)" and the server\'s price; Raise sends that price, which raises', () => {
    const T = curve(240);
    const sent: Array<[number, number]> = [];
    const g = gui(T, sent);
    g.setStatLineText('ac1999');
    g.syncFromPlayerState(buffedPlayer(T));
    g.selectedStatRow = { kind: 'attribute', id: 1 };
    const model = g.statFooterModel('attributes');
    expect(text(model.titleRuns)).toBe('Strength 80 (+15)');
    expect(model.titleRuns.at(-1).colorIndex).toBe(1);
    const expected = T[16] - T[15]; // ClientEvents.cpp SpendAttributeXP "expectedXP"
    expect(model.line1Value).toBe(expected.toLocaleString());
    expect(model.raiseEnabled).toBe(true);
    model.onRaise();
    expect(sent).toEqual([[1, expected]]);
    // Paying it raises (the server's own spend).
    expect(serverSpend({ raises: 15, invested: T[15] }, expected, T).raises).toBe(16);
  });

  it('end of retail (and Dark Majesty) keep "Strength 80+" with the value green: no 1999 runs', () => {
    const T = curve(240);
    const g = gui(T, []);
    expect(g.statLineTextKind).toBe('eor');
    g.syncFromPlayerState(buffedPlayer(T));
    g.selectedStatRow = { kind: 'attribute', id: 1 };
    const model = g.statFooterModel('attributes');
    expect(model.titleRuns).toBeUndefined();
    expect([model.title, model.value, model.tone]).toEqual(['Strength', '80+', 'buffed']);
  });
});

const AC1999 = resolve(__dirname, '..', 'dat-sets', 'ac1999-retail');
describe.skipIf(!existsSync(resolve(AC1999, 'portal.dat')))('the real 1999 XpTable', () => {
  let T: number[] = [];
  beforeAll(() => {
    const portal = openDat(resolve(AC1999, 'portal.dat'));
    const raw = portal.getFileData(0x0e000018)!;
    T = new XpTable(new DatReader(transcodeXpTable1999(raw))).attributeXpList;
  });

  it('first steps 110, 167, 224, 283, 341 (the live-confirmed AC1999 ladder); a raised Strength prices its own step', () => {
    expect([1, 2, 3, 4, 5].map((i) => T[i] - T[i - 1])).toEqual([110, 167, 224, 283, 341]);
    const w = remap1999(50, 15, T[15], T);
    const ps = new PlayerState();
    apply(ps, adapter().inbound(msg(0x26, (m) => m.u32(GUID).u32(1).u32(w.f0).u32(w.f1).u32(w.f2)), 4));
    expect(GameUIClass.statRaiseCosts(T, ps.attributes.getRaises(AttributeId.Strength), ps.attributes.getExperienceSpent(AttributeId.Strength)).cost1)
      .toBe(T[16] - T[15]);
  });
});
