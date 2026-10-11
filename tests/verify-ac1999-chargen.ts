/**
 * Character creation against the 1999 world (era ac1999-retail) under the
 * end-of-retail chargen pages (docs/ac1999-support-scope.md Phase 5):
 *
 * - the heritage page lists only the heritages the WORLD CharGen defines
 *   (HeritageRows.ts `defined`), and Random only rolls listed ones;
 * - the heritage lore / profession text is the 1999 CharGen's own (its 0x31
 *   description ids, which the EoL format has no slot for: Chargen1999.ts);
 * - the profession rows are the CharGen's 8 templates (template index sent
 *   as is), the watermark art is off;
 * - the town page is a list of the CharGen's start areas, the clicked index
 *   (0..17) being what the create request carries;
 * - the summary names the template and the start area.
 *
 * Every other era keeps its pages (chargen1999 is null): the end-of-retail
 * comparisons below hold the old output. The GameUI cases drive the real
 * GameUI in happy-dom with a 1999-shaped CharGen (CI); the real 1999 DAT
 * cases skip without dat-sets/ac1999-retail, loading in beforeAll.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { FileDatBytes } from '../packages/dat-parser/src/node/FileDatBytes.js';
import { ac1999PortalOverlay } from '../packages/dat-parser/src/era1999/Ac1999Overlay.js';
import { HERITAGE_ROWS, heritageListed, visibleHeritageRows } from '../packages/renderer/src/ui/HeritageRows.js';
import { randomizeHeritageGroup, scriptedRandomSource } from '../packages/renderer/src/ui/ChargenRandomize.js';
import { loadChargen1999, startAreasFor1999, type Chargen1999 } from '../packages/renderer/src/ui/Chargen1999.js';
import { buildSummaryRows } from '../packages/renderer/src/ui/ChargenSummary.js';
import { CreateStep } from '../packages/renderer/src/ui/CharacterCreate.js';
import { parseTextRuns } from '../packages/renderer/src/ui/HeritageText.js';
import { mountGameUI, openChargen, type GameUIFixture } from './_harness/gameui.js';
import { DAT_PATHS, openDat } from './_harness/dat.js';

const named = (id: number): string => `name-${id}`;
const only123 = (h: number): boolean => h >= 1 && h <= 3;

describe('heritage rows: only the heritages the world CharGen defines', () => {
  it('a CharGen defining 1..3 lists Aluvian, Gharu\'ndim, Sho; one defining all 13 (end of retail, classic) lists 13', () => {
    expect(visibleHeritageRows(named, only123).map((r) => r.key)).toEqual([1, 2, 3]);
    expect(visibleHeritageRows(named, () => true).map((r) => r.key)).toEqual(HERITAGE_ROWS.map((r) => r.key));
    expect(visibleHeritageRows(named).map((r) => r.key)).toEqual(HERITAGE_ROWS.map((r) => r.key));
    // The blank-label rule still applies on top.
    const blankSho = (id: number): string => (id === HERITAGE_ROWS[2].labelId ? '' : named(id));
    expect(visibleHeritageRows(blankSho, only123).map((r) => r.key)).toEqual([1, 2]);
    expect(heritageListed(4, named, only123)).toBe(false);
    expect(heritageListed(2, named, only123)).toBe(true);
    expect(heritageListed(4, named)).toBe(true);
  });

  it('Random redraws a Throne-of-Destiny roll on Viamontian among the defined ones', () => {
    const listed = (h: number) => heritageListed(h, named, only123);
    expect([1, 2, 3]).toContain(randomizeHeritageGroup(scriptedRandomSource([16383], [0.999]), true, listed));
    expect(randomizeHeritageGroup(scriptedRandomSource([0], [0.999]), true, (h) => heritageListed(h, named, () => true))).toBe(4);
  });
});

describe('start areas and the summary', () => {
  it('startAreasFor1999: primary then secondary, no repeats, within the CharGen; none listed = every area', () => {
    expect(startAreasFor1999({ primaryStartAreas: [12, 13], secondaryStartAreas: [0, 13, 1, 40] }, 18)).toEqual([12, 13, 0, 1]);
    expect(startAreasFor1999(undefined, 3)).toEqual([0, 1, 2]);
    expect(startAreasFor1999({ primaryStartAreas: [], secondaryStartAreas: [] }, 2)).toEqual([0, 1]);
  });

  it('buildSummaryRows prints the 1999 names when given, pcProfessions / pcTown otherwise', () => {
    const base = {
      profession: 3, gender: 1, heritage: 1, startArea: 1, skillCreditsRemaining: 0, skills: [],
      attributes: { strength: 10, endurance: 10, coordination: 10, quickness: 10, focus: 10, self: 10 },
    };
    const eol = buildSummaryRows(base).slice(0, 4).map((r) => (r.kind === 'text' ? r.text : ''));
    expect(eol).toEqual(['Profession: Life Caster', 'Gender: Male', 'Heritage: Aluvian', 'Starting Town: Shoushi']);
    const y1999 = buildSummaryRows({ ...base, professionName: 'Enchanter', townName: 'Holtburg West' }).slice(0, 4).map((r) => (r.kind === 'text' ? r.text : ''));
    expect(y1999).toEqual(['Profession: Enchanter', 'Gender: Male', 'Heritage: Aluvian', 'Starting Town: Holtburg West']);
  });
});

// ── the real GameUI against a 1999-shaped CharGen ──────────────────────

const AREAS = ['Holtburg South', 'Holtburg West', 'Rithwic East', 'Rithwic South', 'Lytelthorpe East', 'Lytelthorpe West',
  'Shoushi Southeast', 'Shoushi West', 'Yanshi North', 'Yanshi South', 'Nanto East', 'Nanto North',
  'Yaraq North', 'Yaraq East', 'Samsur East', 'Samsur Northwest', 'Al-Arqas West', 'Al-Arqas North'];
const TEMPLATE_NAMES = ['Adventurer', 'Archer', 'Blademaster', 'Enchanter', 'Life Mage', 'Sorcerer', 'Vagabond', 'Warrior'];
/**
 * Adventurer all 10s; Warrior (7) the CD's 100/100/70/40/10/10, no skills;
 * the others focus / self 100 with a primary skill nobody has, so they fit
 * nothing (a Warrior fits Warrior, all 10s fits the custom template).
 */
