/**
 * CORE.17.h.f — the Config tab's DEFAULT values + slider RANGES are the
 * retail ones.
 *
 * Retail: gmConfigUI::InitOptions @ 0049e400 (reference/client-eol/decomp/
 * acclient-decompiled.c :158618-158730) adds each option and immediately
 * calls vtable slot +0x2d8 on it — UIOption_{Checkbox,Slider,Menu,
 * CheckboxSlider}::SetDefaultValue (every one of those four functions sits
 * exactly 0x2d8 past its class's vtable in acclient.exe .rdata) — with the
 * preference default: PlaySoundOnlyWhenActive 1, AlignToSlope 1,
 * SyncToRefresh 0, AutomaticDegrades 0, Camera_Stiffness 0x3ee66666 = 0.45,
 * Camera_AdjustmentSpeed 0x42200000 = 40.0, Render_FieldOfView 0x42b40000 =
 * 90.0, ScreenBrightness 0, GraphicsPerformance 0. The ranges come from the
 * preference-attach block (decomp :2959-3010): UIPreferences::
 * SetPreferenceRange(Camera_Stiffness, 0.2857143, 1.0), (Camera_
 * AdjustmentSpeed, 5.0, 80.0), (Render_FieldOfView, 10.0, 160.0),
 * (Render_ScreenBrightness, -1.0, 1.0), (Render_GraphicsPerformance, -1.0,
 * 1.0). UIOption_Slider::Refresh @ 00484a50 places the widget at
 * (value − lower) / (upper − lower), so retail's fresh Config tab shows the
 * Stiffness thumb at ≈23%, Adjustment Speed at ≈47%, Field of View at ≈53%
 * (options-config.jpg). Pre-fix ours defaulted the three toggles inverted
 * and every slider to 50 of 0..100.
 *
 * Display.FullScreen's retail default (1) is deliberately NOT mirrored: the
 * browser Fullscreen API only honors a user-gesture request, so a fresh
 * session cannot be fullscreen and its bullet stays browser-gated OFF.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { existsSync, readFileSync } from 'node:fs';
import { GameUI } from '../packages/renderer/src/ui/GameUI.js';

const DECOMP = 'reference/client-eol/decomp/acclient-decompiled.c';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

const OPT_IDS = [
  0x10000208, 0x10000210, 0x10000211, 0x10000212, 0x10000213, 0x10000216, 0x10000217,
  0x10000218, 0x1000021a, 0x1000021d, 0x10000220, 0x10000221, 0x10000222, 0x1000050c,
  0x10000520, 0x10000521, 0x1000020d, 0x1000020e, 0x1000050b, 0x1000020f,
];

const ACTIVE = GameUI.OPTIONS_SLIDER_WIDTH - GameUI.OPTIONS_SLIDER_THUMB_WIDTH; // ComputeActiveSize = 113

/** Retail fraction for a value in its preference range (UIOption_Slider::Refresh). */
function frac(key: keyof typeof GameUI.CONFIG_SLIDER_RANGES, v: number): number {
  const { min, max } = GameUI.CONFIG_SLIDER_RANGES[key];
  return (v - min) / (max - min);
}

