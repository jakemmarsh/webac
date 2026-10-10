/**
 * VISUAL.chargen-skills-list-rows.a — selecting a chargen Skills page row.
 *
 * gmCGSkillsPage::ListenToElementMessage @ 004814c0: a listbox 0x100003f7
 * selection runs ShowSkillsText @ 00481250 on the selected item; an arrow
 * click runs Increase/DecreaseSkillLevel and then SetSelectedItem's its row.
 * ShowSkillsText fills the title 0x100003fb with the name + " (%d)\n"
 * (GetSkillScore) and the text 0x100003fc with the description, "\n", the
 * training / specialization bonus line and MakeSkillFormula @ 00480e10's
 * line (format strings read from the exe's .rdata); a header (no skill id)
 * clears both. The selected row's texts draw in 0x100002fe state 6 (white).
 * gmCharGenMainUI::SetProgressState runs gmCGSkillsPage::Update on every
 * entry to the page, whose DoSkillRecords Flushes the listbox (the
 * selection goes, the box keeps its text).
 */
import { collapseDatSpaceRuns } from '../packages/renderer/src/ui/GameUI.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { SkillAdvancementClass } from '@ac/shared';
import {
  chargenSkillFormulaText, chargenSkillInfoText, CHARGEN_SKILL_ROW_SELECTED_STATE,
} from '../packages/renderer/src/ui/ChargenSkillRows.js';
import { textStyleFromDesc, findElementByPath } from '../packages/renderer/src/ui/DatTextStyle.js';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import { mountGameUI, openChargen, type GameUIFixture } from './_harness/gameui.js';

const hasDats = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.local);
const { Untrained, Trained, Specialized } = SkillAdvancementClass;
const f = (w: number, x: number, y: number, z: number, attr1: number, attr2: number) => ({ w, x, y, z, attr1, attr2 });

describe('MakeSkillFormula — the formula line', () => {
  it('two attributes are joined by " + " in parentheses, then the divisor', () => {
    expect(chargenSkillFormulaText(f(0, 1, 1, 3, 3, 4))).toBe('Formula : (Quickness + Coordination) / 3');
    expect(chargenSkillFormulaText(f(0, 1, 1, 7, 6, 5))).toBe('Formula : (Self + Focus) / 7');
  });
  it('one attribute stands alone; a divisor of 1 is not written', () => {
    expect(chargenSkillFormulaText(f(0, 1, 0, 3, 5, 0))).toBe('Formula : Focus / 3');
    expect(chargenSkillFormulaText(f(0, 1, 0, 1, 3, 0))).toBe('Formula : Quickness');
  });
  it('a zero multiplier drops its term (Leadership: x 0 → the bare prefix)', () => {
    expect(chargenSkillFormulaText(f(0, 0, 0, 1, 2, 0))).toBe('Formula : ');
  });
  it('a multiplier of 2 or more is "(%u x %s)"; an additive term is " +%u"', () => {
    expect(chargenSkillFormulaText(f(0, 2, 1, 3, 1, 4))).toBe('Formula : ((2 x Strength) + Coordination) / 3');
    expect(chargenSkillFormulaText(f(5, 1, 0, 1, 6, 0))).toBe('Formula : Self +5');
  });
});

describe('ShowSkillsText — the description box', () => {
  const skill = { name: 'Melee Defense', description: 'Helps you evade melee attacks.', formula: f(0, 1, 1, 3, 3, 4) };
  it('title = name (score) with a trailing newline; untrained text has no bonus line', () => {
    expect(chargenSkillInfoText(skill, 33, Untrained)).toEqual({
      title: 'Melee Defense (33)\n',
      text: 'Helps you evade melee attacks.\nFormula : (Quickness + Coordination) / 3\n',
    });
  });
  it('trained adds "Training Bonus  +5"; specialized "Specialization Bonus  +10" (two spaces, as in the exe)', () => {
    expect(chargenSkillInfoText(skill, 38, Trained).text).toBe('Helps you evade melee attacks.\nTraining Bonus  +5\nFormula : (Quickness + Coordination) / 3\n');
    expect(chargenSkillInfoText(skill, 43, Specialized).text).toBe('Helps you evade melee attacks.\nSpecialization Bonus  +10\nFormula : (Quickness + Coordination) / 3\n');
  });
});

