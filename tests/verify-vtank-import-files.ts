/**
 * AGENT.vtank-import-files (Reddit, 2026-11-04: "I can't figure out how to add my own .nav / .met / .utl
 * files that are already created in my vtank folder") — the player's VirindiTank files into the VTank
 * window, in VTank's terms: `/vt nav|meta|loot|settings load <name>` of one not here opens the file picker
 * (several files at once), each Profiles dropdown ends with "Load from file…", and files dropped on the
 * window import. Same importer as the docked panel's (importVTankFiles). Nothing is replaced without asking;
 * a cancelled picker or a bad file changes nothing. Drives the real VTankWindow, the real file reader and
 * picker (vtankFileIn.ts), and the real GameUI's drop wiring.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import { emptyRoutineDoc, importVTank, validateRoutineDoc, vtCanonicalName, type RoutineDoc, type RoutineProfile } from '../packages/shared/src/routines/index.js';
import type { RoutineStatus } from '../packages/renderer/src/agent/RoutineEngine.js';
import type { MenuItem } from '../packages/renderer/src/ui/automation/AutomationPanel.js';
import type { VTankDialogs, VTankKit, VTankSource } from '../packages/renderer/src/ui/automation/VTankWindow.js';

type WinModule = typeof import('../packages/renderer/src/ui/automation/VTankWindow.js');
type InModule = typeof import('../packages/renderer/src/ui/automation/vtankFileIn.js');
let H: GameUIFixture;
let W: WinModule;
let FI: InModule;
beforeAll(async () => {
  H = await mountGameUI();
  W = await import('../packages/renderer/src/ui/automation/VTankWindow.js');
  FI = await import('../packages/renderer/src/ui/automation/vtankFileIn.js');
});
afterAll(() => H.teardown());

const fx = (f: string) => readFileSync(resolve(__dirname, 'fixtures', 'vtank', f), 'latin1');
/** A one-rule .met whose rule runs a chat command (VTank's Chat Command action). */
const chatMet = (cmd: string) => ['1', 'CondAct', '5', 'CType', 'AType', 'CData', 'AData', 'State', 'n', 'n', 'n', 'n', 'n', '1', 'i', '1', 'i', '2', 'i', '0', 's', cmd, 's', 'Default', ''].join('\r\n');

let lastMenu: { items: MenuItem[]; pick: (v: string) => void } | null = null;
function fakeKit(picker: { open: boolean; pending: Array<(f: Array<{ name: string; text: string }>) => void> }): VTankKit {
  const div = (data: Record<string, string>, onClick?: () => void) => { const d = document.createElement('div'); Object.assign(d.dataset, data); if (onClick) d.addEventListener('click', (e) => { e.stopPropagation(); onClick(); }); return d; };
  return {
    text: (t) => { const s = document.createElement('span'); s.textContent = t; s.dataset.text = t; return s; },
    button: (label, onClick) => div({ button: label }, onClick),
    tab: (label, on, onClick) => div({ tab: label, selected: on ? '1' : '0' }, onClick),
    check: (on, onChange) => div({ check: on ? '1' : '0' }, () => onChange(!on)),
    field: (text, onClick) => { const f = div({ field: text }); f.addEventListener('click', () => onClick(f)); return f; },
    menu: (_a, items, onPick) => { lastMenu = { items, pick: onPick }; },
    input: (value, _w, onChange) => { const i = document.createElement('input'); i.value = value; i.addEventListener('input', () => onChange(i.value)); return i; },
    row: (selected, onClick) => div({ selected: selected ? '1' : '0' }, onClick),
    box: () => document.createElement('div'),
    header: (t) => { const s = document.createElement('span'); s.textContent = t; s.dataset.text = t; return s; },
    dot: (lit) => div({ dot: lit ? '1' : '0' }),
    separator: () => document.createElement('hr'),
    scroll: () => {},
    plate: () => document.createElement('div'),
    colors: { text: 'white', dim: 'grey', gold: 'gold', good: 'green', warn: 'yellow', bad: 'red' },
    icon: (id, _s, onClick) => div({ icon: `0x${id.toString(16)}` }, onClick),
    flatButton: (label, onClick) => div({ button: label }, onClick),
    dropdown: (text, onClick) => { const f = div({ field: text }); f.addEventListener('click', () => onClick(f)); return f; },
    slider: () => document.createElement('input'),
    textTab: (label, on, onClick) => div({ tab: label, selected: on ? '1' : '0' }, onClick),
    list: () => {},
    download: () => {},
    openFiles: (onFiles) => { if (!picker.open) return false; picker.pending.push(onFiles); return true; },
  };
}

