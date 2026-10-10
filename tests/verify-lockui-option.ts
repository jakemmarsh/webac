/**
 * FAITHFUL.484 — LockUI CharacterOption (0x33) wired client-side.
 *
 *  Per ACE `CharacterOption.cs:168-169` LockUI = 0x33 / Character
 *  Options2.LockUI. Retail's "Lock UI" toggle prevented panels from
 *  being dragged. ACE persists the bit; the lock is purely client-
 *  side (no server enforcement).
 *
 *  Implementation:
 *  - LayoutRenderer has a static `isUILocked()` / `setUILocked()`
 *    pair backing a class-static `uiLocked` flag. The drag-handle
 *    mousedown bails early when isUILocked() returns true.
 *  - GameUI's optionsSettings.lockUI defaults false.
 *  - OPTIONS_TO_CHARACTER_OPTION maps lockUI → 0x33 so the toggle
 *    round-trips via FAITHFUL.372's setSingleCharacterOption.
 *  - onCharacterOptionToggle in main.ts wires option=0x33 →
 *    LayoutRenderer.setUILocked(value) for the live toggle.
 *  - Startup-apply (FAITHFUL.438 pattern) syncs the persisted bit
 *    with the LayoutRenderer at login.
 *
 *  `LayoutRenderer.isUILocked`/`setUILocked` are real public statics —
 *  driven directly below (no DOM/DAT needed, they just read/write a
 *  class-static boolean). `GameUI.OPTIONS_DEFAULTS`/
 *  `OPTIONS_TO_CHARACTER_OPTION` are likewise public statics, exercised
 *  via the same happy-dom-shimmed dynamic import used by the sibling
 *  behavioral-options tests. main.ts's onCharacterOptionToggle/startup-
 *  apply wiring stays a source citation: it lives inline inside the
 *  login dispatcher with no exported test seam.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LayoutRenderer } from '../packages/renderer/src/ui/LayoutRenderer';

const REPO = resolve(__dirname, '..');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');

describe('FAITHFUL.484 — LayoutRenderer static lock state (behavioral)', () => {
  beforeEach(() => {
    // Reset to the known default between tests (uiLocked defaults false).
    LayoutRenderer.setUILocked(false);
  });

  it('defaults to unlocked', () => {
    expect(LayoutRenderer.isUILocked()).toBe(false);
  });

  it('setUILocked(true) locks, isUILocked() reflects it', () => {
    LayoutRenderer.setUILocked(true);
    expect(LayoutRenderer.isUILocked()).toBe(true);
  });

  it('setUILocked(false) unlocks again', () => {
    LayoutRenderer.setUILocked(true);
    LayoutRenderer.setUILocked(false);
    expect(LayoutRenderer.isUILocked()).toBe(false);
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('FAITHFUL.484 — GameUI options wiring (behavioral, requires happy-dom devDep)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;

  beforeAll(async () => {
    const g = globalThis as Record<string, unknown>;
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    // rAF must stay bound to the happy-dom window object (options panel
    // scrollbar sync schedules a frame).
    g.requestAnimationFrame = (cb: FrameRequestCallback) => domWindow.requestAnimationFrame(cb);
    g.cancelAnimationFrame = (id: number) => domWindow.cancelAnimationFrame(id);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    GameUICtor = mod.GameUI;
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  it('lockUI defaults to false in OPTIONS_DEFAULTS', () => {
    expect(GameUICtor.OPTIONS_DEFAULTS.lockUI).toBe(false);
  });

  it('OPTIONS_TO_CHARACTER_OPTION maps lockUI to 0x33', () => {
    expect(GameUICtor.OPTIONS_TO_CHARACTER_OPTION.lockUI).toBe(0x33);
  });

  // ── Behavioral: LockUI is on NO retail options page (BUG.character-tab-
  // not-retail). The radar padlock (gmRadarUI::ListenToElementMessage
  // @ 004d75b0) and @lockui (DoLockUI @ 005703b0 → GameUI.toggleLockUI) flip
  // it, and the radar's lock/drag buttons follow (CORE.5.b.b,
  // gmRadarUI::UpdateLockedStatus @ 004d7680). ──
  it('the Character tab has no Lock UI row; the radar padlock and toggleLockUI flip lockUI and the drag button', () => {
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui = new GameUICtor(container);
    // Minimal permissive layout-renderer stub (same shape as the sibling
    // panel-options behavioral tests) so renderOptionsPanel + renderHUD run.
    class AutoElements extends Map<number, HTMLElement> {
      private host: HTMLElement;
      constructor(host: HTMLElement) { super(); this.host = host; }
      override get(id: number): HTMLElement {
        let el = super.get(id);
        if (!el) {
          el = domWindow.document.createElement('div');
          this.host.appendChild(el!);
          super.set(id, el!);
        }
        return el!;
      }
    }
    const makeHandle = (parent: HTMLElement) => {
      const wrapper = domWindow.document.createElement('div');
      parent.appendChild(wrapper);
      const root = domWindow.document.createElement('div');
      wrapper.appendChild(root);
      return {
        root, layout: { elements: [] }, elements: new AutoElements(root), descs: new Map(),
        setText: () => {}, setFill: () => {}, setVisible: () => {}, setState: () => {},
        setPalette: () => {}, setInteractive: () => {}, setDraggable: () => {},
        setDropTarget: () => {}, setTexture: () => {}, onClick: () => {},
        moveTo: () => {}, close: () => { wrapper.remove(); }, bringToFront: () => {},
      };
    };
    ui.layoutRenderer = {
      render: (_l: number, parent: HTMLElement) => makeHandle(parent),
      renderPanel: (_l: number, parent: HTMLElement) => makeHandle(parent),
    };
    ui.showGame(); // builds the HUD incl. the radar lock/drag buttons
    const codes: Array<[number, boolean]> = [];
    ui.callbacks.onCharacterOptionToggle = (code: number, on: boolean) => { codes.push([code, on]); };
    ui.optionsTab = 'character';
    ui.renderOptionsPanel();
    expect(container.querySelector('.option-toggle-row[data-option-key="lockUI"]')).toBeNull();
    expect(ui.optionsSettings.lockUI).toBe(false);
    const drag = container.querySelector('#radar-drag-button') as HTMLElement;
    const lock = container.querySelector('#radar-lock-button') as HTMLElement;
    expect(drag).toBeTruthy();
    expect(drag.style.display).not.toBe('none');
    lock.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    expect(ui.optionsSettings.lockUI).toBe(true);
    // gmRadarUI::UpdateLockedStatus — drag button hides while locked.
    expect(drag.style.display).toBe('none');
    // @lockui toggles it back.
    expect(ui.toggleLockUI()).toBe(false);
    expect(ui.optionsSettings.lockUI).toBe(false);
    expect(drag.style.display).not.toBe('none');
    expect(codes).toEqual([[0x33, true], [0x33, false]]);
    container.remove();
  });
});

describe('FAITHFUL.484 — main.ts wiring (citation — no exported test seam)', () => {
  const UI = readFileSync(resolve(REPO, 'packages/renderer/src/ui/GameUI.ts'), 'utf8');

  it('onCharacterOptionToggle sets LayoutRenderer lock for option 0x33', () => {
    expect(MAIN).toMatch(/option === 0x33[\s\S]+?LayoutRenderer\.setUILocked\(value\)/);
  });

  it('startup-apply syncs persisted lockUI', () => {
    expect(MAIN).toMatch(/LayoutRenderer\.setUILocked\(gameUI\.optionsSettings\.lockUI === true\)/);
  });

  it('LayoutRenderer cites FAITHFUL.484', () => {
    const LR = readFileSync(resolve(REPO, 'packages/renderer/src/ui/LayoutRenderer.ts'), 'utf8');
    expect(LR).toMatch(/FAITHFUL\.484/);
  });
  it('GameUI cites FAITHFUL.484', () => {
    expect(UI).toMatch(/FAITHFUL\.484/);
  });
  it('main.ts cites FAITHFUL.484', () => {
    expect(MAIN).toMatch(/FAITHFUL\.484/);
  });
});
