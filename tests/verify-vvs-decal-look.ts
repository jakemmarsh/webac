/**
 * The plugin windows drawn as Decal + Virindi Views drew them (2026-10-12, docs/automation-vtank-window.md
 * "Text", "Virindi Views' bar", "UtilityBelt's window", "The loot editor's look"):
 * - VVS's Times New Roman text with Windows' whole-pixel layout (ui/automation/vvsText.ts);
 * - VVS's bar of plugin icons (VvsBar.ts) and GameUI's entries for it;
 * - UtilityBelt's own main window (UbMainWindow.ts) at its view XML's places;
 * - VTClassic's loot editor in a Windows form's parts and frame;
 * - UB's nametags in Arial (scene/Nametags.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import { VVS_COLORS, VVS_FONT_FACE, VVS_TAB_PX, VVS_TEXT_PX, renderVvsText, vvsGlyphXs, vvsLineHeight, vvsWrap } from '../packages/renderer/src/ui/automation/vvsText.js';
import { VVS_BAR, renderVvsBar, vvsBarLayout, type VvsBarEntry } from '../packages/renderer/src/ui/automation/VvsBar.js';
import { UB_MAIN_BUTTONS, UB_MAIN_SIZE, UB_TOGGLE_OVERLAY, renderUbMainWindow, ubMainButtons, type UbMainSource } from '../packages/renderer/src/ui/automation/UbMainWindow.js';
import { NAMETAG_FONT_FACE, NAMETAG_FONT_PX, nametagTextCanvas, nametagTextureFromCanvas } from '../packages/renderer/src/scene/Nametags.js';
import { emptyRoutineDoc } from '../packages/shared/src/routines/index.js';
import type { VTankKit, VTankSource } from '../packages/renderer/src/ui/automation/VTankWindow.js';
import * as THREE from 'three';

let H: GameUIFixture;
beforeAll(async () => { H = await mountGameUI(); });
afterAll(() => H.teardown());

describe('VVS text (vvsText.ts)', () => {
  it('is Times New Roman, 11 px with 9 px tabs, in the screenshots\' colours', () => {
    expect(VVS_FONT_FACE.startsWith('"Times New Roman"')).toBe(true);
    expect([VVS_TEXT_PX, VVS_TAB_PX]).toEqual([11, 9]);
    expect(VVS_COLORS).toEqual({ text: 'rgb(255, 255, 255)', tabOn: 'rgb(218, 165, 32)', tabOff: 'rgb(128, 128, 128)', line: 'rgb(143, 120, 84)' });
  });

  it('places letters at whole pixels, advances rounded up, a space half the font size', () => {
    const adv = (ch: string) => ({ M: 9.78, o: 5.5, n: 5.5 } as Record<string, number>)[ch] ?? 4;
    expect(vvsGlyphXs('Mon', adv, 11)).toEqual([0, 10, 16, 22]);
    expect(vvsGlyphXs('o n', adv, 11)).toEqual([0, 6, 12, 18]);
    // A whole advance stays whole (no float creep past the integer).
    expect(vvsGlyphXs('xx', () => 5.0000001, 11)).toEqual([0, 5, 10]);
  });

  it('wraps by words and keeps a long word whole; line height is Times New Roman\'s ascent + descent', () => {
    const measure = (s: string) => s.length * 5;
    expect(vvsWrap('one two three', 40, measure)).toEqual(['one two', 'three']);
    expect(vvsWrap('unbreakableword', 20, measure)).toEqual(['unbreakableword']);
    expect(vvsLineHeight(11)).toBe(13);
  });

  it('a run carries its text and size, and grows a pixel for a shadow', () => {
    const plain = renderVvsText('Force Buff');
    expect(plain.dataset.acRunText).toBe('Force Buff');
    expect(plain.dataset.vvsText).toBe('11');
    const shadowed = renderVvsText('Force Buff', VVS_COLORS.text, { shadow: 'rgb(0, 0, 0)' });
    expect(shadowed.height).toBe(plain.height + 1);
    expect(shadowed.width).toBe(plain.width + 1);
    expect(renderVvsText('Options', VVS_COLORS.tabOn, { px: VVS_TAB_PX }).dataset.vvsText).toBe('9');
  });
});

describe('VVS\'s bar (VvsBar.ts)', () => {
  it('lays icons out as the Decal theme: from x 3, 20 apart within a plugin, a 2 px rule with 2 px gaps between plugins', () => {
    const l = vvsBarLayout([{ plugin: 'A' }, { plugin: 'B' }, { plugin: 'B' }, { plugin: 'C' }]);
    expect(l.icons).toEqual([3, 26, 46, 69]);
    expect(l.rules).toEqual([22, 65]);
    expect(l.width).toBe(69 + 16 + 3);
    expect(VVS_BAR.height).toBe(22);
  });

  it('marks open windows, shows VVS\'s coral box for a view without an icon, and toggles on a click', () => {
    const host = document.createElement('div');
    const clicked: string[] = [];
    const entries: VvsBarEntry[] = [
      { id: 'vtank', plugin: 'VirindiTank', title: 'Automation', icon: null, open: true, toggle: () => clicked.push('vtank') },
      { id: 'map', plugin: 'UtilityBelt', title: 'Landscape Maps', icon: { dat: 0x060033c1 }, open: false, toggle: () => clicked.push('map') },
    ];
    renderVvsBar(host, entries, (id) => `dat:${id.toString(16)}`);
    const vt = host.querySelector('[data-vvs-bar-entry="vtank"]') as HTMLElement;
    const map = host.querySelector('[data-vvs-bar-entry="map"]') as HTMLElement;
    expect(vt.dataset.open).toBe('1');
    expect(vt.style.background).toContain('136, 138, 133');
    expect((vt.firstElementChild as HTMLElement).style.background).toContain('255, 127, 80');
    expect(map.dataset.open).toBe('0');
    expect(map.style.backgroundImage).toContain('dat:60033c1');
    map.click();
    vt.click();
    expect(clicked).toEqual(['map', 'vtank']);
  });
});

/** A kit that records what it draws. */
function recordKit(): VTankKit {
  const div = (data: Record<string, string>, onClick?: () => void) => { const d = document.createElement('div'); Object.assign(d.dataset, data); if (onClick) d.addEventListener('click', onClick); return d; };
  return {
    text: (t: string) => div({ text: t }),
    textTab: (label: string, on: boolean, onClick: () => void) => div({ tab: label, selected: on ? '1' : '0' }, onClick),
    flatButton: (label: string, onClick: () => void, w: number, h?: number) => div({ button: label, w: String(w), h: String(h ?? 20) }, onClick),
    icon: (id: number) => div({ icon: `0x${id.toString(16)}` }),
  } as unknown as VTankKit;
}

