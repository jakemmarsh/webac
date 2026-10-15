/**
 * BUG.stale-wait-plate-modal (production telemetry, 2026-10-14): every world
 * session entered from character select reported modal="dialog" for its
 * whole length. Char select's button-less wait plates (Entering World,
 * Please Wait) render through renderTemplateDialog, which lists them for the
 * agent API; showGame() only hid the screen container, so the plates stayed
 * in the document and the "open dialog" checks (own style.display only)
 * counted them. Agents were told an "Entering World" dialog was open.
 *
 * Drives the real GameUI under happy-dom, with a minimal LayoutRenderer
 * double while the DAT dialogs are built (so they take the
 * renderTemplateDialog path the live client takes).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let H: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let isElementDisplayed: (el: any) => boolean;

/** A LayoutRenderer double: the dialog subtree as a root with the plate (0x3d) and text (0x3e) elements. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stubDialogRenderer(doc: any) {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    render: (_layoutId: number, parent: any) => {
      const root = doc.createElement('div');
      parent.appendChild(root);
      const elements = new Map<number, HTMLElement>();
      for (const id of [0x3d, 0x3e]) {
        const el = doc.createElement('div');
        el.dataset.elementId = `0x${id.toString(16)}`;
        root.appendChild(el);
        elements.set(id, el);
      }
      return {
        root, elements, descs: new Map(),
        setState: () => {}, setText: () => {}, setInteractive: () => {}, setVisible: () => {},
        setTexture: () => {}, onClick: () => {}, resizeSubtree: () => {},
        close: () => { root.remove(); }, destroy: () => { root.remove(); },
      };
    },
  };
}

const SLOTS = [{ id: '1342177281', name: 'Alpha' }, { id: '1342177282', name: 'Beta' }];

/** Char select → ENTER's Entering World plate (built through the DAT dialog path). */
function charSelectEnteringWorld(): void {
  H.ui.showCharacterSelect(SLOTS);
  H.ui.layoutRenderer = stubDialogRenderer(H.win.document);
  H.ui.showEnteringWorldDialog();
  H.ui.layoutRenderer = null;
}

describe('BUG.stale-wait-plate-modal — a hidden or left-behind dialog is not an open dialog', () => {
  beforeAll(async () => {
    const { mountGameUI } = await import('./_harness/gameui.js');
    H = await mountGameUI();
    H.ui.playUISound = () => {};
    isElementDisplayed = H.mod.isElementDisplayed;
  });
  afterAll(() => H?.teardown());

  it('the Entering World plate counts while char select shows it', () => {
    charSelectEnteringWorld();
    expect(H.win.document.querySelector('#charsel-enteringworld')).toBeTruthy();
    expect(H.ui.agentDialogs()).toEqual([{ text: 'Entering World', buttons: [] }]);
    expect(H.ui.openBlockingWindow()).toBe('dialog');
  });

  it('hiding the screen container (portal space over char select) hides the plate: no dialog', () => {
    charSelectEnteringWorld();
    H.ui.screenContainer.style.display = 'none';
    // The plate is still in the document with its own display intact …
    const plate = H.win.document.querySelector('#charsel-enteringworld .ac-dat-dialog') as HTMLElement;
    expect(plate.isConnected).toBe(true);
    expect(plate.style.display).not.toBe('none');
    // … but nobody can see it.
    expect(H.ui.openBlockingWindow()).toBeNull();
    expect(H.ui.agentDialogs()).toEqual([]);
    expect(H.ui.agentAnswerDialog('OK')).toBe(false);
  });

  it('entering the world closes char select\'s wait plates; a second entry (relog) reports no modal either', () => {
    for (let entry = 1; entry <= 2; entry++) {
      charSelectEnteringWorld();
      H.ui.showGame();
      expect(H.win.document.querySelector('#charsel-enteringworld')).toBeNull();
      expect(H.ui.openBlockingWindow()).toBeNull();
      expect(H.ui.agentDialogs()).toEqual([]);
      // Even shown again (back to char select without a re-render) nothing lingers.
      H.ui.screenContainer.style.display = 'block';
      expect(H.ui.openBlockingWindow()).toBeNull();
      H.ui.screenContainer.style.display = 'none';
    }
  });

  it('a genuinely open dialog in the world is still reported, and answerable', () => {
    H.ui.layoutRenderer = stubDialogRenderer(H.win.document);
    try {
      H.ui.showKeyboardMapDialog('Press the new key');
      expect(H.ui.openBlockingWindow()).toBe('dialog');
      expect(H.ui.agentDialogs()).toEqual([{ text: 'Press the new key', buttons: [] }]);
      H.ui.hideKeyboardMapDialog();
      expect(H.ui.openBlockingWindow()).toBeNull();

      let ok = 0;
      expect(H.ui.showMessageDialog('Your character is being deleted.', () => { ok++; })).toBe(true);
      expect(H.ui.openBlockingWindow()).toBe('message');
      expect(H.ui.agentDialogs().map((d: { text: string }) => d.text)).toEqual(['Your character is being deleted.']);
      expect(H.ui.agentAnswerDialog('OK')).toBe(true);
      expect(ok).toBe(1);
      expect(H.ui.openBlockingWindow()).toBeNull();
    } finally {
      H.ui.layoutRenderer = null;
    }
  });
});

describe('isElementDisplayed', () => {
  beforeAll(async () => {
    if (!H) {
      const { mountGameUI } = await import('./_harness/gameui.js');
      H = await mountGameUI();
      isElementDisplayed = H.mod.isElementDisplayed;
    }
  });

  it('needs the element in the document and every ancestor shown', () => {
    const doc = H.win.document;
    const outer = doc.createElement('div');
    const inner = doc.createElement('div');
    outer.appendChild(inner);
    expect(isElementDisplayed(inner)).toBe(false); // not in the document
    expect(isElementDisplayed(null)).toBe(false);
    doc.body.appendChild(outer);
    expect(isElementDisplayed(inner)).toBe(true);
    outer.style.display = 'none';
    expect(isElementDisplayed(inner)).toBe(false);
    outer.style.display = '';
    outer.hidden = true;
    expect(isElementDisplayed(inner)).toBe(false);
    outer.hidden = false;
    inner.style.display = 'none';
    expect(isElementDisplayed(inner)).toBe(false);
    outer.remove();
  });

  it('defers to checkVisibility() where the browser has it', () => {
    const doc = H.win.document;
    const el = doc.createElement('div');
    doc.body.appendChild(el);
    el.checkVisibility = () => false; // e.g. a stylesheet rule hides it
    expect(isElementDisplayed(el)).toBe(false);
    el.checkVisibility = () => true;
    expect(isElementDisplayed(el)).toBe(true);
    el.remove();
  });
});
