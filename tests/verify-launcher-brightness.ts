/**
 * BUG.launcher-brightness (webac#21) — "the in-game brightness slider affects the server selector".
 *
 * The Config brightness slider's gamma ramp is a CSS brightness() on document.body
 * (ui/ScreenGamma.ts), applied at boot from the saved pref (setClientRules) and at world start.
 * The launcher (server select + login) is ours: retail's was the separate Turbine launcher,
 * outside acclient's D3D gamma ramp, so it is never brightened in any era. The client's own
 * screens keep retail's ramp in end of retail / Dark Majesty (installed from the first frame by
 * Client::KeepUIAlive @ 004112d0 → SceneTool::PrepareGraphicsDevice @ 0043e4f0 →
 * Render::UpdateFromPreferences @ 0054d850), and 1999 has no ramp at all (the landscape floor).
 *
 * Real GameUI in happy-dom: the launcher's own run() is stubbed to a promise the test settles,
 * everything else (GameUI.showLauncher, the screen it draws, applyScreenBrightness) is shipped code.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { frameScreenBrightnessFilter } from '../packages/renderer/src/ui/ScreenGamma.js';
import { eraClientRules } from '../packages/renderer/src/era/EraFeatures.js';
import { eraProfile } from '../packages/renderer/src/era/EraProfiles.js';
import { LauncherScreen, type LauncherChoice } from '../packages/renderer/src/launcher/LauncherScreen.js';

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle'] as const;
const EOR = eraClientRules(eraProfile('eor')!);
const R1999 = eraClientRules(eraProfile('ac1999-retail')!);

describe('frameScreenBrightnessFilter', () => {
  it('the client\'s own screens in a gamma era carry retail\'s ramp', () => {
    expect(frameScreenBrightnessFilter(1, { gamma: true, ownScreen: false })).toBe('brightness(3.000)');
    expect(frameScreenBrightnessFilter(-0.2, { gamma: true, ownScreen: false })).toBe('brightness(0.600)');
    expect(frameScreenBrightnessFilter(0, { gamma: true, ownScreen: false })).toBe('');
  });
  it('our own pre-world screens (launcher, connect page) never do', () => {
    expect(frameScreenBrightnessFilter(1, { gamma: true, ownScreen: true })).toBe('');
    expect(frameScreenBrightnessFilter(-1, { gamma: true, ownScreen: true })).toBe('');
  });
  it('1999 (no gamma ramp) never filters', () => {
    expect(frameScreenBrightnessFilter(1, { gamma: false, ownScreen: false })).toBe('');
    expect(frameScreenBrightnessFilter(1, { gamma: false, ownScreen: true })).toBe('');
  });
});

describe('the launcher is never brightened by the saved Screen Brightness (real GameUI)', () => {
  const saved: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any; let domWindow: any;
  const filter = (): string => domWindow.document.body.style.filter;
  /** Stub the launcher's run() so the test decides when the player enters a world. */
  function stubLauncherRun(): { enter: () => void; fail: () => void } {
    let resolve!: (c: LauncherChoice) => void; let reject!: (e: unknown) => void;
    vi.spyOn(LauncherScreen.prototype, 'run').mockImplementation(() => new Promise<LauncherChoice>((res, rej) => { resolve = res; reject = rej; }));
    return {
      enter: () => resolve({ world: null, account: 'a', password: 'p', connectUrl: 'ws://x' } as unknown as LauncherChoice),
      fail: () => reject(new Error('gone')),
    };
  }
  const launcherOpts = { bridgeUrl: 'ws://x', loadDirectory: () => new Promise<never>(() => {}) };

  beforeAll(async () => {
    domWindow = await loadDomWindow();
    installDomGlobals(domWindow, DOM_GLOBALS as never, saved);
    domWindow.localStorage.removeItem('ac_options_settings_v1');
    const { GameUI } = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new GameUI(container);
  });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(() => {
    domWindow.localStorage.removeItem('ac_options_settings_v1');
    domWindow.document.body.style.filter = '';
    restoreDomGlobals(DOM_GLOBALS as never, saved);
  });

  it('a reload with a saved bright pref: boot applies it, the launcher drops it, entering a world restores it (end of retail)', async () => {
    ui.optionsSettings.screenBrightness = 1;
    ui.setClientRules(EOR); // main.ts boot: before the launcher
    expect(filter()).toBe('brightness(3.000)');
    const run = stubLauncherRun();
    const done = ui.showLauncher(launcherOpts);
    expect(filter()).toBe('');
    // A slider-driven re-apply while the launcher is up (Reset / setClientRules) stays off.
    ui.setClientRules(EOR);
    expect(filter()).toBe('');
    run.enter();
    await done;
    // The connecting screen, character select, chargen and portal space are the client's: retail's ramp.
    expect(filter()).toBe('brightness(3.000)');
    ui.showConnectingScreen();
    expect(filter()).toBe('brightness(3.000)');
  });

  it('logout to the launcher (character select World box / Exit Game) turns it off again', async () => {
    ui.optionsSettings.screenBrightness = -0.2;
    ui.showGame();
    expect(filter()).toBe('brightness(0.600)');
    const run = stubLauncherRun();
    const done = ui.showLauncher(launcherOpts);
    expect(filter()).toBe('');
    run.enter();
    await done;
    expect(filter()).toBe('brightness(0.600)');
  });

  it('a launcher that goes away without a choice still gives the ramp back', async () => {
    ui.optionsSettings.screenBrightness = 1;
    ui.setClientRules(EOR);
    const run = stubLauncherRun();
    const done = ui.showLauncher(launcherOpts);
    expect(filter()).toBe('');
    run.fail();
    await expect(done).rejects.toThrow('gone');
    expect(filter()).toBe('brightness(3.000)');
  });

  it('1999: no filter on the launcher or anywhere else (the slider is the landscape floor)', async () => {
    ui.optionsSettings.screenBrightness = 1;
    ui.setClientRules(R1999);
    expect(filter()).toBe('');
    const run = stubLauncherRun();
    const done = ui.showLauncher(launcherOpts);
    expect(filter()).toBe('');
    run.enter();
    await done;
    expect(filter()).toBe('');
    ui.setClientRules(EOR);
    ui.optionsSettings.screenBrightness = 0;
    ui.setClientRules(EOR);
    expect(filter()).toBe('');
  });
});