function fakeSource(doc: RoutineDoc) {
  const reports: string[] = [];
  const saved: RoutineDoc[] = [];
  let status: RoutineStatus = { running: false, paused: false, profile: null, state: null, acting: null, last: [] };
  const ok = { ok: true, message: '' };
  const source = {
    load: async () => ({ ok: true, doc: structuredClone(doc) }),
    save: async (d: RoutineDoc) => { const issues = validateRoutineDoc(d); if (issues.length) return { ok: false, message: 'not saved', issues }; saved.push(structuredClone(d)); return { ok: true, doc: structuredClone(d) }; },
    status: () => status,
    stats: () => ({ startedAt: 0, xpGained: 0, kills: 0, deaths: 0, kept: 0, left: 0, sold: 0, rebuffs: 0, stateTime: {} }),
    current: () => null,
    run: () => ok, pause: () => ok, resume: () => ok, stop: () => ok, setModule: () => ok, resetStats: () => {}, step: () => ok,
    history: () => [],
    report: (text: string) => { reports.push(text); },
    character: () => 'Claude',
    coords: () => '42.1N, 33.6E',
    items: () => [], spells: () => [], buffs: () => [],
    now: () => 1_700_000_000_000,
    setting: (_n: string) => undefined,
    setSetting: (n: string) => { void vtCanonicalName(n); },
    forceBuff: () => ok, cancelForceBuff: () => ok, setState: () => ok, update: () => ok,
    mexec: () => 'True', jump: () => ok, fakeDeath: () => ok, reverseRoute: () => ok, routeReversed: () => false,
    selection: () => null,
    pasteChat: () => true,
  } as unknown as VTankSource;
  return { source, reports, saved, setStatus: (s: Partial<RoutineStatus>) => { status = { ...status, ...s }; } };
}

const prof = (name: string, extra: Partial<RoutineProfile> = {}): RoutineProfile => ({
  name, modules: { buffs: true, vitals: true, combat: true, looting: true, navigation: true, inventory: true, service: false },
  initialState: 'Default', macro: true, ruleFiring: 'once', loot: [], buffSets: [], routes: [], states: [{ name: 'Default', rules: [] }],
  settings: { AttackDistance: 20 }, ...extra,
});
const withRules = (name: string, extra: Partial<RoutineProfile> = {}) => prof(name, {
  states: [{ name: 'Default', rules: [{ label: 'Rule 1', when: [{ kind: 'died' }], do: [{ kind: 'set-state', state: 'Default' }] }] }], ...extra,
});
const docWith = (...profiles: RoutineProfile[]): RoutineDoc => ({ ...emptyRoutineDoc('local-eor', 'agentclaude'), profiles });

