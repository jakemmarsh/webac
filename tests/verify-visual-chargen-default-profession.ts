/**
 * VISUAL.chargen-default-profession — a fresh chargen opens on
 * CharGenState::RandomizeCharacter, as the gmCharGenMainUI ctor @ 004e7eb0
 * runs it (`RandomizeCharacter(GetCharGenState(), AccountHasThroneOfDestiny)`
 * before the pages' InitializePage). The retail A/B (2026-10-02) caught
 * retail on War Mage with 0 attribute credits while ours opened on Custom
 * with all 10s and 270 credits; War Mage was that run's roll, not a fixed
 * default (CharGenState::Reset leaves template_ −1 and no code stores 4).
 *
 * Drives the real GameUI (happy-dom) against the EoL CharacterGenerator +
 * SkillTable: the template the roll picks is applied (its attributes, so
 * the credits are spent, its normal skills Trained and primary skills
 * Specialized) and its profession row is the lit one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { SkillAdvancementClass } from '@ac/shared';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import { scriptedRandomSource, seededRandomSource, RETAIL_RAND_MAX } from '../packages/renderer/src/ui/ChargenRandomize.js';
import { CUSTOM_TEMPLATE, TEMPLATE_PROFESSION_ROW } from '../packages/renderer/src/ui/ChargenTemplates.js';
import { CHARGEN_ROW_STATE_SELECTED } from '../packages/renderer/src/ui/DatTextStyle.js';
import { CreateStep } from '../packages/renderer/src/ui/CharacterCreate.js';

const hasPortal = existsSync(DAT_PATHS.portal);

/** A rand() value whose RandInt(n) draw is `k` (floor(v·n / 32768) = k). */
const randFor = (k: number, n: number): number => Math.ceil((k * (RETAIL_RAND_MAX + 1)) / n);

describe.skipIf(!hasPortal)('VISUAL.chargen-default-profession — the chargen opens on RandomizeCharacter', () => {
  let H: GameUIFixture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let charGen: any; let skillTable: any;

  beforeAll(async () => {
    H = await mountGameUI({ size: { innerWidth: 1568, innerHeight: 775 } });
    const dat = await import('@ac/dat-parser');
    const { CharacterGenerator } = await import('../packages/dat-parser/src/file-types/CharacterGenerator.js');
    const portal = openDat(DAT_PATHS.portal);
    charGen = new CharacterGenerator(new dat.DatReader(portal.getFileData(0x0e000002)!));
    skillTable = new dat.SkillTable(new dat.DatReader(portal.getFileData(0x0e000004)!));
  });
  afterAll(() => H?.teardown());

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function open(src: ReturnType<typeof scriptedRandomSource> | ReturnType<typeof seededRandomSource>): any {
    const ui = H.ui;
    ui.getTexURL = (id: number) => `tex:${id.toString(16)}`;
    ui.skillTable = skillTable;
    ui.charGen = charGen;
    ui.paintChargenShadeDisk = () => {};
    ui.renderChargenPreview = () => {};
    ui.renderChargenSummaryView = () => {};
    ui.chargenRandomSource = src;
    ui.showCharacterCreate();
    return ui;
  }

  it('the rolled template is applied: War Mage (template_ 4) for Aluvian gives its attributes, 0 credits, its skills, and its lit row', () => {
    const aluvian = charGen.heritageGroups.get(1);
    const templates = aluvian.templates;
    const warMage = templates[4];
    expect(warMage.name).toBe('War Mage');
    // RollDice(1, 4) → 1 Aluvian, RollDice(1, 2) → 1; every rand() draw the
    // same value, chosen so RandInt(count − 1, −1) = 3 → template_ 4.
    const ui = open(scriptedRandomSource([randFor(3, templates.length - 1)], [0]));
    const w = ui.wizard;
    expect(w.heritage).toBe(1);
    expect(w.gender).toBe(1);
    expect(w.templateIndex).toBe(4);
    expect(w.attributes).toEqual({
      strength: warMage.strength, endurance: warMage.endurance, coordination: warMage.coordination,
      quickness: warMage.quickness, focus: warMage.focus, self: warMage.self,
    });
    // Retail's frame: Str 50 End 40 Coord 10 Quick 30 Focus 100 Self 100.
    expect([w.attributes.strength, w.attributes.endurance, w.attributes.coordination, w.attributes.quickness, w.attributes.focus, w.attributes.self])
      .toEqual([50, 40, 10, 30, 100, 100]);
    expect(w.attributeCredits).toBe(aluvian.attributeCredits);
    expect(w.attributesRemaining).toBe(0);
    for (const id of warMage.normalSkillsList) expect(w.skillLevel(id), `normal ${id}`).toBe(SkillAdvancementClass.Trained);
    for (const id of warMage.primarySkillsList) expect(w.skillLevel(id), `primary ${id}`).toBe(SkillAdvancementClass.Specialized);
    // The start area is rolled from the heritage's primary areas, never left unset.
    expect(aluvian.primaryStartAreas).toContain(w.startArea);

    // The Profession page lights the War Mage row (UpdateProfession: 4 → 0x100003dc).
    w.currentStep = CreateStep.Profession;
    ui.renderCharacterCreate();
    const lit = Array.from(H.container.querySelectorAll('.template-btn'))
      .filter((b) => (b as HTMLElement).dataset.acState === CHARGEN_ROW_STATE_SELECTED.toString(16))
      .map((b) => (b as HTMLElement).dataset.element);
    expect(lit).toEqual([`0x${TEMPLATE_PROFESSION_ROW[4].toString(16)}`]);
  });

  it('a fresh chargen never opens on Custom: every roll lands on a real profession with its credits spent', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const ui = open(seededRandomSource(seed));
      const w = ui.wizard;
      expect([1, 2, 3, 4], `seed ${seed} heritage`).toContain(w.heritage);
      expect([1, 2], `seed ${seed} gender`).toContain(w.gender);
      expect(w.templateIndex, `seed ${seed}`).not.toBe(CUSTOM_TEMPLATE);
      expect(w.templateIndex, `seed ${seed}`).toBeGreaterThan(0);
      expect(w.attributesRemaining, `seed ${seed}`).toBe(0);
    }
  });

  it('pinChargenRandom(seed) reproduces the same character on every open (capture tooling)', () => {
    const snap = (): string => {
      H.ui.pinChargenRandom(7);
      open(H.ui.chargenRandomSource);
      const w = H.ui.wizard;
      return JSON.stringify([w.heritage, w.gender, w.templateIndex, w.attributes, w.startArea, w.appearance]);
    };
    const a = snap();
    expect(snap()).toBe(a);
    H.ui.pinChargenRandom(8);
    open(H.ui.chargenRandomSource);
    // A different seed is a different roll somewhere (heritage, template, face, clothes or town).
    const w = H.ui.wizard;
    expect(JSON.stringify([w.heritage, w.gender, w.templateIndex, w.attributes, w.startArea, w.appearance])).not.toBe(a);
  });
});
