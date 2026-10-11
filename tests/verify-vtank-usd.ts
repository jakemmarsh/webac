/**
 * VirindiTank's `.usd` settings files (docs/vtank-parity-gaps.md §10.2,
 * packages/shared/src/routines/vtankUsd.ts): the tables read and written
 * byte for byte, a file's options and Monsters / Items / Consumables / Buffs
 * tabs into a profile, the tables we don't model kept, and export → import
 * giving back what was imported.
 *
 * Fixtures: tests/fixtures/vtank/hunter.usd is our own file in the format
 * (checked with an independent parser). Real VTank-written files (MossTank's
 * test fixtures, a GPL repo, so not copied here) run when present under
 * reference/vtank-corpus (gitignored; skipped on CI).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ALL_MODULES_OFF, emptyVtankData, exportUsd, exportVTankFile, guessAssistType, importUsd, importVTankFiles, parseUsd, resolveVtankIds,
  validateRoutineDoc, vtankFileKind, vtDefaults, writeUsd, emptyRoutineDoc, type RoutineProfile, type VtNames,
} from '../packages/shared/src/routines/index.ts';

const fx = (n: string): string => readFileSync(resolve(__dirname, 'fixtures/vtank', n), 'latin1');
const WAND = 0x8000abcd;
const SHIELD = 0x8000abce;
const SPELLS: Record<number, string> = { 1: 'Strength Other I', 2: 'Weakness Other I', 1018: 'Leadership Mastery Self I' };
/** What a live client gives the importer: the spell table and the items you carry. */
const names: VtNames = {
  spellName: (id) => SPELLS[id],
  spellId: (n) => Number(Object.entries(SPELLS).find(([, v]) => v === n)?.[0]) || undefined,
  objectName: (g) => ({ [WAND]: 'Wand of the Hunter', [SHIELD]: 'Kite Shield' } as Record<number, string>)[g],
  objectId: (n) => ({ 'Wand of the Hunter': WAND | 0, 'Kite Shield': SHIELD | 0, 'Practice Sword': 0x80001111 | 0 } as Record<string, number>)[n],
};
const base = (): RoutineProfile => ({ name: 'Hunter', modules: { ...ALL_MODULES_OFF }, initialState: 'Default', states: [{ name: 'Default', rules: [] }], loot: [], buffSets: [], routes: [] });

describe('the .usd tables', () => {
  it('reads every table of our fixture and writes it back byte for byte', () => {
    const text = fx('hunter.usd');
    const t = parseUsd(text);
    expect(t.map((x) => x.name)).toEqual(['AntiExtraBuffSpells', 'AssistItems', 'BuffedItems', 'ExtraBuffSpells', 'GemFoodItems', 'ItemUseSpecifiers', 'MyMonsters', 'Settings', 'SettingsCategories']);
    expect(t.find((x) => x.name === 'MyMonsters')!.cols).toHaveLength(21);
    expect(t.find((x) => x.name === 'MyMonsters')!.index[0]).toBe(true);
    const rh = t.find((x) => x.name === 'Settings')!.rows.find((r) => r[0].t === 's' && r[0].v === 'RechargeHandlerSet')!;
    expect(rh[1].t).toBe('table');
    expect(writeUsd(t)).toBe(text);
  });

  it('accepts LF-only copies and comma decimals; refuses what isn\'t one', () => {
    const lf = fx('hunter.usd').replace(/\r\n/g, '\n');
    expect(parseUsd(lf)).toEqual(parseUsd(fx('hunter.usd')));
    const comma = fx('hunter.usd').replace('0.083333333333333329', '0,083333333333333329');
    expect(parseUsd(comma)).toEqual(parseUsd(fx('hunter.usd')));
    expect(() => parseUsd('1\r\nSettings\r\n1\r\nSetting\r\nn\r\n1\r\nq\r\nx\r\n')).toThrow(/unknown value tag "q"/);
    expect(vtankFileKind('Hunter.USD', '')).toBe('usd');
    expect(vtankFileKind('noext', fx('hunter.usd'))).toBe('usd');
  });
});