async function open(doc: RoutineDoc, pickerOpen = true) {
  const f = fakeSource(doc);
  const picker = { open: pickerOpen, pending: [] as Array<(files: Array<{ name: string; text: string }>) => void> };
  const dialogs: Array<{ title: string; body: HTMLElement; onClosed?: () => void }> = [];
  const shown: boolean[] = [];
  const host: VTankDialogs = {
    open: (title, _w, _h, draw, onClosed) => { const body = document.createElement('div'); const d = { title, body, onClosed }; const redraw = () => draw(body, redraw, () => { dialogs.splice(dialogs.indexOf(d), 1); }); dialogs.push(d); redraw(); },
    close: () => { dialogs.length = 0; },
    showMain: (on) => { shown.push(on); },
  };
  const win = new W.VTankWindow(fakeKit(picker), f.source, host);
  const body = document.createElement('div');
  const redraw = () => win.render(body, 794, 189, redraw);
  await win.load(redraw);
  /** The player picks these in the open picker; the import's answer comes back. */
  const choose = async (files: Array<{ name: string; text: string }>) => {
    const cb = picker.pending.shift();
    if (!cb) throw new Error('no picker open');
    const n = f.reports.length;
    cb(files);
    // Done when the import has reported, or is asking (its dialog is up).
    for (let i = 0; i < 200 && f.reports.length === n && !dialogs.length; i++) await settle();
  };
  return { ...f, win, body, redraw, dialogs, picker, choose, shown };
}
const settle = () => new Promise((r) => setTimeout(r, 20));
const q = (root: Element, sel: string) => { const e = root.querySelector(sel); if (!e) throw new Error(`no ${sel}`); return e as HTMLElement; };
const press = (t: { dialogs: Array<{ body: HTMLElement }> }, key: string) => q(t.dialogs[0].body, `[data-vtank="${key}"]`).click();

describe('/vt … load <name> of one not here opens the picker (VTank read it from its folder)', () => {
  it('nav: the picker opens; what is picked is imported and loaded, and the window and chat say so', async () => {
    const t = await open(docWith(prof('Hunt')));
    const reply = await t.win.command('/vt nav load runback');
    expect(reply[0]).toMatch(/No route "runback" here yet: choose runback\.nav from your VirindiTank folder/);
    expect(t.picker.pending).toHaveLength(1);
    await t.choose([{ name: 'runback.nav', text: fx('holtburg-loop.nav') }]);
    const p = t.win.profile()!;
    expect(p.navRoute).toBe('runback');
    expect(p.routes.map((r) => r.name)).toEqual(['runback']);
    expect(t.saved.at(-1)!.profiles[0].navRoute).toBe('runback');
    expect(t.win.message).toMatch(/^Imported runback\.nav/);
    expect(t.reports.some((l) => /runback\.nav: route "runback", \d+ points/.test(l))).toBe(true);
    // The Profiles tab's Auto-Navigation dropdown shows it loaded.
    t.win.tab = 'profiles';
    t.redraw();
    expect(q(t.body, '[data-vtank="nav-profile"]').dataset.field).toBe('runback');
  });

  it('loot, meta and settings ask for their own files the same way; the name may carry VTank\'s extension', async () => {
    const t = await open(docWith(prof('Main')));
    expect((await t.win.command('/vt loot load keep.utl'))[0]).toMatch(/No loot profile "keep" here yet: choose keep\.utl/);
    expect((await t.win.command('/vt meta load hunt'))[0]).toMatch(/No meta "hunt" here yet: choose hunt\.met/);
    expect((await t.win.command('/vt settings load hunter'))[0]).toMatch(/No settings profile "hunter" here yet: choose hunter\.usd/);
    expect(t.picker.pending).toHaveLength(3);
    // Whatever the player picks is imported (a browser can't preselect a file).
    await t.choose([{ name: 'loot.utl', text: fx('loot.utl') }]);
    expect(t.win.profile()!.lootSet).toBe('loot');
  });

  it('a stored one loads as before, with or without the extension', async () => {
    const t = await open(docWith(prof('Hunt', { routes: [{ name: 'runback', mode: 'once', points: ['42.1N, 33.6E'] }], lootSets: { keep: [] } })));
    expect(await t.win.command('/vt nav load runback.nav')).toEqual(['nav "runback" loaded']);
    expect(await t.win.command('/vt loot load Keep.utl')).toEqual(['loot "keep" loaded']);
    expect(t.picker.pending).toHaveLength(0);
  });

  it('when the browser refuses the picker (no key press: a meta\'s chat command), it says where Load from file… is and opens the window there', async () => {
    const t = await open(docWith(prof('Hunt')), false);
    t.win.tab = 'options';
    const reply = await t.win.command('/vt nav load runback');
    expect(reply[0]).toMatch(/No route "runback" here yet\. Pick Load from file… in a Profiles dropdown/);
    expect(t.win.tab).toBe('profiles');
    expect(t.shown).toEqual([true]);
    expect(t.saved).toHaveLength(0);
  });
});