const template = (name: string, i: number) => {
  const a = i === 0 ? [10, 10, 10, 10, 10, 10] : i === 7 ? [100, 100, 70, 40, 10, 10] : [10, 10, 10, 10, 100, 100];
  return {
    name, iconImage: 0, title: 0, strength: a[0], endurance: a[1], coordination: a[2], quickness: a[3], focus: a[4], self: a[5],
    normalSkillsList: [], primarySkillsList: i === 0 || i === 7 ? [] : [99],
  };
};
const heritage = (name: string, primary: number[], secondary: number[]) => ({
  name, iconImage: 0, setupId: 0, environmentSetupId: 0, attributeCredits: 330, skillCredits: 50,
  primaryStartAreas: primary, secondaryStartAreas: secondary, skills: [],
  templates: TEMPLATE_NAMES.map(template), genders: new Map(),
});
const range = (a: number, b: number): number[] => Array.from({ length: b - a }, (_, i) => a + i);
/** The 1999 CD's CharGen, as the overlay serves it (the fields chargen reads). */
const charGen1999Shape = {
  starterAreas: AREAS.map((name) => ({ name, locations: [] })),
  heritageGroups: new Map([
    [1, heritage('Aluvian', range(0, 6), range(6, 18))],
    [2, heritage("Gharu'ndim", range(12, 18), range(0, 12))],
    [3, heritage('Sho', range(6, 12), [...range(0, 6), ...range(12, 18)])],
  ]),
};
const text1999: Chargen1999 = {
  heritageText: (h) => `heritage-${h}`,
  templateText: (h, t) => `template-${h}-${t}`,
  sexText: () => null,
};

