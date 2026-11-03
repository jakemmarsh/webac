/**
 * webac#18 — Enable Decal Plugins: the Config page's UI Options switch for the plugin bar and every plugin
 * window, hotkey and chat command (ui/automation/DecalPlugins.ts).
 * - its default is the era's (EraClientRules.decalPlugins): on for end of retail and every classic era, off
 *   for AC1999;
 * - the choice is kept per era in browser storage, never in the every-era options blob or on the server;
 * - off, the bar, the windows, the VHS hotkeys and the HUD strip are gone, and turning it back on (the Config
 *   row) brings the bar back without a reload; Defaults restores the era's default.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import { ERA_PROFILES, eraProfile } from '../packages/renderer/src/era/EraProfiles.js';
import { eraClientRules } from '../packages/renderer/src/era/EraFeatures.js';
import {
  DECAL_PLUGINS_LABEL, DECAL_PLUGINS_OPTION_KEY, decalPluginsStoreKey, readDecalPlugins, writeDecalPlugins,
} from '../packages/renderer/src/ui/automation/DecalPlugins.js';
import { emptyRoutineDoc } from '../packages/shared/src/routines/index.js';
import type { VTankSource } from '../packages/renderer/src/ui/automation/VTankWindow.js';

describe('the era default (EraClientRules.decalPlugins)', () => {
  it('is off for AC1999 and on for end of retail and every classic era', () => {
    for (const p of Object.values(ERA_PROFILES)) {
      expect(eraClientRules(p).decalPlugins, p.id).toBe(p.login.protocol !== 'ac1999');
    }
    expect(eraClientRules(eraProfile('ac1999-retail')).decalPlugins).toBe(false);
    expect(eraClientRules(eraProfile('eor')).decalPlugins).toBe(true);
    expect(eraClientRules(eraProfile('classicace-customdm')).decalPlugins).toBe(true);
    expect(eraClientRules(null).decalPlugins).toBe(true);
  });
});

describe('the kept choice (readDecalPlugins / writeDecalPlugins)', () => {
  function memStore(): Storage {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear(), key: () => null, get length() { return m.size; } } as Storage;
  }
  it('reads the era default until the player chooses, then the choice, per era', () => {
    const s = memStore();
    expect(readDecalPlugins(() => s, 'ac1999-retail', false)).toBe(false);
    expect(readDecalPlugins(() => s, 'eor', true)).toBe(true);
    writeDecalPlugins(() => s, 'ac1999-retail', true);
    expect(s.getItem(decalPluginsStoreKey('ac1999-retail'))).toBe('on');
    expect(readDecalPlugins(() => s, 'ac1999-retail', false)).toBe(true);
    // Another era keeps its own default.
    expect(readDecalPlugins(() => s, 'eor', true)).toBe(true);
    writeDecalPlugins(() => s, 'eor', false);
    expect(readDecalPlugins(() => s, 'eor', true)).toBe(false);
    expect(readDecalPlugins(() => s, 'ac1999-retail', false)).toBe(true);
  });
  it('blocked or junk storage reads the default and never throws', () => {
    const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } } as unknown as Storage;
    expect(readDecalPlugins(() => throwing, 'eor', true)).toBe(true);
    expect(readDecalPlugins(() => null, 'ac1999-retail', false)).toBe(false);
    expect(() => writeDecalPlugins(() => throwing, 'eor', false)).not.toThrow();
    const s = memStore();
    s.setItem(decalPluginsStoreKey('eor'), 'maybe');
    expect(readDecalPlugins(() => s, 'eor', true)).toBe(true);
  });
});

/** A routine source enough for the VirindiTank window to load. */
function source(onStop?: () => void): VTankSource {
  const status = { running: false, paused: false, profile: null as string | null, state: null, acting: null, last: [] };
  const base: Record<string, unknown> = {
    load: async () => ({ ok: true, doc: emptyRoutineDoc('local-eor', 'tester') }),
    save: async (d: unknown) => ({ ok: true, doc: d }),
    status: () => status, stats: () => ({ startedAt: 0, xpGained: 0, kills: 0, deaths: 0, kept: 0, left: 0, sold: 0, rebuffs: 0, stateTime: {} }),
    current: () => null, character: () => 'Tester', coords: () => null, now: () => 0, items: () => [], spells: () => [], buffs: () => [], history: () => [],
    setting: () => undefined, report: () => {}, spellTable: () => null, selection: () => null,
    stop: () => { status.running = false; onStop?.(); return { ok: true, message: '' }; },
    __status: status,
  };
  return new Proxy(base, { get: (t, k) => (k in t ? t[k as string] : () => ({ ok: true, message: '' })) }) as unknown as VTankSource;
}