describe('CORE.17.h.f — OPTIONS_DEFAULTS carry the gmConfigUI::InitOptions SetDefaultValue values', () => {
  const D = GameUI.OPTIONS_DEFAULTS;
  const R = GameUI.CONFIG_SLIDER_RANGES;

  it('toggles: Play Sounds Only When Active + Align camera to slope ON, Sync with Refresh Rate + Adaptive Degrade OFF', () => {
    expect(D.playSoundsOnlyWhenActive).toBe(true);
    expect(D.alignCameraToSlope).toBe(true);
    expect(D.syncWithRefreshRate).toBe(false);
    expect(D.adaptiveDegrade).toBe(false);
  });

  it('Full Screen stays browser-gated OFF (Fullscreen API needs a gesture; retail SetDefaultValue(1) cannot be honored on load)', () => {
    expect(D.fullScreen).toBe(false);
  });

  it('slider ranges are the UIPreferences::SetPreferenceRange values', () => {
    expect(R.cameraStiffness).toEqual({ min: 0.2857143, max: 1.0 });
    expect(R.cameraAdjustmentSpeed).toEqual({ min: 5.0, max: 80.0 });
    expect(R.fieldOfView).toEqual({ min: 10.0, max: 160.0 });
    expect(R.screenBrightness).toEqual({ min: -1.0, max: 1.0 });
    expect(R.adaptiveDegradeBias).toEqual({ min: -1.0, max: 1.0 });
  });

  it('slider defaults are the SetDefaultValue floats: 0.45 / 40 / 90 / 0 / 0', () => {
    expect(D.cameraStiffness).toBe(0.45);
    expect(D.cameraAdjustmentSpeed).toBe(40);
    expect(D.fieldOfView).toBe(90);
    expect(D.screenBrightness).toBe(0);
    expect(D.adaptiveDegradeBias).toBe(0);
  });

  it('default thumb fractions match retail: Stiffness ≈23%, Adjustment Speed ≈47%, Field of View ≈53%, Brightness/Bias 50%', () => {
    expect(frac('cameraStiffness', D.cameraStiffness as number)).toBeCloseTo(0.23, 3);
    expect(frac('cameraAdjustmentSpeed', D.cameraAdjustmentSpeed as number)).toBeCloseTo(0.4667, 3);
    expect(frac('fieldOfView', D.fieldOfView as number)).toBeCloseTo(0.5333, 3);
    expect(frac('screenBrightness', D.screenBrightness as number)).toBe(0.5);
    expect(frac('adaptiveDegradeBias', D.adaptiveDegradeBias as number)).toBe(0.5);
  });

  it('the persisted blob carries the units-version stamp', () => {
    expect(D.configUnitsVersion).toBe(GameUI.CONFIG_UNITS_VERSION);
    expect(GameUI.CONFIG_UNITS_VERSION).toBe(3);
  });
});

