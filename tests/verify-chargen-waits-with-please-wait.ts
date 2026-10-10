/**
 * Create Character while the streamed world packs are still loading.
 *
 * Chargen draws the world packs' heritage / clothing art, so with streamed
 * DATs showCharacterCreate waits for them (RELEASE.streaming-charselect-weight).
 * On a cold first visit to playwebac.com they landed 55-154 s after char
 * select (2026-10-08), and the click showed nothing for that long: a new
 * player saw a dead button. It now raises retail's Please Wait box
 * (MakePleaseWaitDialog @ 004eced0, string 7426468) until chargen opens.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1568, innerHeight: 775 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;

describe('Create Character before the world art is resident', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mod: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    mod = await import('../packages/renderer/src/ui/GameUI.js');
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  it('shows Please Wait at once, opens chargen and drops the box when the art lands; a second click raises no second box', async () => {
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    let land!: () => void;
    const worldArtReady = new Promise<void>((r) => { land = r; });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ui: any = new mod.GameUI(container, {}, undefined, undefined, undefined, undefined, null, null, { worldArtReady });

    ui.showCharacterCreate();
    ui.showCharacterCreate();
    const boxes = domWindow.document.querySelectorAll(`#${mod.CHARGEN_WORLD_ART_WAIT_ID}`);
    expect(boxes.length).toBe(1);
    expect(ui.uiManager.currentScreen).not.toBe('character-create');

    land();
    await worldArtReady;
    await new Promise((r) => setTimeout(r, 0));
    expect(domWindow.document.getElementById(mod.CHARGEN_WORLD_ART_WAIT_ID)).toBeNull();
    expect(ui.uiManager.currentScreen).toBe('character-create');
  });

  it('whole DATs (no pending world art): chargen opens directly, no box', () => {
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ui: any = new mod.GameUI(container);
    ui.showCharacterCreate();
    expect(domWindow.document.getElementById(mod.CHARGEN_WORLD_ART_WAIT_ID)).toBeNull();
    expect(ui.uiManager.currentScreen).toBe('character-create');
  });
});
