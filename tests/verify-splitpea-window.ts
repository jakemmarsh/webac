/**
 * Splitpea's window and VVS-bar entry through the real GameUI (happy-dom), and its era gate: AC1999 only.
 * The spell table is synthetic (real-shaped 1999 formulas); the solver itself is covered in verify-splitpea.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getPlayerFormula, splitpeaStoreKey, type SplitpeaSpellSource } from '@ac/shared';
import { ERA_PROFILES, eraProfile } from '../packages/renderer/src/era/EraProfiles.js';
import { createSplitpea, SPLITPEA_NOT_LINKED, type SplitpeaPlugin, type SplitpeaReads } from '../packages/renderer/src/ui/splitpea/SplitpeaPlugin.js';
import type { VTankKit } from '../packages/renderer/src/ui/automation/VTankWindow.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

const TAPERS = ['Red', 'Pink', 'Orange', 'Yellow', 'Green', 'Turquoise', 'Blue', 'Indigo', 'Violet', 'Brown', 'White', 'Black'];
const compName = (id: number) => (id >= 63 && id <= 74 ? `${TAPERS[id - 63]} Taper` : `Comp ${id}`);

/** 40 spells: lengths 5–8 in turn, schools 1–4. Spell 1003, 1007 … have all three tapers. */
function table(): Map<number, SplitpeaSpellSource> {
  const m = new Map<number, SplitpeaSpellSource>();
  for (let i = 0; i < 40; i++) {
    const len = 5 + (i % 4);
    const sc = 1 + (i % 6), herb = 7 + (i % 17), gem = 24 + ((i * 3) % 17), alch = 41 + (i % 10), tal = 51 + ((i * 5) % 12);
    const f = len === 8 ? [sc, 63, herb, 63, gem, alch, 63, tal] : len === 7 ? [sc, 63, herb, 63, gem, alch, tal, 0] : len === 6 ? [sc, 63, herb, gem, alch, tal, 0, 0] : [sc, herb, gem, alch, tal, 0, 0, 0];
    m.set(1000 + i, { name: `Spell ${String(i).padStart(2, '0')}`, desc: `A spell that does a thing number ${i}, described at some length to be cut.`, school: 1 + (i % 4), icon: 0x06001000 + i, bitfield: 0, baseMana: 10 + i, baseRangeConstant: 0, power: 50 * (len - 3), formula: f });
  }
  return m;
}

function reads(over: Partial<SplitpeaReads> & { book?: number[]; account?: string } = {}): SplitpeaReads {
  const spells = table();
  const account = over.account ?? 'agentc99';
  return {
    account: () => account,
    server: () => 'AC1999',
    spells: () => spells,
    component: (id) => ({ name: compName(id), icon: 0x06002000 + id }),
    // The spellbook's personal formulas (what the client shows and casts for a known spell).
    spellbook: () => (over.book ?? []).map((id) => ({ id, formula: getPlayerFormula(spells.get(id)!.formula.filter((c) => c !== 0), 1, account) })),
    carries: () => true,
    storage: () => globalThis.localStorage,
    ...over,
  };
}

describe('the era gate: Splitpea exists only in AC1999', () => {
  it('createSplitpea is null for end of retail and every classic era, a plugin for AC1999', () => {
    for (const id of ['eor', 'classicace-customdm', 'classicace-infiltration', 'classic-dereth']) expect(createSplitpea(eraProfile(id), reads())).toBeNull();
    expect(createSplitpea(null, reads())).toBeNull();
    expect(createSplitpea(eraProfile('ac1999-retail'), reads())).not.toBeNull();
    const on = Object.values(ERA_PROFILES).filter((p) => createSplitpea(p, reads()) !== null).map((p) => p.login.protocol);
    expect(new Set(on)).toEqual(new Set(['ac1999']));
  });
});

type Ui = {
  setAutomationSource(s: unknown): void;
  setPreviewFeatures(on: boolean): void;
  setSplitpea(p: SplitpeaPlugin | null): void;
  toggleSplitpeaWindow(): void;
  setSpellData(spells: unknown[]): void;
  hudContainer: HTMLElement;
};