describe('the Profiles dropdowns end with Load from file… (VTank listed its folder there)', () => {
  it('Macro Settings, Auto-Navigation, Looting and the Meta dropdown each offer it, and it opens the picker', async () => {
    const t = await open(docWith(prof('Hunt'), withRules('Other')));
    t.win.tab = 'profiles';
    t.redraw();
    for (const key of ['macro-profile', 'nav-profile', 'loot-profile', 'meta-profile']) {
      q(t.body, `[data-vtank="${key}"]`).click();
      expect(lastMenu!.items.at(-1)!.label).toBe('Load from file…');
      lastMenu!.pick(lastMenu!.items.at(-1)!.value);
    }
    expect(t.picker.pending).toHaveLength(4);
    // The Meta dropdown lists the metas kept here (profiles with rules), as VTank listed its .met files.
    q(t.body, '[data-vtank="meta-profile"]').click();
    expect(lastMenu!.items.map((i) => i.label)).toEqual(['[This profile]', 'Other', 'Load from file…']);
  });

  it('a cancelled picker changes nothing', async () => {
    const t = await open(docWith(prof('Hunt')));
    const before = structuredClone(t.win.document);
    expect(t.win.loadFromFile()).toBe(true);
    t.picker.pending.length = 0; // the player closed the picker: its callback never runs
    await settle();
    expect(t.win.document).toEqual(before);
    expect(t.saved).toHaveLength(0);
  });

  it('the Meta dropdown loads a kept meta; one with rules of its own is asked about first (no Keep both)', async () => {
    const t = await open(docWith(withRules('Hunt'), prof('Sell', { states: [{ name: 'Sell', rules: [{ label: 'S', when: [{ kind: 'always' }], do: [{ kind: 'load-loot', set: 'junk' }] }] }], initialState: 'Sell', lootSets: { junk: [] } })));
    t.win.tab = 'profiles';
    t.redraw();
    q(t.body, '[data-vtank="meta-profile"]').click();
    lastMenu!.pick('Sell');
    await settle();
    expect(t.dialogs).toHaveLength(1);
    expect(t.dialogs[0].body.querySelector('[data-vtank="import-keep"]')).toBeNull();
    press(t, 'import-cancel');
    await settle();
    expect(t.win.profile()!.initialState).toBe('Default');
    q(t.body, '[data-vtank="meta-profile"]').click();
    lastMenu!.pick('Sell');
    await settle();
    press(t, 'import-replace');
    await new Promise((r) => setTimeout(r, 450));
    expect(t.win.profile()!.initialState).toBe('Sell');
    // The loot set its rule loads came along, so the account takes the save.
    expect(t.win.profile()!.lootSets).toHaveProperty('junk');
    expect(t.saved.at(-1)!.profiles.find((p) => p.name === 'Hunt')!.initialState).toBe('Sell');
  });
});

