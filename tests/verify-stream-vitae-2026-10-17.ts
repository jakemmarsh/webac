/**
 * Stream 2026-10-17: Claude Arcanist (L49 mage) died three times in 25 minutes (22:19, 22:37, 22:43Z), his max health
 * falling 193 → 177 → 158, and went back alone into the same Olthoi area each time. All his observe said of it was a
 * buff row, "Vitae permanent": nothing of what it cost him or how to work it off.
 *
 * Now observe has a VITAE line (vitaeFacts.ts) from the Vitae enchantment the server sent (spell 666's StatModValue,
 * ACE Player.Vitae): what it lowers (max vitals and every skill, ACE CreatureVital.GetMaxValue / CreatureSkill.Current;
 * retail's panel: "your health, stamina, mana, and skills"), the max health without it, the XP that regains the next
 * 1% (retail gmVitaeUI::Update) and the XP that clears it (ACE Player.UpdateXpVitae run to the end), and how a
 * fellow's kill XP counts (Fellowship.SplitXp → GrantXP → UpdateXpVitae). `character` carries the same line and the
 * stream opening's readiness block reads it from there. Facts only.
 *
 * Driven through the real builders: AgentApi on the fake host (observe, characterSheet), format.ts formatObservation,
 * prompt.ts readinessBrief, PlayerState's vitals (max without vitae). The XP figures are checked against an
 * independent run of ACE's UpdateXpVitae loop fed XP.
 */
import { describe, expect, it } from 'vitest';
import { AttributeId, PropertyInt, StatModType, VITAE_SPELL_ID, VitalId, type EnchantmentRegistryEntry } from '@ac/shared';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { formatObservation } from '../packages/renderer/src/agent/format.ts';
import { fellowXpShare, vitaeCapPercent, vitaeXpToClear, vitaeXpToNext, type FellowshipXpState, type VitaeState } from '../packages/renderer/src/agent/vitaeFacts.ts';
import { PlayerState } from '../packages/renderer/src/player/PlayerState.js';
import { readinessBrief, vitaeFromSheet } from '../tools/stream/prompt.ts';
import { FakeHost } from './_harness/agentFake.ts';

/** ACE Player.VitaeCPPoolThreshold (Player_Xp.cs:431). */
const threshold = (vitae: number, level: number): number => (Math.pow(level, 2.5) * 2.5 + 20.0) * Math.pow(vitae, 5.0) + 0.5;

/** ACE Player.UpdateXpVitae (Player_Xp.cs:134-183) on a copy, fed `amount` XP: the vitae and pool after. */
function aceUpdateXpVitae(s: { m: number; pool: number; dl: number }, amount: number): { m: number; pool: number } {
  let pen = Math.fround(s.m);
  let maxPool = Math.trunc(threshold(pen, s.dl));
  let cur = s.pool + amount;
  while (cur >= maxPool) {
    cur -= maxPool;
    pen = Math.fround(pen + Math.fround(0.01)); // EnchantmentManager.ReduceVitae
    if (Math.abs(Math.fround(pen - 1)) < 0.0001 || pen > 1) { pen = 1; break; }
    maxPool = Math.trunc(threshold(pen, s.dl));
  }
  return { m: pen, pool: cur };
}

/** The least XP after which ACE has removed the vitae (binary search on the real loop). */
function aceXpToClear(s: { m: number; pool: number; dl: number }): number {
  let lo = 0, hi = 10_000_000;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (aceUpdateXpVitae(s, mid).m === 1) hi = mid; else lo = mid + 1;
  }
  return lo;
}

/** Three ACE deaths from 0.97 (EnchantmentManager.UpdateVitae: StatModValue -= 0.05, as float). */
const ARCANIST_VITAE = Math.fround(Math.fround(Math.fround(Math.fround(0.97) - 0.05) - 0.05) - 0.05);

