/**
 * CORE.17.h.e — the Config tab's headers, row labels, slider end captions
 * and Sound Features choices are the retail strings from table 0x23000003.
 *
 * Retail: every Config pref is registered through
 * UIPreferences::AttachPreference(&pref, kind, 0x10000003,
 * compute_str_hash("ID_…"), compute_str_hash("ID_…_Help")) (decomp
 * acclient-decompiled.c:2490-2537 Sound_ prefs, :2961-2986 Render_ and
 * Display_ prefs, :3004-3008 Camera_ prefs), gmConfigUI::InitOptions @
 * 0049e400 hands each pref
 * to PlayerOptionPage::Add*Option (label = that id), AddHeader takes
 * ID_*_Section, SetSliderLabel takes ID_Graphics_Value_* and SetEnumChoices
 * takes ID_Sound_Stereo / ID_Sound_Mono. Table enum 0x10000003 is the
 * English table 0x23000003 and compute_str_hash is acStringHash, so the
 * label is 0x23000003[acStringHash(token)] — e.g. "Align camera to slope"
 * (sentence case) and "Sync with Refresh Rate", where ours previously
 * rendered Title Case literals.
 *
 * Three layers, no source-text pins:
 *  1. fallback path — with no table loaded the real renderOptionsPanel
 *     still renders the DAT wording (the fallbacks ARE the DAT text);
 *  2. binding path — a synthetic 0x23000003 table with marker text per
 *     token (plus a colliding 0x23000005 entry) proves every header /
 *     label / caption / choice is read from THAT table, not a literal;
 *  3. DAT ground truth (skipped without dat/) — the real
 *     client_local_English.dat table 0x23000003 carries exactly the
 *     CONFIG_STRINGS fallback text at acStringHash(token) for every token.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import fs from 'fs';
import path from 'path';
import {
  DatDatabase, DatReader, parseStringTable, registerStringTable, acStringHash,
} from '@ac/dat-parser';
import type { StringTableData } from '@ac/dat-parser';
import {
  CONFIG_STRINGS, OPTIONS_STRING_TABLE, configString, optionString,
} from '../packages/renderer/src/ui/OptionsStrings.js';
import type { ConfigStringKey } from '../packages/renderer/src/ui/OptionsStrings.js';
import { openDat } from './_harness/dat.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

const OPT_IDS = [
  0x10000208, 0x10000210, 0x10000211, 0x10000212, 0x10000213, 0x10000216, 0x10000217,
  0x10000218, 0x1000021a, 0x1000021d, 0x10000220, 0x10000221, 0x10000222, 0x1000050c,
  0x10000520, 0x10000521, 0x1000020d, 0x1000020e, 0x1000050b, 0x1000020f,
];
const FOOTER_BTN_IDS = [0x100001fc, 0x100001fd, 0x100001fe];

const KEYS = Object.keys(CONFIG_STRINGS) as ConfigStringKey[];
const marker = (key: ConfigStringKey): string => `«${key}»`;

function entry(id: number, text: string) {
  return { id, varNames: [], vars: [], strings: [text], comments: [], unknown: 0 };
}

// The per-row DOM hooks: option key → which CONFIG_STRINGS keys label that
// row (label, then captions / choices).
const ROWS: Array<[string, ConfigStringKey[]]> = [
  ['soundFeatures', ['soundFeatures', 'stereo']],
  ['effectsVolume', ['soundEffects']],
  ['ambientVolume', ['ambientSounds']],
  ['interfaceVolume', ['interfaceSounds']],
  ['playSoundsOnlyWhenActive', ['playSoundsOnlyWhenActive']],
  ['cameraStiffness', ['cameraStiffness', 'soft', 'hard']],
  ['cameraAdjustmentSpeed', ['cameraAdjustmentSpeed', 'slow', 'fast']],
  ['fieldOfView', ['fieldOfView', 'narrow', 'wide']],
  ['alignCameraToSlope', ['alignCameraToSlope']],
  ['fullScreen', ['fullScreen']],
  ['syncWithRefreshRate', ['syncWithRefreshRate']],
  ['screenBrightness', ['screenBrightness', 'dark', 'bright']],
  ['adaptiveDegrade', ['adaptiveDegrade']],
  ['adaptiveDegradeBias', ['adaptiveDegradeBias', 'speed', 'detail']],
  // CORE.17.h.g — the rows below Adaptive Degrade Bias (menus show their default choice).
  ['degradeDistance', ['degradeDistance', 'close', 'far']],
  ['landscapeTextureDetail', ['landscapeTextureDetail', 'medium']],
  ['environmentTextureDetail', ['environmentTextureDetail', 'high']],
  ['textureFiltering', ['textureFiltering', 'trilinear']],
  // CORE.17.h.g.a.a — a fresh profile shows retail's Medium 8 (the interim
  // Very Low 3 ended 2026-09-26); the Defaults button restores Medium too.
  ['landscapeDrawDistance', ['landscapeDrawDistance', 'medium']],
  ['buildingDetailTextures', ['environmentDetailTextures']],
  ['multiPassAlpha', ['multiplePassAlpha']],
  ['mouseLookSensitivity', ['mouselookSensitivity']],
  ['invertMouseLookYAxis', ['invertMouselookAxes']],
  ['useMouseTurning', ['useMouseTurning']],
  ['chatFontFace', ['chatFontFace', 'palatinoLinotype']],
  ['chatFontSize', ['chatFontSize', 'small']],
];
const HEADERS: ConfigStringKey[] = [
  'soundSection', 'cameraSection', 'graphicsSection',
  'renderingQualitySection', 'inputSection', 'uiSection', // CORE.17.h.g
];

describe('CORE.17.h.e — Config tab strings come from table 0x23000003 (real GameUI under happy-dom)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;

  beforeAll(async () => {
    const g = globalThis as Record<string, unknown>;
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof (g as any).requestAnimationFrame !== 'function') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (g as any).requestAnimationFrame = () => 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (g as any).cancelAnimationFrame = () => {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (domWindow as any).requestAnimationFrame = (g as any).requestAnimationFrame;
    }
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.layoutRenderer = {
      renderPanel: (_layoutId: number, parent: HTMLElement) => {
        const root = domWindow.document.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of OPT_IDS) {
          const el = domWindow.document.createElement('div');
          root.appendChild(el);
          elements.set(id, el);
          if (id === 0x10000211) {
            for (const bid of FOOTER_BTN_IDS) {
              const btn = domWindow.document.createElement('div');
              btn.dataset.elementId = `0x${bid.toString(16)}`;
              for (const sid of [0x100002ce, 0x100002cf, 0x100002d0]) {
                const slice = domWindow.document.createElement('div');
                slice.dataset.elementId = `0x${sid.toString(16)}`;
                btn.appendChild(slice);
              }
              el.appendChild(btn);
            }
          }
        }
        return {
          root, elements,
          setState: () => {}, setText: () => {}, setInteractive: () => {}, setVisible: () => {},
          setTexture: () => {}, onClick: () => {}, close: () => { root.remove(); },
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (id: number, parent: HTMLElement) => (ui.layoutRenderer as any).renderPanel(id, parent),
    };
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  function renderConfig(): void {
    ui.optionsTab = 'config';
    if (!ui.optionsPanelVisible) ui.toggleOptionsPanel();
    else ui.renderOptionsPanel();
  }
  function texts(): string[] {
    return [...ui.optionsPanel.querySelectorAll('span')].map((s: HTMLElement) => s.textContent ?? '');
  }
  function rowTexts(optionKey: string): string[] {
    const row = ui.optionsPanel.querySelector(`[data-option-key="${optionKey}"]`) as HTMLElement | null;
    expect(row, `row ${optionKey}`).toBeTruthy();
    return [...row!.querySelectorAll('span')].map((s: HTMLElement) => s.textContent ?? '');
  }
  function headerTexts(): string[] {
    return [...ui.optionsPanel.querySelectorAll('.options-section-header span')].map((s: HTMLElement) => s.textContent ?? '');
  }

  it('fallback path (no string table loaded): the Config tab renders the DAT wording, incl. sentence-case "Align camera to slope" and "Sync with Refresh Rate"', () => {
    renderConfig();
    expect(headerTexts()).toEqual(HEADERS.map((k) => CONFIG_STRINGS[k][1]));
    expect(headerTexts()).toEqual(['Sound Options', 'Camera Options', 'Graphics Options', 'Rendering Quality Options', 'Input Options', 'UI Options']);
    for (const [optionKey, keys] of ROWS) {
      const got = rowTexts(optionKey);
      for (const k of keys) expect(got, `${optionKey} ← ${k}`).toContain(CONFIG_STRINGS[k][1]);
    }
    const all = texts();
    expect(all).toContain('Align camera to slope');
    expect(all).toContain('Sync with Refresh Rate');
    expect(all).not.toContain('Align Camera To Slope');
    expect(all).not.toContain('Sync With Refresh Rate');
    // Resolution is the display-only menu row (no option key): label + readout.
    expect(all).toContain('Resolution');
    expect(all).toContain('1024x768');
  });

  it('binding path: with a marker table registered as 0x23000003 (and a colliding 0x23000005), every header / label / caption / choice is read from 0x23000003', () => {
    const t3: StringTableData = {
      id: OPTIONS_STRING_TABLE, language: 1, unknown: 0,
      entries: KEYS.map((k) => entry(acStringHash(CONFIG_STRINGS[k][0]), marker(k))),
    };
    // A later table carrying the same ids with different text — the flat
    // index is last-write-wins, the panel must still read table 3.
    const t5: StringTableData = {
      id: 0x23000005, language: 1, unknown: 0,
      entries: KEYS.map((k) => entry(acStringHash(CONFIG_STRINGS[k][0]), `WRONG-${k}`)),
    };
    registerStringTable(t3);
    registerStringTable(t5);
    // Persisted Sound Features value follows the retail choice text.
    ui.optionsSettings.soundFeatures = configString('stereo');
    renderConfig();
    expect(headerTexts()).toEqual(HEADERS.map(marker));
    for (const [optionKey, keys] of ROWS) {
      const got = rowTexts(optionKey);
      for (const k of keys) expect(got, `${optionKey} ← ${k}`).toContain(marker(k));
      for (const k of keys) expect(got, `${optionKey} ← ${k}`).not.toContain(CONFIG_STRINGS[k][1]);
    }
    const all = texts();
    expect(all).toContain(marker('resolution'));
    for (const k of KEYS) expect(all).not.toContain(`WRONG-${k}`);
    // The Sound Features menu cycles through the table's choices.
    const menu = ui.optionsPanel.querySelector('[data-option-key="soundFeatures"] .options-menu-field') as HTMLElement;
    menu.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    expect(ui.optionsSettings.soundFeatures).toBe(marker('mono'));
    expect(rowTexts('soundFeatures')).toContain(marker('mono'));
    ui.optionsSettings.soundFeatures = 'Stereo';
  });

  it('row kinds survive the string rewire: Resolution is a menu row, Sound Effects a checkbox+slider row, Field of View a captioned slider', () => {
    renderConfig();
    const menus = [...ui.optionsPanel.querySelectorAll('[data-option-row="menu"]')] as HTMLElement[];
    expect(menus.some((r) => [...r.querySelectorAll('span')].some((s: HTMLElement) => s.textContent === marker('resolution')))).toBe(true);
    const effects = ui.optionsPanel.querySelector('[data-option-key="effectsVolume"]') as HTMLElement;
    expect(effects.dataset.optionRow).toBe('check-slider');
    expect(effects.querySelector(`[data-slider-label="${marker('soundEffects')}"]`)).toBeTruthy();
    const fov = ui.optionsPanel.querySelector('[data-option-key="fieldOfView"]') as HTMLElement;
    expect(fov.dataset.optionRow).toBe('slider');
    expect(fov.style.height).toBe('36px');
    expect(fov.querySelector(`[data-slider-label="${marker('fieldOfView')}"]`)).toBeTruthy();
  });
});

describe('optionString — token hash + per-table binding', () => {
  it('hashes the retail tokens to the ids the Config rows are attached with', () => {
    // Cross-checked against tools/search-strings.mjs over client_local_English.dat.
    expect(acStringHash('ID_Sound_DisableSound')).toBe(96466580);
    expect(acStringHash('ID_Camera_AlignToSlope')).toBe(38659637);
    expect(acStringHash('ID_Rendering_SyncToDisplayRefresh')).toBe(215622664);
    expect(acStringHash('ID_Graphics_AdaptiveDegrade')).toBe(243431381);
    expect(acStringHash('ID_Rendering_DisplayResolution')).toBe(201318958);
    expect(acStringHash('ID_Sound_NoFocusNoSound')).toBe(26644692);
  });

  it('is bound to 0x23000003 and prefers it over the flat index, then falls back to the given text', () => {
    expect(OPTIONS_STRING_TABLE).toBe(0x23000003);
    expect(optionString('ID_Test_Unregistered_Token', 'fallback text')).toBe('fallback text');
    const id = acStringHash('ID_Test_Bound_Token');
    registerStringTable({ id: 0x23000003, language: 1, unknown: 0, entries: [entry(id, 'table three')] });
    registerStringTable({ id: 0x23000005, language: 1, unknown: 0, entries: [entry(id, 'table five')] });
    expect(optionString('ID_Test_Bound_Token', 'fallback text')).toBe('table three');
  });
});

const LANG_DAT = path.resolve(__dirname, '../dat/client_local_English.dat');

describe.skipIf(!fs.existsSync(LANG_DAT))('CORE.17.h.e — DAT ground truth: table 0x23000003 text per Config token', () => {
  let table: StringTableData;
  beforeAll(() => {
    const db = openDat(LANG_DAT);
    table = parseStringTable(new DatReader(db.getFileData(OPTIONS_STRING_TABLE)!));
  });

  it('every CONFIG_STRINGS token resolves in the EoL table to exactly its fallback text', () => {
    const byId = new Map(table.entries.map((e) => [e.id, e.strings[0]]));
    for (const k of KEYS) {
      const [token, text] = CONFIG_STRINGS[k];
      expect(byId.get(acStringHash(token)), `${k} (${token})`).toBe(text);
    }
  });
});
