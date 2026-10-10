/**
 * Real-GameUI-in-happy-dom fixture for behavioural tests (DEBT.test-harness-hygiene).
 *
 * Many source-text pins regex-matched GameUI.ts because constructing the UI
 * looked expensive. It isn't: GameUI builds against happy-dom with no DATs
 * (DAT-driven panels fall back to their span/CSS paths), so a pin can usually
 * be replaced by driving the real method and asserting on the DOM / state.
 *
 *   const H = await mountGameUI();
 *   H.ui.openBarberPanel(...);
 *   ...
 *   H.teardown();
 */
import { scriptedRandomSource } from '../../packages/renderer/src/ui/ChargenRandomize.js';
import { CUSTOM_TEMPLATE, ADVENTURER_TEMPLATE } from '../../packages/renderer/src/ui/ChargenTemplates.js';
import { loadDomWindow, installDomGlobals, restoreDomGlobals, type DomWindowSize } from './dom.js';

/** Globals GameUI (and the modules it pulls in) touch at construction/run time. */
export const GAMEUI_DOM_GLOBALS = [
  'window', 'document', 'localStorage', 'HTMLElement', 'HTMLInputElement', 'HTMLCanvasElement',
  'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'WheelEvent', 'CustomEvent', 'getComputedStyle',
  'requestAnimationFrame', 'cancelAnimationFrame', 'Image', 'DOMParser',
] as const;

export interface GameUIFixture {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  win: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ui: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  container: any;
  /** The imported GameUI module (GameUI, AC_COLORS, exported helpers …). */
  mod: typeof import('../../packages/renderer/src/ui/GameUI.js');
  teardown(): void;
}

export interface MountOptions {
  size?: DomWindowSize;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  callbacks?: Record<string, (...args: any[]) => unknown>;
  /** Clear localStorage before constructing (default true). */
  clearStorage?: boolean;
}

/**
 * Install happy-dom globals, import GameUI, construct it in a fresh container
 * and hand back the pieces. `teardown()` removes the container and restores
 * the previous globals. Throws (never skips) if happy-dom cannot load.
 */
export async function mountGameUI(opts: MountOptions = {}): Promise<GameUIFixture> {
  const win = await loadDomWindow(opts.size);
  const saved: Record<string, unknown> = {};
  installDomGlobals(win, GAMEUI_DOM_GLOBALS, saved, 'functions');
  if (opts.clearStorage !== false) win.localStorage.clear();
  const mod = await import('../../packages/renderer/src/ui/GameUI.js');
  const container = win.document.createElement('div');
  win.document.body.appendChild(container);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ui: any = new mod.GameUI(container as HTMLElement, opts.callbacks ?? {});
  return {
    win, ui, container, mod,
    teardown() {
      container.remove();
      restoreDomGlobals(GAMEUI_DOM_GLOBALS, saved);
    },
  };
}

/**
 * VISUAL.options-panel-eol-window — a recording-free `layoutRenderer.render`
 * double for GameUI tests that stub the LayoutRenderer: panels-window frames
 * (0x2100006e) render an empty root, and the Gameplay Options page
 * (0x2100002a, root 0x10000202) renders its seven 240x32 buttons, each with
 * the 0x100002ce/cf/d0 3-slice children, as `data-element-id` nodes the way
 * the real renderer tags them. Kept apart from the tests' `renderPanel`
 * doubles so rendering a sub-layout never resets what they record.
 */
export const GAMEPLAY_OPTIONS_BUTTON_IDS = [0x10000203, 0x10000617, 0x10000204, 0x100005cc, 0x10000205, 0x10000206, 0x10000207] as const;

export function stubLayoutRender(doc: Document) {
  return (layoutId: number, parent: HTMLElement) => {
    const root = doc.createElement('div');
    root.dataset.layoutId = `0x${layoutId.toString(16).padStart(8, '0')}`;
    parent.appendChild(root);
    const elements = new Map<number, HTMLElement>();
    if (layoutId === 0x2100002a) {
      for (const id of GAMEPLAY_OPTIONS_BUTTON_IDS) {
        const btn = doc.createElement('div');
        btn.dataset.elementId = `0x${id.toString(16)}`;
        for (const sid of [0x100002ce, 0x100002cf, 0x100002d0]) {
          const slice = doc.createElement('div');
          slice.dataset.elementId = `0x${sid.toString(16)}`;
          btn.appendChild(slice);
        }
        root.appendChild(btn);
        elements.set(id, btn);
      }
    }
    return {
      root, elements,
      setState: () => {}, setText: () => {}, setInteractive: () => {}, setVisible: () => {},
      setTexture: () => {}, onClick: () => {}, resizeSubtree: () => {}, close: () => { root.remove(); },
    };
  };
}

export interface OpenChargenOptions {
  /** Click the Custom row after the open roll (default true): all 10s, no skills. */
  custom?: boolean;
}

/**
 * Open the chargen from a known character. A fresh chargen runs
 * CharGenState::RandomizeCharacter (the gmCharGenMainUI ctor @ 004e7eb0),
 * so the roll is scripted to the first entries (heritage 1 Aluvian, gender
 * 1 Male, index 0 of every appearance list, the first template and start
 * area). With `custom` (the default) the player's Custom-row click follows
 * (SetTemplate(0) + ApplyTemplate: the Adventurer template's all-10s and no
 * skills, ClearLocks, FitTemplateToCharacter) — the starting point the
 * slider / lock / summary tests build on.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function openChargen(ui: any, opts: OpenChargenOptions = {}): void {
  ui.chargenRandomSource = scriptedRandomSource([0], [0]);
  ui.showCharacterCreate();
  if (opts.custom === false) return;
  const templates = ui.chargenTemplates();
  ui.wizard.setTemplate(CUSTOM_TEMPLATE);
  ui.wizard.applyTemplate(templates.length > 0 ? templates : [ADVENTURER_TEMPLATE], ui.chargenSkillCosts());
  ui.wizard.clearAttributeLocks();
  ui.wizard.fitTemplateToCharacter(templates);
  ui.renderCharacterCreate();
}
