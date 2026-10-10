/**
 * char-create panel visual-fidelity pins (burndown 2026-06-10).
 *
 * VISUAL.164 — the chargen Skills page (DAT 0x21000048, header element
 * 0x100003f9) must read "Available Skill Credits" (str 9297410), not the
 * invented "Credits:".
 * VISUAL.154/.85 — the chargen_mainmenu (0x2100003a) bar buttons carry no
 * invented box and sit at their DAT y inside the master's 0x100003cf
 * placeholder (y=540). VISUAL.chargen-heritage-lore-spacing overturned the
 * earlier "+10 px" (root y=550 added on top): char-create-ref1.png's chevron
 * gold is centred at y≈574.5 in 800x600, i.e. the element top ≈553 = 540 + 13.
 *
 * The VISUAL.164 / VISUAL.154 cases were converted from source-text pins to
 * behavioural tests in CORE.17.k.b.b.a (2026-09-13): GameUI is driven in
 * happy-dom (DAT-less, stub layout renderer — DAT positions fall back to the
 * hard-coded 0x2100003a rects) and the rendered DOM is asserted.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;

describe('char-create visual fidelity 2026-06-10 (behavioural, happy-dom)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;

  beforeAll(async () => {
    const g = globalThis as Record<string, unknown>;
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof (g as any).requestAnimationFrame !== 'function') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (g as any).requestAnimationFrame = () => 0; (g as any).cancelAnimationFrame = () => {};
      domWindow.requestAnimationFrame = (g as { requestAnimationFrame: unknown }).requestAnimationFrame;
    }
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    GameUICtor = mod.GameUI;
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  function makeUI() {
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui = new GameUICtor(container);
    ui.getTexURL = () => null;
    ui.layoutRenderer = null; // DAT-less: chargen falls back to the hard-coded 0x21000038 / 0x2100003a rects
    ui.showCharacterCreate();
    return { ui, container };
  }

  it('VISUAL.164 — chargen Skills header is "Available Skill Credits" (str 9297410), the invented "Credits:" is gone', () => {
    const { ui, container } = makeUI();
    ui.wizard.setHeritage(1);
    ui.wizard.currentStep = 2; // CreateStep.Skills
    ui.renderCharacterCreate();
    expect(container.querySelector('#chargen-root')?.getAttribute('data-step')).toBe('2');
    const header = container.querySelector('[data-ac-desc="21000048:100003f9"]') as HTMLElement;
    expect(header).toBeTruthy();
    expect(header.textContent).toBe('Available Skill Credits');
    expect(container.textContent).not.toContain('Credits:');
    // the available count is a separate run (the DAT value child 0x100002f3), not glued into the label
    const value = container.querySelector('[data-ac-desc="21000048:100003f9/100002f3"]') as HTMLElement;
    expect(value).toBeTruthy();
    expect(value.textContent).toBe(String(ui.wizard.skillCreditsRemaining));
  });

  it('VISUAL.154/.85 — chargen bottom-bar buttons are bare (no invented box) at their DAT rects; Back/Next are chevron media, not glyphs', () => {
    const { container } = makeUI();
    const btn = (id: string): HTMLElement => container.querySelector(`#${id}`) as HTMLElement;
    for (const [id, x, y, w, h, label] of [
      ['btn-cancel', 379, 21, 39, 24, 'Exit'], ['btn-random', 486, 21, 75, 24, 'Random'],
    ] as Array<[string, number, number, number, number, string]>) {
      const b = btn(id);
      expect(b, id).toBeTruthy();
      expect([b.style.left, b.style.top, b.style.width, b.style.height]).toEqual([`${x}px`, `${y}px`, `${w}px`, `${h}px`]);
      expect(b.style.background).toBe('transparent');
      expect(b.style.border).toMatch(/^none/);
      expect(b.style.backgroundImage).not.toMatch(/url\(/);
      expect(b.textContent).toBe(label);
    }
    for (const [id, x, y] of [['btn-back', 25, 13], ['btn-next', 68, 13]] as Array<[string, number, number]>) {
      const b = btn(id);
      expect([b.style.left, b.style.top, b.style.width, b.style.height]).toEqual([`${x}px`, `${y}px`, '47px', '44px']);
      expect(b.style.border).toMatch(/^none/);
      expect(b.textContent).toBe(''); // no '<' / '>' glyph: the DAT chevron media
      expect(b.dataset.acMedia).toMatch(/^6004c(8f|91|92)$/);
    }
    // the invented buttonBg boxes are gone from the bar
    const bar = btn('btn-cancel').parentElement as HTMLElement;
    for (const child of Array.from(bar.children) as HTMLElement[]) expect(child.style.background).not.toContain('rgb(26, 24, 48)');
  });
});

// VISUAL.82's source pin on the chargen tab strip was converted into a
// behavioural test in tests/verify-core17kbbcc-native-cells.ts (CORE.17.k.b.b.c.c:
// the tabs are layout 0x21000039's own UIElement_Buttons in states 1 / 6).
