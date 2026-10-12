/**
 * VirindiTank's hotkeys in a Virindi Hotkey System-style window
 * (ui/automation/vhsHotkeys.ts, VhsWindow.ts; docs/vtank-parity-gaps.md §5.4):
 * the model against the real retail KeybindRegistry, the window inside the
 * real VTankWindow, GameUI's key hook, and RoutineEngine's Loot this Container.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import { FakeHost, run } from './_harness/agentFake.ts';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { KeybindRegistry } from '../packages/renderer/src/input/KeybindRegistry.js';
import { ACT, DEFAULT_KEYBINDS } from '../packages/renderer/src/input/KeybindDefaults.js';
import { VhsHotkeys, retailClash, vhsKeyLabel, vhsStorageKey, type VhsHotkey } from '../packages/renderer/src/ui/automation/vhsHotkeys.js';
import { VHS_SIZE, VHS_ADD_VVS_SIZE } from '../packages/renderer/src/ui/automation/VhsWindow.js';
import { EXAMPLE_HUNT_PROFILE, emptyRoutineDoc, vtCanonicalName, type RoutineDoc, type RoutineProfile } from '../packages/shared/src/routines/index.js';
import type { RoutineStatus } from '../packages/renderer/src/agent/RoutineEngine.js';
import type { VTankDialogs, VTankKit, VTankSource } from '../packages/renderer/src/ui/automation/VTankWindow.js';

type WinModule = typeof import('../packages/renderer/src/ui/automation/VTankWindow.js');
let H: GameUIFixture;
let W: WinModule;
beforeAll(async () => {
  H = await mountGameUI();
  W = await import('../packages/renderer/src/ui/automation/VTankWindow.js');
});
afterAll(() => H.teardown());

class MemStorage {
  data = new Map<string, string>();
  getItem(k: string): string | null { return this.data.get(k) ?? null; }
  setItem(k: string, v: string): void { this.data.set(k, v); }
}

const retailName = (reg: KeybindRegistry, id: number) => reg.action(id)!.name;

/** A model over two plain hotkeys, the real retail registry and a storage. */
function model(opts: { reg?: KeybindRegistry; storage?: MemStorage; who?: () => { world: string; character: string } | null } = {}) {
  const fired: string[] = [];
  const reports: string[] = [];
  const reg = opts.reg ?? new KeybindRegistry(DEFAULT_KEYBINDS);
  const storage = opts.storage ?? new MemStorage();
  const list: VhsHotkey[] = [
    { id: 'VTank/Start/Stop', plugin: 'VTank', name: 'Start/Stop', description: 'Starts or stops the macro.', defaultCode: 'Pause', run: () => { fired.push('start/stop'); return ['macro on']; } },
    { id: 'VTank/Loot this Container', plugin: 'VTank', name: 'Loot this Container', description: 'x', defaultCode: null, run: () => { fired.push('loot'); return []; } },
  ];
  const m = new VhsHotkeys({ list: () => list, storage: () => storage, who: opts.who ?? (() => ({ world: 'Coldeve', character: 'Claude' })), retail: () => reg, report: (l) => reports.push(l) });
  return { m, fired, reports, reg, storage, list };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('the hotkey model (vhsHotkeys.ts)', () => {
  it('VTank\'s defaults fire in the world: Pause runs Start/Stop; a held key fires once; an unbound key passes', async () => {
    const t = model();
    expect(t.m.rows().map((r) => [r.hotkey.name, r.code, r.label])).toEqual([['Start/Stop', 'Pause', 'Pause'], ['Loot this Container', null, '']]);
    expect(t.m.onKey('Pause')).toBe(true);
    expect(t.m.onKey('Pause', true)).toBe(true);
    await settle();
    expect(t.fired).toEqual(['start/stop']);
    expect(t.reports).toEqual(['macro on']);
    expect(t.m.onKey('KeyV')).toBe(false);
  });

  it('Set takes the next key; Shift waits for the chord; Escape cancels; Unset and Reset', () => {
    const t = model();
    t.m.selected = 'VTank/Loot this Container';
    t.m.beginSet();
    expect(t.m.message).toBe('Press the key for Loot this Container. Escape cancels.');
    expect(t.m.onKey('ShiftLeft')).toBe(true);
    expect(t.m.capturing).toBe('VTank/Loot this Container');
    expect(t.m.onKey('Shift+Numpad7')).toBe(true);
    expect(t.m.rows()[1].code).toBe('Shift+Numpad7');
    expect(t.m.message).toBe(`Loot this Container: ${vhsKeyLabel('Shift+Numpad7')}.`);
    t.m.beginSet();
    expect(t.m.onKey('Escape')).toBe(true);
    expect(t.m.message).toBe('Set cancelled.');
    expect(t.m.rows()[1].code).toBe('Shift+Numpad7');
    t.m.unset();
    expect(t.m.rows()[1].code).toBeNull();
    t.m.selected = 'VTank/Start/Stop';
    t.m.unset();
    expect(t.m.onKey('Pause')).toBe(false); // unset: retail's own handling gets it
    t.m.reset();
    expect(t.m.rows()[0].code).toBe('Pause');
  });

  it('refuses a key retail binds, naming the retail command; refuses a chord on a movement key; says what a chord replaces', () => {
    const t = model();
    t.m.selected = 'VTank/Loot this Container';
    t.m.beginSet();
    t.m.onKey('F9');
    expect(t.m.message).toBe(`F9 is ${retailName(t.reg, t.reg.ownersOf('F9')[0])} in Keyboard Config. Unbind it there, or pick another key.`);
    expect(t.m.rows()[1].code).toBeNull();
    t.m.beginSet();
    t.m.onKey('Ctrl+KeyW');
    expect(t.m.message).toMatch(/would also move you \(Move Forward/);
    expect(t.m.rows()[1].code).toBeNull();
    t.m.beginSet();
    t.m.onKey('Ctrl+F9');
    expect(t.m.rows()[1].code).toBe('Ctrl+F9');
    expect(t.m.message).toContain(`it no longer does ${retailName(t.reg, t.reg.ownersOf('F9')[0])}`);
    // The system keys stay the client's.
    t.m.beginSet();
    t.m.onKey('F7');
    expect(t.m.message).toBe('F7 is the game\'s own key. Pick another.');
  });

  it('a key retail binds later stays retail\'s, and the row says so', () => {
    const t = model();
    t.reg.setMapping(ACT.SelectSelf, 0, 'Pause');
    expect(retailClash('Pause', t.reg)).toEqual({ kind: 'taken', names: [retailName(t.reg, ACT.SelectSelf)] });
    expect(t.m.onKey('Pause')).toBe(false);
    expect(t.fired).toEqual([]);
    expect(t.m.rows()[0].clash?.kind).toBe('taken');
  });

  it('one key, one hotkey: a key set on another hotkey is taken from the first', () => {
    const t = model();
    t.m.selected = 'VTank/Loot this Container';
    t.m.beginSet();
    t.m.onKey('Pause');
    expect(t.m.rows().map((r) => r.code)).toEqual([null, 'Pause']);
    expect(t.m.message).toBe('Loot this Container: Pause (taken from Start/Stop).');
  });

  it('keys are kept per character: another character has its own; a reload reads them back', () => {
    const storage = new MemStorage();
    let who = { world: 'Coldeve', character: 'Claude' };
    const a = model({ storage, who: () => who });
    a.m.selected = 'VTank/Loot this Container';
    a.m.beginSet();
    a.m.onKey('ScrollLock');
    expect(JSON.parse(storage.getItem(vhsStorageKey('Coldeve', 'Claude'))!)).toEqual({ keys: { 'VTank/Loot this Container': 'ScrollLock' }, vvs: [] });
    who = { world: 'Coldeve', character: 'Other' };
    expect(a.m.rows()[1].code).toBeNull();
    who = { world: 'Coldeve', character: 'Claude' };
    const b = model({ storage, who: () => who });
    expect(b.m.rows()[1].code).toBe('ScrollLock');
  });

  it('a Set left waiting when the window closed is dropped, so the key does its usual thing', () => {
    const t = model();
    let open = true;
    t.m.windowOpen = () => open;
    t.m.selected = 'VTank/Loot this Container';
    t.m.beginSet();
    open = false;
    expect(t.m.onKey('KeyV')).toBe(false);
    expect(t.m.capturing).toBeNull();
  });
});

// ── The window inside the VirindiTank window ──

function fakeKit(storage: MemStorage, reg: KeybindRegistry, net = false): VTankKit {
  const div = (data: Record<string, string>, onClick?: () => void) => { const d = document.createElement('div'); Object.assign(d.dataset, data); if (onClick) d.addEventListener('click', (e) => { e.stopPropagation(); onClick(); }); return d; };
  return {
    text: (t) => { const s = document.createElement('span'); s.textContent = t; s.dataset.text = t; return s; },
    button: (label, onClick) => div({ button: label }, onClick),
    tab: (label, on, onClick) => div({ tab: label, selected: on ? '1' : '0' }, onClick),
    check: (on, onChange) => div({ check: on ? '1' : '0' }, () => onChange(!on)),
    field: (text, onClick) => { const f = div({ field: text }); f.addEventListener('click', () => onClick(f)); return f; },
    menu: () => {},
    input: (value, _w, onChange) => { const i = document.createElement('input'); i.value = value; i.addEventListener('input', () => onChange(i.value)); return i; },
    row: (selected, onClick) => div({ selected: selected ? '1' : '0' }, onClick),
    box: () => document.createElement('div'),
    header: (t) => { const s = document.createElement('span'); s.textContent = t; return s; },
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
    storage: () => storage,
    world: () => 'Coldeve',
    retailKeys: () => reg,
    ...(net ? { net: () => ({}) as never } : {}),
  };
}

const meta = (): RoutineProfile => ({
  name: 'Runback', modules: { buffs: true, vitals: true, combat: true, looting: true, navigation: true, inventory: true, service: false },
  initialState: 'Default', macro: true, ruleFiring: 'once', loot: [], buffSets: [], routes: [],
  states: [{ name: 'Default', rules: [] }, { name: 'dead', rules: [] }],
  settings: { EnableCombat: true },
});

async function openWindow(opts: { lootThis?: boolean; ub?: boolean; net?: boolean } = {}) {
  const calls: string[] = [];
  const reports: string[] = [];
  let status: RoutineStatus = { running: false, paused: false, profile: null, state: null, acting: null, last: [] };
  const live: Record<string, string | number | boolean> = {};
  const ubSettings: Record<string, boolean> = { 'AutoVendor.Enabled': true };
  const doc: RoutineDoc = { ...emptyRoutineDoc('local-eor', 'agentclaude'), profiles: [meta()] };
  const source = {
    load: async () => ({ ok: true, doc: structuredClone(doc) }),
    save: async (d: RoutineDoc) => ({ ok: true, doc: structuredClone(d) }),
    status: () => status,
    stats: () => ({ startedAt: 0, xpGained: 0, kills: 0, deaths: 0, kept: 0, left: 0, sold: 0, rebuffs: 0, stateTime: {} }),
    current: () => null,
    run: (p: RoutineProfile) => { calls.push(`run ${p.name}`); status = { ...status, running: true, paused: false, profile: p.name, state: p.initialState, spent: [] }; return { ok: true, message: '' }; },
    pause: () => { calls.push('pause'); status = { ...status, paused: true }; return { ok: true, message: '' }; },
    resume: () => { calls.push('resume'); status = { ...status, paused: false }; return { ok: true, message: '' }; },
    stop: () => ({ ok: true, message: '' }),
    setModule: () => ({ ok: true, message: '' }),
    resetStats: () => {},
    step: () => ({ ok: true, message: '' }),
    history: () => [],
    report: (text: string) => { reports.push(text); },
    character: () => 'Claude',
    coords: () => null,
    items: () => [],
    spells: () => [],
    buffs: () => [],
    now: () => 0,
    setting: (n: string) => live[vtCanonicalName(n)],
    setSetting: (n: string, v: string | number | boolean) => { calls.push(`set ${n}=${String(v)}`); live[vtCanonicalName(n)] = v; },
    forceBuff: () => ({ ok: true, message: '' }),
    cancelForceBuff: () => ({ ok: true, message: '' }),
    mexec: () => '',
    jump: () => ({ ok: true, message: '' }),
    fakeDeath: () => ({ ok: true, message: '' }),
    reverseRoute: () => ({ ok: true, message: '' }),
    setNearestWaypoint: () => ({ ok: true, message: '' }),
    setState: (n: string) => { calls.push(`state ${n}`); return { ok: true, message: `→ "${n}"` }; },
    update: () => ({ ok: true, message: '' }),
    selection: () => null,
    ...(opts.lootThis ? { lootThis: () => { calls.push('loot this'); return { ok: true, message: 'looting this container' }; } } : {}),
    ...(opts.ub ? { tools: {
      metaVars: () => [], testSpell: () => '', spellRows: () => [], skillRows: () => [], stackCram: () => '', carried: () => [], playersWithin: () => 1, clearBugged: () => '',
      ub: async (line: string) => {
        const m = /^\/ub opt toggle (\S+)$/i.exec(line.trim());
        if (!m) return null;
        ubSettings[m[1]] = !ubSettings[m[1]];
        return [`${m[1]} = ${ubSettings[m[1]]}`];
      },
    } } : {}),
  } as unknown as VTankSource;
  const windows = new Map<string, { title: string; body: HTMLElement; redraw: () => void }>();
  let mainOpen = true;
  const host: VTankDialogs = {
    open: () => {}, close: () => {},
    window: (key, title, _w, _h, draw) => {
      if (windows.has(key)) { windows.get(key)!.redraw(); return; }
      const body = document.createElement('div');
      document.body.appendChild(body);
      const w = { title, body, redraw: () => {} };
      const close = () => { body.remove(); windows.delete(key); };
      w.redraw = () => draw(body, w.redraw, close);
      windows.set(key, w);
      w.redraw();
    },
    closeWindow: (key) => { windows.get(key)?.body.remove(); windows.delete(key); },
    showMain: (on) => { mainOpen = on; },
    isOpen: (key) => (key === 'main' ? mainOpen : windows.has(key)),
  };
  const storage = new MemStorage();
  const reg = new KeybindRegistry(DEFAULT_KEYBINDS);
  const win = new W.VTankWindow(fakeKit(storage, reg, opts.net), source, host);
  const body = document.createElement('div');
  const redraw = () => win.render(body, 794, 189, redraw);
  await win.load(redraw);
  const vhs = () => windows.get('hotkeys')!.body;
  const rowOf = (id: string) => Array.from(vhs().querySelectorAll<HTMLElement>('[data-vhs-hotkey]')).find((e) => e.dataset.vhsHotkey === id)!;
  return { win, body, calls, reports, windows, reg, storage, vhs, rowOf, ubSettings, isMain: () => mainOpen };
}

describe('the hotkey window in the VirindiTank window', () => {
  it('Options → Hotkeys opens it at VHS\'s size; it lists VTank\'s hotkeys with their keys, plugin and descriptions', async () => {
    const t = await openWindow({ lootThis: true });
    (t.body.querySelector('[data-vtank="hotkeys"]') as HTMLElement).click();
    expect(t.windows.get('hotkeys')?.title).toBe('Hotkeys');
    expect(VHS_SIZE).toEqual({ w: 551, h: 213 }); // VHS_Main.jpg; long names clip in their column there too
    expect(VHS_ADD_VVS_SIZE).toEqual({ w: 414, h: 240 });
    const ids = Array.from(t.vhs().querySelectorAll('[data-vhs-hotkey]')).map((e) => (e as HTMLElement).dataset.vhsHotkey);
    expect(ids).toEqual([
      'VTank/Start/Stop', 'VTank/Target lock', 'VTank/Loot this Container',
      'VTank/Attack height: High', 'VTank/Attack height: Medium', 'VTank/Attack height: Low',
      'VTank/Meta state: Default', 'VTank/Meta state: dead',
    ]);
    const row = t.rowOf('VTank/Start/Stop');
    expect(row.dataset.key).toBe('Pause');
    expect(Array.from(row.querySelectorAll('[data-text]')).map((e) => (e as HTMLElement).dataset.text)).toEqual(['Pause', 'VTank', 'Start/Stop', 'Starts or stops the macro.']);
    expect(t.rowOf('VTank/Target lock').dataset.key).toBe('ScrollLock');
    for (const b of ['set', 'unset', 'reset', 'add-vvs']) expect(t.vhs().querySelector(`[data-vhs="${b}"]`)).not.toBeNull();
  });

  it('/vt hotkeys opens it too; without a host for windows it says so', async () => {
    const t = await openWindow();
    expect(await t.win.command('/vt hotkeys')).toEqual([]);
    expect(t.windows.has('hotkeys')).toBe(true);
  });

  it('pressing the keys runs VTank\'s actions: the macro, Target lock, attack height, meta state, Loot this Container', async () => {
    const t = await openWindow({ lootThis: true });
    const hk = t.win.hotkeys;
    expect(hk.onKey('Pause')).toBe(true);
    await settle();
    expect(t.calls).toContain('run Runback');
    expect(hk.onKey('ScrollLock')).toBe(true);
    await settle();
    expect(t.win.isOn('TargetLock')).toBe(true);
    // Unbound by default: set them, then press them.
    const setKey = (id: string, code: string) => { hk.selected = id; hk.beginSet(); hk.onKey(code); expect(hk.codeOf(hk.rows().find((r) => r.hotkey.id === id)!.hotkey)).toBe(code); };
    setKey('VTank/Attack height: Low', 'Numpad1');
    setKey('VTank/Meta state: dead', 'Numpad3');
    setKey('VTank/Loot this Container', 'Numpad7');
    hk.onKey('Numpad1'); hk.onKey('Numpad3'); hk.onKey('Numpad7');
    await settle();
    expect(t.calls).toEqual(expect.arrayContaining(['set DefaultMeleeAttackHeight=3', 'state dead', 'loot this']));
    expect(t.reports).toEqual(expect.arrayContaining(['Target lock on', 'Attack height: Low', '→ "dead"', 'looting this container']));
  });

  it('Set in the window: click a row, Set, press a key; the row shows the key; a retail key is refused in the window\'s line', async () => {
    const t = await openWindow();
    t.win.openHotkeys();
    t.rowOf('VTank/Attack height: High').click();
    expect(t.rowOf('VTank/Attack height: High').dataset.selected).toBe('1');
    (t.vhs().querySelector('[data-vhs="set"]') as HTMLElement).click();
    expect(t.vhs().querySelector('[data-vhs="message"]')?.textContent).toBe('Press the key for Attack height: High. Escape cancels.');
    t.win.hotkeys.onKey('KeyQ');
    expect(t.vhs().querySelector('[data-vhs="message"]')?.textContent).toBe('Q is Autorun in Keyboard Config. Unbind it there, or pick another key.');
    (t.vhs().querySelector('[data-vhs="set"]') as HTMLElement).click();
    t.win.hotkeys.onKey('Numpad9');
    expect(t.rowOf('VTank/Attack height: High').dataset.key).toBe('Numpad9');
    (t.vhs().querySelector('[data-vhs="unset"]') as HTMLElement).click();
    expect(t.rowOf('VTank/Attack height: High').dataset.key).toBe('');
  });

  it('UtilityBelt\'s toggles appear when UB runs here, with UB\'s titles; pressing one says UB\'s line', async () => {
    const without = await openWindow();
    expect(without.win.hotkeys.rows().some((r) => r.hotkey.plugin === 'UtilityBelt')).toBe(false);
    const t = await openWindow({ ub: true, net: true });
    const ub = t.win.hotkeys.rows().filter((r) => r.hotkey.plugin === 'UtilityBelt').map((r) => [r.hotkey.name, r.hotkey.description, r.code]);
    // NameTags (scene/Nametags.ts) and DungeonMaps (ui/maps) show up on their own: their settings are in UB_SETTING_DEFAULTS.
    expect(ub).toEqual([
      ['NameTags', 'Toggle NameTags display', null],
      ['DungeonMaps', 'Toggle DungeonMaps display', null],
      ['AutoVendor', 'Toggle AutoVendor functionality', null],
      ['AutoVendorTestMode', 'Toggle AutoVendor TestMode functionality', null],
      ['VitalSharing', 'Toggle VitalSharing functionality', null],
    ]);
    const hk = t.win.hotkeys;
    hk.selected = 'UtilityBelt/AutoVendor';
    hk.beginSet();
    hk.onKey('Ctrl+Numpad5');
    hk.onKey('Ctrl+Numpad5');
    await settle(); await settle();
    expect(t.ubSettings['AutoVendor.Enabled']).toBe(false);
    expect(t.reports).toContain('Toggle Hotkey Pressed: AutoVendor.Enabled = False');
  });

  it('Add VVS: a window\'s toggle hotkey; pressing it opens and closes that window', async () => {
    const t = await openWindow();
    t.win.openHotkeys();
    (t.vhs().querySelector('[data-vhs="add-vvs"]') as HTMLElement).click();
    const add = t.windows.get('hotkeys-vvs')!;
    expect(add.title).toBe('Add VVS...');
    expect(Array.from(add.body.querySelectorAll('[data-vhs-vvs]')).map((e) => (e as HTMLElement).dataset.vhsVvs)).toEqual(['Automation', 'Action History', 'Remote', 'Hotkeys']);
    (add.body.querySelector('[data-vhs-vvs="Action History"]') as HTMLElement).click();
    expect((add.body.querySelector('[data-vhs-vvs="Action History"]') as HTMLElement).dataset.on).toBe('1');
    const row = t.win.hotkeys.rows().find((r) => r.hotkey.id === 'VVS/Toggle:Action History')!;
    expect([row.hotkey.plugin, row.hotkey.name, row.hotkey.description]).toEqual(['VVS', 'Toggle:Action History', 'Toggle window: Action History']);
    t.win.hotkeys.selected = row.hotkey.id;
    t.win.hotkeys.beginSet();
    t.win.hotkeys.onKey('Numpad1');
    expect(t.windows.has('history')).toBe(false);
    t.win.hotkeys.onKey('Numpad1');
    await settle();
    expect(t.windows.has('history')).toBe(true);
    t.win.hotkeys.onKey('Numpad1');
    await settle();
    expect(t.windows.has('history')).toBe(false);
    (add.body.querySelector('[data-vhs="vvs-close"]') as HTMLElement).click();
    expect(t.windows.has('hotkeys-vvs')).toBe(false);
  });
});

describe('GameUI routes world keys to the hotkeys', () => {
  it('automationHotkey runs a VTank hotkey; a retail key and no automation pass through', async () => {
    const ui = H.ui as unknown as { setAutomationSource(s: VTankSource | null): void; automationHotkey(code: string, repeat?: boolean): boolean; keybindRegistry: KeybindRegistry | null };
    expect(ui.automationHotkey('Pause')).toBe(false);
    const before = ui.keybindRegistry;
    ui.keybindRegistry = new KeybindRegistry(DEFAULT_KEYBINDS);
    const runs: string[] = [];
    const t = await openWindow();
    const src = { ...(t.win.source as object), run: (p: RoutineProfile) => { runs.push(p.name); return { ok: true, message: '' }; } } as unknown as VTankSource;
    ui.setAutomationSource(src);
    // Nothing has loaded the routines yet: the hotkey loads them, then runs the profile.
    expect(ui.automationHotkey('F9')).toBe(false);
    expect(ui.automationHotkey('Pause')).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(runs).toEqual(['Runback']);
    ui.setAutomationSource(null);
    ui.keybindRegistry = before;
  });
});

describe('RoutineEngine: Loot this Container', () => {
  it('loots the open chest with the profile\'s loot rules once the macro is between actions, paused or not', async () => {
    vi.useFakeTimers();
    try {
      const host = new FakeHost();
      const api = new AgentApi(host);
      expect(api.routine.lootThis()).toEqual({ ok: false, message: 'no routine is running' });
      const items = [{ guid: 0x80004001, name: 'Pyreals', itemType: 0x40 }, { guid: 0x80004002, name: 'Old Rag', itemType: 0x4 }];
      host.add({ guid: 0x80004000, name: 'Chest', objectDescFlags: 0, x: 80, y: 23 });
      for (const it of items) host.add({ ...it, cell: 0 });
      // The rag is examined for the value rule (worth too little: left).
      host.appraisals.set(0x80004002, 'Old Rag\nValue: 5\nBurden: 10');
      const reports: string[] = [];
      api.routine.onReport = (r) => reports.push(r);
      api.routine.start({ name: 'T', modules: { buffs: false, vitals: false, combat: false, looting: true, navigation: false, inventory: false, service: false }, initialState: 'Idle', loot: EXAMPLE_HUNT_PROFILE.loot, buffSets: [], routes: [], states: [{ name: 'Idle', rules: [] }] });
      api.routine.pause();
      expect(api.routine.lootThis()).toEqual({ ok: false, message: 'Open or select a corpse or chest first.' });
      host.container = { guid: 0x80004000, items: items.map(({ guid, name }) => ({ guid, name })) };
      expect(api.routine.lootThis()).toEqual({ ok: true, message: 'looting this container' });
      for (let i = 0; i < 200 && !reports.some((r) => r.startsWith('Loot this Container:')); i++) { run(api, host, 100); await vi.advanceTimersByTimeAsync(100); }
      const picked = host.sent.filter((x) => x.startsWith('pickup')).map((x) => Number.parseInt(x.slice(7), 16));
      expect(picked).toEqual([0x80004001]);
      expect(reports).toContain('Kept Pyreals (rule: Money)');
      expect(reports.filter((r) => r.startsWith('Loot this Container:'))).toHaveLength(1);
      api.routine.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