describe('CORE.17.h.f — migrateLegacyConfigUnits re-expresses a pre-retail-units blob', () => {
  it('0..100 percents map onto lower + pct × (upper − lower); Field of View (already degrees) is untouched', () => {
    const out = GameUI.migrateLegacyConfigUnits({
      cameraStiffness: 50, cameraAdjustmentSpeed: 50, screenBrightness: 50, adaptiveDegradeBias: 50, fieldOfView: 75,
      showHelm: true,
    });
    expect(out.cameraStiffness).toBeCloseTo(0.643, 3);
    expect(out.cameraAdjustmentSpeed).toBe(42.5);
    expect(out.screenBrightness).toBe(0);
    expect(out.adaptiveDegradeBias).toBe(0);
    expect(out.fieldOfView).toBe(75);
    expect(out.showHelm).toBe(true);
    expect(out.configUnitsVersion).toBe(3);
  });

  it('0 and 100 land on the range ends; out-of-range percents clamp', () => {
    const lo = GameUI.migrateLegacyConfigUnits({ cameraStiffness: 0, cameraAdjustmentSpeed: 0, screenBrightness: 0, adaptiveDegradeBias: -20 });
    expect(lo.cameraStiffness).toBeCloseTo(0.286, 3);
    expect(lo.cameraAdjustmentSpeed).toBe(5);
    expect(lo.screenBrightness).toBe(-1);
    expect(lo.adaptiveDegradeBias).toBe(-1);
    const hi = GameUI.migrateLegacyConfigUnits({ cameraStiffness: 100, cameraAdjustmentSpeed: 130, screenBrightness: 100, adaptiveDegradeBias: 100 });
    expect(hi.cameraStiffness).toBe(1);
    expect(hi.cameraAdjustmentSpeed).toBe(80);
    expect(hi.screenBrightness).toBe(1);
    expect(hi.adaptiveDegradeBias).toBe(1);
  });

  it('a blob already stamped with the current version is returned untouched (50 is a legal Adjustment Speed in units)', () => {
    const blob = { configUnitsVersion: 3, cameraAdjustmentSpeed: 50, cameraStiffness: 0.9, adaptiveDegrade: false };
    const out = GameUI.migrateLegacyConfigUnits(blob);
    expect(out).toBe(blob);
    expect(out.cameraAdjustmentSpeed).toBe(50);
    expect(out.adaptiveDegrade).toBe(false); // a v3 false is the player's choice
  });

  it('VISUAL.town-scenery-gaps — a v2 blob keeps its slider units and its shipped-OFF Automatic Degrades is re-seeded ON', () => {
    const out = GameUI.migrateLegacyConfigUnits({ configUnitsVersion: 2, cameraAdjustmentSpeed: 50, adaptiveDegradeBias: 0.4, adaptiveDegrade: false });
    expect(out.cameraAdjustmentSpeed).toBe(50);
    expect(out.adaptiveDegradeBias).toBe(0.4);
    expect(out.adaptiveDegrade).toBe(true);
    expect(out.configUnitsVersion).toBe(3);
    // A pre-units blob gets both migrations; an ON choice stays on; no key stays absent.
    const old = GameUI.migrateLegacyConfigUnits({ cameraAdjustmentSpeed: 50, adaptiveDegrade: false });
    expect(old.cameraAdjustmentSpeed).toBe(42.5);
    expect(old.adaptiveDegrade).toBe(true);
    expect(GameUI.migrateLegacyConfigUnits({ configUnitsVersion: 2, adaptiveDegrade: true }).adaptiveDegrade).toBe(true);
    expect('adaptiveDegrade' in GameUI.migrateLegacyConfigUnits({ configUnitsVersion: 2 })).toBe(false);
  });

  it('non-numeric or missing slider entries are left alone but the stamp is still written', () => {
    const out = GameUI.migrateLegacyConfigUnits({ cameraStiffness: 'x', screenBrightness: Number.NaN });
    expect(out.cameraStiffness).toBe('x');
    expect(Number.isNaN(out.screenBrightness as number)).toBe(true);
    expect(out.cameraAdjustmentSpeed).toBeUndefined();
    expect(out.configUnitsVersion).toBe(3);
  });

  it('quantizeConfigValue keeps 1/1000 resolution', () => {
    expect(GameUI.quantizeConfigValue(0.4499999)).toBe(0.45);
    expect(GameUI.quantizeConfigValue(42.5004)).toBe(42.5);
  });
});

