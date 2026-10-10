/**
 * AGENT.chargen-choices — GameUI.agentChooseCharacter picks a new
 * character's heritage, gender, profession and starting town by the
 * chargen's own names through the handlers its controls run (real
 * CharacterGenerator 0x0E000002 + string tables; happy-dom).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import { mountGameUI, openChargen, type GameUIFixture } from './_harness/gameui.js';

const hasDats = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.local);

describe.skipIf(!hasDats)('agentChooseCharacter (happy-dom + DATs)', () => {
  let fx: GameUIFixture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let charGen: any; let skillTable: any;
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
  });
  afterAll(() => fx?.teardown());

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function open(): any {
    const { ui } = fx;
    ui.getTexURL = (id: number) => `tex:${id.toString(16)}`;
    ui.skillTable = skillTable;
    ui.charGen = charGen;
    ui.paintChargenShadeDisk = () => {};
    ui.renderChargenPreview = () => {};
    ui.renderChargenSummaryView = () => {};
    openChargen(ui, { custom: false });
    return ui;
  }

  it('sets heritage, gender, profession and town by name, as the controls would', () => {
    const ui = open();
    expect(ui.agentChooseCharacter({ heritage: 'sho', gender: 'female', template: 'War Mage', town: 'Shoushi' })).toBeNull();
    expect(ui.wizard.heritage).toBe(3);
    expect(ui.wizard.gender).toBe(2);
    expect(charGen.starterAreas[ui.wizard.startArea].name).toBe('Shoushi');
    expect(ui.wizard.attributes.focus).toBeGreaterThanOrEqual(ui.wizard.attributes.strength); // the War Mage template, fitted
    expect(ui.wizard.templateIndex).toBeGreaterThan(0);
  });

  it('builds a custom tinkerer: attributes in order (each kept once set) and skills by name', () => {
    const ui = open();
    const credits = ui.wizard.attributeCredits;
    const want = { coordination: 100, focus: 100, self: 100, strength: 10, endurance: 10 };
    expect(ui.agentChooseCharacter({ heritage: 'Aluvian', attributes: want })).toBeNull();
    for (const [k, v] of Object.entries(want)) expect(ui.wizard.attributes[k]).toBe(v);
    expect(Object.values(ui.wizard.attributes as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(credits); // quickness took the rest
    expect(Object.values(ui.wizard.attributeLocks).some(Boolean)).toBe(false); // the page's locks are cleared after
    // The DAT's SkillTable prices specializing a tinkering skill at 1003 credits: trained only at creation.
    const skills = { 'Weapon Tinkering': 'trained', 'armor tinkering': 'trained', 'Item Tinkering': 'trained', 'Magic Item Tinkering': 'trained' };
    expect(ui.agentChooseCharacter({ skills })).toBeNull();
    const id = (n: string) => [...skillTable.skills.entries()].find(([, sk]: [number, { name: string }]) => sk.name === n)![0];
    for (const n of ['Weapon Tinkering', 'Armor Tinkering', 'Item Tinkering', 'Magic Item Tinkering']) expect(ui.wizard.skillLevel(id(n))).toBe(2);
    // The list is the whole build: the rolled profession's paid skills went back.
    const paid = [...skillTable.skills.keys()].filter((k: number) => ui.wizard.skillLevel(k) >= 2 && ui.chargenSkillCosts().trainedCost(k) >= 1); // heritage-aware: a heritage's free skills stay
    expect(paid.sort()).toEqual(['Weapon Tinkering', 'Armor Tinkering', 'Item Tinkering', 'Magic Item Tinkering'].map(id).sort());
    expect(ui.agentChooseCharacter({ skills: { 'Weapon Tinkering': 'specialized' } })).toMatch(/^can't make Weapon Tinkering specialized/);
    expect(ui.wizard.skillCreditsRemaining).toBeGreaterThanOrEqual(0);
  });

  it('says what does not fit: attributes past the points, unknown skills, too few credits', () => {
    const ui = open();
    const r = ui.agentChooseCharacter({ attributes: { strength: 100, endurance: 100, coordination: 100, quickness: 100 } });
    expect(r).toMatch(/^attributes don't fit the \d+ points: quickness 100 \(got \d+\)/);
    expect(ui.agentChooseCharacter({ attributes: { charisma: 50 } as never })).toMatch(/^no attribute charisma/);
    expect(ui.agentChooseCharacter({ skills: { Basketweaving: 'trained' } })).toBe('no skill "Basketweaving"');
    expect(ui.agentChooseCharacter({ skills: { 'War Magic': 'mastered' } })).toMatch(/must be specialized, trained or untrained/);
    const every = Object.fromEntries([...skillTable.skills.values()].map((sk: { name: string }) => [sk.name, 'specialized']));
    expect(ui.agentChooseCharacter({ skills: every })).toMatch(/^can't make .* specialized \(\d+ skill credits left/);
  });

  it('names what exists when a choice does not', () => {
    const ui = open();
    expect(ui.agentChooseCharacter({ heritage: 'Elf' })).toMatch(/^no heritage "Elf" \(have: Aluvian, Gharu'ndim, Sho, Viamontian/);
    expect(ui.agentChooseCharacter({ town: 'Atlantis' })).toMatch(/^no starting town "Atlantis" \(have: .*Holtburg/);
    expect(ui.agentChooseCharacter({ gender: 'robot' })).toBe('gender must be male or female');
    expect(ui.agentChooseCharacter({ template: 'Astronaut' })).toMatch(/^no profession "Astronaut"/);
  });
});
