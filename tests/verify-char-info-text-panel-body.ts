/**
 * VISUAL.char-panel-body-too-bright.b — the Character Information text panel
 * (gmCharacterInfoUI, layout 0x2100001a) draws its body the DAT's way: the
 * body 0x1000011c carries its own alpha-175 black scrim (0x06004cc2), the
 * text 0x1000011d scrolls under the DAT scrollbar 0x1000011e. The old code
 * stretched the invented 0x0600114d leather (applyStonePanelFrame) over an
 * opaque fill on the text element. Real GameUI in happy-dom.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const HAPPY_DOM_PKG = ['happy', 'dom'].join('-');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let domWindow: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import(/* @vite-ignore */ HAPPY_DOM_PKG);
  domWindow = new mod.Window({ innerWidth: 1600, innerHeight: 900 });
} catch { /* skip */ }
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;
class NoopObserver { observe(): void {} unobserve(): void {} disconnect(): void {} takeRecords(): unknown[] { return []; } }

describe.skipIf(!domWindow)('Character Information text panel body (real GameUI)', () => {
  const saved: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  const els = new Map<number, HTMLElement>();
  beforeAll(async () => {
    const g = globalThis as Record<string, unknown>;
    for (const key of DOM_GLOBALS) { saved[key] = g[key]; g[key] = key === 'window' ? domWindow : domWindow[key]; }
    saved.MutationObserver = g.MutationObserver; saved.ResizeObserver = g.ResizeObserver;
    g.MutationObserver = NoopObserver; g.ResizeObserver = NoopObserver;
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.layoutRenderer = {
      renderPanel: (_l: number, parent: HTMLElement) => {
        const wrapper = domWindow.document.createElement('div');
        const root = domWindow.document.createElement('div');
        wrapper.appendChild(root); parent.appendChild(wrapper);
        for (const id of [0x1000011c, 0x1000011d, 0x1000011e]) { const d = domWindow.document.createElement('div'); root.appendChild(d); els.set(id, d); }
        return { root, elements: els, descs: new Map(), setText() {}, setVisible() {}, close: () => wrapper.remove() };
      },
    };
    ui.characterInfoSource = () => ({ prop: (id: number) => (id === 25 ? 107 : undefined), attribute: () => 100, innateAttribute: () => 100, strength: 100 });
    ui.toggleCharacterInfoTextPanel();
  });
  afterAll(() => {
    const g = globalThis as Record<string, unknown>;
    for (const key of [...DOM_GLOBALS, 'MutationObserver', 'ResizeObserver']) { if (saved[key] === undefined) delete g[key]; else g[key] = saved[key]; }
  });

  it('no invented leather or opaque fill on the text element; the text scrolls in its own viewport', () => {
    const text = els.get(0x1000011d)!;
    expect(text.style.backgroundImage ?? '').toBe('');
    expect(text.style.backgroundColor ?? '').toBe('');
    const viewport = text.querySelector("[data-char-info-body]") as HTMLElement | null;
    expect(viewport).toBeTruthy();
    expect(viewport!.children[0].children.length).toBeGreaterThan(0);
  });

  it('characterInfoReportLines hands the live report to probes (empty without a source)', async () => {
    const { buildCharacterInfoReport } = await import('../packages/renderer/src/ui/CharacterInfoReport.js');
    expect(ui.characterInfoReportLines()).toEqual(buildCharacterInfoReport(ui.characterInfoSource()));
    const src = ui.characterInfoSource;
    ui.characterInfoSource = null;
    expect(ui.characterInfoReportLines()).toEqual([]);
    ui.characterInfoSource = src;
  });
});