describe('UtilityBelt\'s window (UbMainWindow.ts)', () => {
  it('has MainView.xml\'s Main page: 400 × 270, its buttons and settings', () => {
    expect(UB_MAIN_SIZE).toEqual({ w: 400, h: 270 });
    expect(UB_MAIN_BUTTONS.find((b) => b.name === 'LandscapeMapsEnabled')).toMatchObject({ text: '   Landscape Maps', left: 144, top: 40, width: 110, height: 24, setting: 'LandscapeMaps.Enabled' });
    expect(UB_TOGGLE_OVERLAY).toEqual({ x: 3, y: 4, size: 16, on: 0x060069a1, off: 0x060011f8 });
  });

  it('draws only the buttons whose feature this port has, each with its on / off overlay; a click flips it and says UB\'s line', async () => {
    const values: Record<string, boolean> = { 'AutoVendor.Enabled': true, 'Nametags.Enabled': false };
    const said: string[][] = [];
    let redraws = 0;
    const src: UbMainSource = {
      has: (s) => s in values,
      value: (s) => values[s]!,
      toggle: (s) => { values[s] = !values[s]; return [`${s} = ${values[s]}`]; },
    };
    expect(ubMainButtons(src).map((b) => b.name)).toEqual(['AutoVendorEnable', 'NameTagsEnabled']);
    const body = document.createElement('div');
    renderUbMainWindow(body, recordKit(), src, () => { redraws++; }, (l) => said.push(l));
    expect(body.querySelector('[data-ub-tab="Main"]')).not.toBeNull();
    const av = body.querySelector('[data-ub-button="AutoVendorEnable"]') as HTMLElement;
    expect([av.style.left, av.style.top, av.dataset.on]).toEqual(['8px', '8px', '1']);
    expect((av.querySelector('[data-icon]') as HTMLElement).dataset.icon).toBe('0x60069a1');
    const nt = body.querySelector('[data-ub-button="NameTagsEnabled"]') as HTMLElement;
    expect((nt.querySelector('[data-icon]') as HTMLElement).dataset.icon).toBe('0x60011f8');
    nt.click();
    await Promise.resolve(); await Promise.resolve();
    expect(values['Nametags.Enabled']).toBe(true);
    expect(said).toEqual([['Nametags.Enabled = true']]);
    expect(redraws).toBe(1);
  });
});