describe('importing several files at once: a whole VirindiTank folder', () => {
  it('.usd + .met + .nav + .utl: a Macro Settings profile, shown, with the route, loot and meta loaded; the meta kept by name', async () => {
    const t = await open(docWith(prof('Main')));
    t.win.loadFromFile();
    await t.choose([
      { name: 'hunter.usd', text: fx('hunter.usd') },
      { name: 'hunt.met', text: fx('hunt.met') },
      { name: 'holtburg-loop.nav', text: fx('holtburg-loop.nav') },
      { name: 'loot.utl', text: fx('loot.utl') },
    ]);
    const doc = t.saved.at(-1)!;
    expect(validateRoutineDoc(doc).map((i) => `${i.path}: ${i.message}`)).toEqual([]);
    expect(doc.profiles.map((p) => p.name)).toEqual(['Main', 'hunter', 'hunt']);
    const p = t.win.profile()!;
    expect(p.name).toBe('hunter');
    expect(p.navRoute).toBe('holtburg-loop');
    expect(p.lootSet).toBe('loot');
    expect(p.states.map((s) => s.name)).toEqual(['Default', 'Fight', 'Sell']);
    // The meta's own profile, for /vt meta load hunt and the Meta dropdown.
    expect(doc.profiles[2].states.map((s) => s.name)).toEqual(['Default', 'Fight', 'Sell']);
    // The profile shown before is untouched.
    expect(doc.profiles[0]).toEqual(prof('Main', { vtank: doc.profiles[0].vtank }));
    expect(t.win.message).toMatch(/^Imported hunter\.usd, loot\.utl, holtburg-loop\.nav, hunt\.met/);
    expect(t.reports.some((l) => /hunt\.met: meta "hunt", \d+ rules, loaded/.test(l))).toBe(true);
  });

  it('a .met and a .usd of one name are one profile; a meta\'s "load loot profile" finds a .utl imported earlier', async () => {
    const t = await open(docWith(prof('Hunt')));
    t.win.loadFromFile();
    await t.choose([{ name: 'keep.utl', text: fx('loot.utl') }]);
    t.win.loadFromFile();
    await t.choose([{ name: 'farm.met', text: chatMet('/vt loot load keep') }, { name: 'farm.usd', text: fx('hunter.usd') }]);
    const doc = t.saved.at(-1)!;
    expect(doc.profiles.map((p) => p.name)).toEqual(['Hunt', 'farm']);
    const farm = doc.profiles[1];
    expect(farm.states[0].rules[0].do).toEqual([{ kind: 'load-loot', set: 'keep' }]);
    expect(farm.states[0].rules[0].disabled).toBeUndefined();
    expect(farm.lootSets).toHaveProperty('keep');
  });
});

describe('names already here: Replace, Keep both or Cancel; never a silent overwrite', () => {
  const start = () => docWith(withRules('Hunt', { routes: [{ name: 'runback', mode: 'once', points: ['1.0N, 1.0E'] }], navRoute: 'runback', lootSets: { loot: [] } }));
  const files = () => [{ name: 'runback.nav', text: fx('holtburg-loop.nav') }, { name: 'loot.utl', text: fx('loot.utl') }];

  it('Cancel: nothing changes', async () => {
    const t = await open(start());
    const before = structuredClone(t.win.document);
    t.win.loadFromFile();
    await t.choose(files());
    expect(t.dialogs).toHaveLength(1);
    expect(Array.from(t.dialogs[0].body.querySelectorAll('[data-text]')).map((e) => e.textContent)).toEqual(['These are already here:', 'loot profile "loot" (loot.utl)', 'route "runback" (runback.nav)']);
    press(t, 'import-cancel');
    await settle();
    expect(t.win.document).toEqual(before);
    expect(t.saved).toHaveLength(0);
    expect(t.win.message).toBe('Import cancelled; nothing changed.');
  });

  it('closing the dialog is Cancel', async () => {
    const t = await open(start());
    const before = structuredClone(t.win.document);
    t.win.loadFromFile();
    await t.choose(files());
    t.dialogs[0].onClosed!();
    await settle();
    expect(t.win.document).toEqual(before);
  });

  it('Keep both: the imports take "name (2)" and are loaded; the old ones stay as they were', async () => {
    const t = await open(start());
    t.win.loadFromFile();
    await t.choose(files());
    press(t, 'import-keep');
    await settle();
    const p = t.win.profile()!;
    expect(p.routes.map((r) => r.name)).toEqual(['runback', 'runback (2)']);
    expect(p.routes[0].points).toEqual(['1.0N, 1.0E']);
    expect(p.navRoute).toBe('runback (2)');
    expect(Object.keys(p.lootSets!)).toEqual(['loot', 'loot (2)']);
    expect(p.lootSets!.loot).toEqual([]);
    expect(p.lootSet).toBe('loot (2)');
  });

  it('Replace: the same names take the files\' contents', async () => {
    const t = await open(start());
    t.win.loadFromFile();
    await t.choose(files());
    press(t, 'import-replace');
    await settle();
    const p = t.win.profile()!;
    expect(p.routes.map((r) => r.name)).toEqual(['runback']);
    expect(p.routes[0].points.length).toBeGreaterThan(1);
    expect(p.lootSets!.loot.length).toBeGreaterThan(0);
    expect(t.reports.some((l) => l.includes('route "runback" (replaced)'))).toBe(true);
  });

  it('a lone .met over a profile whose meta has rules asks; Keep both keeps it beside, not loaded', async () => {
    const t = await open(docWith(withRules('Main')));
    t.win.loadFromFile();
    await t.choose([{ name: 'hunt.met', text: fx('hunt.met') }]);
    expect(t.dialogs[0].body.textContent).toContain('the meta loaded in "Main" (1 rules; hunt.met takes its place)');
    press(t, 'import-keep');
    await settle();
    expect(t.win.profile()!.states[0].rules[0].label).toBe('Rule 1');
    expect(t.saved.at(-1)!.profiles.map((p) => p.name)).toEqual(['Main', 'hunt']);
    expect(t.reports.some((l) => l.includes('/vt meta load hunt loads it'))).toBe(true);
  });
});

