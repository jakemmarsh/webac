/**
 * BUG.ac1999-environment-detail-default — each era's option defaults come from that era's client
 * (EraClientRules.optionDefaults / configDefaultsKeep / characterDefaultsWord), and the keys some era
 * defaults differently are kept per era (ui/EraOptionPrefs.ts).
 *
 * - Environment Detail Textures: end of retail (and the classic eras, its exe) start it on
 *   (Render::m_RenderPrefs @ 0x81ef90, SetDefaultValue(1)); the 1999 client off (0x0042c236 zeroes the
 *   detail flags when its registry blob is missing).
 * - Existing players: a value an earlier build wrote to the every-era blob that equals the old default
 *   (true) is "never chosen" and reads as the era's default; a false can only be the player's choice
 *   and is kept, in every era.
 * - The 1999 Performance panel's Defaults leaves the Detail Texture checkboxes and texture menus alone
 *   (PerformancePanel_Reset(1) @ 0x00598a70); end of retail's restores them.
 * - The 1999 Character page's Defaults writes options_ 0xE56A (CharOptionsPanel_Reset(1) @ 0x005948a0):
 *   the same as end of retail's per-row defaults on every 1999 row except Right-click mouselook (on).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import { ERA_PROFILES, eraProfile } from '../packages/renderer/src/era/EraProfiles.js';
import { ERA_DEFAULTED_OPTION_KEYS, eraClientRules } from '../packages/renderer/src/era/EraFeatures.js';
import {
  eraCharacterPageDefaults, eraOptionsStoreKey, readEraOptionValues, writeEraOptionValues,
} from '../packages/renderer/src/ui/EraOptionPrefs.js';
import { CHARACTER_SETTINGS_ROWS } from '../packages/renderer/src/ui/CharacterSettingsModel.js';
import {
  AC1999_TEXTURE_DETAIL_MENU, eraOffersHighResTextures, eraTextureDetail, eraTexturePrefs,
} from '../packages/renderer/src/era/EraWorldRules.js';
import {
  TextureSamplerPrefs, environmentDetailShift, landscapeMergedSize, retailLandscapeShift,
} from '../packages/renderer/src/models/TextureSamplerPrefs.js';

const R1999 = eraClientRules(eraProfile('ac1999-retail'));
const EOR = eraClientRules(eraProfile('eor'));
const CLASSIC_IDS = Object.values(ERA_PROFILES).filter((p) => p.id !== 'eor' && p.login.protocol !== 'ac1999').map((p) => p.id);
const UNIVERSAL = { buildingDetailTextures: true, landscapeTextureDetail: 2 } as const;
const UNIVERSAL_ALL = { buildingDetailTextures: true, landscapeTextureDetail: 2, environmentTextureDetail: 1 } as const;

function memStore(): Storage {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear(), key: () => null, get length() { return m.size; } } as Storage;
}

describe('the era rules', () => {
  it('1999 defaults Environment Detail Textures off; end of retail and every classic era keep end of retail\'s', () => {
    expect(R1999.optionDefaults).toEqual({ buildingDetailTextures: false, landscapeTextureDetail: 1, environmentTextureDetail: 1 });
    expect(EOR.optionDefaults).toEqual({});
    expect(CLASSIC_IDS.length).toBeGreaterThan(0);
    for (const id of CLASSIC_IDS) {
      const r = eraClientRules(eraProfile(id));
      expect(r.optionDefaults, id).toEqual({});
      expect(r.configDefaultsKeep, id).toEqual([]);
      expect(r.characterDefaultsWord, id).toBeNull();
      expect(r.configDefaultsValues, id).toEqual({});
    }
    expect(ERA_DEFAULTED_OPTION_KEYS).toEqual(['buildingDetailTextures', 'landscapeTextureDetail', 'environmentTextureDetail']);
  });
  it('the 1999 Defaults buttons: the detail checkboxes and texture menus kept; options_ 0xE56A', () => {
    expect([...R1999.configDefaultsKeep].sort()).toEqual(
      ['buildingDetailTextures', 'environmentTextureDetail', 'landscapeDetailTextures', 'landscapeTextureDetail']);
    expect(R1999.characterDefaultsWord).toBe(0xe56a);
    expect(EOR.configDefaultsKeep).toEqual([]);
    expect(EOR.characterDefaultsWord).toBeNull();
  });
});

describe('readEraOptionValues / writeEraOptionValues', () => {
  const keys = ['buildingDetailTextures'];
  const d1999 = { buildingDetailTextures: false };
  it('a fresh profile reads each era\'s default', () => {
    const s = memStore();
    expect(readEraOptionValues(() => s, 'ac1999-retail', keys, d1999, UNIVERSAL, null)).toEqual({ buildingDetailTextures: false });
    expect(readEraOptionValues(() => s, 'eor', keys, {}, UNIVERSAL, null)).toEqual({ buildingDetailTextures: true });
  });
  it('a legacy value equal to the old every-era default is "never chosen": the era default wins', () => {
    const s = memStore();
    const legacy = { buildingDetailTextures: true };
    expect(readEraOptionValues(() => s, 'ac1999-retail', keys, d1999, UNIVERSAL, legacy).buildingDetailTextures).toBe(false);
    expect(readEraOptionValues(() => s, 'eor', keys, {}, UNIVERSAL, legacy).buildingDetailTextures).toBe(true);
  });
  it('a legacy value off the old default is the player\'s choice: kept in every era', () => {
    const s = memStore();
    const legacy = { buildingDetailTextures: false };
    expect(readEraOptionValues(() => s, 'ac1999-retail', keys, d1999, UNIVERSAL, legacy).buildingDetailTextures).toBe(false);
    expect(readEraOptionValues(() => s, 'eor', keys, {}, UNIVERSAL, legacy).buildingDetailTextures).toBe(false);
    expect(readEraOptionValues(() => s, 'classic-dereth', keys, {}, UNIVERSAL, legacy).buildingDetailTextures).toBe(false);
  });
  it('once an era has its own entry, it decides (missing = the era default), and only off-default values are kept', () => {
    const s = memStore();
    const legacy = { buildingDetailTextures: false };
    writeEraOptionValues(() => s, 'eor', keys, {}, UNIVERSAL, { buildingDetailTextures: true });
    expect(s.getItem(eraOptionsStoreKey('eor'))).toBe('{}');
    expect(readEraOptionValues(() => s, 'eor', keys, {}, UNIVERSAL, legacy).buildingDetailTextures).toBe(true);
    writeEraOptionValues(() => s, 'ac1999-retail', keys, d1999, UNIVERSAL, { buildingDetailTextures: true });
    expect(JSON.parse(s.getItem(eraOptionsStoreKey('ac1999-retail'))!)).toEqual({ buildingDetailTextures: true });
    expect(readEraOptionValues(() => s, 'ac1999-retail', keys, d1999, UNIVERSAL, null).buildingDetailTextures).toBe(true);
    // The other era is untouched.
    expect(readEraOptionValues(() => s, 'eor', keys, {}, UNIVERSAL, null).buildingDetailTextures).toBe(true);
  });
  it('junk, mistyped or blocked storage reads the defaults and never throws', () => {
    const s = memStore();
    s.setItem(eraOptionsStoreKey('ac1999-retail'), 'not json');
    expect(readEraOptionValues(() => s, 'ac1999-retail', keys, d1999, UNIVERSAL, null).buildingDetailTextures).toBe(false);
    s.setItem(eraOptionsStoreKey('ac1999-retail'), JSON.stringify({ buildingDetailTextures: 'yes' }));
    expect(readEraOptionValues(() => s, 'ac1999-retail', keys, d1999, UNIVERSAL, null).buildingDetailTextures).toBe(false);
    const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } } as unknown as Storage;
    expect(readEraOptionValues(() => throwing, 'eor', keys, {}, UNIVERSAL, null).buildingDetailTextures).toBe(true);
    expect(() => writeEraOptionValues(() => throwing, 'eor', keys, {}, UNIVERSAL, { buildingDetailTextures: false })).not.toThrow();
  });
});

describe('eraCharacterPageDefaults: the 1999 Character page\'s Defaults (options_ 0xE56A)', () => {
  const d = eraCharacterPageDefaults(R1999.characterOptionsPage!, R1999.characterDefaultsWord!);
  it('covers all fifteen rows of the 1999 page', () => {
    expect(Object.keys(d)).toHaveLength(R1999.characterOptionsPage!.length);
  });
  it('the bits: Right-click mouselook on, Accept Allegiance shown on (Ignore off), Accept Fellowship shown off (Ignore on)', () => {
    expect(d).toEqual({
      autoCreateShortcuts: false, showTooltips: true, stayInChatMode: false, vividTargetingIndicator: true,
      ignoreAllegianceRequests: false, ignoreFellowshipRequests: true, attemptToDeceiveOthers: false, allowGive: true,
      runAsDefault: true, advancedCombatUI: false, autoTarget: true, repeatAttacks: true, keepCombatTargetsInView: false,
      invertMouseLook: false, rightClickMouselook: true,
    });
  });
  it('sweep: against end of retail\'s Defaults (GetDefaultOptionValue per row, else OPTIONS_DEFAULTS) only Right-click mouselook differs', async () => {
    const { GameUI } = await import('../packages/renderer/src/ui/GameUI.js');
    const eor = { ...GameUI.OPTIONS_DEFAULTS, ...GameUI.CHARACTER_PAGE_DEFAULTS };
    const differs = Object.keys(d).filter((k) => eor[k] !== d[k]);
    expect(differs).toEqual(['rightClickMouselook']);
    // Every 1999 row's bit is an options1 bit (the 1999 PlayerModule has no options2_).
    for (const o of R1999.characterOptionsPage!) {
      if (o.ourKey) continue;
      expect(CHARACTER_SETTINGS_ROWS.find((r) => r.playerOption === o.playerOption)?.pref.field, o.playerOption).toBe('options1');
    }
  });
});

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
        // Every pane inherits its own footer set (the ids collide); GameUI binds the visible pane's.
        for (const bid of [0x100001fc, 0x100001fd, 0x100001fe]) {
          const btn = doc.createElement('div');
          btn.dataset.elementId = `0x${bid.toString(16)}`;
          el.appendChild(btn);
        }
      }
      return { root, elements, setState: () => {}, setText: () => {}, setInteractive: () => {}, setVisible: () => {}, setTexture: () => {}, onClick: () => {}, resizeSubtree: () => {}, close: () => { root.remove(); } };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    render: (id: number, parent: HTMLElement) => (ui.layoutRenderer as any).renderPanel(id, parent),
  };
}

describe('GameUI: per-era defaults, existing players and the Defaults buttons', () => {
  let H: GameUIFixture;
  beforeAll(async () => { H = await mountGameUI(); });
  afterAll(() => H.teardown());

  const store = () => H.win.localStorage as Storage;
  const blob = () => JSON.parse(store().getItem('ac_options_settings_v1') ?? '{}') as Record<string, unknown>;
  /** A page load in era `eraId` with whatever storage holds, as main.ts builds it. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function boot(eraId: string): { ui: any; detail: boolean[]; bits: Array<[number, boolean]> } {
    const detail: boolean[] = [];
    const bits: Array<[number, boolean]> = [];
    const container = H.win.document.createElement('div');
    H.win.document.body.appendChild(container);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ui: any = new H.mod.GameUI(container, {
      onCharacterOptionToggle: () => {},
      onCharacterOptionBits: (mask: number, on: boolean) => { bits.push([mask, on]); },
    });
    ui.setUIHost({ setDetailTexturing: (on: boolean) => { detail.push(on); return true; } });
    ui.setClientRules(eraClientRules(eraProfile(eraId)));
    ui.setOptionsEra(eraId);
    return { ui, detail, bits };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function openTab(ui: any, tab: 'config' | 'character'): void {
    stubOptionsLayout(ui, H.win.document);
    if (ui.optionsPanelVisible) ui.toggleOptionsPanel();
    ui.optionsTab = tab;
    ui.optionsSettings.optionsTab = tab;
    ui.toggleOptionsPanel();
    expect(ui.optionsPanelVisible).toBe(true);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rowOf = (ui: any, key: string) => ui.optionsPanel.querySelector(`[data-option-key="${key}"]`) as HTMLElement | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const click = (el: HTMLElement) => el.dispatchEvent(new H.win.MouseEvent('click', { bubbles: true }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pressDefaults = (ui: any) => click(ui.optionsPanel.querySelector('.options-footer-btn[data-element-id="0x100001fe"]') as HTMLElement);
  const legacyBlob = (extra: Record<string, unknown>) => store().setItem('ac_options_settings_v1', JSON.stringify({ configUnitsVersion: 3, ...extra }));

  it('a new AC1999 player: off, applied, and the Config row shows it off; a new end-of-retail / classic player: on', () => {
    store().clear();
    const a = boot('ac1999-retail');
    expect(a.ui.optionsSettings.buildingDetailTextures).toBe(false);
    expect(a.detail.at(-1)).toBe(false);
    openTab(a.ui, 'config');
    expect(rowOf(a.ui, 'buildingDetailTextures')!.dataset.optionOn).toBe('0');
    a.ui.toggleOptionsPanel();
    for (const id of ['eor', 'classic-dereth', 'classicace-customdm']) {
      store().clear();
      const b = boot(id);
      expect(b.ui.optionsSettings.buildingDetailTextures, id).toBe(true);
      expect(b.detail.at(-1), id).toBe(true);
    }
  });

  it('main.ts\'s early read (before the GameUI) gives the era\'s value too', () => {
    store().clear();
    expect(H.mod.GameUI.readPersistedOptionsSettings({ id: 'ac1999-retail', optionDefaults: R1999.optionDefaults }).buildingDetailTextures).toBe(false);
    expect(H.mod.GameUI.readPersistedOptionsSettings({ id: 'eor', optionDefaults: EOR.optionDefaults }).buildingDetailTextures).toBe(true);
    legacyBlob({ buildingDetailTextures: true });
    expect(H.mod.GameUI.readPersistedOptionsSettings({ id: 'ac1999-retail', optionDefaults: R1999.optionDefaults }).buildingDetailTextures).toBe(false);
  });

  it('an existing AC1999 player whose blob holds the old default (true) now gets off; end of retail keeps on', () => {
    store().clear();
    legacyBlob({ buildingDetailTextures: true, effectsVolume: 40 });
    const a = boot('ac1999-retail');
    expect(a.ui.optionsSettings.buildingDetailTextures).toBe(false);
    expect(a.ui.optionsSettings.effectsVolume).toBe(40); // the rest of the blob as before
    a.ui.saveOptionsSettings();
    // The blob keeps the legacy value untouched (for an era not yet visited) and the AC1999 entry has nothing off-default.
    expect(blob().buildingDetailTextures).toBe(true);
    expect(store().getItem(eraOptionsStoreKey('ac1999-retail'))).toBe('{}');
    expect(boot('eor').ui.optionsSettings.buildingDetailTextures).toBe(true);
  });

  it('an existing player who turned it off keeps it off in every era', () => {
    store().clear();
    legacyBlob({ buildingDetailTextures: false });
    const a = boot('ac1999-retail');
    expect(a.ui.optionsSettings.buildingDetailTextures).toBe(false);
    a.ui.saveOptionsSettings();
    const e = boot('eor');
    expect(e.ui.optionsSettings.buildingDetailTextures).toBe(false);
    expect(e.detail.at(-1)).toBe(false);
    e.ui.saveOptionsSettings();
    expect(JSON.parse(store().getItem(eraOptionsStoreKey('eor'))!)).toEqual({ buildingDetailTextures: false });
    expect(boot('classic-dereth').ui.optionsSettings.buildingDetailTextures).toBe(false);
  });

  it('a choice made in one era stays in that era', () => {
    store().clear();
    const a = boot('ac1999-retail');
    openTab(a.ui, 'config');
    click(rowOf(a.ui, 'buildingDetailTextures')!);
    expect(a.ui.optionsSettings.buildingDetailTextures).toBe(true);
    expect(a.detail.at(-1)).toBe(true);
    a.ui.toggleOptionsPanel();
    expect(JSON.parse(store().getItem(eraOptionsStoreKey('ac1999-retail'))!)).toEqual({ buildingDetailTextures: true });
    expect('buildingDetailTextures' in blob()).toBe(false); // never in the every-era blob
    expect(boot('ac1999-retail').ui.optionsSettings.buildingDetailTextures).toBe(true);
    const e = boot('eor');
    openTab(e.ui, 'config');
    click(rowOf(e.ui, 'buildingDetailTextures')!);
    expect(e.ui.optionsSettings.buildingDetailTextures).toBe(false);
    e.ui.toggleOptionsPanel();
    expect(boot('eor').ui.optionsSettings.buildingDetailTextures).toBe(false);
    expect(boot('ac1999-retail').ui.optionsSettings.buildingDetailTextures).toBe(true);
  });

  it('Config Defaults: end of retail / classic restore the detail rows (on / off); AC1999 leaves them as they are', () => {
    store().clear();
    const e = boot('eor');
    e.ui.optionsSettings.buildingDetailTextures = false;
    e.ui.optionsSettings.landscapeTextureDetail = 4;
    e.ui.optionsSettings.effectsVolume = 10;
    openTab(e.ui, 'config');
    pressDefaults(e.ui);
    expect(e.ui.optionsSettings.buildingDetailTextures).toBe(true);
    expect(e.ui.optionsSettings.landscapeTextureDetail).toBe(2);
    expect(e.ui.optionsSettings.effectsVolume).toBe(100);
    e.ui.toggleOptionsPanel();

    store().clear();
    const c = boot('classicace-customdm');
    c.ui.optionsSettings.landscapeDetailTextures = true;
    c.ui.optionsSettings.buildingDetailTextures = false;
    openTab(c.ui, 'config');
    pressDefaults(c.ui);
    expect(c.ui.optionsSettings.buildingDetailTextures).toBe(true);
    expect(c.ui.optionsSettings.landscapeDetailTextures).toBe(false);
    c.ui.toggleOptionsPanel();

    store().clear();
    const a = boot('ac1999-retail');
    a.ui.optionsSettings.buildingDetailTextures = true;
    a.ui.optionsSettings.landscapeDetailTextures = true;
    a.ui.optionsSettings.landscapeTextureDetail = 4;
    a.ui.optionsSettings.environmentTextureDetail = 3;
    a.ui.optionsSettings.screenBrightness = 0.5;
    openTab(a.ui, 'config');
    pressDefaults(a.ui);
    expect(a.ui.optionsSettings.buildingDetailTextures).toBe(true);
    expect(a.ui.optionsSettings.landscapeDetailTextures).toBe(true);
    expect(a.ui.optionsSettings.landscapeTextureDetail).toBe(4);
    expect(a.ui.optionsSettings.environmentTextureDetail).toBe(3);
    expect(a.ui.optionsSettings.screenBrightness).toBe(0); // brightness 0.5 is restored (Reset(1): SmartBox_SetBrightness(0.5))
    a.ui.toggleOptionsPanel();
  });

  it('Character Defaults on AC1999: options_ 0xE56A — Right-click mouselook on, sent as the whole word; end of retail\'s rows unchanged', () => {
    store().clear();
    const a = boot('ac1999-retail');
    a.ui.optionsSettings.rightClickMouselook = false;
    a.ui.optionsSettings.ignoreFellowshipRequests = false;
    openTab(a.ui, 'character');
    pressDefaults(a.ui);
    expect(a.ui.optionsSettings.rightClickMouselook).toBe(true);
    expect(a.ui.optionsSettings.ignoreFellowshipRequests).toBe(true);
    expect(a.bits).toContainEqual([0x4000, true]);
    a.ui.toggleOptionsPanel();

    store().clear();
    const e = boot('eor');
    e.ui.optionsSettings.ignoreFellowshipRequests = false;
    e.ui.optionsSettings.showHelm = true;
    openTab(e.ui, 'character');
    pressDefaults(e.ui);
    expect(e.ui.optionsSettings.ignoreFellowshipRequests).toBe(true);
    expect(e.ui.optionsSettings.showHelm).toBe(false); // GetDefaultOptionValue, not the constructor word
    expect(e.bits).toEqual([]);
    e.ui.toggleOptionsPanel();
  });
});

describe('BUG.ac1999-texture-resolution-defaults: the 1999 texture-resolution menus on our options', () => {
  it('1999 offers Full / 1/2 / 1/4 / 1/8 as our values 1..4; end of retail and every classic era keep the five-choice menu', () => {
    expect(R1999.world.textureDetailMenu).toBe(AC1999_TEXTURE_DETAIL_MENU);
    expect(AC1999_TEXTURE_DETAIL_MENU).toEqual({ values: [1, 2, 3, 4], labels: ['Full', '1/2', '1/4', '1/8'], shifts: [0, 1, 2, 4] });
    expect(EOR.world.textureDetailMenu).toBeNull();
    for (const id of CLASSIC_IDS) expect(eraClientRules(eraProfile(id)).world.textureDetailMenu, id).toBeNull();
  });
  it('item L of the 1999 menu is our value L + 1: the same shift as 1999\'s {0, 1, 2, 4}[L] (.rdata 0x5f75a8 / 0x5fe0d8), for landscape and environment', () => {
    const shift1999 = [0, 1, 2, 4];
    expect(AC1999_TEXTURE_DETAIL_MENU.shifts).toEqual(shift1999);
    const p1999 = new TextureSamplerPrefs({ value: 0 });
    expect(p1999.setEnvironmentShifts(R1999.world.textureDetailMenu)).toBe(true);
    const pEor = new TextureSamplerPrefs({ value: 0 });
    expect(pEor.setEnvironmentShifts(EOR.world.textureDetailMenu)).toBe(false);
    AC1999_TEXTURE_DETAIL_MENU.values.forEach((v, item) => {
      expect(retailLandscapeShift(v), `landscape ${v}`).toBe(shift1999[item]);
      p1999.set({ landscapeTextureDetail: v, environmentTextureDetail: v });
      expect(p1999.shiftFor('landscape'), `landscape ${v}`).toBe(shift1999[item]);
      expect(p1999.shiftFor('environment'), `environment ${v}`).toBe(shift1999[item]);
    });
    // End of retail keeps its own environment shifts: Very Low is 3 there, 1999's "1/8" is 4.
    pEor.set({ environmentTextureDetail: 4 });
    expect(pEor.shiftFor('environment')).toBe(environmentDetailShift(4));
    expect(environmentDetailShift(4)).toBe(3);
    // Full = no shift: the region's base_tex_size merge (1999 0x004a7ee0 >> 0), the portal's own image.
    expect(landscapeMergedSize(1, 512)).toBe(512);
  });
  it('a fresh 1999 profile is Full in both menus; end of retail starts Landscape at Medium (half) and Environment at High', () => {
    const s = memStore();
    const keys = ERA_DEFAULTED_OPTION_KEYS;
    const r1999 = readEraOptionValues(() => s, 'ac1999-retail', keys, R1999.optionDefaults, UNIVERSAL_ALL, null);
    expect(r1999).toMatchObject({ landscapeTextureDetail: 1, environmentTextureDetail: 1 });
    expect(retailLandscapeShift(r1999.landscapeTextureDetail as number)).toBe(0);
    const eor = readEraOptionValues(() => s, 'eor', keys, EOR.optionDefaults, UNIVERSAL_ALL, null);
    expect(eor).toMatchObject({ landscapeTextureDetail: 2, environmentTextureDetail: 1 });
  });
  it('no client_highres.dat on 1999: Very High reads as Full there and is kept in the other eras', () => {
    expect(eraOffersHighResTextures(R1999.world)).toBe(false);
    expect(eraOffersHighResTextures(EOR.world)).toBe(true);
    for (const id of CLASSIC_IDS) expect(eraOffersHighResTextures(eraClientRules(eraProfile(id)).world), id).toBe(true);
    expect(eraTextureDetail(R1999.world, 0)).toBe(1);
    expect(eraTextureDetail(R1999.world, 3)).toBe(3);
    expect(eraTextureDetail(EOR.world, 0)).toBe(0);
    expect(eraTexturePrefs(R1999.world, { textureFiltering: 1, landscapeTextureDetail: 0, environmentTextureDetail: 0 }))
      .toEqual({ textureFiltering: 1, landscapeTextureDetail: 1, environmentTextureDetail: 1 });
    expect(eraTexturePrefs(EOR.world, { environmentTextureDetail: 0 })).toEqual({ environmentTextureDetail: 0 });
    // Through the samplers: 1999 never reports the highres level.
    const prefs = new TextureSamplerPrefs({ value: 0 });
    prefs.set(eraTexturePrefs(R1999.world, { environmentTextureDetail: 0 }));
    prefs.setHighResMounted(true);
    expect(prefs.usesHighResLevel('environment')).toBe(false);
  });
  it('the 1999 Defaults button\'s volumes: 0.66 on the sliders, applied as 6 tenths = 60 (fresh stays 100)', () => {
    expect(R1999.configDefaultsValues).toEqual({ effectsVolume: 60, ambientVolume: 60 });
    expect(R1999.optionDefaults).not.toHaveProperty('effectsVolume');
    expect(Math.trunc(0.66 * 10)).toBe(6);
  });
});

describe('GameUI: the texture menus per era', () => {
  let H: GameUIFixture;
  beforeAll(async () => { H = await mountGameUI(); });
  afterAll(() => H.teardown());
  const store = () => H.win.localStorage as Storage;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function boot(eraId: string): { ui: any; tex: Array<Record<string, unknown>> } {
    const tex: Array<Record<string, unknown>> = [];
    const container = H.win.document.createElement('div');
    H.win.document.body.appendChild(container);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ui: any = new H.mod.GameUI(container, { onCharacterOptionToggle: () => {} });
    ui.setUIHost({ setTexturePrefs: (p: Record<string, unknown>) => { tex.push(p); return true; } });
    ui.setClientRules(eraClientRules(eraProfile(eraId)));
    ui.setOptionsEra(eraId);
    return { ui, tex };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function openConfig(ui: any): void {
    stubOptionsLayout(ui, H.win.document);
    if (ui.optionsPanelVisible) ui.toggleOptionsPanel();
    ui.optionsTab = 'config';
    ui.optionsSettings.optionsTab = 'config';
    ui.toggleOptionsPanel();
  }
  type Menu = { options: string[]; current: string; pick: (v: string) => void };
  /** Open a menu row and return what it offers, the current choice, and its picker. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function menuOf(ui: any, key: string): Menu {
    const got: Menu[] = [];
    ui.openOptionsMenu = (_f: unknown, options: string[], current: string, onSelect: (v: string) => void) => { got.push({ options, current, pick: onSelect }); };
    const field = ui.optionsPanel.querySelector(`[data-option-key="${key}"] .options-menu-field`) as HTMLElement;
    field.dispatchEvent(new H.win.MouseEvent('click', { bubbles: true }));
    if (got.length === 0) throw new Error(`no menu for ${key}`);
    return got[0];
  }
  const pressDefaults = (ui: { optionsPanel: HTMLElement }) => (ui.optionsPanel.querySelector('.options-footer-btn[data-element-id="0x100001fe"]') as HTMLElement)
    .dispatchEvent(new H.win.MouseEvent('click', { bubbles: true }));
  const legacyBlob = (extra: Record<string, unknown>) => store().setItem('ac_options_settings_v1', JSON.stringify({ configUnitsVersion: 3, ...extra }));

  it('a new AC1999 player: Full in both menus, the world gets value 1 (no shift); the menus list 1999\'s four labels', () => {
    store().clear();
    const a = boot('ac1999-retail');
    expect(a.ui.optionsSettings.landscapeTextureDetail).toBe(1);
    expect(a.ui.optionsSettings.environmentTextureDetail).toBe(1);
    expect(a.tex.at(-1)).toMatchObject({ landscapeTextureDetail: 1, environmentTextureDetail: 1 });
    openConfig(a.ui);
    const land = menuOf(a.ui, 'landscapeTextureDetail');
    expect(land.options).toEqual(['Full', '1/2', '1/4', '1/8']);
    expect(land.current).toBe('Full');
    land.pick('1/4');
    expect(a.ui.optionsSettings.landscapeTextureDetail).toBe(3);
    expect(a.tex.at(-1)).toMatchObject({ landscapeTextureDetail: 3 });
    expect(JSON.parse(store().getItem(eraOptionsStoreKey('ac1999-retail'))!)).toMatchObject({ landscapeTextureDetail: 3 });
    expect(menuOf(a.ui, 'environmentTextureDetail').current).toBe('Full');
    a.ui.toggleOptionsPanel();
    // Kept for AC1999 only.
    expect(boot('eor').ui.optionsSettings.landscapeTextureDetail).toBe(2);
  });

  it('end of retail and classic: Medium / High and the five end-of-retail choices', () => {
    for (const id of ['eor', 'classicace-customdm']) {
      store().clear();
      const e = boot(id);
      expect(e.ui.optionsSettings.landscapeTextureDetail, id).toBe(2);
      expect(e.ui.optionsSettings.environmentTextureDetail, id).toBe(1);
      openConfig(e.ui);
      expect(menuOf(e.ui, 'environmentTextureDetail').options, id).toHaveLength(5);
      e.ui.toggleOptionsPanel();
    }
  });

  it('existing players: a stored Medium (the old default) becomes Full on 1999; a stored 1/4 stays; a stored Very High draws Full on 1999 and Very High in end of retail', () => {
    store().clear();
    legacyBlob({ landscapeTextureDetail: 2, environmentTextureDetail: 1 });
    expect(boot('ac1999-retail').ui.optionsSettings.landscapeTextureDetail).toBe(1);
    expect(boot('eor').ui.optionsSettings.landscapeTextureDetail).toBe(2);

    store().clear();
    legacyBlob({ landscapeTextureDetail: 3 });
    expect(boot('ac1999-retail').ui.optionsSettings.landscapeTextureDetail).toBe(3);
    expect(boot('eor').ui.optionsSettings.landscapeTextureDetail).toBe(3);

    store().clear();
    legacyBlob({ environmentTextureDetail: 0 });
    const a = boot('ac1999-retail');
    expect(a.tex.at(-1)).toMatchObject({ environmentTextureDetail: 1 });
    openConfig(a.ui);
    expect(menuOf(a.ui, 'environmentTextureDetail').current).toBe('Full');
    a.ui.toggleOptionsPanel();
    const e = boot('eor');
    expect(e.tex.at(-1)).toMatchObject({ environmentTextureDetail: 0 });
  });

  it('Config Defaults on 1999: volumes to 60, texture menus kept; end of retail: volumes 100, menus to Medium / High', () => {
    store().clear();
    const a = boot('ac1999-retail');
    a.ui.optionsSettings.effectsVolume = 20;
    a.ui.optionsSettings.ambientVolume = 30;
    a.ui.optionsSettings.landscapeTextureDetail = 4;
    openConfig(a.ui);
    pressDefaults(a.ui);
    expect(a.ui.optionsSettings.effectsVolume).toBe(60);
    expect(a.ui.optionsSettings.ambientVolume).toBe(60);
    expect(a.ui.optionsSettings.landscapeTextureDetail).toBe(4);
    a.ui.toggleOptionsPanel();

    store().clear();
    const e = boot('eor');
    e.ui.optionsSettings.effectsVolume = 20;
    e.ui.optionsSettings.landscapeTextureDetail = 4;
    e.ui.optionsSettings.environmentTextureDetail = 3;
    openConfig(e.ui);
    pressDefaults(e.ui);
    expect(e.ui.optionsSettings.effectsVolume).toBe(100);
    expect(e.ui.optionsSettings.landscapeTextureDetail).toBe(2);
    expect(e.ui.optionsSettings.environmentTextureDetail).toBe(1);
    e.ui.toggleOptionsPanel();
  });
});