describe('GameUI chargen with the 1999 world', () => {
  let H: GameUIFixture;
  beforeAll(async () => { H = await mountGameUI(); });
  afterAll(() => H.teardown());

  /* eslint-disable @typescript-eslint/no-explicit-any */
  function open(ui: any, with1999: boolean): void {
    ui.getTexURL = () => null;
    ui.charGen = with1999 ? charGen1999Shape : null;
    ui.chargen1999 = with1999 ? text1999 : null;
    ui.accountHasThroneOfDestiny = !with1999; // the 1999 character list says no ToD
    ui.paintChargenShadeDisk = () => {};
    ui.renderChargenPreview = () => {};
    ui.renderChargenSummaryView = () => {};
    openChargen(ui);
  }
  const render = (html: string): HTMLElement => { const host = H.win.document.createElement('div'); host.innerHTML = html; return host; };
  const step = (s: CreateStep): void => { H.ui.wizard.currentStep = s; H.ui.renderCharacterCreate(); };
  const click = (el: Element | null): void => { (el as HTMLElement).dispatchEvent(new H.win.MouseEvent('click', { bubbles: true })); };
  const texts = (root: Element, sel: string): string[] => Array.from(root.querySelectorAll(sel)).map((e) => (e.querySelector('[data-ac-text]') as HTMLElement | null)?.getAttribute('data-ac-text') ?? '');

  it('heritage page: three rows; the lore panel is the 1999 heritage description alone', () => {
    open(H.ui, true);
    H.ui.wizard.heritage = 2;
    const host = render(H.ui.renderRaceStep());
    expect(Array.from(host.querySelectorAll('.heritage-btn')).map((e) => (e as HTMLElement).dataset.heritage)).toEqual(['1', '2', '3']);
    const runs = parseTextRuns(host.querySelector('.heritage-lore [data-ac-runs]')!.getAttribute('data-ac-runs')!);
    expect(runs).toEqual([{ text: 'heritage-2', colorIndex: 0 }]);
  });

  it('end of retail (no 1999 text, no CharGen loaded): 13 rows and the retail lore composition, as before', () => {
    open(H.ui, false);
    H.ui.wizard.heritage = 1;
    const host = render(H.ui.renderRaceStep());
    expect(host.querySelectorAll('.heritage-btn')).toHaveLength(13);
    const runs = parseTextRuns(host.querySelector('.heritage-lore [data-ac-runs]')!.getAttribute('data-ac-runs')!)!;
    expect(runs.some((r) => r.text === '\n')).toBe(true); // heritageLoreRuns' explicit "\n"
    expect(runs.some((r) => r.text.startsWith('heritage-'))).toBe(false);
  });

  it('Random on the heritage page and RandomizeCharacter only land on the three', () => {
    open(H.ui, true);
    H.ui.wizard.currentStep = CreateStep.Heritage;
    for (const roll of [0, 0.5, 0.999]) {
      H.ui.chargenRandomSource = scriptedRandomSource([16383], [roll]);
      H.ui.doChargenRandom();
      expect([1, 2, 3]).toContain(H.ui.wizard.heritage);
    }
  });

  it('profession page: the 8 CharGen templates by name; Warrior applies template 7 and shows its 1999 text; no watermark art', () => {
    open(H.ui, true);
    step(CreateStep.Profession);
    const c = H.container;
    const rows = Array.from(c.querySelectorAll('.template-btn')) as HTMLElement[];
    expect(rows.map((b) => [b.dataset.template, b.dataset.label])).toEqual(TEMPLATE_NAMES.map((n, i) => [String(i), n]));
    expect(rows.map((b) => parseInt(b.style.top))).toEqual([45, 80, 110, 140, 170, 200, 230, 260]);
    click(c.querySelector('.template-btn[data-profession="Warrior"]'));
    expect(H.ui.wizard.templateIndex).toBe(7);
    expect(H.ui.wizard.attributes.strength).toBe(100);
    const desc = H.container.querySelector('.profession-description')!;
    expect(desc.querySelector('[data-ac-text]')?.getAttribute('data-ac-text') ?? desc.textContent).toContain('template-1-7');
    const states: number[] = [];
    H.ui.chargenHandle = { setState: (_id: number, s: number) => states.push(s) };
    try {
      H.ui.syncProfessionWatermark();
    } finally {
      H.ui.chargenHandle = null;
    }
    expect(states).toEqual([0x1000002b]); // the Custom state: no art
  });

  it('town page: the heritage\'s start areas as a list (own towns first); a click sets the 0..17 index the create request carries', () => {
    open(H.ui, true);
    H.ui.wizard.setHeritageGroup(2, H.ui.chargenRollDeps(), scriptedRandomSource([0], [0]));
    step(CreateStep.Town);
    const c = H.container;
    expect(c.querySelector('img')).toBeNull(); // no end-of-retail map art
    const rows = Array.from(c.querySelectorAll('.start-area-row')) as HTMLElement[];
    expect(rows.map((r) => Number(r.dataset.area))).toEqual([...range(12, 18), ...range(0, 12)]);
    // All 18 rows fit the 481 px frame (8 + 18 x 26 = 476): the list clips, never a native scrollbar.
    const list = c.querySelector('.start-area-list') as HTMLElement;
    expect(list.style.overflow).toBe('hidden');
    const last = rows[rows.length - 1];
    expect(parseInt(last.style.top, 10) + parseInt(last.style.height, 10)).toBeLessThanOrEqual(481);
    expect(texts(render(H.ui.renderMapStep()), '.start-area-row').slice(0, 2)).toEqual(['Yaraq North', 'Yaraq East']);
    click(c.querySelector('.start-area-row[data-area="13"]'));
    expect(H.ui.wizard.startArea).toBe(13);
    expect(H.ui.wizard.getCharacterInfo().startArea).toBe(13);
    expect(render(H.ui.renderMapStep()).querySelector('[data-ac-text="Yaraq East"]')).toBeTruthy(); // the heading
  });

  it('town Random rolls among the listed start areas', () => {
    open(H.ui, true);
    H.ui.wizard.setHeritageGroup(3, H.ui.chargenRollDeps(), scriptedRandomSource([0], [0]));
    H.ui.wizard.currentStep = CreateStep.Town;
    for (const r of [0, 9000, 32767]) {
      H.ui.chargenRandomSource = scriptedRandomSource([r], [0]);
      H.ui.doChargenRandom();
      expect(H.ui.wizard.startArea).toBeGreaterThanOrEqual(0);
      expect(H.ui.wizard.startArea).toBeLessThan(18);
    }
  });

  it('summary: the template and start-area names', () => {
    open(H.ui, true);
    H.ui.wizard.setTemplate(7);
    H.ui.wizard.applyTemplate(H.ui.chargenTemplates(), H.ui.chargenSkillCosts());
    H.ui.wizard.startArea = 1;
    const lines = texts(render(H.ui.renderFinishStep()), '.summary-row-text');
    expect(lines[0]).toBe('Profession: Warrior');
    expect(lines[3]).toBe('Starting Town: Holtburg West');
  });

  it('summary: a 1999 start-area line gets the listbox width (Holtburg South was clipped to "Holtburg Soul" at 175 px); end of retail keeps 175', () => {
    const clipWidths = (): string[] => Array.from(render(H.ui.renderFinishStep()).querySelectorAll('.summary-row-text-clip')).map((e) => (e as HTMLElement).style.width);
    open(H.ui, true);
    expect(new Set(clipWidths())).toEqual(new Set(['240px']));
    open(H.ui, false);
    expect(new Set(clipWidths())).toEqual(new Set(['175px']));
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */
});

// ── the real 1999 DAT ───────────────────────────────────────────────────

const PORTAL_1999 = resolve(__dirname, '..', 'dat-sets', 'ac1999-retail', 'portal.dat');
const HAS_1999 = existsSync(PORTAL_1999);

describe.skipIf(!HAS_1999)('the 1999 retail portal through the overlay', () => {
  let world: DatDatabase;
  let text: Chargen1999 | null;
  beforeAll(() => {
    // Its own instance: openDat's is shared per worker, and the overlay would change what other files read.
    world = new DatDatabase(new FileDatBytes(PORTAL_1999));
    world.setOverlay(ac1999PortalOverlay());
    text = loadChargen1999(world);
  });

  it('loadChargen1999 reads the 1999 heritage / template / sex text', () => {
    expect(text).not.toBeNull();
    expect(text!.heritageText(1)!.startsWith('ALUVIANS are a fiercely individualistic')).toBe(true);
    expect(text!.heritageText(3)!.startsWith('The SHO are a people')).toBe(true);
    for (const h of [1, 2, 3]) expect(text!.heritageText(h)!.toLowerCase()).not.toContain('augment');
    expect(text!.templateText(1, 0)!.startsWith('If you choose a CUSTOM CHARACTER')).toBe(true);
    expect(text!.templateText(2, 7)!.startsWith('WARRIORS')).toBe(true);
    expect(text!.sexText(2, 2)!.startsWith("There are three ways Gharu'ndim women's names")).toBe(true);
    expect(text!.heritageText(4)).toBeNull();
  });

  it('GameUI on the 1999 world portal: three heritage rows, the 1999 lore, the 18 start areas', async () => {
    const H = await mountGameUI();
    try {
      const ui = new H.mod.GameUI(H.container, {}, world) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
      ui.getTexURL = () => null;
      ui.paintChargenShadeDisk = () => {};
      ui.renderChargenPreview = () => {};
      ui.renderChargenSummaryView = () => {};
      ui.accountHasThroneOfDestiny = false;
      openChargen(ui);
      ui.wizard.heritage = 1;
      const host = H.win.document.createElement('div');
      host.innerHTML = ui.renderRaceStep();
      expect(host.querySelectorAll('.heritage-btn')).toHaveLength(3);
      const runs = parseTextRuns(host.querySelector('.heritage-lore [data-ac-runs]')!.getAttribute('data-ac-runs')!)!;
      expect(runs).toHaveLength(1);
      expect(runs[0].text.startsWith('ALUVIANS')).toBe(true);
      host.innerHTML = ui.renderMapStep();
      expect(host.querySelectorAll('.start-area-row')).toHaveLength(18);
      expect(ui.chargenRollDeps().starterAreaCount).toBe(18);
      expect(ui.chargenRollDeps().heritageGroup(1).attributeCredits).toBe(330);
      expect(ui.chargenRollDeps().heritageGroup(1).skillCredits).toBe(50);
    } finally {
      H.teardown();
    }
  });
});

describe.skipIf(!existsSync(DAT_PATHS.portal))('end of retail is untouched', () => {
  let eol: DatDatabase;
  beforeAll(() => { eol = openDat(DAT_PATHS.portal); });
  it('loadChargen1999 is null for a ToD portal (every other era keeps its pages)', () => {
    expect(loadChargen1999(eol)).toBeNull();
    expect(loadChargen1999(null)).toBeNull();
  });
});
