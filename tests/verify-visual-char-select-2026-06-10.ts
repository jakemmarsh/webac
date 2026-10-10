/**
 * char-select panel visual-fidelity pins (burndown 2026-06-10).
 *
 * VISUAL.148/.145/.146 — the bottom button row used invented labels and put
 * "Restore" in the CREDITS slot. The DAT (layout 0x21000004): the (36,522) slot
 * (0x1000039e/0x1000039f) is the RESTORE/DELETE state toggle (str 184855186 /
 * 197392594); (465,522) (0x100003a3) is CREDITS (str 198852211); (615,522)
 * (0x100003a4) is EXIT (str 149740564). NOTE: visual capture of these buttons
 * is blocked in our test setup — the +TestChar account auto-enters the world
 * before the char-select buttons persist.
 *
 * DEBT.test-harness-hygiene: every check here is now behavioural (the real
 * GameUI char-select render in happy-dom); the former GameUI.ts source pins
 * for VISUAL.148 (string ids) and VISUAL.107 (frameless list) are driven
 * through registered StringTable entries and the rendered list's styles.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { registerStringTable } from '../packages/dat-parser/src/file-types/LayoutDesc.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame'] as const;

describe('char-select visual fidelity 2026-06-10', () => {
  // VISUAL.146/.145 — converted from a source pin to a behavioural test in
  // CORE.17.k.b.b.a (2026-09-13): GameUI in happy-dom (DAT-less, the DAT
  // rects fall back to the hard-coded 0x21000004 positions).
  describe('VISUAL.146/.145 — CREDITS occupies the (465,522) slot, not Restore (behavioural)', () => {
    const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let GameUICtor: any;
    beforeAll(async () => {
      const g = globalThis as Record<string, unknown>;
      installDomGlobals(domWindow, DOM_GLOBALS, saved);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (typeof (g as any).requestAnimationFrame !== 'function') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (g as any).requestAnimationFrame = () => 0;
        domWindow.requestAnimationFrame = (g as { requestAnimationFrame: unknown }).requestAnimationFrame;
      }
      GameUICtor = (await import('../packages/renderer/src/ui/GameUI.js')).GameUI;
    });
    afterAll(() => {
      restoreDomGlobals(DOM_GLOBALS, saved);
    });
    const buttonAt = (container: HTMLElement, x: number, y: number): HTMLElement | undefined =>
      (Array.from(container.querySelectorAll('button')) as HTMLElement[]).find((b) => b.style.left === `${x}px` && b.style.top === `${y}px`);
    function show(chars: Array<{ id: number; name: string; deleteTime?: number }>) {
      domWindow.document.body.innerHTML = '';
      const container = domWindow.document.createElement('div');
      domWindow.document.body.appendChild(container);
      const ui = new GameUICtor(container);
      ui.getTexURL = () => null;
      ui.layoutRenderer = null;
      ui.showCharacterSelect(chars);
      ui.selectScreen.selectCharacter(0);
      ui.renderCharacterSelect();
      return container;
    }
    it('the (465,522) button reads CREDITS and the (36,522) toggle reads DELETE for a live character', () => {
      const container = show([{ id: 1, name: 'Perf Tester' }]);
      expect(buttonAt(container, 465, 522)?.textContent).toBe('CREDITS');
      expect(buttonAt(container, 36, 522)?.textContent).toBe('DELETE');
      expect(buttonAt(container, 615, 522)?.textContent).toBe('EXIT');
      const labels = (Array.from(container.querySelectorAll('button')) as HTMLElement[]).map((b) => b.textContent);
      expect(labels).not.toContain('Restore');
      expect(labels).not.toContain('Delete Character');
    });
    it('the (36,522) toggle reads RESTORE for a character pending deletion; CREDITS stays at (465,522)', () => {
      const container = show([{ id: 1, name: 'Perf Tester', deleteTime: 1_700_000_000 }]);
      expect(buttonAt(container, 36, 522)?.textContent).toBe('RESTORE');
      expect(buttonAt(container, 465, 522)?.textContent).toBe('CREDITS');
    });
  });

  // VISUAL.147 — converted from a source pin to a behavioural test in
  // CORE.17.k.b.b.a (2026-09-13), which also corrected the ENTER faces: the
  // DAT (0x21000004:0x100003a2, template 0x100002d9) puts the gold-rimmed
  // circle 0x06004cb2 on state 0x1, 0x06004cb3 on hover / pressed and
  // 0x06004cb5 on disabled; 0x06004cb1 is only the element's base media.
  describe('VISUAL.147 — the 5 buttons use the DAT template state textures, not CSS boxes (behavioural)', () => {
    const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let GameUICtor: any;
    beforeAll(async () => {
      const g = globalThis as Record<string, unknown>;
      installDomGlobals(domWindow, DOM_GLOBALS, saved);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (typeof (g as any).requestAnimationFrame !== 'function') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (g as any).requestAnimationFrame = () => 0;
        domWindow.requestAnimationFrame = (g as { requestAnimationFrame: unknown }).requestAnimationFrame;
      }
      GameUICtor = (await import('../packages/renderer/src/ui/GameUI.js')).GameUI;
    });
    afterAll(() => {
      restoreDomGlobals(DOM_GLOBALS, saved);
    });
    const buttonAt = (container: HTMLElement, x: number, y: number): HTMLElement =>
      (Array.from(container.querySelectorAll('button')) as HTMLElement[]).find((b) => b.style.left === `${x}px` && b.style.top === `${y}px`)!;
    const face = (b: HTMLElement): string => (/tex-([0-9a-f]+)/.exec(b.style.backgroundImage) ?? [])[1] ?? '';
    function show(select: boolean, atCap = false) {
      domWindow.document.body.innerHTML = '';
      const container = domWindow.document.createElement('div');
      domWindow.document.body.appendChild(container);
      const ui = new GameUICtor(container);
      ui.getTexURL = (id: number) => `data:tex-${id.toString(16)}`;
      ui.layoutRenderer = null;
      ui.showCharacterSelect([{ id: 1, name: 'Perf Tester' }], atCap ? 1 : undefined);
      // BUG.charsel-no-default-selection — the list opens with its first
      // playable character selected; the no-selection case clears it.
      if (select) ui.selectScreen.selectCharacter(0);
      else ui.selectScreen.clearSelection();
      ui.renderCharacterSelect();
      return container;
    }
    it('with a character selected: ENTER shows the gold-rimmed 0x06004cb2, DELETE / CREDITS / EXIT 0x06004c9e, Create 0x06004ca3; hover / pressed swap to the DAT hover / pressed faces', () => {
      const c = show(true);
      const enter = buttonAt(c, 239, 289);
      expect(face(enter)).toBe('6004cb2');
      enter.dispatchEvent(new domWindow.MouseEvent('mouseenter'));
      expect(face(enter)).toBe('6004cb3');
      enter.dispatchEvent(new domWindow.MouseEvent('mousedown'));
      expect(face(enter)).toBe('6004cb3');
      enter.dispatchEvent(new domWindow.MouseEvent('mouseleave'));
      expect(face(enter)).toBe('6004cb2');
      for (const [x, y] of [[36, 522], [465, 522], [615, 522]]) {
        const b = buttonAt(c, x, y);
        expect(face(b), `${x},${y}`).toBe('6004c9e');
        b.dispatchEvent(new domWindow.MouseEvent('mouseenter'));
        expect(face(b)).toBe('6004c9f');
        b.dispatchEvent(new domWindow.MouseEvent('mousedown'));
        expect(face(b)).toBe('6004ca0');
      }
      const create = buttonAt(c, 216, 185);
      expect(face(create)).toBe('6004ca3');
      create.dispatchEvent(new domWindow.MouseEvent('mouseenter'));
      expect(face(create)).toBe('6004ca4');
      // no invented CSS box on any of them
      for (const b of Array.from(c.querySelectorAll('button')) as HTMLElement[]) {
        expect(b.style.backgroundImage).toMatch(/^url\(/);
        expect(b.style.border).toMatch(/^none/);
      }
    });
    it('with no selection: ENTER and DELETE wear their disabled faces 0x06004cb5 / 0x06004ca1 and ignore hover; at the slot cap Create wears 0x06004ca6', () => {
      const c = show(false);
      const enter = buttonAt(c, 239, 289);
      expect(face(enter)).toBe('6004cb5');
      enter.dispatchEvent(new domWindow.MouseEvent('mouseenter'));
      expect(face(enter)).toBe('6004cb5');
      expect(face(buttonAt(c, 36, 522))).toBe('6004ca1');
      expect(face(buttonAt(c, 216, 185))).toBe('6004ca3');
      const capped = show(false, true);
      expect(face(buttonAt(capped, 216, 185))).toBe('6004ca6');
    });
  });

  // Shared char-select render for the two describes below.
  function renderCharSelect(GameUICtor: any, chars: Array<{ id: number; name: string; deleteTime?: number }>, slotCount?: number) {
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui = new GameUICtor(container);
    ui.getTexURL = () => null;
    ui.layoutRenderer = null;
    ui.showCharacterSelect(chars, slotCount);
    ui.selectScreen.selectCharacter(0);
    ui.renderCharacterSelect();
    return container as HTMLElement;
  }

  describe('VISUAL.107 — the character list is frameless (no invented chrome), DAT row height 20 (behavioural)', () => {
    const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let GameUICtor: any;
    beforeAll(async () => {
      installDomGlobals(domWindow, DOM_GLOBALS, saved);
      GameUICtor = (await import('../packages/renderer/src/ui/GameUI.js')).GameUI;
    });
    afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

    // VISUAL.charselect-name-row — the row height is not p96: RebuildCharacterList
    // @ 004ec3a0 sizes rows to max(320 / max(slots, characters), 320 / 20).
    it('the list container 0x1000039c carries no fill or border; rows take RebuildCharacterList height (320 / 11 slots = 29)', () => {
      const c = renderCharSelect(GameUICtor, [{ id: 1, name: 'Perf Tester' }, { id: 2, name: 'Alt' }], 11);
      const rows = [...c.querySelectorAll('.char-slot')] as HTMLElement[];
      expect(rows.length).toBe(2);
      const listEl = rows[0].parentElement!.parentElement as HTMLElement;
      expect(listEl.style.background).toMatch(/transparent/);
      expect(listEl.style.background).not.toMatch(/rgba\(8, ?8, ?24/);
      expect(listEl.style.border).toMatch(/^none/);
      for (const r of rows) {
        expect(r.style.height).toBe('29px');
        expect(r.style.borderLeft ?? '').toBe('');
      }
    });
  });

  // Registers StringTable entries, so it runs last (the describes above
  // assert the DAT-less fallbacks).
  describe('VISUAL.148 — bottom buttons take their labels from the DAT string ids (behavioural)', () => {
    const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let GameUICtor: any;
    const entry = (id: number, text: string) => ({ id, varNames: [], vars: [], strings: [text], comments: [], unknown: 0 });
    beforeAll(async () => {
      installDomGlobals(domWindow, DOM_GLOBALS, saved);
      GameUICtor = (await import('../packages/renderer/src/ui/GameUI.js')).GameUI;
      registerStringTable({ id: 0x23000001, language: 1, unknown: 0, entries: [
        entry(197392594, 'dat:DELETE'), entry(184855186, 'dat:RESTORE'),
        entry(198852211, 'dat:CREDITS'), entry(149740564, 'dat:EXIT'),
      ] });
    });
    afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));
    const labelAt = (c: HTMLElement, x: number, y: number): string | null | undefined =>
      (Array.from(c.querySelectorAll('button')) as HTMLElement[]).find((b) => b.style.left === `${x}px` && b.style.top === `${y}px`)?.textContent;

    it('DELETE 197392594 / CREDITS 198852211 / EXIT 149740564 on a live character', () => {
      const c = renderCharSelect(GameUICtor, [{ id: 1, name: 'Perf Tester' }]);
      expect(labelAt(c, 36, 522)).toBe('dat:DELETE');
      expect(labelAt(c, 465, 522)).toBe('dat:CREDITS');
      expect(labelAt(c, 615, 522)).toBe('dat:EXIT');
    });

    it('RESTORE 184855186 on a character pending deletion', () => {
      const c = renderCharSelect(GameUICtor, [{ id: 1, name: 'Perf Tester', deleteTime: 1_700_000_000 }]);
      expect(labelAt(c, 36, 522)).toBe('dat:RESTORE');
    });
  });
});
