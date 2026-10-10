/**
 * CORE.13.a — every pre-world screen presents the 800x600 frame with a
 * UNIFORM scale-to-fit, centered (letterbox/pillarbox), never a
 * non-uniform stretch.
 *
 * Ground truth (decompiled retail client): gmClient::Init @ 004047a0
 * calls Device::ForceDisplayResolution(true, 800, 600) @ 0043a750 at
 * startup; the force is only released when gmGamePlayUI is constructed
 * (world entry) and re-applied in its destructor (logout). Retail
 * therefore always renders the pre-world flow as a 4:3 800x600 frame —
 * there is no widescreen pre-world frame to imitate, and the DAT layout
 * roots for 0x21000001/2/4 carry edge modes 0 (fixed) or 3 (centered),
 * never 4 (proportional). The browser equivalent of that forced display
 * mode is a uniformly scaled, centered 800x600 surface with black bars.
 *
 * Before this fix char-select applied scale(sx, sy) with independent
 * axes (bust/logo smear at 16:9) while char-create rendered an unscaled
 * centered box — the screens visibly jumped between stretched and boxed.
 *
 * Behavioral suite — drives the real GameUI class under happy-dom (same
 * harness as verify-charselect-resize-listener-leak.ts; tests/_harness/dom.ts).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1920, innerHeight: 1080 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame'] as const;

const SLOT = { id: '1342177281', name: '+Fable', level: 1, race: 'Aluvian', class: 'Adventurer' };

describe('CORE.13.a — pre-world screens use one uniform letterbox scale', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};

  beforeAll(() => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved, 'functions');
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function freshUi(): Promise<any> {
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    // Clear any prior instance's DOM so #charsel-inner lookups can't hit a
    // stale tree from an earlier test body.
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    return new mod.GameUI(container);
  }

  // At 1920x1080 the uniform factor is min(1920/800, 1080/600) = 1.8:
  // the frame becomes 1440x1080, pillarboxed with (1920-1440)/2 = 240px
  // bars left and right and no vertical bars.
  const EXPECTED = { scale: 1.8, left: 240, top: 0 };

  function expectUniformScale(el: HTMLElement): void {
    const m = /^scale\(([\d.]+)\)$/.exec(el.style.transform);
    expect(m, `transform "${el.style.transform}" must be a single-factor scale()`).toBeTruthy();
    expect(Number(m![1])).toBeCloseTo(EXPECTED.scale, 5);
    expect(parseFloat(el.style.left)).toBeCloseTo(EXPECTED.left, 3);
    expect(parseFloat(el.style.top)).toBeCloseTo(EXPECTED.top, 3);
    expect(el.style.width).toBe('800px');
    expect(el.style.height).toBe('600px');
  }

  it('character select scales uniformly and centers at 16:9 (no stretch)', async () => {
    const ui = await freshUi();
    ui.showCharacterSelect([SLOT]);
    const inner = domWindow.document.querySelector('#charsel-inner') as HTMLElement;
    expect(inner).toBeTruthy();
    expectUniformScale(inner);
  });

  it('connecting screen (same surface) scales uniformly too', async () => {
    const ui = await freshUi();
    ui.showConnectingScreen();
    const inner = domWindow.document.querySelector('#charsel-inner') as HTMLElement;
    expect(inner).toBeTruthy();
    expect(inner.dataset.mode).toBe('connecting');
    expectUniformScale(inner);
  });

  it('character create scales uniformly with the SAME factor and centering as char-select', async () => {
    const ui = await freshUi();
    ui.showCharacterCreate();
    const wrapper = domWindow.document.querySelector('#chargen-root') as HTMLElement;
    expect(wrapper).toBeTruthy();
    const inner = wrapper.firstElementChild as HTMLElement;
    expect(inner).toBeTruthy();
    expectUniformScale(inner);
  });

  it('letterbox bars are black on both screens (screen container backdrop)', async () => {
    const ui = await freshUi();
    ui.showCharacterSelect([SLOT]);
    const screens = domWindow.document.querySelector('#game-ui-screens') as HTMLElement;
    expect(screens.style.background).toMatch(/^(#000|rgb\(0,\s*0,\s*0\))$/);
    ui.showCharacterCreate();
    expect(screens.style.background).toMatch(/^(#000|rgb\(0,\s*0,\s*0\))$/);
    const wrapper = domWindow.document.querySelector('#chargen-root') as HTMLElement;
    expect(wrapper.style.background).toMatch(/^(#000|rgb\(0,\s*0,\s*0\))$/);
  });

  it('switching char-select -> char-create keeps exactly one live resize listener', async () => {
    const ui = await freshUi();
    const addSpy = vi.spyOn(domWindow, 'addEventListener');
    const removeSpy = vi.spyOn(domWindow, 'removeEventListener');
    ui.showCharacterSelect([SLOT]);
    ui.showCharacterCreate();
    const adds = addSpy.mock.calls.filter((c: unknown[]) => c[0] === 'resize');
    const removes = removeSpy.mock.calls.filter((c: unknown[]) => c[0] === 'resize');
    expect(adds.length - removes.length).toBe(1);
    // The removed handler is the one char-select registered.
    expect(removes[removes.length - 1][1]).toBe(adds[0][1]);
  });

  it('a window resize re-derives the uniform factor (no stale scale)', async () => {
    const ui = await freshUi();
    ui.showCharacterSelect([SLOT]);
    const inner = domWindow.document.querySelector('#charsel-inner') as HTMLElement;
    // Shrink to a squat 1200x600 viewport: min(1200/800, 600/600) = 1.
    domWindow.innerWidth = 1200;
    domWindow.innerHeight = 600;
    domWindow.dispatchEvent(new domWindow.Event('resize'));
    const m = /^scale\(([\d.]+)\)$/.exec(inner.style.transform);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBeCloseTo(1, 5);
    expect(parseFloat(inner.style.left)).toBeCloseTo((1200 - 800) / 2, 3);
    expect(parseFloat(inner.style.top)).toBeCloseTo(0, 3);
  });
});