const PAGE_IDS = [0x10000208, 0x10000210, 0x10000211, 0x10000212, 0x10000213, 0x1000050c, 0x1000020d, 0x1000020e, 0x1000050b, 0x1000020f];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stubOptionsLayout(ui: any, doc: Document): void {
  ui.layoutRenderer = {
    renderPanel: (_id: number, parent: HTMLElement) => {
      const root = doc.createElement('div');
      parent.appendChild(root);
      const elements = new Map<number, HTMLElement>();
      for (const id of PAGE_IDS) {
        const el = doc.createElement('div');
        root.appendChild(el);
        elements.set(id, el);
        if (id === 0x10000211) {
          for (const bid of [0x100001fc, 0x100001fd, 0x100001fe]) {
            const btn = doc.createElement('div');
            btn.dataset.elementId = `0x${bid.toString(16)}`;
            el.appendChild(btn);
          }
        }
      }
      return { root, elements, setState: () => {}, setText: () => {}, setInteractive: () => {}, setVisible: () => {}, setTexture: () => {}, onClick: () => {}, resizeSubtree: () => {}, close: () => { root.remove(); } };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    render: (id: number, parent: HTMLElement) => (ui.layoutRenderer as any).renderPanel(id, parent),
  };
  ui.callbacks.onCharacterOptionToggle = () => { throw new Error('Enable Decal Plugins must never reach the server'); };
}

let H: GameUIFixture;
beforeAll(async () => { H = await mountGameUI(); });
afterAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ui = H.ui as any;
  ui.setAutomationSource(null);
  ui.setClientRules(eraClientRules(null));
  H.teardown();
});

