/**
 * BUG.spell-drag-source-torn-out (Reddit, RaptorBuckets, 2026-11-07: "I can't
 * drag my spells from the spell book into the spell bar. Worked for a while,
 * then didn't").
 *
 * A press on a spellbook row holds the magic panel's rebuilds (PanelPressGuard).
 * Chrome and Edge fire pointercancel as a native drag starts; the guard took
 * that as the release and ran the held rebuild at once, mid-drag. The rebuild
 * replaced the row the drag came from, so the drag's dragend went to a node no
 * longer in the page and never reached the document. Everything that ends a
 * drag on dragend stayed on: the spell bar's drop mode (the backdrop and its
 * name strip kept taking the pointer), the drag-scroll frame loop, and the
 * HUD's "a drag is in flight" hold on tooltips.
 *
 * The guard now holds through the drag (drop / dragend / the next mouse event),
 * and the drag modes end on the next mouse event when a dragend was lost anyway
 * (a native drag sends no mouse events while it runs).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PanelPressGuard } from '../packages/renderer/src/ui/PanelPressGuard.js';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

/** A drag event carrying a DataTransfer stand-in (happy-dom's events have none). */
function dragEvent(type: string, data: Record<string, string> = {}): Event {
  const e = new domWindow.Event(type, { bubbles: true, cancelable: true });
  const store = { ...data };
  Object.defineProperty(e, 'dataTransfer', {
    value: {
      effectAllowed: '', dropEffect: '', setData: (k: string, v: string) => { store[k] = v; }, getData: (k: string) => store[k] ?? '',
      setDragImage: () => {},
      get types() { return Object.keys(store); },
    },
  });
  return e;
}
const pointer = (el: EventTarget, type: string): void => { el.dispatchEvent(new domWindow.PointerEvent(type, { bubbles: true })); };

describe('PanelPressGuard holds a rebuild through a native drag that began in the panel', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let doc: any;
  beforeAll(() => { doc = domWindow.document; });

  function panelWithRow() {
    const panel = doc.createElement('div'); doc.body.appendChild(panel);
    const row = doc.createElement('div'); row.draggable = true; panel.appendChild(row);
    return { panel, row };
  }

  it('pointercancel at the drag start does not run the held rebuild; the drop does', async () => {
    const guard = new PanelPressGuard(doc);
    const { panel, row } = panelWithRow();
    let runs = 0;
    pointer(row, 'pointerdown');
    expect(guard.defer(panel, () => { runs++; })).toBe(true);
    row.dispatchEvent(dragEvent('dragstart', { 'text/spell-id': '100' }));
    pointer(row, 'pointercancel'); // Chrome / Edge: the drag took the pointer
    await tick();
    expect(runs).toBe(0); // the row the drag came from is still the page's
    // A rebuild asked for mid-drag is held too.
    expect(guard.defer(panel, () => { runs++; })).toBe(true);
    doc.body.dispatchEvent(dragEvent('drop', { 'text/spell-id': '100' }));
    await tick();
    expect(runs).toBe(1);
    panel.remove();
  });

  it('a drag released outside the window ends on dragend', async () => {
    const guard = new PanelPressGuard(doc);
    const { panel, row } = panelWithRow();
    let runs = 0;
    pointer(row, 'pointerdown');
    guard.defer(panel, () => { runs++; });
    row.dispatchEvent(dragEvent('dragstart'));
    pointer(row, 'pointercancel');
    row.dispatchEvent(dragEvent('dragend'));
    await tick();
    expect(runs).toBe(1);
    panel.remove();
  });

  it('a drag whose end never arrives is over at the next mouse move (no mouse events during a native drag)', async () => {
    const guard = new PanelPressGuard(doc);
    const { panel, row } = panelWithRow();
    let runs = 0;
    pointer(row, 'pointerdown');
    guard.defer(panel, () => { runs++; });
    row.dispatchEvent(dragEvent('dragstart'));
    pointer(row, 'pointercancel');
    doc.body.dispatchEvent(new domWindow.MouseEvent('mousemove', { bubbles: true }));
    await tick();
    expect(runs).toBe(1);
    panel.remove();
  });

  it('a cancelled dragstart is no drag: the press ends on its pointercancel / pointerup as before', async () => {
    const guard = new PanelPressGuard(doc);
    const { panel, row } = panelWithRow();
    row.addEventListener('dragstart', (e: Event) => e.preventDefault());
    let runs = 0;
    pointer(row, 'pointerdown');
    guard.defer(panel, () => { runs++; });
    row.dispatchEvent(dragEvent('dragstart'));
    pointer(row, 'pointercancel');
    await tick();
    expect(runs).toBe(1);
    panel.remove();
  });
});

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'PointerEvent', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;

