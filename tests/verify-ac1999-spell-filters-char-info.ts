/**
 * BUG.ac1999-spell-filters (webac#7) + BUG.ac1999-char-info-eor-rows (webac#8).
 *
 * - The spellbook's school / level filter buttons are the ones the era's own
 *   SpellTable can match (spellbookFilterOptions): the 1999 table (through the
 *   1999 portal overlay) has Creature / Item / Life / War and levels I-VI; end
 *   of retail and the classic sets keep all five schools and I-VIII.
 * - A 1999 world's Character Information panel says what the 1999 client.exe
 *   did (born / played / deaths from the server, then its Burden panel text,
 *   burdenText1999 @ 0x59a9e0); end of retail's report is unchanged.
 * Drives the shipped modules and the real GameUI (happy-dom); the DAT checks
 * skip when the DAT sets are absent (CI).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spellbookFilterOptions } from '../packages/renderer/src/ui/spellbookFilter.js';
import { buildCharacterInfoReport, burdenText1999, type CharacterInfoSource } from '../packages/renderer/src/ui/CharacterInfoReport.js';
import { acStringHash, registerStringTable, type StringTableData } from '../packages/dat-parser/src/file-types/LayoutDesc.js';
import { SpellTable } from '../packages/dat-parser/src/file-types/SpellTable.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import type { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { ac1999PortalOverlay } from '../packages/dat-parser/src/era1999/Ac1999Overlay.js';
import { MagicSchool } from '../packages/shared/src/index.js';
import { eraClientRules } from '../packages/renderer/src/era/EraFeatures.js';
import { eraProfile } from '../packages/renderer/src/era/EraProfiles.js';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

const REPO = resolve(__dirname, '..');
const PORTAL_1999 = resolve(REPO, 'dat-sets/ac1999-retail/portal.dat');
const PORTAL_CLASSIC = resolve(REPO, 'dat-sets/classic-dereth-1.1/client_portal.dat');

describe('spellbookFilterOptions', () => {
  it('collects the schools present and the highest spell level (power thresholds)', () => {
    const o = spellbookFilterOptions([
      { school: MagicSchool.WarMagic, power: 1 }, { school: MagicSchool.LifeMagic, power: 250 },
      { school: MagicSchool.CreatureEnchantment, power: 100 },
    ]);
    expect([...o.schools].sort()).toEqual([MagicSchool.CreatureEnchantment, MagicSchool.LifeMagic, MagicSchool.WarMagic].sort());
    expect(o.maxLevel).toBe(6);
  });
  it('no table, or nothing usable in it: every button', () => {
    for (const o of [spellbookFilterOptions(null), spellbookFilterOptions([]), spellbookFilterOptions([{ school: 99, power: 0 }])]) {
      expect(o.schools.size).toBe(5);
      expect(o.maxLevel).toBe(8);
    }
  });
});

function tableOf(db: DatDatabase): SpellTable {
  return new SpellTable(new DatReader(db.getFileData(0x0e00000e)!));
}

describe.skipIf(!existsSync(PORTAL_1999))('the 1999 SpellTable: no Void, no VII / VIII (needs the 1999 DAT set)', () => {
  let opts: ReturnType<typeof spellbookFilterOptions>;
  beforeAll(() => {
    const db = openDat(PORTAL_1999);
    db.setOverlay(ac1999PortalOverlay());
    opts = spellbookFilterOptions(tableOf(db).spells.values());
  });
  it('Creature, Item, Life, War; levels I-VI', () => {
    expect([...opts.schools].sort()).toEqual([1, 2, 3, 4]);
    expect(opts.schools.has(MagicSchool.VoidMagic)).toBe(false);
    expect(opts.maxLevel).toBe(6);
  });
});

describe.skipIf(!existsSync(DAT_PATHS.portal))('end of retail keeps every button (needs DAT files)', () => {
  it('five schools, levels I-VIII', () => {
    const o = spellbookFilterOptions(tableOf(openDat(DAT_PATHS.portal)).spells.values());
    expect(o.schools.size).toBe(5);
    expect(o.maxLevel).toBe(8);
  });
});

describe.skipIf(!existsSync(PORTAL_CLASSIC))('Dark Majesty (classic Dereth) carries the same table (needs the classic DAT set)', () => {
  it('five schools, levels I-VIII: unchanged', () => {
    const o = spellbookFilterOptions(tableOf(openDat(PORTAL_CLASSIC)).spells.values());
    expect(o.schools.size).toBe(5);
    expect(o.maxLevel).toBe(8);
  });
});

// ── Character Information ────────────────────────────────────────────────────

function tok(name: string, strings: string[]) {
  return { id: acStringHash(name), varNames: [], vars: [], strings, comments: [], unknown: 0 };
}
const TABLE: StringTableData = {
  id: 0x23000001, language: 1, unknown: 0,
  entries: [
    tok('ID_CharacterInfo_Birth', ['You were born on ', '.\\n']),
    tok('ID_CharacterInfo_Played', ['You have played for ', '.\\n']),
    tok('ID_CharacterInfo_Deaths_Many', ['You have died ', ' times.\\n']),
    tok('ID_CharacterInfo_Resists', ['Natural Resistances: ', '\\nDrain Resistances: ', '\\nRegeneration Bonus: ', '\\n']),
    tok('ID_CharacterInfo_Innates', ['Innate Strength: ', '\\nInnate Endurance: ', '\\nInnate Coordination: ', '\\nInnate Quickness: ', '\\nInnate Focus: ', '\\nInnate Self: ', '\\n']),
    tok('ID_CharacterInfo_Chess', ['Chess Rank: ', '\\n']),
    tok('ID_CharacterInfo_Luminance_Header', ['Luminance Augmentations:\\n\\n']),
    tok('ID_CharacterInfo_Luminance_Base_Damage', ['Aura of Valor. Your Damage Rating is increased by ', '.\\n\\n']),
    tok('ID_CharacterInfo_Load_None', ['You are not overburdened at this time.\\n']),
    tok('ID_CharacterInfo_Load_Burdened', ['You are currently overburdened by ', ' burden units. This is reducing your Run, Jump, Melee Defense and Missile Defense skills by ', '%.\\n']),
  ],
};
registerStringTable(TABLE);

/** The reporter's character (webac#8): 51 deaths, 3922 units over. */
const props: Record<number, number> = { 98: 1790000000, 125: 15 * 3600 + 49 * 60, 43: 51, 181: 1400, 333: 3, 5: 100 * 150 + 3922 };
const SRC: CharacterInfoSource = {
  prop: (id) => props[id],
  attribute: () => 100,
  innateAttribute: () => 0,
  strength: 100,
};

