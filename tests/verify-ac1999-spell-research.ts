/**
 * AC1999.spell-research-panel — the 1999 client's Spell Research panel
 * ("Create Spell", CreateSpellPanel @ 0x5ab060 in the 1999 client.exe) and
 * its 0x4B ResearchSpell message.
 *
 *  - the wire: buildResearchSpellPayload through the 1999 adapter is exactly
 *    what the AC1999 server reads (ClientEvents.cpp case RESEARCH_SPELL_EVENT:
 *    SpellFormula::UnPack = 8 × u32, then ReadUInt32 target);
 *  - the panel model (SpellResearch1999.ts): the formula row, the component
 *    grid, the Test decision;
 *  - the server's answers through the real adapter + ServerMessageHandler:
 *    learn (0x4C → MagicUpdateSpell), fizzle (0x1C 0x402), the malformed
 *    refusal (0xF62C line + 0x1C 0x405), and the one 0x1C7 UseDone that
 *    releases the busy count the send raised;
 *  - era gating: only a 1999 world builds the tab (eraClientRules);
 *  - the GameUI page itself (renderResearchTab) with a stand-in layout
 *    renderer: grid click → formula row, Clear, Test → onResearchSpell;
 *  - with the real 1999 DATs: a level-I formula built in the panel is the
 *    formula the server resolves for that spell.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Adapter1999, emptyCodecs } from '../packages/network/src/era1999/Adapter1999.js';
import { codecs1999 } from '../packages/network/src/era1999/codecs/index.js';
import { registerCombat1999 } from '../packages/network/src/era1999/codecs/Combat1999.js';
import { Reader1999, Writer1999 } from '../packages/network/src/era1999/Wire1999.js';
import {
  buildResearchSpellPayload, deserializeMessage, parseResearchSpellPayload, serializeGameAction, SPELL_FORMULA_SLOTS,
} from '../packages/network/src/MessageSerializer.js';
import { GameActionType } from '../packages/network/src/GameActionType.js';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { BusyCount } from '../packages/renderer/src/ui/BusyCount.js';
import {
  ResearchFormula, researchGridCells, ownedComponentCounts, researchComponentSignature, testResearchFormula,
  RESEARCH_LAYOUT, RESEARCH_TAB_WIDTH, RESEARCH_TEXT,
} from '../packages/renderer/src/ui/SpellResearch1999.js';
import { CLIENT_NOTICES } from '../packages/renderer/src/ui/ClientNotices.js';
import { ERA_PROFILES, eraProfile } from '../packages/renderer/src/era/EraProfiles.js';
import { eraClientRules } from '../packages/renderer/src/era/EraFeatures.js';
import { SPELL_COMPONENT_WCIDS_1999 } from '../packages/dat-parser/src/era1999/Tables1999.js';
import { weenieErrorText } from '@ac/shared';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { mountGameUI } from './_harness/gameui.js';
import { openDat, DAT_PATHS } from './_harness/dat.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const u32s = (...v: number[]) => { const w = new Writer1999(); for (const x of v) w.u32(x); return w.toBytes(); };
/** scid → wcid, the 1999 client's SCIDtoWCID (Tables1999). */
const W = (scid: number) => SPELL_COMPONENT_WCIDS_1999[scid - 1];
const SCID_OF = new Map(SPELL_COMPONENT_WCIDS_1999.map((wcid, i) => [wcid, i + 1]));
const scidOf = (wcid: number) => SCID_OF.get(wcid);
// Flame Bolt I in the 1999 SpellTable: Lead Scarab, Hawthorn, Powdered Onyx, Turpeth, Birch Talisman.
const FLAME_BOLT_I = [1, 15, 34, 46, 55];
const TARGET = 0x80001234;