describe('a file that can\'t be read changes nothing', () => {
  it('a bad file beside good ones: the good ones come in, the bad one is said', async () => {
    const t = await open(docWith(prof('Hunt')));
    t.win.loadFromFile();
    await t.choose([{ name: 'broken.nav', text: 'hello' }, { name: 'notes.txt', text: 'just notes' }, { name: 'loot.utl', text: fx('loot.utl') }]);
    expect(t.win.profile()!.lootSet).toBe('loot');
    expect(t.win.profile()!.routes).toEqual([]);
    expect(t.win.message).toMatch(/^Imported loot\.utl; .*couldn't read 2 files\./);
    expect(t.reports.some((l) => /broken\.nav: .*; nothing changed for it/.test(l))).toBe(true);
    expect(t.reports.some((l) => /notes\.txt: not a VirindiTank .*; nothing changed for it/.test(l))).toBe(true);
  });

  it('only bad files: nothing imported, nothing saved', async () => {
    const t = await open(docWith(prof('Hunt')));
    const before = structuredClone(t.win.document);
    t.win.loadFromFile();
    await t.choose([{ name: 'broken.met', text: 'not a meta' }]);
    expect(t.win.message).toMatch(/^Nothing imported: broken\.met: could not read it/);
    expect(t.win.document).toEqual(before);
    expect(t.saved).toHaveLength(0);
  });
});

describe('the browser side (vtankFileIn.ts) and GameUI\'s drop', () => {
  it('readVTankFiles reads Windows-1252, as VTank wrote', async () => {
    const files = await FI.readVTankFiles([new File([new Uint8Array([0x43, 0x61, 0x66, 0xe9])], 'Café.nav')]);
    expect(files).toEqual([{ name: 'Café.nav', text: 'Café' }]);
  });

  it('pickVTankFiles: several files, VTank\'s kinds; a cancel (no files) calls nothing; refused without a user action', async () => {
    let input: HTMLInputElement | null = null;
    const doc = { createElement: (t: string) => { const e = document.createElement(t) as HTMLInputElement; input = e; e.click = () => {}; return e; } } as unknown as Document;
    const got: Array<Array<{ name: string; text: string }>> = [];
    expect(FI.pickVTankFiles((f) => got.push(f), doc)).toBe(true);
    expect(input!.multiple).toBe(true);
    expect(input!.accept).toBe('.met,.nav,.utl,.usd,.af');
    input!.dispatchEvent(new Event('change'));
    await settle();
    expect(got).toEqual([]);
    Object.defineProperty(input!, 'files', { value: [new File(['a'], 'a.nav'), new File(['b'], 'b.met')], configurable: true });
    input!.dispatchEvent(new Event('change'));
    await settle();
    expect(got).toEqual([[{ name: 'a.nav', text: 'a' }, { name: 'b.met', text: 'b' }]]);
    const had = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { value: { userActivation: { isActive: false } }, configurable: true });
    try { expect(FI.pickVTankFiles(() => {}, doc)).toBe(false); } finally {
      if (had) Object.defineProperty(globalThis, 'navigator', had); else delete (globalThis as { navigator?: unknown }).navigator;
    }
  });

  it('files dropped on the VTank window import; a file dropped elsewhere on the page doesn\'t navigate away', async () => {
    const ui = H.ui as unknown as { setAutomationSource(s: VTankSource | null): void; toggleAutomationWindow(): void };
    const f = fakeSource(docWith(prof('Hunt')));
    ui.setAutomationSource(f.source);
    ui.toggleAutomationWindow();
    await settle();
    const win = H.container.querySelector('[data-vtank-window]') as HTMLElement;
    const dragged = (type: string, files: File[]) => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'dataTransfer', { value: { types: ['Files'], files, dropEffect: 'none' } });
      return e;
    };
    const over = dragged('dragover', []);
    win.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(win.dataset.vtankDrop).toBe('1');
    win.dispatchEvent(dragged('drop', [new File([fx('holtburg-loop.nav')], 'runback.nav')]));
    expect(win.dataset.vtankDrop).toBeUndefined();
    await new Promise((r) => setTimeout(r, 100));
    expect(f.saved.at(-1)!.profiles[0].navRoute).toBe('runback');
    expect(f.reports[0]).toMatch(/^Imported runback\.nav/);
    // Elsewhere on the page: the browser's "open the file" is stopped.
    const stray = dragged('drop', [new File(['x'], 'x.nav')]);
    document.body.dispatchEvent(stray);
    expect(stray.defaultPrevented).toBe(true);
    ui.toggleAutomationWindow();
    ui.setAutomationSource(null);
  });
});