describe('the XP that works vitae off (ACE Player.UpdateXpVitae)', () => {
  it('Arcanist after three deaths: 18%, the next 1% and all of it, as ACE’s loop takes them', () => {
    expect(Math.round((1 - ARCANIST_VITAE) * 100)).toBe(18);
    for (const pool of [0, 1234]) {
      const v: VitaeState = { multiplier: ARCANIST_VITAE, cpPool: pool, deathLevel: 49 };
      const s = { m: ARCANIST_VITAE, pool, dl: 49 };
      const next = vitaeXpToNext(v);
      expect(aceUpdateXpVitae(s, next).m).toBeGreaterThan(ARCANIST_VITAE);
      expect(aceUpdateXpVitae(s, next - 1).m).toBe(ARCANIST_VITAE);
      expect(vitaeXpToClear(v)).toBe(aceXpToClear(s));
    }
    // L49: (49^2.5 × 2.5 + 20) × 0.82^5 + 0.5, the panel's "You will regain 1% of your Vitae once you earn N more".
    expect(vitaeXpToNext({ multiplier: ARCANIST_VITAE, cpPool: 0, deathLevel: 49 })).toBe(Math.trunc(threshold(ARCANIST_VITAE, 49)));
  });

  it('one fresh death at level 10 (0.95f) and the 40% cap, the same against the loop', () => {
    for (const [m, dl] of [[Math.fround(0.95), 10], [Math.fround(0.6), 80], [Math.fround(0.99), 49]] as const) {
      expect(vitaeXpToClear({ multiplier: m, cpPool: 0, deathLevel: dl })).toBe(aceXpToClear({ m, pool: 0, dl }));
    }
    expect(vitaeXpToClear({ multiplier: 1, cpPool: 0, deathLevel: 49 })).toBe(0);
  });

  it('the cap is ACE GetMinVitae: (level − 1) × 3 %, at most 40', () => {
    expect(vitaeCapPercent(49)).toBe(40);
    expect(vitaeCapPercent(5)).toBe(12);
    expect(vitaeCapPercent(1)).toBe(1);
  });
});

describe('a fellow’s kill XP (ACE Fellowship.SplitXp)', () => {
  const pair = (evenShare: boolean, shareXP = true): FellowshipXpState => ({
    shareXP, evenShare, members: [{ name: 'Claude Arcanist', level: 49, self: true }, { name: 'Claude Bulwark', level: 46, self: false }],
  });

  it('two fellows within 5 levels split evenly: 75% each (GetMemberSharePercent)', () => {
    expect(fellowXpShare(pair(true))).toBe(0.75);
  });

  it('a proportional split weights each by the XP their next level takes', () => {
    // characterLevelXpList-shaped: total XP at each level
    const t = Array.from({ length: 60 }, (_, l) => BigInt(l * l * 1000));
    const me = Number(t[50] - t[49]), him = Number(t[47] - t[46]);
    expect(fellowXpShare({ ...pair(false), levelXpTable: t })).toBeCloseTo(me / (me + him), 10);
  });

  it('no share when the fellowship isn’t sharing', () => {
    expect(fellowXpShare(pair(true, false))).toBe(0);
  });
});

describe('max vitals without vitae (PlayerState vitals, ACE CreatureVital.GetMaxValue)', () => {
  it('the same buffs, vitae left out; additive buffs are not scaled by it', () => {
    const ps = new PlayerState();
    ps.attributes.setInnate(AttributeId.Endurance, 200);
    ps.vitals.setRaises(VitalId.Health, 40);
    ps.serverIntProps.set(PropertyInt.Enlightenment, 0);
    const ench = (spellId: number, statModType: number, statModKey: number, statModValue: number): EnchantmentRegistryEntry => ({
      spellId, layer: spellId === VITAE_SPELL_ID ? 0 : 1, spellCategory: spellId === VITAE_SPELL_ID ? 204 : spellId, powerLevel: 100, startTime: 0,
      duration: -1, casterGuid: 0x50000001, statModType, statModKey, statModValue: Math.fround(statModValue), spellSetId: 0,
    });
    ps.enchantments.upsertRegistryEntry(ench(2, StatModType.SecondAtt | StatModType.SingleStat | StatModType.Additive, 1, 20));
    ps.enchantments.upsertRegistryEntry(ench(VITAE_SPELL_ID, StatModType.Vitae | StatModType.SecondAtt | StatModType.Skill | StatModType.Multiplicative, 0, ARCANIST_VITAE));
    expect(ps.vitals.getMaxValue(VitalId.Health, ps.attributes, true, false)).toBe(160); // 140 + 20
    expect(ps.health.max).toBe(Math.round(Math.fround(140 * ARCANIST_VITAE) + 20)); // 115 + 20 = 135
  });
});

