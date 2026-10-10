/**
 * BUG.skill-select-scrolls-to-top — clicking a skill near the bottom of the
 * list jumped the list back to the top. Retail's stat lists are persistent
 * UIElement_ListBoxes (selection re-colours rows in place), so a re-render
 * of our character panel must carry each scrolled viewport's offset across
 * the rebuild; switching tabs starts the new page at the top.
 *
 * Drives the real GameUI.renderCharPanel wrapper; the panel rebuild itself
 * (renderCharPanelFresh, the DAT layout path) is replaced by a stand-in that
 * rebuilds the same viewport element, as the real one does.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('BUG.skill-select-scrolls-to-top — renderCharPanel keeps the list scroll', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  let rebuilds = 0;
  const scrollEvents: number[] = [];

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const { GameUI } = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new GameUI(container);
    // Stand-in for the DAT rebuild: a fresh panel with the skills list
    // viewport 0x1000023d at scrollTop 0 (what the real rebuild yields).
    ui.renderCharPanelFresh = () => {
      rebuilds++;
      ui.charPanel?.remove();
      // Both panes inherit the list template, so each holds a 0x1000023d;
      // the Attributes pane (hidden on the Skills tab) comes FIRST in DOM order.
      const panel = domWindow.document.createElement('div');
      for (const paneId of ['0x1000022b', '0x1000022c']) {
        const pane = domWindow.document.createElement('div');
        pane.dataset.elementId = paneId;
        const list = domWindow.document.createElement('div');
        list.dataset.elementId = '0x1000023d';
        list.addEventListener('scroll', () => scrollEvents.push(list.scrollTop));
        pane.appendChild(list);
        panel.appendChild(pane);
      }
      container.appendChild(panel);
      ui.charPanel = panel;
    };
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  const list = (): HTMLElement => ui.charPanel.querySelector('[data-element-id="0x1000022c"] [data-element-id="0x1000023d"]');
  const attrList = (): HTMLElement => ui.charPanel.querySelector('[data-element-id="0x1000022b"] [data-element-id="0x1000023d"]');

  it('a re-render on the same tab (e.g. selecting a skill) restores the list offset and syncs the scrollbar', () => {
    ui.charPanelTab = 'skills';
    ui.renderCharPanel();
    list().scrollTop = 340;
    scrollEvents.length = 0;
    ui.renderCharPanel();
    expect(rebuilds).toBe(2);
    expect(list().scrollTop).toBe(340);
    expect(attrList().scrollTop).toBe(0); // the same-id list in the other pane is untouched
    expect(scrollEvents).toEqual([340]); // bindDatScrollbarWidget's thumb listens on the viewport
  });

  it('switching tabs starts the new page at the top', () => {
    list().scrollTop = 200;
    ui.charPanelTab = 'attributes';
    ui.renderCharPanel();
    expect(list().scrollTop).toBe(0);
  });
});
