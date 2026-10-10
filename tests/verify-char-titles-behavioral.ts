/**
 * BEHAVIORAL char-titles panel test (VISUAL3, 2026-06-12; reworked for
 * CORE.6) — EXECUTES the shipped titles renderer and inspects the DOM.
 *
 * CORE.6 replaced renderTitlesTab (hand-built rows on the tab container)
 * with renderTitlesPaneNative, which binds into the pane's inherited DAT
 * chrome (0x2100005e:0x1000052d — gmCharacterTitleUI::PostInit @ 0049a610
 * ids). The old VISUAL3 regression ("list collapsed to a one-row strip")
 * cannot recur by construction: the rows render INSIDE the DAT list
 * element 0x10000532, whose geometry comes from the layout, not from row
 * count — asserted here by driving the renderer against a chrome scaffold.
 *
 * Requires happy-dom (devDep; tests/_harness/dom.ts fails loudly without it).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('char-titles panel — behavioral (VISUAL3/CORE.6)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  /** Chrome scaffold with the pane's element ids, as the LayoutRenderer
   *  materializes them ([data-element-id] nodes). The list element gets the
   *  DAT-authored size class of behavior: a fixed height from the layout. */
  function renderTitles(titles: Array<{ id: number; name: string }>, activeId = 0): HTMLElement {
    ui.setTitlesData(titles, activeId);
    ui.selectedTitleId = -1;
    const mk = (id: number, ...children: HTMLElement[]): HTMLElement => {
      const d = domWindow.document.createElement('div');
      d.setAttribute('data-element-id', `0x${id.toString(16)}`);
      for (const c of children) d.appendChild(c);
      return d;
    };
    const list = mk(0x10000532);
    list.style.height = '455px'; // DAT-authored geometry (0x2100005e)
    const body = mk(0x10000539,
      mk(0x1000052e), mk(0x1000052f), mk(0x10000531),
      list, mk(0x10000533),
      mk(0x10000535, mk(0x100002ce), mk(0x100002cf), mk(0x100002d0)),
    );
    domWindow.document.body.appendChild(body);
    ui.renderTitlesPaneNative(body);
    return body;
  }

  const byId = (root: HTMLElement, id: number): HTMLElement =>
    root.querySelector(`[data-element-id="0x${id.toString(16)}"]`) as HTMLElement;

  it('rows render inside the DAT list element — its height comes from the layout, not row count', () => {
    const c = renderTitles([{ id: 1, name: 'Adventurer' }], 1);
    const list = byId(c, 0x10000532);
    expect(list.children.length).toBe(1);
    expect(list.style.height).toBe('455px'); // renderer must not shrink it
    expect(list.style.overflowY).toBe('auto');
    expect(list.textContent).toContain('Adventurer');
    c.remove();
  });

  it('uses the retail label wording (rendered as DOM text, not source-grepped)', () => {
    const c = renderTitles([{ id: 1, name: 'Adventurer' }], 1);
    expect(byId(c, 0x1000052e).textContent).toBe('Current Display Title:');
    expect(byId(c, 0x10000531).textContent).toBe('All Available Titles:');
    expect(byId(c, 0x1000052f).textContent).toBe('Adventurer');
    c.remove();
  });

  it('shows "Unknown" when the display title does not resolve (gmCharacterTitleUI::Refresh @ 0049abc0)', () => {
    const c = renderTitles([{ id: 1, name: 'Adventurer' }], 0);
    expect(byId(c, 0x1000052f).textContent).toBe('Unknown');
    c.remove();
  });

  it('many titles still render into the same fixed DAT list region', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, name: `Title ${i + 1}` }));
    const c = renderTitles(many, 1);
    const list = byId(c, 0x10000532);
    expect(list.children.length).toBe(40);
    expect(list.style.height).toBe('455px');
    c.remove();
  });
});