describe('importing a .usd', () => {
  it('options typed and in our units; the tabs from their tables; ids named by the live client', () => {
    const r = importUsd(base(), fx('hunter.usd'), names);
    const s = r.value.settings!;
    expect(s.EnableCombat).toBe(true);
    expect(s.EnableLooting).toBe(false);
    // VTank stores ranges as map units (yards / 240): 20 yd.
    expect(s.AttackDistance).toBe(20);
    expect(s['Recharge-Norm-HitP']).toBe(60);
    expect(s.UseArcs).toBe(2);
    expect(s['BuffProfile-Prots']).toBe('BPS');
    expect(s.SomePluginSetting).toBe('kept');
    const v = r.value.vtank!;
    expect(v.monsters.map((m) => m.name)).toEqual(['<DEFAULT>', 'Drudge Skulker', 'maxhp>500']);
    expect(v.monsters[0]).toMatchObject({ priority: 1, on: ['A', 'S'], damage: 8, exVuln: 98, weapon: null, offhand: null, petDamage: 101 });
    expect(v.monsters[1]).toMatchObject({ priority: 3, damage: 6, on: ['I', 'V', 'A'], weapon: 'Wand of the Hunter', offhand: 'Kite Shield' });
    expect(v.monsters[1].expr).toBeUndefined();
    expect(v.monsters[2]).toMatchObject({ expr: true, priority: 4, on: ['I', 'Y', 'A'], exVuln: 5, petDamage: 6 });
    // Items tab: BuffedItems' objects in order.
    expect(v.items).toEqual([{ name: 'Wand of the Hunter' }, { name: 'Kite Shield' }]);
    // Consumables: AssistItems' names; a kind outside 0–11 is kept, not listed.
    expect(v.consumables).toEqual(['Handy Healing Kit', 'Mana Draught']);
    expect(v.usd?.assistTypes).toEqual({ 'Handy Healing Kit': 0, 'Mana Draught': 5 });
    expect(v.usd?.assistOther).toEqual([{ name: 'Strange Trinket', type: 42 }]);
    expect(v.gemFood).toEqual([{ name: "Asheron's Benediction", spell: 3810 }]);
    expect(v.extraBuffs).toEqual(['Strength Other I', 'Weakness Other I']);
    expect(v.blacklistedBuffs).toEqual(['Leadership Mastery Self I']);
    // Kept as they are: ItemUseSpecifiers, the per-item buff rows, RechargeHandlerSet, SettingsCategories.
    expect(v.usd?.itemUseSpecifiers).toEqual([{ object: WAND | 0, uses: 5 }]);
    expect(v.usd?.buffedItems).toEqual([{ object: WAND | 0, spell: 1599 }, { object: WAND | 0, spell: 35 }, { object: SHIELD | 0, spell: -1 }]);
    expect(v.usd?.settingsRaw?.map((x) => x.name)).toEqual(['RechargeHandlerSet']);
    expect(v.usd?.tables?.map((x) => x.name)).toEqual(['SettingsCategories']);
    expect(r.problems).toEqual(['1 Consumables row(s) of a kind we don\'t know; kept as they are']);
    // States, routes and loot are the profile's own; the result stores.
    expect(r.value.states).toEqual(base().states);
    const doc = { ...emptyRoutineDoc('s', 'a'), profiles: [r.value] };
    expect(validateRoutineDoc(doc)).toEqual([]);
    // A hand-edited document with a broken GemFoodItems list or keep is refused.
    const bad = structuredClone(doc);
    (bad.profiles[0].vtank as unknown as { gemFood: unknown }).gemFood = [{ name: 'Gem' }];
    (bad.profiles[0].vtank as unknown as { usd: unknown }).usd = 'x';
    expect(validateRoutineDoc(bad).map((i) => i.path)).toEqual(['profiles[0].vtank.gemFood', 'profiles[0].vtank.usd']);
  });

  it('without a live client (Claude\'s import): object and spell ids are kept by id and named when the macro runs', () => {
    const r = importUsd(base(), fx('hunter.usd'));
    const v = r.value.vtank!;
    expect(v.items).toEqual([]);
    expect(v.usd?.unnamedItems).toEqual([WAND | 0, SHIELD | 0]);
    expect(v.monsters[1]).toMatchObject({ weapon: null, offhand: null, vt: { weapon: WAND | 0, offhand: SHIELD | 0 } });
    expect(v.extraBuffs).toEqual([]);
    expect(v.usd?.unnamedExtraBuffs).toEqual([1, 2]);
    expect(r.problems.some((p) => /Items-tab object id/.test(p))).toBe(true);
    // The macro's view: the same ids named from what it carries now and the spell table.
    const seen = resolveVtankIds(v, names);
    expect(seen.items.map((x) => x.name)).toEqual(['Wand of the Hunter', 'Kite Shield']);
    expect(seen.monsters[1]).toMatchObject({ weapon: 'Wand of the Hunter', offhand: 'Kite Shield' });
    expect(seen.extraBuffs).toEqual(['Strength Other I', 'Weakness Other I']);
    expect(seen.blacklistedBuffs).toEqual(['Leadership Mastery Self I']);
    // Nothing kept by id: the same object back.
    const plain = emptyVtankData();
    expect(resolveVtankIds(plain, names)).toBe(plain);
  });

  it('a .usd beside a .met: the meta makes the states, the .usd the settings and tabs', () => {
    const r = importVTankFiles([{ name: 'hunt.met', text: fx('hunt.met') }, { name: 'hunter.usd', text: fx('hunter.usd') }], null, 'hunt', names);
    expect(r.value.states.map((s) => s.name)).toEqual(['Default', 'Fight', 'Sell']);
    expect(r.value.settings?.AttackDistance).toBe(20);
    expect(r.value.vtank?.items).toHaveLength(2);
    expect(importVTankFiles([{ name: 'x.usd', text: 'nonsense' }], base(), 'x').problems[0]).toMatch(/^x\.usd: could not read it/);
  });
});