describe('sweep: a meta keeps what it doesn\'t replace, and brings the loot sets its rules load', () => {
  it('importVTank: a .met into an existing profile replaces only its meta (settings, loot profiles and route stay)', () => {
    const base = prof('Hunt', { settings: { AttackDistance: 33 }, lootSets: { keep: [] }, lootSet: 'keep', navRoute: 'x', routes: [{ name: 'x', mode: 'once', points: ['1.0N, 1.0E'] }] });
    const { value: p } = importVTank([{ name: 'hunt.met', text: fx('hunt.met') }], base, 'Hunt');
    expect(p.settings).toEqual({ AttackDistance: 33 });
    expect(p.lootSets).toEqual({ keep: [] });
    expect(p.lootSet).toBe('keep');
    expect(p.navRoute).toBe('x');
    expect(p.routes.map((r) => r.name)).toEqual(['x', 'Holtburg loop']);
    expect(p.states.map((s) => s.name)).toEqual(['Default', 'Fight', 'Sell']);
  });

  it('/vt meta load and /vt meta save bring the loot sets the rules load (the account refused the save before)', async () => {
    const seller = prof('Seller', { states: [{ name: 'Default', rules: [{ label: 'S', when: [{ kind: 'always' }], do: [{ kind: 'load-loot', set: 'junk' }] }] }], lootSets: { junk: [] } });
    const t = await open(docWith(prof('Hunt'), seller));
    expect(await t.win.command('/vt meta load Seller')).toEqual(['meta "Seller" loaded']);
    expect(t.saved.at(-1)!.profiles[0].lootSets).toEqual({ junk: [] });
    expect(await t.win.command('/vt meta save Copy')).toEqual(['meta saved as "Copy"']);
    expect(t.saved.at(-1)!.profiles.find((p) => p.name === 'Copy')!.lootSets).toEqual({ junk: [] });
  });

  it('copyMeta keeps the target\'s own routes unless told the file replaces them', () => {
    const from = prof('A', { routes: [{ name: 'r', mode: 'once', points: ['2.0N, 2.0E'] }] });
    const to = prof('B', { routes: [{ name: 'r', mode: 'once', points: ['1.0N, 1.0E'] }] });
    W.copyMeta(from, to);
    expect(to.routes[0].points).toEqual(['1.0N, 1.0E']);
    W.copyMeta(from, to, true);
    expect(to.routes[0].points).toEqual(['2.0N, 2.0E']);
  });
});
