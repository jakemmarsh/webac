/**
 * VISUAL2.6 — the loading overlay stayed bare black with zero feedback for
 * the entire portal.dat download (the bulk of the ~1.2GB initial transfer)
 * on a slow connection, reported 2026-06-12 as "kinda fucked up". Root cause:
 * main.ts's setLoadStatus/setLoadStatusDual calls made during the portal.dat
 * fetch target #load-text-left/#load-text-right by document.getElementById,
 * but initDatSplash() (which creates those elements from the DAT-driven
 * PatchField layout) doesn't run until AFTER portal.dat is fully downloaded
 * and parsed — so every status update during the download silently no-oped.
 *
 * createLoadingOverlay() (packages/renderer/src/ui/LoadingOverlay.ts) now
 * pre-creates plain-text #load-text-left/#load-text-right placeholders up
 * front, so those callbacks have somewhere to render from the very first
 * frame. Verified live via a throttled-network Playwright capture (150Mbps
 * CDP emulation) showing the percent/size text updating continuously
 * through the portal.dat fetch, where before it was solid black.
 *
 * Drives the real factory function under happy-dom (no main.ts import — it
 * has top-level side effects like fetching DATs and opening a WebSocket, so
 * only the extracted DOM-building unit is safely importable/testable).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'HTMLElement', 'Node'] as const;

describe('VISUAL2.6 — loading overlay has a status target before the DAT splash exists', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let createLoadingOverlay: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let revealLoadingPlaceholder: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved, 'functions');
    ({ createLoadingOverlay, revealLoadingPlaceholder } = await import('../packages/renderer/src/ui/LoadingOverlay.js'));
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  // Each test appends its own overlay to the shared happy-dom document;
  // clear it so #load-text-left/#load-text-right stay unique across tests
  // (document.getElementById returns the first match otherwise).
  afterEach(() => {
    domWindow.document.body.innerHTML = '';
  });

  it('creates #load-text-left and #load-text-right before any DAT data is available', () => {
    const overlay = createLoadingOverlay();
    domWindow.document.body.appendChild(overlay);

    const left = domWindow.document.getElementById('load-text-left');
    const right = domWindow.document.getElementById('load-text-right');
    expect(left).toBeTruthy();
    expect(right).toBeTruthy();
    // Plain text targets, not canvases — no AC bitmap font is available yet
    // (it loads lazily from the not-yet-downloaded portal.dat).
    expect(left.tagName).toBe('DIV');
    expect(right.tagName).toBe('DIV');
  });

  it('the placeholder elements accept status updates the way the real download callbacks do', () => {
    const overlay = createLoadingOverlay();
    domWindow.document.body.appendChild(overlay);

    // Mirrors main.ts's labels (CORE.17.k.b.b.a.a.a): the connect level's
    // state text on the left, the DDD patch progress line on the right.
    domWindow.document.getElementById('load-text-left').textContent = 'Connect progress';
    domWindow.document.getElementById('load-text-right').textContent = '33% of 905,216K complete...';

    expect(overlay.textContent).toContain('Connect progress');
    expect(overlay.textContent).toContain('33% of 905,216K complete...');
  });

  // VISUAL.preworld-placeholder-before-portal-dat — retail never shows a
  // pre-art state: the status line stays hidden (a black frame while the
  // splash's files are read by byte range) until main.ts reveals it because
  // that read failed.
  it('the status line starts hidden and is revealed only on the ranged-read fallback', () => {
    const overlay = createLoadingOverlay();
    domWindow.document.body.appendChild(overlay);
    const left = domWindow.document.getElementById('load-text-left');
    const right = domWindow.document.getElementById('load-text-right');
    expect(left.style.visibility).toBe('hidden');
    expect(right.style.visibility).toBe('hidden');

    revealLoadingPlaceholder(overlay);
    expect(left.style.visibility).toBe('visible');
    expect(right.style.visibility).toBe('visible');
  });

  it('revealing after the DAT splash replaced the placeholder touches nothing', () => {
    const overlay = createLoadingOverlay();
    domWindow.document.body.appendChild(overlay);
    overlay.innerHTML = '';
    const splashLabel = domWindow.document.createElement('div');
    splashLabel.id = 'load-text-left';
    overlay.appendChild(splashLabel);
    revealLoadingPlaceholder(overlay);
    expect(splashLabel.style.visibility).toBe('');
  });

  it('overlay itself is the full-screen black backdrop main.ts expects at id "loading-overlay"', () => {
    const overlay = createLoadingOverlay();
    expect(overlay.id).toBe('loading-overlay');
    expect(overlay.style.background).toBe('#000');
    expect(overlay.style.position).toBe('fixed');
  });
});