/** A routine source enough for the VirindiTank window to load. */
function source(): VTankSource {
  const status = { running: false, paused: false, profile: null, state: null, acting: null, last: [] };
  const base: Record<string, unknown> = {
    load: async () => ({ ok: true, doc: emptyRoutineDoc('local-eor', 'tester') }),
    save: async (d: unknown) => ({ ok: true, doc: d }),
    status: () => status, stats: () => ({ startedAt: 0, xpGained: 0, kills: 0, deaths: 0, kept: 0, left: 0, sold: 0, rebuffs: 0, stateTime: {} }),
    current: () => null, character: () => 'Tester', coords: () => null, now: () => 0, items: () => [], spells: () => [], buffs: () => [], history: () => [],
    setting: () => undefined, report: () => {}, spellTable: () => null, selection: () => null,
  };
  return new Proxy(base, { get: (t, k) => (k in t ? t[k as string] : () => ({ ok: true, message: '' })) }) as unknown as VTankSource;
}

type Ui = {
  setAutomationSource(s: VTankSource | null): void;
  setUbSettings(s: unknown): void;
  setUbMaps(m: unknown): void;
  toggleAutomationWindow(): void;
  toggleVvsBar(): string;
  refreshVvsBar(): void;
  hudContainer: HTMLElement;
};