describe('0x4B ResearchSpell on the wire, against the AC1999 server reader', () => {
  it('packs a fixed 8 × u32 SpellFormula (zero-padded) then the target, 36 bytes', () => {
    const p = buildResearchSpellPayload(FLAME_BOLT_I, TARGET);
    expect(p.length).toBe(4 * (SPELL_FORMULA_SLOTS + 1));
    expect(hex(p)).toBe(hex(u32s(1, 15, 34, 46, 55, 0, 0, 0, TARGET)));
    expect(parseResearchSpellPayload(p)).toEqual({ components: [1, 15, 34, 46, 55, 0, 0, 0], targetGuid: TARGET });
    expect(() => buildResearchSpellPayload([1, 2, 3, 4, 5, 6, 7, 8, 9], TARGET)).toThrow();
  });

  it('the 1999 adapter sends it unchanged on the game-action group, read back the way ProcessEvent reads it', () => {
    const c = emptyCodecs();
    registerCombat1999(c, { player: () => ({ guid: 0x50000001, eventSequence: 0 }) });
    const logs: string[] = [];
    const a = new Adapter1999(c, { account: 'acjs', log: (m) => logs.push(m) });
    const comps = [1, 66, 15, 69, 34, 46, 70, 55];
    const out = a.outbound(serializeGameAction(7, GameActionType.ResearchSpell, buildResearchSpellPayload(comps, TARGET)));
    expect(logs).toEqual([]);
    expect(out).toHaveLength(1);
    expect(out![0].group).toBe(5);
    // 0xF7B1 [seq] [0x4B], SpellFormula::UnPack (8 × ReadDWORD), then targetId = ReadUInt32.
    const r = new Reader1999(out![0].message);
    expect([r.u32(), r.u32(), r.u32()]).toEqual([0xf7b1, 7, 0x4b]);
    expect(Array.from({ length: 8 }, () => r.u32())).toEqual(comps);
    expect(r.u32()).toBe(TARGET);
    expect(r.remaining).toBe(0);
  });

  it('every 1999 codec set knows it (no "no codec" drop)', () => {
    expect(codecs1999().outboundAction.has(GameActionType.ResearchSpell)).toBe(true);
  });
});

describe('the formula row (FormulaRow, vtable 0x613a60)', () => {
  it('appends in placement order, at most 8, never more of a component than owned', () => {
    const f = new ResearchFormula();
    expect(f.add(W(1), 1)).toBe('added');
    expect(f.add(W(1), 1)).toBe('not-enough');
    expect(f.add(W(15), 2)).toBe('added');
    expect(f.add(W(15), 2)).toBe('added');
    expect(f.wcids).toEqual([W(1), W(15), W(15)]);
    for (let i = 0; i < 5; i++) expect(f.add(W(20 + i), 1)).toBe('added');
    expect(f.count).toBe(8);
    expect(f.add(W(40), 5)).toBe('full');
  });

  it('a drop inserts at the slot under the pointer, clamped to the end; a picked-up slot moves or leaves', () => {
    const f = new ResearchFormula();
    f.add(W(1), 1); f.add(W(34), 1);
    f.add(W(15), 1, 1); // dropped on slot 1
    f.add(W(55), 1, 7); // past the end → appended
    expect(f.wcids).toEqual([W(1), W(15), W(34), W(55)]);
    f.move(3, 0);
    expect(f.wcids).toEqual([W(55), W(1), W(15), W(34)]);
    expect(f.removeAt(0)).toBe(W(55));
    expect(f.removeAt(9)).toBeUndefined();
    expect(f.wcids).toEqual([W(1), W(15), W(34)]);
  });

  it('builds the SpellFormula: WCIDtoSCID per slot in row order, zeros to 8; Clear empties it', () => {
    const f = new ResearchFormula();
    for (const scid of FLAME_BOLT_I) f.add(W(scid), 1);
    expect(f.components(scidOf)).toEqual([...FLAME_BOLT_I, 0, 0, 0]);
    f.clear();
    expect(f.count).toBe(0);
    expect(f.components(scidOf)).toEqual(new Array(8).fill(0));
  });

  it('follows the pack: uses past what the player still owns drop out, last first', () => {
    const f = new ResearchFormula();
    f.add(W(1), 2); f.add(W(15), 1); f.add(W(1), 2);
    expect(f.prune((w) => (w === W(1) ? 1 : 1))).toBe(true);
    expect(f.wcids).toEqual([W(1), W(15)]);
    expect(f.prune(() => 0)).toBe(true);
    expect(f.count).toBe(0);
    expect(f.prune(() => 0)).toBe(false);
  });
});

