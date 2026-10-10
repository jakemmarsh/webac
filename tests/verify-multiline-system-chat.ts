/**
 * FAITHFUL.511 — addSystemMessage preserves embedded "\n" line breaks.
 *
 *  ACE server-side emits SystemChat strings with embedded "\n" line
 *  breaks. Examples from the source:
 *    Player_Xp.cs:312
 *      $"You are now level {Level}!\nYou have {N} experience points
 *        and {M} skill credits available to raise skills and attributes."
 *    Player_Allegiance.cs:988
 *      $"Approved vassals:\n{name1}\n{name2}…"
 *    Player_Skills.cs:763
 *      "Your trained skills have been reset due to an error with
 *       skill credits.\nYou have received a refund…"
 *
 *  The AC bitmap font has no glyph for 0x0A, so a single renderACText
 *  call would silently drop every "\n" and collapse multi-line messages
 *  onto one line. addSystemMessage (via buildSystemChatLine since
 *  CORE.3.c) splits on "\n" and appends one block element per line, with
 *  empty lines rendered as a space placeholder so "\n\n" keeps a visible
 *  gap.
 *
 *  Converted from a source-regex pin to a behavioral test (CORE.3.c —
 *  per the no-source-text-pin testing rule): drives the real
 *  GameUI.addSystemMessage through renderHUD with a layoutRenderer
 *  double and asserts the DOM the chat log actually receives.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = [
  'window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event',
  'MouseEvent', 'MutationObserver',
] as const;

describe('FAITHFUL.511 — addSystemMessage line-break handling (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  let mainLog: HTMLElement;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.getTexURL = () => null;
    const makeHandle = (_layoutId: number, parent: HTMLElement) => {
      const root = domWindow.document.createElement('div') as HTMLElement;
      parent.appendChild(root);
      const elements = new Map<number, HTMLElement>();
      const getOrCreate = (id: number): HTMLElement => {
        let el = elements.get(id);
        if (!el) {
          el = domWindow.document.createElement('div') as HTMLElement;
          root.appendChild(el);
          elements.set(id, el);
        }
        return el;
      };
      return {
        root,
        elements: { get: (id: number) => getOrCreate(id), set: () => {} },
        setText: () => {}, setInteractive: () => {}, setState: () => {},
        setVisible: () => {}, setFill: () => {}, setPalette: () => {},
        setScrollable: () => ({ contentEl: root, setPosition() {}, scrollToBottom() {}, appendContent() {} }),
        close: () => { root.remove(); }, destroy: () => { root.remove(); },
      };
    };
    ui.layoutRenderer = {
      render: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
      renderPanel: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
      getTextureDataURLWithAlpha: () => null,
    };
    ui.renderHUD();
    mainLog = domWindow.document.getElementById('chat-messages')!;
  });

  afterAll(() => {
    const g = globalThis as Record<string, unknown>;
    for (const key of DOM_GLOBALS) g[key] = saved[key];
  });

  it('a multi-line ACE level-up message renders one block per line', () => {
    ui.addSystemMessage('You are now level 100!\nYou have 12,345 experience points.');
    const msg = mainLog.lastElementChild as HTMLElement;
    expect(msg.children.length).toBe(2);
    expect(msg.children[0].textContent).toBe('You are now level 100!');
    expect(msg.children[1].textContent).toBe('You have 12,345 experience points.');
  });

  it('consecutive "\\n\\n" produces a space-placeholder line (visible gap)', () => {
    ui.addSystemMessage('Approved vassals:\n\nBob');
    const msg = mainLog.lastElementChild as HTMLElement;
    expect(msg.children.length).toBe(3);
    expect(msg.children[1].textContent).toBe(' ');
    expect(msg.children[2].textContent).toBe('Bob');
  });

  it('a single-line message stays a single block', () => {
    ui.addSystemMessage('Plain line.');
    const msg = mainLog.lastElementChild as HTMLElement;
    expect(msg.children.length).toBe(1);
    expect(msg.textContent).toBe('Plain line.');
  });
});
