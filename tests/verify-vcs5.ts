/**
 * Virindi Chat System 5 (docs/plugin-specs/vcs5.md): the rule model (@ac/shared vcs5.ts), AC's built-in
 * presets from the client's own line builders, the actions, and GameUI's hosting: the preview gate, the
 * order after Mag-Tools' filters, routing to windows, the window and its VVS bar entry.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ChatMessageType, RETAIL_CHAT_COLORS, VCS_AC_PRESETS, VCS_MAGTOOLS_PRESETS, VCS_VTANK_PRESETS, VcsModel, normalizeVcsSettings,
  vcsColorName, vcsForwardCommand, vcsMatcher, vcsParseWindows, vcsPresetWindowsText, vtVcsCategory,
} from '@ac/shared';
import { VcsActions, VCS_ACTION_MIN_MS, vcsAcPreset } from '../packages/renderer/src/ui/automation/VcsWindow.js';
import { evasionAttackerLine, evasionDefenderLine } from '../packages/renderer/src/ui/ServerMessageText.js';
import { VCS_ICON_PNG } from '../packages/renderer/src/ui/automation/virindiIcons.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

class Mem { m = new Map<string, string>(); getItem(k: string) { return this.m.get(k) ?? null; } setItem(k: string, v: string) { this.m.set(k, v); } }

function model(who = { v: 'Srv.Tester' }, mem = new Mem()) {
  return { m: new VcsModel(() => mem, () => who.v), mem, who };
}

describe('patterns', () => {
  it('plain: * is a wildcard, the rest literal, the whole line, case-sensitive', () => {
    const m = vcsMatcher('*tells you, "*', false);
    expect(m('Bob tells you, "hi"')).toBe(true);
    expect(m('Bob Tells you, "hi"')).toBe(false);
    expect(vcsMatcher('[VI] *', false)('[VI] [General] Bob says, "x"')).toBe(true);
    expect(vcsMatcher('evaded', false)('Drudge evaded your attack.')).toBe(false);
    expect(vcsMatcher('a.c', false)('abc')).toBe(false);
  });
  it('regex: anchored to the whole line; a bad one matches nothing', () => {
    expect(vcsMatcher('.*evaded your attack\\.', true)('Drudge evaded your attack.')).toBe(true);
    expect(vcsMatcher('evaded', true)('Drudge evaded your attack.')).toBe(false);
    expect(vcsMatcher('(', true)('(')).toBe(false);
  });
  it('windows: digits 1–5 once each; the Presets cell shows M for main', () => {
    expect(vcsParseWindows('31x9 3')).toEqual([1, 3]);
    expect(vcsPresetWindowsText([4, 1])).toBe('M3');
  });
  it('colours are AC\'s palette by name', () => {
    expect(vcsColorName(RETAIL_CHAT_COLORS.lightBlue)).toBe('LightBlue');
    expect(vcsColorName('rgb(238, 146, 30)')).toBe('Orange');
    expect(vcsColorName('#123456')).toBeNull();
  });
});

describe('the model', () => {
  it('registers AC\'s built-ins, keeps them last, and each plugin category once', () => {
    const { m } = model();
    for (const p of VCS_VTANK_PRESETS) m.register(p.plugin, p.category, p.description);
    for (const p of VCS_MAGTOOLS_PRESETS) m.register(p.plugin, p.category, p.description);
    m.register('VTank', 'Echo', 'again');
    expect(m.presets().map((p) => `${p.plugin}.${p.category}`)).toEqual([
      ...VCS_VTANK_PRESETS, ...VCS_MAGTOOLS_PRESETS, ...VCS_AC_PRESETS].map((p) => `${p.plugin}.${p.category}`));
  });

  it('an unset preset leaves the line alone; a set one routes and recolours; no windows eats it; Unset restores', () => {
    const { m } = model();
    const line = { text: 'Bob tells you, "hi"', color: RETAIL_CHAT_COLORS.yellow, preset: { plugin: 'AC', category: 'TellInc' } };
    expect(m.route(line)).toBeNull();
    m.setPreset('AC', 'TellInc', { windows: [4, 1], color: 'LightBlue', action: 2 });
    const r = m.route(line)!;
    expect(r.hide).toBe(false);
    expect(r.windows).toEqual([1, 4]);
    expect(r.color).toBe(RETAIL_CHAT_COLORS.lightBlue);
    expect(r.action).toBeNull(); // action 2 isn't defined
    m.setPreset('AC', 'TellInc', { windows: [] });
    expect(m.route(line)!.hide).toBe(true);
    m.unsetPreset('AC', 'TellInc');
    expect(m.route(line)).toBeNull();
  });

  it('patterns: first match wins, Pattern color must match, Filter hides, empty windows keeps the routing', () => {
    const { m } = model();
    m.update((s) => {
      s.actions.push({ id: 1, sound: 0x0a000123, soundName: 'x', chatboxDo: '', tellTarget: '' });
      s.patterns.push({ pattern: '*evaded*', regex: false, patternColor: 'Yellow', changeTo: 'Orange', windows: [2], action: 0 });
      s.patterns.push({ pattern: '*evaded*', regex: false, patternColor: 'Any', changeTo: 'Filter', windows: [], action: 1 });
      s.patterns.push({ pattern: '*', regex: false, patternColor: 'Any', changeTo: 'Cyan', windows: [], action: 0 });
    });
    const evade = m.route({ text: 'Drudge evaded your attack.', color: RETAIL_CHAT_COLORS.lightRed })!;
    expect(evade.hide).toBe(true);
    expect(evade.action?.id).toBe(1);
    expect(evade.by).toEqual({ pattern: 1 });
    const yellow = m.route({ text: 'Drudge evaded your attack.', color: RETAIL_CHAT_COLORS.yellow })!;
    expect(yellow).toMatchObject({ hide: false, windows: [2], color: RETAIL_CHAT_COLORS.orange });
    const other = m.route({ text: 'Hello', color: '#ffffff' })!;
    expect(other).toMatchObject({ hide: false, windows: [], color: RETAIL_CHAT_COLORS.cyan });
  });

  it('a set preset decides its line before the patterns', () => {
    const { m } = model();
    m.update((s) => { s.patterns.push({ pattern: '*', regex: false, patternColor: 'Any', changeTo: 'Filter', windows: [], action: 0 }); });
    m.setPreset('VTank', 'Echo', { windows: [1] });
    expect(m.route({ text: '[Automation] x', color: '#fff', preset: { plugin: 'VTank', category: 'Echo' } })!.windows).toEqual([1]);
    expect(m.route({ text: '[Automation] x', color: '#fff', preset: { plugin: 'VTank', category: 'Errors' } })!.hide).toBe(true);
  });

  it('is kept per character in browser storage', () => {
    const mem = new Mem();
    const who = { v: 'Srv.Alpha' };
    const a = model(who, mem).m;
    a.setPreset('AC', 'TellInc', { windows: [1] });
    expect(mem.getItem('acjs.vcs5.Srv.Alpha')).toContain('TellInc');
    who.v = 'Srv.Beta';
    expect(a.preset('AC', 'TellInc')).toBeNull();
    who.v = 'Srv.Alpha';
    expect(new VcsModel(() => mem, () => who.v).preset('AC', 'TellInc')?.windows).toEqual([1]);
    expect(normalizeVcsSettings({ presets: { k: { windows: [9, 2], color: 3 } }, actions: [{ id: 0 }] })).toEqual({ v: 1, presets: { k: { windows: [2], color: 'Any', action: 0 } }, patterns: [], actions: [] });
  });
});

describe('AC\'s built-in presets, from the client\'s own lines', () => {
  it('evades by the client\'s builders and types; tells by the sender, not the text (every era)', () => {
    const at = evasionAttackerLine('Drudge Skulker');
    const df = evasionDefenderLine('Drudge Skulker');
    expect(vcsAcPreset(at.text, at.type, null)?.category).toBe('MAtEvade');
    expect(vcsAcPreset(df.text, df.type, null)?.category).toBe('MDfEvade');
    expect(vcsAcPreset(at.text, ChatMessageType.Broadcast, null)).toBeNull();
    expect(vcsAcPreset('Bob says, "Drudge Skulker evaded your attack."', at.type, null)).toBeNull();
    const tell = (senderClass: 'player' | 'npc' | 'vendor' | null, self = false) => vcsAcPreset('whatever the era writes', ChatMessageType.Tell, { kind: 'tell', sender: 'X', message: 'm', senderClass, self })?.category ?? null;
    expect(tell('player')).toBe('TellInc');
    expect(tell(null)).toBe('TellInc');
    expect(tell('npc')).toBe('NPCTellInc');
    expect(tell('vendor')).toBe('NPCTellInc');
    expect(tell('player', true)).toBeNull();
  });
  it('VTank lines: the engine\'s category, `/vt log` as Logging, else CommandLine', () => {
    expect(vtVcsCategory('x', 'Echo')).toBe('Echo');
    expect(vtVcsCategory('[VT log Loot] corpse')).toBe('Logging');
    expect(vtVcsCategory('Set Loot')).toBe('CommandLine');
  });
});

describe('actions', () => {
  it('plays the wave, runs ChatBox Do and forwards as /t <target>, <line>; never on your own lines; at most twice a second', () => {
    const waves: number[] = []; const chat: string[] = []; let t = 0;
    const acts = new VcsActions({ playWave: (w) => waves.push(w), chat: (l) => chat.push(l), now: () => t });
    const a = { id: 1, sound: 0x0a000456, soundName: 'Tell', chatboxDo: '/e waves', tellTarget: 'Alt' };
    expect(acts.fire(a, 'Bob tells you, "hi"', ChatMessageType.Tell, null)).toBe(true);
    expect(waves).toEqual([0x0a000456]);
    expect(chat).toEqual(['/e waves', vcsForwardCommand('Alt', 'Bob tells you, "hi"')]);
    expect(chat[1]).toBe('/t Alt, Bob tells you, "hi"');
    expect(acts.fire(a, 'again', ChatMessageType.Tell, null)).toBe(false);
    t += VCS_ACTION_MIN_MS;
    expect(acts.fire(a, 'You tell Alt, "x"', ChatMessageType.OutgoingTell, null)).toBe(false);
    expect(acts.fire(a, 'x', ChatMessageType.Speech, { kind: 'say', sender: 'Me', message: 'x', self: true })).toBe(false);
    expect(acts.fire(a, 'later', ChatMessageType.Tell, null)).toBe(true);
  });
});

type Ui = {
  chatMessages: HTMLElement; hudContainer: HTMLElement; callbacks: Record<string, unknown>;
  vcs: VcsModel; chatLineFilter: ((l: { text: string }) => boolean) | null;
  setPreviewFeatures(on: boolean): void; setAutomationSource(s: unknown): void; toggleAutomationWindow(): void; toggleVcsWindow(): void;
  addSystemMessage(text: string, color?: string, type?: number, target?: number, speech?: unknown, preset?: { plugin: string; category: string } | null): void;
};

describe('GameUI hosting', () => {
  let H: GameUIFixture;
  let ui: Ui;
  const sniffed: string[] = [];
  const sent: string[] = [];
  beforeAll(async () => {
    H = await mountGameUI();
    ui = H.ui as Ui;
    ui.chatMessages = H.win.document.createElement('div');
    H.container.appendChild(ui.chatMessages);
    ui.callbacks.onChatLine = (l: string) => sniffed.push(l);
    ui.callbacks.onChatSend = (l: string) => sent.push(l);
  });
  afterAll(() => H.teardown());

  it('alert sounds play outside the Options page\'s sound switches (VCS: "keep AC sounds off and still receive the alert")', () => {
    const played: Array<[number, string]> = [];
    const u = ui as unknown as { soundPlayer: unknown; playVcsWave(w: number): void };
    const before = u.soundPlayer;
    u.soundPlayer = { playSound: async (w: number, category: string) => { played.push([w, category]); return null; } };
    u.playVcsWave(0x0a000123);
    u.soundPlayer = before;
    expect(played).toEqual([[0x0a000123, 'plugin']]);
  });

  it('with preview UI off chat is unchanged, whatever VCS holds', () => {
    ui.setPreviewFeatures(false);
    ui.vcs.update((s) => { s.patterns = [{ pattern: '*secret*', regex: false, patternColor: 'Any', changeTo: 'Filter', windows: [], action: 0 }]; });
    ui.addSystemMessage('a secret line', '#ffffff', ChatMessageType.Broadcast);
    expect(ui.chatMessages.textContent).toContain('a secret line');
    expect(ui.hudContainer.querySelector('[data-vtank-aux="vcs"]')).toBeNull();
    ui.toggleVcsWindow();
    expect(ui.hudContainer.querySelector('[data-vtank-aux="vcs"]')).toBeNull();
  });

  it('preview on: a pattern hides a line (still sniffed); a preset routes a plugin line to main chat in its colour; its action fires', () => {
    ui.setPreviewFeatures(true);
    ui.chatMessages.replaceChildren();
    sniffed.length = 0;
    ui.addSystemMessage('another secret line', '#ffffff', ChatMessageType.Broadcast);
    expect(ui.chatMessages.textContent).not.toContain('secret');
    expect(sniffed).toContain('another secret line');
    ui.vcs.update((s) => { s.patterns = []; s.actions = [{ id: 3, sound: null, soundName: '', chatboxDo: '/em nods', tellTarget: '' }]; });
    ui.vcs.setPreset('MagTools', 'IDs', { windows: [1], color: 'Orange', action: 3 });
    ui.addSystemMessage('Pyreal Sword, Value 1,000', '#b4dcf0', ChatMessageType.Abuse, 0, null, { plugin: 'MagTools', category: 'IDs' });
    const lines = Array.from(ui.chatMessages.querySelectorAll<HTMLElement>('[data-ac-run-text]')).filter((e) => e.dataset.acRunText?.includes('Pyreal Sword'));
    expect(lines.length).toBeGreaterThan(0);
    expect(sent).toContain('/em nods');
    expect(sniffed.filter((l) => l.includes('Pyreal Sword'))).toHaveLength(1);
  });

  it('a set preset with only a floating window that isn\'t built shows nowhere; no windows eats the line', () => {
    ui.chatMessages.replaceChildren();
    ui.vcs.setPreset('VTank', 'Echo', { windows: [3] });
    ui.addSystemMessage('[Automation] echoed', '#ff7fff', ChatMessageType.System, 0, null, { plugin: 'VTank', category: 'Echo' });
    expect(ui.chatMessages.textContent).not.toContain('echoed');
    ui.vcs.setPreset('AC', 'TellInc', { windows: [] });
    ui.addSystemMessage('Bob tells you, "hi"', '#ffff3f', ChatMessageType.Tell, 0, { kind: 'tell', sender: 'Bob', message: 'hi', senderClass: 'player' });
    expect(ui.chatMessages.textContent).not.toContain('Bob tells you');
    ui.addSystemMessage('Gharu tells you, "quest"', '#ffff3f', ChatMessageType.Tell, 0, { kind: 'tell', sender: 'Gharu', message: 'quest', senderClass: 'npc' });
    expect(ui.chatMessages.textContent).toContain('Gharu tells you');
  });

  it('VCS routes after Mag-Tools: a line Mag-Tools hides never reaches VCS (its action doesn\'t fire)', () => {
    sent.length = 0;
    // A fresh action (3 fired just now, and one action fires at most twice a second).
    ui.vcs.update((s) => { s.actions.push({ id: 4, sound: null, soundName: '', chatboxDo: '/em bows', tellTarget: '' }); s.patterns = [{ pattern: '*evaded*', regex: false, patternColor: 'Any', changeTo: 'Any', windows: [1], action: 4 }]; });
    ui.chatLineFilter = (l) => l.text.includes('evaded');
    ui.addSystemMessage('Drudge evaded your attack.', '#f57572', ChatMessageType.CombatSelf);
    expect(sent).toEqual([]);
    ui.chatLineFilter = null;
    ui.addSystemMessage('Drudge evaded your attack.', '#f57572', ChatMessageType.CombatSelf);
    expect(sent).toEqual(['/em bows']);
  });

  it('the window: VVS bar entry with the no-icon box; three tabs; Presets toggles set a preset; Patterns Create adds a rule; Actions Create adds an action', async () => {
    const { emptyRoutineDoc } = await import('../packages/shared/src/routines/index.js');
    const base: Record<string, unknown> = {
      load: async () => ({ ok: true, doc: emptyRoutineDoc('local-eor', 'tester') }),
      status: () => ({ running: false, paused: false, profile: null, state: null, acting: null, last: [] }),
      stats: () => ({ startedAt: 0, xpGained: 0, kills: 0, deaths: 0, kept: 0, left: 0, sold: 0, rebuffs: 0, stateTime: {} }),
      current: () => null, character: () => 'T', coords: () => null, now: () => 0, items: () => [], spells: () => [], buffs: () => [], history: () => [], setting: () => undefined, report: () => {}, spellTable: () => null, selection: () => null,
    };
    ui.setAutomationSource(new Proxy(base, { get: (t, k) => (k in t ? t[k as string] : () => ({ ok: true, message: '' })) }));
    ui.toggleAutomationWindow();
    await new Promise((r) => setTimeout(r, 5));
    const entry = ui.hudContainer.querySelector<HTMLElement>('[data-vvs-bar-entry="vcs"]');
    expect(entry).not.toBeNull();
    // Our own stand-in globe (virindiIcons.ts), not VVS's coral no-icon box.
    expect(entry!.style.backgroundImage).toContain(VCS_ICON_PNG.slice(0, 40));
    expect(entry!.children.length).toBe(0);
    entry!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const win = () => ui.hudContainer.querySelector<HTMLElement>('[data-vtank-aux="vcs"]')!;
    expect(win()).not.toBeNull();
    expect(win().querySelector<HTMLElement>('[data-vvs-title-icon]')?.dataset.vvsTitleIcon).toBe('image');
    expect(Array.from(win().querySelectorAll<HTMLElement>('[data-vcs-tab]')).map((t) => t.dataset.vcsTab)).toEqual(['Presets', 'Patterns', 'Actions']);
    // VTank's six rows come before AC's four.
    const rows = Array.from(win().querySelectorAll<HTMLElement>('[data-vcs-preset]')).map((r) => r.dataset.vcsPreset);
    expect(rows.slice(0, 6)).toEqual(VCS_VTANK_PRESETS.map((p) => `VTank.${p.category}`));
    expect(rows.slice(-4)).toEqual(VCS_AC_PRESETS.map((p) => `AC.${p.category}`));
    ui.vcs.unsetPreset('VTank', 'Warnings');
    win().querySelector<HTMLElement>('[data-vcs-preset="VTank.Warnings"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const m = win().querySelector<HTMLElement>('[data-vcs-window="1"]')!;
    m.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(ui.vcs.preset('VTank', 'Warnings')?.windows).toEqual([1]);
    expect(win().querySelector<HTMLElement>('[data-vcs-preset="VTank.Warnings"]')!.dataset.selected).toBe('1');
    win().querySelector<HTMLElement>('[data-vcs="unset"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(ui.vcs.preset('VTank', 'Warnings')).toBeNull();

    win().querySelector<HTMLElement>('[data-vcs-tab="Patterns"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    ui.vcs.update((s) => { s.patterns = []; });
    const type = (sel: string, v: string) => { const i = win().querySelector<HTMLInputElement>(`[data-vcs="${sel}"]`)!; i.value = v; i.dispatchEvent(new Event('input')); };
    type('pattern-text', '*Asheron*');
    type('pattern-windows', '2');
    type('pattern-action', '0');
    win().querySelector<HTMLElement>('[data-vcs="pattern-create"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(ui.vcs.settings().patterns).toEqual([{ pattern: '*Asheron*', regex: false, patternColor: 'Any', changeTo: 'Any', windows: [2], action: 0 }]);
    expect(win().querySelector('[data-vcs-pattern="0"]')).not.toBeNull();

    win().querySelector<HTMLElement>('[data-vcs-tab="Actions"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    type('action-id', '7');
    type('action-tell', 'Alt');
    win().querySelector<HTMLElement>('[data-vcs="action-create"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(ui.vcs.action(7)).toMatchObject({ id: 7, tellTarget: 'Alt', chatboxDo: '' });
    win().querySelector<HTMLElement>('[data-vcs-delete="7"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(ui.vcs.action(7)).toBeNull();

    ui.toggleVcsWindow();
    expect(ui.hudContainer.querySelector('[data-vtank-aux="vcs"]')).toBeNull();
    ui.toggleAutomationWindow();
    ui.setPreviewFeatures(false);
    ui.setAutomationSource(null);
  });
});