describe('CORE.17.h.f — a fresh Config tab renders the retail defaults; Defaults restores them; consumers read retail units', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICls: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let container: any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function stubLayout(target: any): void {
    target.layoutRenderer = {
      renderPanel: (_layoutId: number, parent: HTMLElement) => {
        const root = domWindow.document.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of OPT_IDS) {
          const el = domWindow.document.createElement('div');
          root.appendChild(el);
          elements.set(id, el);
          if (id === 0x10000211) {
            for (const bid of [0x100001fc, 0x100001fd, 0x100001fe]) {
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
      render: (id: number, parent: HTMLElement) => (target.layoutRenderer as any).renderPanel(id, parent),
    };
    target.callbacks.onCharacterOptionToggle = () => {};
  }

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
    domWindow.localStorage.removeItem('ac_options_settings_v1');
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    GameUICls = mod.GameUI;
    container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    stubLayout(ui);
  });
  afterAll(() => {
    domWindow.localStorage.removeItem('ac_options_settings_v1');
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  function openConfig(): void {
    if (ui.optionsPanelVisible) ui.toggleOptionsPanel();
    ui.optionsTab = 'config';
    ui.optionsSettings.optionsTab = 'config';
    ui.toggleOptionsPanel();
    expect(ui.optionsPanelVisible).toBe(true);
  }
  function toggleOn(key: string): string {
    const row = ui.optionsPanel.querySelector(`.option-toggle-row[data-option-key="${key}"]`) as HTMLElement | null;
    expect(row, key).toBeTruthy();
    return row!.dataset.optionOn!;
  }
  function slider(key: string): { pos: number; left: number } {
    const row = ui.optionsPanel.querySelector(`[data-option-row="slider"][data-option-key="${key}"]`) as HTMLElement | null;
    expect(row, key).toBeTruthy();
    const track = row!.querySelector('.options-slider-track') as HTMLElement;
    const thumb = track.querySelector('.options-slider-thumb') as HTMLElement;
    return { pos: Number(track.dataset.sliderPos), left: parseInt(thumb.style.left, 10) };
  }
  function clickFooter(id: number): void {
    const btn = ui.optionsPanel.querySelector(`[data-element-id="0x${id.toString(16)}"]`) as HTMLElement | null;
    expect(btn).toBeTruthy();
    btn!.dispatchEvent(new domWindow.Event('click', { bubbles: true }));
  }

  it('a first session (no persisted blob) starts on the retail defaults', () => {
    expect(ui.optionsSettings.playSoundsOnlyWhenActive).toBe(true);
    expect(ui.optionsSettings.alignCameraToSlope).toBe(true);
    expect(ui.optionsSettings.syncWithRefreshRate).toBe(false);
    expect(ui.optionsSettings.cameraStiffness).toBe(0.45);
    expect(ui.optionsSettings.cameraAdjustmentSpeed).toBe(40);
    expect(ui.optionsSettings.configUnitsVersion).toBe(3);
    // VISUAL.town-scenery-gaps — auto_update_deg_mul's static initialiser.
    expect(ui.optionsSettings.adaptiveDegrade).toBe(true);
  });

  it('fresh Config tab: bullets ON for Play Sounds Only When Active + Align camera to slope + Adaptive Degrade, OFF for Full Screen / Sync', () => {
    openConfig();
    expect(toggleOn('playSoundsOnlyWhenActive')).toBe('1');
    expect(toggleOn('alignCameraToSlope')).toBe('1');
    expect(toggleOn('fullScreen')).toBe('0');
    expect(toggleOn('syncWithRefreshRate')).toBe('0');
    expect(toggleOn('adaptiveDegrade')).toBe('1');
  });

  it('fresh Config tab: widgets sit at the retail fractions of the 113px travel (Stiffness 25px, Speed 52px, FOV 60px, Brightness/Bias 56px)', () => {
    openConfig();
    expect(slider('cameraStiffness')).toEqual({ pos: 23, left: Math.floor(0.23 * ACTIVE) });
    expect(slider('cameraAdjustmentSpeed')).toEqual({ pos: 47, left: Math.floor((35 / 75) * ACTIVE) });
    expect(slider('fieldOfView')).toEqual({ pos: 53, left: Math.floor((80 / 150) * ACTIVE) });
    expect(slider('screenBrightness')).toEqual({ pos: 50, left: Math.floor(0.5 * ACTIVE) });
    expect(slider('adaptiveDegradeBias')).toEqual({ pos: 50, left: Math.floor(0.5 * ACTIVE) });
    // Concrete pixels, so a range/default regression cannot hide behind the formula.
    expect(slider('cameraStiffness').left).toBe(25);
    expect(slider('cameraAdjustmentSpeed').left).toBe(52);
    expect(slider('fieldOfView').left).toBe(60);
  });

  it('a slider value out of the retail range renders clamped (a stale 0..100 percent cannot push the widget off the track)', () => {
    ui.optionsSettings.cameraStiffness = 50; // legacy percent, never migrated
    openConfig();
    expect(slider('cameraStiffness')).toEqual({ pos: 100, left: ACTIVE });
    ui.optionsSettings.cameraStiffness = 0.45;
  });

  it('Defaults restores the retail values + thumb positions after every Config option was perturbed', () => {
    openConfig();
    ui.optionsSettings.playSoundsOnlyWhenActive = false;
    ui.optionsSettings.alignCameraToSlope = false;
    ui.optionsSettings.syncWithRefreshRate = true;
    ui.optionsSettings.adaptiveDegrade = true;
    ui.optionsSettings.cameraStiffness = 1.0;
    ui.optionsSettings.cameraAdjustmentSpeed = 5;
    ui.optionsSettings.fieldOfView = 160;
    ui.optionsSettings.screenBrightness = -1;
    ui.optionsSettings.adaptiveDegradeBias = 1;
    ui.renderOptionsPanel();
    expect(toggleOn('alignCameraToSlope')).toBe('0');
    expect(slider('cameraStiffness').left).toBe(ACTIVE);
    expect(slider('cameraAdjustmentSpeed').left).toBe(0);

    clickFooter(0x100001fe); // Defaults

    expect(ui.optionsSettings.playSoundsOnlyWhenActive).toBe(true);
    expect(ui.optionsSettings.alignCameraToSlope).toBe(true);
    expect(ui.optionsSettings.syncWithRefreshRate).toBe(false);
    expect(ui.optionsSettings.adaptiveDegrade).toBe(false);
    expect(ui.optionsSettings.cameraStiffness).toBe(0.45);
    expect(ui.optionsSettings.cameraAdjustmentSpeed).toBe(40);
    expect(ui.optionsSettings.fieldOfView).toBe(90);
    expect(ui.optionsSettings.screenBrightness).toBe(0);
    expect(ui.optionsSettings.adaptiveDegradeBias).toBe(0);
    expect(toggleOn('playSoundsOnlyWhenActive')).toBe('1');
    expect(toggleOn('alignCameraToSlope')).toBe('1');
    expect(toggleOn('syncWithRefreshRate')).toBe('0');
    expect(slider('cameraStiffness').left).toBe(25);
    expect(slider('cameraAdjustmentSpeed').left).toBe(52);
    expect(slider('fieldOfView').left).toBe(60);
    expect(slider('screenBrightness').left).toBe(56);
    // The units stamp is not a page option: Defaults never touches it.
    expect(ui.optionsSettings.configUnitsVersion).toBe(3);
    expect(ui.optionsPanel.querySelector('[data-option-key="configUnitsVersion"]')).toBeNull();
  });

  it('consumers read retail units: default → stiffness 0.45 / no screen gamma; range ends pass through (CORE.18.b.a.a: SetStiffness takes the pref; CORE.17.q.a.a: the ramp is 1 + 2·clamp(pref, −0.2, 1) on the frame root)', () => {
    const stiffness: number[] = [];
    const cc = { lookSpeed: 0, adjustmentSpeed: 0, alignToSlope: false, setStiffness: (v: number) => { stiffness.push(v); } };
    const canvas = domWindow.document.createElement('canvas');
    ui.setUIHost({ cameraController: cc, renderer: { domElement: canvas } });
    openConfig();
    clickFooter(0x100001fe); // Defaults → applyOptionsBulk re-applies every consumer
    expect(cc.lookSpeed).toBeCloseTo(0.002, 6);
    expect(stiffness.at(-1)).toBeCloseTo(0.45, 6);
    expect(cc.adjustmentSpeed).toBe(40);
    expect(cc.alignToSlope).toBe(true);
    expect(canvas.style.filter).toBe('');
    expect(domWindow.document.body.style.filter).toBe('');

    ui.optionsSettings.cameraStiffness = 1.0;
    ui.optionsSettings.screenBrightness = 1;
    ui.applyOptionsBulk({});
    expect(stiffness.at(-1)).toBeCloseTo(1, 6);
    expect(canvas.style.filter).toBe('');
    expect(domWindow.document.body.style.filter).toBe('brightness(3.000)');

    ui.optionsSettings.cameraStiffness = 0.2857143;
    ui.optionsSettings.screenBrightness = -1;
    ui.applyOptionsBulk({});
    expect(stiffness.at(-1)).toBeCloseTo(0.2857143, 6);
    expect(canvas.style.filter).toBe('');
    expect(domWindow.document.body.style.filter).toBe('brightness(0.600)');
    clickFooter(0x100001fe);
  });

  it('CORE.17.h.g — Camera Adjustment Speed is not a mouse-look factor: retail multiplies it into the camera-rotate KEY step (decomp :90837) and the zoom tick (CORE.18.b.a.a), so it drives adjustmentSpeed, never lookSpeed', () => {
    const cc = { lookSpeed: 0, adjustmentSpeed: 0 };
    ui.setUIHost({ cameraController: cc });
    openConfig();
    clickFooter(0x100001fe);
    expect(cc.lookSpeed).toBeCloseTo(0.002, 6);
    for (const speed of [5, 80, 100]) {
      ui.optionsSettings.cameraAdjustmentSpeed = speed;
      ui.applyOptionsBulk({});
      expect(cc.lookSpeed, `speed ${speed}`).toBeCloseTo(0.002, 6);
      expect(cc.adjustmentSpeed, `speed ${speed}`).toBe(Math.min(80, speed));
    }
    clickFooter(0x100001fe);
    expect(ui.optionsSettings.cameraAdjustmentSpeed).toBe(40);
  });

  it('a persisted pre-fix blob (0..100 percents, no stamp) is migrated on construction; a stamped blob is trusted', () => {
    domWindow.localStorage.setItem('ac_options_settings_v1', JSON.stringify({
      cameraStiffness: 50, cameraAdjustmentSpeed: 50, screenBrightness: 50, adaptiveDegradeBias: 50, fieldOfView: 75,
      syncWithRefreshRate: true,
    }));
    const legacy = new GameUICls(domWindow.document.createElement('div'));
    expect(legacy.optionsSettings.cameraStiffness).toBeCloseTo(0.643, 3);
    expect(legacy.optionsSettings.cameraAdjustmentSpeed).toBe(42.5);
    expect(legacy.optionsSettings.screenBrightness).toBe(0);
    expect(legacy.optionsSettings.adaptiveDegradeBias).toBe(0);
    expect(legacy.optionsSettings.fieldOfView).toBe(75);
    expect(legacy.optionsSettings.syncWithRefreshRate).toBe(true); // a player's own choice survives
    expect(legacy.optionsSettings.configUnitsVersion).toBe(3);

    domWindow.localStorage.setItem('ac_options_settings_v1', JSON.stringify({
      configUnitsVersion: 2, cameraStiffness: 0.9, cameraAdjustmentSpeed: 50,
    }));
    const stamped = new GameUICls(domWindow.document.createElement('div'));
    expect(stamped.optionsSettings.cameraStiffness).toBe(0.9);
    expect(stamped.optionsSettings.cameraAdjustmentSpeed).toBe(50);
    domWindow.localStorage.removeItem('ac_options_settings_v1');
  });
});

describe.skipIf(!existsSync(DECOMP))('CORE.17.h.f — decompiled-client ground truth for the defaults + ranges', () => {
  let initOptions = '';
  let attachBlock = '';
  beforeAll(() => {
    const src = readFileSync(DECOMP, 'utf8');
    const start = src.indexOf('// ===== gmConfigUI::InitOptions @ 0049e400 =====');
    expect(start).toBeGreaterThan(0);
    initOptions = src.slice(start, src.indexOf('// =====', start + 60));
    const a = src.indexOf('UIPreferences::SetPreferenceRange(&Camera_Stiffness');
    expect(a).toBeGreaterThan(0);
    attachBlock = src.slice(a - 4000, a + 400);
  });

  it('InitOptions hands each option its SetDefaultValue through slot +0x2d8 with the values we ship', () => {
    // Ghidra wraps long calls onto a continuation line and may park the
    // result in a member (this->m_pSlope = …) before the SetDefaultValue call.
    const toggleDefault = (pref: string, value: 0 | 1): RegExp => new RegExp(
      `AddToggleOption\\s*\\(\\(PlayerOptionPage \\*\\)this,&(::)?${pref}\\);\\s*(this->\\w+ = pUVar\\d;\\s*)?` +
      `\\(\\*\\*\\(code \\*\\*\\)\\(pUVar\\d->_padding_ \\+ 0x2d8\\)\\)\\(${value}\\);`,
    );
    expect(initOptions).toMatch(toggleDefault('Sound_PlaySoundOnlyWhenActive', 1));
    expect(initOptions).toMatch(toggleDefault('Camera_AlignToSlope', 1));
    expect(initOptions).toMatch(toggleDefault('Display_SyncToRefresh', 0));
    expect(initOptions).toMatch(toggleDefault('Display_FullScreen', 1));
    expect(initOptions).toMatch(toggleDefault('Render_AutomaticDegrades', 0));
    expect(initOptions).toMatch(/m_pStiffness->_padding_ \+ 0x2d8\)\)\(0x3ee66666\)/);      // 0.45f
    expect(initOptions).toMatch(/m_pAdjustmentSpeed->_padding_ \+ 0x2d8\)\)\(0x42200000\)/); // 40.0f
    expect(initOptions).toMatch(/Render_FieldOfView,true\);[\s\S]{0,200}\+ 0x2d8\)\)\(0x42b40000\)/); // 90.0f
    expect(initOptions).toMatch(/Render_ScreenBrightness,true\);[\s\S]{0,200}\+ 0x2d8\)\)\(0\)/);
    expect(initOptions).toMatch(/Render_GraphicsPerformance,true\);[\s\S]{0,200}\+ 0x2d8\)\)\(0\)/);
    // The float literals decode to our defaults.
    const f32 = (hex: number): number => new DataView(new Uint32Array([hex]).buffer).getFloat32(0, true);
    expect(f32(0x3ee66666)).toBeCloseTo(GameUI.OPTIONS_DEFAULTS.cameraStiffness as number, 6);
    expect(f32(0x42200000)).toBe(GameUI.OPTIONS_DEFAULTS.cameraAdjustmentSpeed);
    expect(f32(0x42b40000)).toBe(GameUI.OPTIONS_DEFAULTS.fieldOfView);
  });

  it('SetPreferenceRange calls carry our CONFIG_SLIDER_RANGES', () => {
    const R = GameUI.CONFIG_SLIDER_RANGES;
    expect(attachBlock).toContain(`SetPreferenceRange(&Camera_Stiffness,${R.cameraStiffness.min},${R.cameraStiffness.max.toFixed(1)});`);
    expect(attachBlock).toContain(`SetPreferenceRange(&Camera_AdjustmentSpeed,${R.cameraAdjustmentSpeed.min.toFixed(1)},${R.cameraAdjustmentSpeed.max.toFixed(1)});`);
    expect(attachBlock).toContain(`SetPreferenceRange(&::Render_FieldOfView,${R.fieldOfView.min.toFixed(1)},${R.fieldOfView.max.toFixed(1)});`);
    expect(attachBlock).toContain(`SetPreferenceRange(&::Render_ScreenBrightness,${R.screenBrightness.min.toFixed(1)},${R.screenBrightness.max.toFixed(1)});`);
    expect(attachBlock).toContain(`SetPreferenceRange(&::Render_GraphicsPerformance,${R.adaptiveDegradeBias.min.toFixed(1)},${R.adaptiveDegradeBias.max.toFixed(1)});`);
  });
});