describe('buildCharacterInfoReport by era', () => {
  it('the era rule: 1999 says the 1999 rows, every other era end of retail\'s', () => {
    expect(eraClientRules(eraProfile('ac1999-retail')).characterInfoText).toBe('ac1999');
    for (const id of ['eor', 'classic-dereth', 'classicace-customdm', 'classicace-infiltration']) {
      expect(eraClientRules(eraProfile(id)).characterInfoText, id).toBe('eor');
    }
  });

  it('end of retail: unchanged (resistances, innates, chess, luminance, burden)', () => {
    const text = buildCharacterInfoReport(SRC).join('\n');
    for (const s of ['You have died 51 times.', 'Natural Resistances:', 'Innate Strength: 0', 'Chess Rank: 1400',
      'Luminance Augmentations:', 'Aura of Valor', 'You are currently overburdened by 3922 burden units.']) expect(text).toContain(s);
    expect(buildCharacterInfoReport(SRC, 'eor')).toEqual(buildCharacterInfoReport(SRC));
  });

  it('1999: born / played / deaths, then the 1999 burden text; no EoR-only rows', () => {
    const lines = buildCharacterInfoReport(SRC, 'ac1999');
    const text = lines.join('\n');
    expect(lines[0]).toMatch(/^You were born on /);
    expect(lines[1]).toBe('You have played for 15 hours, 49 minutes.');
    expect(lines[2]).toBe('You have died 51 times.');
    for (const s of ['Resistances', 'Regeneration', 'Innate', 'Chess', 'Luminance', 'Aura', 'burden units']) expect(text).not.toContain(s);
    expect(text).toContain('You are currently overburdened by 3922 Burden Units.');
    expect(text).toContain('skill levels by 30%.');
    expect(text).toContain('To reduce this penalty, you must either drop some of your equipment or increase your Strength.');
    expect(lines).toHaveLength(4);
  });
});

describe('burdenText1999 (the 1999 client.exe @ 0x59a9e0)', () => {
  it('under capacity: the literal, typo included', () => {
    expect(burdenText1999(100 * 150 - 1, 100)).toBe('\n\nYou are not overburdended at this time');
  });
  it('capacity is Strength x 150; the penalty steps by 10 (truncated)', () => {
    // ratio 1.5 → mod 0.5 → 50 %; ratio 1.26 → mod 0.74 → trunc 7 → 30 %; ratio 2+ → 100 %.
    expect(burdenText1999(150 * 150, 100)).toContain('by 7500 Burden Units.');
    expect(burdenText1999(150 * 150, 100)).toContain('by 50%.');
    expect(burdenText1999(126 * 150, 100)).toContain('by 30%.');
    expect(burdenText1999(300 * 150, 100)).toContain('by 100%.');
    expect(burdenText1999(100 * 150, 100)).toContain('by 0%.');
  });
  it('no strength: load ratio 3.0, fully penalised', () => {
    expect(burdenText1999(10, 0)).toContain('by 100%.');
  });
});