describe('the COMPONENTS grid (CreateSpellPanel_UpdateComponents @ 0x5ab980)', () => {
  const comp = (id: number, scid: number, name: string, stackSize = 1) => ({ id, name, weenieClassId: W(scid), itemType: 0x1000, stackSize });
  const CATEGORY: Record<number, number> = { 1: 0, 2: 0, 15: 1, 34: 2, 46: 3, 55: 4, 66: 5 };
  const items = [
    comp(1, 55, 'Birch Talisman'), comp(2, 1, 'Lead Scarab', 3), comp(3, 15, 'Hawthorn'), comp(4, 2, 'Iron Scarab'),
    comp(5, 66, 'Yellow Taper', 0), comp(6, 34, 'Powdered Onyx'), comp(7, 1, 'Lead Scarab', 2),
    { id: 8, name: 'Bread', weenieClassId: 1234, itemType: 0x20, stackSize: 1 },
  ];
  it('one icon per component name, the six 1999 categories in order, names sorted inside each', () => {
    const cells = researchGridCells(items, scidOf, (scid) => CATEGORY[scid]);
    expect(cells.map((c) => c.name)).toEqual(['Iron Scarab', 'Lead Scarab', 'Hawthorn', 'Powdered Onyx', 'Birch Talisman', 'Yellow Taper']);
    expect(cells.find((c) => c.name === 'Lead Scarab')!.numItems).toBe(5);
    expect(cells.find((c) => c.name === 'Yellow Taper')!.numItems).toBe(1); // a stack of 0 counts 1
  });
  it('a seventh category (end of retail\'s PEAS) never shows: the 1999 panel walks six lists', () => {
    expect(researchGridCells(items, scidOf, (scid) => (scid === 55 ? 6 : CATEGORY[scid])).map((c) => c.name)).not.toContain('Birch Talisman');
  });
  it('owned counts and the change signature follow kinds and counts only', () => {
    expect(ownedComponentCounts(items).get(W(1))).toBe(5);
    expect(ownedComponentCounts(items).has(1234)).toBe(false);
    const sig = researchComponentSignature(items);
    expect(researchComponentSignature([...items].reverse())).toBe(sig);
    expect(researchComponentSignature(items.slice(1))).not.toBe(sig);
  });
});

describe('Test (CreateSpellPanel_ListenToMessage @ 0x5ab710, sender testBut)', () => {
  const filled = () => { const f = new ResearchFormula(); for (const s of FLAME_BOLT_I) f.add(W(s), 1); return f; };
  it('out of magic mode: "You must first enter magic mode to test spell formulae", empty row or not', () => {
    expect(testResearchFormula({ formula: filled(), scidOf, inMagicMode: false, selectedId: TARGET })).toEqual({ kind: 'refuse', reason: 'magicMode' });
    expect(testResearchFormula({ formula: new ResearchFormula(), scidOf, inMagicMode: false, selectedId: 0 })).toEqual({ kind: 'refuse', reason: 'magicMode' });
    expect(CLIENT_NOTICES.researchNeedsMagicMode.text).toBe('You must first enter magic mode to test spell formulae');
  });
  it('in magic mode with an empty row the disabled button does nothing', () => {
    expect(testResearchFormula({ formula: new ResearchFormula(), scidOf, inMagicMode: true, selectedId: TARGET })).toEqual({ kind: 'nothing' });
  });
  it('nothing selected: "You must first select a target for the spell"', () => {
    expect(testResearchFormula({ formula: filled(), scidOf, inMagicMode: true, selectedId: 0 })).toEqual({ kind: 'refuse', reason: 'target' });
    expect(CLIENT_NOTICES.researchNoTarget.text).toBe('You must first select a target for the spell');
  });
  it('otherwise the row\'s SpellFormula and the selected object, and the row stays', () => {
    const f = filled();
    expect(testResearchFormula({ formula: f, scidOf, inMagicMode: true, selectedId: TARGET })).toEqual({ kind: 'send', components: [...FLAME_BOLT_I, 0, 0, 0], target: TARGET });
    expect(f.count).toBe(5);
  });
});

