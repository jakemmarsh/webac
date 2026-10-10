/**
 * VISUAL.chargen-skills-list-rows — the chargen Skills page list rows as the
 * EoL client builds them (gmCGSkillsPage::DoSkillRecords @ 004817e0,
 * SetSkillText @ 00480600, IncreaseSkillLevel @ 00480ca0,
 * DecreaseSkillLevel @ 00480d60; the row template 0x2100004c:0x100002ff).
 *
 * Retail A/B evidence (verification/retail-ab/chargen-skills/retail.png):
 * every row carries the 0x06004d3d icon, the name, the skill score, the up
 * cost, green up / down arrows and the down cost — e.g. specialized Mana
 * Conversion "43  0 ▲ ▼ 6", trained Arcane Lore "38  2 ▲ ▼ 0" (the down
 * arrow dim), trained Life Magic "55  8 ▲ ▼ 12" (lit). Ours drew '>' / '-'
 * markers, green names and "v0 ^2" text buttons.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { SkillAdvancementClass } from '@ac/shared';
import {
  chargenSkillRecord, chargenSkillRowView, chargenSkillIncreaseTarget, chargenSkillDecreaseTarget,
  SKILL_ARROW_DIM_STATE, SKILL_ARROW_LIT_STATE,
} from '../packages/renderer/src/ui/ChargenSkillRows.js';
import { findElementByPath, textStyleFromDesc } from '../packages/renderer/src/ui/DatTextStyle.js';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import { mountGameUI, openChargen, type GameUIFixture } from './_harness/gameui.js';

const hasDats = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.local);
const { Untrained, Trained, Specialized } = SkillAdvancementClass;

describe('DoSkillRecords — the record costs and flags', () => {
  it('a plain skill takes the SkillTable costs; both flags set when the costs are non-zero', () => {
    expect(chargenSkillRecord({ trainedCost: 12, specializedCost: 20 })).toEqual({ trainCost: 12, specCost: 20, untrainable: true, unspecializable: true });
  });
  it('a free SkillTable skill (trained cost 0) cannot be untrained', () => {
    expect(chargenSkillRecord({ trainedCost: 0, specializedCost: 12 })).toEqual({ trainCost: 0, specCost: 12, untrainable: false, unspecializable: true });
  });
  it('a heritage normalCost of 0 moves the trained cost out of the specialized one (Arcane Lore 4 / 6 → 0 / 2)', () => {
    expect(chargenSkillRecord({ trainedCost: 4, specializedCost: 6 }, { normalCost: 0, primaryCost: 2 }))
      .toEqual({ trainCost: 0, specCost: 2, untrainable: false, unspecializable: true });
  });
  it('a heritage primaryCost of 0 zeroes the specialized cost; non-zero heritage costs change nothing', () => {
    expect(chargenSkillRecord({ trainedCost: 4, specializedCost: 6 }, { normalCost: 0, primaryCost: 0 }))
      .toEqual({ trainCost: 0, specCost: 0, untrainable: false, unspecializable: false });
    expect(chargenSkillRecord({ trainedCost: 4, specializedCost: 6 }, { normalCost: 8, primaryCost: 16 }))
      .toEqual({ trainCost: 4, specCost: 6, untrainable: true, unspecializable: true });
  });
});

describe('SetSkillText — the cost texts and the arrow states', () => {
  const rec = { trainCost: 12, specCost: 20, untrainable: true, unspecializable: true };
  it('Untrained: up = train cost, down "0"; down dim; up lit only when the credits cover the train cost', () => {
    expect(chargenSkillRowView(rec, Untrained, 12)).toEqual({ upCostText: '12', downCostText: '0', upState: SKILL_ARROW_LIT_STATE, downState: SKILL_ARROW_DIM_STATE });
    expect(chargenSkillRowView(rec, Untrained, 11).upState).toBe(SKILL_ARROW_DIM_STATE);
  });
  it('Trained: up = spec − train, down = train cost; up lit on credits, down lit when untrainable', () => {
    expect(chargenSkillRowView(rec, Trained, 8)).toEqual({ upCostText: '8', downCostText: '12', upState: SKILL_ARROW_LIT_STATE, downState: SKILL_ARROW_LIT_STATE });
    expect(chargenSkillRowView(rec, Trained, 7).upState).toBe(SKILL_ARROW_DIM_STATE);
    expect(chargenSkillRowView({ ...rec, untrainable: false }, Trained, 99).downState).toBe(SKILL_ARROW_DIM_STATE);
  });
  it('Specialized: up "0" and dim, down = spec − train, lit when unspecializable', () => {
    expect(chargenSkillRowView(rec, Specialized, 99)).toEqual({ upCostText: '0', downCostText: '8', upState: SKILL_ARROW_DIM_STATE, downState: SKILL_ARROW_LIT_STATE });
    expect(chargenSkillRowView({ ...rec, unspecializable: false }, Specialized, 99).downState).toBe(SKILL_ARROW_DIM_STATE);
  });
  it('a cost of 999 or more draws as an empty up cost', () => {
    expect(chargenSkillRowView({ trainCost: 999, specCost: 999, untrainable: true, unspecializable: true }, Untrained, 50).upCostText).toBe('');
    expect(chargenSkillRowView({ trainCost: 4, specCost: 1003, untrainable: true, unspecializable: true }, Trained, 50).upCostText).toBe('');
  });
});

describe('IncreaseSkillLevel / DecreaseSkillLevel — one class step, gated by the record', () => {
  const rec = { trainCost: 12, specCost: 20, untrainable: true, unspecializable: true };
  it('up: Untrained → Trained on enough credits, Trained → Specialized on enough for the difference, Specialized stays', () => {
    expect(chargenSkillIncreaseTarget(rec, Untrained, 12)).toBe(Trained);
    expect(chargenSkillIncreaseTarget(rec, Untrained, 11)).toBeNull();
    expect(chargenSkillIncreaseTarget(rec, Trained, 8)).toBe(Specialized);
    expect(chargenSkillIncreaseTarget(rec, Trained, 7)).toBeNull();
    expect(chargenSkillIncreaseTarget(rec, Specialized, 99)).toBeNull();
  });
  it('down: Specialized → Trained when unspecializable, Trained → Untrained when untrainable, Untrained stays', () => {
    expect(chargenSkillDecreaseTarget(rec, Specialized)).toBe(Trained);
    expect(chargenSkillDecreaseTarget(rec, Trained)).toBe(Untrained);
    expect(chargenSkillDecreaseTarget(rec, Untrained)).toBeNull();
    expect(chargenSkillDecreaseTarget({ ...rec, unspecializable: false }, Specialized)).toBeNull();
    expect(chargenSkillDecreaseTarget({ ...rec, untrainable: false }, Trained)).toBeNull();
  });
});

describe.skipIf(!hasDats)('the DAT row template 0x2100004c:0x100002ff and header 0x100002f4', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let layout: any;
  beforeAll(async () => {
    const dat = await import('@ac/dat-parser');
    dat.setMasterPropertyTypes(dat.parseMasterProperty(openDat(DAT_PATHS.portal).getReader(0x39000001)));
    layout = dat.parseLayoutDesc(openDat(DAT_PATHS.local).getReader(0x2100004c));
  });
  const el = (...path: number[]) => findElementByPath(layout, path)!;

  it('the row: icon (0,0) 26x26 = 0x06004d3d; name (37) 200; level (255), up cost (325), down cost (403) 34 wide; arrows (346) / (373) 30x26', () => {
    expect([el(0x100002ff).width, el(0x100002ff).height]).toEqual([421, 26]);
    expect(el(0x100002ff, 0x10000300).media[0].file).toBe(0x06004d3d);
    const geo = (id: number) => { const e = el(0x100002ff, id); return [e.x, e.width]; };
    expect(geo(0x10000301)).toEqual([37, 200]);
    expect(geo(0x10000302)).toEqual([255, 34]);
    expect(geo(0x10000303)).toEqual([325, 34]);
    expect(geo(0x10000304)).toEqual([346, 30]);
    expect(geo(0x10000305)).toEqual([373, 30]);
    expect(geo(0x10000306)).toEqual([403, 34]);
  });

  it('the arrow media per state match GameUI.CHARGEN_SKILL_ARROW_MEDIA (0x1000001a dim, 0x1000001b lit)', async () => {
    const { GameUI } = await import('../packages/renderer/src/ui/GameUI.js');
    for (const [dir, id] of [['up', 0x10000304], ['down', 0x10000305]] as const) {
      const e = el(0x100002ff, id);
      for (const state of [SKILL_ARROW_DIM_STATE, SKILL_ARROW_LIT_STATE]) {
        expect(e.states.get(state)!.media[0].file, `${dir} ${state.toString(16)}`).toBe((GameUI.CHARGEN_SKILL_ARROW_MEDIA[dir] as Record<number, number>)[state]);
      }
    }
  });

  it('the row texts inherit 0x100002fe: font 0x40000008, grey 0xffa3a3a3 in the row state 1', () => {
    const name = el(0x100002ff, 0x10000301);
    expect([name.baseElement, name.baseLayout]).toEqual([0x100002fe, 0x2100004c]);
    const style = textStyleFromDesc(el(0x100002fe), 1);
    expect(style.font).toBe(0x40000008);
    expect(style.colorArgb >>> 0).toBe(0xffa3a3a3);
  });

  it('the header: the 0x06004d0b bar, the section name (0) 175 and the "Skill Level" column (225) 107', () => {
    expect(el(0x100002f4, 0x100002f5).media[0].file).toBe(0x06004d0b);
    expect([el(0x100002f4, 0x100002f6).x, el(0x100002f4, 0x100002f6).width]).toEqual([0, 175]);
    expect([el(0x100002f4, 0x100002f7).x, el(0x100002f4, 0x100002f7).width]).toEqual([225, 107]);
  });
});

describe.skipIf(!hasDats)('the Skills page renders the retail rows (happy-dom)', () => {
  let fx: GameUIFixture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let skillTable: any; let charGen: any; let layoutRenderer: any;

  beforeAll(async () => {
    fx = await mountGameUI();
    const dat = await import('@ac/dat-parser');
    const portal = openDat(DAT_PATHS.portal);
    const local = openDat(DAT_PATHS.local);
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
  const cellText = (r: HTMLElement, el: number) => r.querySelector(`[data-element="0x${el.toString(16)}"] [data-ac-text], [data-element="0x${el.toString(16)}"] canvas`)?.getAttribute('data-ac-text')
    ?? r.querySelector(`[data-element="0x${el.toString(16)}"]`)?.textContent?.trim() ?? '';
  const arrow = (r: HTMLElement, dir: 'up' | 'down') => r.querySelector(`.skill-arrow[data-dir="${dir}"]`) as HTMLElement;

  it('all four section headers, each with the 0x06004d0b bar and the "Skill Level" column, even when a section is empty', () => {
    const { container } = openSkills();
    const headers = Array.from(container.querySelectorAll('.chargen-skill-section-row')) as HTMLElement[];
    expect(headers.map((h) => (h.querySelector('.chargen-skill-section') as HTMLElement).dataset.section))
      .toEqual(['specialized', 'trained', 'useableUntrained', 'unuseableUntrained']);
    for (const h of headers) {
      expect(h.style.backgroundImage).toContain('tex:6004d0b');
      // Both texts sit p35 = 7 in from their boxes (the retail A/B showed ours 7 px left).
      expect((h.querySelector('.chargen-skill-section') as HTMLElement).style.paddingLeft).toBe('7px');
      expect((h.querySelector('.chargen-skill-level-heading') as HTMLElement).style.paddingLeft).toBe('7px');
    }
  });

  it('every row: the 0x06004d3d icon, the arrows as DAT images (no text buttons), no ">" / "-" markers', () => {
    const { container } = openSkills();
    const rows = Array.from(container.querySelectorAll('.chargen-skill-row')) as HTMLElement[];
    expect(rows.length).toBeGreaterThan(20);
    for (const r of rows) {
      expect((r.querySelector('[data-element="0x10000300"]') as HTMLElement).style.backgroundImage).toContain('tex:6004d3d');
      expect(r.querySelectorAll('.skill-arrow')).toHaveLength(2);
      expect(r.querySelector('button')).toBeNull();
    }
    expect(container.innerHTML).not.toMatch(/data-ac-text="[>*-]"/);
  });

  it('the Aluvian Custom character: Arcane Lore trained free (up 2, down 0 dim), and the arrows step a skill through the classes', () => {
    const { ui, container } = openSkills();
    const arcane = row(container, skillId('Arcane Lore'));
    expect(arcane.closest('.chargen-skill-listbox')).toBeTruthy();
    expect(arrow(arcane, 'down').dataset.state).toBe('0x1000001a');
    expect(arrow(arcane, 'down').style.backgroundImage).toContain('tex:6004d3e');
    // Click the dim down arrow: nothing (the heritage made it free).
    arrow(arcane, 'down').click();
    expect(ui.wizard.skillLevel(skillId('Arcane Lore'))).toBe(Trained);

    const life = skillId('Life Magic');
    expect(ui.wizard.skillLevel(life)).toBe(Untrained);
    const credits = ui.wizard.skillCreditsRemaining;
    const lifeRec = chargenSkillRecord(skillTable.skills.get(life));
    expect(arrow(row(container, life), 'up').dataset.state).toBe('0x1000001b');
    arrow(row(container, life), 'up').click();
    expect(ui.wizard.skillLevel(life)).toBe(Trained);
    expect(ui.wizard.skillCreditsRemaining).toBe(credits - lifeRec.trainCost);
    const lifeRow = row(container, life);
    expect(lifeRow.previousElementSibling && container.querySelector('[data-section="trained"]')).toBeTruthy();
    expect(arrow(lifeRow, 'down').dataset.state).toBe('0x1000001b');
    expect(arrow(lifeRow, 'down').style.backgroundImage).toContain('tex:6004d3f');
    arrow(lifeRow, 'down').click();
    expect(ui.wizard.skillLevel(life)).toBe(Untrained);
    expect(ui.wizard.skillCreditsRemaining).toBe(credits);
  });
});