describe.skipIf(!hasDats)('selecting rows on the Skills page (happy-dom)', () => {
  let fx: GameUIFixture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let skillTable: any; let charGen: any; let layoutRenderer: any; let local: any;

  beforeAll(async () => {
    fx = await mountGameUI();
    const dat = await import('@ac/dat-parser');
    const portal = openDat(DAT_PATHS.portal);
    local = openDat(DAT_PATHS.local);
    dat.setMasterPropertyTypes(dat.parseMasterProperty(portal.getReader(0x39000001)));
    dat.registerStringTable(dat.parseStringTable(local.getReader(0x23000001)));
    dat.registerStringTable(dat.parseStringTable(local.getReader(0x23000002)));
    skillTable = new dat.SkillTable(portal.getReader(0x0e000004));
    const { CharacterGenerator } = await import('../packages/dat-parser/src/file-types/CharacterGenerator.js');
    charGen = new CharacterGenerator(portal.getReader(0x0e000002));
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const tex = { getTextureDataURL: (id: number) => `data:tex-${id.toString(16)}`, getTextureDataURLWithAlpha: (id: number) => `data:tex-${id.toString(16)}` };
    layoutRenderer = new LayoutRenderer(local, tex as never, null);
  });
  afterAll(() => fx?.teardown());

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function openSkills(): { ui: any; container: HTMLElement } {
    const { ui, container } = fx;
    ui.getTexURL = (id: number) => `tex:${id.toString(16)}`;
    ui.layoutRenderer = layoutRenderer;
    ui.skillTable = skillTable;
    ui.charGen = charGen;
    ui.paintChargenShadeDisk = () => {};
    ui.renderChargenPreview = () => {};
    ui.renderChargenSummaryView = () => {};
    openChargen(ui);
    ui.wizard.currentStep = 2;
    ui.renderCharacterCreate();
    return { ui, container };
  }
  const skillId = (name: string): number => [...skillTable.skills].find(([, s]) => s.name === name)![0];
  const row = (c: HTMLElement, id: number) => c.querySelector(`.chargen-skill-row[data-skill="${id}"]`) as HTMLElement;
  const textOf = (c: HTMLElement, cls: string): string | null => {
    const box = c.querySelector(`.${cls}`);
    if (!box) return null;
    const el = box.querySelector('[data-ac-text]') ?? box.querySelector('[data-ac-desc]');
    return el?.getAttribute('data-ac-text') ?? el?.textContent ?? '';
  };
  const statesIn = (r: HTMLElement): string[] => Array.from(r.querySelectorAll('.chargen-skill-cell [data-ac-state]')).map((e) => (e as HTMLElement).dataset.acState!);

  it('the box starts empty and no row is selected', () => {
    const { container } = openSkills();
    expect(container.querySelector('.chargen-skill-info-title')).toBeNull();
    expect(container.querySelector('.chargen-skill-row[data-selected]')).toBeNull();
  });

  it('clicking a row selects it (texts in state 6, the others in 1) and fills the box with name (score), description and formula', () => {
    const { ui, container } = openSkills();
    const md = skillId('Melee Defense');
    row(container, md).querySelector('.chargen-skill-cell')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const r = row(container, md);
    expect(r.dataset.selected).toBe('1');
    expect(new Set(statesIn(r))).toEqual(new Set([CHARGEN_SKILL_ROW_SELECTED_STATE.toString(16)]));
    expect(container.querySelectorAll('.chargen-skill-row[data-selected]')).toHaveLength(1);
    expect(new Set(statesIn(row(container, skillId('Run'))))).toEqual(new Set(['1']));
    const skill = skillTable.skills.get(md);
    const level = ui.wizard.skillLevel(md);
    expect(textOf(container, 'chargen-skill-info-title')).toMatch(/^Melee Defense \(\d+\)\n$/);
    expect(textOf(container, 'chargen-skill-info-text')).toBe(chargenSkillInfoText(skill, Number(textOf(container, 'chargen-skill-info-title')!.match(/\((\d+)\)/)![1]), level).text);
    expect(textOf(container, 'chargen-skill-info-text')).toContain('Formula : (Quickness + Coordination) / 3');
  });

  it('the title score is the row\'s Skill Level value', () => {
    const { container } = openSkills();
    const run = skillId('Run');
    row(container, run).click();
    const cell = row(container, run).querySelector('[data-element="0x10000302"]')!;
    const level = cell.querySelector('[data-ac-text]')?.getAttribute('data-ac-text') ?? cell.textContent!.trim();
    expect(level).toMatch(/^\d+$/);
    expect(textOf(container, 'chargen-skill-info-title')).toBe(`Run (${level})\n`);
  });

  it('an arrow click steps the skill AND selects its row; the box shows the new bonus line', () => {
    const { ui, container } = openSkills();
    const life = skillId('Life Magic');
    expect(ui.wizard.skillLevel(life)).toBe(Untrained);
    (row(container, life).querySelector('.skill-arrow[data-dir="up"]') as HTMLElement).click();
    expect(ui.wizard.skillLevel(life)).toBe(Trained);
    expect(row(container, life).dataset.selected).toBe('1');
    expect(textOf(container, 'chargen-skill-info-text')).toContain('Training Bonus +5\n'); // drawn with the space run collapsed
    // Down again: back to untrained, still selected, the bonus line gone.
    (row(container, life).querySelector('.skill-arrow[data-dir="down"]') as HTMLElement).click();
    expect(ui.wizard.skillLevel(life)).toBe(Untrained);
    expect(row(container, life).dataset.selected).toBe('1');
    expect(textOf(container, 'chargen-skill-info-text')).not.toContain('Bonus');
  });

  it('a dim arrow changes nothing but still selects the row', () => {
    const { ui, container } = openSkills();
    const arcane = skillId('Arcane Lore');
    const before = ui.wizard.skillLevel(arcane);
    (row(container, arcane).querySelector('.skill-arrow[data-dir="down"]') as HTMLElement).click();
    expect(ui.wizard.skillLevel(arcane)).toBe(before);
    expect(row(container, arcane).dataset.selected).toBe('1');
    expect(textOf(container, 'chargen-skill-info-title')).toMatch(/^Arcane Lore \(/);
  });

  it('selecting a section header clears the selection and the box', () => {
    const { container } = openSkills();
    row(container, skillId('Run')).click();
    expect(container.querySelector('.chargen-skill-info-title')).not.toBeNull();
    (container.querySelector('.chargen-skill-section-row') as HTMLElement).click();
    expect(container.querySelector('.chargen-skill-row[data-selected]')).toBeNull();
    expect(container.querySelector('.chargen-skill-info-title')).toBeNull();
  });

  it('leaving and re-entering the page drops the selection but keeps the box text (Update → Flush)', () => {
    const { ui, container } = openSkills();
    row(container, skillId('Run')).click();
    ui.wizard.currentStep = 3;
    ui.renderCharacterCreate();
    ui.wizard.currentStep = 2;
    ui.renderCharacterCreate();
    expect(container.querySelector('.chargen-skill-row[data-selected]')).toBeNull();
    expect(textOf(container, 'chargen-skill-info-title')).toMatch(/^Run \(/);
  });

  it('a new character starts with an empty box', () => {
    const { ui, container } = openSkills();
    row(container, skillId('Run')).click();
    openSkills();
    expect(ui.chargenSkillSelection.info).toBeNull();
    expect(container.querySelector('.chargen-skill-info-title')).toBeNull();
  });

  it('the box texts sit at the DAT rects (0x100003fb (15,435), 0x100003fc (15,460), page y − 55) with 4 / 5 margins', () => {
    const { container } = openSkills();
    row(container, skillId('Run')).click();
    const title = container.querySelector('.chargen-skill-info-title') as HTMLElement;
    const text = container.querySelector('.chargen-skill-info-text') as HTMLElement;
    expect([title.style.left, title.style.top, title.style.width, title.style.height]).toEqual(['15px', '380px', '421px', '100px']);
    expect([text.style.left, text.style.top]).toEqual(['15px', '405px']);
    const inner = title.firstElementChild as HTMLElement;
    expect([inner.style.paddingLeft, inner.style.paddingRight, inner.style.paddingTop, inner.style.paddingBottom]).toEqual(['4px', '4px', '5px', '5px']);
    const layout = layoutRenderer.getResolvedLayout(0x21000048);
    for (const [id, x, y] of [[0x100003fb, 15, 435], [0x100003fc, 15, 460]] as const) {
      const desc = findElementByPath(layout, [id])!;
      expect([desc.x, desc.y, desc.width, desc.height]).toEqual([x, y, 421, 100]);
    }
  });

  it('the selected state is 0x100002fe state 6 (white) — the row state 1 is grey', () => {
    const tmpl = layoutRenderer.getResolvedLayout(0x2100004c);
    const desc = findElementByPath(tmpl, [0x100002fe])!;
    expect(textStyleFromDesc(desc, CHARGEN_SKILL_ROW_SELECTED_STATE)!.colorArgb >>> 0).toBe(0xffffffff);
    expect(textStyleFromDesc(desc, 1)!.colorArgb >>> 0).toBe(0xffa3a3a3);
  });
});
