/**
 * Splitpea (AC1999 plugin, reference/plugin-specs/splitpea.md): the seed solver and the model, against
 * the real RandomizeVersion1 (getPlayerFormula's version-1 path). Synthetic formulas always run; the real
 * 1999 SpellTable runs when dat-sets/ac1999-retail is present (skipped on CI, loads in beforeAll).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  computeAccountHash, getPlayerFormula, randomizeVersion1ForSeed, version1Tapers, VERSION1_SEED_MODULUS,
  SeedSolver, SplitpeaModel, splitpeaSpells, splitpeaList, splitpeaStoreKey, serializeKnownTapers, parseKnownTapers,
  loadKnownTapers, saveKnownTapers, splitpeaExportHtml, openSlotText, splitpeaSlotRoles, NOT_RESEARCHABLE_SPELL_FLAG,
  type SplitpeaSpell, type SplitpeaSpellSource,
} from '@ac/shared';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { FileDatBytes } from '../packages/dat-parser/src/node/FileDatBytes.js';
import { ac1999PortalOverlay } from '../packages/dat-parser/src/era1999/Ac1999Overlay.js';
import { SpellTable } from '../packages/dat-parser/src/file-types/SpellTable.js';

/** A deterministic PRNG so failures reproduce. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

/** Real-shaped 1999 formulas: scarab, (taper 1), herb, (taper 2), gem, alchemy, (taper 3), talisman, by component id range. */
function syntheticSpells(n: number, r: () => number): SplitpeaSpell[] {
  const pick = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const out: SplitpeaSpell[] = [];
  for (let i = 0; i < n; i++) {
    const len = 5 + (i % 4); // 5, 6, 7, 8
    const scarab = pick(1, 6), herb = pick(7, 23), gem = pick(24, 40), alch = pick(41, 50), tal = pick(51, 62);
    const f = len === 8 ? [scarab, 63, herb, 63, gem, alch, 63, tal]
      : len === 7 ? [scarab, 63, herb, 63, gem, alch, tal]
        : len === 6 ? [scarab, 63, herb, gem, alch, tal] : [scarab, herb, gem, alch, tal];
    out.push({ id: 1000 + i, name: `Spell ${i}`, desc: `Does thing ${i}.`, school: 1 + (i % 4), icon: 0x06000000 + i, mana: 10 * len, difficulty: 50 * (len - 4), level: len - 4, range: 0, duration: 0, formula: f });
  }
  return out;
}

/** Feed `k` spells the account has (its true personal formulas, as the spellbook shows them). */
function learn(model: SplitpeaModel, account: string, ids: number[]): void {
  model.syncSpellbook(ids.map((id) => ({ id, formula: getPlayerFormula([...model.spell(id)!.formula], 1, account) })));
}

/** Every solved slot is the account's true taper, every open set contains it, known slots match. */
function expectHonest(model: SplitpeaModel, account: string): { solved: number; open: number } {
  let solved = 0, open = 0;
  for (const s of model.spells) {
    const truth = getPlayerFormula([...s.formula], 1, account);
    for (const v of model.view(s.id)) {
      if (v.kind === 'open') { open++; expect(v.ids).toContain(truth[v.slot]); } else {
        if (v.kind === 'solved') solved++;
        expect(v.id).toBe(truth[v.slot]);
      }
    }
  }
  return { solved, open };
}

describe('RandomizeVersion1 for a seed (SpellFormula.ts)', () => {
  it('is getPlayerFormula version 1 with the account\'s seed, for every formula length', () => {
    const r = rng(1);
    for (const acct of ['agentc99', 'testacjs', 'Zed', 'x']) {
      const seed = computeAccountHash(acct) % VERSION1_SEED_MODULUS;
      for (const s of syntheticSpells(40, r)) expect(randomizeVersion1ForSeed(s.formula, seed)).toEqual(getPlayerFormula([...s.formula], 1, acct));
    }
  });

  it('places tapers by length: none at 5, taper 1 at 6, taper 2 at 7, taper 3 at 8', () => {
    expect(version1Tapers([1, 7, 24, 41, 51])).toEqual({ taper1: null, personal: [] });
    expect(version1Tapers([1, 63, 7, 24, 41, 51]).personal).toEqual([]);
    expect(version1Tapers([1, 63, 7, 63, 24, 41, 51]).personal.map((p) => p.slot)).toEqual([3]);
    expect(version1Tapers([1, 63, 7, 63, 24, 41, 63, 51]).personal.map((p) => p.slot)).toEqual([3, 6]);
    expect(splitpeaSlotRoles(8)).toEqual(['Scarab', 'Taper 1', 'Herb', 'Taper 2', 'Gem', 'Alchemy', 'Taper 3', 'Talisman']);
  });
});