describe('observe, character and the opening (AgentApi on the fake host)', () => {
  function arcanist(): { host: FakeHost; api: AgentApi } {
    const host = new FakeHost();
    host.me = { ...host.me, name: 'Claude Arcanist', level: 49, health: { current: 158, max: 158 }, stamina: { current: 200, max: 236 }, mana: { current: 300, max: 330 } };
    host.buffs = [
      { spellId: VITAE_SPELL_ID, name: 'Vitae', remaining: -1, beneficial: true },
      { spellId: 1, name: 'Focus Self V', remaining: 701, beneficial: true },
    ];
    host.vitae = () => ({ multiplier: ARCANIST_VITAE, cpPool: 0, deathLevel: 49, maxWithout: { health: 193, stamina: 288, mana: 402 } });
    host.fellowshipXp = () => ({ shareXP: true, evenShare: true, members: [{ name: 'Claude Arcanist', level: 49, self: true }, { name: 'Claude Bulwark', level: 46, self: false }] });
    host.characterSheet = () => 'Claude Arcanist  level 49  Aluvian Male  NPK\nXP 60,000,000 total, 0 unassigned, 3,000,000 to next level; 0 skill credits';
    return { host, api: new AgentApi(host) };
  }

  const next = vitaeXpToNext({ multiplier: ARCANIST_VITAE, cpPool: 0, deathLevel: 49 }).toLocaleString('en-US');
  const all = vitaeXpToClear({ multiplier: ARCANIST_VITAE, cpPool: 0, deathLevel: 49 }).toLocaleString('en-US');

  it('the VITAE line under the header, and the buff row carries the percentage', () => {
    const { api } = arcanist();
    const text = formatObservation(api.observe());
    const lines = text.split('\n');
    const at = lines.findIndex((l) => l.startsWith('VITAE −18%:'));
    expect(at).toBe(2); // name/vitals, position, then vitae
    expect(lines[at]).toBe(
      'VITAE −18%: max health, stamina, mana and every skill 18% lower (max health 158, not 193; stamina 236, not 288; mana 330, not 402); attributes are not lowered'
      + `; ${next} more XP regains 1%, about ${all} XP clears it all (kill, quest and fellowship XP all count; set at your level at death, 49)`
      + '; each death adds 5% more (up to 40% at your level)'
      + '; fellowship kills count too: XP is shared evenly (you L49, Claude Bulwark L46), so each kill Claude Bulwark makes gives you 75% of its XP while you\'re within 600 m of Claude Bulwark (both outdoors, or inside the same landblock; less out to 1,200 m, none past), and that XP works vitae off like your own (Claude Bulwark is out of sight now)',
    );
    expect(text).not.toMatch(/Vitae permanent/);
    expect(text).toMatch(/^debuffs \(1\): Vitae −18% until XP works it off \(VITAE line\)$/m);
    expect(text).toMatch(/^buffs \(1\): Focus Self V 11m41s$/m);
  });

  it('a fellow in view gets their distance', () => {
    const { host, api } = arcanist();
    const BULWARK = 0x50000002;
    host.objs.set(BULWARK, { guid: BULWARK, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: host.me.cell, x: host.me.x + 30, y: host.me.y, z: host.me.z } as never);
    host.fellows = () => [{ guid: BULWARK, name: 'Claude Bulwark', health: { cur: 300, max: 300 }, stamina: { cur: 1, max: 1 }, mana: { cur: 1, max: 1 } }];
    expect(api.observe().vitae).toMatch(/\(Claude Bulwark is 30 m away now\)$/);
  });

  it('`character` ends with the same facts, and the opening’s readiness leads with them', () => {
    const { api } = arcanist();
    const sheet = api.characterSheet();
    expect(sheet.split('\n').at(-1)).toBe(`Vitae: ${api.observe().vitae!.replace(/^VITAE /, '')}`);
    expect(vitaeFromSheet(sheet)).toMatch(/^−18%: max health, stamina, mana and every skill 18% lower/);
    const r = readinessBrief({ items: null, sheet, session: null })!;
    expect(r.split('\n')[1]).toBe(`- vitae ${vitaeFromSheet(sheet)}`);
  });

  it('a fellowship not sharing XP says so, with the levels', () => {
    const { host, api } = arcanist();
    host.fellowshipXp = () => ({ shareXP: false, evenShare: false, members: [{ name: 'Claude Arcanist', level: 49, self: true }, { name: 'Claude Bulwark', level: 30, self: false }] });
    expect(api.observe().vitae).toMatch(/; fellowship kills don't count: your fellowship isn't sharing XP \(you L49, Claude Bulwark L30;/);
  });

  it('no vitae: no line, no Vitae row, nothing on the sheet or in readiness', () => {
    const { host, api } = arcanist();
    host.vitae = () => null;
    host.buffs = host.buffs.filter((b) => b.spellId !== VITAE_SPELL_ID);
    const text = formatObservation(api.observe());
    expect(text).not.toMatch(/VITAE|Vitae/);
    expect(api.characterSheet()).not.toMatch(/Vitae/);
    expect(readinessBrief({ items: null, sheet: api.characterSheet(), session: null }) ?? '').not.toMatch(/vitae/);
  });
});