describe('GameUI: spellbook row → spell bar, with a magic-panel rebuild landing during the drag (all eras)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;
  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    GameUICtor = (await import('../packages/renderer/src/ui/GameUI.js')).GameUI;
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  const spell = (id: number, name: string) => ({
    id, name, school: 1, level: 1, power: 1, manaCost: 10, difficulty: 50, duration: 0, components: [], targetType: 2,
  });
  const A = spell(100, 'Spell A');
  const B = spell(200, 'Spell B');

  async function setup(era: 'end-of-retail' | 'classic-dereth' | 'ac1999-retail') {
    domWindow.localStorage.clear();
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui = new GameUICtor(container);
    if (era !== 'end-of-retail') {
      const { eraClientRules } = await import('../packages/renderer/src/era/EraFeatures.js');
      const { eraProfile } = await import('../packages/renderer/src/era/EraProfiles.js');
      ui.setClientRules(eraClientRules(eraProfile(era)));
    }
    const events: string[] = [];
    ui.setSpellData([A, B]);
    ui.setSpellCallbacks({ onAddSpellFavorite: (id: number, pos: number, bar: number) => events.push(`add ${id} @${pos} bar${bar}`) });
    ui.spellBarSlots[0] = [A, null, null, null, null, null, null, null, null];
    ui.installSpellBarDragScroll();
    ui.ensureHudTooltipMachine();
    // The bar: its backdrop (the drop target spell drags switch on) and a cell.
    const bg = domWindow.document.createElement('div');
    const name = domWindow.document.createElement('div');
    bg.appendChild(name); domWindow.document.body.appendChild(bg);
    ui.wireSpellcastBackgroundDrop(bg, name);
    const cell = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(cell);
    ui.wireSpellBarSlotEvents(cell, 1, 0);
    // The open spellbook: a row that drags its spell id, as renderMagicPanel's rows do.
    const panel = domWindow.document.createElement('div');
    const row = domWindow.document.createElement('div');
    row.draggable = true;
    row.addEventListener('dragstart', (e: DragEvent) => e.dataTransfer?.setData('text/spell-id', '200'));
    panel.appendChild(row); domWindow.document.body.appendChild(panel);
    ui.magicPanel = panel;
    ui.magicVisible = true;
    const ids = () => (ui.spellBarSlots[0] as Array<{ id: number } | null>).filter(Boolean).map((s) => s!.id);
    return { ui, events, bg, name, cell, panel, row, ids };
  }

  for (const era of ['end-of-retail', 'classic-dereth', 'ac1999-retail'] as const) {
    it(`${era}: the row stays in the page for the whole drag, the drop lands, the spell bar's drop mode ends`, async () => {
      const { ui, events, bg, name, cell, panel, row, ids } = await setup(era);
      pointer(row, 'pointerdown');
      // A rebuild during the press (a streamed icon landing, a spell learned): held.
      ui.renderMagicPanel();
      expect(row.isConnected).toBe(true);
      row.dispatchEvent(dragEvent('dragstart'));
      expect(bg.style.pointerEvents).toBe('auto');
      expect(ui.hudDragInProgress()).toBe(true);
      pointer(row, 'pointercancel');
      await tick();
      // Before: the held rebuild ran here and tore the row (the drag's source) out of the page.
      expect(row.isConnected).toBe(true);
      expect(panel.isConnected).toBe(true);
      cell.dispatchEvent(dragEvent('dragover', { 'text/spell-id': '200' }));
      const drop = dragEvent('drop', { 'text/spell-id': '200' });
      cell.dispatchEvent(drop);
      row.dispatchEvent(dragEvent('dragend'));
      expect(ids()).toEqual([100, 200]);
      expect(events).toEqual(['add 200 @1 bar0']);
      expect(bg.style.pointerEvents).toBe('');
      expect(name.style.pointerEvents).toBe('');
      expect(ui.spellDragScroll).toBeNull();
      expect(ui.hudDragInProgress()).toBe(false);
      await tick();
      // The held rebuild ran once the drag was over (no layout renderer here: it only clears the old panel).
      expect(panel.isConnected).toBe(false);
    });

    it(`${era}: a drag whose source left the page anyway (no dragend) is over at the next mouse move`, async () => {
      const { ui, bg, name, panel, row } = await setup(era);
      pointer(row, 'pointerdown');
      row.dispatchEvent(dragEvent('dragstart'));
      pointer(row, 'pointercancel');
      expect(bg.style.pointerEvents).toBe('auto');
      // Released off any target with the source already gone: its dragend reaches nothing.
      panel.remove();
      row.dispatchEvent(dragEvent('dragend'));
      expect(bg.style.pointerEvents).toBe('auto'); // the lost end: the bar stays in drop mode …
      domWindow.document.body.dispatchEvent(new domWindow.MouseEvent('mousemove', { bubbles: true }));
      // … until the next mouse event, which no native drag sends.
      expect(bg.style.pointerEvents).toBe('');
      expect(name.style.pointerEvents).toBe('');
      expect(ui.spellDragScroll).toBeNull();
      expect(ui.hudDragInProgress()).toBe(false);
    });
  }
});