describe('the seed solver', () => {
  it('narrowing reuses the seeds left; removing a taper rebuilds; the first scan stays well under 100 ms', () => {
    const r = rng(2);
    const spells = syntheticSpells(40, r).filter((s) => s.formula.length >= 7);
    const model = new SplitpeaModel(spells);
    const acct = 'narrowtest';
    const t0 = performance.now();
    learn(model, acct, [spells[0].id]);
    const firstMs = performance.now() - t0;
    expect(model.solver.fullScans).toBe(1);
    // Measured 2026-10-16 on an M-series Mac: ~10–20 ms for the 1,299,827-seed scan in Node.
    expect(firstMs).toBeLessThan(100);
    const afterOne = model.keysLeft();
    expect(afterOne).toBeLessThan(VERSION1_SEED_MODULUS);
    learn(model, acct, [spells[1].id]);
    learn(model, acct, [spells[2].id]);
    expect(model.solver.fullScans).toBe(1);
    expect(model.solver.narrowings).toBe(2);
    expect(model.keysLeft()).toBeLessThanOrEqual(afterOne);
    const afterThree = model.keysLeft();
    model.remove(spells[2].id);
    expect(model.solver.fullScans).toBe(2);
    expect(model.keysLeft()).toBeGreaterThanOrEqual(afterThree);
    expectHonest(model, acct);
    model.remove(spells[0].id); model.remove(spells[1].id);
    expect(model.keysLeft()).toBe(VERSION1_SEED_MODULUS);
  });

  it('property: for random accounts and spells learned, solved slots are the true tapers and open sets contain them', () => {
    const r = rng(3);
    const spells = syntheticSpells(120, r);
    for (let a = 0; a < 6; a++) {
      const acct = `acct${Math.floor(r() * 1e9).toString(36)}`;
      const model = new SplitpeaModel(spells);
      const order = spells.filter((s) => s.formula.length >= 7).map((s) => s.id).sort(() => r() - 0.5);
      for (const k of [1, 3, 8]) {
        learn(model, acct, order.slice(0, k));
        expectHonest(model, acct);
      }
      expect(model.conflict()).toBe(false);
      expect(model.keysLeft()).toBeGreaterThan(0);
    }
  });

  it('a contradicting entered taper leaves no key (conflict) and shows nothing as solved', () => {
    const spells = syntheticSpells(8, rng(4)).filter((s) => s.formula.length === 8);
    const model = new SplitpeaModel(spells);
    learn(model, 'conflicting', [spells[0].id]);
    const truth = getPlayerFormula([...spells[0].formula], 1, 'conflicting');
    // The same term with a different taper cannot hold for any seed.
    const solver = new SeedSolver();
    const p = version1Tapers(spells[0].formula).personal[0];
    solver.set([{ mul: p.mul, div: p.div, taper: truth[p.slot] }, { mul: p.mul, div: p.div, taper: truth[p.slot] === 63 ? 64 : 63 }]);
    expect(solver.count).toBe(0);
    expect(solver.colours(p)).toBe(0);
    model.enter(spells[1].id, 3, truth[3] === 63 ? 64 : 63); // a slot on another spell: not a direct conflict
    expect(model.knownTapers().find((k) => k.spell === spells[1].id)?.source).toBe('entered');
  });

  it('the model never takes an account: two accounts whose keys agree on the found tapers get the same views', () => {
    const spells = syntheticSpells(60, rng(5));
    const a = new SplitpeaModel(spells);
    learn(a, 'alpha', [spells[2].id, spells[3].id]);
    const left = a.solver.candidates()!;
    const trueSeed = computeAccountHash('alpha') % VERSION1_SEED_MODULUS;
    const other = left.find((s) => s !== trueSeed);
    expect(other).toBeDefined();
    // Another key that fits what was found: its formulas must lie inside every open set too (the solver can't tell them apart).
    for (const s of spells) {
      const theirs = randomizeVersion1ForSeed(s.formula, other!);
      for (const v of a.view(s.id)) if (v.kind === 'open') expect(v.ids).toContain(theirs[v.slot]);
    }
    // The model's API: spells in, tapers in. Constructing and feeding it needs no account name.
    expect(SplitpeaModel.length).toBe(1);
  });
});

