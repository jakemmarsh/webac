/**
 * webac#28 (AC1999, 2026-11-07): "Skills from preview builds showing up in skill panel" —
 * Arms And Armor Repair, Awareness, Sling and Spellcraft listed with no icon and 0.
 *
 * The AC1999 server stores a skill record for every slot of chargen's skill array
 * (CACQualities::SetSkillAdvancementClass, Inactive slots included), so its
 * PlayerDescription carries ids 8 / 17 / 25 / 26 that the 1999 SkillTable lacks. Our
 * census appended any record the table lacked. Both retail clients list exactly the
 * SkillTable: 1999 SkillListPanel::UpdateSkillsFromPlayerDesc @ 0x00547470 sizes its row
 * array by the table and walks the table's hash; end of retail gmSkillUI::RebuildSkillList
 * @ 0x0049c3a0 walks PackableHashTable<SkillBase> and asks InqSkill per key.
 *
 * Drives the real GameUI.syncFromPlayerState with each era's real SkillTable and a server
 * record for every id 0..max (what a GDLE-family server holds after chargen).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { openDat, DAT_PATHS, DAT_SETS_DIR } from './_harness/dat.js';
import { skillPanelCensusIds } from '../packages/renderer/src/ui/SkillDisplay.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame'] as const;

const AC1999_PORTAL = resolve(DAT_SETS_DIR, 'ac1999-retail/portal.dat');
const DM_PORTAL = resolve(DAT_SETS_DIR, 'classic-dereth-1.1/client_portal.dat');
const CUSTOMDM_PORTAL = resolve(DAT_SETS_DIR, 'classicace-customdm-1.60/client_portal.dat');

describe('skillPanelCensusIds (webac#28)', () => {
  it('lists the table only; a record the table lacks is dropped', () => {
    const table = new Map<number, unknown>([[6, {}], [21, {}]]);
    expect(skillPanelCensusIds(table, [6, 8, 17, 21, 25, 26])).toEqual([6, 21]);
  });
  it('a table skill with no record is still listed', () => {
    expect(skillPanelCensusIds(new Map([[6, {}], [21, {}]]), [])).toEqual([6, 21]);
  });
  it('with no table loaded, the server records are the list', () => {
    expect(skillPanelCensusIds(null, [6, 8])).toEqual([6, 8]);
  });
});

describe('webac#28 — the character panel lists exactly the era SkillTable (real DATs)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any; let SkillSystem: any; let AttributeSystem: any; let SkillTable: any; let DatReader: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    SkillSystem = (await import('../packages/shared/src/character/SkillSystem.js')).SkillSystem;
    AttributeSystem = (await import('../packages/shared/src/character/AttributeSystem.js')).AttributeSystem;
    SkillTable = (await import('../packages/dat-parser/src/file-types/SkillTable.js')).SkillTable;
    DatReader = (await import('../packages/dat-parser/src/DatReader.js')).DatReader;
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  /** The panel's listed ids/names after a PlayerDescription with a record for every id 0..maxId (Untrained). */
  const panelFor = (portalPath: string, maxId: number): { ids: number[]; names: string[]; tableIds: number[] } => {
    const table = new SkillTable(new DatReader(openDat(portalPath).getFileData(0x0e000004)!));
    ui.skillTable = table;
    const records = new Map<number, number>();
    for (let id = 0; id <= maxId; id++) records.set(id, 1);
    ui.syncFromPlayerState({
      name: 'Census', heritage: 1, gender: 1, level: 1, totalBurden: 0,
      xp: { totalXp: 0n, availableXp: 0n, availableSkillCredits: 0 },
      health: { current: 10, max: 10 }, stamina: { current: 10, max: 10 }, mana: { current: 10, max: 10 },
      attributes: new AttributeSystem({ strength: 10, endurance: 10, coordination: 10, quickness: 10, focus: 10, self: 10 }),
      skills: new SkillSystem(records),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const listed = ui.charInfo.skills as any[];
    return {
      ids: listed.map((s) => s.id).sort((a, b) => a - b),
      names: listed.map((s) => s.name),
      tableIds: [...table.skills.keys()].sort((a: number, b: number) => a - b),
    };
  };

  it.skipIf(!existsSync(AC1999_PORTAL))('AC1999: the 35 table skills; Sling, Spellcraft, Awareness, Arms and Armor Repair never', () => {
    const p = panelFor(AC1999_PORTAL, 39); // the AC1999 server's chargen slots 0..39
    expect(p.ids).toEqual(p.tableIds);
    expect(p.ids.length).toBe(35);
    for (const id of [0, 8, 17, 25, 26]) expect(p.ids).not.toContain(id);
    for (const n of ['Sling', 'Spellcraft', 'Awareness', 'Arms And Armor Repair', 'Arms and Armor Repair']) expect(p.names).not.toContain(n);
    // the reporter's visible neighbours stay
    for (const n of ['Cooking', 'Fletching', 'Healing', 'Lockpick']) expect(p.names).toContain(n);
    // and the panel the player sees renders none of them
    const list = domWindow.document.createElement('div');
    ui.renderSkillsTab(list);
    expect(list.textContent).not.toMatch(/Sling|Spellcraft|Awareness|Armor Repair/);
    expect(list.textContent).toContain('Cooking');
  });

  it.skipIf(!existsSync(DM_PORTAL))('Dark Majesty (Classic Dereth 1.1): the 36 table skills; the same four retired ids never', () => {
    const p = panelFor(DM_PORTAL, 40);
    expect(p.ids).toEqual(p.tableIds);
    expect(p.ids.length).toBe(36);
    for (const id of [0, 8, 17, 25, 26]) expect(p.ids).not.toContain(id);
    expect(p.names).toContain('Salvaging');
  });

  it.skipIf(!existsSync(CUSTOMDM_PORTAL))('ClassicACE CustomDM: its own table lists Awareness, so Awareness stays', () => {
    const p = panelFor(CUSTOMDM_PORTAL, 57);
    expect(p.ids).toEqual(p.tableIds);
    expect(p.names).toContain('Awareness');
    expect(p.ids).not.toContain(8);
  });

  it.skipIf(!existsSync(DAT_PATHS.portal))('end of retail: the 38 table skills; the retired weapon skills never', () => {
    const p = panelFor(DAT_PATHS.portal, 54);
    expect(p.ids).toEqual(p.tableIds);
    expect(p.ids.length).toBe(38);
    for (const id of [1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 17, 25, 26, 42, 53]) expect(p.ids).not.toContain(id);
    for (const n of ['Heavy Weapons', 'Summoning', 'Void Magic', 'Salvaging']) expect(p.names).toContain(n);
  });
});