let H: GameUIFixture;
beforeAll(async () => {
  H = await mountGameUI();
  const ui = H.ui as Ui;
  const { emptyRoutineDoc } = await import('../packages/shared/src/routines/index.js');
  const base: Record<string, unknown> = {
    load: async () => ({ ok: true, doc: emptyRoutineDoc('local-eor', 'tester') }),
    status: () => ({ running: false, paused: false, profile: null, state: null, acting: null, last: [] }),
    stats: () => ({ startedAt: 0, xpGained: 0, kills: 0, deaths: 0, kept: 0, left: 0, sold: 0, rebuffs: 0, stateTime: {} }),
    current: () => null, character: () => 'T', coords: () => null, now: () => 0, items: () => [], spells: () => [], buffs: () => [], history: () => [], setting: () => undefined, report: () => {}, spellTable: () => null, selection: () => null,
  };
  ui.setAutomationSource(new Proxy(base, { get: (t, k) => (k in t ? t[k as string] : () => ({ ok: true, message: '' })) }));
  ui.setPreviewFeatures(true);
});
afterAll(() => { (H.ui as Ui).setSplitpea(null); (H.ui as Ui).setAutomationSource(null); H.teardown(); });

const q = <T extends HTMLElement = HTMLElement>(sel: string) => (H.ui as Ui).hudContainer.querySelector<T>(sel);
const qa = (sel: string) => Array.from((H.ui as Ui).hudContainer.querySelectorAll<HTMLElement>(sel));
const click = (el: Element | null) => { expect(el).not.toBeNull(); el!.dispatchEvent(new MouseEvent('click', { bubbles: true })); };
/** VVS text is drawn on canvases; each carries its string in data-ac-run-text. */
const txt = (el: Element | null): string => (el ? [el, ...el.querySelectorAll('[data-ac-run-text]')].map((e) => (e as HTMLElement).dataset?.acRunText ?? '').filter(Boolean).join(' ') : '');
const status = () => txt(q('[data-splitpea-status]'));