describe('Splitpea model: spellbook, entry, store, list, export', () => {
  const spells = syntheticSpells(16, rng(6));
  const names = (id: number) => (id >= 63 && id <= 74 ? ['Red', 'Pink', 'Orange', 'Yellow', 'Green', 'Turquoise', 'Blue', 'Indigo', 'Violet', 'Brown', 'White', 'Black'][id - 63] + ' Taper' : `Comp ${id}`);

  it('spellbook auto-fill records each personal taper with its source; a spellbook taper replaces an entered one', () => {
    const m = new SplitpeaModel(spells);
    const eight = spells.find((s) => s.formula.length === 8)!;
    const truth = getPlayerFormula([...eight.formula], 1, 'bookie');
    m.enter(eight.id, 3, truth[3] === 63 ? 64 : 63);
    expect(m.knownTapers()[0].source).toBe('entered');
    expect(m.syncSpellbook([{ id: eight.id, formula: truth }])).toBe(2);
    expect(m.knownTapers().map((k) => [k.slot, k.taper, k.source]).sort()).toEqual([[3, truth[3], 'spellbook'], [6, truth[6], 'spellbook']].sort());
    expect(m.syncSpellbook([{ id: eight.id, formula: truth }])).toBe(0);
    // A spell without personal tapers adds nothing.
    expect(m.syncSpellbook([{ id: spells.find((s) => s.formula.length === 6)!.id, formula: [1, 2, 3, 4, 5, 6] }])).toBe(0);
    expect(m.view(eight.id).filter((v) => v.kind === 'known' && v.source === 'spellbook').length).toBe(2);
  });

  it('the store round-trips per server + account and survives blocked storage', () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } };
    const list = [{ spell: 1, slot: 3, taper: 65, source: 'spellbook' as const }, { spell: 2, slot: 6, taper: 70, source: 'entered' as const }];
    saveKnownTapers(storage, 'AC1999', 'Agent', list);
    expect(mem.has(splitpeaStoreKey('ac1999', 'agent'))).toBe(true);
    expect(loadKnownTapers(storage, 'AC1999', 'agent')).toEqual(list);
    expect(loadKnownTapers(storage, 'Other', 'agent')).toEqual([]);
    expect(parseKnownTapers(serializeKnownTapers(list))).toEqual(list);
    expect(parseKnownTapers('not json')).toEqual([]);
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(loadKnownTapers(blocked, 's', 'a')).toEqual([]);
    expect(() => saveKnownTapers(blocked, 's', 'a', list)).not.toThrow();
  });

  it('keeps only researchable spells with a formula, from SpellTable entries', () => {
    const src = (bitfield: number, formula: number[]): SplitpeaSpellSource => ({ name: 'X', desc: '', school: 1, icon: 0, bitfield, baseMana: 5, baseRangeConstant: 0, power: 150, formula });
    const out = splitpeaSpells(new Map([[1, src(0, [1, 7, 24, 41, 51, 0, 0, 0])], [2, src(NOT_RESEARCHABLE_SPELL_FLAG, [1, 7, 24, 41, 51])], [3, src(0, [])]]));
    expect(out.map((s) => s.id)).toEqual([1]);
    expect(out[0].formula).toEqual([1, 7, 24, 41, 51]);
    expect(out[0].level).toBe(4);
  });

  it('filters by school, hides settled spells, keeps only what you carry, sorts by name / level / school', () => {
    const m = new SplitpeaModel(spells);
    expect(splitpeaList(m, { school: 2, sort: 'name' }).every((s) => s.school === 2)).toBe(true);
    const byLevel = splitpeaList(m, { school: 0, sort: 'level' });
    expect(byLevel.map((s) => s.level)).toEqual([...byLevel.map((s) => s.level)].sort((a, b) => a - b));
    // With nothing found, spells with a personal taper are open; the rest are settled.
    const open = splitpeaList(m, { school: 0, sort: 'name', hideSettled: true });
    expect(open.every((s) => s.formula.length >= 7)).toBe(true);
    const none = splitpeaList(m, { school: 0, sort: 'name', carried: () => false });
    expect(none).toEqual([]);
    const five = spells.find((s) => s.formula.length === 5)!;
    const carriedFive = splitpeaList(m, { school: 0, sort: 'name', carried: (id) => five.formula.includes(id) });
    expect(carriedFive.map((s) => s.id)).toContain(five.id);
  });

  it('Export HTML: a self-contained table with each formula, open tapers as "one of", names escaped', () => {
    const m = new SplitpeaModel([...spells, { ...spells[0], id: 9999, name: 'Bolt <&>' }]);
    const eight = spells.find((s) => s.formula.length === 8)!;
    learn(m, 'exporter', [eight.id]);
    const html = splitpeaExportHtml(m, splitpeaList(m, { school: 0, sort: 'name' }), names, 'Splitpea - Spell List - exporter');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toMatch(/<script|<link|src=/);
    expect(html).toContain('Bolt &lt;&amp;&gt;');
    expect(html).toContain('<th>Formula</th>');
    const truth = getPlayerFormula([...eight.formula], 1, 'exporter');
    const row = html.split('\n').find((l) => l.includes(`<td>${eight.name}</td>`))!;
    expect(row).toContain(names(truth[3]));
    expect(html).toContain('class="open"');
    expect(openSlotText([63, 69], names)).toBe('Red/Blue');
    expect(openSlotText([63, 64, 65, 66], names)).toBe('? (4)');
  });
});