describe('GameUI: the bar, UB\'s window and the windows\' VVS text', () => {
  it('the bar is up from login for a preview player, lists the plugins\' windows, and opens UB\'s window', async () => {
    const ui = H.ui as unknown as Ui;
    try { globalThis.localStorage?.removeItem('acjs.vvsBar'); } catch { /* none */ }
    const settings: Record<string, boolean> = { 'AutoVendor.Enabled': true, 'DungeonMaps.Enabled': true, 'LandscapeMaps.Enabled': true };
    const store = {
      name: (n: string) => Object.keys(settings).find((k) => k.toLowerCase() === n.toLowerCase()) ?? null,
      get: (n: string) => settings[n],
      bool: (n: string) => settings[n] === true,
      setValue: (k: string, v: boolean) => { settings[k] = v; },
      display: (k: string) => `${k} = ${settings[k]}`,
    };
    const closed: string[] = [];
    const open = new Set<string>();
    ui.setUbSettings(store);
    ui.setUbMaps({ toggle: (w: string) => { if (open.has(w)) open.delete(w); else open.add(w); return ''; }, closeAll: () => {}, close: (w: string) => { closed.push(w); open.delete(w); }, isOpen: (w: string) => open.has(w) });
    ui.setAutomationSource(source());
    // The bar is preview UI (the bridge's BRIDGE_PREVIEW_ACCOUNTS); verify-virindi-reporter.ts tests the gate.
    (ui as unknown as { setPreviewFeatures(on: boolean): void }).setPreviewFeatures(true);
    const bar = () => ui.hudContainer.querySelector('[data-vvs-bar]') as HTMLElement | null;
    // Up before any plugin window has opened (Jake, 2026-10-13: "i dont even see it").
    expect(bar()).not.toBeNull();
    ui.toggleAutomationWindow();
    await new Promise((r) => setTimeout(r, 10));
    const ids = () => Array.from(bar()!.querySelectorAll('[data-vvs-bar-entry]')).map((e) => `${(e as HTMLElement).dataset.vvsBarEntry}:${(e as HTMLElement).dataset.open}`);
    expect(ids()).toEqual(['vtank:1', 'vhs:0', 'ub:0', 'ub-dungeon:0', 'ub-landscape:0', 'vcs:0']);

    // The VirindiTank window's text is VVS's.
    const win = ui.hudContainer.querySelector('[data-vtank-window]') as HTMLElement;
    expect(win.querySelector('[data-vvs-text="11"][data-ac-run-text="Automation"]')).not.toBeNull();
    expect(win.querySelector('[data-tab="Options"]')?.getAttribute('data-vvs-text')).toBe('9');
    expect(win.querySelector('[data-vtank="ub-dungeon-maps"]')).toBeNull();

    // UB's window from its icon: turning Dungeon Maps off takes it off the bar and closes its window.
    (bar()!.querySelector('[data-vvs-bar-entry="ub"]') as HTMLElement).click();
    const ubWin = ui.hudContainer.querySelector('[data-vtank-aux="ub-main"]') as HTMLElement;
    expect(ubWin).not.toBeNull();
    expect(ids()[2]).toBe('ub:1');
    (ubWin.querySelector('[data-ub-button="DungeonMapsEnabled"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(settings['DungeonMaps.Enabled']).toBe(false);
    expect(closed).toEqual(['dungeon']);
    expect(ids()).toEqual(['vtank:1', 'vhs:0', 'ub:1', 'ub-landscape:0', 'vcs:0']);

    // /automation bar hides it, and again shows it.
    expect(ui.toggleVvsBar()).toMatch(/hidden/);
    expect(bar()).toBeNull();
    expect(ui.toggleVvsBar()).toMatch(/shown/);
    expect(bar()).not.toBeNull();
    // Hidden stays hidden across a refresh and opening a window (kept as 'off').
    expect(ui.toggleVvsBar()).toMatch(/hidden/);
    ui.refreshVvsBar();
    expect(bar()).toBeNull();
    expect(globalThis.localStorage?.getItem('acjs.vvsBar')).toBe('off');
    expect(ui.toggleVvsBar()).toMatch(/shown/);
    // Either order at login: the preview flag before the automation source still draws it.
    ui.setAutomationSource(null);
    expect(bar()).toBeNull();
    ui.setAutomationSource(source());
    expect(bar()).not.toBeNull();
    ui.setAutomationSource(null);
    ui.setUbSettings(null);
    ui.setUbMaps(null);
  });

  it('the bar and open plugin windows survive the world\'s HUD build (drawn before it at login)', async () => {
    const ui = H.ui as unknown as Ui & { showGame(): void; toggleHotkeysForTest?: never };
    try { globalThis.localStorage?.removeItem('acjs.vvsBar'); } catch { /* none */ }
    ui.setAutomationSource(source());
    (ui as unknown as { setPreviewFeatures(on: boolean): void }).setPreviewFeatures(true);
    ui.toggleAutomationWindow();
    await new Promise((r) => setTimeout(r, 10));
    // Entering the world rebuilds the HUD layer (renderHUD empties it).
    ui.showGame();
    const bar = ui.hudContainer.querySelector('[data-vvs-bar]') as HTMLElement | null;
    expect(bar?.isConnected).toBe(true);
    expect(ui.hudContainer.querySelector('[data-vtank-window]')).not.toBeNull();
    expect((bar!.querySelector('[data-vvs-bar-entry="vtank"]') as HTMLElement).dataset.open).toBe('1');
    ui.setAutomationSource(null);
  });

  it('the loot editor opens in a Windows program\'s frame, drawn with a Windows form\'s parts', async () => {
    const ui = H.ui as unknown as Ui & { vtankKit(): VTankKit };
    ui.setAutomationSource(source());
    const desk = ui.vtankKit().desktop!();
    expect(desk.colors.text).toBe('rgb(0, 0, 0)');
    const b = desk.flatButton('Move Up', () => {}, 78, 20);
    expect(b.style.background).toContain('253, 253, 253');
    expect(b.textContent).toBe('Move Up');
    const c = desk.check(true, () => {});
    expect((c as HTMLInputElement).type).toBe('checkbox');
    expect(desk.menuLabel).toBeTypeOf('function');
    ui.setAutomationSource(null);
  });
});

describe('UB\'s nametags (scene/Nametags.ts)', () => {
  it('are Arial, as UB asks Decal for (MarkObjectWith3DText(…, "Arial", 0)), drawn large and filtered smoothly', () => {
    expect(NAMETAG_FONT_FACE.startsWith('Arial')).toBe(true);
    expect(NAMETAG_FONT_PX).toBe(48);
    const c = nametagTextCanvas('Sparring Golem [1]', 'rgb(255, 0, 0)');
    if (c) expect(c.height).toBe(Math.ceil(48 * 1.117));
    const t = nametagTextureFromCanvas({ width: 40, height: 10 } as unknown as HTMLCanvasElement);
    expect(t.texture.magFilter).toBe(THREE.LinearFilter);
  });
});