describe('exporting a .usd', () => {
  it('import → export → import gives back what was imported (with and without the live client)', () => {
    for (const n of [names, {}]) {
      const a = importUsd(base(), fx('hunter.usd'), n).value;
      const out = exportUsd(a, n);
      expect(out.fileName).toBe('Hunter.usd');
      expect(out.text.endsWith('\r\n')).toBe(true);
      const b = importUsd(base(), out.text, n).value;
      expect(b.vtank).toEqual(a.vtank);
      expect({ ...vtDefaults(), ...b.settings }).toEqual({ ...vtDefaults(), ...a.settings });
    }
  });

  it('every option goes out typed as VTank types it (SettingType), ranges as map units', () => {
    const p = { ...base(), settings: { AttackDistance: 12, EnableNav: true }, vtank: emptyVtankData() };
    const t = parseUsd(exportUsd(p).text);
    const st = t.find((x) => x.name === 'Settings')!;
    expect(st.cols).toEqual(['Setting', 'Value', 'Description', 'SettingType']);
    const row = (n: string) => st.rows.find((r) => r[0].t === 's' && r[0].v === n)!;
    expect(row('AttackDistance')[1]).toEqual({ t: 'd', v: 12 / 240 });
    expect(row('AttackDistance')[3]).toEqual({ t: 'i', v: 2 });
    expect(row('EnableNav')[1]).toEqual({ t: 'b', v: true });
    expect(row('UseArcs')[3]).toEqual({ t: 'i', v: 6 });
    expect(row('BuffProfile-Prots')[3]).toEqual({ t: 'i', v: 5 });
    expect(row('Recharge-Norm-HitP')[1]).toEqual({ t: 'i', v: 75 });
    // VTank's tables, in its order; an unset GemFoodItems is VTank's default two.
    expect(t.map((x) => x.name)).toEqual(['AntiExtraBuffSpells', 'AssistItems', 'BuffedItems', 'ExtraBuffSpells', 'GemFoodItems', 'ItemUseSpecifiers', 'MyMonsters', 'Settings']);
    expect(t.find((x) => x.name === 'GemFoodItems')!.rows).toEqual([[{ t: 's', v: "Asheron's Benediction" }, { t: 'i', v: 3810 }], [{ t: 's', v: "Blackmoor's Favor" }, { t: 'i', v: 3811 }]]);
  });

  it('what was made here: items and weapons by the ids of what you carry; what can\'t be written is said', () => {
    const v = emptyVtankData();
    v.items = [{ name: 'Wand of the Hunter' }, { name: 'Lost Mace' }];
    v.monsters.push({ name: 'Mite', priority: 2, on: ['A'], damage: 8, exVuln: 98, weapon: 'Wand of the Hunter', offhand: 'Lost Mace', petDamage: 101 });
    v.consumables = ['Handy Healing Kit', 'Prismatic Pea', 'Bread'];
    v.extraBuffs = ['Strength Other I', 'Unknown Spell'];
    v.excludedScarabs = ['Platinum Scarab'];
    const out = exportUsd({ ...base(), vtank: v }, names);
    const t = parseUsd(out.text);
    const rows = (n: string) => t.find((x) => x.name === n)!.rows;
    expect(rows('BuffedItems')).toEqual([[{ t: 'i', v: WAND | 0 }, { t: 'i', v: -1 }]]);
    const mite = rows('MyMonsters').find((r) => r[0].t === 's' && r[0].v === 'Mite')!;
    expect(mite[3]).toEqual({ t: 'i', v: WAND | 0 });
    expect(mite[19]).toEqual({ t: 'i', v: 0 });
    expect(rows('AssistItems')).toEqual([[{ t: 's', v: 'Handy Healing Kit' }, { t: 'i', v: 0 }], [{ t: 's', v: 'Prismatic Pea' }, { t: 'i', v: 9 }]]);
    expect(rows('ExtraBuffSpells')).toEqual([[{ t: 'i', v: 1 }]]);
    expect(out.problems).toEqual(expect.arrayContaining([
      expect.stringMatching(/monster "Mite": its offhand "Lost Mace" isn't carried/),
      expect.stringMatching(/Items tab: "Lost Mace" not carried/),
      expect.stringMatching(/Consumables: "Bread" have no VirindiTank kind/),
      expect.stringMatching(/Excluded Scarab Types/),
      expect.stringMatching(/Extra Buff Spells: "Unknown Spell" not found/),
    ]));
    expect(guessAssistType('[All Peas]')).toBe(11);
    expect(guessAssistType('Plentiful Healing Kit')).toBe(0);
    expect(guessAssistType('Bread')).toBeUndefined();
  });

  it('removing an item from the Items tab drops its kept rows; one kept by id stays', () => {
    const a = importUsd(base(), fx('hunter.usd'), names).value;
    a.vtank!.items = a.vtank!.items.filter((x) => x.name !== 'Wand of the Hunter');
    const rows = parseUsd(exportUsd(a, names).text).find((x) => x.name === 'BuffedItems')!.rows;
    expect(rows).toEqual([[{ t: 'i', v: SHIELD | 0 }, { t: 'i', v: -1 }]]);
  });

  it('exportVTankFile hands out usd and af alongside met / nav / utl', () => {
    const p = importVTankFiles([{ name: 'hunt.met', text: fx('hunt.met') }, { name: 'hunter.usd', text: fx('hunter.usd') }], null, 'hunt', names).value;
    expect(exportVTankFile(p, 'usd')!.fileName).toBe('hunt.usd');
    expect(exportVTankFile(p, 'af')!.fileName).toBe('hunt.af');
    expect(exportVTankFile(p, 'af', 'Holtburg loop')!.text).toMatch(/^NAV: nav0 circular/m);
    expect(exportVTankFile(p, 'af', 'nope')).toBeNull();
    expect(exportVTankFile(p, 'met')!.fileName).toBe('hunt.met');
  });
});

// Real VTank-written settings files: MossTank's test fixtures (defaultsettings.usd, owner-*.usd,
// vt-proof-settings.usd; https://github.com/eriknihlen/openac-mosstank tests/…/Fixtures), kept in
// reference/vtank-mosstank/usd (gitignored: MossTank is GPL, so they aren't copied into the repo).
const MOSS = process.env.ACJS_VTANK_MOSSTANK ?? resolve(__dirname, '..', 'reference', 'vtank-mosstank');
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
describe.skipIf(!existsSync(MOSS))('VTank-written .usd files (reference/vtank-mosstank)', () => {
  it('each reads and writes back byte for byte, and round-trips through a profile', () => {
    const files = walk(MOSS).filter((f) => /\.usd$/i.test(f));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(f, 'latin1');
      expect(writeUsd(parseUsd(text)), f).toBe(text);
      const a = importUsd(base(), text).value;
      const b = importUsd(base(), exportUsd(a).text).value;
      expect(b.vtank, f).toEqual(a.vtank);
      expect({ ...vtDefaults(), ...b.settings }, f).toEqual({ ...vtDefaults(), ...a.settings });
    }
    const def = files.find((f) => /defaultsettings\.usd$/.test(f));
    if (def) {
      // VTank's own defaults are ours (vtankOptions.ts took them from this file), EnableMeta aside (ours is on).
      const s = importUsd(base(), readFileSync(def, 'latin1')).value.settings!;
      const ours = vtDefaults();
      for (const [k, v] of Object.entries(ours)) if (k !== 'EnableMeta' && k in s) expect(s[k], k).toEqual(v);
      expect(s.EnableMeta).toBe(false);
    }
  });
});
