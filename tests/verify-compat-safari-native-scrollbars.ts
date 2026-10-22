/**
 * COMPAT.safari-native-scrollbars — `scrollbar-width: none` hides a list's
 * own browser scrollbar only in Firefox, Chromium 121+ and Safari 18.2+
 * (https://caniuse.com/mdn-css_properties_scrollbar-width). Ten GameUI lists
 * (spellbook, components, effects, titles, social, contracts, …) set only
 * that, so Safari before 18.2 drew a native scrollbar beside the retail DAT
 * one (always visible with a mouse attached). They now go through
 * DatFrame.hideNativeScrollbar, which adds the ::-webkit-scrollbar rule's
 * class too. Drives the real GameUI.fillDatListRows in happy-dom.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow } from './_harness/dom.js';
import { NATIVE_SCROLLBAR_HIDDEN_CLASS } from '../packages/renderer/src/ui/DatFrame.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

class FakeObserver { constructor(_cb: unknown) {} observe(): void {} unobserve(): void {} disconnect(): void {} takeRecords(): unknown[] { return []; } }

describe('GameUI lists hide the native scrollbar in older Safari too', () => {
  const GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'MutationObserver', 'ResizeObserver'] as const;
  const g = globalThis as Record<string, unknown>;
  const saved: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;

  beforeAll(async () => {
    for (const key of GLOBALS) saved[key] = g[key];
    for (const key of GLOBALS) {
      g[key] = key === 'window' ? domWindow : key === 'MutationObserver' || key === 'ResizeObserver' ? FakeObserver : domWindow[key];
    }
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
  });
  afterAll(() => {
    for (const key of GLOBALS) { if (saved[key] === undefined) delete g[key]; else g[key] = saved[key]; }
  });

  it('a DAT list with its own scrollbar gets the WebKit-hiding class and stylesheet, not only scrollbar-width', () => {
    const doc = domWindow.document;
    const list = doc.createElement('div');
    const column = doc.createElement('div');
    doc.body.append(list, column);
    ui.fillDatListRows(list, [], () => ({}), 'row', { scrollbar: { column, hideDisabled: true } });
    expect(list.classList.contains(NATIVE_SCROLLBAR_HIDDEN_CLASS)).toBe(true);
    const sheet = [...doc.querySelectorAll('style')].map((s: HTMLStyleElement) => s.textContent).join('\n');
    expect(sheet).toContain(`.${NATIVE_SCROLLBAR_HIDDEN_CLASS}::-webkit-scrollbar { display: none; }`);
  });

  it('a list without a scrollbar is clipped, as before (no class)', () => {
    const list = domWindow.document.createElement('div');
    ui.fillDatListRows(list, [], () => ({}), 'row', {});
    expect(list.classList.contains(NATIVE_SCROLLBAR_HIDDEN_CLASS)).toBe(false);
    expect(list.style.overflow).toBe('hidden');
  });
});
