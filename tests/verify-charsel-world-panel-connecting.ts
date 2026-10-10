/**
 * CORE.13 (overturns VISUAL2.5) — the char-select World box (layout
 * 0x21000004 element 0x1000039b, base media 0x06004d64) draws in the
 * connecting phase too, and the connecting status is carried by a modal
 * "Please Wait" dialog over the fully-drawn screen.
 *
 * VISUAL2.5 suppressed the box while connecting on the strength of
 * reference/images/preworld/char-select-web2.webp — but that image is
 * pixel-identical to raw DAT asset 0x06007075 (the no-bust 2012 backdrop
 * with "World"/"Characters" labels BAKED IN): it is the extracted texture,
 * not a screenshot, so it says nothing about the live screen. The
 * decompiled retail client is the authority: RecvNotice_WorldName @
 * 004ec360 only SetTexts into the box's text child (never hides the box),
 * UpdateButtons @ 004ec240 never hides the action buttons, and
 * gmCharacterManagementUI::Update @ 004ecab0 closes a modal Please Wait
 * dialog (MakePleaseWaitDialog @ 004eced0, string 7426468 in table
 * 0x23000002) once the character set arrives.
 *
 * Drives the real GameUI under happy-dom. happy-dom comes from
 * tests/_harness/dom.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame'] as const;

describe('CORE.13 — connecting phase draws the full char-select chrome + Please Wait modal', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let container: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved, 'functions');
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  it('showConnectingScreen does NOT suppress the World box media', () => {
    ui.showConnectingScreen();
    const worldEl = container.querySelector('#charsel-world-panel');
    expect(worldEl).toBeTruthy();
    // The old VISUAL2.5 behavior forced backgroundImage:'none' here; the
    // decomp shows retail never hides the box.
    expect(worldEl.style.backgroundImage).not.toBe('none');
  });

  it('showConnectingScreen shows the modal Please Wait dialog', () => {
    ui.showConnectingScreen();
    const blocker = container.querySelector('#charsel-pleasewait');
    expect(blocker).toBeTruthy();
  });

  it('showCharacterSelect (character set arrived) removes the Please Wait dialog', () => {
    ui.showConnectingScreen();
    ui.showCharacterSelect([]);
    expect(container.querySelector('#charsel-pleasewait')).toBeFalsy();
    const worldEl = container.querySelector('#charsel-world-panel');
    expect(worldEl).toBeTruthy();
    expect(worldEl.style.backgroundImage).not.toBe('none');
  });

  it('re-entering connecting mode brings the dialog back (not a one-shot)', () => {
    ui.showCharacterSelect([]);
    ui.showConnectingScreen();
    expect(container.querySelector('#charsel-pleasewait')).toBeTruthy();
  });
});