describe('GameUI: the bar entry', () => {
  it('shows a Splitpea entry with its own stand-in icon only while a plugin is set (AC1999), last on the bar', () => {
    const ui = H.ui as Ui;
    ui.setSplitpea(createSplitpea(eraProfile('eor'), reads()));
    expect(q('[data-vvs-bar-entry="splitpea"]')).toBeNull();
    ui.setSplitpea(createSplitpea(eraProfile('ac1999-retail'), reads()));
    const entry = q('[data-vvs-bar-entry="splitpea"]')!;
    expect(entry).not.toBeNull();
    expect(entry.style.backgroundImage).toMatch(/^url\("?data:image\/png/);
    const ids = qa('[data-vvs-bar-entry]').map((e) => e.dataset.vvsBarEntry);
    expect(ids[ids.length - 1]).toBe('splitpea');
    // Preview UI: the bar (and so the entry) goes with the preview flag.
    ui.setPreviewFeatures(false);
    expect(q('[data-vvs-bar-entry="splitpea"]')).toBeNull();
    ui.setPreviewFeatures(true);
    ui.setSplitpea(null);
    expect(q('[data-vvs-bar-entry="splitpea"]')).toBeNull();
  });
});

describe('GameUI: the Splitpea window', () => {
  it('opens from the bar as "Splitpea - Spell List - <account>", with the tabs, filters, status and only the cards in view', () => {
    const ui = H.ui as Ui;
    const sp = createSplitpea(eraProfile('ac1999-retail'), reads())!;
    ui.setSplitpea(sp);
    click(q('[data-vvs-bar-entry="splitpea"]'));
    const win = q('[data-vtank-aux="splitpea"]')!;
    expect(win).not.toBeNull();
    expect(txt(win)).toContain('Splitpea - Spell List - agentc99');
    expect(qa('[data-splitpea-tab]').map((e) => e.dataset.splitpeaTab)).toEqual(['Spell List', 'Known Tapers', 'Options']);
    expect(qa('[data-splitpea-filter]').map((e) => e.dataset.splitpeaFilter)).toEqual(['All Spells', 'War', 'Life', 'Item', 'Creature']);
    expect(status()).toContain('0 spells with known tapers, 1,299,827 taper keys left');
    // The account is in the title; the status line stays inside the 400 px window.
    expect(status()).not.toContain('Account');
    const cards = qa('[data-splitpea-card]');
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.length).toBeLessThan(40);
    // Sorted by name; the description is cut to one line; a spell with tapers 2 and 3 shows them open in red.
    expect(txt(cards[0])).toContain('Spell 00');
    expect(txt(cards[0])).toContain('…');
    const eight = q('[data-splitpea-card="1003"]')!;
    expect(eight.querySelectorAll('[data-splitpea-open]').length).toBe(2);
    // "? (n)" past three colours, else the colours ("Red/Turquoise": this taper's term only reaches even ones).
    for (const o of eight.querySelectorAll('[data-splitpea-open]')) expect(txt(o)).toMatch(/^(\? \(\d+\)|[A-Za-z]+(\/[A-Za-z]+){1,2})$/);
    // The filter: War only.
    click(q('[data-splitpea-filter="War"]'));
    expect(qa('[data-splitpea-card]').every((c) => (Number(c.dataset.splitpeaCard) - 1000) % 4 === 0)).toBe(true);
    click(q('[data-splitpea-filter="All Spells"]'));
    ui.toggleSplitpeaWindow();
    expect(q('[data-vtank-aux="splitpea"]')).toBeNull();
    ui.setSplitpea(null);
  });

  it('the spellbook fills in known tapers (source spellbook), narrows the keys, and a learned spell redraws through setSpellData', () => {
    const ui = H.ui as Ui;
    const book: number[] = [];
    // reads() closes over `book`: push to it, then signal the spellbook change.
    const sp = createSplitpea(eraProfile('ac1999-retail'), reads({ book }))!;
    ui.setSplitpea(sp);
    ui.toggleSplitpeaWindow();
    book.push(1003, 1007, 1011);
    ui.setSpellData([]);
    expect(status()).toMatch(/3 spells with known tapers, [\d,]+ taper keys? left/);
    const card = q('[data-splitpea-card="1003"]')!;
    expect(card.querySelectorAll('[data-splitpea-open]').length).toBe(0);
    expect(card.querySelector('[data-splitpea-slot="3:known"]')).not.toBeNull();
    // Stored per server + account.
    const stored = JSON.parse(globalThis.localStorage.getItem(splitpeaStoreKey('AC1999', 'agentc99'))!);
    expect(stored.tapers.filter((t: { source: string }) => t.source === 'spellbook').length).toBe(6);
    // Known Tapers lists them with their source; the hook for research does the same.
    click(q('[data-splitpea-tab="Known Tapers"]'));
    expect(qa('[data-splitpea-known]').map((r) => txt(r)).every((t) => t.includes('spellbook'))).toBe(true);
    // The keys count is right-aligned inside the window, never past its frame.
    expect(q('[data-splitpea-keys]')!.style.right).toBe('10px');
    expect(q('[data-splitpea-keys]')!.style.left).toBe('');
    book.push(1015);
    sp.onSpellLearned(1015);
    expect(qa('[data-splitpea-known]').length).toBe(4);
    // Remove forgets one (it comes back from the spellbook on the next sync, as it should).
    click(q('[data-splitpea-known="1003"]'));
    click(qa('[data-button="Remove"]')[0]);
    expect(qa('[data-splitpea-known]').length).toBe(3);
    ui.toggleSplitpeaWindow();
    ui.setSplitpea(null);
    globalThis.localStorage.clear();
  });

  it('Edit Tapers: a dropdown per unknown taper, the narrowed set first; Save enters it as "entered"', async () => {
    const ui = H.ui as Ui;
    const sp = createSplitpea(eraProfile('ac1999-retail'), reads({ book: [1007] }))!;
    ui.setSplitpea(sp);
    ui.toggleSplitpeaWindow();
    click(q('[data-splitpea-card="1003"]'));
    click(qa('[data-button="Edit Tapers"]')[0]);
    const dlg = q('[data-vtank-aux="splitpea-edit"]')!;
    expect(dlg).not.toBeNull();
    expect(qa('[data-splitpea-edit-slot]').map((d) => d.dataset.splitpeaEditSlot)).toEqual(['3', '6']);
    click(q('[data-splitpea-edit-slot="3"]'));
    const items = Array.from(document.querySelectorAll<HTMLElement>('[data-menu-item]'));
    expect(items[0].dataset.menuItem).toBe('');
    expect(items.length).toBe(13);
    const truth = getPlayerFormula(table().get(1003)!.formula, 1, 'agentc99');
    await new Promise((r) => setTimeout(r, 5)); // the menu arms its outside-click listener on a timer
    click(items.find((i) => i.dataset.menuItem === String(truth[3]))!);
    click(Array.from(q('[data-vtank-aux="splitpea-edit"]')!.querySelectorAll('[data-button="Save"]'))[0]);
    expect(q('[data-vtank-aux="splitpea-edit"]')).toBeNull();
    expect(sp.ensure()!.knownTapers().find((k) => k.spell === 1003)).toEqual({ spell: 1003, slot: 3, taper: truth[3], source: 'entered' });
    expect(q('[data-splitpea-card="1003"] [data-splitpea-slot="3:known"]')).not.toBeNull();
    ui.toggleSplitpeaWindow();
    ui.setSplitpea(null);
    globalThis.localStorage.clear();
  });

  it('Load into Research: unwired says to open the Create Spell tab; wired, it hands the formula over (0 for open tapers)', () => {
    const ui = H.ui as Ui;
    const sp = createSplitpea(eraProfile('ac1999-retail'), reads())!;
    ui.setSplitpea(sp);
    ui.toggleSplitpeaWindow();
    click(q('[data-splitpea-card="1003"]'));
    click(qa('[data-button="Load into Research"]')[0]);
    expect(status()).toBe(SPLITPEA_NOT_LINKED);
    const loadFormula = vi.fn((_ids: number[]) => false);
    sp.research = { loadFormula };
    click(qa('[data-button="Load into Research"]')[0]);
    expect(status()).toBe(SPLITPEA_NOT_LINKED);
    loadFormula.mockReturnValue(true);
    click(qa('[data-button="Load into Research"]')[0]);
    const f = table().get(1003)!.formula;
    const sent = loadFormula.mock.calls[1][0];
    expect(sent.length).toBe(8);
    expect([sent[0], sent[2], sent[4], sent[5], sent[7]]).toEqual([f[0], f[2], f[4], f[5], f[7]]);
    expect([sent[3], sent[6]]).toEqual([0, 0]);
    expect(status()).toContain('Loaded Spell 03; pick Taper 2 and Taper 3 yourself');
    ui.toggleSplitpeaWindow();
    ui.setSplitpea(null);
  });

  it('Export HTML downloads a self-contained table of the list', () => {
    const sp = createSplitpea(eraProfile('ac1999-retail'), reads())!;
    const download = vi.fn();
    const html = sp.exportHtml({ download } as unknown as VTankKit)!;
    expect(download).toHaveBeenCalledWith('splitpea-agentc99.html', html);
    expect(html).toContain('<title>Splitpea - Spell List - agentc99</title>');
    expect(html).toContain('<td>Spell 03</td>');
    expect(html.match(/<tr><td>/g)!.length).toBe(40);
  });

  it('Options filter the list and are kept per browser; the window comes back after the HUD is rebuilt', () => {
    const ui = H.ui as Ui;
    const sp = createSplitpea(eraProfile('ac1999-retail'), reads({ carries: () => false }))!;
    ui.setSplitpea(sp);
    ui.toggleSplitpeaWindow();
    click(q('[data-splitpea-tab="Options"]'));
    click(q('[data-splitpea-option="Only spells you have the components for"]'));
    expect(JSON.parse(globalThis.localStorage.getItem('acjs.splitpea.options')!).carriedOnly).toBe(true);
    click(q('[data-splitpea-tab="Spell List"]'));
    expect(qa('[data-splitpea-card]').length).toBe(0);
    // renderHUD sweeps the HUD layer; reattachPluginLayers puts open plugin windows back.
    const win = q('[data-vtank-aux="splitpea"]')!;
    win.remove();
    (H.ui as unknown as { reattachPluginLayers(): void }).reattachPluginLayers();
    expect(q('[data-vtank-aux="splitpea"]')).toBe(win);
    ui.toggleSplitpeaWindow();
    ui.setSplitpea(null);
    globalThis.localStorage.clear();
  });
});
