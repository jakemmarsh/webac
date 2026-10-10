/**
 * FAITHFUL.517 — Chat input has no placeholder text (matches retail).
 *
 *  AC retail's chat input was an empty Edit2 control with no
 *  placeholder hint. Discoverability was carried by the DAT panel
 *  chrome (main chat window 0x2100006f: input row texture + "Send"
 *  button label).
 *
 *  Pre-fix the chat input had a browser-Web ergonomic hint:
 *    `chatInputEl.placeholder = 'Click and type here to talk to others';`
 *  This sat inside the input until the user typed something — a non-
 *  retail UX addition that broke faithfulness.
 *
 *  Behavioral (converted from a source-text pin under CORE.17.g): drives
 *  the real GameUI.renderHUD() with a layoutRenderer test-double and
 *  inspects the #chat-input element it injects into the entry area.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('FAITHFUL.517 — chat input has no placeholder', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  let input: HTMLInputElement;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui = new mod.GameUI(container);
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
        root, descs: new Map(),
        elements: { get: (id: number) => getOrCreate(id), set: () => {} },
        setText: () => {}, setInteractive: () => {}, setVisible: () => {}, setState: () => {},
        setTexture: () => {}, close: () => { root.remove(); },
      };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ui as any).layoutRenderer = {
      render: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
      renderPanel: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
      getTextureDataURLWithAlpha: () => null,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ui as any).renderHUD();
    input = domWindow.document.getElementById('chat-input') as HTMLInputElement;
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  it('injects a text input into the chat entry area', () => {
    expect(input).toBeTruthy();
    expect(input.tagName.toLowerCase()).toBe('input');
    expect(input.type).toBe('text');
  });

  it('carries no placeholder attribute (retail Edit2 control is blank until typed into)', () => {
    expect(input.hasAttribute('placeholder')).toBe(false);
    expect(input.placeholder ?? '').toBe('');
  });

  it('caps at the entry desc p30 (RECON.chat-entry-maxchars; none in this stub, so 0xffff) with browser affordances off (FAITHFUL.358)', () => {
    expect(input.maxLength).toBe(0xffff);
    expect(input.autocomplete).toBe('off');
    expect(input.spellcheck).toBe(false);
  });
});