describe('the server\'s answers, through the real 1999 adapter and handlers', () => {
  const PLAYER = 0x50000001;
  function rig() {
    const a = new Adapter1999(codecs1999(), { account: 'acjs', log: () => {} });
    const got: Array<[string, unknown]> = [];
    const busy = new BusyCount(() => {});
    const h = new ServerMessageHandler();
    h.setHandlers({
      onMagicUpdateSpell: (d) => got.push(['learn', d]),
      onWeenieError: (d) => got.push(['error', d]),
      onServerMessage: (d) => got.push(['text', d]),
      onUseDone: (d) => { got.push(['useDone', d]); busy.decrement(); },
    });
    const feed = (m: Uint8Array) => { for (const e of a.inbound(m, 4)) h.handleMessage(deserializeMessage(e)); };
    /** QueueNetMessage with event=TRUE: 0xF7B0, player, sequence, then the message. */
    const wrapped = (seq: number, build: (w: Writer1999) => void) => { const w = new Writer1999().u32(0xf7b0).u32(PLAYER).u32(seq); build(w); return w.toBytes(); };
    busy.noteActionSent(GameActionType.ResearchSpell); // the research send's PanelUI_IncrementBusyCount
    return { got, busy, feed, wrapped };
  }

  it('a learn: the spell reaches the spellbook (0x4C → MagicUpdateSpell) and the UseDone clears the busy cursor', () => {
    const { got, busy, feed, wrapped } = rig();
    expect(busy.busy).toBe(true);
    feed(wrapped(1, (w) => w.u32(0x4c).u32(27)));
    feed(wrapped(2, (w) => w.u32(0x1c7).u32(0)));
    expect(got.map(([k]) => k)).toEqual(['learn', 'useDone']);
    expect(got[0][1]).toMatchObject({ spellId: 27 });
    expect(busy.busy).toBe(false);
  });

  it('a fizzle: NotifyUseDone(WERROR_MAGIC_FIZZLE) = 0x1C 0x402 ("Your spell fizzled.") then the 0x1C7', () => {
    const { got, busy, feed, wrapped } = rig();
    feed(u32s(0x1c, 0x402));
    feed(wrapped(1, (w) => w.u32(0x1c7).u32(0)));
    expect(got.map(([k]) => k)).toEqual(['error', 'useDone']);
    const code = (got[0][1] as { errorType?: number; error?: number }).errorType ?? (got[0][1] as { error?: number }).error;
    expect(code).toBe(0x402);
    expect(weenieErrorText(0x402)).toBe('Your spell fizzled.');
    expect(busy.busy).toBe(false);
  });

  it('a malformed formula: "That is not a valid spell formula." then 0x1C 0x405 and the 0x1C7', () => {
    const { got, busy, feed, wrapped } = rig();
    feed(new Writer1999().u32(0xf62c).acString('That is not a valid spell formula.').u32(0).toBytes());
    feed(u32s(0x1c, 0x405));
    feed(wrapped(1, (w) => w.u32(0x1c7).u32(0)));
    expect(got.map(([k]) => k)).toEqual(['text', 'error', 'useDone']);
    expect(got[0][1]).toMatchObject({ message: 'That is not a valid spell formula.' });
    expect(busy.busy).toBe(false);
  });
});