describe('GameUI: Enable Decal Plugins', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ui = () => H.ui as any;
  const bar = () => ui().hudContainer.querySelector('[data-vvs-bar]') as HTMLElement | null;
  const vtWin = () => ui().hudContainer.querySelector('[data-vtank-window]') as HTMLElement | null;
  const store = () => H.win.localStorage as Storage;
  function enter(eraId: string): void {
    ui().setClientRules(eraClientRules(eraProfile(eraId)));
    ui().setDecalPluginsEra(eraId);
    ui().setAutomationSource(source());
  }
  function openConfig(): void {
    stubOptionsLayout(ui(), H.win.document);
    if (ui().optionsPanelVisible) ui().toggleOptionsPanel();
    ui().optionsTab = 'config';
    ui().optionsSettings.optionsTab = 'config';
    ui().toggleOptionsPanel();
    expect(ui().optionsPanelVisible).toBe(true);
  }
  const row = () => ui().optionsPanel?.querySelector(`[data-option-key="${DECAL_PLUGINS_OPTION_KEY}"]`) as HTMLElement | null;
  const clickRow = () => row()!.dispatchEvent(new H.win.MouseEvent('click', { bubbles: true }));

  it('end of retail: on with nothing kept — the bar is up, the window opens, /vt and the hotkeys are live', () => {
    store().clear();
    enter('eor');
    expect(ui().decalPluginsOn).toBe(true);
    expect(ui().automationAvailable).toBe(true);
    expect(bar()).not.toBeNull();
    ui().toggleAutomationWindow();
    expect(vtWin()).not.toBeNull();
    ui().toggleAutomationWindow();
    // Reading the era keeps nothing: the default stays the default until the player chooses.
    expect(store().getItem(decalPluginsStoreKey('eor'))).toBeNull();
  });

  it('a classic era is on by default too', () => {
    store().clear();
    enter('classic-dereth');
    expect(ui().decalPluginsOn).toBe(true);
    expect(bar()).not.toBeNull();
  });

  it('AC1999: off by default — no bar, no window, no /vt, no hotkeys, no strip, no meta views', () => {
    store().clear();
    enter('ac1999-retail');
    expect(ui().decalPluginsOn).toBe(false);
    expect(ui().automationAvailable).toBe(false);
    expect(bar()).toBeNull();
    ui().toggleAutomationWindow();
    expect(vtWin()).toBeNull();
    ui().toggleAutomationPanel();
    expect(ui().automationPanelVisible).toBe(false);
    expect(ui().automationHotkey('F5')).toBe(false);
    ui().openMetaView('v', { title: 'View', width: 50, height: 20, buttons: [] }, () => {});
    expect(ui().hudContainer.querySelector('[data-meta-view]')).toBeNull();
  });

  it('AC1999: the Config page\'s UI Options row turns them on without a reload, kept for AC1999 only', () => {
    store().clear();
    enter('ac1999-retail');
    openConfig();
    const r = row();
    expect(r).not.toBeNull();
    expect(r!.dataset.optionOn).toBe('0');
    expect(DECAL_PLUGINS_LABEL).toBe('Enable Decal Plugins');
    // It closes the UI Options section: after the chat font menus.
    const keys = Array.from(ui().optionsPanel.querySelectorAll('[data-option-key]')).map((e) => (e as HTMLElement).dataset.optionKey);
    expect(keys.slice(-3)).toEqual(['chatFontFace', 'chatFontSize', DECAL_PLUGINS_OPTION_KEY]);
    clickRow();
    expect(ui().decalPluginsOn).toBe(true);
    expect(row()!.dataset.optionOn).toBe('1');
    expect(bar()).not.toBeNull();
    expect(ui().automationAvailable).toBe(true);
    ui().toggleAutomationWindow();
    expect(vtWin()).not.toBeNull();
    expect(store().getItem(decalPluginsStoreKey('ac1999-retail'))).toBe('on');
    expect(store().getItem(decalPluginsStoreKey('eor'))).toBeNull();
    // Not in the every-era options blob.
    const blob = JSON.parse(store().getItem('ac_options_settings_v1') ?? '{}') as Record<string, unknown>;
    expect(DECAL_PLUGINS_OPTION_KEY in blob).toBe(false);

    // Off again: the open window and the bar go at once, and a running macro of the player's stops.
    const stops: number[] = [];
    const src = source(() => stops.push(1));
    ui().setAutomationSource(src);
    (src as unknown as { __status: { running: boolean } }).__status.running = true;
    ui().toggleAutomationWindow();
    expect(vtWin()).not.toBeNull();
    clickRow();
    expect(ui().decalPluginsOn).toBe(false);
    expect(vtWin()).toBeNull();
    expect(bar()).toBeNull();
    expect(stops).toEqual([1]);
    expect(store().getItem(decalPluginsStoreKey('ac1999-retail'))).toBe('off');
  });

  it('a kept choice wins over the default at the next load, and Defaults restores the era default', () => {
    store().clear();
    writeDecalPlugins(() => store(), 'ac1999-retail', true);
    enter('ac1999-retail');
    expect(ui().decalPluginsOn).toBe(true);
    expect(bar()).not.toBeNull();
    openConfig();
    const defaults = ui().optionsPanel.querySelector('[data-element-id="0x100001fe"]') as HTMLElement;
    defaults.dispatchEvent(new H.win.MouseEvent('click', { bubbles: true }));
    expect(ui().decalPluginsOn).toBe(false);
    expect(bar()).toBeNull();
    expect(store().getItem(decalPluginsStoreKey('ac1999-retail'))).toBe('off');

    // End of retail kept off stays off; its Defaults turns it back on.
    store().clear();
    writeDecalPlugins(() => store(), 'eor', false);
    enter('eor');
    expect(bar()).toBeNull();
    openConfig();
    (ui().optionsPanel.querySelector('[data-element-id="0x100001fe"]') as HTMLElement).dispatchEvent(new H.win.MouseEvent('click', { bubbles: true }));
    expect(ui().decalPluginsOn).toBe(true);
    expect(bar()).not.toBeNull();
  });

  it('no row where this client has no plugins (no automation source)', () => {
    store().clear();
    enter('eor');
    ui().setAutomationSource(null);
    openConfig();
    expect(row()).toBeNull();
  });
});
