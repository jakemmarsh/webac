/**
 * BOOT.capability-screen-under-overlay — on playwebac.com (2026-10-18) a
 * browser without WebGL showed an all-black page: the capability screen
 * (boot/Capability.ts) was in the DOM at z-index 1000, under the boot loading
 * overlay (#loading-overlay, ui/LoadingOverlay.ts, z 9999, opaque black,
 * pointer-events auto). The soft prompts (no mouse on phones and tablets,
 * low memory) were covered the same way, so their Continue button could not
 * be seen or clicked (players sat on boot stage capability_prompt for up to
 * 80 minutes).
 *
 * Boots the real pieces in main.ts's order (overlay appended to the body,
 * then showCapabilityScreen) and resolves which body-level layer the browser
 * would hit at the window centre, the way it does for fixed full-window
 * siblings in the root stacking context: the highest z-index among the
 * visible ones that take the pointer, the later one on a tie.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1280, innerHeight: 720 });
const DOM_GLOBALS = ['window', 'document', 'HTMLElement', 'Node'] as const;

/** The body child that takes a click at the window centre (fixed full-window layers only). */
function topmostLayer(doc: Document): HTMLElement | null {
  let best: { el: HTMLElement; z: number; order: number } | null = null;
  Array.from(doc.body.children).forEach((child, order) => {
    const el = child as HTMLElement;
    const cs = doc.defaultView!.getComputedStyle(el);
    if (cs.position !== 'fixed') return;
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.pointerEvents === 'none') return;
    if (Number(el.style.opacity || '1') === 0) return;
    const z = Number(el.style.zIndex || '0');
    if (!best || z > best.z || (z === best.z && order > best.order)) best = { el, z, order };
  });
  return (best as { el: HTMLElement } | null)?.el ?? null;
}

describe('BOOT.capability-screen-under-overlay — the capability screen is above the loading overlay', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let createLoadingOverlay: any;
  let fadeOutLoadingOverlay: any;
  let capabilityProblems: any;
  let showCapabilityScreen: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const ok = { webgl2: true, websocket: true, deviceMemoryGb: 8, finePointer: true };

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved, 'functions');
    ({ createLoadingOverlay, fadeOutLoadingOverlay } = await import('../packages/renderer/src/ui/LoadingOverlay.js'));
    ({ capabilityProblems, showCapabilityScreen } = await import('../packages/renderer/src/boot/Capability.js'));
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));
  afterEach(() => { domWindow.document.body.innerHTML = ''; });

  function bootOverlay(): HTMLElement {
    const doc = domWindow.document as Document;
    const overlay = createLoadingOverlay() as HTMLElement;
    doc.body.appendChild(overlay);
    expect(topmostLayer(doc)).toBe(overlay);
    return overlay;
  }

  it('a hard problem (no WebGL 2) shows its message on top, with no way past it', () => {
    const doc = domWindow.document as Document;
    const overlay = bootOverlay();
    void showCapabilityScreen(doc, capabilityProblems({ ...ok, webgl2: false }));
    const screen = doc.getElementById('capability-screen');
    expect(screen).not.toBeNull();
    expect(topmostLayer(doc)).toBe(screen);
    expect(Number(screen!.style.zIndex)).toBeGreaterThan(Number(overlay.style.zIndex));
    expect(screen!.textContent).toMatch(/This browser can't run the game/);
    expect(doc.querySelector('.capability-continue')).toBeNull();
  });

  it('a soft prompt (no mouse) is on top and its Continue hands the page back to the loading overlay', async () => {
    const doc = domWindow.document as Document;
    const overlay = bootOverlay();
    let continued = false;
    const prompt = showCapabilityScreen(doc, capabilityProblems({ ...ok, finePointer: false })).then(() => { continued = true; });
    const screen = doc.getElementById('capability-screen');
    expect(topmostLayer(doc)).toBe(screen);
    const btn = doc.querySelector('.capability-continue') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    // The button is inside the topmost layer, so the click reaches it.
    expect(topmostLayer(doc)!.contains(btn)).toBe(true);
    btn.click();
    await prompt;
    expect(continued).toBe(true);
    expect(doc.getElementById('capability-screen')).toBeNull();
    // Boot resumes under the overlay it had before the prompt.
    expect(doc.body.contains(overlay)).toBe(true);
    expect(topmostLayer(doc)).toBe(overlay);
  });

  it('the low-memory prompt is on top too', () => {
    const doc = domWindow.document as Document;
    bootOverlay();
    void showCapabilityScreen(doc, capabilityProblems({ ...ok, deviceMemoryGb: 2 }));
    expect(topmostLayer(doc)).toBe(doc.getElementById('capability-screen'));
  });

  it('the overlay stops taking the pointer as soon as its fade-out starts, and is removed after it', async () => {
    const doc = domWindow.document as Document;
    const overlay = bootOverlay();
    let removed = false;
    fadeOutLoadingOverlay(overlay, 20, () => { removed = true; });
    expect(overlay.style.pointerEvents).toBe('none');
    expect(topmostLayer(doc)).toBeNull();
    await new Promise(r => setTimeout(r, 40));
    expect(removed).toBe(true);
    expect(doc.body.contains(overlay)).toBe(false);
  });
});