describe('era gating: only a 1999 world has the research tab', () => {
  it('end of retail and every classic (Dark Majesty) era: no research', () => {
    for (const p of Object.values(ERA_PROFILES)) {
      expect(eraClientRules(p).spellResearch, p.id).toBe(p.login.protocol === 'ac1999');
    }
    for (const id of ['eor', 'classicace-customdm', 'classicace-infiltration', 'classic-dereth']) expect(eraClientRules(eraProfile(id)).spellResearch).toBe(false);
    expect(eraClientRules(null).spellResearch).toBe(false);
  });
  it('AC1999 has it', () => {
    expect(eraClientRules(eraProfile('ac1999-retail')).spellResearch).toBe(true);
  });
  it('the 1999 geometry: three 92 px tabs and the ctor\'s rects', () => {
    expect(RESEARCH_TAB_WIDTH * 3 + 24).toBe(300); // three tabs + the 24 px close box span the panel
    expect(RESEARCH_LAYOUT.grid).toEqual({ x: 12, y: 85, w: 256, h: 192 }); // 8 x 6 cells of 32
    expect(RESEARCH_LAYOUT.formulaRow).toEqual({ x: 22, y: 25, w: 256, h: 32 }); // 8 slots of 32
  });
});

// ── The page itself (GameUI.renderResearchTab) ──────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('GameUI research page (renderResearchTab) with a stand-in layout renderer', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  let parent: HTMLElement;
  const clicks = new Map<string, () => void>();
  const sent: number[][] = [];

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const { GameUI } = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new GameUI(container);
    // The DAT pieces the page renders (button, caption) are stood in: a handle
    // whose onClick is recorded per host.
    ui.layoutRenderer = {
      render: (_layout: number, host: HTMLElement) => ({
        root: host, elements: new Map(), descs: new Map(),
        resizeSubtree: () => {}, setText: () => {}, setState: () => {}, setVisible: () => {},
        onClick: (_id: number, fn: () => void) => { clicks.set((host.closest('[data-research-button]') as HTMLElement | null)?.dataset.researchButton ?? '?', fn); },
      }),
      getResolvedLayout: () => null,
    };
    const comp = (id: number, scid: number, name: string) => ({ id, name, weenieClassId: W(scid), itemType: 0x1000, stackSize: 1 });
    ui.inventoryItems = [comp(1, 1, 'Lead Scarab'), comp(2, 15, 'Hawthorn'), comp(3, 34, 'Powdered Onyx'), comp(4, 46, 'Turpeth'), comp(5, 55, 'Birch Talisman')];
    ui.componentScidByWcid = SCID_OF;
    const CATEGORY: Record<number, number> = { 1: 0, 15: 1, 34: 2, 46: 3, 55: 4 };
    ui.spellComponentTable = { components: new Map(FLAME_BOLT_I.map((s) => [s, { category: CATEGORY[s], icon: 0 }])) };
    ui.setSpellResearch(true);
    ui.setSpellCallbacks({ onResearchSpell: (f: ResearchFormula) => sent.push(f.components(scidOf)) });
    parent = domWindow.document.createElement('div');
    container.appendChild(parent);
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  const render = () => { parent.innerHTML = ''; ui.renderResearchTab(parent, 25, 337); };
  const gridCells = (): HTMLElement[] => [...parent.querySelectorAll<HTMLElement>('.ac-research-components [data-comp-wcid]')];
  const slots = (): HTMLElement[] => [...parent.querySelectorAll<HTMLElement>('.ac-research-formula [data-research-slot]')];

  it('lists the carried components; clicking them fills the formula row in click order', () => {
    render();
    expect(gridCells().map((c) => Number(c.dataset.compWcid))).toEqual(FLAME_BOLT_I.map(W));
    // Click in the canonical slot order: scarab, herb, gem, alchemy, talisman.
    for (const scid of FLAME_BOLT_I) {
      parent.querySelector<HTMLElement>(`.ac-research-components [data-comp-wcid="${W(scid)}"]`)!.click();
      render();
    }
    expect(slots().map((s) => Number(s.dataset.compWcid))).toEqual(FLAME_BOLT_I.map(W));
    // One of each is owned: a second click on the scarab adds nothing.
    parent.querySelector<HTMLElement>(`.ac-research-components [data-comp-wcid="${W(1)}"]`)!.click();
    expect(ui.researchFormula.count).toBe(5);
  });

  it('Splitpea\'s Load into Research fills the row in slot order, only on the open Create Spell tab', () => {
    ui.researchFormula.clear();
    ui.magicVisible = false;
    expect(ui.loadResearchFormula(FLAME_BOLT_I)).toBe(false);
    ui.magicVisible = true;
    ui.magicPanelTab = 'spells';
    expect(ui.loadResearchFormula(FLAME_BOLT_I)).toBe(false);
    ui.magicPanelTab = 'research';
    const realRender = ui.renderMagicPanel;
    ui.renderMagicPanel = () => {};
    // An open taper (0) and a component not carried (99) are left out; the rest keep their order.
    expect(ui.loadResearchFormula([1, 0, 15, 34, 99, 46, 55])).toBe(true);
    render();
    expect(slots().map((s) => Number(s.dataset.compWcid))).toEqual(FLAME_BOLT_I.map(W));
    ui.renderMagicPanel = realRender;
    ui.magicVisible = false;
  });

  it('Test hands the row to onResearchSpell; Clear empties it', () => {
    render();
    expect(parent.querySelector('[data-research-button="Test"]')).not.toBeNull();
    clicks.get(RESEARCH_TEXT.test)!();
    expect(sent).toEqual([[...FLAME_BOLT_I, 0, 0, 0]]);
    clicks.get(RESEARCH_TEXT.clear)!();
    expect(ui.researchFormula.count).toBe(0);
  });

  it('a component that leaves the pack leaves the row (setInventoryData prunes)', () => {
    ui.researchFormula.add(W(1), 1);
    ui.researchFormula.add(W(15), 1);
    ui.setInventoryData(ui.inventoryItems.filter((i: { weenieClassId: number }) => i.weenieClassId !== W(1)), [], 0, 0);
    expect([...ui.researchFormula.wcids]).toEqual([W(15)]);
  });

  it('turning research off (a non-1999 world) leaves the magic panel on its own pages', () => {
    ui.magicPanelTab = 'research';
    ui.setSpellResearch(false);
    expect(ui.magicPanelTab).toBe('spells');
    expect(ui.hasSpellResearch).toBe(false);
  });
});