// ── The real GameUI ──────────────────────────────────────────────────────────

describe('GameUI: the shared panels follow the era (behavioral)', () => {
  let H: GameUIFixture;
  beforeAll(async () => { H = await mountGameUI(); }, 60_000);
  afterAll(() => H?.teardown());

  it('the Character Information report switches with setCharacterInfoText', () => {
    H.ui.characterInfoSource = () => SRC;
    expect(H.ui.characterInfoReportLines().join('\n')).toContain('Luminance Augmentations:');
    H.ui.setCharacterInfoText('ac1999');
    const lines: string[] = H.ui.characterInfoReportLines();
    expect(lines.join('\n')).not.toContain('Luminance');
    expect(lines.join('\n')).toContain('Burden Units.');
    H.ui.setCharacterInfoText('eor');
    expect(H.ui.characterInfoReportLines()).toEqual(buildCharacterInfoReport(SRC));
  });

  it('the spellbook page hides the school / level buttons the table cannot match', () => {
    const doc = H.win.document;
    const made = new Map<number, HTMLElement>();
    const makeHandle = (parent: HTMLElement) => {
      const root = doc.createElement('div');
      parent.appendChild(root);
      const elements = new Map<number, HTMLElement>();
      const get = elements.get.bind(elements);
      elements.get = (id: number) => {
        const have = get(id);
        if (have) return have;
        const el: HTMLElement = doc.createElement('div');
        root.appendChild(el); elements.set(id, el); made.set(id, el);
        return el;
      };
      const noop = () => {};
      return {
        root, layout: { elements: [] }, elements, descs: new Map(),
        setText: noop, setFill: noop, setVisible: noop, setState: noop, setPalette: noop, setInteractive: noop,
        setScrollable: () => ({ contentEl: doc.createElement('div'), setPosition: noop, scrollToBottom: noop, appendContent: noop }),
        setDraggable: noop, setDropTarget: noop, setTexture: noop, onClick: noop, resizeSubtree: noop,
        destroy: () => root.remove(), moveTo: noop, close: () => root.remove(), bringToFront: noop,
      };
    };
    H.ui.layoutRenderer = {
      render: (_id: number, parent: HTMLElement) => makeHandle(parent),
      renderPanel: (_id: number, parent: HTMLElement) => makeHandle(parent),
      getTextureDataURLWithAlpha: () => null, getResolvedLayout: () => null, setFontResolver: () => {},
    };
    const VOID = 0x100005c0, WAR = 0x1000029b, VI = 0x100002a1, VII = 0x100002a2, VIII = 0x1000054e;
    // A 1999-shaped table: four schools, nothing past level VI.
    H.ui.spellTable = { spells: new Map([1, 2, 3, 4].map((sch, i) => [i + 1, { school: sch, power: i === 0 ? 250 : 1 }])) };
    H.ui.toggleMagicPanel();
    for (const id of [VOID, VII, VIII]) expect(made.get(id)?.style.display, id.toString(16)).toBe('none');
    for (const id of [WAR, VI]) expect(made.get(id)?.style.display, id.toString(16)).not.toBe('none');
    H.ui.toggleMagicPanel();
    // End of retail's shape: all five schools, levels to VIII.
    made.clear();
    H.ui.spellTable = { spells: new Map([1, 2, 3, 4, 5].map((sch, i) => [i + 1, { school: sch, power: i === 0 ? 400 : 1 }])) };
    H.ui.toggleMagicPanel();
    for (const id of [VOID, WAR, VI, VII, VIII]) expect(made.get(id)?.style.display, id.toString(16)).not.toBe('none');
    H.ui.toggleMagicPanel();
  });

  it('the spellbook filter options come from the spell table GameUI holds', () => {
    H.ui.spellTable = { spells: new Map([[1, { school: MagicSchool.WarMagic, power: 250 }], [2, { school: MagicSchool.LifeMagic, power: 1 }]]) };
    const o = H.ui.spellbookFilterOptions();
    expect([...o.schools].sort()).toEqual([MagicSchool.LifeMagic, MagicSchool.WarMagic].sort());
    expect(o.maxLevel).toBe(6);
    H.ui.spellTable = null;
    expect(H.ui.spellbookFilterOptions().maxLevel).toBe(8);
  });
});