const AC1999 = resolve(__dirname, '..', 'dat-sets', 'ac1999-retail');
const HAS_1999 = existsSync(resolve(AC1999, 'portal.dat'));

describe.skipIf(!HAS_1999)('Splitpea on the real 1999 SpellTable', () => {
  let spells: SplitpeaSpell[];
  beforeAll(() => {
    const portal = new DatDatabase(new FileDatBytes(resolve(AC1999, 'portal.dat')));
    portal.setOverlay(ac1999PortalOverlay());
    spells = splitpeaSpells(new SpellTable(new DatReader(portal.getFileData(0x0e00000e)!)).spells);
  });

  it('lists the researchable spells, most with a personal taper', () => {
    expect(spells.length).toBeGreaterThan(1000);
    expect(spells.filter((s) => version1Tapers(s.formula).personal.length > 0).length).toBeGreaterThan(1000);
    expect(spells.find((s) => s.name === 'Flame Bolt V')).toBeDefined();
  });

  it('property: random accounts learning random real spells; every solved slot is true, every open set contains the truth', () => {
    const r = rng(7);
    const personal = spells.filter((s) => version1Tapers(s.formula).personal.length > 0);
    for (let a = 0; a < 4; a++) {
      const acct = `real${Math.floor(r() * 1e9).toString(36)}`;
      const model = new SplitpeaModel(spells);
      const order = personal.map((s) => s.id).sort(() => r() - 0.5);
      let last = Infinity;
      for (const k of [3, 10]) {
        learn(model, acct, order.slice(0, k));
        expect(model.keysLeft()).toBeLessThanOrEqual(last);
        last = model.keysLeft();
        const { solved } = expectHonest(model, acct);
        if (k === 10) expect(solved).toBeGreaterThan(0);
      }
    }
  });
});