// ── The real 1999 data: a level-I formula built in the panel is the one the server matches ──

const AC1999 = resolve(__dirname, '..', 'dat-sets', 'ac1999-retail');
describe.skipIf(!existsSync(resolve(AC1999, 'portal.dat')))('with the 1999 portal.dat', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let spells: any;
  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { FileDatBytes } = await import('../packages/dat-parser/src/node/FileDatBytes.js');
    const { ac1999PortalOverlay } = await import('../packages/dat-parser/src/era1999/Ac1999Overlay.js');
    const { SpellTable } = await import('../packages/dat-parser/src/file-types/SpellTable.js');
    const portal = new DatDatabase(new FileDatBytes(resolve(AC1999, 'portal.dat')));
    portal.setOverlay(ac1999PortalOverlay());
    spells = new SpellTable(new DatReader(portal.getFileData(0x0e00000e)!));
  });

  it('Flame Bolt I: five components in slot order, no tapers — the server\'s InqSpellFormula + RandomizeVersion1, slot for slot', async () => {
    const { getPlayerFormula } = await import('@ac/shared');
    const spell = spells.spells.get(27);
    expect(spell.name).toBe('Flame Bolt I');
    // ResolveResearchedSpell compares all 8 slots of the account-keyed formula.
    const expected = [...getPlayerFormula(spell.formula.filter((c: number) => c), spell.formulaVersion, 'acjs')];
    while (expected.length < 8) expected.push(0);
    const f = new ResearchFormula();
    for (const scid of FLAME_BOLT_I) f.add(W(scid), 1);
    expect(f.components(scidOf)).toEqual(expected);
  });
});

