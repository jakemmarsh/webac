/**
 * BUG.charselect-resize-listener-leak — renderCharacterSelect() must not
 * accumulate a fresh 'resize' listener on every re-render.
 *
 * showCharacterSelect/setWorldName/slot-click/delete/restore all re-invoke
 * renderCharacterSelect() within one page session (6 call sites per the
 * filed task). Each prior call added a brand-new updateCharselScale closure
 * via window.addEventListener('resize', ...) with no matching
 * removeEventListener anywhere in the file — unlike hidePortalSpace's
 * correct _resizeCleanup pattern in the same file — so every re-render
 * permanently retained a stale closure over a detached DOM node.
 *
 * Fix under test: renderCharacterSelect() caches the handler on
 * this.charselResizeCleanup and removes the previous one before adding the
 * new one, so at most one 'resize' listener from this code path is ever
 * live at a time.
 *
 * Behavioral suite — drives the real GameUI class under happy-dom (same
 * harness as verify-charselect-no-resurrect.ts; tests/_harness/dom.ts).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame'] as const;

const SLOT = { id: '1342177281', name: '+Fable', level: 1, race: 'Aluvian', class: 'Adventurer' };

describe('BUG.charselect-resize-listener-leak — resize listener stays singular across re-renders', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  let addSpy: ReturnType<typeof vi.spyOn>;
  let removeSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved, 'functions');
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  afterEach(() => {
    addSpy?.mockRestore();
    removeSpy?.mockRestore();
  });

  function resizeCalls(spy: ReturnType<typeof vi.spyOn>): unknown[][] {
    return spy.mock.calls.filter((c: unknown[]) => c[0] === 'resize');
  }

  // Each case gets its own GameUI instance — charselResizeCleanup state
  // otherwise carries over between test bodies since GameUI persists it
  // on the instance, not the module.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function freshUi(): Promise<any> {
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    return new mod.GameUI(container);
  }

  it('a single render adds exactly one resize listener and removes none', async () => {
    const ui = await freshUi();
    addSpy = vi.spyOn(domWindow, 'addEventListener');
    removeSpy = vi.spyOn(domWindow, 'removeEventListener');
    ui.showCharacterSelect([SLOT]);
    expect(resizeCalls(addSpy).length).toBe(1);
    expect(resizeCalls(removeSpy).length).toBe(0);
  });

  it('re-rendering while still on character-select removes the previous listener before adding the new one', async () => {
    const ui = await freshUi();
    addSpy = vi.spyOn(domWindow, 'addEventListener');
    removeSpy = vi.spyOn(domWindow, 'removeEventListener');

    // setWorldName re-renders via renderCharacterSelect() while already on
    // character-select (mirrors real ServerName-message-arrives-late flow).
    ui.showCharacterSelect([SLOT]);
    ui.setWorldName('Local Server');
    ui.setWorldName('Local Server 2');

    const adds = resizeCalls(addSpy);
    const removes = resizeCalls(removeSpy);
    expect(adds.length).toBe(3);
    expect(removes.length).toBe(2);
    // Each removed handler must be the immediately-prior added handler, not
    // some other stale reference — proves the specific closure is torn down.
    expect(removes[0][1]).toBe(adds[0][1]);
    expect(removes[1][1]).toBe(adds[1][1]);
  });

  it('only the latest resize handler remains live after several re-renders', async () => {
    const ui = await freshUi();
    addSpy = vi.spyOn(domWindow, 'addEventListener');
    removeSpy = vi.spyOn(domWindow, 'removeEventListener');

    ui.showCharacterSelect([SLOT]);
    ui.setWorldName('Yet Another Server');

    const adds = resizeCalls(addSpy);
    const removes = resizeCalls(removeSpy);
    // net live listeners registered by this code path = adds - removes
    expect(adds.length - removes.length).toBe(1);
  });
});