// ── The Test / Clear art with the real LayoutRenderer: no tiled sliver past the button ──

describe.skipIf(!existsSync(DAT_PATHS.portal) || !existsSync(DAT_PATHS.local))('research buttons with the real interface DAT layout', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let H: any;
  const artWidth = new Map<number, number>();
  beforeAll(async () => {
    H = await mountGameUI();
    const dat = await import('@ac/dat-parser');
    const portal = openDat(DAT_PATHS.portal);
    const local = openDat(DAT_PATHS.local);
    dat.setMasterPropertyTypes(dat.parseMasterProperty(portal.getReader(0x39000001)));
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const { Texture } = await import('../packages/dat-parser/src/file-types/Texture.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    // The push button's two state images (0x21000032:0x100002a5 state 1 / 3).
    for (const id of [0x06004cda, 0x06004cdb]) artWidth.set(id, Texture.read(new DatReader(portal.getFileData(id)!)).width);
    const tex = { getTextureDataURL: () => 'data:image/png;base64,', getTextureDataURLWithAlpha: () => null };
    const font = {
      isReady: true, lineHeight: 17, outlinePadding: { x: 1, y: 1 }, measureText: (t: string) => t.length * 9,
      renderTextToCanvas: () => document.createElement('canvas'), renderWrappedTextToCanvas: () => document.createElement('canvas'),
    };
    H.ui.layoutRenderer = new LayoutRenderer(local, tex as never, font as never);
    H.ui.setSpellResearch(true);
  });
  afterAll(() => H?.teardown());

  it('each button is drawn at its art\'s own width, inside its 1999 slot: the image never tiles past it', () => {
    const parent = H.win.document.createElement('div');
    H.container.appendChild(parent);
    H.ui.renderResearchTab(parent, 25, 337);
    const minArt = Math.min(...artWidth.values());
    for (const [text, slot] of [[RESEARCH_TEXT.test, RESEARCH_LAYOUT.test], [RESEARCH_TEXT.clear, RESEARCH_LAYOUT.clear]] as const) {
      const host = parent.querySelector(`[data-research-button="${text}"]`) as HTMLElement;
      expect(host, text).not.toBeNull();
      const btn = host.querySelector('[data-element-id="0x100002a5"]') as HTMLElement;
      expect(btn, text).not.toBeNull();
      const inner = btn.closest('[data-research-button] > div') as HTMLElement;
      const left = parseFloat(inner.style.left);
      const w = parseFloat(btn.style.width || inner.style.width);
      // UIRegion::DrawSelf tiles an image smaller than its box: a box wider than the art repeats its left edge.
      expect(w, text).toBeLessThanOrEqual(minArt);
      expect(left, text).toBeGreaterThanOrEqual(0);
      expect(left + w, text).toBeLessThanOrEqual(slot.w);
      // Every rendered descendant stays inside the slot.
      for (const el of host.querySelectorAll<HTMLElement>('[data-element-id]')) {
        const ew = parseFloat(el.style.width);
        if (Number.isFinite(ew)) expect(left + (parseFloat(el.style.left) || 0) + ew, `${text} ${el.dataset.elementId}`).toBeLessThanOrEqual(slot.w);
      }
    }
  });
});
